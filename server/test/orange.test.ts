// The Orange Health adapter against a stand-in for its Partner API that answers in the shapes of the published
// examples (orangehealth.docs.apiary.io, read 2026-11-10). The webhook test uses Orange Health's own signed example.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { OrangeHealthAdapter, parseOrangeCatalog, type OrangeCatalogItem } from '../src/lab/partners/orange.ts';
import { PartnerError, type PartnerOrderInput } from '../src/lab/partners/types.ts';

const NOW = Date.parse('2026-11-10T04:30:00Z'); // 10:00 India time
const CATALOG: OrangeCatalogItem[] = [
  { code: 'OH-P-3', kind: 'package', id: '3', name: 'Full Body Checkup - Smart', tests: ['CBC', 'Lipid profile', 'HbA1c'], pricePaise: 129_900, mrpPaise: 249_900, fasting: true, reportHours: 12 },
  { code: 'OH-T-154', kind: 'test', id: '154', name: 'Vitamin D (25-OH)', tests: ['Vitamin D'], pricePaise: 89_900, fasting: false, reportHours: 24 },
];

interface Call { method: string; path: string; query: Record<string, string>; headers: Record<string, string>; body: unknown }
type Handler = (c: Call) => { status?: number; body?: unknown; bytes?: Uint8Array } | undefined;

/** An Orange Health stand-in: records every call and answers with the first handler that returns something. */
function lab(...handlers: Handler[]) {
  const calls: Call[] = [];
  const fetchFn = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? 'GET', path: url.pathname, query: Object.fromEntries(url.searchParams),
      headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    for (const h of handlers) {
      const r = h(call);
      if (r) return r.bytes ? new Response(r.bytes, { status: r.status ?? 200 }) : new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ status: 'not found' }), { status: 404 });
  }) as typeof fetch;
  const adapter = new OrangeHealthAdapter({ apiKey: 'test-key-123', webhookSecret: 'abcd-abcd-abcd-abcd', catalog: CATALOG, fetch: fetchFn, now: () => NOW });
  return { adapter, calls };
}

const serviceable: Handler = c => c.path === '/v1/partner/serviceability' && c.query.pincode === '560043' ? {
  body: {
    status: 'Serviceable Pincode Region',
    slots: {
      [`${c.query.request_date}T07:15:00`]: { slot_datetime: `${c.query.request_date}T07:15:00` },
      [`${c.query.request_date}T12:30:00`]: { slot_datetime: `${c.query.request_date}T12:30:00` },
      '2026-11-30T08:00:00': { slot_datetime: '2026-11-30T08:00:00' },
    },
  },
} : undefined;
const unserviceable: Handler = c => c.path === '/v1/partner/serviceability' ? { status: 400, body: { status: 'Unserviceable Pincode Region' } } : undefined;

const order = (over: Partial<PartnerOrderInput> = {}): PartnerOrderInput => ({
  orderId: '8f1c2e3a-0000-4000-8000-000000000001', items: ['OH-P-3', 'OH-T-154'],
  slot: { start: '2026-11-11T07:15:00+05:30', end: '2026-11-11T08:15:00+05:30' },
  patient: { name: 'Asha Rao', age: 34, sex: 'female' }, phone: '+919812345678',
  address: { line1: '12 Lake Road', line2: 'Kalyan Nagar', city: 'Bengaluru', pincode: '560043' }, ...over,
});

describe('catalogue and slots', () => {
  test('a serviceable pincode gets the onboarding catalogue; an unserviceable one gets nothing', async () => {
    const { adapter, calls } = lab(serviceable, unserviceable);
    const items = await adapter.catalog('560043');
    assert.deepEqual(items.map(i => [i.partner, i.code, i.pricePaise]), [['orange', 'OH-P-3', 129_900], ['orange', 'OH-T-154', 89_900]]);
    assert.equal(calls[0].query.request_date, '2026-11-10', 'today in India');
    assert.equal(calls[0].headers.api_key, 'test-key-123');
    assert.deepEqual(await adapter.catalog('110001'), []);
  });

  test('slots are that date\'s, in India time, an hour long', async () => {
    const { adapter } = lab(serviceable, unserviceable);
    assert.deepEqual(await adapter.slots({ pincode: '560043', date: '2026-11-11', items: ['OH-P-3'] }), [
      { start: '2026-11-11T07:15:00+05:30', end: '2026-11-11T08:15:00+05:30' },
      { start: '2026-11-11T12:30:00+05:30', end: '2026-11-11T13:30:00+05:30' },
    ]);
    // Today: the 07:15 slot has passed at 10:00.
    assert.deepEqual((await adapter.slots({ pincode: '560043', date: '2026-11-10', items: [] })).map(s => s.start), ['2026-11-10T12:30:00+05:30']);
    assert.deepEqual(await adapter.slots({ pincode: '110001', date: '2026-11-11', items: [] }), []);
  });
});

