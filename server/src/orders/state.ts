// Order state machine (design doc §6). Pure: no I/O, no clock.
//
// Two kinds of moves:
// - partner: what the lab reports (via a webhook hint or a poll). The lab is the source of truth for the
//   visit and the report, so these moves are judged on whether they make sense, not on who asked.
// - local: what we do ourselves: payment, placing the order, a user's cancel or reschedule, the device
//   confirming pickup, the mailbox expiring.
//
// Out-of-date reads (an older status fetched late) are caught by comparing the partner's status time
// before this is called (orders/sync.ts); this module only judges whether a move is allowed.
import type { OrderStatus } from '../../../shared/lab-bundle.ts';

export const FINAL_STATUSES: ReadonlySet<OrderStatus> = new Set(['delivered', 'expired', 'cancelled', 'failed']);
export const isFinal = (s: OrderStatus): boolean => FINAL_STATUSES.has(s);

/** Position from booking to delivery. recollection_needed shares sample_collected's rank: a rejected sample. */
const RANK: Record<OrderStatus, number> = {
  created: 0, payment_pending: 1, paid: 2, placing: 3, booked: 4, collector_assigned: 5,
  sample_collected: 6, recollection_needed: 6, processing: 7, partial_report: 8, report_ready: 9,
  delivered: 10, expired: 10, cancelled: 10, failed: 10,
};

/** Statuses a partner can report. Everything else is ours to set. */
export const PARTNER_STATUSES: ReadonlySet<OrderStatus> = new Set([
  'booked', 'collector_assigned', 'sample_collected', 'recollection_needed', 'processing', 'partial_report', 'report_ready', 'cancelled',
]);

/** Our own moves. A user's cancel or reschedule is applied after the partner has accepted it. */
const LOCAL_MOVES: Partial<Record<OrderStatus, readonly OrderStatus[]>> = {
  created: ['payment_pending', 'placing', 'cancelled', 'failed'],
  payment_pending: ['paid', 'cancelled', 'failed'],
  paid: ['placing', 'cancelled', 'failed'],
  placing: ['booked', 'failed'],
  booked: ['cancelled'],
  collector_assigned: ['booked', 'cancelled'],
  recollection_needed: ['booked', 'cancelled'],
  partial_report: ['expired'],
  report_ready: ['delivered', 'expired'],
};

export type MoveSource = 'partner' | 'local';

export type MoveCheck =
  | { ok: true }
  /**
   * unchanged: already there. final: the order is finished. backward: an earlier stage than where we are.
   * not_allowed: not a move this source can make from here.
   */
  | { ok: false; reason: 'unchanged' | 'final' | 'backward' | 'not_allowed' };

const OK: MoveCheck = { ok: true };
const no = (reason: 'unchanged' | 'final' | 'backward' | 'not_allowed'): MoveCheck => ({ ok: false, reason });

export function checkMove(from: OrderStatus, to: OrderStatus, source: MoveSource): MoveCheck {
  if (from === to) return no('unchanged');
  if (isFinal(from)) return no('final');
  if (source === 'local') return LOCAL_MOVES[from]?.includes(to) ? OK : no('not_allowed');

  if (!PARTNER_STATUSES.has(to)) return no('not_allowed');
  // The lab can cancel at any point (no collector available, sample lost). Accept it and handle it.
  if (to === 'cancelled') return OK;
  // A rejected sample can be reported any time after booking, up to a partial report (one test's sample failed).
  if (to === 'recollection_needed') return RANK[from] >= RANK.booked && RANK[from] <= RANK.partial_report ? OK : no('not_allowed');
  // After a rejected sample the visit starts again, from booking onwards.
  if (from === 'recollection_needed') return RANK[to] >= RANK.booked ? OK : no('backward');
  // Visit rescheduled or collector reassigned by the lab.
  if (from === 'collector_assigned' && to === 'booked') return OK;
  // Skipping ahead is fine: a missed webhook means we may jump from booked straight to report_ready.
  return RANK[to] > RANK[from] ? OK : no('backward');
}

/** Whether a user may still cancel (we then ask the partner, and apply `cancelled` once it agrees). */
export const canCancel = (s: OrderStatus): boolean => LOCAL_MOVES[s]?.includes('cancelled') ?? false;

/** Whether a user may still reschedule the visit. */
export const canReschedule = (s: OrderStatus): boolean => s === 'booked' || s === 'collector_assigned' || s === 'recollection_needed';

/** Statuses where the partner's report may be new or changed (partial, final, amended). */
export const REPORT_STATUSES: ReadonlySet<OrderStatus> = new Set(['partial_report', 'report_ready', 'delivered']);
