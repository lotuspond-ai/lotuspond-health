// App state (zustand) with IndexedDB persistence via idb-keyval.
import { create } from 'zustand';
import { del, delMany, get, keys, set as idbSet } from 'idb-keyval';
import type { BiomarkerDef, Measurement, OrganId, ParseResult, ScanItem, SystemId } from '../types';
import { findMarker } from './catalog.ts';
import { refreshMeasurement } from './status.ts';
import { SAMPLE } from './sample.ts';
import { uid } from './id.ts';

export const STORAGE_KEY = 'lotuspond:v1';
export const BLOB_PREFIX = 'lotuspond:blob:';

export interface HealthState {
  measurements: Measurement[];
  scans: ScanItem[];
  selectedOrgan: OrganId | null;
  selectedMarkerId: string | null;
  activeSystem: SystemId | null;
  /** True once stored data has been loaded from IndexedDB. */
  hydrated: boolean;

  addResult: (r: ParseResult) => void;
  updateMeasurement: (id: string, patch: Partial<Measurement>) => void;
  removeMeasurement: (id: string) => void;
  updateScan: (id: string, patch: Partial<ScanItem>) => void;
  removeScan: (id: string) => void;
  clearAll: () => void;
  loadSample: () => void;
  selectOrgan: (organ: OrganId | null) => void;
  selectMarker: (markerId: string | null) => void;
  setActiveSystem: (system: SystemId | null) => void;
}

interface Persisted { version: 1; measurements: Measurement[]; scans: ScanItem[] }

/* ---------------- blob cache + persistence helpers ---------------- */

const blobCache = new Map<string, Blob>();

function safe(p: Promise<unknown>): void {
  p.catch(err => { if (typeof console !== 'undefined') console.warn('[lotuspond] storage error', err); });
}

const hasIDB = () => typeof indexedDB !== 'undefined';

function persistBlobs(blobs: Record<string, Blob>): void {
  for (const [k, b] of Object.entries(blobs)) {
    blobCache.set(k, b);
    if (hasIDB()) safe(idbSet(BLOB_PREFIX + k, b));
  }
}

/** Original file for a scan, from memory or IndexedDB. */
export async function getScanBlob(key: string): Promise<Blob | null> {
  const cached = blobCache.get(key);
  if (cached) return cached;
  if (!hasIDB()) return null;
  try {
    const b = await get<Blob>(BLOB_PREFIX + key);
    if (b instanceof Blob) { blobCache.set(key, b); return b; }
  } catch { /* unavailable (private mode etc.) */ }
  return null;
}

/* ---------------- merge helpers ---------------- */

const measurementKey = (m: Measurement) =>
  `${m.markerId ?? 'raw:' + m.rawName.trim().toLowerCase()}|${m.date ?? ''}|${m.value ?? m.valueText.trim().toLowerCase()}`;
const scanKey = (s: ScanItem) => `${s.fileName}|${s.date ?? ''}|${s.width ?? ''}x${s.height ?? ''}|${s.modality ?? ''}`;

function mergeMeasurements(existing: Measurement[], incoming: Measurement[]): Measurement[] {
  const seen = new Set(existing.map(measurementKey));
  const ids = new Set(existing.map(m => m.id));
  const out = [...existing];
  for (const m of incoming) {
    const k = measurementKey(m);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(ids.has(m.id) ? { ...m, id: uid() } : m);
    ids.add(m.id);
  }
  return out;
}

function mergeScans(existing: ScanItem[], incoming: ScanItem[]): { scans: ScanItem[]; added: Set<string> } {
  const seen = new Set(existing.map(scanKey));
  const added = new Set<string>();
  const out = [...existing];
  for (const s of incoming) {
    const k = scanKey(s);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    added.add(s.blobKey);
  }
  return { scans: out, added };
}

/* ---------------- store ---------------- */

export const useHealth = create<HealthState>()((set, getState) => ({
  measurements: [],
  scans: [],
  selectedOrgan: null,
  selectedMarkerId: null,
  activeSystem: null,
  hydrated: false,

  addResult: r => {
    const { measurements, scans } = getState();
    const merged = mergeScans(scans, r.scans);
    const blobs: Record<string, Blob> = {};
    for (const [k, b] of Object.entries(r.blobs)) if (merged.added.has(k)) blobs[k] = b;
    persistBlobs(blobs);
    // Re-derive status in case rows were edited (marker, value, unit) after parsing.
    const incoming = r.measurements.map(refreshMeasurement);
    set({ measurements: mergeMeasurements(measurements, incoming), scans: merged.scans });
  },

  updateMeasurement: (id, patch) => set(s => ({
    measurements: s.measurements.map(m => (m.id === id ? refreshMeasurement({ ...m, ...patch, id: m.id }) : m)),
  })),

  removeMeasurement: id => set(s => ({
    measurements: s.measurements.filter(m => m.id !== id),
  })),

  updateScan: (id, patch) => set(s => ({
    scans: s.scans.map(x => (x.id === id ? { ...x, ...patch, id: x.id, blobKey: x.blobKey } : x)),
  })),

  removeScan: id => {
    const scan = getState().scans.find(x => x.id === id);
    if (scan) {
      blobCache.delete(scan.blobKey);
      if (hasIDB()) safe(del(BLOB_PREFIX + scan.blobKey));
    }
    set(s => ({ scans: s.scans.filter(x => x.id !== id) }));
  },

  clearAll: () => {
    blobCache.clear();
    if (hasIDB()) {
      safe(keys().then(all => delMany(all.filter(k => typeof k === 'string' && k.startsWith(BLOB_PREFIX)))));
    }
    set({ measurements: [], scans: [], selectedOrgan: null, selectedMarkerId: null, activeSystem: null });
  },

  loadSample: () => getState().addResult(SAMPLE),
  selectOrgan: organ => set({ selectedOrgan: organ }),
  selectMarker: markerId => set({ selectedMarkerId: markerId }),
  setActiveSystem: system => set({ activeSystem: system }),
}));

