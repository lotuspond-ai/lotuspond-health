// Tests for the simulated lab and its adapter. Run: npm run test:server
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { OrderStatus } from '../../shared/lab-bundle.ts';
import { FakeLab, istDate, type FakeTag, type FakeWebhookBody, type FakeWebhookRequest } from '../src/partners/fake-lab.ts';
import { FakeLabAdapter } from '../src/partners/fake.ts';
import { PartnerError, type PartnerOrderInput } from '../src/partners/types.ts';
import { buildBundle } from '../src/results/bundle.ts';
// The browser's own parsers, to check that what the server delivers reads correctly in the app.
import { parseJsonText } from '../../src/lib/parse/json.ts';
import { parseReportPages } from '../../src/lib/parse/pdf-text.ts';

const SECRET = 'test-secret';
const T0 = Date.parse('2026-11-03T07:30:00+05:30');
const TOMORROW = '2026-11-04';
const PIN = '560034';

interface Received { req: FakeWebhookRequest; body: FakeWebhookBody }

function setup(opts: { tags?: FakeTag[]; failDeliveries?: number; slotCapacity?: number } = {}) {
  let t = T0;
  const now = () => t;
  const webhooks: Received[] = [];
  let failures = opts.failDeliveries ?? 0;
  const lab = new FakeLab({
    now, stepMs: 1000, webhookSecret: SECRET, defaultTags: opts.tags, slotCapacity: opts.slotCapacity,
    onWebhook: req => {
      if (failures > 0) { failures--; throw new Error('receiver down'); }
      webhooks.push({ req, body: JSON.parse(Buffer.from(req.rawBody).toString('utf8')) as FakeWebhookBody });
    },
  });
  const adapter = new FakeLabAdapter({ lab, webhookSecret: SECRET, now });
  const advance = async (ms: number) => { t += ms; await lab.tick(); };
  return { lab, adapter, webhooks, advance, now };
}
type Env = ReturnType<typeof setup>;

async function orderInput(env: Env, over: Partial<PartnerOrderInput> = {}): Promise<PartnerOrderInput> {
  const slots = await env.adapter.slots({ pincode: PIN, date: TOMORROW, items: ['FL_ESSENTIAL'] });
  return {
    orderId: 'ord_1', items: ['FL_ESSENTIAL'], slot: slots[0],
    patient: { name: 'Asha Rao', age: 34, sex: 'female' }, phone: '+919812345678',
    address: { line1: '12 Lake Road', city: 'Bengaluru', pincode: PIN }, ...over,
  };
}

/** Advance step by step, returning each distinct status that polling sees. */
async function playOut(env: Env, ref: string, steps = 12): Promise<OrderStatus[]> {
  const seen: (OrderStatus | 'unknown')[] = [(await env.adapter.status(ref)).status];
  for (let i = 0; i < steps; i++) {
    await env.advance(1000);
    const s = (await env.adapter.status(ref)).status;
    if (s !== seen[seen.length - 1]) seen.push(s);
  }
  assert.ok(!seen.includes('unknown'));
  return seen as OrderStatus[];
}

async function rejectsWith(p: Promise<unknown>, code: PartnerError['code']): Promise<PartnerError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof PartnerError, `expected PartnerError, got ${String(e)}`);
    assert.equal(e.code, code, e.message);
    return e;
  }
  assert.fail(`expected PartnerError ${code}`);
}

describe('catalogue and slots', () => {
  test('packages are priced in paise for a served pincode', async () => {
    const { adapter } = setup();
    const items = await adapter.catalog(PIN);
    const essential = items.find(i => i.code === 'FL_ESSENTIAL');
    assert.ok(essential);
    assert.equal(essential.partner, 'fake');
    assert.equal(essential.pricePaise, 99_900);
    assert.equal(essential.mrpPaise, 240_000);
    assert.ok(essential.tests.includes('Lipid profile'));
  });

  test('an unserved pincode has no packages or slots; a malformed one is an error', async () => {
    const { adapter } = setup();
    assert.deepEqual(await adapter.catalog('682001'), []);
    assert.deepEqual(await adapter.slots({ pincode: '682001', date: TOMORROW, items: [] }), []);
    await rejectsWith(adapter.catalog('56003'), 'invalid_request');
  });

  test('slots are IST hours, at least two hours ahead, within the next 7 days', async () => {
    const env = setup();
    const today = await env.adapter.slots({ pincode: PIN, date: istDate(T0), items: [] });
    assert.ok(today.length > 0);
    for (const s of today) {
      assert.match(s.start, /^2026-11-03T\d{2}:00:00\+05:30$/);
      assert.ok(Date.parse(s.start) >= env.now() + 2 * 3600_000, s.start);
      assert.equal(Date.parse(s.end) - Date.parse(s.start), 3600_000);
    }
    assert.deepEqual(await env.adapter.slots({ pincode: PIN, date: '2026-11-02', items: [] }), []);
    assert.deepEqual(await env.adapter.slots({ pincode: PIN, date: '2026-11-10', items: [] }), []);
    assert.ok((await env.adapter.slots({ pincode: PIN, date: '2026-11-09', items: [] })).length > 0);
  });
});

