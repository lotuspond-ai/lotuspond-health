// What the home screen and the body light up: the results that need attention, in plain sentences, and how much
// each organ is affected. Built on the same series and summary rules agents read (shared/synthesis.ts), so the app
// and a connected agent say the same thing.
import { followUps, markerSummaries, type FollowUp } from '../../shared/synthesis.ts';
import { formatDate, type Series } from './derive.ts';
import type { Measurement, OrganId, Profile, Status } from '../types';

export const isOut = (s: Status) => s === 'high' || s === 'low';

/** How far a value sits outside its range, as a share of the range (0 when inside or unknown). */
export function distanceOutside(m: Measurement): number {
  const r = m.range;
  if (m.value == null || !r) return 0;
  const span = r.low != null && r.high != null ? r.high - r.low : Math.abs(r.high ?? r.low ?? 1) || 1;
  if (r.high != null && m.value > r.high) return (m.value - r.high) / span;
  if (r.low != null && m.value < r.low) return (r.low - m.value) / span;
  return 0;
}

/** How an organ shows on the body: an amber glow for results outside their range, a stronger one when far outside. */
export type IssueLevel = 'out' | 'far';

/** A result at least this far outside its range (as a share of the range) counts as far outside. */
export const FAR_OUTSIDE = 0.25;

export interface AttentionItem {
  key: string;
  /** The marker's series key, to open its history. */
  seriesKey: string;
  name: string;
  organ: OrganId | null;
  level: IssueLevel;
  status: 'high' | 'low';
  /** "Above its range", "Below its range". */
  headline: string;
  /** "124 mmHg on 10 Nov, up from 118 on 2 Oct." */
  detail: string;
  /** A plain next step, never a treatment. */
  next: string;
}

const levelOf = (m: Measurement): IssueLevel => (distanceOutside(m) >= FAR_OUTSIDE ? 'far' : 'out');

function value(m: Measurement) {
  return `${m.valueText}${m.unit ? ` ${m.unit}` : ''}`;
}

function change(s: Series): string {
  const prev = s.points.length > 1 ? s.points[s.points.length - 2] : null;
  if (!prev || prev.value == null || s.latest.value == null) return '';
  if (prev.value === s.latest.value) return `, the same as on ${formatDate(prev.date)}`;
  return `, ${s.latest.value > prev.value ? 'up' : 'down'} from ${prev.valueText} on ${formatDate(prev.date)}`;
}

function nextStep(s: Series, now: number): string {
  const d = s.latest.date ? (now - Date.parse(`${s.latest.date}T00:00:00Z`)) / 86_400_000 : null;
  if (d != null && d > 90) return `Last checked ${Math.round(d / 30)} months ago. Ask a clinician whether to repeat it.`;
  return levelOf(s.latest) === 'far' ? 'Worth raising with a clinician soon.' : 'Worth discussing at your next check-up.';
}

/** Results outside their range, furthest out first, as sentences. */
export function attentionItems(series: Series[], now = Date.now()): AttentionItem[] {
  return series
    .filter(s => isOut(s.latest.status))
    .sort((a, b) => distanceOutside(b.latest) - distanceOutside(a.latest) || a.name.localeCompare(b.name))
    .map(s => {
      const status = s.latest.status as 'high' | 'low';
      return {
        key: `attn:${s.key}`, seriesKey: s.key, name: s.name, organ: s.def?.organs[0] ?? null, level: levelOf(s.latest), status,
        headline: status === 'high' ? 'Above its range' : 'Below its range',
        detail: `${value(s.latest)}${s.latest.date ? ` on ${formatDate(s.latest.date)}` : ''}${change(s)}.`,
        next: nextStep(s, now),
      };
    });
}

/** The strongest issue on each organ; organs with nothing outside range are left out. */
export function organIssues(items: AttentionItem[]): Partial<Record<OrganId, IssueLevel>> {
  const out: Partial<Record<OrganId, IssueLevel>> = {};
  for (const i of items) {
    if (!i.organ) continue;
    if (i.level === 'far' || !out[i.organ]) out[i.organ] = i.level;
  }
  return out;
}

/** Tests that may be due (from the profile's conditions, or results not repeated in a while), not already listed. */
export function testsDue(profile: Pick<Profile, 'conditions'> | null, measurements: Measurement[], listed: AttentionItem[], now = Date.now()): FollowUp[] {
  if (!profile) return [];
  const shown = new Set(listed.map(i => i.name));
  return followUps(profile, markerSummaries(measurements, now)).filter(f => !shown.has(f.marker));
}
