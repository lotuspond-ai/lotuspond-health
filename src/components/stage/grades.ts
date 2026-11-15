// A letter per body system for the "Glow" look of the body map, from the latest result of each marker:
//   A  every result in range        B  something outside its range        C  something far outside it
//   –  no results yet, or none with a range to compare against
// Results without a range ("unknown") are counted apart and never count as in range. Organ halos use the same rule
// over every organ a marker relates to (useOrganLevels). It sums up the counts the app already shows; it is not a clinical score.
import { useMemo } from 'react';
import { useHealth } from '../../lib/store';
import { buildSeries } from '../../lib/derive';
import { distanceOutside, FAR_OUTSIDE, isOut } from '../../lib/attention';
import { SYSTEM_LABELS } from '../../lib/catalog';
import type { OrganId, SystemId } from '../../types';
import type { IssueLevel } from '../../lib/attention';

export type Grade = 'A' | 'B' | 'C' | '–';

/** `total` counts results with a range; `unknown` those without one. */
export interface SystemGrade { system: SystemId; label: string; grade: Grade; total: number; out: number; far: number; unknown: number }

/** Ring colours: the body map's in-range green and its outside / far outside glow colours (issues.ts). */
export const GRADE_COLOR: Record<Grade, string> = { A: '#5fbf95', B: '#f0b43c', C: '#f0664a', '–': '#5d7f7c' };

export function gradeOf(total: number, out: number, far: number): Grade {
  return !total ? '–' : far ? 'C' : out ? 'B' : 'A';
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function gradeText(g: SystemGrade): string {
  const noRange = g.unknown ? `${plural(g.unknown, 'result')} without a range` : '';
  if (!g.total) return `${g.label}: ${noRange || 'no results yet'}`;
  const res = plural(g.total, 'result') + ' with a range';
  const extra = noRange ? `; ${noRange}` : '';
  if (!g.out) return `${g.label}, grade A: ${res}, all in range${extra}`;
  return `${g.label}, grade ${g.grade}: ${res}, ${g.out} outside range${g.far ? `, ${g.far} far outside` : ''}${extra}`;
}

export function useSystemGrades(): SystemGrade[] {
  const measurements = useHealth(s => s.measurements);
  return useMemo(() => {
    const by = new Map<SystemId, { total: number; out: number; far: number; unknown: number }>();
    for (const s of buildSeries(measurements)) {
      const sys = s.def?.system;
      if (!sys) continue;
      const c = by.get(sys) ?? by.set(sys, { total: 0, out: 0, far: 0, unknown: 0 }).get(sys)!;
      if (s.latest.status === 'unknown') { c.unknown++; continue; }
      c.total++;
      if (isOut(s.latest.status)) { c.out++; if (distanceOutside(s.latest) >= FAR_OUTSIDE) c.far++; }
    }
    return (Object.keys(SYSTEM_LABELS) as SystemId[]).map(system => {
      const c = by.get(system) ?? { total: 0, out: 0, far: 0, unknown: 0 };
      return { system, label: SYSTEM_LABELS[system], grade: gradeOf(c.total, c.out, c.far), ...c };
    });
  }, [measurements]);
}

/** Per organ: null when its results with a range are all in range, else the strongest level over every marker that
 *  relates to it (the attention list files a marker under its first organ only). Organs without such results are
 *  left out. */
export function useOrganLevels(): Partial<Record<OrganId, IssueLevel | null>> {
  const measurements = useHealth(s => s.measurements);
  return useMemo(() => {
    const out: Partial<Record<OrganId, IssueLevel | null>> = {};
    for (const s of buildSeries(measurements)) {
      if (!s.def || s.latest.status === 'unknown') continue;
      const lv: IssueLevel | null = !isOut(s.latest.status) ? null : distanceOutside(s.latest) >= FAR_OUTSIDE ? 'far' : 'out';
      for (const o of s.def.organs) {
        const cur = out[o];
        if (cur === undefined || (lv && cur !== 'far' && (lv === 'far' || !cur))) out[o] = lv;
      }
    }
    return out;
  }, [measurements]);
}
