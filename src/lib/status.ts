// Range parsing, unit normalization and status computation.
import type { BiomarkerDef, Measurement, RefRange, Status } from '../types';
import { findMarker } from './catalog.ts';

/* ---------------- status ---------------- */

const NEGATIVE_WORDS = /^(?:neg(?:ative)?|nil|absent|none|not\s+(?:detected|seen|present)|non[\s-]?reactive|normal|nad|no\s+growth|occasional|rare|-ve)\b/i;
const POSITIVE_WORDS = /^(?:pos(?:itive)?|present|detected|reactive|trace|\+{1,4}|[1-4]\s*\+|\+ve)(?:\s|$|\b)/i;

/** Interpret qualitative results such as "Negative", "Nil", "Trace", "2+". */
export function qualitativeValue(text: string): 'negative' | 'positive' | null {
  const t = text.trim();
  if (!t) return null;
  if (NEGATIVE_WORDS.test(t)) return 'negative';
  if (POSITIVE_WORDS.test(t)) return 'positive';
  return null;
}

/**
 * Compare a value with a range. Boundaries are inclusive. Qualitative text is used when there is
 * no number: "Negative" is normal, "Positive"/"Trace" is high when the marker only has an upper limit.
 */
export function computeStatus(value: number | null | undefined, range: RefRange | null | undefined, valueText?: string): Status {
  if (value == null || !Number.isFinite(value)) {
    if (!valueText) return 'unknown';
    const q = qualitativeValue(valueText);
    if (q === 'negative') return 'normal';
    if (q === 'positive' && (range?.high != null || /neg|nil|absent/i.test(range?.text ?? ''))) return 'high';
    return 'unknown';
  }
  if (!range || (range.low == null && range.high == null)) return 'unknown';
  if (range.low != null && value < range.low) return 'low';
  if (range.high != null && value > range.high) return 'high';
  return 'normal';
}

const hasBounds = (r: RefRange | null | undefined): boolean => !!r && (r.low != null || r.high != null);

/** The range a measurement is judged against: the report's own range wins, else the catalog's typical range. */
export function resolveRange(def: BiomarkerDef | null | undefined, reportRange: RefRange | null | undefined): RefRange | null {
  if (reportRange && hasBounds(reportRange)) return { ...reportRange, source: 'report' };
  if (def?.typical && (def.typical.low != null || def.typical.high != null)) {
    return { low: def.typical.low, high: def.typical.high, text: typicalText(def.typical, def.unit), source: 'typical' };
  }
  return reportRange?.text ? { text: reportRange.text, source: 'report' } : null;
}

function typicalText(t: { low?: number; high?: number }, unit: string): string {
  const u = unit && unit !== 'ratio' && unit !== 'index' ? ` ${unit}` : '';
  if (t.low != null && t.high != null) return `${fmt(t.low)} – ${fmt(t.high)}${u}`;
  if (t.high != null) return `≤ ${fmt(t.high)}${u}`;
  return `≥ ${fmt(t.low ?? 0)}${u}`;
}

/* ---------------- range text ---------------- */

const NUM = String.raw`\d+(?:\.\d+)?|\.\d+`;
const EXPR = new RegExp(
  String.raw`between\s+(${NUM})\s+and\s+(${NUM})` +
  String.raw`|(${NUM})\s*(?:-|to)\s*(${NUM})` +
  String.raw`|(<=|>=|<|>|=<|=>|up\s*-?\s*to|till|less\s+than|lower\s+than|below|under|more\s+than|greater\s+than|higher\s+than|above|over|min(?:imum)?|max(?:imum)?)\s*:?\s*(${NUM})`,
  'gi',
);
const GOOD_LABEL = /desirable|optimal|normal|sufficien|reference|ideal|recommended|healthy|euthyroid|adult|negative|expected|target|good|acceptable/i;
const BAD_LABEL = /deficien|insufficien|toxic|borderline|high|elevated|\blow|risk|diabet|impaired|abnormal|poor|very|intoxication|excess|above|near|pregnan|trimester|child|infant|newborn|neonat|cord|elderly|decreased|increased/i;

