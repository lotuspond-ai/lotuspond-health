// Lab booking through the real app: main's sign-up, sessions, profiles and audit log, the lab routes, the simulated
// lab behind them and its webhooks coming back. TEST_DATABASE_URL uses PostgreSQL; otherwise in-memory PGlite.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { eq } from 'drizzle-orm';
import type { LabOrderView } from '../../shared/lab-bundle.ts';
import { openDatabase, type Database } from '../src/db/client.ts';
import { auditEvents, labOrders } from '../src/db/schema.ts';
import { PartnerError, type LabPartner } from '../src/lab/partners/types.ts';
import { istDate } from '../src/lab/time.ts';
import { makeClient } from './helpers.ts';
import { bookingBody, labEnv, NOTICE_VERSION, withOverrides } from './lab-helpers.ts';

const migrations = fileURLToPath(new URL('../drizzle', import.meta.url));
let database: Database;
let filesDir: string;

before(async () => {
  database = await openDatabase({ url: process.env.TEST_DATABASE_URL });
  await database.migrate(migrations);
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspond-lab-'));
});
after(async () => {
  await database?.close();
  fs.rmSync(filesDir, { recursive: true, force: true });
});


describe('catalogue and slots', () => {
  test('signed-in accounts in India see the catalogue in paise, cached a day; other regions see none', async () => {
    let calls = 0;
    const env = labEnv(database, filesDir, { wrap: real => withOverrides(real, { catalog: async (pin: string) => { calls++; return real.catalog(pin); } }) });
    const { c } = await env.signUp();
    const r = await c.json<{ items: { code: string; pricePaise: number; partner: string }[]; unavailable: string[] }>('GET', '/api/lab/catalog?pincode=560034');
    const essential = r.items.find(i => i.code === 'FL_ESSENTIAL');
    assert.equal(essential?.partner, 'fake');
    assert.equal(essential?.pricePaise, 99_900);
    await c.json('GET', '/api/lab/catalog?pincode=560034');
    assert.equal(calls, 1);
    assert.equal((await c.error('GET', '/api/lab/catalog?pincode=5600')).status, 400);

    const { c: eu } = await env.signUp('DE');
    assert.deepEqual((await eu.json<{ items: unknown[] }>('GET', '/api/lab/catalog?pincode=560034')).items, []);
    assert.equal((await eu.error('GET', '/api/lab/slots?partner=fake&pincode=560034&date=2026-12-01')).code, 'not_in_region');
    assert.equal((await makeClient(env.app).error('GET', '/api/lab/catalog?pincode=560034')).status, 401);
  });

  test('slots for a partner and date', async () => {
    const env = labEnv(database, filesDir, );
    const { c } = await env.signUp();
    const s = await env.slot(c);
    assert.match(s.start, /T\d{2}:00:00\+05:30$/);
    assert.equal((await c.error('GET', `/api/lab/slots?partner=nope&pincode=560034&date=${env.tomorrow()}`)).code, 'unknown_partner');
    assert.equal((await c.error('GET', '/api/lab/slots?partner=fake&pincode=560034&date=4/11/2026')).status, 400);
  });
});