describe('booking', () => {
  test('books with our order id as the client reference, and a repeat returns the same booking', async () => {
    const env = setup();
    const input = await orderInput(env);
    const { partnerRef } = await env.adapter.createOrder(input);
    assert.match(partnerRef, /^FL\d{6}$/);
    assert.deepEqual(await env.adapter.findOrderByClientRef('ord_1'), { partnerRef });
    assert.deepEqual(await env.adapter.createOrder(input), { partnerRef });
    assert.equal((await env.adapter.status(partnerRef)).status, 'booked');
    assert.equal(await env.adapter.findOrderByClientRef('ord_unknown'), null);
  });

  test('#lost-response: the booking goes through but the reply is lost; a retry finds it', async () => {
    const env = setup();
    const input = await orderInput(env, { patient: { name: 'Asha Rao #lost-response', age: 34, sex: 'female' } });
    const err = await rejectsWith(env.adapter.createOrder(input), 'timeout');
    assert.equal(err.retryable, true);
    const found = await env.adapter.findOrderByClientRef('ord_1');
    assert.ok(found);
    assert.deepEqual(await env.adapter.createOrder(input), found);
  });

  test('#slot-full and a full slot are refused as slot_unavailable', async () => {
    const env = setup({ slotCapacity: 2 });
    const tagged = await orderInput(env, { patient: { name: 'Asha Rao #slot-full', age: 34, sex: 'female' } });
    assert.equal((await rejectsWith(env.adapter.createOrder(tagged), 'slot_unavailable')).retryable, false);

    const slot = (await orderInput(env)).slot;
    await env.adapter.createOrder(await orderInput(env, { orderId: 'ord_a', slot }));
    await env.adapter.createOrder(await orderInput(env, { orderId: 'ord_b', slot }));
    await rejectsWith(env.adapter.createOrder(await orderInput(env, { orderId: 'ord_c', slot })), 'slot_unavailable');
    const left = await env.adapter.slots({ pincode: PIN, date: TOMORROW, items: [] });
    assert.ok(!left.some(s => s.start === slot.start));
  });

  test('rejects bad input before calling the lab', async () => {
    const env = setup();
    await rejectsWith(env.adapter.createOrder(await orderInput(env, { phone: '9812345678' })), 'invalid_request');
    await rejectsWith(env.adapter.createOrder(await orderInput(env, {
      slot: { start: '2026-11-04T07:30:00+05:30', end: '2026-11-04T08:30:00+05:30' },
    })), 'invalid_request');
    await rejectsWith(env.adapter.createOrder(await orderInput(env, { items: ['NOPE'] })), 'invalid_request');
  });

  test('cancel before collection; not after', async () => {
    const env = setup();
    const { partnerRef } = await env.adapter.createOrder(await orderInput(env));
    await env.adapter.cancel(partnerRef, 'Changed my mind');
    assert.equal((await env.adapter.status(partnerRef)).status, 'cancelled');
    await env.advance(5000);
    assert.equal((await env.adapter.status(partnerRef)).status, 'cancelled');

    const other = await env.adapter.createOrder(await orderInput(env, { orderId: 'ord_2' }));
    await env.advance(2000);
    assert.equal((await env.adapter.status(other.partnerRef)).status, 'sample_collected');
    await rejectsWith(env.adapter.cancel(other.partnerRef, 'Too late'), 'not_allowed');
  });

  test('reschedule moves the visit and restarts the timeline', async () => {
    const env = setup();
    const { partnerRef } = await env.adapter.createOrder(await orderInput(env));
    await env.advance(1000);
    assert.equal((await env.adapter.status(partnerRef)).status, 'collector_assigned');
    const later = (await env.adapter.slots({ pincode: PIN, date: '2026-11-05', items: [] }))[0];
    await env.adapter.reschedule(partnerRef, later);
    assert.equal((await env.adapter.status(partnerRef)).status, 'booked');
    assert.deepEqual(await playOut(env, partnerRef), ['booked', 'collector_assigned', 'sample_collected', 'processing', 'report_ready']);
  });

  test('unknown orders are not_found', async () => {
    const { adapter } = setup();
    await rejectsWith(adapter.status('FL999999'), 'not_found');
    await rejectsWith(adapter.report('FL999999'), 'not_found');
  });
});

