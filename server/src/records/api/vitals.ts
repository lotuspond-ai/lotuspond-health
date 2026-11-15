// Daily vitals from devices (Withings, Oura, Ultrahuman) → one FHIR file per check, reviewed like a report.
//
// Each provider turns its own data into daily values for the catalogue's vitals markers; this module keeps the
// marker details (the name the app's FHIR reader matches, LOINC, UCUM, plausible bounds, decimals), builds the FHIR R4
// collection Bundle of vital-sign Observations, and makes the PortalReport, with a key from its contents so the same
// days are never saved twice.
import { createHash } from 'node:crypto';
import type { PortalReport } from '../recipes/types.ts';

export type VitalMarker = 'body_weight' | 'body_fat' | 'bp_systolic' | 'bp_diastolic' | 'resting_heart_rate' | 'spo2' | 'body_temperature' | 'respiratory_rate' | 'glucose_meter';

export const VITALS: Record<VitalMarker, { name: string; loinc: string; unit: string; ucum: string; bounds: [number, number]; decimals: number }> = {
  body_weight: { name: 'Body weight', loinc: '29463-7', unit: 'kg', ucum: 'kg', bounds: [1, 650], decimals: 1 },
  body_fat: { name: 'Body fat', loinc: '41982-0', unit: '%', ucum: '%', bounds: [1, 75], decimals: 1 },
  bp_systolic: { name: 'Systolic blood pressure', loinc: '8480-6', unit: 'mmHg', ucum: 'mm[Hg]', bounds: [50, 300], decimals: 0 },
  bp_diastolic: { name: 'Diastolic blood pressure', loinc: '8462-4', unit: 'mmHg', ucum: 'mm[Hg]', bounds: [30, 200], decimals: 0 },
  resting_heart_rate: { name: 'Resting heart rate', loinc: '40443-4', unit: 'bpm', ucum: '/min', bounds: [20, 250], decimals: 0 },
  spo2: { name: 'Oxygen saturation (SpO2)', loinc: '59408-5', unit: '%', ucum: '%', bounds: [50, 100], decimals: 0 },
  body_temperature: { name: 'Body temperature', loinc: '8310-5', unit: '°C', ucum: 'Cel', bounds: [30, 45], decimals: 1 },
  respiratory_rate: { name: 'Respiratory rate', loinc: '9279-1', unit: 'breaths/min', ucum: '/min', bounds: [4, 60], decimals: 0 },
  glucose_meter: { name: 'Glucose (home meter)', loinc: '41653-7', unit: 'mg/dL', ucum: 'mg/dL', bounds: [10, 1000], decimals: 0 },
};

/** One marker's value for one day. `readings` is how many readings were averaged (for the note). */
export interface DailyValue { marker: VitalMarker; day: string; value: number; readings: number; note?: string }

/** The calendar day of a unix time in a time zone (the person's), yyyy-mm-dd; an unknown zone counts as India. */
export function dayIn(unixSeconds: number, timeZone: string): string {
  let tz = timeZone;
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); } catch { tz = 'Asia/Kolkata'; }
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(unixSeconds * 1000));
}

/** yyyy-mm-dd plus n days. */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** A value within its marker's plausible bounds, rounded to its decimals; null when it is not usable. */
export function vitalValue(marker: VitalMarker, v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  const m = VITALS[marker];
  if (!Number.isFinite(n) || n < m.bounds[0] || n > m.bounds[1]) return null;
  const f = 10 ** m.decimals;
  return Math.round(n * f) / f;
}

/** Readings → their mean per marker per day (dropping implausible ones), oldest first. */
export function dailyMeans(readings: { marker: VitalMarker; day: string; value: number }[]): DailyValue[] {
  const sums = new Map<string, { marker: VitalMarker; day: string; total: number; n: number }>();
  for (const r of readings) {
    const b = VITALS[r.marker].bounds;
    if (!Number.isFinite(r.value) || r.value < b[0] || r.value > b[1]) continue;
    const key = `${r.marker}\u0000${r.day}`;
    const s = sums.get(key) ?? { marker: r.marker, day: r.day, total: 0, n: 0 };
    s.total += r.value; s.n++;
    sums.set(key, s);
  }
  return sortDaily([...sums.values()].map(s => ({ marker: s.marker, day: s.day, value: vitalValue(s.marker, s.total / s.n)!, readings: s.n })));
}

export const sortDaily = (rows: DailyValue[]) => [...rows].sort((a, b) => a.day.localeCompare(b.day) || VITALS[a.marker].name.localeCompare(VITALS[b.marker].name));

/** Daily values as a FHIR R4 collection Bundle of vital-sign Observations (what the app's FHIR reader takes). */
export function vitalsBundle(rows: DailyValue[], device: string, from: string, to: string): Record<string, unknown> {
  return {
    resourceType: 'Bundle', type: 'collection', id: `${device.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${from}-${to}`, timestamp: new Date().toISOString(),
    entry: rows.map(r => {
      const m = VITALS[r.marker];
      return {
        resource: {
          resourceType: 'Observation', status: 'final',
          category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }],
          code: { coding: [{ system: 'http://loinc.org', code: m.loinc, display: m.name }], text: m.name },
          effectiveDateTime: r.day,
          valueQuantity: { value: r.value, unit: m.unit, system: 'http://unitsofmeasure.org', code: m.ucum },
          device: { display: device },
          note: [{ text: r.note ?? (r.readings === 1 ? '1 reading' : `Mean of ${r.readings} readings that day`) }],
        },
      };
    }),
  };
}

/** One file for a check's daily values, or null when there are none. */
export function vitalsReport(rows: DailyValue[], device: string): PortalReport | null {
  if (!rows.length) return null;
  const sorted = sortDaily(rows);
  const from = sorted[0].day, to = sorted[sorted.length - 1].day;
  const days = new Set(sorted.map(r => r.day)).size;
  const span = from === to ? from : `${from} to ${to}`;
  return {
    key: createHash('sha256').update(device).update(JSON.stringify(sorted)).digest('hex'),
    title: `${device} measurements, ${span}`, date: to,
    fileName: `${device} ${span} (${days} day${days === 1 ? '' : 's'})`,
    contentType: 'application/fhir+json',
    bytes: new Uint8Array(Buffer.from(JSON.stringify(vitalsBundle(sorted, device, from, to)), 'utf8')),
  };
}