function cleanRangeText(text: string): string {
  return text
    .replace(/[≤⩽]/g, '<=').replace(/[≥⩾]/g, '>=').replace(/[＜]/g, '<').replace(/[＞]/g, '>')
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/<\s*or\s*=|<\s*\/\s*=/gi, '<=').replace(/>\s*or\s*=|>\s*\/\s*=/gi, '>=')
    .replace(/(\d),(?=(?:\d{2},)*\d{3}\b)/g, '$1')
    .replace(/\b(?:x|\*)?\s*10\s*(?:\^|\*\*|e)\s*\d+/gi, ' ')
    .replace(/\b10[³⁶⁹]/g, ' ')
    .replace(/\/\s*1\.73\s*(?:m\s*[2²]|sq\.?\s*m)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface Expr { low?: number; high?: number; label: string }

const cleanLabel = (s: string) => s.replace(/[:;,|()[\]]/g, ' ').replace(/\s+/g, ' ').trim();

function extractExprs(t: string): Expr[] {
  const out: Expr[] = [];
  const spans: [number, number][] = [];
  let last = 0;
  EXPR.lastIndex = 0;
  for (let m = EXPR.exec(t); m; m = EXPR.exec(t)) {
    const label = cleanLabel(t.slice(last, m.index));
    spans.push([m.index, m.index + m[0].length]);
    last = m.index + m[0].length;
    if (m[1] != null) out.push({ low: +m[1], high: +m[2], label });
    else if (m[3] != null) {
      const a = +m[3], b = +m[4];
      out.push(a <= b ? { low: a, high: b, label } : { low: b, high: a, label });
    } else if (m[5] != null) {
      const op = m[5].toLowerCase().replace(/\s+/g, ' ');
      const n = +m[6];
      if (/^(<|=<|<=|up|till|less|lower|below|under|max)/.test(op)) out.push({ high: n, label });
      else out.push({ low: n, label });
    }
  }
  // Labels printed after each band ("<1 Low risk; 1-3 Average risk; >3 High risk").
  if (out.length > 1 && !out[0].label && cleanLabel(t.slice(spans[spans.length - 1][1]))) {
    out.forEach((e, i) => { e.label = cleanLabel(t.slice(spans[i][1], spans[i + 1]?.[0] ?? t.length)); });
  }
  return out;
}

/** Rewrite phrases whose words would otherwise be misread ("Low risk" is a good band, "Non-diabetic" is normal). */
function canonLabel(label: string): string {
  return label
    .replace(/non[\s-]?diabet\w*/gi, 'normal')
    .replace(/\b(?:low(?:er)?|minimal|no)\s+risk\b/gi, 'optimal')
    .replace(/\baverage\s+risk\b|\baverage\b|\bmoderate\s+risk\b/gi, 'average');
}

const isGood = (l: string) => GOOD_LABEL.test(l) && !BAD_LABEL.test(l);
const isAverage = (l: string) => /^average$/i.test(l.trim());

function pickBand(exprs: Expr[]): { low?: number; high?: number } | null {
  if (exprs.length === 1) {
    const e = exprs[0];
    const l = canonLabel(e.label);
    if (!l || isGood(l) || !BAD_LABEL.test(l)) return e;
    // A single risk band: "Low: <40" means at least 40 is fine; "High: >200" means up to 200 is fine.
    if (/^(?:low|deficien|insufficien|decreased)/i.test(l) && e.high != null && e.low == null) return { low: e.high };
    if (/^(?:high|elevated|increased|toxic|excess|risk)/i.test(l) && e.low != null && e.high == null) return { high: e.low };
    return null;
  }
  const labelled = exprs.map(e => ({ ...e, label: canonLabel(e.label) }));
  const good = labelled.filter(e => isGood(e.label) || isAverage(e.label));
  if (good.some(e => isGood(e.label))) {
    // Union of adjacent acceptable bands, e.g. "Low risk <1, Average risk 1-3" → ≤3.
    const first = good.find(e => isGood(e.label))!;
    let low = first.low, high = first.high;
    for (const e of good) {
      if (e === first) continue;
      if (high != null && e.low != null && Math.abs(e.low - high) <= Math.max(0.15 * Math.abs(high), 0.11)) high = e.high;
      else if (low != null && e.high != null && Math.abs(e.high - low) <= Math.max(0.15 * Math.abs(low), 0.11)) low = e.low;
    }
    return { low, high };
  }
  const male = labelled.find(e => /\b(?:male|men|m)\b/i.test(e.label) && !/female|women/i.test(e.label));
  const female = labelled.find(e => /\b(?:female|women|f)\b/i.test(e.label));
  if (male && female) {
    return {
      low: male.low != null && female.low != null ? Math.min(male.low, female.low) : undefined,
      high: male.high != null && female.high != null ? Math.max(male.high, female.high) : undefined,
    };
  }
  const neutral = labelled.find(e => !e.label || !BAD_LABEL.test(e.label));
  if (neutral) return neutral;
  // Infer the healthy band from risk bands, e.g. "Low: <40  High: >=60" or "Deficient <20, Toxic >100".
  let low: number | undefined, high: number | undefined;
  for (const e of labelled) {
    if (/^(?:low|deficien|insufficien|decreased)/i.test(e.label) && e.high != null && e.low == null) low = Math.max(low ?? -Infinity, e.high);
    else if (/^(?:high|elevated|increased|borderline|diabet|impaired|toxic|excess|risk|very)/i.test(e.label) && e.low != null) high = Math.min(high ?? Infinity, e.low);
  }
  return low != null || high != null ? { low, high } : null;
}

/** Parse printed reference range text into numeric bounds. Returns null when no bounds can be read. */
export function parseRangeText(text: string | null | undefined): RefRange | null {
  if (text == null) return null;
  const original = String(text).replace(/\s+/g, ' ').trim();
  if (!original || original.length > 400) return null;
  const exprs = extractExprs(cleanRangeText(original));
  if (!exprs.length) return null;
  const pick = pickBand(exprs);
  if (!pick) return null;
  const r: RefRange = { text: original, source: 'report' };
  if (pick.low != null && Number.isFinite(pick.low)) r.low = pick.low;
  if (pick.high != null && Number.isFinite(pick.high)) r.high = pick.high;
  if (r.low != null && r.high != null && r.low > r.high) return null;
  return r.low == null && r.high == null ? null : r;
}

/* ---------------- units ---------------- */

const UNIT_ALIASES: Record<string, string> = {
  'mg/dl': 'mg/dl', 'mg%': 'mg/dl', 'mg/100ml': 'mg/dl', 'mgs/dl': 'mg/dl', 'mgs%': 'mg/dl',
  'g/dl': 'g/dl', 'g%': 'g/dl', 'gm/dl': 'g/dl', 'gm%': 'g/dl', 'gms/dl': 'g/dl', 'gms%': 'g/dl', 'g/100ml': 'g/dl', 'grams/dl': 'g/dl', 'gram/dl': 'g/dl',
  'g/l': 'g/l', 'gm/l': 'g/l', 'mg/l': 'mg/l', 'ug/l': 'ng/ml', 'ng/ml': 'ng/ml', 'pg/ml': 'pg/ml', 'ng/l': 'pg/ml', 'ug/dl': 'ug/dl', 'ng/dl': 'ng/dl', 'ug/ml': 'ug/ml',
  'u/l': 'u/l', 'iu/l': 'u/l', 'units/l': 'u/l', 'unit/l': 'u/l', 'u/lit': 'u/l', 'iu/lit': 'u/l', 'iu/litre': 'u/l',
  'miu/l': 'uiu/ml', 'uiu/ml': 'uiu/ml', 'mu/l': 'uiu/ml', 'uu/ml': 'uiu/ml', 'uiu/ml(miu/l)': 'uiu/ml', 'miu/ml': 'miu/ml',
  'mmol/l': 'mmol/l', 'meq/l': 'meq/l', 'umol/l': 'umol/l', 'nmol/l': 'nmol/l', 'pmol/l': 'pmol/l', 'mmol/mol': 'mmol/mol',
  '10^3/ul': '10^3/ul', '10^3/cumm': '10^3/ul', '10^3cells/ul': '10^3/ul', '10^3cells/cumm': '10^3/ul', 'thousand/cumm': '10^3/ul', 'thou/cumm': '10^3/ul',
  'thousand/ul': '10^3/ul', 'thou/ul': '10^3/ul', 'thousands/cumm': '10^3/ul', '10^9/l': '10^3/ul', 'k/ul': '10^3/ul', '/nl': '10^3/ul', '103/ul': '10^3/ul', '103/cumm': '10^3/ul', 'k/cumm': '10^3/ul',
  '10^6/ul': '10^6/ul', '10^6/cumm': '10^6/ul', '10^6cells/ul': '10^6/ul', 'million/cumm': '10^6/ul', 'millions/cumm': '10^6/ul', 'mill/cumm': '10^6/ul', 'mil/cumm': '10^6/ul',
  'million/ul': '10^6/ul', 'mill/ul': '10^6/ul', 'mil/ul': '10^6/ul', '10^12/l': '10^6/ul', 'm/ul': '10^6/ul', '106/ul': '10^6/ul', '106/cumm': '10^6/ul', 'm/cumm': '10^6/ul',
  '/cumm': '/ul', 'cells/cumm': '/ul', '/ul': '/ul', 'cells/ul': '/ul', 'cell/cumm': '/ul', 'cells/cmm': '/ul', '/cmm': '/ul', 'per/cumm': '/ul', 'cumm': '/ul',
  'lakhs/cumm': 'lakh/ul', 'lakh/cumm': 'lakh/ul', 'lakhs/ul': 'lakh/ul', 'lakh/ul': 'lakh/ul', 'lakhs': 'lakh/ul', 'lakh': 'lakh/ul', 'lacs/cumm': 'lakh/ul', 'lac/cumm': 'lakh/ul',
  '%': '%', 'percent': '%', '%age': '%', 'l/l': 'l/l',
  'fl': 'fl', 'femtolitre': 'fl', 'femtoliter': 'fl', 'cumicron': 'fl', 'cu.micron': 'fl', 'cumicrons': 'fl', 'um^3': 'fl', 'um3': 'fl',
  'pg': 'pg', 'picogram': 'pg', 'pg/cell': 'pg', 'pgm': 'pg',
  'mm/hr': 'mm/hr', 'mm/h': 'mm/hr', 'mm/1sthr': 'mm/hr', 'mm/1hr': 'mm/hr', 'mm/1sthour': 'mm/hr', 'mmin1sthr': 'mm/hr', 'mm/hour': 'mm/hr', 'mm/1st': 'mm/hr', 'mmat1hr': 'mm/hr',
  'ml/min/1.73m2': 'ml/min/1.73m2', 'ml/min/1.73m^2': 'ml/min/1.73m2', 'ml/min/1.73sqm': 'ml/min/1.73m2', 'ml/min/1.73sq.m': 'ml/min/1.73m2', 'ml/min/1.73': 'ml/min/1.73m2', 'ml/min': 'ml/min',
  '/hpf': '/hpf', 'cells/hpf': '/hpf', '/h.p.f': '/hpf', 'perhpf': '/hpf', 'hpf': '/hpf', '/hpf.': '/hpf', 'cells/h.p.f': '/hpf', '/lpf': '/lpf',
  'ratio': '', 'index': '', 'ph': '', '': '', 'nmol/min/ml': 'nmol/min/ml',
};

/** Canonical comparison key for a unit string ("gm/dL", "g%" → "g/dl"; "thousand/cumm" → "10^3/ul"). */
export function unitKey(unit: string | null | undefined): string {
  if (!unit) return '';
  let s = unit.trim().toLowerCase();
  s = s.replace(/[µμ]/g, 'u').replace(/mcg/g, 'ug').replace(/micro\s*/g, 'u');
  s = s.replace(/³/g, '^3').replace(/⁶/g, '^6').replace(/⁹/g, '^9').replace(/¹²/g, '^12').replace(/²/g, '2');
  s = s.replace(/\s+/g, '').replace(/^\(|\)$/g, '').replace(/^\[|\]$/g, '');
  s = s.replace(/^per(?=[a-z])/, '/').replace(/\*\*|\*/g, '^').replace(/×/g, 'x');
  s = s.replace(/^x(?=10)/, '').replace(/10e(\d+)/g, '10^$1').replace(/10\^\^/g, '10^');
  s = s.replace(/litre|liter|lit\b/g, 'l').replace(/cu\.?mm|cmm(?!o)|mm\^3|mm3/g, 'cumm');
  s = s.replace(/^gms?(?=\/|%)/, 'g').replace(/^grams?(?=\/)/, 'g');
  s = s.replace(/\.$/, '');
  return UNIT_ALIASES[s] ?? s;
}

/** True when the text is a unit this module knows (gm%, thousand/cumm, mIU/L...). */
export function isKnownUnit(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 22) return false;
  const k = unitKey(t);
  return k !== '' && k in KNOWN_KEYS;
}

