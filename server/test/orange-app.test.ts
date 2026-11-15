// Orange Health through the real app: catalogue, slots, booking (the token is stored), a signed webhook, the status
// sync, results waiting for review, and cancelling with the stored token. Orange Health itself is a stand-in that
// answers like the published examples. TEST_DATABASE_URL uses PostgreSQL; otherwise in-memory PGlite.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { LAB_BOOKING_NOTICE_VERSION, type LabOrderView, type LabResultView } from '../../shared/lab-bundle.ts';
import type { SessionInfo } from '../../shared/types.ts';
import { createApp } from '../src/app.ts';
import { singleCell } from '../src/cells.ts';
import { ephemeralSecrets } from '../src/compliance/secrets.ts';
import { loadConfig } from '../src/config.ts';
import { openDatabase, type Database } from '../src/db/client.ts';
import { labOrders } from '../src/db/schema.ts';
import { DiskFileStore } from '../src/lib/files.ts';
import { memoryLogger } from '../src/lab/log.ts';
import { OrangeHealthAdapter } from '../src/lab/partners/orange.ts';
import { createLabs } from '../src/lab/runtime.ts';
import { makeClient, registration } from './helpers.ts';

const migrations = fileURLToPath(new URL('../drizzle', import.meta.url));
let database: Database;
let filesDir: string;
before(async () => {
  database = await openDatabase({ url: process.env.TEST_DATABASE_URL });
  await database.migrate(migrations);
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspond-orange-'));
});
after(async () => {
  await database?.close();
  fs.rmSync(filesDir, { recursive: true, force: true });
});

const SECRET = 'orange-webhook-secret-for-tests';
const HOOK = 'h00k-path-secret-for-orange-tests-0001';

/** A small Orange Health: requests with their token, status, readiness and results. */
function orangeLab() {
  const requests = new Map<string, { token: string; ref: string; status: string; ready: boolean; cancelled: boolean; completedAt: string | null }>();
  let n = 300100;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchFn = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const p = url.pathname, q = url.searchParams, method = init?.method ?? 'GET';
    if (p === '/v1/partner/serviceability') {
      const d = q.get('request_date')!;
      return q.get('pincode') === '560043'
        ? json({ status: 'Serviceable Pincode Region', slots: { [`${d}T09:00:00`]: { slot_datetime: `${d}T09:00:00` }, [`${d}T16:30:00`]: { slot_datetime: `${d}T16:30:00` } } })
        : json({ status: 'Unserviceable Pincode Region' }, 400);
    }
    if (p === '/v1/partner/order' && method === 'POST') {
      const body = JSON.parse(String(init!.body));
      const id = `BLR${++n}`, token = `tok-${n}`;
      requests.set(id, { token, ref: body.patient_details[0].partner_reference_id, status: 'scheduled', ready: false, cancelled: false, completedAt: null });
      return json({ request_id: id, token, status: 'Scheduled', orders: [{ id: n, partnerReferenceId: body.patient_details[0].partner_reference_id }] }, 202);
    }
    const m = /^\/v1\/partner\/(?:order-details\/)?(BLR\d+)(?:\/(cancel|reschedule))?$/.exec(p);
    const r = m ? requests.get(m[1]) : undefined;
    if (m && (!r || q.get('token') !== r.token)) return json({ status: 'Could not get request details, re-verify request ID and token provided' }, 400);
    if (m && m[2] === 'cancel') { r!.cancelled = true; r!.status = 'cancelled'; return json({ status: `Cancellation Request with ID : ${m[1]} is in process` }); }
    if (m && p.includes('order-details')) {
      return json({ status: 200, data: { id: m[1], status: r!.status, emedicDetails: {}, patient_information: [{ tests: { tests: [{ name: 'Full Body Checkup', is_report_ready: r!.ready }] } }] } });
    }
    if (p === '/v1/partner/test-results') {
      const id = q.get('request_id');
      const list = [...requests.entries()].filter(([k]) => !id || k === id).map(([k, v]) => ({
        request_id: k, partner_reference_id: v.ref, order_completed_at: v.completedAt,
        tests: v.ready ? [
          { investigation_code: 'OD1', investigation_name: 'Haemoglobin', investigation_value: '13.4', investigation_value_unit: 'g/dL', investigation_range: '12.0-15.5', investigation_is_abnormal: 'N' },
          { investigation_code: 'OD2', investigation_name: 'HbA1c', investigation_value: '6.1', investigation_value_unit: '%', investigation_range: '4.0-5.6', investigation_is_abnormal: 'A' },
        ] : [],
      }));
      return json({ data: { orders: list } });
    }
    return json({ status: 'not found' }, 404);
  }) as typeof fetch;
  return { requests, fetchFn };
}

