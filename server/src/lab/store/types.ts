// Storage contracts for lab orders and the partner webhook inbox (design doc §10). store/drizzle.ts implements them on
// the cell databases; store/memory.ts implements them in memory for fast domain tests. Both pass the same contract
// tests (test/lab-store.test.ts). Accounts, sessions and profiles are main's (db/schema.ts).
import type { OrderStatus, PartnerId } from '../../../../shared/lab-bundle.ts';

/* ---------------- orders ---------------- */

export interface OrderItem {
  code: string;
  name: string;
  pricePaise: number;
}

export interface OrderRecord {
  id: string;
  userId: string;
  /** The family profile the test is for; results are saved to it. */
  profileId: string;
  partner: PartnerId;
  /** Null until the partner has accepted the booking. */
  partnerRef: string | null;
  status: OrderStatus;
  /** The partner's own last status name and when it says that status began (ms); guards against out-of-date reads. */
  partnerStatus: string | null;
  partnerStatusAt: number | null;
  /** Last time we asked the partner about this order; drives reconciliation polling. */
  lastSyncedAt: number | null;
  items: OrderItem[];
  slotStart: number | null;
  slotEnd: number | null;
  pricePaise: number;
  /** Who takes the money. Only 'partner' (pay at collection) until payments are decided (design doc §16). */
  payer: 'partner' | 'lotuspond';
  /** Patient, phone and address, sealed. Wiped (null) when personal details are purged (design doc §11). */
  contactCt: Uint8Array | null;
  piiPurgedAt: number | null;
  /** The booking notice the user accepted (shared/lab-bundle.ts LAB_BOOKING_NOTICE_VERSION) and when. */
  consentVersion: string | null;
  consentedAt: number | null;
  /** Unique per user: a repeat of the same booking request returns this order. */
  idempotencyKey: string | null;
  /** Hash of the booking request, so a reused key with a different request is refused. */
  requestHash: string | null;
  /** Retries of a booking whose partner reply was lost (status placing). */
  placementAttempts: number;
  nextPlacementAt: number | null;
  /** Why the order failed, in our error vocabulary (e.g. slot_unavailable). */
  failureReason: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A record with defaults for everything not given; for the booking service, tests and the dev server. */
export function newOrderRecord(fields: Pick<OrderRecord, 'id' | 'userId' | 'profileId' | 'partner' | 'status' | 'createdAt'> & Partial<OrderRecord>): OrderRecord {
  return {
    partnerRef: null, partnerStatus: null, partnerStatusAt: null, lastSyncedAt: null,
    items: [], slotStart: null, slotEnd: null, pricePaise: 0, payer: 'partner',
    contactCt: null, piiPurgedAt: null, consentVersion: null, consentedAt: null, idempotencyKey: null, requestHash: null,
    placementAttempts: 0, nextPlacementAt: null, failureReason: null, updatedAt: fields.createdAt,
    ...fields,
  };
}

export type EventSource = 'webhook' | 'poll' | 'api' | 'user' | 'system';

export interface OrderEvent {
  id: number;
  orderId: string;
  /** Our status after the event (unchanged when only the partner's status changed, e.g. an amended report). */
  status: OrderStatus;
  partnerStatus: string | null;
  source: EventSource;
  /** When it happened, by the partner's clock where it gave one. */
  occurredAt: number | null;
  receivedAt: number;
  note?: string;
}

export type NewOrderEvent = Omit<OrderEvent, 'id'>;

/** What an apply() callback returns: the new record and the events to write with it, or null to change nothing. */
export type OrderChange = { next: OrderRecord; events: NewOrderEvent[] } | null;

/** Thrown by insert() when the user already has an order with this idempotency key. */
export class DuplicateIdempotencyKey extends Error {
  readonly existingId: string;

  constructor(existingId: string) {
    super('An order already exists for this idempotency key');
    this.name = 'DuplicateIdempotencyKey';
    this.existingId = existingId;
  }
}

export interface OrderStore {
  /** Throws DuplicateIdempotencyKey if (userId, idempotencyKey) is taken. */
  insert(order: OrderRecord): Promise<void>;
  get(id: string): Promise<OrderRecord | null>;
  findByPartnerRef(partner: PartnerId, partnerRef: string): Promise<OrderRecord | null>;
  findByIdempotencyKey(userId: string, key: string): Promise<OrderRecord | null>;
  /** A profile's orders, newest first. */
  listByProfile(profileId: string, limit: number): Promise<OrderRecord[]>;
  /**
   * Read-modify-write one order atomically with its events. `change` must not do I/O; it gets a copy.
   * Returns the order as stored afterwards, or null if there is no such order.
   */
  apply(id: string, change: (current: OrderRecord) => OrderChange): Promise<OrderRecord | null>;
  events(orderId: string): Promise<OrderEvent[]>;
  /** Unfinished orders with a partner reference in one of `statuses`, last synced at or before `syncedBefore[status]`. */
  dueForPoll(syncedBefore: Partial<Record<OrderStatus, number>>, limit: number): Promise<OrderRecord[]>;
  /** Orders still placing whose next placement retry is due. */
  dueForPlacement(now: number, limit: number): Promise<OrderRecord[]>;
}

/* ---------------- webhook inbox ---------------- */

export interface InboxItem {
  id: number;
  partner: PartnerId;
  /** Partner's event id, or a hash of the body. Unique per partner. */
  dedupeKey: string;
  /** Request headers minus credentials, kept for audit. */
  headers: Record<string, string>;
  /** The raw body, sealed (encrypted) because it may contain results. */
  body: Uint8Array;
  receivedAt: number;
  attempts: number;
  nextAttemptAt: number;
  processedAt: number | null;
  /** Set when processing failed; with deadAt set, it will not be retried. */
  error: string | null;
  deadAt: number | null;
}

export interface WebhookInbox {
  /** Store a request once. A repeat of the same (partner, dedupeKey) is reported as a duplicate and not stored again. */
  add(item: Pick<InboxItem, 'partner' | 'dedupeKey' | 'headers' | 'body' | 'receivedAt'>): Promise<{ id: number; duplicate: boolean }>;
  /** Unprocessed, live items whose next attempt is due, oldest first. */
  due(now: number, limit: number): Promise<InboxItem[]>;
  markProcessed(id: number, at: number): Promise<void>;
  /** Record a failed attempt; `retryAt` null means give up (dead letter). */
  markFailed(id: number, error: string, retryAt: number | null, at: number): Promise<void>;
  /** Delete processed and dead items received before `before` (raw bodies are kept 7 days, design doc §11). */
  purge(before: number): Promise<number>;
}
