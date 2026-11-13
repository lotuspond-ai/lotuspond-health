// Pure (DOM-free) lab-report text parser. Input: positioned text items per page (as from pdfjs
// getTextContent). Output: ParseResult. Kept free of pdfjs imports so it can be tested in Node.
import type { Measurement, ParseResult } from '../../types';
import { matchMarkerDetailed, type MarkerMatch, type MatchContext } from '../catalog.ts';
import { isKnownUnit, isUnitText } from '../status.ts';
import { buildMeasurement, dedupeMeasurements } from './rows.ts';
import { detectReportDate } from './dates.ts';

export interface PdfTextItem { str: string; x: number; y: number; width: number; height: number }
export interface PdfPageText { items: PdfTextItem[] }
export interface Cell { text: string; x0: number; x1: number }
export interface Line { page: number; y: number; height: number; cells: Cell[]; text: string }

/* ---------------- line reconstruction ---------------- */

/** Group items into lines by y (with tolerance), sort by x, and merge touching items into cells. */
export function buildLines(items: PdfTextItem[], page = 0): Line[] {
  const its = items
    .filter(i => i.str && i.str.trim())
    .map(i => ({ ...i, str: i.str.replace(/\s+/g, ' '), height: i.height > 0 ? i.height : 8 }));
  its.sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: { y: number; h: number; items: PdfTextItem[] }[] = [];
  for (const it of its) {
    let row: (typeof rows)[number] | null = null;
    for (let k = rows.length - 1; k >= 0 && k >= rows.length - 4; k--) {
      const tol = Math.max(1.5, 0.45 * Math.min(rows[k].h, it.height));
      if (Math.abs(rows[k].y - it.y) <= tol) { row = rows[k]; break; }
    }
    if (row) { row.items.push(it); row.h = Math.max(row.h, it.height); }
    else rows.push({ y: it.y, h: it.height, items: [it] });
  }
  return rows.map(r => {
    const sorted = r.items.sort((a, b) => a.x - b.x);
    const cells: Cell[] = [];
    for (const it of sorted) {
      const last = cells[cells.length - 1];
      const gap = last ? it.x - last.x1 : Infinity;
      const h = it.height;
      if (last && gap < 0.6 * h) {
        const needSpace = gap > 0.12 * h && !last.text.endsWith(' ') && !it.str.startsWith(' ');
        last.text = (last.text + (needSpace ? ' ' : '') + it.str);
        last.x1 = Math.max(last.x1, it.x + it.width);
      } else {
        cells.push({ text: it.str, x0: it.x, x1: it.x + it.width });
      }
    }
    for (const c of cells) c.text = c.text.trim();
    const kept = cells.filter(c => c.text);
    return { page, y: r.y, height: r.h, cells: kept, text: kept.map(c => c.text).join('  ') };
  }).filter(l => l.cells.length);
}

/* ---------------- tokens ---------------- */

interface Token { t: string; cell: number; x0: number }

const NUM_RE = /^([<>]=?|=)?((?:\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d+)?|\.\d+)$/;
const QUAL_RE = /^(?:negative|nil|absent|present|positive|trace|reactive|non-?reactive|not\s+detected|not\s+seen|detected|occasional|rare|acidic|alkaline|neutral|\+{1,4}|[1-4]\+)$/i;
const FLAG_RE = /^(?:\(?[hl]\)?|high|low|\*+|↑|↓|▲|▼|\(?a\)?|abnormal)$/i;
const SPAN_RE = /^\d+(?:\.\d+)?-\d+(?:\.\d+)?$/;
const TIME_WORD = /^(?:hrs?|hours?|mins?|minutes?|st|nd|rd|th)$/i;
const STOPWORDS = /\b(?:the|is|are|was|were|may|can|should|indicates?|suggests?|your|this|that|these|be|been|than|which|when|if|please|due|note|patients?|levels?\s+of|associated|recommended|consult)\b/i;

