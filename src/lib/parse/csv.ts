// CSV / TSV parsing with flexible header detection.
import Papa from 'papaparse';
import type { Measurement, ParseResult } from '../../types';
import { buildMeasurement, dedupeMeasurements, type RawRow } from './rows.ts';
import { detectReportDate, parseDate } from './dates.ts';

type Col = 'name' | 'value' | 'unit' | 'range' | 'low' | 'high' | 'date' | 'flag' | 'marker';

const HEADER_PATTERNS: [Col, RegExp][] = [
  ['marker', /^(?:marker\s*id|markerid|biomarker\s*id|loinc)$/],
  ['name', /^(?:test(?:\s*name)?|tests?|name|parameters?|investigations?|analyte|biomarker|marker|component|description|test\s*description|examination|item|observation|lab\s*test)$/],
  ['value', /^(?:value|values|result|results|observed\s*value|observation\s*value|reading|your\s*value|result\s*value|test\s*result|measured\s*value|observed)$/],
  ['unit', /^(?:units?|uom|unit\s*of\s*measure(?:ment)?|measure)$/],
  ['range', /^(?:range|ref(?:erence)?(?:\s*(?:range|interval|values?|limits?))?|ref\.?\s*range|normal\s*(?:range|values?)|biological\s*ref(?:erence)?(?:\s*(?:range|interval|values?))?|bio\.?\s*ref(?:\.|erence)?\s*(?:range|interval)?|expected\s*(?:range|values?)|reference\s*interval)$/],
  ['low', /^(?:low|min(?:imum)?|lower(?:\s*(?:limit|bound|range))?|ref\s*low|range\s*low|low\s*(?:limit|range|ref))$/],
  ['high', /^(?:high|max(?:imum)?|upper(?:\s*(?:limit|bound|range))?|ref\s*high|range\s*high|high\s*(?:limit|range|ref))$/],
  ['date', /^(?:date|collected|collection\s*date|collected\s*(?:on|at|date)|sample\s*date|date\s*collected|test\s*date|specimen\s*date|drawn|draw\s*date|observation\s*date|result\s*date|date\s*of\s*(?:test|collection)|reported\s*(?:on|date)|report\s*date)$/],
  ['flag', /^(?:flag|flags|status|abnormal|h\/l|interpretation|indicator)$/],
];

function classifyHeader(h: string): Col | null {
  const t = h.toLowerCase().replace(/[_*:#]/g, ' ').replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  for (const [col, re] of HEADER_PATTERNS) if (re.test(t)) return col;
  return null;
}

export type ColumnMap = Partial<Record<Col, number>>;

/** Find the header row within the first rows; returns its index and column mapping. */
export function detectHeader(rows: string[][]): { index: number; map: ColumnMap } | null {
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const map: ColumnMap = {};
    rows[i].forEach((cell, j) => {
      const c = classifyHeader(String(cell ?? ''));
      if (c && map[c] == null) map[c] = j;
    });
    if (map.name != null && (map.value != null || map.marker != null)) {
      // "Date" sometimes reported as "Reported On" etc. Prefer a collection-like column if two exist.
      return { index: i, map };
    }
  }
  return null;
}

function rowsFromText(text: string): string[][] {
  const res = Papa.parse<string[]>(text.replace(/^﻿/, ''), { skipEmptyLines: 'greedy', delimiter: '' });
  return res.data.map(r => r.map(c => String(c ?? '').trim()));
}

/** Parse CSV/TSV text into measurements. */
export function parseCsvText(text: string, sourceFile: string): ParseResult {
  const result: ParseResult = { measurements: [], scans: [], blobs: {}, warnings: [], detectedDate: null };
  const rows = rowsFromText(text);
  if (!rows.length) { result.warnings.push('The file is empty.'); return result; }
  const header = detectHeader(rows);
  const fileDate = detectReportDate(rows.slice(0, header?.index ?? 10).map(r => r.join(' ')).join('\n'));
  result.detectedDate = fileDate;
  const out: Measurement[] = [];
  let unmatched = 0;

  if (header) {
    const { map } = header;
    const cell = (r: string[], c: Col) => (map[c] != null ? r[map[c]!] ?? '' : '');
    let section: 'urine' | null = null;
    for (const r of rows.slice(header.index + 1)) {
      const name = cell(r, 'name');
      const valueText = cell(r, 'value');
      if (!name) continue;
      if (!valueText && !cell(r, 'marker')) {
        section = /urin|routine\s*examination|physical\s*examination|microscop/i.test(name) ? 'urine' : /blood|serum|haemat|hemat|lipid|liver|kidney|thyroid/i.test(name) ? null : section;
        continue;
      }
      const raw: RawRow = {
        name, value: valueText, unit: cell(r, 'unit'), range: cell(r, 'range'),
        low: cell(r, 'low'), high: cell(r, 'high'), flag: cell(r, 'flag'),
        date: map.date != null ? parseDate(cell(r, 'date')) : null,
        markerId: cell(r, 'marker') || null,
      };
      if (!raw.date) raw.date = fileDate;
      const m = buildMeasurement(raw, { sourceFile, date: fileDate, keepUnmatched: true, section });
      if (!m) continue;
      if (!m.markerId) unmatched++;
      out.push(m);
    }
  } else {
    // Headerless: assume name, value, unit, range.
    for (const r of rows) {
      if (r.length < 2) continue;
      const m = buildMeasurement({ name: r[0], value: r[1], unit: r[2], range: r[3] }, { sourceFile, date: fileDate, keepUnmatched: false });
      if (m) out.push(m);
    }
    if (out.length) result.warnings.push('No header row was found, so columns were read as name, value, unit, range. Please check the results.');
  }

  result.measurements = dedupeMeasurements(out);
  const dated = result.measurements.map(m => m.date).filter((d): d is string => !!d).sort();
  result.detectedDate = fileDate ?? dated[dated.length - 1] ?? null;
  if (!result.measurements.length) result.warnings.push('No test results were recognised. Expected columns like Test, Value, Unit, Reference range.');
  else if (unmatched) result.warnings.push(`${unmatched} row${unmatched === 1 ? '' : 's'} did not match a known biomarker; pick the right one or remove them.`);
  if (result.measurements.length && !result.measurements.some(m => m.date)) result.warnings.push('No date was found; please set the sample date.');
  return result;
}
