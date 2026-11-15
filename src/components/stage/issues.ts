// Which organs light up on the body: those with results outside their range (src/lib/attention.ts). Shared by the
// pre-rendered map and the 3D stage, and free of three.js.
import { useMemo } from 'react';
import { useHealth } from '../../lib/store';
import { buildSeries } from '../../lib/derive';
import { attentionItems, organIssues, type IssueLevel } from '../../lib/attention';
import type { OrganId } from '../../types';

/** Amber for outside the range, coral for far outside: the same family as the "Outside" pin colour. */
export const ISSUE_COLOR: Record<IssueLevel, string> = { out: '#f0b43c', far: '#f0664a' };
export const ISSUE_RGB: Record<IssueLevel, [number, number, number]> = { out: [240, 180, 60], far: [240, 102, 74] };

export function useIssues() {
  const measurements = useHealth(s => s.measurements);
  return useMemo(() => {
    const items = attentionItems(buildSeries(measurements));
    return { items, organs: organIssues(items) };
  }, [measurements]);
}

/** Pins of organs with an issue pulse; with any issue on the body, the other pins go quiet. */
export function pinIssueClass(issues: Partial<Record<OrganId, IssueLevel>>, organ: OrganId): string {
  const lv = issues[organ];
  if (lv) return ` pin--issue pin--issue-${lv}`;
  return Object.keys(issues).length ? ' pin--quiet' : '';
}
