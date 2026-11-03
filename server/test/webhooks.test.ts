// Webhook receiver, inbox processor and poller, end to end against the simulated lab.
// The lab posts its signed webhooks into the real Hono app (app.request, no network). Run: npm run test:server
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import type { Hono } from 'hono';
import type { OrderStatus } from '../../shared/lab-bundle.ts';
import { BookingService } from '../src/booking/service.ts';
import { parseBookingInput } from '../src/booking/validate.ts';
import { aesGcmSealer } from '../src/crypto/sealer.ts';
import { createApp } from '../src/http/app.ts';
import { memoryLogger } from '../src/log.ts';
import { reconcile } from '../src/orders/reconcile.ts';
import type { OrderHooks } from '../src/orders/sync.ts';
import { FakeLab, FAKE_SIGNATURE_HEADER, type FakeTag } from '../src/partners/fake-lab.ts';
import { FakeLabAdapter } from '../src/partners/fake.ts';
import { PartnerError, type LabPartner, type PartnerConfig, type PartnerRegistry } from '../src/partners/types.ts';
import { MemoryAccountStore, MemoryOrderStore, MemoryWebhookInbox } from '../src/store/memory.ts';
import { newOrderRecord } from '../src/store/types.ts';
import { WebhookProcessor } from '../src/webhooks/processor.ts';
import { bookingBody, NOTICE_VERSION } from './helpers.ts';

const T0 = Date.parse('2026-11-03T07:30:00+05:30');
const HOOK = 'hook-path-secret-1';
const LAB_SECRET = 'lab-signing-secret';
const HOUR = 3600_000;

interface SetupOptions { tags?: FakeTag[]; maxAttempts?: number; statusFailures?: number; allowIps?: string[] }

function setup(opts: SetupOptions = {}) {
  let t = T0;
  const now = () => t;
  const log = memoryLogger();
  const orders = new MemoryOrderStore();
  const inbox = new MemoryWebhookInbox();
  const sealer = aesGcmSealer(randomBytes(32));
  const responses: number[] = [];
  let app!: Hono;

  const lab = new FakeLab({
    now, stepMs: 1000, webhookSecret: LAB_SECRET, defaultTags: opts.tags,
    onWebhook: async req => {
      const res = await app.request(`/hooks/fake/${HOOK}`, { method: 'POST', headers: { ...req.headers, 'x-test-ip': '10.0.0.1' }, body: req.rawBody });
      responses.push(res.status);
      if (!res.ok) throw new Error(`receiver replied ${res.status}`);
    },
  });
  const real = new FakeLabAdapter({ lab, webhookSecret: LAB_SECRET, now });
  // Optionally make status() fail a few times, as a partner outage would.
  let failures = opts.statusFailures ?? 0;
  const adapter: LabPartner = Object.create(real, {
    status: { value: async (ref: string) => { if (failures-- > 0) throw new PartnerError('unavailable', 'partner down'); return real.status(ref); } },
  });
  const cfg: PartnerConfig = { adapter, hookSecret: HOOK, ...(opts.allowIps ? { allowIps: opts.allowIps } : {}) };
  const partners: PartnerRegistry = new Map([['fake', cfg]]);

  const transitions: string[] = [];
  const reportUpdates: { status: OrderStatus; partnerStatus: string | null }[] = [];
  const hooks: OrderHooks = {
    onTransition: (o, from) => { transitions.push(`${from}>${o.status}`); },
    onReportUpdate: o => { reportUpdates.push({ status: o.status, partnerStatus: o.partnerStatus }); },
  };
  const deps = { orders, partners, now, log, hooks };
  const processor = new WebhookProcessor({ ...deps, inbox, sealer }, { maxAttempts: opts.maxAttempts ?? 10, baseDelayMs: 1000, maxDelayMs: 8000 });
  app = createApp({ receiver: { partners, inbox, sealer, now, log, clientIp: c => c.req.header('x-test-ip') ?? '' }, log });
  const accounts = new MemoryAccountStore();
  const booking = new BookingService({ ...deps, accounts, sealer: aesGcmSealer(randomBytes(32)) }, { noticeVersion: NOTICE_VERSION });

  /** Move the clock, let the lab act and deliver, then process the inbox. */
  const step = async (ms = 1000) => { t += ms; await lab.tick(); await processor.runOnce(); };
  const setClock = (ms: number) => { t = ms; };
  return { app, lab, adapter, orders, accounts, booking, inbox, sealer, log, responses, transitions, reportUpdates, deps, processor, step, now, setClock };
}
type Env = ReturnType<typeof setup>;

