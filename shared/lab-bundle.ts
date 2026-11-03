// Types shared by the API server (server/) and the app (src/) for lab orders and results.
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

/** A lab order as the API shows it (GET /api/profiles/:pid/lab-orders...). No personal details, no internal fields. */
export interface LabOrderView {
  id: string;
  profileId: string;
  partner: PartnerId;
  partnerRef: string | null;
  status: OrderStatus;
  items: { code: string; name: string; pricePaise: number }[];
  /** ISO 8601 with the IST offset. */
  slot: { start: string; end: string } | null;
  pricePaise: number;
  /** Who takes payment: 'partner' means pay at collection. */
  payer: 'partner' | 'lotuspond';
  failureReason: string | null;
  canCancel: boolean;
  canReschedule: boolean;
  createdAt: string;
  updatedAt: string;
  /** Status changes, oldest first; only when reading one order. */
  timeline?: { status: OrderStatus; at: string }[];
}

export type LabResultStatus = 'pending' | 'saved' | 'dismissed' | 'superseded';

/** A delivery of an order's results (GET /api/profiles/:pid/lab-results). */
export interface LabResultView {
  id: string;
  orderId: string;
  profileId: string;
  /** 1 for the first delivery of an order; a later one replaces what an earlier one saved. */
  sequence: number;
  partial: boolean;
  /**
   * pending: waiting for review. saved: now records in the profile (documentId is the PDF). dismissed: not wanted.
   * superseded: replaced by a later delivery for the same order.
   */
  status: LabResultStatus;
  /** How the saved records are labelled (their sourceFile), e.g. "LotusPond Test Lab (simulated) order FL…". */
  source: string;
  createdAt: string;
  decidedAt: string | null;
  documentId: string | null;
  /** Whether GET …/:rid/report serves the PDF. */
  hasPdf: boolean;
  /** The rows as printed, for the app's review screen; only while pending. */
  bundle?: LabResultBundle;
}

/* ---------------- booking (GET /api/lab/catalog, /api/lab/slots, POST /api/profiles/:pid/lab-orders) ---------------- */

/** A package a partner offers at a pincode. */
export interface LabCatalogItem {
  partner: PartnerId;
  /** The partner's package code; what a booking lists in `items`. */
  code: string;
  name: string;
  /** Plain names of what the package measures, for display. */
  tests: string[];
  pricePaise: number;
  /** List price before any discount, when the partner shows one. */
  mrpPaise?: number;
  fasting: boolean;
  /** Typical hours from collection to report. */
  reportHours: number;
}

export interface LabCatalog {
  pincode: string;
  items: LabCatalogItem[];
  /** Partners that could not answer just now. */
  unavailable: PartnerId[];
}

/** A collection window. ISO 8601 with the IST offset, e.g. 2026-11-08T07:00:00+05:30. */
export interface LabSlot {
  start: string;
  end: string;
}

export interface LabPatient {
  name: string;
  age: number;
  sex: 'female' | 'male' | 'other';
}

export interface LabAddress {
  line1: string;
  line2?: string;
  landmark?: string;
  city: string;
  pincode: string;
}

/** The body of POST /api/profiles/:pid/lab-orders. */
export interface LabBookingInput {
  partner: PartnerId;
  items: string[];
  slot: LabSlot;
  patient: LabPatient;
  /** Indian mobile number as +91 and 10 digits: the number the collector calls. */
  phone: string;
  address: LabAddress;
  consent: { noticeVersion: string; accepted: boolean };
}

/** What POST /api/profiles/:pid/lab-results/:rid/save answers. */
export interface LabResultSaved {
  result: LabResultView;
  /** The document the report PDF became, if it had one. */
  documentId: string | null;
  saved: number;
  /** Measurements from an earlier delivery of the same order that this one replaced. */
  replaced: number;
}
