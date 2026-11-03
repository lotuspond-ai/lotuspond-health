// The booking API end to end: HTTP requests into the real app, the simulated lab behind it, webhooks back.
// Run: npm run test:server
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { PartnerError, type LabPartner } from '../src/partners/types.ts';
import { apiEnv, bookingBody, deviceKey, NOTICE_VERSION, ORIGIN, type ApiEnv } from './lab-helpers.ts';

/** The real adapter with some methods replaced. */
function withOverrides(real: LabPartner, overrides: Partial<Record<keyof LabPartner, unknown>>): LabPartner {
  return Object.create(real, Object.fromEntries(Object.entries(overrides).map(([k, v]) => [k, { value: v }])));
}

async function statusAtLab(env: ApiEnv, partnerRef: string): Promise<string> {
  return (await env.real.status(partnerRef)).partnerStatus;
}

describe('catalogue and slots', () => {
  test('the catalogue is public, priced in paise, and cached for a day', async () => {
    let calls = 0;
    const env = apiEnv({ wrap: real => withOverrides(real, { catalog: async (pin: string) => { calls++; return real.catalog(pin); } }) });
    const r = await env.call('GET', '/v1/catalog?pincode=560034');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const essential = r.body.items.find((i: { code: string }) => i.code === 'FL_ESSENTIAL');
    assert.equal(essential.partner, 'fake');
    assert.equal(essential.pricePaise, 99_900);
    assert.deepEqual(r.body.unavailable, []);
    await env.call('GET', '/v1/catalog?pincode=560034');
    assert.equal(calls, 1);
    assert.deepEqual((await env.call('GET', '/v1/catalog?pincode=682001')).body.items, []);
    assert.equal((await env.call('GET', '/v1/catalog?pincode=5600')).status, 400);
  });

  test('a partner that is down is listed as unavailable', async () => {
    const env = apiEnv({ wrap: real => withOverrides(real, { catalog: async () => { throw new PartnerError('unavailable', 'down'); } }) });
    const r = await env.call('GET', '/v1/catalog?pincode=560034');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.items, []);
    assert.deepEqual(r.body.unavailable, ['fake']);
  });

  test('slots for a partner and date', async () => {
    const env = apiEnv();
    const r = await env.call('GET', '/v1/slots?partner=fake&pincode=560034&date=2026-11-04&items=FL_ESSENTIAL');
    assert.equal(r.status, 200);
    assert.ok(r.body.slots.length > 0);
    assert.match(r.body.slots[0].start, /^2026-11-04T\d{2}:00:00\+05:30$/);
    assert.equal((await env.call('GET', '/v1/slots?partner=nope&pincode=560034&date=2026-11-04')).body.error, 'unknown_partner');
    assert.equal((await env.call('GET', '/v1/slots?partner=fake&pincode=560034&date=4/11/2026')).status, 400);
  });
});

