// Date detection for lab reports. Output is ISO yyyy-mm-dd.

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};
const MON = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?`;

const pad = (n: number) => String(n).padStart(2, '0');

function valid(y: number, m: number, d: number): boolean {
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function iso(y: number, m: number, d: number): string | null {
  if (y < 100) y += y >= 70 ? 1900 : 2000;
  return valid(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : null;
}

export interface DateHit { iso: string; index: number; length: number; ambiguous: boolean }

/** Day-first unless only month-first is valid, or the caller says the source is US formatted. */
const NUMERIC = /\b(\d{1,4})[./-](\d{1,2}|[a-z]{3,9}\.?)[./-](\d{2,4})\b/gi;
const ISO_RE = /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s]\d{1,2}:\d{2}(?::\d{2})?)?/g;
const DMY_TEXT = new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?[\s,/-]+${MON}[\s,/-]+'?(\d{2,4})\b`, 'gi');
const MDY_TEXT = new RegExp(String.raw`\b${MON}[\s,/-]+(\d{1,2})(?:st|nd|rd|th)?,?[\s,/-]+(\d{4})\b`, 'gi');
const COMPACT = /\b((?:19|20)\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\b/g;

export interface DateOptions {
  /** Treat ambiguous numeric dates as MM/DD/YYYY. */
  us?: boolean;
  /** Allow yyyymmdd (DICOM style). */
  compact?: boolean;
  /** Only return a date that carries a collection-type label (collected, sample, drawn...). */
  requireLabel?: boolean;
}

/** All date-like substrings in the text, in order. */
export function findDates(text: string, opts: DateOptions = {}): DateHit[] {
  const hits: DateHit[] = [];
  const taken: [number, number][] = [];
  const overlaps = (i: number, len: number) => taken.some(([a, b]) => i < b && i + len > a);
  const push = (h: DateHit | null) => {
    if (!h || overlaps(h.index, h.length)) return;
    hits.push(h);
    taken.push([h.index, h.index + h.length]);
  };

  for (const m of text.matchAll(ISO_RE)) {
    const v = iso(+m[1], +m[2], +m[3]);
    push(v ? { iso: v, index: m.index, length: m[0].length, ambiguous: false } : null);
  }
  for (const m of text.matchAll(DMY_TEXT)) {
    const v = iso(+m[3], MONTHS[m[2].toLowerCase().replace('.', '')] ?? 0, +m[1]);
    push(v ? { iso: v, index: m.index, length: m[0].length, ambiguous: false } : null);
  }
  for (const m of text.matchAll(MDY_TEXT)) {
    const v = iso(+m[3], MONTHS[m[1].toLowerCase().replace('.', '')] ?? 0, +m[2]);
    push(v ? { iso: v, index: m.index, length: m[0].length, ambiguous: false } : null);
  }
  for (const m of text.matchAll(NUMERIC)) {
    const [a, bRaw, c] = [m[1], m[2], m[3]];
    if (a.length === 4) continue; // handled by ISO_RE
    if (a.length === 3 || c.length === 3) continue;
    const monthWord = MONTHS[bRaw.toLowerCase().replace('.', '')];
    const y = +c;
    if (monthWord) { push((v => v ? { iso: v, index: m.index, length: m[0].length, ambiguous: false } : null)(iso(y, monthWord, +a))); continue; }
    if (!/^\d+$/.test(bRaw)) continue;
    const p = +a, q = +bRaw;
    const dmy = iso(y, q, p), mdy = iso(y, p, q);
    let v: string | null;
    let ambiguous = false;
    if (dmy && mdy && dmy !== mdy) { v = opts.us ? mdy : dmy; ambiguous = true; }
    else v = dmy ?? mdy;
    push(v ? { iso: v, index: m.index, length: m[0].length, ambiguous } : null);
  }
  if (opts.compact) {
    for (const m of text.matchAll(COMPACT)) {
      const v = iso(+m[1], +m[2], +m[3]);
      push(v ? { iso: v, index: m.index, length: m[0].length, ambiguous: false } : null);
    }
  }
  return hits.sort((x, y) => x.index - y.index);
}

/** Parse a single date value (e.g. a CSV cell). */
export function parseDate(text: string | null | undefined, opts: DateOptions = {}): string | null {
  if (!text) return null;
  const t = String(text).trim();
  if (!t) return null;
  const hits = findDates(t, { compact: true, ...opts });
  return hits[0]?.iso ?? null;
}

const GOOD_LABEL = /(collect|sample|specimen|drawn|draw|registration|registered|received|receipt|accession|test\s*date|date\s*of\s*(?:test|collection|sample)|visit|service|study)/i;
const BAD_LABEL = /(report(?:ed)?|print(?:ed)?|authori[sz]|approv|releas|generated|dispatch|validated|verified|signed|birth|dob|d\.o\.b|issued|expiry|valid)/i;

interface Scored { iso: string; score: number; index: number }

/**
 * Best collection date in a block of report text. Prefers dates labelled collected/sample/drawn
 * over reported/printed; ignores birth dates. US MM/DD/YYYY is used only when unambiguous
 * (or when `opts.us` is set).
 */
export function detectReportDate(text: string, opts: DateOptions = {}): string | null {
  const hits = findDates(text, opts);
  if (!hits.length) return null;
  const today = new Date();
  const max = `${today.getFullYear() + 1}-12-31`;
  const scored: Scored[] = [];
  for (const h of hits) {
    if (h.iso > max) continue;
    const lineStart = text.lastIndexOf('\n', h.index) + 1;
    const before = text.slice(Math.max(lineStart, h.index - 48), h.index);
    // Nearest label: text since the previous date on the same line.
    const prevEnd = hits.filter(o => o.index < h.index && o.index >= lineStart).map(o => o.index + o.length).pop() ?? lineStart;
    const label = text.slice(Math.max(prevEnd, h.index - 48), h.index);
    let score = 0;
    if (GOOD_LABEL.test(label)) score += 10;
    else if (GOOD_LABEL.test(before)) score += 4;
    if (BAD_LABEL.test(label)) score -= /birth|dob|d\.o\.b|expiry|valid/i.test(label) ? 100 : 6;
    if (/date/i.test(label)) score += 1;
    if (h.ambiguous && !opts.us) score -= 1;
    scored.push({ iso: h.iso, score, index: h.index });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  if (opts.requireLabel && scored[0].score < 4) return null;
  return scored[0].score > -50 ? scored[0].iso : null;
}