/* ---------------- persistence ---------------- */

let writeTimer: ReturnType<typeof setTimeout> | null = null;
let hydrating: Promise<void> | null = null;

function scheduleWrite(): void {
  if (!hasIDB()) return;
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    const { measurements, scans } = useHealth.getState();
    const payload: Persisted = { version: 1, measurements, scans };
    safe(idbSet(STORAGE_KEY, payload));
  }, 250);
}

useHealth.subscribe((state, prev) => {
  if (!state.hydrated) return;
  if (state.measurements !== prev.measurements || state.scans !== prev.scans || !prev.hydrated) scheduleWrite();
});

function isPersisted(v: unknown): v is Persisted {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return Array.isArray(o.measurements) && Array.isArray(o.scans);
}

/** Load saved data from IndexedDB (safe to call more than once). Data added before hydration is kept. */
export function hydrate(): Promise<void> {
  hydrating ??= (async () => {
    let stored: Persisted | null = null;
    if (hasIDB()) {
      try {
        const v: unknown = await get(STORAGE_KEY);
        if (isPersisted(v)) stored = v;
      } catch { /* storage unavailable: run in memory */ }
    }
    const cur = useHealth.getState();
    const measurements = stored ? mergeMeasurements(stored.measurements, cur.measurements) : cur.measurements;
    const scans = stored ? mergeScans(stored.scans, cur.scans).scans : cur.scans;
    useHealth.setState({ measurements, scans, hydrated: true });
  })();
  return hydrating;
}

/* ---------------- derived selectors ---------------- */

export interface MarkerSeries {
  /** markerId, or "raw:<name>" for unmatched rows. */
  key: string;
  def: BiomarkerDef | null;
  latest: Measurement;
  /** Oldest → newest. */
  history: Measurement[];
}

const seriesKey = (m: Measurement) => m.markerId ?? `raw:${m.rawName.trim().toLowerCase()}`;
const byDateAsc = (a: Measurement, b: Measurement) => (a.date ?? '').localeCompare(b.date ?? '');

function groupSeries(measurements: Measurement[]): Map<string, Measurement[]> {
  const map = new Map<string, Measurement[]>();
  for (const m of measurements) {
    const k = seriesKey(m);
    const list = map.get(k);
    if (list) list.push(m); else map.set(k, [m]);
  }
  for (const list of map.values()) list.sort(byDateAsc);
  return map;
}

/** Most recent measurement per marker (undated rows count as oldest). */
export function latestByMarker(measurements: Measurement[]): Record<string, Measurement> {
  const out: Record<string, Measurement> = {};
  for (const [k, list] of groupSeries(measurements)) out[k] = list[list.length - 1];
  return out;
}

const STATUS_RANK = { high: 0, low: 1, normal: 2, unknown: 3 } as const;

/** Markers related to an organ: latest value plus full history, out-of-range first. */
export function measurementsForOrgan(state: Pick<HealthState, 'measurements'>, organ: OrganId): MarkerSeries[] {
  const out: MarkerSeries[] = [];
  for (const [key, history] of groupSeries(state.measurements)) {
    const def = findMarker(history[0].markerId) ?? null;
    if (!def || !def.organs.includes(organ)) continue;
    out.push({ key, def, latest: history[history.length - 1], history });
  }
  return out.sort((a, b) =>
    STATUS_RANK[a.latest.status] - STATUS_RANK[b.latest.status]
    || (a.def?.organs.indexOf(organ) ?? 9) - (b.def?.organs.indexOf(organ) ?? 9)
    || (a.def?.name ?? a.key).localeCompare(b.def?.name ?? b.key));
}

export const ORGAN_IDS: OrganId[] = ['brain', 'thyroid', 'airway', 'lungs', 'heart', 'esophagus', 'liver', 'stomach',
  'spleen', 'pancreas', 'kidneys', 'intestine', 'colon', 'marrow', 'skin'];

export interface OrganCounts { total: number; out: number; low: number; high: number }

/** Per-organ counts over the latest value of each marker. A marker counts for every organ it lists. */
export function organSummary(measurements: Measurement[]): Record<OrganId, OrganCounts> {
  const out = Object.fromEntries(ORGAN_IDS.map(o => [o, { total: 0, out: 0, low: 0, high: 0 }])) as Record<OrganId, OrganCounts>;
  for (const m of Object.values(latestByMarker(measurements))) {
    const def = findMarker(m.markerId);
    if (!def) continue;
    for (const o of def.organs) {
      const c = out[o];
      c.total++;
      if (m.status === 'low') { c.low++; c.out++; }
      else if (m.status === 'high') { c.high++; c.out++; }
    }
  }
  return out;
}

/** Distinct sample dates, oldest → newest (undated rows are ignored). */
export function dates(measurements: Measurement[]): string[] {
  return [...new Set(measurements.map(m => m.date).filter((d): d is string => !!d))].sort();
}