let keySeq = 0;

/** Book through the booking service, as POST /v1/orders does (a lost reply leaves the order placing). */
async function book(env: Env, { name = 'Asha Rao' }: { name?: string } = {}): Promise<string> {
  await env.accounts.createUser({ id: 'usr_1', phone: '+919812345678', createdAt: env.now(), deletedAt: null });
  const slot = (await env.adapter.slots({ pincode: '560034', date: '2026-11-04', items: ['FL_ESSENTIAL'] }))[0];
  const parsed = parseBookingInput(bookingBody(slot, { patient: { name, age: 34, sex: 'female' } }));
  assert.ok(parsed.ok);
  const { order } = await env.booking.createOrder('usr_1', parsed.value, `test-key-${++keySeq}`);
  return order.id;
}

async function statusOf(env: Env, id: string): Promise<OrderStatus | undefined> {
  return (await env.orders.get(id))?.status;
}

/** Sign a body the way the simulated lab does, for hand-made requests. */
function signed(body: string, t = Math.floor(T0 / 1000), secret = LAB_SECRET): Record<string, string> {
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return { 'content-type': 'application/json', [FAKE_SIGNATURE_HEADER]: `t=${t},v1=${v1}`, 'x-test-ip': '10.0.0.1' };
}

const RANK: OrderStatus[] = ['placing', 'booked', 'collector_assigned', 'sample_collected', 'processing', 'partial_report', 'report_ready'];

describe('webhooks drive orders', () => {
  test('a normal order: each webhook moves it on, through to report_ready', async () => {
    const env = setup();
    const id = await book(env);
    for (let i = 0; i < 6; i++) await env.step();
    assert.equal(await statusOf(env, id), 'report_ready');
    assert.deepEqual(env.transitions, [
      'created>placing', 'placing>booked',
      'booked>collector_assigned', 'collector_assigned>sample_collected', 'sample_collected>processing', 'processing>report_ready',
    ]);
    assert.deepEqual(env.reportUpdates, [{ status: 'report_ready', partnerStatus: 'REPORT_READY' }]);
    assert.ok(env.responses.every(s => s === 200));

    const events = await env.orders.events(id);
    // The first tick delivers ORDER_PLACED and PHLEBO_ASSIGNED together. Processing the first one asks the
    // lab for the current status (already PHLEBO_ASSIGNED), so the second is a duplicate: no ORDER_PLACED event.
    assert.deepEqual(events.map(e => `${e.source}:${e.status}:${e.partnerStatus ?? ''}`), [
      'api:created:', 'api:placing:', 'api:booked:', 'webhook:collector_assigned:PHLEBO_ASSIGNED',
      'webhook:sample_collected:SAMPLE_COLLECTED', 'webhook:processing:IN_LAB', 'webhook:report_ready:REPORT_READY',
    ]);
    const items = env.inbox.all();
    assert.equal(items.length, 5);
    assert.ok(items.every(i => i.processedAt != null && i.deadAt == null));
    assert.deepEqual(env.log.alerts(), []);
  });

  test('duplicate and out-of-order webhooks never move an order backwards', async () => {
    const env = setup({ tags: ['duplicate-webhooks', 'out-of-order'] });
    const id = await book(env);
    for (let i = 0; i < 6; i++) await env.step();
    assert.equal(await statusOf(env, id), 'report_ready');
    assert.equal(env.responses.length, 10);
    assert.equal(env.inbox.all().length, 5, 'duplicates are stored once');
    const seq = (await env.orders.events(id)).map(e => RANK.indexOf(e.status));
    assert.deepEqual(seq, [...seq].sort((a, b) => a - b), 'event statuses never go back');
    assert.ok(env.transitions.every(tr => {
      const [from, to] = tr.split('>') as OrderStatus[];
      return RANK.indexOf(to) > RANK.indexOf(from);
    }), env.transitions.join(', '));
  });

  test('a lost booking reply: the first webhook links the order and moves it on', async () => {
    const env = setup({ tags: ['lost-response'] });
    const id = await book(env);
    const placing = await env.orders.get(id);
    assert.equal(placing?.status, 'placing');
    assert.equal(placing?.partnerRef, null);
    await env.step();
    const linked = await env.orders.get(id);
    assert.equal(linked?.partnerRef, 'FL000001');
    assert.equal(linked?.status, 'collector_assigned');
    assert.ok((await env.orders.events(id)).some(e => e.note === 'linked to partner order FL000001'));
    for (let i = 0; i < 5; i++) await env.step();
    assert.equal(await statusOf(env, id), 'report_ready');
  });

  test('a rejected sample goes through recollection_needed and a second visit', async () => {
    const env = setup({ tags: ['recollect'] });
    const id = await book(env);
    for (let i = 0; i < 8; i++) await env.step();
    assert.equal(await statusOf(env, id), 'report_ready');
    assert.ok(env.transitions.includes('sample_collected>recollection_needed'));
    assert.ok(env.transitions.includes('recollection_needed>collector_assigned'));
  });

  test('a partial report, then the rest: the report hook fires for each', async () => {
    const env = setup({ tags: ['partial'] });
    const id = await book(env);
    for (let i = 0; i < 6; i++) await env.step();
    assert.equal(await statusOf(env, id), 'report_ready');
    assert.deepEqual(env.reportUpdates.map(r => r.partnerStatus), ['PARTIAL_REPORT', 'REPORT_READY']);
  });

  test('an amended report after delivery keeps the order delivered but fires the report hook', async () => {
    const env = setup({ tags: ['amended'] });
    const id = await book(env);
    for (let i = 0; i < 4; i++) await env.step();
    assert.equal(await statusOf(env, id), 'report_ready');
    await env.orders.apply(id, cur => ({ next: { ...cur, status: 'delivered' }, events: [] }));
    await env.step();
    const o = await env.orders.get(id);
    assert.equal(o?.status, 'delivered');
    assert.equal(o?.partnerStatus, 'REPORT_AMENDED');
    assert.deepEqual(env.reportUpdates.map(r => `${r.status}:${r.partnerStatus}`), ['report_ready:REPORT_READY', 'delivered:REPORT_AMENDED']);
    assert.deepEqual(env.log.alerts(), []);
  });

  test('a cancellation reported by the lab cancels the order', async () => {
    const env = setup();
    const id = await book(env);
    await env.adapter.cancel('FL000001', 'Customer request');
    await env.step();
    assert.equal(await statusOf(env, id), 'cancelled');
    await env.step(5000);
    assert.equal(await statusOf(env, id), 'cancelled');
  });
});