describe('timeline and reports', () => {
  test('a normal order plays out to a final report with rows and a PDF', async () => {
    const env = setup();
    const { partnerRef } = await env.adapter.createOrder(await orderInput(env));
    const pending = await env.adapter.report(partnerRef);
    assert.equal(pending.pending, true);
    assert.equal(buildBundle(pending, { partner: 'fake', orderId: 'ord_1', partnerRef, sequence: 1 }), null);

    assert.deepEqual(await playOut(env, partnerRef), ['booked', 'collector_assigned', 'sample_collected', 'processing', 'report_ready']);
    const r = await env.adapter.report(partnerRef);
    assert.equal(r.pending, false);
    assert.equal(r.partial, false);
    assert.equal(r.version, '1');
    assert.ok(r.rows && r.rows.length > 30);
    assert.ok(r.pdf && Buffer.from(r.pdf).subarray(0, 5).toString() === '%PDF-');
    assert.equal(r.collectedAt, '2026-11-03T07:30:02+05:30');
  });

  test('#partial: slow tests arrive in a second report', async () => {
    const env = setup({ tags: ['partial'] });
    const { partnerRef } = await env.adapter.createOrder(await orderInput(env));
    for (let i = 0; i < 4; i++) await env.advance(1000);
    assert.equal((await env.adapter.status(partnerRef)).status, 'partial_report');
    const first = await env.adapter.report(partnerRef);
    assert.equal(first.partial, true);
    assert.ok(!first.rows?.some(r => r.name === 'HbA1c'));
    await env.advance(1000);
    const final = await env.adapter.report(partnerRef);
    assert.equal(final.partial, false);
    assert.ok(final.rows?.some(r => r.name === 'HbA1c'));
    assert.notEqual(first.version, final.version);
  });

  test('#amended: the final report is corrected afterwards', async () => {
    const env = setup({ tags: ['amended'] });
    const { partnerRef } = await env.adapter.createOrder(await orderInput(env));
    for (let i = 0; i < 4; i++) await env.advance(1000);
    const before = await env.adapter.report(partnerRef);
    const k1 = before.rows?.find(r => r.name === 'Potassium');
    assert.equal(k1?.flag, 'H');
    await env.advance(1000);
    const st = await env.adapter.status(partnerRef);
    assert.equal(st.status, 'report_ready');
    assert.equal(st.partnerStatus, 'REPORT_AMENDED');
    const after = await env.adapter.report(partnerRef);
    const k2 = after.rows?.find(r => r.name === 'Potassium');
    assert.equal(k2?.flag, undefined);
    assert.ok(Number(k2?.value) < Number(k1?.value));
    assert.notEqual(before.version, after.version);
  });

  test('#recollect: a rejected sample means a second visit', async () => {
    const env = setup({ tags: ['recollect'] });
    const { partnerRef } = await env.adapter.createOrder(await orderInput(env));
    assert.deepEqual(await playOut(env, partnerRef), [
      'booked', 'collector_assigned', 'sample_collected', 'recollection_needed',
      'collector_assigned', 'sample_collected', 'processing', 'report_ready',
    ]);
  });

  test('#pdf-only: a PDF and no structured rows', async () => {
    const env = setup({ tags: ['pdf-only'] });
    const { partnerRef } = await env.adapter.createOrder(await orderInput(env));
    await playOut(env, partnerRef);
    const r = await env.adapter.report(partnerRef);
    assert.equal(r.rows, undefined);
    assert.ok(r.pdf);
    assert.deepEqual(buildBundle(r, { partner: 'fake', orderId: 'ord_1', partnerRef, sequence: 1 })?.results, []);
  });
});

