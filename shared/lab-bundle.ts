// Types shared by the LotusPond backend (server/) and the browser app (src/) for lab orders and results.
// See docs/lab-booking-backend.md. Keep this file free of runtime dependencies so both sides can import it.

export type PartnerId = 'fake' | 'tata1mg' | 'thyrocare' | 'labsadvisor';

/** Our order states (design doc §6). Partner status names are mapped to these by each adapter. */
export const ORDER_STATUSES = [
  'created', 'payment_pending', 'paid', 'placing', 'booked', 'collector_assigned', 'sample_collected',
  'recollection_needed', 'processing', 'partial_report', 'report_ready', 'delivered', 'expired', 'cancelled', 'failed',
] as const;
export type OrderStatus = typeof ORDER_STATUSES[number];

/** One result as the lab printed it. Field names match what src/lib/parse/json.ts reads. */
export interface ResultRow {
  name: string;
  /** Keep text such as "<0.5" or "Negative" as text. */
  value: string | number;
  unit?: string;
  /** Printed reference range, e.g. "0.54 - 5.30" or "< 200". */
  range?: string;
  low?: number;
  high?: number;
  /** "H", "L", "Abnormal"... as printed. */
  flag?: string;
  /** Partner's own test code, kept for future code-based matching. Never sent as `markerId` (design doc §4.2). */
  partnerCode?: string;
  loinc?: string;
}

/** What the browser receives (after decryption) for one delivery of an order's results. */
export interface LabResultBundle {
  version: 1;
  kind: 'lab-result-bundle';
  source: { partner: PartnerId; orderId: string; partnerRef: string; labName?: string };
  /** Sample collection date, yyyy-mm-dd. */
  date: string | null;
  reportedAt: string | null;
  partial: boolean;
  /** Goes up with each delivery for the order; a higher sequence replaces earlier ones. */
  sequence: number;
  results: ResultRow[];
}

/**
 * Version of the booking notice the app shows before a lab booking: it names the lab and lists what is shared with
 * it (name, age, sex, mobile number, address, tests) and why. Bookings accepted under another version are refused.
 * Bump it whenever the notice text changes.
 */
export const LAB_BOOKING_NOTICE_VERSION = '2026-11-03';