describe('orders', () => {
  test('a booking sends our order id as the reference and keeps the token', async () => {
    const { adapter, calls } = lab(c => c.method === 'POST' && c.path === '/v1/partner/order'
      ? { status: 202, body: { request_id: 'BLR1901286', token: '517dfc6a-7ddd-4da6-a60c-0f67e6f001dc', status: 'Scheduled', orders: [{ id: 1897, partnerReferenceId: order().orderId }] } }
      : undefined);
    assert.deepEqual(await adapter.createOrder(order()), { partnerRef: 'BLR1901286', token: '517dfc6a-7ddd-4da6-a60c-0f67e6f001dc' });
    const body = calls[0].body as Record<string, any>;
    assert.equal(body.slot_datetime, '2026-11-11T07:15:00');
    assert.equal(body.primary_patient_number, '9812345678');
    assert.equal(body.payment_type, 'paid_by_group');
    assert.equal(body.address, '12 Lake Road, Kalyan Nagar, Bengaluru, 560043');
    assert.deepEqual(body.patient_details, [{
      partner_reference_id: order().orderId, patient_name: 'Asha Rao', patient_phone: '9812345678', age: '34', gender: 'Female',
      tests: [{ test_id: '154' }], packages: [{ package_id: '3' }],
    }]);
  });

  test('a repeated booking ("Request already accepted") resolves to the earlier one through our reference', async () => {
    const { adapter, calls } = lab(
      c => c.path === '/v1/partner/order' ? { status: 425, body: { status: 'Request already accepted' } } : undefined,
      c => c.path === '/v1/partner/test-results' ? { body: { data: { orders: [{ request_id: 'BLR9', partner_reference_id: order().orderId, tests: [] }] } } } : undefined,
    );
    assert.deepEqual(await adapter.createOrder(order()), { partnerRef: 'BLR9', token: null });
    assert.equal(calls[1].query.creation_start_date, '2026-11-07');
  });

  test('refusals become our error codes', async () => {
    const refuse = (status: number, text: string) => lab(c => c.path === '/v1/partner/order' ? { status, body: { status: text } } : undefined).adapter;
    await assert.rejects(refuse(400, 'Location provided is unserviceable').createOrder(order()), (e: PartnerError) => e.code === 'not_serviceable');
    await assert.rejects(refuse(400, 'Selected slot is full').createOrder(order()), (e: PartnerError) => e.code === 'slot_unavailable');
    await assert.rejects(refuse(503, '').createOrder(order()), (e: PartnerError) => e.code === 'unavailable' && e.retryable);
    await assert.rejects(refuse(401, '').createOrder(order()), (e: PartnerError) => e.code === 'unavailable');
    await assert.rejects(lab().adapter.createOrder(order({ items: ['NOPE'] })), (e: PartnerError) => e.code === 'invalid_request');
    await assert.rejects(lab().adapter.createOrder(order({ phone: '12345' })), (e: PartnerError) => e.code === 'invalid_request');
  });

  test('a network timeout is retryable', async () => {
    const adapter = new OrangeHealthAdapter({
      apiKey: 'test-key-123', webhookSecret: 'abcd-abcd-abcd-abcd', catalog: CATALOG, now: () => NOW,
      fetch: (async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); }) as typeof fetch,
    });
    await assert.rejects(adapter.catalog('560043'), (e: PartnerError) => e.code === 'timeout' && e.retryable);
  });

  test('cancel and reschedule send the token; without one they are refused', async () => {
    const { adapter, calls } = lab(c => c.method === 'PATCH' ? { body: { result: 'ok' } } : undefined);
    await adapter.cancel('BLR300100', 'Changed my mind', 'tok-1');
    await adapter.reschedule('BLR300100', { start: '2026-11-12T12:30:00+05:30', end: '2026-11-12T13:30:00+05:30' }, 'tok-1');
    assert.deepEqual(calls.map(c => [c.path, c.query.token]), [['/v1/partner/BLR300100/cancel', 'tok-1'], ['/v1/partner/BLR300100/reschedule', 'tok-1']]);
    assert.deepEqual(calls[0].body, { cancellationReason: 'Changed my mind', cancellationExplanation: 'Changed my mind' });
    assert.equal((calls[1].body as { requested_slot_time: string }).requested_slot_time, '2026-11-12T12:30:00');
    await assert.rejects(adapter.cancel('BLR300100', 'x', null), (e: PartnerError) => e.code === 'not_allowed');
  });
});

