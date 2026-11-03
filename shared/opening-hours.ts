// Evaluates simple OpenStreetMap opening_hours values ("Mo-Sa 07:00-21:00; Su 07:00-13:00", "24/7").
// Anything beyond weekdays and clock times (months, dates, sunrise, comments, nth weekdays, fallback rules)
// is reported as not evaluable, and the interface then shows the hours text as written.

export interface OpenState {
  open: boolean;
  /** Always open. */
  always?: boolean;
  /** When open: closing time today ("21:00"), if it closes within the next 24 hours. */
  until?: string;
  /** When closed: next opening time today, if any. */
  opensAt?: string;
}

const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'] as const;
const DAY_INDEX: Record<string, number> = Object.fromEntries(DAYS.map((d, i) => [d, i]));
const UNSUPPORTED = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|week|sunrise|sunset|dawn|dusk|easter|\bSH\b|"|\[|\+|\|\||unknown|\d{4})/i;
const TIME = /^(\d{1,2}):(\d{2})$/;

type Interval = [number, number]; // minutes from the start of the day; end may exceed 1440 (past midnight)

function minutes(t: string): number | null {
  const m = TIME.exec(t);
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (min > 59 || h > 48) return null;
  return h * 60 + min;
}

function parseDays(sel: string): number[] | null {
  const out = new Set<number>();
  for (const part of sel.split(',').map(s => s.trim()).filter(Boolean)) {
    if (part === 'PH') continue; // public holidays: not known here, so their rules are ignored
    const range = /^([A-Z][a-z])(?:-([A-Z][a-z]))?$/.exec(part);
    if (!range || !(range[1] in DAY_INDEX) || (range[2] && !(range[2] in DAY_INDEX))) return null;
    const a = DAY_INDEX[range[1]], b = range[2] ? DAY_INDEX[range[2]] : a;
    for (let i = a; ; i = (i + 1) % 7) { out.add(i); if (i === b) break; }
  }
  return [...out];
}

function parseTimes(text: string): Interval[] | null {
  const out: Interval[] = [];
  for (const span of text.split(',').map(s => s.trim()).filter(Boolean)) {
    const [a, b, ...rest] = span.split('-');
    if (rest.length || a === undefined || b === undefined) return null;
    const start = minutes(a.trim()), endRaw = minutes(b.trim());
    if (start == null || endRaw == null || start >= 1440) return null;
    const end = endRaw <= start ? endRaw + 1440 : endRaw;
    out.push([start, end]);
  }
  return out.length ? out : null;
}

/** Weekly schedule (index 0 = Monday), or null when the value is outside the simple subset. */
export function parseOpeningHours(value: string): Interval[][] | null {
  const text = value.trim();
  if (!text || text.length > 300) return null;
  if (/^24\/7$/.test(text)) return DAYS.map(() => [[0, 1440]]);
  if (UNSUPPORTED.test(text)) return null;
  const week: Interval[][] = DAYS.map(() => []);
  let any = false;
  for (const normal of text.split(';').map(s => s.trim()).filter(Boolean)) {
    // "Mo-Fr 08:00-20:00, Sa 09:00-14:00": a comma after a time (or "off") followed by a weekday starts an additional rule.
    const parts = normal.split(/(?<=\d{2}|off|closed)\s*,\s*(?=(?:Mo|Tu|We|Th|Fr|Sa|Su|PH)\b)/);
    parts.forEach((rule, i) => {
      const m = /^((?:(?:Mo|Tu|We|Th|Fr|Sa|Su|PH)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?\s*,?\s*)+)?\s*(.*)$/.exec(rule.trim());
      if (!m) throw new Error('unsupported');
      const selector = m[1]?.replace(/\s+/g, '').replace(/,$/, '');
      const body = m[2].trim();
      if (selector && /^(PH,?)+$/.test(selector)) return; // a holiday-only rule
      const days = selector ? parseDays(selector) : DAYS.map((_, d) => d);
      if (!days) throw new Error('unsupported');
      let times: Interval[];
      if (body === 'off' || body === 'closed') times = [];
      else if (body === '' && selector) times = [[0, 1440]];
      else {
        const parsed = parseTimes(body);
        if (!parsed) throw new Error('unsupported');
        times = parsed;
      }
      any = true;
      for (const d of days) week[d] = i === 0 ? [...times] : [...week[d], ...times];
    });
  }
  return any ? week : null;
}

const hhmm = (min: number) => `${String(Math.floor((min % 1440) / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** Whether a place is open at `now` (device local time), or null when the hours cannot be evaluated. */
export function openState(value: string | null | undefined, now = new Date()): OpenState | null {
  if (!value) return null;
  let week: Interval[][] | null;
  try { week = parseOpeningHours(value); } catch { return null; }
  if (!week) return null;
  if (week.every(d => d.length === 1 && d[0][0] === 0 && d[0][1] >= 1440)) return { open: true, always: true };
  const day = (now.getDay() + 6) % 7;
  const t = now.getHours() * 60 + now.getMinutes();
  const yesterday = week[(day + 6) % 7].filter(([, e]) => e > 1440).map(([s, e]): Interval => [s - 1440, e - 1440]);
  const today = [...yesterday, ...week[day]];
  const current = today.find(([s, e]) => t >= s && t < e);
  if (current) return { open: true, until: current[1] - t <= 1440 ? hhmm(current[1]) : undefined };
  const next = today.filter(([s]) => s > t).sort((a, b) => a[0] - b[0])[0];
  return { open: false, opensAt: next ? hhmm(next[0]) : undefined };
}
