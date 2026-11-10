// The interface every lab partner adapter implements (design doc §8), plus the shapes it trades in.
import type { DataRegion } from '../../../../shared/regions.ts';
import type { LabAddress, LabCatalogItem, LabPatient, LabSlot, OrderStatus, PartnerId, ResultRow } from '../../../../shared/lab-bundle.ts';

// Shapes the app sees too live in shared/lab-bundle.ts; these are the server's names for them.
export type CatalogItem = LabCatalogItem;
export type Slot = LabSlot;
export type Patient = LabPatient;
export type Address = LabAddress;

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

/** A booking at the partner: its order reference, and a per-order token if its API wants one back on later calls. */
export interface PartnerBooking {
  partnerRef: string;
  /** Orange Health returns one with each booking; status, cancel and reschedule need it. Null when unknown. */
  token?: string | null;
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
  createOrder(o: PartnerOrderInput): Promise<PartnerBooking>;
  /** Lets a retry after a timeout check whether the booking already went through. */
  findOrderByClientRef(orderId: string): Promise<PartnerBooking | null>;
  // The calls below get the booking's token (PartnerBooking.token) when the partner gave one; most adapters ignore it.
  cancel(partnerRef: string, reason: string, token?: string | null): Promise<void>;
  reschedule(partnerRef: string, slot: Slot, token?: string | null): Promise<void>;
  status(partnerRef: string, token?: string | null): Promise<PartnerStatus>;
  report(partnerRef: string, token?: string | null): Promise<PartnerReport>;
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
