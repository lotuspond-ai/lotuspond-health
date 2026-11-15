// JSON import: rows array, {date, results:[...]}, or our own export {version:1, measurements, scans}.
import type { Measurement, ParseResult, ScanItem } from '../../types';
import { buildMeasurement, dedupeMeasurements, type RawRow } from './rows.ts';
import { parseDate } from './dates.ts';
import { refreshMeasurement } from '../status.ts';
import { findMarker } from '../catalog.ts';
import { uid } from '../id.ts';
import { isFhir, parseFhir } from './fhir.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (v == null ? null : typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : null);

const KEYS = {
  name: ['name', 'test', 'testname', 'test_name', 'parameter', 'investigation', 'analyte', 'biomarker', 'marker', 'component', 'description', 'label', 'title'],
  value: ['value', 'result', 'results', 'observedvalue', 'observed_value', 'reading', 'resultvalue', 'valuequantity', 'valuestring'],
  unit: ['unit', 'units', 'uom'],
  range: ['range', 'reference', 'referencerange', 'reference_range', 'refrange', 'ref_range', 'refinterval', 'normalrange', 'biologicalreference', 'biological_reference_interval', 'bioref'],
  low: ['low', 'min', 'lower', 'reflow', 'ref_low', 'rangelow'],
  high: ['high', 'max', 'upper', 'refhigh', 'ref_high', 'rangehigh'],
  date: ['date', 'collected', 'collectedon', 'collected_on', 'collectiondate', 'sampledate', 'sample_date', 'effectivedatetime', 'drawn', 'testdate'],
  flag: ['flag', 'status', 'interpretation', 'abnormal'],
  marker: ['markerid', 'marker_id'],
};

function pick(o: Obj, keys: string[]): unknown {
  const lower = new Map(Object.keys(o).map(k => [k.toLowerCase().replace(/[\s-]/g, ''), k]));
  for (const k of keys) {
    const real = lower.get(k.replace(/[\s-]/g, ''));
    if (real != null && o[real] != null && o[real] !== '') return o[real];
  }
  return undefined;
}

function valueOf(v: unknown): { value: string | number | null; unit: string | null } {
  if (typeof v === 'number' || typeof v === 'string') return { value: v, unit: null };
  if (isObj(v)) return { value: (typeof v.value === 'number' || typeof v.value === 'string') ? v.value : null, unit: str(v.unit) ?? str(v.code) };
  return { value: null, unit: null };
}

function rangeOf(v: unknown): { text: string | null; low: number | string | null; high: number | string | null } {
  if (typeof v === 'string' || typeof v === 'number') return { text: String(v), low: null, high: null };
  if (Array.isArray(v) && v.length) return rangeOf(v[0]);
  if (isObj(v)) {
    const lowV = isObj(v.low) ? v.low.value : v.low;
    const highV = isObj(v.high) ? v.high.value : v.high;
    return { text: str(v.text), low: str(lowV), high: str(highV) };
  }
  return { text: null, low: null, high: null };
}

function rowFrom(o: Obj, fallbackDate: string | null): RawRow | null {
  let name = pick(o, KEYS.name);
  if (isObj(name)) name = name.text ?? (Array.isArray(name.coding) && isObj(name.coding[0]) ? name.coding[0].display : undefined);
  const nameStr = str(name);
  if (!nameStr) return null;
  const v = valueOf(pick(o, KEYS.value));
  const r = rangeOf(pick(o, KEYS.range));
  return {
    name: nameStr,
    value: v.value,
    unit: str(pick(o, KEYS.unit)) ?? v.unit,
    range: r.text,
    low: str(pick(o, KEYS.low)) ?? r.low,
    high: str(pick(o, KEYS.high)) ?? r.high,
    date: parseDate(str(pick(o, KEYS.date))) ?? fallbackDate,
    flag: str(pick(o, KEYS.flag)),
    markerId: str(pick(o, KEYS.marker)),
  };
}

function isMeasurement(v: unknown): v is Measurement {
  return isObj(v) && typeof v.rawName === 'string' && typeof v.valueText === 'string' && 'markerId' in v && 'status' in v;
}
function isScan(v: unknown): v is ScanItem {
  return isObj(v) && typeof v.fileName === 'string' && typeof v.blobKey === 'string' && (v.kind === 'image' || v.kind === 'dicom');
}

