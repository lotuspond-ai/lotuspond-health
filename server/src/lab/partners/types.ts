// The interface every lab partner adapter implements (design doc §8), plus the shapes it trades in.
import type { DataRegion } from '../../../../shared/regions.ts';
import type { OrderStatus, PartnerId, ResultRow } from '../../../../shared/lab-bundle.ts';

export interface CatalogItem {
  partner: PartnerId;
  /** Partner's package code; what createOrder takes in `items`. */
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

/** A collection window. Times are ISO 8601 with the IST offset, e.g. 2026-11-08T07:00:00+05:30. */
export interface Slot {
  start: string;
  end: string;
}

export interface Patient {
  name: string;
  age: number;
  sex: 'female' | 'male' | 'other';
}

export interface Address {
  line1: string;
  line2?: string;
  landmark?: string;
  city: string;
  pincode: string;
}

export interface PartnerOrderInput {
  /** Our order id. Adapters must send it as the partner's client reference (see findOrderByClientRef). */
  orderId: string;
  items: string[];
  slot: Slot;
  patient: Patient;
  /** E.164, e.g. +919812345678. */
  phone: string;
  address: Address;
}

export interface PartnerStatus {
  status: OrderStatus | 'unknown';
  /** The partner's own status name, kept for order_events and for alerting on unknown statuses. */
  partnerStatus: string;
  /** When the partner says the status changed (ISO 8601). */
  at: string;
}

export interface PartnerReport {
  /** Nothing is ready yet. */
  pending: boolean;
  partial: boolean;
  rows?: ResultRow[];
  pdf?: Uint8Array;
  /** Partner's identifier for this version of the report, so an amended report can be told apart from a repeat. */
  version?: string;
  collectedAt?: string;
  reportedAt?: string;
  labName?: string;
}

export interface InboundRequest {
  headers: Record<string, string>;
  rawBody: Uint8Array;
  ip: string;
}

export interface WebhookInfo {
  partnerRef: string;
  /** Partner's event id when it sends one; otherwise the receiver dedupes on a hash of the body. */
  eventId: string | null;
  /**
   * Our order id, when the partner echoes the client reference. Lets a webhook link an order whose booking
   * reply was lost (still `placing`, no partnerRef yet); the link is confirmed with the partner before use.
   */
  clientRef?: string;
}

export interface LabPartner {
  id: PartnerId;
  /** Packages offered at this pincode; empty when the partner doesn't serve it. */
  catalog(pincode: string): Promise<CatalogItem[]>;
  /** Available slots on a date (yyyy-mm-dd, IST). */
  slots(q: { pincode: string; date: string; items: string[] }): Promise<Slot[]>;
  createOrder(o: PartnerOrderInput): Promise<{ partnerRef: string }>;
  /** Lets a retry after a timeout check whether the booking already went through. */
  findOrderByClientRef(orderId: string): Promise<{ partnerRef: string } | null>;
  cancel(partnerRef: string, reason: string): Promise<void>;
  reschedule(partnerRef: string, slot: Slot): Promise<void>;
  status(partnerRef: string): Promise<PartnerStatus>;
  report(partnerRef: string): Promise<PartnerReport>;
  verifyWebhook(req: InboundRequest): boolean;
  /** Only identifies the order; the worker then calls status()/report() (design doc §4.3). */
  parseWebhook(body: unknown): WebhookInfo;
}

export type PartnerErrorCode =
  | 'not_serviceable' | 'slot_unavailable' | 'invalid_request' | 'not_found' | 'not_allowed' | 'timeout' | 'unavailable';

/** Errors adapters throw, in our vocabulary. `retryable` errors may have succeeded on the partner's side. */
export class PartnerError extends Error {
  readonly code: PartnerErrorCode;
  readonly retryable: boolean;

  constructor(code: PartnerErrorCode, message: string) {
    super(message);
    this.name = 'PartnerError';
    this.code = code;
    this.retryable = code === 'timeout' || code === 'unavailable';
  }
}

/** A configured partner: its adapter and its webhook endpoint settings. */
export interface PartnerConfig {
  adapter: LabPartner;
  /** Data region the partner serves. Its orders and webhooks live in that region's cell; only accounts held there can book. */
  region: DataRegion;
  /** The secret path segment in /hooks/:partner/:hookSecret. Rotatable; compared in constant time. */
  hookSecret: string;
  /** If set, webhooks are accepted only from these addresses. */
  allowIps?: readonly string[];
}

export type PartnerRegistry = ReadonlyMap<PartnerId, PartnerConfig>;
