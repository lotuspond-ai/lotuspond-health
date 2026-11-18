// The lab store contracts (src/lab/store/types.ts), run against both implementations: in memory (domain tests)
// and Drizzle on a migrated database (the server). TEST_DATABASE_URL uses PostgreSQL; otherwise in-memory PGlite.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDatabase, type Database } from '../src/db/client.ts';
import { profiles, users } from '../src/db/schema.ts';
import { DrizzleOrderStore, DrizzleWebhookInbox } from '../src/lab/store/drizzle.ts';
import { MemoryOrderStore, MemoryWebhookInbox } from '../src/lab/store/memory.ts';
import { DuplicateIdempotencyKey, newOrderRecord, type OrderRecord, type OrderStore, type WebhookInbox } from '../src/lab/store/types.ts';

const T0 = Date.parse('2026-11-03T07:30:00+05:30');
const migrations = fileURLToPath(new URL('../drizzle', import.meta.url));
let database: Database;
const ids = { user: randomUUID(), profile: randomUUID(), otherProfile: randomUUID() };

before(async () => {
  database = await openDatabase({ url: process.env.TEST_DATABASE_URL });
  await database.migrate(migrations);
  await database.db.insert(users).values({ id: ids.user, email: `lab-store-${ids.user}@example.com` });
  await database.db.insert(profiles).values([
    { id: ids.profile, userId: ids.user, displayName: 'Asha' },
    { id: ids.otherProfile, userId: ids.user, displayName: 'Ravi', relationship: 'partner' },
  ]);
});
after(async () => { await database?.close(); });

const order = (over: Partial<OrderRecord> = {}): OrderRecord => newOrderRecord({
  id: randomUUID(), userId: ids.user, profileId: ids.profile, partner: 'fake', status: 'booked', createdAt: T0, ...over,
});

const impls: [string, () => { orders: OrderStore; inbox: WebhookInbox }][] = [
  ['memory', () => ({ orders: new MemoryOrderStore(), inbox: new MemoryWebhookInbox() })],
  ['drizzle', () => ({ orders: new DrizzleOrderStore(database.db), inbox: new DrizzleWebhookInbox(database.db) })],
];

