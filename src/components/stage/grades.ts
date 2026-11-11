// A letter per body system for the "Glow" look of the body map, from the latest result of each marker:
//   A  every result in range        B  something outside its range        C  something far outside it
//   –  no results yet
// It sums up the counts the app already shows; it is not a clinical score.
import { useMemo } from 'react';
import { useHealth } from '../../lib/store';
import { buildSeries } from '../../lib/derive';
import { distanceOutside, FAR_OUTSIDE, isOut } from '../../lib/attention';
import { SYSTEM_LABELS } from '../../lib/catalog';
import type { SystemId } from '../../types';

export type Grade = 'A' | 'B' | 'C' | '–';

export interface SystemGrade { system: SystemId; label: string; grade: Grade; total: number; out: number; far: number }

/** Ring colours: the body map's in-range green and its outside / far outside glow colours (issues.ts). */
export const GRADE_COLOR: Record<Grade, string> = { A: '#5fbf95', B: '#f0b43c', C: '#f0664a', '–': '#5d7f7c' };

export function gradeOf(total: number, out: number, far: number): Grade {
  return !total ? '–' : far ? 'C' : out ? 'B' : 'A';
}

export function gradeText(g: SystemGrade): string {
  if (!g.total) return `${g.label}: no results yet`;
  const res = `${g.total} result${g.total === 1 ? '' : 's'}`;
  if (!g.out) return `${g.label}, grade A: ${res}, all in range`;
  return `${g.label}, grade ${g.grade}: ${res}, ${g.out} outside range${g.far ? `, ${g.far} far outside` : ''}`;
}

export function useSystemGrades(): SystemGrade[] {
  const measurements = useHealth(s => s.measurements);
  return useMemo(() => {
    const by = new Map<SystemId, { total: number; out: number; far: number }>();
    for (const s of buildSeries(measurements)) {
      const sys = s.def?.system;
      if (!sys) continue;
      const c = by.get(sys) ?? by.set(sys, { total: 0, out: 0, far: 0 }).get(sys)!;
      c.total++;
      if (isOut(s.latest.status)) { c.out++; if (distanceOutside(s.latest) >= FAR_OUTSIDE) c.far++; }
    }
    return (Object.keys(SYSTEM_LABELS) as SystemId[]).map(system => {
      const c = by.get(system) ?? { total: 0, out: 0, far: 0 };
      return { system, label: SYSTEM_LABELS[system], grade: gradeOf(c.total, c.out, c.far), ...c };
    });
  }, [measurements]);
}
