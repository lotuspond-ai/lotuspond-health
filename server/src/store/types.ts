// Storage interfaces (design doc §10). store/memory.ts implements them for development and tests; a Postgres
// implementation follows the same contracts (apply() runs in one transaction, uniqueness rules become indexes).
import type { OrderStatus, PartnerId } from '../../../shared/lab-bundle.ts';

/* ---------------- orders ---------------- */

export interface OrderItem {
  code: string;
  name: string;
  pricePaise: number;
}

export interface OrderRecord {
  id: string;
  userId: string;
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
  /** The device whose key results are encrypted to. */
  deviceId: string | null;
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
export function newOrderRecord(fields: Pick<OrderRecord, 'id' | 'userId' | 'partner' | 'status' | 'createdAt'> & Partial<OrderRecord>): OrderRecord {
  return {
    partnerRef: null, partnerStatus: null, partnerStatusAt: null, lastSyncedAt: null,
    items: [], slotStart: null, slotEnd: null, pricePaise: 0, payer: 'partner',
    contactCt: null, piiPurgedAt: null, deviceId: null, idempotencyKey: null, requestHash: null,
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
  /** Newest first. */
  listByUser(userId: string, limit: number): Promise<OrderRecord[]>;
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

/* ---------------- accounts ---------------- */

export interface UserRecord {
  id: string;
  /** E.164. */
  phone: string;
  createdAt: number;
  deletedAt: number | null;
}

export interface OtpChallenge {
  phone: string;
  /** HMAC of the code; the code itself is never stored. */
  codeHash: string;
  createdAt: number;
  expiresAt: number;
  attempts: number;
  consumedAt: number | null;
}

export interface SessionRecord {
  /** SHA-256 of the bearer token; the token itself is never stored. */
  tokenHash: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number;
  revokedAt: number | null;
}

export interface DeviceRecord {
  id: string;
  userId: string;
  /** Public P-256 key as a JWK (kty, crv, x, y only). */
  publicKey: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  /** RFC 7638 thumbprint; unique per user. */
  thumbprint: string;
  createdAt: number;
  revokedAt: number | null;
}

export interface ConsentRecord {
  id: string;
  userId: string;
  orderId: string;
  partner: PartnerId;
  purpose: 'home_collection_booking';
  noticeVersion: string;
  acceptedAt: number;
  withdrawnAt: number | null;
}

export interface AccountStore {
  findUserByPhone(phone: string): Promise<UserRecord | null>;
  getUser(id: string): Promise<UserRecord | null>;
  /** Returns the existing user if the phone number is already registered. */
  createUser(user: UserRecord): Promise<UserRecord>;

  /** Replaces any earlier challenge for the phone number and records the send (for rate limits). */
  putOtp(challenge: OtpChallenge): Promise<void>;
  getOtp(phone: string): Promise<OtpChallenge | null>;
  updateOtp(phone: string, change: (c: OtpChallenge) => OtpChallenge): Promise<OtpChallenge | null>;
  /** OTPs sent to this number since `since`. */
  otpSendsSince(phone: string, since: number): Promise<number[]>;

  createSession(s: SessionRecord): Promise<void>;
  getSession(tokenHash: string): Promise<SessionRecord | null>;
  updateSession(tokenHash: string, change: (s: SessionRecord) => SessionRecord): Promise<void>;

  findDevice(userId: string, thumbprint: string): Promise<DeviceRecord | null>;
  getDevice(id: string): Promise<DeviceRecord | null>;
  createDevice(d: DeviceRecord): Promise<DeviceRecord>;

  addConsent(c: ConsentRecord): Promise<void>;
  consents(userId: string): Promise<ConsentRecord[]>;
}