const DATA_URL = /^data:([^;,]+)?(;base64)?,/;
function dataUrlToBlob(url: string): Blob | null {
  const m = DATA_URL.exec(url);
  if (!m) return null;
  const body = url.slice(m[0].length);
  try {
    if (m[2]) {
      const bin = atob(body);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes], { type: m[1] ?? 'application/octet-stream' });
    }
    return new Blob([decodeURIComponent(body)], { type: m[1] ?? 'text/plain' });
  } catch { return null; }
}

/** Parse JSON text into measurements (and scans, for our own export format). */
export function parseJsonText(text: string, sourceFile: string): ParseResult {
  const result: ParseResult = { measurements: [], scans: [], blobs: {}, warnings: [], detectedDate: null };
  let data: unknown;
  try { data = JSON.parse(text.replace(/^﻿/, '')); } catch {
    result.warnings.push('This JSON file could not be read (invalid JSON).');
    return result;
  }

  // FHIR R4 (ABDM / ABHA apps, hospital portals). PDFs inside it are read by parseFile (index.ts).
  if (isFhir(data)) {
    const { attachments: _attachments, ...fhir } = parseFhir(data, sourceFile);
    return fhir;
  }

  // Our own export.
  if (isObj(data) && data.version === 1 && Array.isArray(data.measurements)) {
    for (const m of data.measurements) {
      if (!isMeasurement(m)) continue;
      const known = m.markerId && findMarker(m.markerId) ? m.markerId : null;
      result.measurements.push(refreshMeasurement({ ...m, markerId: known, id: typeof m.id === 'string' ? m.id : uid() }));
    }
    if (Array.isArray(data.scans)) {
      for (const s of data.scans) {
        if (!isScan(s)) continue;
        result.scans.push(s);
        const original = isObj(data.blobs) ? str(data.blobs[s.blobKey]) : null;
        const blob = (original && dataUrlToBlob(original)) ?? (s.thumbDataUrl ? dataUrlToBlob(s.thumbDataUrl) : null);
        if (blob) result.blobs[s.blobKey] = blob;
      }
      if (result.scans.length && !isObj(data.blobs)) result.warnings.push('Scans were restored from their thumbnails; the full-size originals are not part of this export.');
    }
    const ds = result.measurements.map(m => m.date).filter((d): d is string => !!d).sort();
    result.detectedDate = ds[ds.length - 1] ?? null;
    return result;
  }

  const groups: { date: string | null; rows: unknown[] }[] = [];
  const visit = (v: unknown, date: string | null, depth: number) => {
    if (depth > 4) return;
    if (Array.isArray(v)) {
      if (v.some(x => isObj(x) && pick(x, KEYS.name) != null && (pick(x, KEYS.value) != null))) groups.push({ date, rows: v });
      else for (const x of v) visit(x, date, depth + 1);
      return;
    }
    if (!isObj(v)) return;
    const d = parseDate(str(pick(v, KEYS.date))) ?? date;
    const list = v.results ?? v.tests ?? v.measurements ?? v.observations ?? v.data ?? v.items ?? v.parameters ?? v.reports ?? v.entry;
    if (list != null) visit(list, d, depth + 1);
    else if (isObj(v.resource)) visit([v.resource], d, depth + 1);
  };
  visit(data, null, 0);

  const out: Measurement[] = [];
  let unmatched = 0;
  for (const g of groups) {
    for (const r of g.rows) {
      if (!isObj(r)) continue;
      const raw = rowFrom(r, g.date);
      if (!raw) continue;
      const m = buildMeasurement(raw, { sourceFile, date: g.date, keepUnmatched: true });
      if (!m) continue;
      if (!m.markerId) unmatched++;
      out.push(m);
    }
  }
  result.measurements = dedupeMeasurements(out);
  const ds = result.measurements.map(m => m.date).filter((d): d is string => !!d).sort();
  result.detectedDate = ds[ds.length - 1] ?? null;
  if (!result.measurements.length) result.warnings.push('No test results were found. Expected an array of {name, value, unit, range} objects.');
  else if (unmatched) result.warnings.push(`${unmatched} row${unmatched === 1 ? '' : 's'} did not match a known biomarker; pick the right one or remove them.`);
  return result;
}
