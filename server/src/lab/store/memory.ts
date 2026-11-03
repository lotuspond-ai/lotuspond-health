// In-memory stores for domain tests (the server uses store/drizzle.ts). Single-threaded JS makes apply() atomic as long as the
// callback does no I/O, which the OrderStore contract already requires. Records are copied in and out
// (structuredClone) so callers can't change stored state by mutating what they were given.
import type { OrderStatus, PartnerId } from '../../../../shared/lab-bundle.ts';
import { isFinal } from '../orders/state.ts';
import { DuplicateIdempotencyKey, type InboxItem, type OrderChange, type OrderEvent, type OrderRecord, type OrderStore, type WebhookInbox } from './types.ts';

const copy = structuredClone;

export class MemoryOrderStore implements OrderStore {
  private readonly orders = new Map<string, OrderRecord>();
  private readonly log: OrderEvent[] = [];
  private eventSeq = 0;

  async insert(order: OrderRecord): Promise<void> {
    if (this.orders.has(order.id)) throw new Error(`Order ${order.id} already exists`);
    if (order.idempotencyKey) {
      const existing = await this.findByIdempotencyKey(order.userId, order.idempotencyKey);
      if (existing) throw new DuplicateIdempotencyKey(existing.id);
    }
    this.orders.set(order.id, copy(order));
  }

  async get(id: string): Promise<OrderRecord | null> {
    const o = this.orders.get(id);
    return o ? copy(o) : null;
  }

  async findByPartnerRef(partner: PartnerId, partnerRef: string): Promise<OrderRecord | null> {
    for (const o of this.orders.values()) if (o.partner === partner && o.partnerRef === partnerRef) return copy(o);
    return null;
  }

  async findByIdempotencyKey(userId: string, key: string): Promise<OrderRecord | null> {
    for (const o of this.orders.values()) if (o.userId === userId && o.idempotencyKey === key) return copy(o);
    return null;
  }

  async listByProfile(profileId: string, limit: number): Promise<OrderRecord[]> {
    return [...this.orders.values()]
      .filter(o => o.profileId === profileId)
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
      .slice(0, limit)
      .map(x => copy(x));
  }

  async apply(id: string, change: (current: OrderRecord) => OrderChange): Promise<OrderRecord | null> {
    const cur = this.orders.get(id);
    if (!cur) return null;
    const res = change(copy(cur));
    if (res) {
      if (res.next.id !== id) throw new Error('apply() may not change the order id');
      if (res.next.partnerRef && res.next.partnerRef !== cur.partnerRef) {
        const clash = [...this.orders.values()].find(o => o.id !== id && o.partner === res.next.partner && o.partnerRef === res.next.partnerRef);
        if (clash) throw new Error(`Partner reference ${res.next.partnerRef} already belongs to order ${clash.id}`);
      }
      this.orders.set(id, copy(res.next));
      for (const e of res.events) this.log.push({ ...e, id: ++this.eventSeq });
    }
    return copy(this.orders.get(id)!);
  }

  async events(orderId: string): Promise<OrderEvent[]> {
    return this.log.filter(e => e.orderId === orderId).map(e => ({ ...e }));
  }

  async dueForPoll(syncedBefore: Partial<Record<OrderStatus, number>>, limit: number): Promise<OrderRecord[]> {
    const out: OrderRecord[] = [];
    for (const o of this.orders.values()) {
      const cutoff = syncedBefore[o.status];
      if (cutoff == null || !o.partnerRef || isFinal(o.status)) continue;
      if ((o.lastSyncedAt ?? 0) <= cutoff) out.push(copy(o));
    }
    return out.sort((a, b) => (a.lastSyncedAt ?? 0) - (b.lastSyncedAt ?? 0)).slice(0, limit);
  }

  async dueForPlacement(now: number, limit: number): Promise<OrderRecord[]> {
    return [...this.orders.values()]
      .filter(o => o.status === 'placing' && o.nextPlacementAt != null && o.nextPlacementAt <= now)
      .sort((a, b) => (a.nextPlacementAt ?? 0) - (b.nextPlacementAt ?? 0))
      .slice(0, limit)
      .map(x => copy(x));
  }
}

export class MemoryWebhookInbox implements WebhookInbox {
  private readonly items: InboxItem[] = [];
  private seq = 0;

  async add(item: Pick<InboxItem, 'partner' | 'dedupeKey' | 'headers' | 'body' | 'receivedAt'>): Promise<{ id: number; duplicate: boolean }> {
    const existing = this.items.find(i => i.partner === item.partner && i.dedupeKey === item.dedupeKey);
    if (existing) return { id: existing.id, duplicate: true };
    const id = ++this.seq;
    this.items.push({
      ...copy(item), id, attempts: 0, nextAttemptAt: item.receivedAt, processedAt: null, error: null, deadAt: null,
    });
    return { id, duplicate: false };
  }

  async due(now: number, limit: number): Promise<InboxItem[]> {
    return this.items
      .filter(i => i.processedAt == null && i.deadAt == null && i.nextAttemptAt <= now)
      .sort((a, b) => a.receivedAt - b.receivedAt || a.id - b.id)
      .slice(0, limit)
      .map(x => copy(x));
  }

  async markProcessed(id: number, at: number): Promise<void> {
    const i = this.find(id);
    i.processedAt = at;
    i.error = null;
  }

  async markFailed(id: number, error: string, retryAt: number | null, at: number): Promise<void> {
    const i = this.find(id);
    i.attempts++;
    i.error = error;
    if (retryAt == null) i.deadAt = at;
    else i.nextAttemptAt = retryAt;
  }

  async purge(before: number): Promise<number> {
    let n = 0;
    for (let k = this.items.length - 1; k >= 0; k--) {
      const i = this.items[k];
      if (i.receivedAt < before && (i.processedAt != null || i.deadAt != null)) {
        this.items.splice(k, 1);
        n++;
      }
    }
    return n;
  }

  /** For tests and the dev server. */
  all(): InboxItem[] {
    return this.items.map(x => copy(x));
  }

  private find(id: number): InboxItem {
    const i = this.items.find(x => x.id === id);
    if (!i) throw new Error(`No inbox item ${id}`);
    return i;
  }
}
