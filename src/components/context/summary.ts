// Counts and orderings behind the visual summaries (overview ring, system tiles, attention cards).
import { create } from 'zustand';
import { SYSTEM_LABELS } from '../../lib/catalog';
import { rankStatus, type Series } from '../../lib/derive';
import { useUI, VIEWS, type View } from '../../state/ui';
import type { RefRange, Status, SystemId } from '../../types';

export interface StatusCounts { total: number; normal: number; high: number; low: number; unknown: number }

/** Range as text, e.g. "70 – 100" or "< 200". */
export function rangeText(r: RefRange | null | undefined): string {
  if (!r) return 'No range';
  if (r.text) return r.text;
  if (r.low != null && r.high != null) return `${r.low} – ${r.high}`;
  if (r.high != null) return `< ${r.high}`;
  if (r.low != null) return `> ${r.low}`;
  return 'No range';
}

export { distanceOutside, isOut } from '../../lib/attention';
import { distanceOutside, isOut } from '../../lib/attention';

export function statusCounts(series: Series[]): StatusCounts {
  const c: StatusCounts = { total: 0, normal: 0, high: 0, low: 0, unknown: 0 };
  for (const s of series) { c.total++; c[s.latest.status]++; }
  return c;
}

export const SYSTEM_ORDER = Object.keys(SYSTEM_LABELS) as SystemId[];
export type SystemKey = SystemId | 'other';

export function systemLabel(k: SystemKey): string {
  return k === 'other' ? 'Unmatched rows' : SYSTEM_LABELS[k];
}

/** Series grouped by body system in catalog order, unmatched rows last; each group sorted by status then name. */
export function groupBySystem(series: Series[]): { system: SystemKey; list: Series[]; counts: StatusCounts }[] {
  const by = new Map<SystemKey, Series[]>();
  for (const s of series) { const k: SystemKey = s.def?.system ?? 'other'; (by.get(k) ?? by.set(k, []).get(k)!).push(s); }
  const order: SystemKey[] = [...SYSTEM_ORDER, 'other'];
  return order.filter(k => by.has(k)).map(k => {
    const list = by.get(k)!.sort((a, b) => rankStatus(a.latest.status) - rankStatus(b.latest.status) || a.name.localeCompare(b.name));
    return { system: k, list, counts: statusCounts(list) };
  });
}

/** The status that best sums up a group: any above wins, then any below, then in range, else no range. */
export function groupStatus(c: StatusCounts): Status {
  return c.high ? 'high' : c.low ? 'low' : c.normal ? 'normal' : 'unknown';
}

/** Latest values outside their range, furthest out first. */
export function needsAttention(series: Series[]): Series[] {
  return series.filter(s => isOut(s.latest.status)).sort((a, b) => distanceOutside(b.latest) - distanceOutside(a.latest) || a.name.localeCompare(b.name));
}

/** Distinct sample dates, oldest first. */
export function sampleDates(series: Series[]): string[] {
  return [...new Set(series.flatMap(s => s.points.map(p => p.date).filter(Boolean) as string[]))].sort();
}

/* ---------------- shared view state for the Biomarkers page ---------------- */

export type MarkerFilter = 'all' | 'out' | SystemKey;
export type Layout = 'cards' | 'table';

const LAYOUT_KEY = 'lotuspond:biomarkers-layout';
function savedLayout(): Layout {
  try { return localStorage.getItem(LAYOUT_KEY) === 'table' ? 'table' : 'cards'; } catch { return 'cards'; }
}

interface MarkerViewState {
  filter: MarkerFilter;
  layout: Layout;
  setFilter: (f: MarkerFilter) => void;
  setLayout: (l: Layout) => void;
}

/** Filter and layout of the Biomarkers page, shared so the overview can open it pre-filtered. */
export const useMarkerView = create<MarkerViewState>(set => ({
  filter: 'all',
  layout: savedLayout(),
  setFilter: filter => set({ filter }),
  setLayout: layout => {
    try { localStorage.setItem(LAYOUT_KEY, layout); } catch { /* storage unavailable */ }
    set({ layout });
  },
}));

/** Open the Biomarkers page with a filter applied. */
export function showMarkers(filter: MarkerFilter = 'all') {
  useMarkerView.getState().setFilter(filter);
  useUI.getState().setView('markers');
}

/** True once the app has a Labs view (added separately); until then the action explains it is not ready. */
export const hasLabsView = (VIEWS as string[]).includes('labs');

export function openLabs(): boolean {
  if (!hasLabsView) return false;
  useUI.getState().setView('labs' as View);
  return true;
}