describe('failures and retries', () => {
  test('a webhook for an order we never had is retried with backoff, then dead-lettered with an alert', async () => {
    const env = setup({ maxAttempts: 3 });
    const slot = (await env.adapter.slots({ pincode: '560034', date: '2026-11-04', items: [] }))[0];
    await env.adapter.createOrder({
      orderId: 'ord_ghost', items: ['FL_THYROID'], slot, patient: { name: 'Ghost Order #no-webhooks', age: 40, sex: 'male' },
      phone: '+919812345678', address: { line1: 'x', city: 'Bengaluru', pincode: '560034' },
    });
    // Hand-deliver one signed webhook for it.
    const body = JSON.stringify({ event_id: 'evt_x', type: 'order.status_changed', order_ref: 'FL000001', client_ref: 'ord_ghost', status: 'ORDER_PLACED', occurred_at: '2026-11-03T07:30:00+05:30' });
    const res = await env.app.request(`/hooks/fake/${HOOK}`, { method: 'POST', headers: signed(body), body });
    assert.equal(res.status, 200);

    await env.processor.runOnce();
    let [item] = env.inbox.all();
    assert.equal(item.attempts, 1);
    assert.equal(item.error, 'unknown_order');
    assert.equal(item.nextAttemptAt, T0 + 1000);
    await env.step(1000);
    [item] = env.inbox.all();
    assert.equal(item.attempts, 2);
    assert.equal(item.nextAttemptAt, T0 + 1000 + 2000);
    await env.step(2000);
    [item] = env.inbox.all();
    assert.equal(item.attempts, 3);
    assert.ok(item.deadAt != null);
    assert.ok(env.log.alerts().some(l => l.msg === 'webhook dead-lettered' && l.fields.reason === 'unknown_order'));
  });

  test('a partner outage while syncing is retried until it recovers', async () => {
    const env = setup({ statusFailures: 2 });
    const id = await book(env);
    await env.step();
    assert.equal(await statusOf(env, id), 'booked');
    assert.equal(env.inbox.all()[0].error, 'partner_unavailable');
    for (let i = 0; i < 8; i++) await env.step();
    assert.equal(await statusOf(env, id), 'report_ready');
    assert.ok(env.log.lines.some(l => l.msg === 'webhook will be retried'));
    assert.ok(env.inbox.all().every(i => i.deadAt == null && i.processedAt != null));
  });

  test('the receiver returns non-2xx while storage is down, and the lab retries', async () => {
    const env = setup();
    const id = await book(env);
    const add = env.inbox.add.bind(env.inbox);
    let down = 2;
    env.inbox.add = async item => { if (down-- > 0) throw new Error('db down'); return add(item); };
    await env.step();
    assert.ok(env.responses.includes(500));
    for (let i = 0; i < 7; i++) await env.step();
    assert.equal(await statusOf(env, id), 'report_ready');
    assert.equal(env.lab.pendingWebhooks(), 0);
  });
});

