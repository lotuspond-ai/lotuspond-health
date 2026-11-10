// What an agent reads first: one profile's records turned into a short, explainable summary. Everything here is
// arithmetic on the person's own results and the catalogue's ranges. No diagnosis and no treatment advice: results
// outside their range are listed for the person to discuss with a clinician, and follow-ups are about when a test
// was last done, not what it means.
import type { BiomarkerDef, Measurement, Profile, ScanItem, Status, StoredDocument } from '../../../shared/types.ts';
import { findMarker, normalizeName, SYSTEM_LABELS } from '../../../shared/catalog.ts';

const DAY = 24 * 60 * 60 * 1000;
/** A change smaller than this (relative to the range width, or to the value without a range) counts as steady. */
const STEADY = 0.05;

export const DISCLAIMER =
  'LotusPond Health holds results the person uploaded or reported. Ranges come from the lab report when it printed one, '
  + 'otherwise from a typical adult range. This is information to discuss with a clinician, not a diagnosis or medical advice.';

export type Trend = 'rising' | 'falling' | 'steady' | 'single';
export type Direction = 'toward_range' | 'away_from_range' | 'within_range' | 'unknown';

export interface MarkerSummary {
  marker: string;
  markerId: string | null;
  system: string | null;
  latest: { value: number | null; text: string; unit: string; date: string | null; status: Status; range: string | null; rangeSource: 'report' | 'typical' | null };
  previous: { value: number | null; date: string | null; status: Status } | null;
  results: number;
  trend: Trend;
  /** Whether the latest change moved the value toward its range, away from it, or kept it within. */
  direction: Direction;
  /** Days since the latest result, or null without a date. */
  ageDays: number | null;
  about: string | null;
}

export interface FollowUp {
  marker: string;
  reason: string;
  /** Plain suggestion for the person, never a treatment. */
  suggestion: string;
}

export interface HealthSummary {
  profile: {
    id: string; name: string; relationship: string; ageYears: number | null; sex: string | null;
    bmi: number | null; bloodType: string | null; conditions: string[]; medications: string[]; allergies: string[];
  };
  counts: { results: number; markers: number; scans: number; documents: number };
  lastResultDate: string | null;
  outOfRange: MarkerSummary[];
  changing: MarkerSummary[];
  followUps: FollowUp[];
  bySystem: { system: string; markers: number; outOfRange: number }[];
  disclaimer: string;
}

