// Display helpers for lab booking: prices, collection slots (shown in India time, where the labs are), status names.
import { PARTNER_LABELS, type LabOrderView, type LabSlot, type OrderStatus, type PartnerId } from '../../../shared/lab-bundle';

const IST = 'Asia/Kolkata';

export const rupees = (paise: number): string =>
  `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

export const partnerName = (id: PartnerId | string): string => PARTNER_LABELS[id as PartnerId] ?? id;

/** "Wed, 4 Nov" */
export function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', { timeZone: IST, weekday: 'short', day: 'numeric', month: 'short' });
}

/** "6:00 – 7:00 am" */
export function timeRange(slot: LabSlot): string {
  const t = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { timeZone: IST, hour: 'numeric', minute: '2-digit' });
  const [a, b] = [t(slot.start), t(slot.end)];
  const sameHalf = a.slice(-2) === b.slice(-2);
  return `${sameHalf ? a.slice(0, -3) : a} – ${b}`;
}

export const slotLabel = (slot: LabSlot): string => `${dayLabel(slot.start)}, ${timeRange(slot)}`;

/** The next `n` days in India, as yyyy-mm-dd with a short label ("Today", "Tomorrow", "Fri, 6 Nov"). */
export function nextDays(n = 7, now = Date.now()): { date: string; label: string }[] {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: IST, year: 'numeric', month: '2-digit', day: '2-digit' });
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(now + i * 86_400_000);
    return { date: ymd.format(d), label: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : dayLabel(d.toISOString()) };
  });
}

export const STATUS_LABEL: Record<OrderStatus, string> = {
  created: 'Booking…', payment_pending: 'Waiting for payment', paid: 'Booking…', placing: 'Confirming with the lab…',
  booked: 'Booked', collector_assigned: 'Collector assigned', sample_collected: 'Sample collected',
  recollection_needed: 'A new sample is needed', processing: 'At the lab', partial_report: 'Some results ready',
  report_ready: 'Results ready', delivered: 'Results added', expired: 'Expired', cancelled: 'Cancelled', failed: 'Not booked',
};

/** Tone for the status chip. */
export function statusTone(s: OrderStatus): 'progress' | 'ready' | 'done' | 'stopped' | 'attention' {
  if (s === 'report_ready' || s === 'partial_report') return 'ready';
  if (s === 'delivered') return 'done';
  if (s === 'cancelled' || s === 'failed' || s === 'expired') return 'stopped';
  if (s === 'recollection_needed') return 'attention';
  return 'progress';
}

/** Steps of the progress tracker, and how far an order has got (-1 when it stopped before starting). */
export const STEPS = ['Booked', 'Collector', 'Sample collected', 'At the lab', 'Results'] as const;
export function stepOf(o: LabOrderView): number {
  switch (o.status) {
    case 'booked': case 'recollection_needed': return 0;
    case 'collector_assigned': return 1;
    case 'sample_collected': return 2;
    case 'processing': case 'partial_report': return 3;
    case 'report_ready': case 'delivered': return 4;
    default: return -1;
  }
}

const REASONS: Record<string, string> = {
  slot_unavailable: 'That slot was taken before the lab could confirm it.',
  placement_gave_up: 'The lab did not confirm the booking in time.',
  not_serviceable: 'The lab does not collect at that pincode.',
  rejected_by_partner: 'The lab could not take this booking.',
};
export const failureText = (reason: string | null): string => (reason && REASONS[reason]) || 'The lab could not take this booking.';
