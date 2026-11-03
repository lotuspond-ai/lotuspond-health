// Reconciliation poller (design doc §4.3, §12): asks partners about unfinished orders on a schedule that
// depends on their status, so a missed webhook only delays an update. Partners without webhooks rely on it.
import type { OrderStatus } from '../../../../shared/lab-bundle.ts';
import { PartnerError } from '../partners/types.ts';
import { syncOrder, type SyncDeps } from './sync.ts';

const MIN = 60_000, HOUR = 60 * MIN;

/**
 * How long after the last sync an order is polled again. Statuses not listed are not polled: before
 * placing there's nothing to ask, and from report_ready on the results pipeline takes over.
 * booked should eventually follow the slot time (poll near the visit); orders don't carry the slot yet.
 */
export const POLL_EVERY_MS: Partial<Record<OrderStatus, number>> = {
  booked: 3 * HOUR,
  collector_assigned: 30 * MIN,
  sample_collected: HOUR,
  recollection_needed: HOUR,
  processing: 6 * HOUR,
  partial_report: 3 * HOUR,
};

export interface ReconcileResult { polled: number; changed: number; failed: number }

export async function reconcile(deps: SyncDeps, opts: { every?: Partial<Record<OrderStatus, number>>; limit?: number } = {}): Promise<ReconcileResult> {
  const every = opts.every ?? POLL_EVERY_MS;
  const now = deps.now();
  const cutoffs: Partial<Record<OrderStatus, number>> = {};
  for (const [status, ms] of Object.entries(every) as [OrderStatus, number][]) cutoffs[status] = now - ms;

  const due = await deps.orders.dueForPoll(cutoffs, opts.limit ?? 100);
  const result: ReconcileResult = { polled: 0, changed: 0, failed: 0 };
  for (const o of due) {
    result.polled++;
    try {
      const outcome = await syncOrder(deps, o.id, 'poll');
      if (outcome?.kind === 'applied') result.changed++;
    } catch (e) {
      result.failed++;
      deps.log.warn('poll failed', {
        orderId: o.id, partner: o.partner,
        error: e instanceof PartnerError ? e.code : e instanceof Error ? e.name : 'unknown',
        alert: !(e instanceof PartnerError && e.retryable),
      });
    }
  }
  return result;
}
