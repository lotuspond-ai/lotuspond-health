// App state (zustand), saved through a storage backend: IndexedDB in the browser, app files in the
// iOS / Android apps (see src/lib/storage/ and src/native/storage.ts).
import { create } from 'zustand';
import type { BiomarkerDef, Measurement, OrganId, ParseResult, ScanItem, SystemId } from '../types';
import { findMarker } from './catalog.ts';
import { refreshMeasurement } from './status.ts';
import { SAMPLE } from './sample.ts';
import { uid } from './id.ts';
import type { Persisted, StorageBackend } from './storage/index.ts';
import { idbBackend } from './storage/idb.ts';

export { STORAGE_KEY, BLOB_PREFIX } from './storage/idb.ts';

export interface HealthState {
  measurements: Measurement[];
  scans: ScanItem[];
  selectedOrgan: OrganId | null;
  selectedMarkerId: string | null;
  activeSystem: SystemId | null;
  /** True once saved data has been loaded from storage. */
  hydrated: boolean;
  /** Saved data exists but could not be read, so nothing is being saved this session. */
  saveBlocked: boolean;

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

/* ---------------- storage backend + blob cache ---------------- */

let backend: StorageBackend = idbBackend;
/** Set when saved data exists but could not be read: this session then stays in memory instead of overwriting it. */
let readOnly = false;

/** Choose where data is saved (the apps switch to native files). Call before hydrate(). */
export function setStorageBackend(b: StorageBackend): void { backend = b; }

const blobCache = new Map<string, Blob>();

function safe(p: Promise<unknown>): void {
  p.catch(err => { if (typeof console !== 'undefined') console.warn('[lotuspond] storage error', err); });
}

function persistBlobs(blobs: Record<string, Blob>): void {
  for (const [k, b] of Object.entries(blobs)) {
    blobCache.set(k, b);
    if (!readOnly) safe(backend.saveBlob(k, b));
  }
}

/** Original file for a scan, from memory or storage. */
export async function getScanBlob(key: string): Promise<Blob | null> {
  const cached = blobCache.get(key);
  if (cached) return cached;
  try {
    const b = await backend.loadBlob(key);
    if (b) { blobCache.set(key, b); return b; }
  } catch (err) { if (typeof console !== 'undefined') console.warn('[lotuspond] could not read scan file', err); }
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
  saveBlocked: false,

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
      if (!readOnly) safe(backend.deleteBlob(scan.blobKey));
    }
    set(s => ({ scans: s.scans.filter(x => x.id !== id) }));
  },

  clearAll: () => {
    blobCache.clear();
    if (!readOnly) safe(backend.clearBlobs());
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
let gate: Promise<unknown> = Promise.resolve();

/** Keep saved data out of memory until `until` resolves (the apps pass the app lock's unlock). Call before hydrate(). */
export function holdHydration(until: Promise<unknown>): void { gate = until; }

function writeNow(): Promise<void> {
  const { measurements, scans } = useHealth.getState();
  const payload: Persisted = { version: 1, measurements, scans };
  const p = backend.savePayload(payload);
  safe(p);
  return p.catch(() => {});
}

function scheduleWrite(): void {
  if (readOnly) return;
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => { writeTimer = null; void writeNow(); }, 250);
}

/** Save a pending change right away (the apps call this when they go to the background). */
export function flushPersist(): Promise<void> {
  if (!writeTimer) return Promise.resolve();
  clearTimeout(writeTimer);
  writeTimer = null;
  return writeNow();
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
    await gate;
    let stored: Persisted | null = null;
    try {
      const v: unknown = await backend.loadPayload();
      if (isPersisted(v)) stored = v;
    } catch (err) {
      readOnly = true;
      if (typeof console !== 'undefined') console.warn(`[lotuspond] saved data could not be read (${backend.name}); changes this session are not saved`, err);
    }
    const cur = useHealth.getState();
    const measurements = stored ? mergeMeasurements(stored.measurements, cur.measurements) : cur.measurements;
    const scans = stored ? mergeScans(stored.scans, cur.scans).scans : cur.scans;
    useHealth.setState({ measurements, scans, hydrated: true, saveBlocked: readOnly });
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