for (const [name, make] of impls) {
  describe(`lab order store (${name})`, () => {
    test('round-trips every field', async () => {
      const { orders } = make();
      const o = order({
        partnerRef: `FL-${randomUUID()}`, partnerStatus: 'ORDER_PLACED', partnerStatusAt: T0 + 1, lastSyncedAt: T0 + 2,
        items: [{ code: 'FL_ESSENTIAL', name: 'Essential health check', pricePaise: 99_900 }], slotStart: T0 + 86_400_000, slotEnd: T0 + 90_000_000,
        pricePaise: 99_900, contactCt: new Uint8Array([1, 2, 3, 250]), consentVersion: '2026-11-03', consentedAt: T0,
        idempotencyKey: `k-${randomUUID()}`, requestHash: 'abc', placementAttempts: 2, nextPlacementAt: T0 + 30_000, failureReason: null,
        reportVersion: '3', reportCheckedStatusAt: T0 + 1, reportAttempts: 1, nextReportAt: T0 + 60_000, updatedAt: T0 + 5,
      });
      await orders.insert(o);
      assert.deepEqual(await orders.get(o.id), o);
      assert.deepEqual(await orders.findByPartnerRef('fake', o.partnerRef!), o);
      assert.deepEqual(await orders.findByIdempotencyKey(ids.user, o.idempotencyKey!), o);
      assert.equal(await orders.get(randomUUID()), null);
    });

    test('an idempotency key is unique per user', async () => {
      const { orders } = make();
      const key = `k-${randomUUID()}`;
      const first = order({ idempotencyKey: key });
      await orders.insert(first);
      await assert.rejects(orders.insert(order({ idempotencyKey: key })), (e: unknown) => e instanceof DuplicateIdempotencyKey && e.existingId === first.id);
      await orders.insert(order({ idempotencyKey: null }));
      await orders.insert(order({ idempotencyKey: null }));
    });

    test('apply changes the record and writes its events together; a null change writes nothing', async () => {
      const { orders } = make();
      const o = order();
      await orders.insert(o);
      const after = await orders.apply(o.id, cur => ({
        next: { ...cur, status: 'collector_assigned', partnerStatus: 'PHLEBO_ASSIGNED', updatedAt: T0 + 10 },
        events: [
          { orderId: o.id, status: 'collector_assigned', partnerStatus: 'PHLEBO_ASSIGNED', source: 'webhook', occurredAt: T0 + 9, receivedAt: T0 + 10 },
          { orderId: o.id, status: 'collector_assigned', partnerStatus: null, source: 'system', occurredAt: null, receivedAt: T0 + 11, note: 'n' },
        ],
      }));
      assert.equal(after?.status, 'collector_assigned');
      assert.equal((await orders.get(o.id))?.partnerStatus, 'PHLEBO_ASSIGNED');
      const ev = await orders.events(o.id);
      assert.deepEqual(ev.map(e => [e.source, e.occurredAt, e.note]), [['webhook', T0 + 9, undefined], ['system', null, 'n']]);
      assert.ok(ev[0].id < ev[1].id);
      const same = await orders.apply(o.id, () => null);
      assert.equal(same?.status, 'collector_assigned');
      assert.equal((await orders.events(o.id)).length, 2);
      assert.equal(await orders.apply(randomUUID(), () => null), null);
    });

    test('a partner reference belongs to one order', async () => {
      const { orders } = make();
      const ref = `FL-${randomUUID()}`;
      const a = order({ partnerRef: ref }), b = order();
      await orders.insert(a);
      await orders.insert(b);
      await assert.rejects(orders.apply(b.id, cur => ({ next: { ...cur, partnerRef: ref }, events: [] })));
      assert.equal((await orders.get(b.id))?.partnerRef, null, 'nothing changed');
    });

    test('lists a profile\'s orders, newest first', async () => {
      const { orders } = make();
      const profileId = name === 'memory' ? randomUUID() : ids.otherProfile;
      const older = order({ profileId, createdAt: T0 }), newer = order({ profileId, createdAt: T0 + 1000 });
      await orders.insert(older);
      await orders.insert(newer);
      const list = await orders.listByProfile(profileId, 10);
      assert.deepEqual(list.slice(0, 2).map(o => o.id), [newer.id, older.id]);
      assert.equal((await orders.listByProfile(profileId, 1)).length, 1);
    });

    test('due for poll: by status and last sync, never finished or unplaced orders', async () => {
      const { orders } = make();
      const tag = randomUUID();
      const mk = (status: OrderRecord['status'], lastSyncedAt: number | null, partnerRef: string | null = `FL-${tag}-${status}-${lastSyncedAt}`) =>
        order({ status, lastSyncedAt, partnerRef, slotStart: T0 });
      const due1 = mk('booked', null), due2 = mk('booked', T0), notYet = mk('booked', T0 + 10_000), other = mk('processing', T0);
      const unplaced = mk('booked', null, null), done = mk('cancelled', null);
      for (const o of [due1, due2, notYet, other, unplaced, done]) await orders.insert(o);
      const got = (await orders.dueForPoll({ booked: T0 + 5000, cancelled: T0 + 5000 }, 100)).filter(o => o.partnerRef?.includes(tag));
      assert.deepEqual(got.map(o => o.id), [due1.id, due2.id], 'never-synced first');
    });

    test('due for report: a partner status newer than the last check, not waiting for a retry', async () => {
      const { orders } = make();
      const tag = randomUUID();
      const mk = (over: Partial<OrderRecord>) => order({ status: 'report_ready', partnerRef: `FL-${tag}-${randomUUID()}`, partnerStatusAt: T0 + 100, ...over });
      const never = mk({}), older = mk({ reportCheckedStatusAt: T0 + 50 }), covered = mk({ reportCheckedStatusAt: T0 + 100 });
      const waiting = mk({ nextReportAt: T0 + 60_000 }), retryDue = mk({ nextReportAt: T0 - 1 }), notReport = mk({ status: 'processing' });
      for (const o of [never, older, covered, waiting, retryDue, notReport]) await orders.insert(o);
      const got = (await orders.dueForReport(['partial_report', 'report_ready', 'delivered'], T0, 100)).filter(o => o.partnerRef?.includes(tag)).map(o => o.id);
      assert.deepEqual(new Set(got), new Set([never.id, older.id, retryDue.id]));
    });

    test('due for placement: placing orders whose retry time has come', async () => {
      const { orders } = make();
      const due = order({ status: 'placing', nextPlacementAt: T0 - 1 }), later = order({ status: 'placing', nextPlacementAt: T0 + 60_000 });
      const notScheduled = order({ status: 'placing' }), booked = order({ status: 'booked', nextPlacementAt: T0 - 1 });
      for (const o of [due, later, notScheduled, booked]) await orders.insert(o);
      const got = (await orders.dueForPlacement(T0, 100)).map(o => o.id);
      assert.ok(got.includes(due.id));
      for (const o of [later, notScheduled, booked]) assert.ok(!got.includes(o.id));
    });
  });

  describe(`lab webhook inbox (${name})`, () => {
    test('stores once per partner and key, then retries, processes, dead-letters and purges', async () => {
      const { inbox } = make();
      const key = `evt-${randomUUID()}`;
      const body = new Uint8Array([9, 8, 7]);
      const a = await inbox.add({ partner: 'fake', dedupeKey: key, headers: { 'x-a': '1' }, body, receivedAt: T0 });
      assert.equal(a.duplicate, false);
      assert.deepEqual(await inbox.add({ partner: 'fake', dedupeKey: key, headers: {}, body, receivedAt: T0 + 1 }), { id: a.id, duplicate: true });
      const b = await inbox.add({ partner: 'fake', dedupeKey: `${key}-b`, headers: {}, body, receivedAt: T0 + 2 });

      let due = (await inbox.due(T0 + 5, 100)).filter(i => i.dedupeKey.startsWith(key));
      assert.deepEqual(due.map(i => i.id), [a.id, b.id]);
      assert.deepEqual(due[0].body, body);
      assert.deepEqual(due[0].headers, { 'x-a': '1' });

      await inbox.markFailed(a.id, 'unknown_order', T0 + 1000, T0 + 5);
      due = (await inbox.due(T0 + 5, 100)).filter(i => i.dedupeKey.startsWith(key));
      assert.deepEqual(due.map(i => i.id), [b.id], 'a waits for its retry');
      due = (await inbox.due(T0 + 1000, 100)).filter(i => i.dedupeKey.startsWith(key));
      assert.equal(due.find(i => i.id === a.id)?.attempts, 1);
      assert.equal(due.find(i => i.id === a.id)?.error, 'unknown_order');

      await inbox.markFailed(a.id, 'unknown_order', null, T0 + 2000);
      await inbox.markProcessed(b.id, T0 + 2000);
      assert.equal((await inbox.due(T0 + 99_999, 100)).filter(i => i.dedupeKey.startsWith(key)).length, 0);

      const pending = await inbox.add({ partner: 'fake', dedupeKey: `${key}-c`, headers: {}, body, receivedAt: T0 + 3 });
      assert.ok(await inbox.purge(T0 + 10) >= 2);
      const left = (await inbox.due(T0 + 99_999, 100)).filter(i => i.dedupeKey.startsWith(key));
      assert.deepEqual(left.map(i => i.id), [pending.id], 'pending items are kept');
    });
  });
}