function tokenize(cells: Cell[]): Token[] {
  const out: Token[] = [];
  cells.forEach((c, ci) => {
    const text = c.text
      .replace(/[≤]/g, '<=').replace(/[≥]/g, '>=')
      .replace(/([<>]=?)\s+(?=\d)/g, '$1')
      .replace(/\bnot\s+(detected|seen|present)\b/gi, 'not $1')
      .replace(/\bnon\s+reactive\b/gi, 'non-reactive');
    const words = text.split(/\s+/).filter(Boolean);
    for (const w0 of words) {
      const w = w0.replace(/ /g, ' ');
      // Split "13.5g/dL" → "13.5" "g/dL", "13.5H" → "13.5" "H".
      const glued = /^([<>]=?)?(\d[\d,]*(?:\.\d+)?)([a-zµμ%/^][^\s]*)$/i.exec(w);
      if (glued && (isUnitText(glued[3]) || FLAG_RE.test(glued[3]))) {
        out.push({ t: (glued[1] ?? '') + glued[2], cell: ci, x0: c.x0 }, { t: glued[3], cell: ci, x0: c.x0 });
      } else out.push({ t: w, cell: ci, x0: c.x0 });
    }
  });
  return out;
}

const isNum = (t: string) => NUM_RE.test(t);
const isValueTok = (t: string) => isNum(t) || QUAL_RE.test(t) || SPAN_RE.test(t);

/* ---------------- row parsing ---------------- */

export interface ParsedRow {
  match: MarkerMatch;
  name: string;
  valueText: string;
  unit: string;
  rangeText: string;
  flag: string | null;
  /** x of the first range token (for continuation lines). */
  rangeX: number | null;
  line: Line;
}

const NOT_ROW_START = /^(?:method|note|notes|comments?|interpretation|remarks?|sample\s*type|specimen|test\s*name|page\b|printed|report(?:ed)?\b|dr\.?\b|doctor|patient|name\b|age\b|sex\b|gender|ref(?:erred)?\b|ref\.|lab\s*(?:no|id)|barcode|reg(?:istration)?\b|uhid|mobile|phone|tel\b|email|e-mail|address|www\.|http|clinical|kindly|disclaimer|this\s+report|end\s+of|\*{2,}|collected|received|sample\s*(?:collected|received)|technique|instrument|pathologist|consultant|signature|verified|authori[sz]ed)/i;

/** Words that commonly appear inside reference-range text and never start a new test row. */
const RANGE_WORD = /^(?:to|and|or|upto|up|male|female|men|women|m|f|adults?|child(?:ren)?|desirable|optimal|normal|near|borderline|high|low|very|deficien\w*|insufficien\w*|sufficien\w*|toxic\w*|non|pre|diabetic|average|risk|negative|nil|absent|less|more|than|below|above|ref\w*|range|interval|bio\w*|years?|yrs?)\b/i;

/** Test-method words that labs print in a column next to the name (Thyrocare/Apollo style). */
const METHOD_TAIL = /(?:^|(?<=[\s)\]]))(?:c\.?\s?l\.?\s?i\.?\s?a\.?|e\.?\s?c\.?\s?l\.?\s?i\.?\s?a\.?|h\.?\s?p\.?\s?l\.?\s?c\.?|photometry|spectrophotometry|calculated|calculation|derived|computed|hexokinase|god[-\s]?pod|i\.?\s?s\.?\s?e\.?(?:\s*-?\s*(?:in)?direct)?|immunoturbidimetr(?:y|ic)|turbidimetr(?:y|ic)|nephelometr(?:y|ic)|chemiluminescen(?:ce|t)|immunoassay|elisa|enzymatic|colorimetric|kinetic|dipstick|microscopy|visual|flow\s*cytometry|impedance|automated|westergren|ifcc|jaffe|uricase|bromocresol\s*green|biuret|diazo)\s*$/i;

/** Remove a trailing method column from a test name: "IRON PHOTOMETRY" → "IRON". */
export function stripMethod(name: string): string {
  let s = name.trim();
  for (let i = 0; i < 3; i++) {
    const t = s.replace(METHOD_TAIL, '').trim();
    if (t === s || !t) break;
    s = t.replace(/[-–:,]$/, '').trim();
  }
  return s;
}