test('book with Orange Health, follow a signed webhook to results, and cancel another booking with its token', async () => {
  // The webhook inbox stamps arrivals with the real clock, so the test clock starts now.
  let t = Date.now();
  const tomorrow = new Date(t + 330 * 60_000 + 86_400_000).toISOString().slice(0, 10); // India date
  const now = () => t;
  const config = loadConfig({ NODE_ENV: 'test', TRUST_PROXY: 'true' });
  const files = new DiskFileStore(filesDir);
  const cells = singleCell(database.db, files, config.servedRegions);
  const secrets = ephemeralSecrets();
  const oh = orangeLab();
  const adapter = new OrangeHealthAdapter({
    apiKey: 'test-key-123', webhookSecret: SECRET, fetch: oh.fetchFn, now,
    catalog: [{ code: 'OH-P-3', kind: 'package', id: '3', name: 'Full Body Checkup', tests: ['CBC', 'HbA1c'], pricePaise: 129_900, fasting: true, reportHours: 12 }],
  });
  const log = memoryLogger();
  const labs = createLabs({ cells, secrets, partners: [{ adapter, region: 'in', hookSecret: HOOK }], now, log, processor: { baseDelayMs: 1000 } });
  const app = createApp({ db: database.db, files, config, cells, secrets, labs });

  const c = makeClient(app);
  const info = await c.json<SessionInfo>('POST', '/api/auth/register', registration(`orange-${Date.now()}@example.com`), 201);
  const pid = info.profiles[0].id;

  const catalog = await c.json<{ items: { code: string; partner: string }[] }>('GET', '/api/lab/catalog?pincode=560043');
  assert.deepEqual(catalog.items.map(i => [i.partner, i.code]), [['orange', 'OH-P-3']]);
  const { slots } = await c.json<{ slots: { start: string; end: string }[] }>('GET', `/api/lab/slots?partner=orange&pincode=560043&date=${tomorrow}&items=OH-P-3`);
  assert.deepEqual(slots[0], { start: `${tomorrow}T09:00:00+05:30`, end: `${tomorrow}T10:00:00+05:30` });

  const book = async (key: string) => {
    const res = await c.call('POST', `/api/profiles/${pid}/lab-orders`, {
      partner: 'orange', items: ['OH-P-3'], slot: slots[0], patient: { name: 'Asha Rao', age: 34, sex: 'female' }, phone: '+919812345678',
      address: { line1: '12 Lake Road', city: 'Bengaluru', pincode: '560043' }, consent: { noticeVersion: LAB_BOOKING_NOTICE_VERSION, accepted: true },
    }, { 'idempotency-key': key });
    const body = await res.json() as { order: LabOrderView };
    assert.equal(res.status, 201, JSON.stringify(body));
    return body.order;
  };
  const first = await book('orange-booking-0001');
  assert.equal(first.status, 'booked');
  assert.match(first.partnerRef!, /^BLR\d+$/);
  const [row] = await database.db.select().from(labOrders).where(eq(labOrders.id, first.id));
  assert.equal(row.partnerToken, oh.requests.get(first.partnerRef!)!.token, 'the token is kept for later calls');

  // Orange Health finishes the tests and says so with a signed webhook.
  const req = oh.requests.get(first.partnerRef!)!;
  Object.assign(req, { status: 'completed', ready: true, completedAt: '2026-11-11T10:30:00Z' });
  t += 60_000;
  const payload = JSON.stringify({ event: 'order.completed', payload: { order: { city_request_id: first.partnerRef, partner_reference_id: first.id, status_string: 'completed' } } });
  const sig = createHmac('sha256', SECRET).update(payload).digest('hex');
  const unsigned = await app.request(`/hooks/orange/${HOOK}`, { method: 'POST', body: payload, headers: { 'content-type': 'application/json' } });
  assert.equal(unsigned.status, 401, 'an unsigned webhook is refused');
  const hook = await app.request(`/hooks/orange/${HOOK}`, { method: 'POST', body: payload, headers: { 'content-type': 'application/json', 'x-oh-signature': sig } });
  assert.ok(hook.status < 300, `webhook: ${hook.status}`);
  for (let i = 0; i < 3; i++) { t += 15_000; await labs.tick(); }

  const order = (await c.json<{ order: LabOrderView }>('GET', `/api/profiles/${pid}/lab-orders/${first.id}`)).order;
  assert.equal(order.status, 'report_ready');
  const { results } = await c.json<{ results: LabResultView[] }>('GET', `/api/profiles/${pid}/lab-results`);
  assert.equal(results.length, 1);
  const bundle = results[0].bundle!;
  assert.ok(bundle, 'the result carries its bundle');
  assert.deepEqual(bundle.results.map(r => [r.name, r.value, r.flag ?? null]), [['Haemoglobin', '13.4', null], ['HbA1c', '6.1', 'Abnormal']]);
  assert.equal(bundle.source.partner, 'orange');

  // A second booking, cancelled: our server sends the stored token.
  const second = await book('orange-booking-0002');
  const cancelled = await c.json<{ order: LabOrderView }>('POST', `/api/profiles/${pid}/lab-orders/${second.id}/cancel`, { reason: 'Changed my mind' });
  assert.equal(cancelled.order.status, 'cancelled');
  assert.equal(oh.requests.get(second.partnerRef!)!.cancelled, true);
});
