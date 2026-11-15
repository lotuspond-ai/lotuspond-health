// Readings from the phone's health store (Apple Health on iOS, Health Connect on Android) → results, one value per
// marker per day. The plugin calls live in src/native/health.ts; everything here is plain data, so it is tested in
// tools/test-parsers.mjs. docs/health-import.md explains the rules.
import { findMarker } from './catalog.ts';
import { buildMeasurement } from './parse/rows.ts';
import type { Measurement } from '../types';

export type HealthSource = 'apple_health' | 'health_connect';

/** The source as shown in the app and stored as each result's source. */
export const SOURCE_NAME: Record<HealthSource, string> = { apple_health: 'Apple Health', health_connect: 'Health Connect' };

/** The plugin's data types this app reads. Nothing is ever written back. */
export type HealthReadType =
  | 'bloodPressure' | 'bloodGlucose' | 'restingHeartRate' | 'oxygenSaturation' | 'respiratoryRate' | 'bodyTemperature'
  | 'weight' | 'bodyFat';

/** The part of a plugin sample used here. */
export interface HealthReading {
  value: number;
  unit: string;
  startDate: string;
  systolic?: number;
  diastolic?: number;
}

export interface ImportKind {
  type: HealthReadType;
  label: string;
  /** Catalogue markers the readings become (blood pressure gives two). */
  markers: string[];
  /** Readings outside these bounds are unit mistakes or sensor errors, and are left out. */
  plausible: [number, number];
  decimals: number;
}

export const IMPORT_KINDS: ImportKind[] = [
  { type: 'bloodPressure', label: 'Blood pressure', markers: ['bp_systolic', 'bp_diastolic'], plausible: [30, 300], decimals: 0 },
  { type: 'bloodGlucose', label: 'Blood glucose (meter or sensor)', markers: ['glucose_meter'], plausible: [10, 1000], decimals: 0 },
  { type: 'restingHeartRate', label: 'Resting heart rate', markers: ['resting_heart_rate'], plausible: [20, 250], decimals: 0 },
  { type: 'oxygenSaturation', label: 'Oxygen saturation (SpO2)', markers: ['spo2'], plausible: [50, 100], decimals: 0 },
  { type: 'respiratoryRate', label: 'Respiratory rate', markers: ['respiratory_rate'], plausible: [4, 60], decimals: 0 },
  { type: 'bodyTemperature', label: 'Body temperature', markers: ['body_temperature'], plausible: [30, 45], decimals: 1 },
  { type: 'weight', label: 'Weight', markers: ['body_weight'], plausible: [1, 650], decimals: 1 },
  { type: 'bodyFat', label: 'Body fat', markers: ['body_fat'], plausible: [1, 75], decimals: 1 },
];

export const KIND_BY_TYPE = new Map(IMPORT_KINDS.map(k => [k.type, k]));