/** True when the text looks like a unit of measurement (known, or shaped like "x/y"). */
export function isUnitText(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 22) return false;
  if (isKnownUnit(t)) return true;
  return /^[a-zµμ%][a-zµμ0-9^.%]*\s*\/\s*[a-zµμ0-9.^²³]{1,14}(?:\s*(?:m2|m²|sq\.?\s*m))?$/i.test(t) && !/\d\s*-\s*\d/.test(t);
}
const KNOWN_KEYS: Record<string, true> = Object.fromEntries(Object.values(UNIT_ALIASES).filter(Boolean).map(v => [v, true as const]));
KNOWN_KEYS['ratio'] = true;

export interface UnitNormalization {
  value: number | null;
  unit: string;
  /** Maps a number in the printed unit to the canonical unit (identity when not converted). */
  convert: (v: number) => number;
  /** Printed unit is the canonical unit or a known alternative. */
  matched: boolean;
  converted: boolean;
  /** No unit was printed; the canonical unit was assumed. */
  missing: boolean;
}

const identity = (v: number) => v;

/** Convert a value into the marker's canonical unit using its `altUnits` table. */
export function normalizeUnit(def: BiomarkerDef, value: number | null, unit: string | null | undefined): UnitNormalization {
  const printed = (unit ?? '').trim();
  const key = unitKey(printed);
  const canon = unitKey(def.unit);
  if (key === canon) return { value, unit: def.unit, convert: identity, matched: true, converted: false, missing: false };
  if (!printed) return { value, unit: def.unit, convert: identity, matched: false, converted: false, missing: true };
  if (def.id === 'hba1c' && key === 'mmol/mol') {
    const convert = (v: number) => round(v * 0.09148 + 2.152, 2);
    return { value: value == null ? null : convert(value), unit: def.unit, convert, matched: true, converted: true, missing: false };
  }
  for (const alt of def.altUnits ?? []) {
    if (unitKey(alt.unit) === key) {
      if (alt.factor === 1) return { value, unit: def.unit, convert: identity, matched: true, converted: false, missing: false };
      const convert = (v: number) => round(v * alt.factor, sigDecimals(v * alt.factor));
      return { value: value == null ? null : convert(value), unit: def.unit, convert, matched: true, converted: true, missing: false };
    }
  }
  return { value, unit: printed, convert: identity, matched: false, converted: false, missing: false };
}

