// Turns a raw (name, value, unit, range) row from any source into a Measurement.
import type { BiomarkerDef, Measurement, RefRange, Status } from '../../types';
import { findMarker, matchMarkerName, PERCENT_ABSOLUTE_PAIRS, type MatchContext } from '../catalog.ts';
import { uid } from '../id.ts';
import { computeStatus, convertRange, normalizeUnit, parseRangeText, qualitativeValue, resolveRange, unitKey } from '../status.ts';

export interface RawRow {
  name: string;
  value: string | number | null | undefined;
  unit?: string | null;
  range?: string | null;
  low?: string | number | null;
  high?: string | number | null;
  date?: string | null;
  flag?: string | null;
  /** Pre-resolved marker id (e.g. from our own export); skips name matching. */
  markerId?: string | null;
}

export interface BuildOptions extends MatchContext {
  sourceFile: string;
  date: string | null;
  /** Keep rows that do not match the catalog (low confidence). */
  keepUnmatched?: boolean;
}

export interface ParsedValue { value: number | null; text: string; flag: Status | null }

const FLAG_RE = /(?:^|\s)(\(?(?:h|l|hi|lo|high|low|a|abn|abnormal|\*+|↑|↓|▲|▼)\)?)(?=\s|$)/i;

function flagOf(token: string | null | undefined): Status | null {
  if (!token) return null;
  const t = token.replace(/[()]/g, '').trim().toLowerCase();
  if (/^(?:h|hi|high|↑|▲)$/.test(t)) return 'high';
  if (/^(?:l|lo|low|↓|▼)$/.test(t)) return 'low';
  return null;
}

/** Parse a printed result: "13.5", "1,234", "<0.5", "13.5 H", "2.5 lakhs", "Negative", "2-4". */
export function parseValue(input: string | number | null | undefined): ParsedValue {
  if (input == null) return { value: null, text: '', flag: null };
  if (typeof input === 'number') return { value: Number.isFinite(input) ? input : null, text: String(input), flag: null };
  let text = input.replace(/\s+/g, ' ').trim();
  let flag: Status | null = null;
  const f = FLAG_RE.exec(` ${text} `.replace(/\s+$/, ' '));
  if (f) {
    flag = flagOf(f[1]);
    if (/\d/.test(text)) text = text.replace(f[1], ' ').replace(/\s+/g, ' ').trim();
  }
  text = text.replace(/[*↑↓▲▼]+$/, '').trim();
  if (!text) return { value: null, text: input.trim(), flag };
  const cleaned = text.replace(/[≤]/g, '<=').replace(/[≥]/g, '>=');
  // Range-like results ("2-4" pus cells per hpf): use the upper bound.
  const span = /^(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)$/.exec(cleaned);
  if (span) return { value: +span[2], text, flag };
  const m = /^([<>]=?|=)?\s*((?:\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d+)?|\.\d+)(?:\s*(lakhs?|lacs?|thousand|k))?(?=$|\s|[a-zµμ/%^(])/i.exec(cleaned);
  if (m) {
    let v = parseFloat(m[2].replace(/,/g, ''));
    const mult = m[3]?.toLowerCase();
    if (mult && /^la/.test(mult)) v *= 100000;
    else if (mult === 'thousand' || mult === 'k') v *= 1000;
    return { value: Number.isFinite(v) ? v : null, text, flag };
  }
  return { value: null, text, flag };
}

const COUNT_MARKERS = new Set(['wbc', 'platelets', 'neutrophils_abs', 'lymphocytes_abs', 'monocytes_abs', 'eosinophils_abs', 'basophils_abs']);
const toNum = (v: string | number | null | undefined): number | undefined => {
  if (v == null || v === '') return undefined;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, '').replace(/^[<>=≤≥]+/, ''));
  return Number.isFinite(n) ? n : undefined;
};

function rangeFromRow(row: RawRow): RefRange | null {
  const text = row.range?.toString().trim();
  const low = toNum(row.low), high = toNum(row.high);
  if (low != null || high != null) {
    const t = text || [low ?? '', high ?? ''].join(' - ').replace(/^ - | - $/g, '');
    return { low, high, text: t, source: 'report' };
  }
  if (!text) return null;
  return parseRangeText(text) ?? { text, source: 'report' };
}

