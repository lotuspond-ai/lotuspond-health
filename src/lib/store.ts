// Records of the open profile (zustand). Changes show at once and are saved through the configured backend;
// a failed save reports the problem and reloads the profile so the screen matches what is stored.
// Without a backend (tests, or before sign-in) the store works in memory only.
import { create } from 'zustand';
import type {
  BiomarkerDef, Measurement, MeasurementInput, OrganId, ParseResult, ScanInput, ScanItem, StoredDocument, SystemId,
} from '../types';
import type { Backend, ScanPatch } from '../api/backend';
import { LIMITS, ORGAN_IDS } from '../../shared/constants.ts';
import { findMarker } from './catalog.ts';
import { refreshMeasurement } from './status.ts';
import { SAMPLE } from './sample.ts';
import { uid } from './id.ts';

export { ORGAN_IDS };

export interface AddSummary { measurements: number; scans: number; files: number }

export interface HealthState {
  /** Profile whose records are loaded; null before sign-in. */
  profileId: string | null;
  loading: boolean;
  measurements: Measurement[];
  scans: ScanItem[];
  documents: StoredDocument[];
  selectedOrgan: OrganId | null;
  selectedMarkerId: string | null;
  activeSystem: SystemId | null;

  /** Load a profile's records (null clears everything). */
  openProfile: (profileId: string | null) => Promise<void>;
  /** Save reviewed results and scans. `files` are the originals the person chose; report files are kept too. */
  /** `stored`: files already saved (file name → document id), whose results are linked to them instead of uploading again. */
  addResult: (r: ParseResult, files?: File[], stored?: Record<string, string>) => Promise<AddSummary>;
  updateMeasurement: (id: string, patch: Partial<Measurement>) => void;
  removeMeasurement: (id: string) => void;
  updateScan: (id: string, patch: ScanPatch) => void;
  removeScan: (id: string) => void;
  removeDocument: (id: string) => void;
  clearAll: () => Promise<void>;
  loadSample: () => Promise<AddSummary>;
  selectOrgan: (organ: OrganId | null) => void;
  selectMarker: (markerId: string | null) => void;
  setActiveSystem: (system: SystemId | null) => void;
}

/* ---------------- backend wiring ---------------- */

let backend: Backend | null = null;
let reportError: (message: string) => void = message => console.warn('[lotuspond]', message);

export function configureStore(opts: { backend: Backend | null; onError?: (message: string) => void }): void {
  backend = opts.backend;
  if (opts.onError) reportError = opts.onError;
}

const messageOf = (e: unknown) => (e instanceof Error && e.message ? e.message : 'Changes could not be saved. Try again.');

/* ---------------- original files ---------------- */

const blobCache = new Map<string, Blob>();

/** Original file for a scan or document, from memory or the backend. */
export async function getScanBlob(key: string): Promise<Blob | null> {
  const cached = blobCache.get(key);
  if (cached) return cached;
  const pid = useHealth.getState().profileId;
  if (!backend || !pid) return null;
  try {
    const b = await backend.documentFile(pid, key);
    blobCache.set(key, b);
    return b;
  } catch (e) {
    reportError(messageOf(e));
    return null;
  }
}

/* ---------------- merge helpers ---------------- */

const measurementKey = (m: Measurement) =>
  `${m.markerId ?? 'raw:' + m.rawName.trim().toLowerCase()}|${m.date ?? ''}|${m.value ?? m.valueText.trim().toLowerCase()}`;
const scanKey = (s: ScanItem) => `${s.fileName}|${s.date ?? ''}|${s.width ?? ''}x${s.height ?? ''}|${s.modality ?? ''}`;

