// Storage interfaces for orders and the webhook inbox (design doc §10). store/memory.ts implements them for
// development and tests; a Postgres implementation follows the same contracts (apply() runs in one transaction).
import type { OrderStatus, PartnerId } from '../../../shared/lab-bundle.ts';

/** The order fields the status pipeline needs. Patient details, items and payment are added with the booking service. */
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
  createdAt: number;
  updatedAt: number;
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

export interface OrderStore {
  insert(order: OrderRecord): Promise<void>;
  get(id: string): Promise<OrderRecord | null>;
  findByPartnerRef(partner: PartnerId, partnerRef: string): Promise<OrderRecord | null>;
  /**
   * Read-modify-write one order atomically with its events. `change` must not do I/O; it gets a copy.
   * Returns the order as stored afterwards, or null if there is no such order.
   */
  apply(id: string, change: (current: OrderRecord) => OrderChange): Promise<OrderRecord | null>;
  events(orderId: string): Promise<OrderEvent[]>;
  /** Unfinished orders with a partner reference in one of `statuses`, last synced at or before `syncedBefore[status]`. */
  dueForPoll(syncedBefore: Partial<Record<OrderStatus, number>>, limit: number): Promise<OrderRecord[]>;
}

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