describe('status', () => {
  const details = (status: string, tests: boolean[], emedic = {}) => (c: Call) => c.path.startsWith('/v1/partner/order-details/') ? {
    body: { data: { id: 'BLR300100', status, emedicDetails: emedic, patient_information: [{ tests: { tests: tests.map((r, i) => ({ name: `T${i}`, is_report_ready: r })) } }] }, status: 200 },
  } : undefined;
  const statusOf = async (h: Handler) => (await lab(h).adapter.status('BLR300100', 'tok')).status;

  test('order details map to our states', async () => {
    assert.equal(await statusOf(details('scheduled', [false])), 'booked');
    assert.equal(await statusOf(details('confirmed', [false], { name: 'Ravi' })), 'collector_assigned');
    assert.equal(await statusOf(details('confirmed', [true, false])), 'partial_report');
    assert.equal(await statusOf(details('confirmed', [true, true])), 'report_ready');
    assert.equal(await statusOf(details('completed', [true])), 'report_ready');
    assert.equal(await statusOf(details('cancelled', [false])), 'cancelled');
    const odd = await lab(details('teleported', [false])).adapter.status('BLR300100', 'tok');
    assert.deepEqual([odd.status, odd.partnerStatus], ['unknown', 'teleported']);
  });

  test('without a token, the results show how far it got', async () => {
    const { adapter } = lab(c => c.path === '/v1/partner/test-results' ? { body: { data: { orders: [{ request_id: 'BLR9', order_completed_at: '2026-11-10T09:00:00Z', tests: [{ investigation_name: 'X', investigation_value: '1' }] }] } } } : undefined);
    assert.equal((await adapter.status('BLR9', null)).status, 'report_ready');
  });
});

describe('results', () => {
  const PDF = new Uint8Array(Buffer.from('%PDF-1.4 test report'));
  const results = (completedAt: string | null, value = '40') => (c: Call) => c.path === '/v1/partner/test-results' && c.query.request_id === 'BLR680877' ? {
    body: { data: { orders: [{
      request_id: 'BLR680877', order_completed_at: completedAt, partner_reference_id: 'ours',
      tests: [
        { investigation_code: 'OD0310', investigation_is_abnormal: 'A', investigation_name: 'APTT - TEST', investigation_range: '17.8-39.8', investigation_value: value, investigation_value_unit: 'seconds' },
        { investigation_code: 'OD0311', investigation_is_abnormal: 'N', investigation_name: 'aPTT - Control', investigation_range: '', investigation_value: '1', investigation_value_unit: 'seconds' },
        { investigation_code: 'OD0312', investigation_name: 'Not done yet', investigation_value: '' },
      ],
    }] } },
  } : undefined;
  const pdfLink: Handler = c => c.path.startsWith('/v1/partner/order-details/') ? { body: { data: { patient_information: [{ reportURL: 'https://files.example/report?fileId=1' }] } } } : undefined;
  const pdfFile: Handler = c => c.path === '/report' ? { bytes: PDF } : undefined;

  test('structured rows as printed, partial until the order completes, then the PDF too', async () => {
    const partial = await lab(results(null)).adapter.report('BLR680877', 'tok');
    assert.equal(partial.pending, false);
    assert.equal(partial.partial, true);
    assert.equal(partial.pdf, undefined);
    assert.deepEqual(partial.rows, [
      { name: 'APTT - TEST', value: '40', unit: 'seconds', range: '17.8-39.8', flag: 'Abnormal', partnerCode: 'OD0310' },
      { name: 'aPTT - Control', value: '1', unit: 'seconds', partnerCode: 'OD0311' },
    ]);
    const final = await lab(results('2026-11-10T09:00:00Z'), pdfLink, pdfFile).adapter.report('BLR680877', 'tok');
    assert.equal(final.partial, false);
    assert.deepEqual(final.pdf, PDF);
    assert.equal(final.reportedAt, '2026-11-10T09:00:00Z');
    assert.notEqual(final.version, partial.version);
    const amended = await lab(results('2026-11-10T09:00:00Z', '41'), pdfLink, pdfFile).adapter.report('BLR680877', 'tok');
    assert.notEqual(amended.version, final.version, 'an amended value is a new version');
  });

  test('nothing yet means pending', async () => {
    const { adapter } = lab(c => c.path === '/v1/partner/test-results' ? { body: { data: { orders: [] } } } : undefined);
    assert.deepEqual(await adapter.report('BLR1', 'tok'), { pending: true, partial: false });
  });
});