/** Incoming items that are not already stored (and not repeated within the batch). */
function onlyNew<T>(existing: T[], incoming: T[], key: (x: T) => string): T[] {
  const seen = new Set(existing.map(key));
  return incoming.filter(x => {
    const k = key(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

const withoutId = <T extends { id: string }>({ id: _id, ...rest }: T): Omit<T, 'id'> => rest;

/* ---------------- store ---------------- */

let loadTicket = 0;

export const useHealth = create<HealthState>()((set, get) => {
  /** Reload the open profile quietly, for example after a failed save. */
  async function reload(): Promise<void> {
    const pid = get().profileId;
    if (!backend || !pid) return;
    const ticket = ++loadTicket;
    try {
      const rec = await backend.records(pid);
      if (ticket === loadTicket && get().profileId === pid) set({ measurements: rec.measurements, scans: rec.scans, documents: rec.documents });
    } catch { /* the original error was already reported */ }
  }

  /** Run a save in the background; on failure, report it and reload. */
  function persist(save: (b: Backend, pid: string) => Promise<unknown>): void {
    const pid = get().profileId;
    if (!backend || !pid) return;
    save(backend, pid).catch(e => {
      reportError(messageOf(e));
      void reload();
    });
  }

  return {
    profileId: null,
    loading: false,
    measurements: [],
    scans: [],
    documents: [],
    selectedOrgan: null,
    selectedMarkerId: null,
    activeSystem: null,

    openProfile: async profileId => {
      const ticket = ++loadTicket;
      blobCache.clear();
      set({
        profileId, loading: !!(profileId && backend), measurements: [], scans: [], documents: [],
        selectedOrgan: null, selectedMarkerId: null, activeSystem: null,
      });
      if (!profileId || !backend) return;
      try {
        const rec = await backend.records(profileId);
        if (ticket === loadTicket) set({ ...rec, loading: false });
      } catch (e) {
        if (ticket === loadTicket) set({ loading: false });
        reportError(messageOf(e));
      }
    },

    addResult: async (r, files = [], stored = {}) => {
      const { measurements, scans, profileId } = get();
      const newMs = onlyNew(measurements, r.measurements.map(refreshMeasurement), measurementKey);
      const newScans = onlyNew(scans, r.scans, scanKey);

      if (!backend || !profileId) {
        const ids = new Set(measurements.map(m => m.id));
        for (const s of newScans) if (r.blobs[s.blobKey]) blobCache.set(s.blobKey, r.blobs[s.blobKey]);
        set({ measurements: [...measurements, ...newMs.map(m => (ids.has(m.id) ? { ...m, id: uid() } : m))], scans: [...scans, ...newScans] });
        return { measurements: newMs.length, scans: newScans.length, files: 0 };
      }

      const b = backend;
      const uploaded: StoredDocument[] = [];
      try {
        // Scans are stored with their original file.
        const scanInputs: ScanInput[] = [];
        for (const s of newScans) {
          const blob = r.blobs[s.blobKey];
          if (!blob) continue;
          const doc = await b.uploadDocument(profileId, blob, s.fileName, 'scan');
          uploaded.push(doc);
          blobCache.set(doc.id, blob);
          scanInputs.push({ ...withoutId(s), blobKey: doc.id });
        }
        // Keep each report file that new results were read from.
        const docBySource = new Map<string, string>(Object.entries(stored));
        const sources = new Set(newMs.map(m => m.sourceFile));
        const scanFiles = new Set(newScans.map(s => s.fileName));
        for (const f of files) {
          if (!sources.has(f.name) || scanFiles.has(f.name) || docBySource.has(f.name)) continue;
          const doc = await b.uploadDocument(profileId, f, f.name, 'report');
          uploaded.push(doc);
          docBySource.set(f.name, doc.id);
        }
        const savedMs: Measurement[] = [];
        for (const part of chunks(newMs, LIMITS.measurementsPerRequest)) {
          const rows: MeasurementInput[] = part.map(m => ({ ...withoutId(m), documentId: docBySource.get(m.sourceFile) ?? null }));
          savedMs.push(...await b.addMeasurements(profileId, rows));
        }
        const savedScans: ScanItem[] = [];
        for (const part of chunks(scanInputs, LIMITS.scansPerRequest)) savedScans.push(...await b.addScans(profileId, part));

        if (get().profileId === profileId) {
          set(s => ({
            measurements: [...s.measurements, ...savedMs],
            scans: [...s.scans, ...savedScans],
            documents: [...uploaded, ...s.documents],
          }));
        }
        return { measurements: savedMs.length, scans: savedScans.length, files: uploaded.length };
      } catch (e) {
        // Remove files stored by this attempt so a retry does not duplicate them.
        await Promise.allSettled(uploaded.map(d => b.deleteDocument(profileId, d.id)));
        void reload();
        throw e;
      }
    },

    updateMeasurement: (id, patch) => {
      const prev = get().measurements.find(m => m.id === id);
      if (!prev) return;
      const next = refreshMeasurement({ ...prev, ...patch, id });
      set(s => ({ measurements: s.measurements.map(m => (m.id === id ? next : m)) }));
      persist((b, pid) => b.updateMeasurement(pid, id, withoutId(next)));
    },

    removeMeasurement: id => {
      set(s => ({ measurements: s.measurements.filter(m => m.id !== id) }));
      persist((b, pid) => b.deleteMeasurement(pid, id));
    },

    updateScan: (id, patch) => {
      set(s => ({ scans: s.scans.map(x => (x.id === id ? { ...x, ...patch, id: x.id, blobKey: x.blobKey } : x)) }));
      persist((b, pid) => b.updateScan(pid, id, patch));
    },

    removeScan: id => {
      const scan = get().scans.find(x => x.id === id);
      if (!scan) return;
      blobCache.delete(scan.blobKey);
      set(s => ({ scans: s.scans.filter(x => x.id !== id), documents: s.documents.filter(d => d.id !== scan.blobKey) }));
      persist((b, pid) => b.deleteScan(pid, id));
    },

    removeDocument: id => {
      blobCache.delete(id);
      set(s => ({
        documents: s.documents.filter(d => d.id !== id),
        scans: s.scans.filter(x => x.blobKey !== id),
        measurements: s.measurements.map(m => (m.documentId === id ? { ...m, documentId: null } : m)),
      }));
      persist((b, pid) => b.deleteDocument(pid, id));
    },

    clearAll: async () => {
      blobCache.clear();
      set({ measurements: [], scans: [], documents: [], selectedOrgan: null, selectedMarkerId: null, activeSystem: null });
      const pid = get().profileId;
      if (!backend || !pid) return;
      try {
        await backend.clearRecords(pid);
      } catch (e) {
        void reload();
        throw e;
      }
    },

    loadSample: () => get().addResult(SAMPLE),
    selectOrgan: organ => set({ selectedOrgan: organ }),
    selectMarker: markerId => set({ selectedMarkerId: markerId }),
    setActiveSystem: system => set({ activeSystem: system }),
  };
});

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