describe('polling', () => {
  test('without webhooks, the poller catches the order up on its schedule', async () => {
    const env = setup({ tags: ['no-webhooks'] });
    const id = await book(env);
    await env.step(2000);
    assert.equal((await reconcile(env.deps)).polled, 0, 'booked orders are polled every 3 hours');
    assert.equal(await statusOf(env, id), 'booked');

    await env.step(3 * HOUR);
    const r = await reconcile(env.deps);
    assert.deepEqual(r, { polled: 1, changed: 1, failed: 0 });
    assert.equal(await statusOf(env, id), 'report_ready', 'skips straight to the current status');
    assert.equal((await env.orders.events(id)).at(-1)?.source, 'poll');
    assert.deepEqual(env.reportUpdates.map(u => u.partnerStatus), ['REPORT_READY']);
    assert.equal((await reconcile(env.deps)).polled, 0, 'report_ready is left to the results pipeline');
    assert.equal(env.inbox.all().length, 0);
  });

  test('polling a status that hasn\'t changed records nothing new', async () => {
    const env = setup({ tags: ['no-webhooks'] });
    const id = await book(env);
    const every = { booked: 0, collector_assigned: 0 };
    await reconcile(env.deps, { every });
    const before = (await env.orders.events(id)).length;
    await reconcile(env.deps, { every });
    assert.equal((await env.orders.events(id)).length, before);
  });
});

describe('receiver', () => {
  const validBody = JSON.stringify({ event_id: 'evt_1', type: 'order.status_changed', order_ref: 'FL000001', client_ref: 'ord_1', status: 'ORDER_PLACED', occurred_at: '2026-11-03T07:30:00+05:30' });

  test('stores a signed webhook once, sealed, without credential headers, and replies 200', async () => {
    const env = setup();
    const headers = { ...signed(validBody), authorization: 'Bearer abc', cookie: 's=1' };
    for (let i = 0; i < 2; i++) {
      const res = await env.app.request(`/hooks/fake/${HOOK}`, { method: 'POST', headers, body: validBody });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { received: true });
    }
    const items = env.inbox.all();
    assert.equal(items.length, 1);
    assert.equal(items[0].dedupeKey, 'evt_1');
    assert.equal(items[0].headers.authorization, undefined);
    assert.equal(items[0].headers.cookie, undefined);
    assert.ok(items[0].headers[FAKE_SIGNATURE_HEADER]);
    assert.ok(!Buffer.from(items[0].body).toString('latin1').includes('FL000001'), 'body is encrypted at rest');
    assert.equal(Buffer.from(env.sealer.open(items[0].body)).toString('utf8'), validBody);
  });

  test('without an event id, deduplicates on a hash of the body', async () => {
    const env = setup();
    const body = JSON.stringify({ order_ref: 'FL000001', status: 'IN_LAB' });
    await env.app.request(`/hooks/fake/${HOOK}`, { method: 'POST', headers: signed(body), body });
    await env.app.request(`/hooks/fake/${HOOK}`, { method: 'POST', headers: signed(body), body });
    const items = env.inbox.all();
    assert.equal(items.length, 1);
    assert.match(items[0].dedupeKey, /^sha256:[0-9a-f]{64}$/);
  });

  test('refuses unknown partners and wrong secrets alike, bad signatures, bad bodies and oversized requests', async () => {
    const env = setup();
    const post = (path: string, headers: Record<string, string>, body: string | Uint8Array) =>
      env.app.request(path, { method: 'POST', headers, body });

    const wrongSecret = await post('/hooks/fake/not-the-secret', signed(validBody), validBody);
    const unknown = await post(`/hooks/thyrocare/${HOOK}`, signed(validBody), validBody);
    assert.equal(wrongSecret.status, 404);
    assert.equal(unknown.status, 404);
    assert.deepEqual(await wrongSecret.json(), await unknown.json());

    assert.equal((await post(`/hooks/fake/${HOOK}`, signed(validBody, undefined, 'wrong-key'), validBody)).status, 401);
    assert.equal((await post(`/hooks/fake/${HOOK}`, { 'content-type': 'application/json' }, validBody)).status, 401);
    const tampered = validBody.replace('ORDER_PLACED', 'REPORT_READY');
    assert.equal((await post(`/hooks/fake/${HOOK}`, signed(validBody), tampered)).status, 401);

    const notJson = 'order_ref=FL000001';
    assert.equal((await post(`/hooks/fake/${HOOK}`, signed(notJson), notJson)).status, 400);
    const noRef = JSON.stringify({ status: 'IN_LAB' });
    assert.equal((await post(`/hooks/fake/${HOOK}`, signed(noRef), noRef)).status, 400);

    const big = 'x'.repeat(300 * 1024);
    assert.equal((await post(`/hooks/fake/${HOOK}`, signed(big), big)).status, 413);

    assert.equal(env.inbox.all().length, 0);
    assert.ok(env.log.alerts().some(l => l.msg === 'webhook signature rejected'));
    assert.ok(!JSON.stringify(env.log.lines).includes(HOOK), 'the path secret never reaches the logs');
  });

  test('an address allowlist, when configured', async () => {
    const env = setup({ allowIps: ['10.0.0.9'] });
    const from = (ip: string) => env.app.request(`/hooks/fake/${HOOK}`, { method: 'POST', headers: { ...signed(validBody), 'x-test-ip': ip }, body: validBody });
    assert.equal((await from('10.0.0.1')).status, 403);
    assert.equal((await from('10.0.0.9')).status, 200);
  });

  test('health check and unknown routes', async () => {
    const env = setup();
    assert.equal((await env.app.request('/healthz')).status, 200);
    assert.equal((await env.app.request('/nope')).status, 404);
    assert.equal((await env.app.request(`/hooks/fake/${HOOK}`)).status, 404);
  });
});