describe('booking', () => {
  test('a confirmed booking: 201, stored in the cell with consent, details sealed, recorded in activity', async () => {
    const env = labEnv(database, filesDir, );
    const { c, profileId } = await env.signUp();
    const r = await env.book(c, profileId);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const o = r.body.order!;
    assert.equal(o.status, 'booked');
    assert.equal(o.profileId, profileId);
    assert.match(o.partnerRef!, /^FL[0-9A-F]{4}\d{6}$/);
    assert.deepEqual(o.items, [{ code: 'FL_ESSENTIAL', name: 'Essential health check', pricePaise: 99_900 }]);
    assert.equal(o.payer, 'partner');
    assert.equal(r.headers.get('cache-control'), 'no-store');

    const [row] = await database.db.select().from(labOrders).where(eq(labOrders.id, o.id));
    assert.equal(row.consentVersion, NOTICE_VERSION);
    assert.ok(row.consentedAt);
    assert.ok(row.contactCt && !Buffer.from(row.contactCt, 'base64').toString('latin1').includes('Asha'), 'contact details sealed at rest');
    const events = await database.db.select().from(auditEvents).where(eq(auditEvents.userId, row.userId));
    assert.ok(events.some(e => e.kind === 'lab_order_created' && e.detail?.profileId === profileId));
    assert.ok(!JSON.stringify(env.log.lines).includes('Asha') && !JSON.stringify(env.log.lines).includes('9812345678'), 'no names or numbers in logs');
  });

  test('the same Idempotency-Key and request returns the same order; a different request is refused', async () => {
    const env = labEnv(database, filesDir, );
    const { c, profileId } = await env.signUp();
    const body = bookingBody(await env.slot(c));
    const first = await env.book(c, profileId, body, 'same-key-123');
    const again = await env.book(c, profileId, body, 'same-key-123');
    assert.equal(again.status, 200);
    assert.equal(again.headers.get('idempotent-replayed'), 'true');
    assert.equal(again.body.order!.id, first.body.order!.id);
    assert.equal((await env.book(c, profileId, { ...body, items: ['FL_THYROID'] }, 'same-key-123')).body.error?.code, 'idempotency_key_reused');
    const noKey = await c.call('POST', `/api/profiles/${profileId}/lab-orders`, body);
    assert.equal(noKey.status, 400);
    assert.equal(((await noKey.json()) as { error: { code: string } }).error.code, 'idempotency_key_required');
    assert.equal((await c.json<{ orders: unknown[] }>('GET', `/api/profiles/${profileId}/lab-orders`)).orders.length, 1);
  });

  test('checks: shape, adults only, current notice, offered items, served pincode, future slot, mobile number', async () => {
    const env = labEnv(database, filesDir, );
    const { c, profileId } = await env.signUp();
    const s = await env.slot(c);
    const code = async (over: Record<string, unknown>) => (await env.book(c, profileId, bookingBody(s, over))).body.error?.code;
    assert.equal(await code({ items: [] }), 'invalid');
    assert.equal(await code({ phone: '9812345678' }), 'invalid');
    assert.equal(await code({ devicePublicKey: { kty: 'EC' } }), 'invalid', 'unknown fields are refused');
    assert.equal(await code({ patient: { name: 'Child', age: 16, sex: 'male' } }), 'adults_only');
    assert.equal(await code({ consent: { noticeVersion: '2025-01-01', accepted: true } }), 'consent_outdated');
    assert.equal(await code({ consent: { noticeVersion: NOTICE_VERSION, accepted: false } }), 'consent_required');
    assert.equal(await code({ items: ['NOT_A_PACKAGE'] }), 'unknown_item');
    assert.equal(await code({ address: { line1: 'MG Road', city: 'Kochi', pincode: '682001' } }), 'not_serviceable');
    assert.equal(await code({ slot: { start: '2020-01-01T06:00:00+05:30', end: '2020-01-01T07:00:00+05:30' } }), 'slot_in_past');
    assert.equal(await code({ partner: 'nope' }), 'unknown_partner');
    assert.equal((await c.json<{ orders: unknown[] }>('GET', `/api/profiles/${profileId}/lab-orders`)).orders.length, 0);
  });

  test('a slot taken at the lab: 409, with the order recorded as failed', async () => {
    const env = labEnv(database, filesDir, { tags: ['slot-full'] });
    const { c, profileId } = await env.signUp();
    const r = await env.book(c, profileId);
    assert.equal(r.status, 409);
    assert.equal(r.body.error?.code, 'slot_unavailable');
    assert.equal(r.body.error?.order?.status, 'failed');
  });

  test('accounts outside the lab\'s region, other people\'s profiles and cross-site requests are refused', async () => {
    const env = labEnv(database, filesDir, );
    const { c, profileId } = await env.signUp();
    const { c: other, profileId: otherProfile } = await env.signUp();
    const o = (await env.book(c, profileId)).body.order!;
    assert.equal((await other.error('GET', `/api/profiles/${profileId}/lab-orders/${o.id}`)).status, 404);
    assert.equal((await other.error('GET', `/api/profiles/${otherProfile}/lab-orders/${o.id}`)).status, 404, 'another profile\'s order looks missing');
    assert.equal((await c.error('GET', `/api/profiles/${profileId}/lab-orders/not-a-uuid`)).status, 404);
    const { c: eu, profileId: euProfile } = await env.signUp('DE');
    assert.equal((await env.book(eu, euProfile, bookingBody(await env.slot(c)))).body.error?.code, 'not_in_region');
    const crossSite = await c.call('POST', `/api/profiles/${profileId}/lab-orders`, bookingBody(await env.slot(c)), { 'idempotency-key': 'cross-site-1', 'sec-fetch-site': 'cross-site' });
    assert.equal(crossSite.status, 403);
  });

  test('a family member\'s booking is kept under their profile', async () => {
    const env = labEnv(database, filesDir, );
    const { c, profileId } = await env.signUp();
    const partner = await c.json<{ id: string }>('POST', '/api/profiles', { displayName: 'Ravi', relationship: 'partner' }, 201);
    const o = (await env.book(c, partner.id, bookingBody(await env.slot(c), { patient: { name: 'Ravi Rao', age: 38, sex: 'male' } }))).body.order!;
    assert.equal(o.profileId, partner.id);
    assert.deepEqual((await c.json<{ orders: LabOrderView[] }>('GET', `/api/profiles/${partner.id}/lab-orders`)).orders.map(x => x.id), [o.id]);
    assert.deepEqual((await c.json<{ orders: LabOrderView[] }>('GET', `/api/profiles/${profileId}/lab-orders`)).orders, []);
  });
});

