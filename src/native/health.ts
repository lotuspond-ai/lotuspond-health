// The phone's health store: Apple Health (HealthKit) on iOS, Health Connect on Android, through
// @capgo/capacitor-health. Read only: the app never writes to it. Readings become results in
// src/lib/health-import.ts and go through the upload review before anything is saved (docs/health-import.md).
import { Health } from '@capgo/capacitor-health';
import { isNative, platform } from './platform';
import { monthWindows, type HealthReadType, type HealthReading, type HealthSource } from '../lib/health-import';

export interface HealthStore {
  source: HealthSource;
  /** Whether the store can be used on this phone; `reason` says why not. */
  available(): Promise<{ available: boolean; reason?: string }>;
  /** Shows the system permission sheet for these types (read only). */
  authorize(types: HealthReadType[]): Promise<void>;
  /** Readings of one type from `start` (yyyy-mm-dd, local) up to the start of `end`. */
  read(type: HealthReadType, start: string, end: string, onProgress?: (done: number, total: number) => void): Promise<HealthReading[]>;
  /** Android: Health Connect's own settings (permissions, or installing it). */
  openSettings?(): Promise<void>;
}

/** Readings per month and type at most; a glucose sensor gives about 9,000 a month. */
const PER_MONTH = 20_000;

function nativeStore(source: HealthSource): HealthStore {
  return {
    source,
    async available() {
      try {
        const r = await Health.isAvailable();
        return { available: r.available, reason: r.reason };
      } catch (e) {
        return { available: false, reason: e instanceof Error ? e.message : String(e) };
      }
    },
    async authorize(types) {
      // Android caps reads to the last 30 days unless the history permission is granted too.
      await Health.requestAuthorization({ read: types, write: [], requestHistoryAccess: source === 'health_connect' });
    },
    async read(type, start, end, onProgress) {
      const windows = monthWindows(start, end);
      const out: HealthReading[] = [];
      for (const [i, w] of windows.entries()) {
        const { samples } = await Health.readSamples({ dataType: type, startDate: w.startDate, endDate: w.endDate, limit: PER_MONTH, ascending: true });
        for (const s of samples) out.push({ value: s.value, unit: s.unit, startDate: s.startDate, systolic: s.systolic, diastolic: s.diastolic });
        onProgress?.(i + 1, windows.length);
      }
      return out;
    },
    openSettings: source === 'health_connect' ? () => Health.openHealthConnectSettings() : undefined,
  };
}

declare global {
  // Development only: a stand-in store, so the import can be tried in a browser (docs/health-import.md).
  interface Window { __lotuspondHealthStore?: HealthStore }
}

/** The phone's health store, or null in a browser. */
export function healthStore(): HealthStore | null {
  if (isNative && (platform === 'ios' || platform === 'android')) return nativeStore(platform === 'ios' ? 'apple_health' : 'health_connect');
  if (import.meta.env.DEV && typeof window !== 'undefined' && window.__lotuspondHealthStore) return window.__lotuspondHealthStore;
  return null;
}