describe('webhooks', () => {
  test('one signed webhook per status change, which the adapter verifies and parses', async () => {
    const env = setup();
    const { partnerRef } = await env.adapter.createOrder(await orderInput(env));
    await playOut(env, partnerRef);
    assert.deepEqual(env.webhooks.map(w => w.body.status), ['ORDER_PLACED', 'PHLEBO_ASSIGNED', 'SAMPLE_COLLECTED', 'IN_LAB', 'REPORT_READY']);
    for (const w of env.webhooks) {
      assert.ok(env.adapter.verifyWebhook({ headers: w.req.headers, rawBody: w.req.rawBody, ip: '127.0.0.1' }));
      assert.deepEqual(env.adapter.parseWebhook(w.body), { partnerRef, eventId: w.body.event_id, clientRef: 'ord_1' });
    }
    assert.equal(new Set(env.webhooks.map(w => w.body.event_id)).size, env.webhooks.length);
  });

  test('rejects a tampered body, a wrong secret, a stale timestamp and a missing signature', async () => {
    const env = setup();
    await env.adapter.createOrder(await orderInput(env));
    await env.advance(1000);
    const w = env.webhooks[0];
    const ok = { headers: w.req.headers, rawBody: w.req.rawBody, ip: '127.0.0.1' };
    assert.ok(env.adapter.verifyWebhook(ok));
    const tampered = new Uint8Array(Buffer.from(Buffer.from(w.req.rawBody).toString().replace('ORDER_PLACED', 'REPORT_READY')));
    assert.equal(env.adapter.verifyWebhook({ ...ok, rawBody: tampered }), false);
    assert.equal(new FakeLabAdapter({ lab: env.lab, webhookSecret: 'other', now: env.now }).verifyWebhook(ok), false);
    assert.equal(env.adapter.verifyWebhook({ ...ok, headers: { 'content-type': 'application/json' } }), false);
    assert.equal(env.adapter.verifyWebhook({ ...ok, headers: { 'X-FakeLab-Signature': 't=abc,v1=00' } }), false);
    await env.advance(6 * 60_000);
    assert.equal(env.adapter.verifyWebhook(ok), false);
    assert.throws(() => env.adapter.parseWebhook({ status: 'IN_LAB' }), PartnerError);
  });

  test('#duplicate-webhooks sends each event twice; #out-of-order swaps them in pairs', async () => {
    const dup = setup({ tags: ['duplicate-webhooks'] });
    const a = await dup.adapter.createOrder(await orderInput(dup));
    await playOut(dup, a.partnerRef);
    const ids = dup.webhooks.map(w => w.body.event_id);
    assert.equal(ids.length, 10);
    assert.equal(new Set(ids).size, 5);

    const ooo = setup({ tags: ['out-of-order'] });
    const b = await ooo.adapter.createOrder(await orderInput(ooo));
    await playOut(ooo, b.partnerRef);
    const statuses = ooo.webhooks.map(w => w.body.status);
    assert.deepEqual(statuses, ['PHLEBO_ASSIGNED', 'ORDER_PLACED', 'IN_LAB', 'SAMPLE_COLLECTED', 'REPORT_READY']);
  });

  test('#no-webhooks: progress is visible only by polling', async () => {
    const env = setup({ tags: ['no-webhooks'] });
    const { partnerRef } = await env.adapter.createOrder(await orderInput(env));
    const seen = await playOut(env, partnerRef);
    assert.equal(seen[seen.length - 1], 'report_ready');
    assert.equal(env.webhooks.length, 0);
  });

  test('failed deliveries are retried on later ticks', async () => {
    const env = setup({ failDeliveries: 3 });
    const { partnerRef } = await env.adapter.createOrder(await orderInput(env));
    await playOut(env, partnerRef);
    await env.advance(1000);
    assert.deepEqual(env.webhooks.map(w => w.body.status).sort(), ['IN_LAB', 'ORDER_PLACED', 'PHLEBO_ASSIGNED', 'REPORT_READY', 'SAMPLE_COLLECTED']);
    assert.equal(env.lab.pendingWebhooks(), 0);
  });
});

/* ---------------- results read correctly in the app ---------------- */