/** Correct percent/absolute WBC differential matches using the printed unit. */
function adjustForUnit(def: BiomarkerDef, unit: string): BiomarkerDef {
  const k = unitKey(unit);
  if (!k) return def;
  const abs = PERCENT_ABSOLUTE_PAIRS[def.id];
  if (abs && k !== '%') {
    const absDef = findMarker(abs);
    if (absDef && (normalizeUnit(absDef, 1, unit).matched)) return absDef;
  }
  if (!abs && k === '%') {
    const pct = Object.entries(PERCENT_ABSOLUTE_PAIRS).find(([, a]) => a === def.id)?.[0];
    const pctDef = findMarker(pct);
    if (pctDef) return pctDef;
  }
  return def;
}

/** Build a Measurement, or null when the row has no usable name/value. */
export function buildMeasurement(row: RawRow, opts: BuildOptions): Measurement | null {
  const rawName = row.name.replace(/\s+/g, ' ').trim();
  const pv = parseValue(row.value);
  if (!rawName || (!pv.text && pv.value == null)) return null;
  let unit = (row.unit ?? '').replace(/\s+/g, ' ').trim();
  let def: BiomarkerDef | null = row.markerId ? findMarker(row.markerId) ?? null : matchMarkerName(rawName, opts);
  if (!def && !opts.keepUnmatched) return null;
  if (def) def = adjustForUnit(def, unit);
  const flag = pv.flag ?? flagOf(row.flag);

  let value = pv.value;
  let range = rangeFromRow(row);
  let confidence: Measurement['confidence'] = 'low';

  if (def) {
    const norm = normalizeUnit(def, value, unit);
    if (norm.converted) {
      value = norm.value;
      range = convertRange(range, norm.convert);
    }
    unit = norm.unit;
    // Counts printed without units in cells/cumm (e.g. WBC 7800) → thousands.
    if (norm.missing && value != null && COUNT_MARKERS.has(def.id) && def.typical?.high != null && value > def.typical.high * 100) {
      value = value / 1000;
      range = convertRange(range, v => v / 1000);
    }
    const qualitative = value == null && qualitativeValue(pv.text) != null;
    if ((value != null && norm.matched) || (qualitative && (norm.matched || norm.missing))) confidence = 'high';
    else if (value != null || qualitative) confidence = 'medium';
    // Qualitative result with a printed qualitative range ("Negative" / "NEGATIVE"): keep both as printed.
    const textOnlyRange = !!range?.text && range.low == null && range.high == null;
    if (value == null && textOnlyRange) {
      if (norm.missing) unit = '';
    } else if (norm.matched || norm.missing) {
      // With an unknown unit the catalog range is not comparable, so only a printed range is used.
      range = resolveRange(def, range);
    }
  }

  // A converted value is shown and edited as converted: the review's value box next to "10^3/µL" must read 7.8,
  // not the printed 7800 (editing that would store 7800 thousand). A "<" or ">" qualifier is kept.
  let valueText = pv.text;
  if (value != null && pv.value != null && value !== pv.value) {
    const qualifier = /^\s*([<>]=?|≤|≥)/.exec(pv.text)?.[1] ?? '';
    valueText = `${qualifier}${Number(value.toPrecision(6))}`;
  }

  let status = computeStatus(value, range, pv.text);
  if (status === 'unknown' && flag) status = flag;
  if (value == null && def && confidence === 'high' && qualitativeValue(pv.text) === 'positive' && def.lowerIsBetter) status = 'high';

  return {
    id: uid(),
    markerId: def?.id ?? null,
    rawName,
    value,
    valueText,
    unit,
    range,
    status,
    date: row.date ?? opts.date,
    sourceFile: opts.sourceFile,
    confidence,
  };
}

/** Keep the first occurrence of each marker (or raw name) per date. */
export function dedupeMeasurements(ms: Measurement[]): Measurement[] {
  const seen = new Set<string>();
  const out: Measurement[] = [];
  for (const m of ms) {
    const k = `${m.markerId ?? 'raw:' + m.rawName.toLowerCase()}|${m.date ?? ''}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(m);
  }
  return out;
}

export function emptyResult(): { measurements: Measurement[]; scans: []; blobs: Record<string, Blob>; warnings: string[]; detectedDate: string | null } {
  return { measurements: [], scans: [], blobs: {}, warnings: [], detectedDate: null };
}