/** Find "<marker name> <value>" at the start of the tokens: returns the matched marker and value index. */
function nameAndValue(tokens: Token[], ctx: MatchContext): { match: MarkerMatch; v: number } | null {
  if (tokens.length < 2) return null;
  const first = tokens[0].t;
  if ((isNum(first) || SPAN_RE.test(first)) && !/^\d+$/.test(first)) return null;
  const maxName = Math.min(tokens.length - 1, 14);
  for (let i = 1; i <= maxName; i++) {
    const tok = tokens[i].t;
    if (!isValueTok(tok)) continue;
    if (TIME_WORD.test(tokens[i + 1]?.t ?? '')) continue; // "2 hr", "1st hour" belong to the name
    const name = stripMethod(tokens.slice(0, i).map(x => x.t).join(' '));
    const m = matchMarkerDetailed(name, ctx);
    if (!m) continue;
    if (!m.exact && STOPWORDS.test(name)) return null;
    // A span value ("2-4") is only a result for urine microscopy; elsewhere it is a range.
    if (SPAN_RE.test(tok) && m.def.system !== 'urine') return null;
    // A number followed by "- n" / "to n" is a range, not a result (interpretation text).
    if (isNum(tok) && /^(?:-|–|to)$/i.test(tokens[i + 1]?.t ?? '') && isNum(tokens[i + 2]?.t ?? '') && m.def.system !== 'urine') return null;
    // The number may be part of the name ("Vitamin D 25 Hydroxy 18.4"): prefer a later value whose
    // longer name matches a longer alias of the same marker.
    const nextTok = tokens[i + 1]?.t ?? '';
    if (/^[a-z]{2,}/i.test(nextTok) && !isUnitText(nextTok) && !FLAG_RE.test(nextTok) && !RANGE_WORD.test(nextTok)) {
      for (let j = i + 2; j <= Math.min(tokens.length - 1, i + 6); j++) {
        if (!isNum(tokens[j].t)) continue;
        const later = matchMarkerDetailed(stripMethod(tokens.slice(0, j).map(x => x.t).join(' ')), ctx);
        if (later && later.def.id === m.def.id && later.alias.length > m.alias.length) return { match: later, v: j };
        break;
      }
    }
    return { match: m, v: i };
  }
  return null;
}