/** Which catalog marker each simulated row should land on in the browser. */
const EXPECTED_MARKER: Record<string, string> = {
  'Haemoglobin': 'hemoglobin', 'Total Leucocyte Count (WBC)': 'wbc', 'RBC Count': 'rbc', 'Haematocrit (PCV)': 'hematocrit',
  'MCV': 'mcv', 'MCH': 'mch', 'MCHC': 'mchc', 'RDW-CV': 'rdw', 'Neutrophils': 'neutrophils_pct', 'Lymphocytes': 'lymphocytes_pct',
  'Monocytes': 'monocytes_pct', 'Eosinophils': 'eosinophils_pct', 'Platelet Count': 'platelets',
  'Total Cholesterol': 'total_cholesterol', 'Triglycerides': 'triglycerides', 'HDL Cholesterol - Direct': 'hdl',
  'LDL Cholesterol - Direct': 'ldl', 'VLDL Cholesterol': 'vldl', 'Non-HDL Cholesterol': 'non_hdl', 'TC/HDL Cholesterol Ratio': 'tc_hdl_ratio',
  'Fasting Blood Sugar (Glucose)': 'glucose_fasting', 'HbA1c': 'hba1c', 'Estimated Average Glucose (eAG)': 'eag',
  'Bilirubin - Total': 'bilirubin_total', 'Bilirubin - Direct': 'bilirubin_direct', 'Bilirubin - Indirect': 'bilirubin_indirect',
  'SGOT (AST)': 'ast', 'SGPT (ALT)': 'alt', 'Alkaline Phosphatase': 'alp', 'Gamma GT (GGT)': 'ggt', 'Total Protein': 'total_protein',
  'Albumin': 'albumin', 'Globulin': 'globulin', 'A/G Ratio': 'ag_ratio',
  'Urea': 'urea', 'Blood Urea Nitrogen (BUN)': 'bun', 'Creatinine': 'creatinine', 'Uric Acid': 'uric_acid', 'Sodium': 'sodium',
  'Potassium': 'potassium', 'Chloride': 'chloride', 'Calcium': 'calcium',
  'Total T3': 't3', 'Total T4': 't4', 'TSH - Ultrasensitive': 'tsh',
  '25-OH Vitamin D (Total)': 'vitamin_d', 'Vitamin B-12': 'vitamin_b12',
  'Iron': 'iron', 'Total Iron Binding Capacity (TIBC)': 'tibc', 'Transferrin Saturation': 'transferrin_sat', 'Ferritin': 'ferritin',
  'Urine pH': 'urine_ph', 'Urine Specific Gravity': 'urine_sg', 'Urine Glucose': 'urine_glucose', 'Urine Protein': 'urine_protein',
  'Urine Ketones': 'urine_ketones', 'Pus Cells': 'urine_pus_cells',
};
const FLAG_STATUS: Record<string, string> = { H: 'high', L: 'low', '': 'normal' };

async function pdfPages(pdf: Uint8Array) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(pdf), useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    pages.push({
      items: tc.items.filter(i => 'str' in i).map(i => ({
        str: i.str, x: i.transform[4], y: i.transform[5], width: i.width, height: i.height || Math.hypot(i.transform[2], i.transform[3]),
      })),
    });
  }
  await task.destroy();
  return pages;
}

describe('delivered results read correctly in the app', () => {
  for (const sex of ['female', 'male'] as const) {
    test(`complete package (${sex}): bundle and PDF both match every row to the right marker`, async () => {
      const env = setup();
      const input = await orderInput(env, { items: ['FL_COMPLETE'], patient: { name: 'Asha Rao', age: 34, sex } });
      const { partnerRef } = await env.adapter.createOrder(input);
      await playOut(env, partnerRef);
      const report = await env.adapter.report(partnerRef);
      const rows = report.rows ?? [];
      assert.equal(rows.length, Object.keys(EXPECTED_MARKER).length);

      const bundle = buildBundle(report, { partner: 'fake', orderId: input.orderId, partnerRef, sequence: 1 });
      assert.ok(bundle);
      assert.equal(bundle.date, '2026-11-03');
      const fromJson = parseJsonText(JSON.stringify(bundle), `Fake lab order ${partnerRef}`);
      assert.deepEqual(fromJson.warnings, []);
      assert.equal(fromJson.detectedDate, '2026-11-03');
      for (const row of rows) {
        const m = fromJson.measurements.find(x => x.rawName === row.name);
        assert.ok(m, `missing ${row.name}`);
        assert.equal(m.markerId, EXPECTED_MARKER[row.name], row.name);
        assert.equal(m.confidence, 'high', `${row.name}: ${m.confidence}`);
        assert.equal(m.status, FLAG_STATUS[row.flag ?? ''], `${row.name} ${row.value} ${row.range}: ${m.status}`);
      }

      assert.ok(report.pdf);
      const fromPdf = parseReportPages(await pdfPages(report.pdf), `${partnerRef}.pdf`);
      assert.equal(fromPdf.detectedDate, '2026-11-03');
      const byMarker = new Map(fromJson.measurements.map(m => [m.markerId, m]));
      const pdfMarkers = fromPdf.measurements.map(m => m.markerId);
      assert.deepEqual([...pdfMarkers].sort(), [...byMarker.keys()].sort(), 'same markers from the PDF as from the bundle');
      for (const m of fromPdf.measurements) {
        const j = byMarker.get(m.markerId)!;
        assert.equal(m.value, j.value, `${m.markerId}: PDF ${m.value} vs bundle ${j.value}`);
        assert.equal(m.status, j.status, `${m.markerId}: PDF ${m.status} vs bundle ${j.status}`);
      }
    });
  }
});
