// Lab order and webhook inbox storage on a cell database (db/schema.ts lab_* tables). Same contracts as the
// in-memory stores (store/types.ts); test/lab-store.test.ts runs both against the same expectations.
import { and, asc, desc, eq, isNotNull, isNull, lt, lte, notInArray, or, sql } from 'drizzle-orm';
import type { OrderStatus, PartnerId } from '../../../../shared/lab-bundle.ts';
import type { Db } from '../../db/client.ts';
import { labOrderEvents, labOrders, labWebhookInbox, type LabOrderEventRow, type LabOrderRow, type LabWebhookInboxRow } from '../../db/schema.ts';
import { FINAL_STATUSES } from '../orders/state.ts';
import { DuplicateIdempotencyKey, type InboxItem, type OrderChange, type OrderEvent, type OrderRecord, type OrderStore, type WebhookInbox } from './types.ts';

const ms = (d: Date | null): number | null => (d ? d.getTime() : null);
const date = (n: number | null): Date | null => (n == null ? null : new Date(n));
const toBytes = (b64: string | null): Uint8Array | null => (b64 == null ? null : new Uint8Array(Buffer.from(b64, 'base64')));
const toB64 = (b: Uint8Array | null): string | null => (b == null ? null : Buffer.from(b).toString('base64'));
const isUniqueViolation = (e: unknown) => {
  const err = e as { code?: string; cause?: { code?: string } } | null;
  return err?.code === '23505' || err?.cause?.code === '23505';
};

function toRecord(r: LabOrderRow): OrderRecord {
  return {
    id: r.id, userId: r.userId, profileId: r.profileId, partner: r.partner as PartnerId, partnerRef: r.partnerRef, status: r.status,
    partnerStatus: r.partnerStatus, partnerStatusAt: ms(r.partnerStatusAt), lastSyncedAt: ms(r.lastSyncedAt),
    items: r.items, slotStart: ms(r.slotStart), slotEnd: ms(r.slotEnd), pricePaise: r.pricePaise, payer: r.payer,
    contactCt: toBytes(r.contactCt), piiPurgedAt: ms(r.piiPurgedAt), consentVersion: r.consentVersion, consentedAt: ms(r.consentedAt),
    idempotencyKey: r.idempotencyKey, requestHash: r.requestHash, placementAttempts: r.placementAttempts,
    nextPlacementAt: ms(r.nextPlacementAt), failureReason: r.failureReason, createdAt: r.createdAt.getTime(), updatedAt: r.updatedAt.getTime(),
  };
}

function toRow(o: OrderRecord): typeof labOrders.$inferInsert {
  return {
    id: o.id, userId: o.userId, profileId: o.profileId, partner: o.partner, partnerRef: o.partnerRef, status: o.status,
    partnerStatus: o.partnerStatus, partnerStatusAt: date(o.partnerStatusAt), lastSyncedAt: date(o.lastSyncedAt),
    items: o.items, slotStart: date(o.slotStart), slotEnd: date(o.slotEnd), pricePaise: o.pricePaise, payer: o.payer,
    contactCt: toB64(o.contactCt), piiPurgedAt: date(o.piiPurgedAt), consentVersion: o.consentVersion, consentedAt: date(o.consentedAt),
    idempotencyKey: o.idempotencyKey, requestHash: o.requestHash, placementAttempts: o.placementAttempts,
    nextPlacementAt: date(o.nextPlacementAt), failureReason: o.failureReason, createdAt: new Date(o.createdAt), updatedAt: new Date(o.updatedAt),
  };
}

const toEvent = (e: LabOrderEventRow): OrderEvent => ({
  id: e.id, orderId: e.orderId, status: e.status, partnerStatus: e.partnerStatus, source: e.source,
  occurredAt: ms(e.occurredAt), receivedAt: e.receivedAt.getTime(), ...(e.note != null ? { note: e.note } : {}),
});