describe('when the lab does not answer', () => {
  test('a lost reply: 202 placing, then the retry finds the booking at the lab', async () => {
    const env = labEnv(database, filesDir, { tags: ['lost-response', 'no-webhooks'] });
    const { c, profileId } = await env.signUp();
    const r = await env.book(c, profileId);
    assert.equal(r.status, 202);
    assert.equal(r.body.order!.status, 'placing');
    await env.advance(1000);
    const o = await env.getOrder(c, profileId, r.body.order!.id);
    assert.equal(o.status, 'booked');
    assert.deepEqual(o.timeline!.map(e => e.status), ['created', 'placing', 'booked']);
  });

  test('a slow reply after the timeout is still applied', async () => {
    const env = labEnv(database, filesDir, {
      booking: { placeTimeoutMs: 20 },
      wrap: real => withOverrides(real, { createOrder: async (input: Parameters<LabPartner['createOrder']>[0]) => { await sleep(80); return real.createOrder(input); } }),
    });
    const { c, profileId } = await env.signUp();
    const r = await env.book(c, profileId);
    assert.equal(r.status, 202);
    await sleep(200);
    assert.equal((await env.getOrder(c, profileId, r.body.order!.id)).status, 'booked');
  });

  test('if the lab never confirms, the order fails after the last retry, with an alert', async () => {
    const env = labEnv(database, filesDir, {
      booking: { placementRetryDelaysMs: [1000, 1000] },
      wrap: real => withOverrides(real, { createOrder: async () => { throw new PartnerError('timeout', 'no reply'); }, findOrderByClientRef: async () => null }),
    });
    const { c, profileId } = await env.signUp();
    const id = (await env.book(c, profileId)).body.order!.id;
    for (let i = 0; i < 3; i++) await env.advance(1000);
    const o = await env.getOrder(c, profileId, id);
    assert.equal(o.status, 'failed');
    assert.equal(o.failureReason, 'placement_gave_up');
    assert.ok(env.log.alerts().some(l => l.msg === 'booking could not be confirmed with the partner'));
  });
});