/** True when a measurement's unit can be compared with the catalog's typical range. */
export function unitComparable(def: BiomarkerDef, unit: string): boolean {
  const k = unitKey(unit);
  return k === '' || k === unitKey(def.unit);
}

export function convertRange(range: RefRange | null, convert: (v: number) => number): RefRange | null {
  if (!range) return null;
  const r: RefRange = { ...range };
  if (r.low != null) r.low = convert(r.low);
  if (r.high != null) r.high = convert(r.high);
  return r;
}

/* ---------------- formatting ---------------- */

function round(v: number, decimals: number): number {
  const p = 10 ** decimals;
  return Math.round(v * p) / p;
}

function sigDecimals(v: number): number {
  const a = Math.abs(v);
  if (a >= 100) return 0;
  if (a >= 10) return 1;
  if (a >= 1) return 2;
  return 3;
}

function fmt(v: number): string {
  const r = round(v, sigDecimals(v));
  return r.toLocaleString('en-US', { maximumFractionDigits: 3, useGrouping: Math.abs(r) >= 10000 });
}

/** Display text for a measurement value, e.g. "13.5 g/dL", "<0.5 mg/L" or "Negative". */
export function formatValue(m: Pick<Measurement, 'value' | 'valueText' | 'unit'>, withUnit = true): string {
  const unit = withUnit && m.unit && m.unit !== 'ratio' && m.unit !== 'index' ? ` ${m.unit}` : '';
  if (m.value == null) return m.valueText || '—';
  const printed = m.valueText.trim();
  const printedNum = parseFloat(printed.replace(/^[<>≤≥=]+\s*/, '').replace(/,/g, ''));
  if (printed && printedNum === m.value && /^[<>≤≥]?=?\s*[\d.,]+$/.test(printed)) return `${printed}${unit}`;
  const qual = /^\s*([<>≤≥])/.exec(printed)?.[1] ?? '';
  return `${qual}${fmt(m.value)}${unit}`;
}

/**
 * Re-derive range and status after an edit (marker, value, unit or range text changed).
 * A report range is kept; a typical range is re-resolved for the (possibly new) marker.
 */
export function refreshMeasurement(input: Measurement): Measurement {
  let m = input;
  const def = findMarker(m.markerId);
  if (def) {
    // A marker picked by hand may be in an alternative unit (e.g. mmol/L): convert to canonical.
    const norm = normalizeUnit(def, m.value, m.unit);
    if (norm.converted) m = { ...m, value: norm.value, unit: norm.unit, range: convertRange(m.range, norm.convert) };
    else if (norm.matched && m.unit !== def.unit) m = { ...m, unit: def.unit };
  }
  let range = m.range;
  if (range && range.source === 'report' && range.low == null && range.high == null && range.text) {
    range = parseRangeText(range.text) ?? range;
  }
  if (!range || range.source === 'typical' || (range.low == null && range.high == null)) {
    const typical = def && unitComparable(def, m.unit) ? resolveRange(def, null) : null;
    range = typical ?? (range?.source === 'report' ? range : null);
  }
  return { ...m, range, status: computeStatus(m.value, range, m.valueText) };
}