describe('webhooks', () => {
  const fixture = JSON.parse(fs.readFileSync(fileURLToPath(new URL('./fixtures/orange-webhook-order-created.json', import.meta.url)), 'utf8')) as {
    secret: string; headers: Record<string, string>; body: unknown;
  };
  const adapter = new OrangeHealthAdapter({ apiKey: 'k-12345678', webhookSecret: fixture.secret, catalog: CATALOG });
  const raw = (s: string) => new Uint8Array(Buffer.from(s, 'utf8'));

  test('Orange Health\'s own signed example verifies, compact or pretty-printed; a changed body does not', () => {
    const headers = { 'x-oh-signature': fixture.headers['x-oh-signature'] };
    assert.equal(adapter.verifyWebhook({ headers, rawBody: raw(JSON.stringify(fixture.body)), ip: '1.2.3.4' }), true);
    assert.equal(adapter.verifyWebhook({ headers, rawBody: raw(JSON.stringify(fixture.body, null, 2)), ip: '1.2.3.4' }), true);
    const tampered = JSON.stringify(fixture.body).replace('Jane Doe', 'Jane Roe');
    assert.equal(adapter.verifyWebhook({ headers, rawBody: raw(tampered), ip: '1.2.3.4' }), false);
    assert.equal(adapter.verifyWebhook({ headers: {}, rawBody: raw(JSON.stringify(fixture.body)), ip: '1.2.3.4' }), false);
    const other = new OrangeHealthAdapter({ apiKey: 'k-12345678', webhookSecret: 'a-different-secret', catalog: CATALOG });
    assert.equal(other.verifyWebhook({ headers, rawBody: raw(JSON.stringify(fixture.body)), ip: '1.2.3.4' }), false);
  });

  test('a webhook names Orange Health\'s request and our reference', () => {
    assert.deepEqual(adapter.parseWebhook(fixture.body), { partnerRef: 'BLR520289', eventId: null, clientRef: 'P_1' });
    assert.throws(() => adapter.parseWebhook({ event: 'order.created' }), PartnerError);
  });
});

describe('catalogue file', () => {
  test('is checked when loaded', () => {
    assert.equal(parseOrangeCatalog(JSON.stringify(CATALOG)).length, 2);
    assert.throws(() => parseOrangeCatalog('[]'), /non-empty/);
    assert.throws(() => parseOrangeCatalog(JSON.stringify([{ ...CATALOG[0], kind: 'bundle' }])), /kind/);
    assert.throws(() => parseOrangeCatalog(JSON.stringify([CATALOG[0], CATALOG[0]])), /duplicate/);
    assert.throws(() => parseOrangeCatalog(JSON.stringify([{ ...CATALOG[0], pricePaise: 12.5 }])), /pricePaise/);
  });
});

describe('settings', () => {
  test('LAB_PARTNERS=orange needs its key, secrets and catalogue', async () => {
    const { loadConfig } = await import('../src/config.ts');
    assert.throws(() => loadConfig({ NODE_ENV: 'test', LAB_PARTNERS: 'orange' }), /ORANGE_API_KEY, ORANGE_WEBHOOK_SECRET, ORANGE_HOOK_SECRET, ORANGE_CATALOG_FILE/);
    const c = loadConfig({
      NODE_ENV: 'test', LAB_PARTNERS: 'orange', ORANGE_API_KEY: 'partner-key-1', ORANGE_WEBHOOK_SECRET: 'a-webhook-secret-of-length',
      ORANGE_HOOK_SECRET: 'path-secret-0123456789abcdef', ORANGE_CATALOG_FILE: 'data/orange-catalog.example.json',
    });
    assert.equal(c.labs.orange?.apiUrl, 'https://sandbox-partner-api.orangehealth.dev');
    assert.throws(() => loadConfig({ NODE_ENV: 'test', LAB_PARTNERS: 'quantum' }), /unknown partner quantum/);
  });

  test('the example catalogue file is valid', () => {
    const file = fileURLToPath(new URL('../data/orange-catalog.example.json', import.meta.url));
    assert.equal(parseOrangeCatalog(fs.readFileSync(file, 'utf8')).length, 2);
  });
});