/** Index in `rest` where a new "<name> <value>" row starts (side-by-side columns merged into one cell). */
function nextRowStart(rest: Token[], ctx: MatchContext): number {
  for (let j = 0; j < rest.length - 1; j++) {
    const t = rest[j].t;
    if (!/^[a-z(%]/i.test(t) || RANGE_WORD.test(t) || isKnownUnit(t)) continue;
    const prev = rest[j - 1]?.t ?? '';
    if (/^(?:-|–|to|:)$/i.test(prev)) continue;
    const probe = nameAndValue(rest.slice(j), ctx);
    if (!probe) continue;
    const name = rest.slice(j, j + probe.v).map(x => x.t).join(' ');
    if (name.replace(/[^a-z]/gi, '').length < 3 && rest[j].cell === rest[Math.max(0, j - 1)].cell) continue;
    return j;
  }
  return -1;
}

function parseSegment(tokens: Token[], ctx: MatchContext, line: Line): { row: ParsedRow; remainder: Token[] } | null {
  const nv = nameAndValue(tokens, ctx);
  if (!nv) return null;
  const { match, v } = nv;
  let nameEnd = v;
  let flag: string | null = null;
  // Flag printed before the value ("Hemoglobin  L  12.1").
  if (v >= 2 && /^\(?[hl]\)?$/i.test(tokens[v - 1].t) && tokens[v - 1].cell !== tokens[v - 2].cell) { flag = tokens[v - 1].t; nameEnd = v - 1; }
  const name = stripMethod(tokens.slice(0, nameEnd).map(x => x.t).join(' '));
  let valueText = tokens[v].t;
  let k = v + 1;
  if (match.def.system === 'urine' && isNum(valueText) && /^(?:-|–|to)$/i.test(tokens[k]?.t ?? '') && isNum(tokens[k + 1]?.t ?? '')) {
    valueText = `${valueText}-${tokens[k + 1].t}`;
    k += 2;
  }
  if (!flag && k < tokens.length && FLAG_RE.test(tokens[k].t) && !/^(?:high|low)\s*:/i.test(tokens.slice(k, k + 2).map(x => x.t).join(' '))) {
    flag = tokens[k].t;
    k++;
  }
  let rest = tokens.slice(k);
  let remainder: Token[] = [];
  const cut = nextRowStart(rest, ctx);
  if (cut >= 0) { remainder = rest.slice(cut); rest = rest.slice(0, cut); }
  // Unit: the first run of 1–3 tokens that reads as a unit (known units first, then unit-shaped tokens).
  let unit = '';
  let unitAt = -1, unitLen = 0;
  const unitCand = (i: number, len: number): string | null => {
    const part = rest.slice(i, i + len);
    if (part.length < len || part.some(p => p.cell !== part[0].cell)) return null;
    const cand = part.map(p => p.t).join(' ');
    if (/^[\d<>=.-]/.test(cand) && !/^10\s*\^|^10[³⁶⁹]|^\d+\s*\^/.test(cand)) return null;
    return cand;
  };
  outer: for (const strict of [true, false]) {
    for (let i = 0; i < rest.length; i++) {
      for (let len = strict ? Math.min(3, rest.length - i) : 1; len >= 1; len--) {
        const cand = unitCand(i, len);
        if (cand && (strict ? isKnownUnit(cand) : isUnitText(cand))) { unit = cand; unitAt = i; unitLen = len; break outer; }
      }
    }
  }
  const rangeToks = unitAt >= 0 ? [...rest.slice(0, unitAt), ...rest.slice(unitAt + unitLen)] : rest;
  // Drop leading words that are not part of a range (method names in a separate column).
  let r0 = 0;
  while (r0 < rangeToks.length && !/[\d<>]|^(?:upto|up|desirable|optimal|normal|male|female|adults?|negative|nil|absent|less|more|below|above|deficien|sufficien|insufficien|non|low|high|borderline|m|f|men|women|child|ref)/i.test(rangeToks[r0].t)) r0++;
  let rangeT = rangeToks.slice(r0);
  // Stop at a later cell that starts a new test name (unsplit side-by-side tables, trailing notes).
  const stop = rangeT.findIndex((x, i) => i > 0 && x.cell !== rangeT[i - 1].cell && /^[a-z]{3,}/i.test(x.t)
    && !/^(?:to|and|upto|up|or|male|female|men|women|adults?|desirable|optimal|normal|borderline|high|low|deficien|insufficien|sufficien|toxic|non|pre|diabetic|average|risk|negative|nil)/i.test(x.t)
    && !!matchMarkerDetailed(rangeT.slice(i).map(y => y.t).join(' ').replace(/\s+[\d<>].*$/, '')));
  if (stop > 0) rangeT = rangeT.slice(0, stop);
  // A method column printed after the range ("<75 Immunoturbidimetric", "0.35-4.75 CLIA") is not part of it.
  const rangeText = stripMethod(rangeT.map(x => x.t).join(' ').trim());
  return { row: { match, name, valueText, unit, rangeText, flag, rangeX: rangeT[0]?.x0 ?? null, line }, remainder };
}

const HEADER_NAME = /^(?:test(?:\s*name|\s*description)?|investigations?|parameters?|tests?|examination|analyte)$/i;
const HEADER_VALUE = /^(?:results?|values?|observed(?:\s*value)?|your\s*value|observation)$/i;
const HEADER_RANGE = /ref|interval|range|normal|biological/i;

interface TableHeader { starts: number[]; rangeX: number | null }

function readHeader(line: Line): TableHeader | null {
  const names = line.cells.filter(c => HEADER_NAME.test(c.text));
  const values = line.cells.filter(c => HEADER_VALUE.test(c.text));
  if (!names.length || !values.length) return null;
  const range = line.cells.find(c => HEADER_RANGE.test(c.text) && !HEADER_NAME.test(c.text));
  return { starts: names.map(c => c.x0), rangeX: range?.x0 ?? null };
}

/** Split a line holding two side-by-side tables into one cell list per table. */
function splitSegments(cells: Cell[], header: TableHeader | null, ctx: MatchContext): Cell[][] {
  if (cells.length < 4) return [cells];
  const segs: Cell[][] = [];
  let cur: Cell[] = [];
  let curHasValue = false;
  for (let j = 0; j < cells.length; j++) {
    const c = cells[j];
    const firstTok = c.text.split(/\s+/)[0] ?? '';
    const startsText = /^[a-z(]/i.test(c.text) && !isValueTok(firstTok) && !isUnitText(c.text);
    const nextIsValue = isValueTok((cells[j + 1]?.text ?? '').split(/\s+/)[0] ?? '');
    const atTableStart = !!header && header.starts.length > 1 && header.starts.slice(1).some(x => Math.abs(x - c.x0) < 12);
    if (j > 0 && curHasValue && startsText && (atTableStart || (nextIsValue && matchMarkerDetailed(c.text, ctx)))) {
      segs.push(cur); cur = []; curHasValue = false;
    }
    cur.push(c);
    if (cur.length > 1 && isValueTok(firstTok)) curHasValue = true;
  }
  if (cur.length) segs.push(cur);
  return segs;
}

const URINE_SECTION = /urine|urinalysis|routine\s+examination|physical\s+examination|chemical\s+examination|microscopic\s+examination/i;
const OTHER_SECTION = /h(?:a)?ematology|complete\s+blood|blood\s+count|\bcbc\b|hemogram|haemogram|biochemistry|lipid|liver|kidney|renal|thyroid|serum|diabet|glucose|vitamin|iron|hormone|immunology|electrolyte|cardiac/i;

export interface LineParseOutput { rows: ParsedRow[]; text: string; lines: Line[] }

/** Find result rows in reconstructed lines. Exposed for tests. */
export function findRows(lines: Line[]): ParsedRow[] {
  const rows: ParsedRow[] = [];
  let header: TableHeader | null = null;
  let section: MatchContext['section'] = null;
  let last: ParsedRow | null = null;
  let page = -1;
  for (const line of lines) {
    if (line.page !== page) { page = line.page; last = null; }
    const h = readHeader(line);
    if (h) { header = h; last = null; continue; }
    const text = line.text.trim();
    if (NOT_ROW_START.test(text)) { last = null; continue; }
    const segs = splitSegments(line.cells, header, { section });
    let found = false;
    for (const seg of segs) {
      let toks = tokenize(seg);
      for (let guard = 0; toks.length && guard < 8; guard++) {
        const r = parseSegment(toks, { section }, line);
        if (!r) break;
        rows.push(r.row); last = r.row; found = true;
        toks = r.remainder;
      }
    }
    if (found) continue;
    // Section headings switch urine context ("URINE ROUTINE", "MICROSCOPIC EXAMINATION").
    if (!/\d/.test(text) && text.length < 70) {
      if (URINE_SECTION.test(text)) section = 'urine';
      else if (OTHER_SECTION.test(text)) section = null;
    }
    // Continuation of a multi-line reference range under the range column.
    const rangeX = last?.rangeX ?? header?.rangeX ?? null;
    if (last && rangeX != null && last.line.page === line.page && line.cells[0].x0 >= rangeX - 4
      && last.line.y - line.y < 6 * line.height && text.length < 80 && /\d|negative|nil/i.test(text)) {
      last.rangeText = last.rangeText ? `${last.rangeText}; ${text}` : text;
      continue;
    }
    last = null;
  }
  return rows;
}

/* ---------------- document ---------------- */

function plausible(m: Measurement): boolean {
  if (m.value == null || !m.range || m.range.source !== 'typical') return true;
  const ref = m.range.high ?? m.range.low;
  if (!ref || ref <= 0) return true;
  return m.value <= ref * 25 && m.value >= ref / 200;
}

/** Parse pages of positioned text into measurements. */
export function parseReportPages(pages: PdfPageText[], sourceFile: string): ParseResult {
  const result: ParseResult = { measurements: [], scans: [], blobs: {}, warnings: [], detectedDate: null };
  const pageLines = pages.map((p, i) => buildLines(p.items, i));
  const allLines = pageLines.flat();
  const chars = allLines.reduce((n, l) => n + l.text.replace(/\s/g, '').length, 0);
  if (chars < 20) {
    result.warnings.push('This PDF has no readable text (it is probably a scanned image). Upload a photo of each page as an image, or a CSV export from your lab, instead.');
    return result;
  }
  const pageText = pageLines.map(ls => ls.map(l => l.text).join('\n'));
  const docDate = detectReportDate(pageText.join('\n'));
  const pageDates = pageText.map(t => detectReportDate(t, { requireLabel: true }) ?? docDate);
  result.detectedDate = docDate;

  const rows = findRows(allLines);
  const out: Measurement[] = [];
  for (const r of rows) {
    const m = buildMeasurement(
      { name: r.name, value: r.valueText, unit: r.unit, range: r.rangeText, flag: r.flag, markerId: r.match.def.id },
      { sourceFile, date: pageDates[r.line.page] ?? docDate },
    );
    if (!m) continue;
    m.rawName = r.name;
    const nameWords = r.match.name.split(' ').length;
    const aliasWords = r.match.alias.split(' ').length;
    if (!r.match.exact && aliasWords * 2 < nameWords) m.confidence = 'low';
    if (!plausible(m)) m.confidence = 'low';
    out.push(m);
  }
  result.measurements = dedupeMeasurements(out);
  if (!result.measurements.length) result.warnings.push('No test results were recognised in this PDF. If it is a lab report, try a CSV export or add values by hand.');
  if (result.measurements.length && !docDate) result.warnings.push('No sample date was found; please set it before adding.');
  return result;
}
