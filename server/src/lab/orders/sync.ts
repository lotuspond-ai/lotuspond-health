// Brings one order up to date with its partner (design doc §4.3, §5.2). The webhook processor and the
// reconciliation poller both call syncOrder; neither trusts a webhook's payload. We always ask the partner
// for the current status, drop out-of-date reads by the partner's status time, then apply the state machine.
import type { OrderStatus } from '../../../../shared/lab-bundle.ts';
import type { Logger } from '../log.ts';
import type { PartnerRegistry, PartnerStatus } from '../partners/types.ts';
import type { OrderChange, OrderRecord, OrderStore } from '../store/types.ts';
import { checkMove, REPORT_STATUSES } from './state.ts';

export interface OrderHooks {
  /** Our status changed. Push notifications hang off this. */
  onTransition?(order: OrderRecord, from: OrderStatus): void | Promise<void>;
  /** The partner's report may be new or changed (partial, final or amended); the results pipeline compares versions. */
  onReportUpdate?(order: OrderRecord): void | Promise<void>;
}

export interface SyncDeps {
  orders: OrderStore;
  partners: PartnerRegistry;
  now: () => number;
  log: Logger;
  hooks?: OrderHooks;
}

export type NotedReason = 'unchanged' | 'final' | 'backward' | 'not_allowed' | 'unknown_status';

export type SyncOutcome =
  /** Our status moved. */
  | { kind: 'applied'; from: OrderStatus; to: OrderStatus }
  /** The partner's status changed but ours didn't (e.g. REPORT_AMENDED, or a move we refuse). Recorded as an event. */
  | { kind: 'noted'; status: OrderStatus; partnerStatus: string; reason: NotedReason }
  /** Same partner status and time as last time. */
  | { kind: 'duplicate' }
  /** Older than what we already have (a slow read finishing late). */
  | { kind: 'stale' };

/** The pure part of a sync: given the stored order and what the partner says, what changes. */
export function decideSync(cur: OrderRecord, st: PartnerStatus, source: 'webhook' | 'poll', now: number): { change: OrderChange; outcome: SyncOutcome } {
  const parsed = Date.parse(st.at);
  const at = Number.isNaN(parsed) ? now : parsed;
  const synced: OrderRecord = { ...cur, lastSyncedAt: now };
  if (cur.partnerStatusAt != null && at < cur.partnerStatusAt) return { change: { next: synced, events: [] }, outcome: { kind: 'stale' } };
  if (cur.partnerStatusAt === at && cur.partnerStatus === st.partnerStatus) return { change: { next: synced, events: [] }, outcome: { kind: 'duplicate' } };

  const seen: OrderRecord = { ...synced, partnerStatus: st.partnerStatus, partnerStatusAt: at, updatedAt: now };
  const event = (status: OrderStatus, note?: string) => ({
    orderId: cur.id, status, partnerStatus: st.partnerStatus, source, occurredAt: at, receivedAt: now, ...(note ? { note } : {}),
  });

  if (st.status === 'unknown') {
    return {
      change: { next: seen, events: [event(cur.status, `unknown partner status ${st.partnerStatus}`)] },
      outcome: { kind: 'noted', status: cur.status, partnerStatus: st.partnerStatus, reason: 'unknown_status' },
    };
  }
  const check = checkMove(cur.status, st.status, 'partner');
  if (check.ok) {
    return {
      change: { next: { ...seen, status: st.status }, events: [event(st.status)] },
      outcome: { kind: 'applied', from: cur.status, to: st.status },
    };
  }
  const note = check.reason === 'unchanged' ? undefined : `partner reported ${st.status} (${check.reason})`;
  return {
    change: { next: seen, events: [event(cur.status, note)] },
    outcome: { kind: 'noted', status: cur.status, partnerStatus: st.partnerStatus, reason: check.reason },
  };
}

/**
 * Fetch the order's status from its partner and apply it. Throws what the adapter throws (PartnerError) so
 * the caller can retry; returns null if the order doesn't exist or has no partner reference yet.
 */
export async function syncOrder(deps: SyncDeps, orderId: string, source: 'webhook' | 'poll'): Promise<SyncOutcome | null> {
  const order = await deps.orders.get(orderId);
  if (!order?.partnerRef) return null;
  const cfg = deps.partners.get(order.partner);
  if (!cfg) throw new Error(`No adapter configured for partner ${order.partner}`);
  const st = await cfg.adapter.status(order.partnerRef, order.partnerToken);

  const holder: { outcome?: SyncOutcome } = {};
  const after = await deps.orders.apply(order.id, cur => {
    const d = decideSync(cur, st, source, deps.now());
    holder.outcome = d.outcome;
    return d.change;
  });
  const outcome = holder.outcome;
  if (!after || !outcome) return null;

  const fields = { orderId: after.id, partner: after.partner, partnerStatus: st.partnerStatus, source };
  if (outcome.kind === 'applied') deps.log.info('order status changed', { ...fields, from: outcome.from, to: outcome.to });
  else if (outcome.kind === 'noted') {
    if (outcome.reason === 'unknown_status') deps.log.error('unknown partner status', { ...fields, status: after.status, alert: true });
    else if (outcome.reason === 'backward' || outcome.reason === 'not_allowed') {
      deps.log.warn('partner status conflicts with order', { ...fields, status: after.status, reported: st.status, reason: outcome.reason, alert: true });
    } else deps.log.info('partner status noted', { ...fields, status: after.status });
  }

  if (outcome.kind === 'applied' || outcome.kind === 'noted') {
    await runHook(deps, 'onTransition', after, outcome.kind === 'applied' ? outcome.from : null);
    if (REPORT_STATUSES.has(after.status)) await runHook(deps, 'onReportUpdate', after, null);
  }
  return outcome;
}

/** Hooks enqueue follow-up work; a failing hook is logged and doesn't undo the sync. */
async function runHook(deps: SyncDeps, name: keyof OrderHooks, order: OrderRecord, from: OrderStatus | null): Promise<void> {
  try {
    if (name === 'onTransition') {
      if (from != null) await deps.hooks?.onTransition?.(order, from);
    } else await deps.hooks?.onReportUpdate?.(order);
  } catch (e) {
    deps.log.error('order hook failed', { hook: name, orderId: order.id, error: e instanceof Error ? e.name : 'unknown', alert: true });
  }
}
