import type { BiomarkerDef, Measurement, OrganId, Status, SystemId } from '../types';
import { BIOMARKERS, findMarker } from './catalog';

export interface Series { key: string; def: BiomarkerDef | null; name: string; points: Measurement[]; latest: Measurement }

const keyOf = (m: Measurement) => m.markerId ?? `raw:${m.rawName.toLowerCase()}`;
const byDate = (a: Measurement, b: Measurement) => (a.date ?? '').localeCompare(b.date ?? '');

/** One series per biomarker, points oldest → newest. */
export function buildSeries(ms: Measurement[]): Series[] {
  const map = new Map<string, Measurement[]>();
  for (const m of ms) { const k = keyOf(m); (map.get(k) ?? map.set(k, []).get(k)!).push(m); }
  return [...map.entries()].map(([key, pts]) => {
    pts.sort(byDate);
    const def = pts[0].markerId ? findMarker(pts[0].markerId) ?? null : null;
    return { key, def, name: def?.name ?? pts[0].rawName, points: pts, latest: pts[pts.length - 1] };
  });
}

export const organsOf = (s: Series): OrganId[] => s.def?.organs ?? [];
export const systemOf = (s: Series): SystemId | null => s.def?.system ?? null;

export function seriesForOrgan(all: Series[], organ: OrganId) {
  return all.filter(s => organsOf(s).includes(organ))
    .sort((a, b) => rankStatus(a.latest.status) - rankStatus(b.latest.status) || a.name.localeCompare(b.name));
}

export function rankStatus(s: Status) { return s === 'high' ? 0 : s === 'low' ? 1 : s === 'unknown' ? 3 : 2; }

export function systemCounts(all: Series[]) {
  const out: Partial<Record<SystemId, { total: number; high: number; low: number }>> = {};
  for (const s of all) {
    const sys = systemOf(s); if (!sys) continue;
    const c = (out[sys] ??= { total: 0, high: 0, low: 0 });
    c.total++; if (s.latest.status === 'high') c.high++; if (s.latest.status === 'low') c.low++;
  }
  return out;
}

export function formatDate(iso: string | null, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }) {
  if (!iso) return 'Undated';
  const d = new Date(iso + 'T12:00:00');
  return isNaN(+d) ? iso : d.toLocaleDateString(undefined, opts);
}

export const STATUS_WORD: Record<Status, string> = { high: 'Above range', low: 'Below range', normal: 'In range', unknown: 'No range' };

export const knownMarkerCount = BIOMARKERS.length;