describe('booking', () => {
  test('a booking is confirmed by the lab: 201 with the order, consent and device recorded, details sealed', async () => {
    const env = apiEnv();
    const token = await env.signIn();
    const r = await env.book(token);
    assert.equal(r.status, 201);
    const o = r.body.order;
    assert.equal(o.status, 'booked');
    assert.match(o.partnerRef, /^FL\d{6}$/);
    assert.deepEqual(o.items, [{ code: 'FL_ESSENTIAL', name: 'Essential health check', pricePaise: 99_900 }]);
    assert.equal(o.pricePaise, 99_900);
    assert.equal(o.payer, 'partner');
    assert.match(o.slot.start, /^2026-11-04T\d{2}:00:00\+05:30$/);
    assert.equal(o.canCancel, true);
    assert.equal(o.patient, undefined, 'no personal details in the API view');

    const stored = (await env.orders.get(o.id))!;
    const userId = stored.userId;
    assert.ok(stored.contactCt);
    assert.ok(!Buffer.from(stored.contactCt).toString('latin1').includes('Asha'), 'patient details are sealed at rest');
    const consents = await env.accounts.consents(userId);
    assert.equal(consents.length, 1);
    assert.equal(consents[0].orderId, o.id);
    assert.equal(consents[0].noticeVersion, NOTICE_VERSION);
    assert.ok(stored.deviceId && await env.accounts.getDevice(stored.deviceId));
    assert.ok(!JSON.stringify(env.log.lines).includes('Asha'), 'no names in logs');
  });

  test('the same Idempotency-Key and request returns the same order; a different request is refused', async () => {
    const env = apiEnv();
    const token = await env.signIn();
    const body = bookingBody(await env.slot());
    const first = await env.book(token, body, 'same-key-123');
    const again = await env.book(token, body, 'same-key-123');
    assert.equal(again.status, 200);
    assert.equal(again.headers.get('idempotent-replayed'), 'true');
    assert.equal(again.body.order.id, first.body.order.id);
    const changed = await env.book(token, { ...body, items: ['FL_THYROID'] }, 'same-key-123');
    assert.equal(changed.status, 422);
    assert.equal(changed.body.error, 'idempotency_key_reused');
    const noKey = await env.call('POST', '/v1/orders', { token, body });
    assert.equal(noKey.status, 400);
    assert.equal(noKey.body.error, 'idempotency_key_required');
    assert.equal((await env.call('GET', '/v1/orders', { token })).body.orders.length, 1);
  });

  test('checks: shape, adults only, current consent, public keys only, offered items, served pincode, future slot', async () => {
    const env = apiEnv();
    const token = await env.signIn();
    const slot = await env.slot();
    const tryBook = (over: Record<string, unknown>) => env.book(token, bookingBody(slot, over));

    const missing = await env.call('POST', '/v1/orders', { token, body: { partner: 'fake' }, headers: { 'idempotency-key': 'k-missing-1' } });
    assert.equal(missing.status, 400);
    assert.ok(missing.body.details.includes('items must list 1 to 10 package codes'));

    const minor = await tryBook({ patient: { name: 'Child', age: 16, sex: 'male' } });
    assert.equal(minor.body.error, 'adults_only');
    assert.equal((await tryBook({ consent: { noticeVersion: '2025-01-01', accepted: true } })).body.error, 'consent_outdated');
    assert.equal((await tryBook({ consent: { noticeVersion: NOTICE_VERSION, accepted: false } })).body.error, 'consent_required');

    const leaked = await tryBook({ devicePublicKey: { ...deviceKey(), d: 'c2VjcmV0' } });
    assert.equal(leaked.status, 400);
    assert.match(leaked.body.details.join(' '), /private key/);
    const offCurve = await tryBook({ devicePublicKey: { kty: 'EC', crv: 'P-256', x: 'AAAA', y: 'AAAA' } });
    assert.match(offCurve.body.details.join(' '), /not a valid P-256/);

    assert.equal((await tryBook({ items: ['NOT_A_PACKAGE'] })).body.error, 'unknown_item');
    assert.equal((await tryBook({ address: { line1: 'MG Road', city: 'Kochi', pincode: '682001' } })).body.error, 'not_serviceable');
    assert.equal((await tryBook({ slot: { start: '2026-11-03T06:00:00+05:30', end: '2026-11-03T07:00:00+05:30' } })).body.error, 'slot_in_past');
    assert.equal((await tryBook({ partner: 'nope' })).body.error, 'unknown_partner');
    assert.equal((await env.call('GET', '/v1/orders', { token })).body.orders.length, 0, 'none of these created an order');
  });

  test('a slot taken at the lab: 409, and the order is recorded as failed', async () => {
    const env = apiEnv();
    const token = await env.signIn();
    const r = await env.book(token, bookingBody(await env.slot(), { patient: { name: 'Asha Rao #slot-full', age: 34, sex: 'female' } }));
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'slot_unavailable');
    assert.equal(r.body.order.status, 'failed');
    assert.equal(r.body.order.failureReason, 'slot_unavailable');
  });
});