/** The local calendar day (yyyy-mm-dd) a reading was taken on. */
export function localDay(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** A reading in the marker's catalogue unit, or null when it can't be used. */
function normalise(kind: ImportKind, r: HealthReading, part: 'systolic' | 'diastolic' | null): number | null {
  let v = part ? r[part] : r.value;
  if (v == null || !Number.isFinite(v)) return null;
  const unit = r.unit.toLowerCase();
  if (kind.type === 'oxygenSaturation' || kind.type === 'bodyFat') {
    // HealthKit gives a fraction (0.97); Health Connect gives a percentage (97).
    if (v <= 1) v *= 100;
  } else if (kind.type === 'bodyTemperature' && unit.startsWith('f')) {
    v = ((v - 32) * 5) / 9;
  } else if (kind.type === 'bloodGlucose' && unit === 'mmol/l') {
    v *= 18.016;
  }
  return v >= kind.plausible[0] && v <= kind.plausible[1] ? v : null;
}

const round = (v: number, decimals: number) => Math.round(v * 10 ** decimals) / 10 ** decimals;

export interface DailyValue { markerId: string; date: string; value: number; readings: number }

/**
 * One value per marker per day: the mean of that day's readings. Today is left out, because its average is not
 * final yet; it is imported next time.
 */
export function dailyValues(kind: ImportKind, readings: HealthReading[], today: string): DailyValue[] {
  const days = new Map<string, Map<string, number[]>>();
  for (const r of readings) {
    const date = localDay(r.startDate);
    if (!date || date >= today) continue;
    kind.markers.forEach((markerId, i) => {
      const part = kind.type === 'bloodPressure' ? (i === 0 ? 'systolic' : 'diastolic') : null;
      const v = normalise(kind, r, part);
      if (v == null) return;
      const byMarker = days.get(date) ?? new Map<string, number[]>();
      days.set(date, byMarker);
      const list = byMarker.get(markerId) ?? [];
      byMarker.set(markerId, list);
      list.push(v);
    });
  }
  const out: DailyValue[] = [];
  for (const [date, byMarker] of [...days].sort(([a], [b]) => a.localeCompare(b))) {
    for (const markerId of kind.markers) {
      const list = byMarker.get(markerId);
      if (!list?.length) continue;
      out.push({ markerId, date, value: round(list.reduce((n, v) => n + v, 0) / list.length, kind.decimals), readings: list.length });
    }
  }
  return out;
}

/** Daily values → results for the upload review, each with its typical range and status. */
export function toMeasurements(values: DailyValue[], source: HealthSource): Measurement[] {
  const out: Measurement[] = [];
  for (const d of values) {
    const def = findMarker(d.markerId);
    if (!def) continue;
    const m = buildMeasurement(
      { name: def.name, value: String(d.value), unit: def.unit, markerId: def.id },
      { sourceFile: SOURCE_NAME[source], date: d.date },
    );
    if (m) out.push({ ...m, confidence: 'high' });
  }
  return out;
}

/** Leaves out days already imported from the same source, so a second import adds only what is new. */
export function onlyNewDays(rows: Measurement[], existing: Pick<Measurement, 'markerId' | 'date' | 'sourceFile'>[]): Measurement[] {
  const have = new Set(existing.map(m => `${m.sourceFile}|${m.markerId}|${m.date}`));
  return rows.filter(m => !have.has(`${m.sourceFile}|${m.markerId}|${m.date}`));
}

/** Where the next import should start: the day after the last one imported from this source, or `fallbackDays` ago. */
export function importStart(existing: Pick<Measurement, 'date' | 'sourceFile'>[], source: HealthSource, today: string, fallbackDays: number): string {
  const last = existing.filter(m => m.sourceFile === SOURCE_NAME[source] && m.date).map(m => m.date!).sort().pop();
  if (last) {
    const d = new Date(`${last}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }
  return daysBefore(today, fallbackDays);
}

export function daysBefore(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Calendar months from `start` (yyyy-mm-dd, local) to `end`, so no single read asks for too much at once. */
export function monthWindows(start: string, end: string): { startDate: string; endDate: string }[] {
  const out: { startDate: string; endDate: string }[] = [];
  const endAt = new Date(`${end}T00:00:00`);
  let from = new Date(`${start}T00:00:00`);
  while (from < endAt) {
    const to = new Date(from.getFullYear(), from.getMonth() + 1, 1);
    const stop = to < endAt ? to : endAt;
    out.push({ startDate: from.toISOString(), endDate: stop.toISOString() });
    from = stop;
  }
  return out;
}

/** "Blood pressure: 24 days, Weight: 12 days" for the review's summary line. */
export function importSummary(rows: Measurement[]): string {
  const days = new Map<string, Set<string>>();
  for (const m of rows) {
    const kind = IMPORT_KINDS.find(k => m.markerId && k.markers.includes(m.markerId));
    if (!kind || !m.date) continue;
    (days.get(kind.label) ?? days.set(kind.label, new Set()).get(kind.label)!).add(m.date);
  }
  return [...days].map(([label, d]) => `${label}: ${d.size} day${d.size === 1 ? '' : 's'}`).join(', ');
}
