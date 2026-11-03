// Result status per organ, shared by the 2D body map and the 3D stage (no three.js here).
import { ORGANS } from '../../anatomy/organs';
import { BIOMARKERS } from '../../lib/catalog';
import type { OrganCounts } from '../../lib/store';
import type { OrganId, SystemId } from '../../types';

export type PinState = 'none' | 'ok' | 'out';

export const STATUS_COLOR: Record<PinState | 'focus', string> = { none: '#7f9b98', ok: '#5fbf95', out: '#e9b949', focus: '#e2869e' };

/** Organs that get a status pin on the overview (the airway and esophagus have no results of their own). */
export const PINNED = ORGANS.filter(o => o.id !== 'skin' && o.id !== 'airway' && o.id !== 'esophagus');

export const pinState = (s: OrganCounts | undefined): PinState => (!s || s.total === 0 ? 'none' : s.out > 0 ? 'out' : 'ok');

export function pinLabel(name: string, s: OrganCounts | undefined) {
  return `${name}${s?.total ? `, ${s.total} result${s.total === 1 ? '' : 's'}, ${s.out} outside range` : ', no results yet'}`;
}

/** Body systems each organ belongs to, directly or through the markers that relate to it. */
export const ORGAN_SYSTEMS = (() => {
  const map: Record<string, Set<SystemId>> = {};
  for (const o of ORGANS) map[o.id] = new Set(o.systems);
  for (const b of BIOMARKERS) for (const o of b.organs) (map[o] ??= new Set()).add(b.system);
  return map as Record<OrganId, Set<SystemId>>;
})();