describe('when the lab does not answer', () => {
  test('a lost reply: 202 placing, then the retry finds the booking at the lab', async () => {
    const env = apiEnv({ tags: ['lost-response', 'no-webhooks'] });
    const token = await env.signIn();
    const r = await env.book(token);
    assert.equal(r.status, 202);
    assert.equal(r.body.order.status, 'placing');
    assert.equal(r.body.order.canCancel, false);
    const id = r.body.order.id;
    assert.deepEqual(await env.booking.retryPlacements(), { attempted: 0, booked: 0, failed: 0 }, 'not due yet');
    await env.advance(1000);
    assert.deepEqual(await env.booking.retryPlacements(), { attempted: 1, booked: 1, failed: 0 });
    const o = (await env.call('GET', `/v1/orders/${id}`, { token })).body.order;
    assert.equal(o.status, 'booked');
    assert.equal(o.partnerRef, 'FL000001');
    assert.deepEqual(o.timeline.map((e: { status: string }) => e.status), ['created', 'placing', 'booked']);
  });

  test('a slow reply after the timeout is still applied', async () => {
    const env = apiEnv({
      booking: { placeTimeoutMs: 20 },
      wrap: real => withOverrides(real, { createOrder: async (input: Parameters<LabPartner['createOrder']>[0]) => { await sleep(80); return real.createOrder(input); } }),
    });
    const token = await env.signIn();
    const r = await env.book(token);
    assert.equal(r.status, 202);
    await sleep(150);
    const o = (await env.orders.get(r.body.order.id))!;
    assert.equal(o.status, 'booked');
    assert.equal(o.nextPlacementAt, null);
  });

  test('if the lab never confirms, the order fails after the last retry, with an alert', async () => {
    const env = apiEnv({
      booking: { placementRetryDelaysMs: [1000, 1000] },
      wrap: real => withOverrides(real, {
        createOrder: async () => { throw new PartnerError('timeout', 'no reply'); },
        findOrderByClientRef: async () => null,
      }),
    });
    const token = await env.signIn();
    const id = (await env.book(token)).body.order.id;
    const runs = [];
    for (let i = 0; i < 3; i++) {
      await env.advance(1000);
      runs.push(await env.booking.retryPlacements());
    }
    assert.deepEqual(runs, [{ attempted: 1, booked: 0, failed: 0 }, { attempted: 1, booked: 0, failed: 0 }, { attempted: 0, booked: 0, failed: 1 }]);
    const o = (await env.orders.get(id))!;
    assert.equal(o.status, 'failed');
    assert.equal(o.failureReason, 'placement_gave_up');
    assert.ok(env.log.alerts().some(l => l.msg === 'booking could not be confirmed with the partner'));
  });

  test('a lab booking that turns up after we gave up is cancelled at the lab', async () => {
    const env = apiEnv({
      booking: { placeTimeoutMs: 20 },
      wrap: real => withOverrides(real, { createOrder: async (input: Parameters<LabPartner['createOrder']>[0]) => { await sleep(80); return real.createOrder(input); } }),
    });
    const token = await env.signIn();
    const id = (await env.book(token)).body.order.id;
    // Simulate having given up before the slow reply lands.
    await env.orders.apply(id, cur => ({ next: { ...cur, status: 'failed', failureReason: 'placement_gave_up' }, events: [] }));
    await sleep(150);
    const o = (await env.orders.get(id))!;
    assert.equal(o.status, 'failed');
    assert.equal(o.partnerRef, 'FL000001');
    assert.equal(await statusAtLab(env, 'FL000001'), 'CANCELLED');
    assert.ok(env.log.alerts().some(l => l.msg === 'unwanted partner booking; cancelling it at the lab'));
  });
});