export class DrizzleOrderStore implements OrderStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async insert(order: OrderRecord): Promise<void> {
    try {
      await this.db.insert(labOrders).values(toRow(order));
    } catch (e) {
      if (isUniqueViolation(e) && order.idempotencyKey) {
        const existing = await this.findByIdempotencyKey(order.userId, order.idempotencyKey);
        if (existing) throw new DuplicateIdempotencyKey(existing.id);
      }
      throw e;
    }
  }

  async get(id: string): Promise<OrderRecord | null> {
    const [r] = await this.db.select().from(labOrders).where(eq(labOrders.id, id)).limit(1);
    return r ? toRecord(r) : null;
  }

  async findByPartnerRef(partner: PartnerId, partnerRef: string): Promise<OrderRecord | null> {
    const [r] = await this.db.select().from(labOrders).where(and(eq(labOrders.partner, partner), eq(labOrders.partnerRef, partnerRef))).limit(1);
    return r ? toRecord(r) : null;
  }

  async findByIdempotencyKey(userId: string, key: string): Promise<OrderRecord | null> {
    const [r] = await this.db.select().from(labOrders).where(and(eq(labOrders.userId, userId), eq(labOrders.idempotencyKey, key))).limit(1);
    return r ? toRecord(r) : null;
  }

  async listByProfile(profileId: string, limit: number): Promise<OrderRecord[]> {
    const rows = await this.db.select().from(labOrders).where(eq(labOrders.profileId, profileId))
      .orderBy(desc(labOrders.createdAt), desc(labOrders.id)).limit(limit);
    return rows.map(toRecord);
  }

  async apply(id: string, change: (current: OrderRecord) => OrderChange): Promise<OrderRecord | null> {
    return this.db.transaction(async tx => {
      // Row lock: concurrent applies to one order (webhook processor, poller, API) run one after another.
      const [row] = await tx.select().from(labOrders).where(eq(labOrders.id, id)).for('update');
      if (!row) return null;
      const res = change(toRecord(row));
      if (!res) return toRecord(row);
      if (res.next.id !== id) throw new Error('apply() may not change the order id');
      const { id: _id, ...fields } = toRow(res.next);
      const [after] = await tx.update(labOrders).set(fields).where(eq(labOrders.id, id)).returning();
      if (res.events.length) {
        await tx.insert(labOrderEvents).values(res.events.map(e => ({
          orderId: e.orderId, status: e.status, partnerStatus: e.partnerStatus, source: e.source,
          occurredAt: date(e.occurredAt), receivedAt: new Date(e.receivedAt), note: e.note ?? null,
        })));
      }
      return toRecord(after);
    });
  }

  async events(orderId: string): Promise<OrderEvent[]> {
    const rows = await this.db.select().from(labOrderEvents).where(eq(labOrderEvents.orderId, orderId)).orderBy(asc(labOrderEvents.id));
    return rows.map(toEvent);
  }

  async dueForPoll(syncedBefore: Partial<Record<OrderStatus, number>>, limit: number): Promise<OrderRecord[]> {
    const due = Object.entries(syncedBefore).filter(([s]) => !FINAL_STATUSES.has(s as OrderStatus)) as [OrderStatus, number][];
    if (!due.length) return [];
    const rows = await this.db.select().from(labOrders).where(and(
      isNotNull(labOrders.partnerRef),
      notInArray(labOrders.status, [...FINAL_STATUSES]),
      or(...due.map(([status, cutoff]) => and(
        eq(labOrders.status, status),
        or(isNull(labOrders.lastSyncedAt), lte(labOrders.lastSyncedAt, new Date(cutoff))),
      ))),
    )).orderBy(sql`${labOrders.lastSyncedAt} asc nulls first`).limit(limit);
    return rows.map(toRecord);
  }

  async dueForPlacement(now: number, limit: number): Promise<OrderRecord[]> {
    const rows = await this.db.select().from(labOrders)
      .where(and(eq(labOrders.status, 'placing'), lte(labOrders.nextPlacementAt, new Date(now))))
      .orderBy(asc(labOrders.nextPlacementAt)).limit(limit);
    return rows.map(toRecord);
  }
}

const toItem = (r: LabWebhookInboxRow): InboxItem => ({
  id: r.id, partner: r.partner as PartnerId, dedupeKey: r.dedupeKey, headers: r.headers, body: toBytes(r.body)!,
  receivedAt: r.receivedAt.getTime(), attempts: r.attempts, nextAttemptAt: r.nextAttemptAt.getTime(),
  processedAt: ms(r.processedAt), error: r.error, deadAt: ms(r.deadAt),
});

export class DrizzleWebhookInbox implements WebhookInbox {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async add(item: Pick<InboxItem, 'partner' | 'dedupeKey' | 'headers' | 'body' | 'receivedAt'>): Promise<{ id: number; duplicate: boolean }> {
    const [inserted] = await this.db.insert(labWebhookInbox).values({
      partner: item.partner, dedupeKey: item.dedupeKey, headers: item.headers, body: toB64(item.body)!,
      receivedAt: new Date(item.receivedAt), nextAttemptAt: new Date(item.receivedAt),
    }).onConflictDoNothing({ target: [labWebhookInbox.partner, labWebhookInbox.dedupeKey] }).returning({ id: labWebhookInbox.id });
    if (inserted) return { id: inserted.id, duplicate: false };
    const [existing] = await this.db.select({ id: labWebhookInbox.id }).from(labWebhookInbox)
      .where(and(eq(labWebhookInbox.partner, item.partner), eq(labWebhookInbox.dedupeKey, item.dedupeKey))).limit(1);
    return { id: existing.id, duplicate: true };
  }

  async due(now: number, limit: number): Promise<InboxItem[]> {
    const rows = await this.db.select().from(labWebhookInbox)
      .where(and(isNull(labWebhookInbox.processedAt), isNull(labWebhookInbox.deadAt), lte(labWebhookInbox.nextAttemptAt, new Date(now))))
      .orderBy(asc(labWebhookInbox.receivedAt), asc(labWebhookInbox.id)).limit(limit);
    return rows.map(toItem);
  }

  async markProcessed(id: number, at: number): Promise<void> {
    await this.db.update(labWebhookInbox).set({ processedAt: new Date(at), error: null }).where(eq(labWebhookInbox.id, id));
  }

  async markFailed(id: number, error: string, retryAt: number | null, at: number): Promise<void> {
    await this.db.update(labWebhookInbox).set({
      attempts: sql`${labWebhookInbox.attempts} + 1`, error,
      ...(retryAt == null ? { deadAt: new Date(at) } : { nextAttemptAt: new Date(retryAt) }),
    }).where(eq(labWebhookInbox.id, id));
  }

  async purge(before: number): Promise<number> {
    const gone = await this.db.delete(labWebhookInbox)
      .where(and(lt(labWebhookInbox.receivedAt, new Date(before)), or(isNotNull(labWebhookInbox.processedAt), isNotNull(labWebhookInbox.deadAt))))
      .returning({ id: labWebhookInbox.id });
    return gone.length;
  }

  /** Every item, for tests. */
  async all(): Promise<InboxItem[]> {
    const rows = await this.db.select().from(labWebhookInbox).orderBy(asc(labWebhookInbox.id));
    return rows.map(toItem);
  }
}