describe('managing orders', () => {
  test('cancel before collection (at the lab too, and in activity); not after', async () => {
    const env = labEnv(database, filesDir, );
    const { c, profileId } = await env.signUp();
    const o = (await env.book(c, profileId)).body.order!;
    const r = await c.json<{ order: LabOrderView }>('POST', `/api/profiles/${profileId}/lab-orders/${o.id}/cancel`, { reason: 'Travelling' });
    assert.equal(r.order.status, 'cancelled');
    assert.equal((await env.fake.adapter.status(o.partnerRef!)).partnerStatus, 'CANCELLED');
    await c.json('POST', `/api/profiles/${profileId}/lab-orders/${o.id}/cancel`, {});
    const [row] = await database.db.select().from(labOrders).where(eq(labOrders.id, o.id));
    const kinds = (await database.db.select().from(auditEvents).where(eq(auditEvents.userId, row.userId))).map(e => e.kind);
    assert.equal(kinds.filter(k => k === 'lab_order_cancelled').length, 1, 'cancelling twice records it once');

    const later = (await env.book(c, profileId, bookingBody(await env.slot(c, istDate(env.now() + 2 * 86_400_000))))).body.order!;
    await env.advance(1000);
    await env.advance(1000);
    assert.equal((await env.getOrder(c, profileId, later.id)).status, 'sample_collected');
    assert.equal((await c.error('POST', `/api/profiles/${profileId}/lab-orders/${later.id}/cancel`, {})).code, 'not_cancellable');
  });

  test('reschedule a visit; not after collection', async () => {
    const env = labEnv(database, filesDir, );
    const { c, profileId } = await env.signUp();
    const o = (await env.book(c, profileId)).body.order!;
    await env.advance(1000);
    assert.equal((await env.getOrder(c, profileId, o.id)).status, 'collector_assigned');
    const newSlot = await env.slot(c, istDate(env.now() + 3 * 86_400_000));
    const r = await c.json<{ order: LabOrderView }>('POST', `/api/profiles/${profileId}/lab-orders/${o.id}/reschedule`, { slot: newSlot });
    assert.equal(r.order.status, 'booked');
    assert.equal(r.order.slot?.start, newSlot.start);
    assert.equal((await c.error('POST', `/api/profiles/${profileId}/lab-orders/${o.id}/reschedule`, { slot: { start: 'tomorrow' } })).status, 400);
    await env.advance(1000);
    await env.advance(1000);
    assert.equal((await c.error('POST', `/api/profiles/${profileId}/lab-orders/${o.id}/reschedule`, { slot: newSlot })).code, 'not_reschedulable');
  });

  test('from booking to report, driven by the lab\'s webhooks', async () => {
    const env = labEnv(database, filesDir, );
    const { c, profileId } = await env.signUp();
    const o = (await env.book(c, profileId)).body.order!;
    for (let i = 0; i < 5; i++) await env.advance(1000);
    const r = await env.getOrder(c, profileId, o.id);
    assert.equal(r.status, 'report_ready');
    assert.deepEqual(r.timeline!.map(e => e.status), ['created', 'placing', 'booked', 'collector_assigned', 'sample_collected', 'processing', 'report_ready']);
    assert.equal(r.canCancel, false);
  });

  test('webhooks are served outside /api, and a wrong secret looks like nothing is there', async () => {
    const env = labEnv(database, filesDir, );
    const res = await env.app.request('/hooks/fake/not-the-secret', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'not_found' });
  });

  test('deleting a profile deletes its lab orders', async () => {
    const env = labEnv(database, filesDir, );
    const { c } = await env.signUp();
    const member = await c.json<{ id: string }>('POST', '/api/profiles', { displayName: 'Mum', relationship: 'parent' }, 201);
    const o = (await env.book(c, member.id, bookingBody(await env.slot(c), { patient: { name: 'Lata Rao', age: 61, sex: 'female' } }))).body.order!;
    const del = await c.call('DELETE', `/api/profiles/${member.id}`, { confirm: true });
    assert.ok(del.status < 300, `delete profile: ${del.status} ${await del.clone().text()}`);
    assert.deepEqual(await database.db.select().from(labOrders).where(eq(labOrders.id, o.id)), []);
  });
});