export function ageYears(dob: string | null, now = Date.now()): number | null {
  if (!dob) return null;
  const d = new Date(`${dob}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const n = new Date(now);
  let age = n.getUTCFullYear() - d.getUTCFullYear();
  if (n.getUTCMonth() < d.getUTCMonth() || (n.getUTCMonth() === d.getUTCMonth() && n.getUTCDate() < d.getUTCDate())) age--;
  return age >= 0 && age < 130 ? age : null;
}

export function bmi(heightCm: number | null, weightKg: number | null): number | null {
  if (!heightCm || !weightKg || heightCm < 40) return null;
  return Math.round((weightKg / (heightCm / 100) ** 2) * 10) / 10;
}

const seriesKey = (m: Measurement) => m.markerId ?? `raw:${normalizeName(m.rawName)}`;
const byDate = (a: Measurement, b: Measurement) => (a.date ?? '').localeCompare(b.date ?? '');

function rangeText(m: Measurement): string | null {
  const r = m.range;
  if (!r) return null;
  if (r.text) return r.text;
  if (r.low != null && r.high != null) return `${r.low}–${r.high}`;
  if (r.high != null) return `< ${r.high}`;
  if (r.low != null) return `> ${r.low}`;
  return null;
}

/** Distance outside the range (0 inside), or null when it can't be measured. */
function outside(m: Measurement): number | null {
  if (m.value == null || !m.range) return null;
  const { low, high } = m.range;
  if (high != null && m.value > high) return m.value - high;
  if (low != null && m.value < low) return low - m.value;
  return low != null || high != null ? 0 : null;
}

function trendOf(latest: Measurement, previous: Measurement | undefined): Trend {
  if (!previous || latest.value == null || previous.value == null) return 'single';
  const r = latest.range;
  const scale = r?.low != null && r?.high != null && r.high > r.low ? r.high - r.low : Math.abs(previous.value) || 1;
  const change = (latest.value - previous.value) / scale;
  return Math.abs(change) < STEADY ? 'steady' : change > 0 ? 'rising' : 'falling';
}

function directionOf(latest: Measurement, previous: Measurement | undefined): Direction {
  if (!previous) return 'unknown';
  const now = outside(latest), before = outside(previous);
  if (now == null || before == null) return 'unknown';
  if (now === 0 && before === 0) return 'within_range';
  if (now < before) return 'toward_range';
  if (now > before) return 'away_from_range';
  return now === 0 ? 'within_range' : 'away_from_range';
}

export function summarizeMarker(points: Measurement[], now = Date.now()): MarkerSummary {
  const sorted = [...points].sort(byDate);
  const latest = sorted[sorted.length - 1];
  const previous = sorted.length > 1 ? sorted[sorted.length - 2] : undefined;
  const def: BiomarkerDef | undefined = findMarker(latest.markerId);
  const time = latest.date ? Date.parse(`${latest.date}T00:00:00Z`) : NaN;
  return {
    marker: def?.name ?? latest.rawName,
    markerId: latest.markerId,
    system: def ? SYSTEM_LABELS[def.system] : null,
    latest: {
      value: latest.value, text: latest.valueText, unit: latest.unit, date: latest.date, status: latest.status,
      range: rangeText(latest), rangeSource: latest.range?.source ?? null,
    },
    previous: previous ? { value: previous.value, date: previous.date, status: previous.status } : null,
    results: sorted.length,
    trend: trendOf(latest, previous),
    direction: directionOf(latest, previous),
    ageDays: Number.isNaN(time) ? null : Math.max(0, Math.floor((now - time) / DAY)),
    about: def?.about ?? null,
  };
}

/** One summary per marker, out-of-range first, then by name. */
export function markerSummaries(ms: Measurement[], now = Date.now()): MarkerSummary[] {
  const groups = new Map<string, Measurement[]>();
  for (const m of ms) {
    const k = seriesKey(m);
    const g = groups.get(k);
    if (g) g.push(m); else groups.set(k, [m]);
  }
  const rank = (s: Status) => (s === 'high' || s === 'low' ? 0 : 1);
  return [...groups.values()].map(g => summarizeMarker(g, now))
    .sort((a, b) => rank(a.latest.status) - rank(b.latest.status) || a.marker.localeCompare(b.marker));
}

/** Results that conditions on the profile usually keep an eye on, and how often (days). Matched on words in the condition. */
const WATCH: { words: RegExp; markers: string[]; everyDays: number; label: string }[] = [
  { words: /diabet|prediabet|insulin resist|\bpcos\b/i, markers: ['hba1c'], everyDays: 180, label: 'blood sugar' },
  { words: /cholesterol|lipid|hyperlipid|heart|coronary|cardi/i, markers: ['ldl'], everyDays: 365, label: 'cholesterol' },
  { words: /hypertens|blood pressure|kidney|renal|\bckd\b/i, markers: ['creatinine', 'egfr'], everyDays: 365, label: 'kidney function' },
  { words: /thyroid|hashimoto|graves/i, markers: ['tsh'], everyDays: 365, label: 'thyroid' },
  { words: /an(a)?emia|iron deficien/i, markers: ['hemoglobin', 'ferritin'], everyDays: 180, label: 'blood count and iron' },
  { words: /fatty liver|hepat|liver/i, markers: ['alt'], everyDays: 365, label: 'liver' },
];

export function followUps(profile: Pick<Profile, 'conditions'>, summaries: MarkerSummary[]): FollowUp[] {
  const out: FollowUp[] = [];
  const seen = new Set<string>();
  const byId = new Map(summaries.filter(s => s.markerId).map(s => [s.markerId!, s]));
  for (const s of summaries) {
    if ((s.latest.status === 'high' || s.latest.status === 'low') && s.ageDays != null && s.ageDays > 90) {
      seen.add(s.marker);
      out.push({
        marker: s.marker,
        reason: `Last result was ${s.latest.status === 'high' ? 'above' : 'below'} range, ${Math.round(s.ageDays / 30)} months ago.`,
        suggestion: 'Ask a clinician whether to repeat this test.',
      });
    } else if (s.direction === 'away_from_range' && s.latest.status !== 'normal' && !seen.has(s.marker)) {
      seen.add(s.marker);
      out.push({ marker: s.marker, reason: 'Moved further from its range since the previous result.', suggestion: 'Worth raising at the next appointment.' });
    }
  }
  for (const w of WATCH) {
    if (!profile.conditions.some(c => w.words.test(c))) continue;
    for (const id of w.markers) {
      const def = findMarker(id);
      const name = def?.name ?? id;
      if (seen.has(name)) continue;
      const s = byId.get(id);
      if (!s) {
        out.push({ marker: name, reason: `No ${name} result on file, and the profile lists a condition linked to ${w.label}.`, suggestion: 'Ask a clinician whether this test is due.' });
      } else if (s.ageDays != null && s.ageDays > w.everyDays) {
        out.push({ marker: name, reason: `Last ${name} result is ${Math.round(s.ageDays / 30)} months old; people with this condition often check it every ${Math.round(w.everyDays / 30)} months.`, suggestion: 'Ask a clinician whether this test is due.' });
      } else continue;
      seen.add(name);
    }
  }
  return out;
}

export function healthSummary(profile: Profile, records: { measurements: Measurement[]; scans: ScanItem[]; documents: StoredDocument[] }, now = Date.now()): HealthSummary {
  const all = markerSummaries(records.measurements, now);
  const bySystem = new Map<string, { markers: number; outOfRange: number }>();
  for (const s of all) {
    const k = s.system ?? 'Other';
    const e = bySystem.get(k) ?? { markers: 0, outOfRange: 0 };
    e.markers++;
    if (s.latest.status === 'high' || s.latest.status === 'low') e.outOfRange++;
    bySystem.set(k, e);
  }
  const dates = records.measurements.map(m => m.date).filter((d): d is string => !!d).sort();
  return {
    profile: {
      id: profile.id, name: profile.displayName, relationship: profile.relationship, ageYears: ageYears(profile.dateOfBirth, now),
      sex: profile.sex, bmi: bmi(profile.heightCm, profile.weightKg), bloodType: profile.bloodType,
      conditions: profile.conditions, medications: profile.medications, allergies: profile.allergies,
    },
    counts: { results: records.measurements.length, markers: all.length, scans: records.scans.length, documents: records.documents.length },
    lastResultDate: dates.at(-1) ?? null,
    outOfRange: all.filter(s => s.latest.status === 'high' || s.latest.status === 'low'),
    changing: all.filter(s => s.direction === 'toward_range' || s.direction === 'away_from_range'),
    followUps: followUps(profile, all),
    bySystem: [...bySystem].map(([system, v]) => ({ system, ...v })).sort((a, b) => b.outOfRange - a.outOfRange || b.markers - a.markers),
    disclaimer: DISCLAIMER,
  };
}