describe('storage pieces', () => {
  test('the sealer round-trips and rejects altered data or another key', () => {
    const key = randomBytes(32);
    const s = aesGcmSealer(key);
    const plain = new Uint8Array(Buffer.from('{"order_ref":"FL000001"}'));
    const sealed = s.seal(plain);
    assert.deepEqual(s.open(sealed), plain);
    assert.notDeepEqual(s.seal(plain), sealed, 'a fresh nonce each time');
    const altered = sealed.slice();
    altered[altered.length - 1] ^= 1;
    assert.throws(() => s.open(altered));
    assert.throws(() => aesGcmSealer(randomBytes(32)).open(sealed));
    assert.throws(() => aesGcmSealer(randomBytes(16)));
  });

  test('inbox purge removes old finished items and keeps pending ones', async () => {
    const inbox = new MemoryWebhookInbox();
    const add = (k: string, at: number) => inbox.add({ partner: 'fake', dedupeKey: k, headers: {}, body: new Uint8Array([1]), receivedAt: at });
    const a = await add('a', T0), b = await add('b', T0), c = await add('c', T0), d = await add('d', T0 + 8 * 24 * HOUR);
    await inbox.markProcessed(a.id, T0);
    await inbox.markFailed(b.id, 'x', null, T0);
    await inbox.markProcessed(d.id, T0 + 8 * 24 * HOUR);
    const removed = await inbox.purge(T0 + 7 * 24 * HOUR);
    assert.equal(removed, 2);
    assert.deepEqual(inbox.all().map(i => i.dedupeKey), ['c', 'd']);
    assert.equal(c.duplicate, false);
  });

  test('two orders cannot share a partner reference', async () => {
    const orders = new MemoryOrderStore();
    const base = { userId: 'u', partner: 'fake' as const, status: 'booked' as const, createdAt: T0 };
    await orders.insert(newOrderRecord({ ...base, id: 'a', partnerRef: 'FL1' }));
    await orders.insert(newOrderRecord({ ...base, id: 'b' }));
    await assert.rejects(orders.apply('b', cur => ({ next: { ...cur, partnerRef: 'FL1' }, events: [] })));
    await assert.rejects(orders.insert(newOrderRecord({ ...base, id: 'a' })));
  });
});