describe('managing orders', () => {
  test('list and read your own orders only', async () => {
    const env = apiEnv();
    const asha = await env.signIn('+919812345678');
    const ravi = await env.signIn('+919898989898');
    const a1 = (await env.book(asha)).body.order.id;
    await env.advance(1000);
    const a2 = (await env.book(asha, bookingBody(await env.slot('2026-11-05')))).body.order.id;
    const list = await env.call('GET', '/v1/orders', { token: asha });
    assert.deepEqual(list.body.orders.map((o: { id: string }) => o.id), [a2, a1]);
    assert.equal(list.body.orders[0].timeline, undefined);
    assert.deepEqual((await env.call('GET', '/v1/orders', { token: ravi })).body.orders, []);
    assert.equal((await env.call('GET', `/v1/orders/${a1}`, { token: ravi })).status, 404, "someone else's order looks missing");
    assert.equal((await env.call('POST', `/v1/orders/${a1}/cancel`, { token: ravi, body: {} })).status, 404);
    assert.equal((await env.call('GET', '/v1/orders/ord_missing', { token: asha })).status, 404);
  });

  test('cancel before collection (at the lab too); not after', async () => {
    const env = apiEnv();
    const token = await env.signIn();
    const o = (await env.book(token)).body.order;
    const c = await env.call('POST', `/v1/orders/${o.id}/cancel`, { token, body: { reason: 'Travelling' } });
    assert.equal(c.status, 200);
    assert.equal(c.body.order.status, 'cancelled');
    assert.equal(c.body.order.canCancel, false);
    assert.equal(await statusAtLab(env, o.partnerRef), 'CANCELLED');
    assert.equal((await env.call('POST', `/v1/orders/${o.id}/cancel`, { token, body: {} })).status, 200, 'cancelling twice is fine');
    await env.advance(1000);
    assert.equal((await env.orders.get(o.id))!.status, 'cancelled', "the lab's cancellation webhook changes nothing");

    const later = (await env.book(token, bookingBody(await env.slot('2026-11-05')))).body.order;
    await env.advance(1000);
    await env.advance(1000);
    assert.equal((await env.orders.get(later.id))!.status, 'sample_collected');
    const late = await env.call('POST', `/v1/orders/${later.id}/cancel`, { token, body: {} });
    assert.equal(late.status, 409);
    assert.equal(late.body.error, 'not_cancellable');
  });

  test('if the lab has moved on, cancel is refused and the order catches up', async () => {
    const env = apiEnv({ tags: ['no-webhooks'] });
    const token = await env.signIn();
    const o = (await env.book(token)).body.order;
    await env.advance(2000);
    assert.equal((await env.orders.get(o.id))!.status, 'booked', 'no webhooks, so we have not heard');
    const r = await env.call('POST', `/v1/orders/${o.id}/cancel`, { token, body: {} });
    assert.equal(r.status, 409);
    assert.equal((await env.orders.get(o.id))!.status, 'sample_collected');
  });

  test('reschedule a visit: back to booked with the new slot; not after collection', async () => {
    const env = apiEnv();
    const token = await env.signIn();
    const o = (await env.book(token)).body.order;
    await env.advance(1000);
    assert.equal((await env.orders.get(o.id))!.status, 'collector_assigned');
    const newSlot = await env.slot('2026-11-06');
    const r = await env.call('POST', `/v1/orders/${o.id}/reschedule`, { token, body: { slot: newSlot } });
    assert.equal(r.status, 200);
    assert.equal(r.body.order.status, 'booked');
    assert.equal(r.body.order.slot.start, newSlot.start);
    const timeline = (await env.call('GET', `/v1/orders/${o.id}`, { token })).body.order.timeline.map((e: { status: string }) => e.status);
    assert.deepEqual(timeline, ['created', 'placing', 'booked', 'collector_assigned', 'booked']);

    assert.equal((await env.call('POST', `/v1/orders/${o.id}/reschedule`, { token, body: { slot: { start: 'tomorrow' } } })).status, 400);
    await env.advance(1000);
    await env.advance(1000);
    const late = await env.call('POST', `/v1/orders/${o.id}/reschedule`, { token, body: { slot: await env.slot('2026-11-07') } });
    assert.equal(late.status, 409);
    assert.equal(late.body.error, 'not_reschedulable');
  });

  test('from booking to report, driven by the lab', async () => {
    const env = apiEnv();
    const token = await env.signIn();
    const o = (await env.book(token)).body.order;
    for (let i = 0; i < 5; i++) await env.advance(1000);
    const r = (await env.call('GET', `/v1/orders/${o.id}`, { token })).body.order;
    assert.equal(r.status, 'report_ready');
    assert.deepEqual(r.timeline.map((e: { status: string }) => e.status), [
      'created', 'placing', 'booked', 'collector_assigned', 'sample_collected', 'processing', 'report_ready',
    ]);
    assert.equal(r.canCancel, false);
    assert.equal(r.canReschedule, false);
  });
});

describe('HTTP details', () => {
  test('CORS only for the app origin', async () => {
    const env = apiEnv();
    const preflight = (origin: string) => env.app.request('/v1/orders', {
      method: 'OPTIONS',
      headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type,idempotency-key' },
    });
    const ok = await preflight(ORIGIN);
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
    assert.match(ok.headers.get('access-control-allow-headers') ?? '', /idempotency-key/i);
    const other = await preflight('https://evil.example');
    assert.equal(other.headers.get('access-control-allow-origin'), null);
  });

  test('malformed JSON and oversized bodies', async () => {
    const env = apiEnv();
    const token = await env.signIn();
    const bad = await env.app.request('/v1/orders', {
      method: 'POST', body: '{not json',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': 'k-bad-json-1' },
    });
    assert.equal(bad.status, 400);
    const big = await env.app.request('/v1/auth/otp', { method: 'POST', body: JSON.stringify({ phone: 'x'.repeat(40_000) }), headers: { 'content-type': 'application/json' } });
    assert.equal(big.status, 413);
  });
});
