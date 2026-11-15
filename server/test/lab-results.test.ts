// Lab results into the profile, through the real app: the simulated lab's report arrives as a pending result, the
// app reads it with its own parsers (as its review screen would), and saving it makes ordinary records.
// TEST_DATABASE_URL uses PostgreSQL; otherwise in-memory PGlite.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import type { LabOrderView, LabResultView } from '../../shared/lab-bundle.ts';
import type { ProfileRecords } from '../../shared/types.ts';
import { openDatabase, type Database } from '../src/db/client.ts';
import { auditEvents, labOrders } from '../src/db/schema.ts';
import { PartnerError } from '../src/lab/partners/types.ts';
import type { TestClient } from './helpers.ts';
import { labEnv, withOverrides, type LabEnv } from './lab-helpers.ts';
// The app's own parsers, loaded by computed path so the server's type check doesn't compile frontend code.
import type { Measurement, ParseResult } from '../../src/types.ts';

interface PdfTextItem { str: string; x: number; y: number; width: number; height: number }
const appLib = (p: string) => new URL(`../../src/lib/${p}`, import.meta.url).href;
const { parseJsonText } = await import(appLib('parse/json.ts')) as { parseJsonText: (text: string, sourceFile: string) => ParseResult };
const { parseReportPages } = await import(appLib('parse/pdf-text.ts')) as { parseReportPages: (pages: { items: PdfTextItem[] }[], sourceFile: string) => ParseResult };

const migrations = fileURLToPath(new URL('../drizzle', import.meta.url));
let database: Database;
let filesDir: string;

before(async () => {
  database = await openDatabase({ url: process.env.TEST_DATABASE_URL });
  await database.migrate(migrations);
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspond-lab-results-'));
});
after(async () => {
  await database?.close();
  fs.rmSync(filesDir, { recursive: true, force: true });
});

const STEP = 1000;

/** Book, then let the lab run `steps` steps (each also runs the background jobs, including fetching reports). */
async function bookAndRun(env: LabEnv, steps: number) {
  const { c, profileId } = await env.signUp();
  const booked = await env.book(c, profileId);
  assert.ok(booked.status === 201 || booked.status === 202, JSON.stringify(booked.body));
  for (let i = 0; i < steps; i++) await env.advance(STEP);
  return { c, profileId, order: booked.body.order! };
}

const pending = async (c: TestClient, profileId: string) => (await c.json<{ results: LabResultView[] }>('GET', `/api/profiles/${profileId}/lab-results`)).results;
const records = (c: TestClient, profileId: string) => c.json<ProfileRecords>('GET', `/api/profiles/${profileId}/records`);
const order = async (c: TestClient, profileId: string, id: string) => (await c.json<{ order: LabOrderView }>('GET', `/api/profiles/${profileId}/lab-orders/${id}`)).order;

/** What the app sends after its review screen: the parsed rows, as measurement inputs. */
const reviewed = (ms: Measurement[]) => ms.map(m => ({
  markerId: m.markerId, rawName: m.rawName, value: m.value, valueText: m.valueText, unit: m.unit, range: m.range,
  status: m.status, date: m.date, sourceFile: m.sourceFile, confidence: m.confidence,
}));

/** The app's review: parse the bundle exactly as an uploaded JSON file would be. */
function review(r: LabResultView): Measurement[] {
  const parsed = parseJsonText(JSON.stringify(r.bundle), r.source);
  assert.deepEqual(parsed.warnings, []);
  return parsed.measurements;
}

async function save(c: TestClient, profileId: string, r: LabResultView, ms = review(r)) {
  return c.json<{ result: LabResultView; documentId: string | null; saved: number; replaced: number }>('POST', `/api/profiles/${profileId}/lab-results/${r.id}/save`, { measurements: reviewed(ms) });
}

async function pdfPages(bytes: Uint8Array) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, verbosity: 0 }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    pages.push({ items: tc.items.filter(i => 'str' in i).map(i => ({ str: i.str, x: i.transform[4], y: i.transform[5], width: i.width, height: i.height || Math.hypot(i.transform[2], i.transform[3]) })) });
  }
  await doc.cleanup();
  return pages;
}

describe('results into the profile', () => {
  test('a final report waits for review; saving it adds the values and the PDF to the profile and delivers the order', async () => {
    const env = labEnv(database, filesDir);
    const { c, profileId, order: o } = await bookAndRun(env, 5);
    assert.equal((await order(c, profileId, o.id)).status, 'report_ready');
    assert.deepEqual((await records(c, profileId)).measurements, [], 'nothing is added before review');

    const [r] = await pending(c, profileId);
    assert.equal(r.orderId, o.id);
    assert.equal(r.sequence, 1);
    assert.equal(r.partial, false);
    assert.equal(r.hasPdf, true);
    assert.equal(r.source, `LotusPond Test Lab (simulated) order ${o.partnerRef}`);
    assert.equal(r.bundle?.results.length, 45);

    const pdf = await c.call('GET', `/api/profiles/${profileId}/lab-results/${r.id}/report`);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');

    const ms = review(r);
    assert.equal(ms.length, 45);
    assert.ok(ms.every(m => m.markerId && m.confidence === 'high'), 'every row matched by the app');
    const out = await save(c, profileId, r, ms);
    assert.equal(out.saved, 45);
    assert.equal(out.replaced, 0);
    assert.equal(out.result.status, 'saved');

    const recs = await records(c, profileId);
    assert.equal(recs.measurements.length, 45);
    assert.ok(recs.measurements.every(m => m.sourceFile === r.source && m.documentId === out.documentId), 'labelled with the order and linked to the PDF');
    const doc = recs.documents.find(d => d.id === out.documentId);
    assert.equal(doc?.kind, 'report');
    assert.equal(doc?.contentType, 'application/pdf');
    const file = await c.call('GET', `/api/profiles/${profileId}/documents/${out.documentId}/file`);
    assert.equal(Buffer.from(await file.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');

    const after = await order(c, profileId, o.id);
    assert.equal(after.status, 'delivered');
    assert.equal(after.timeline?.at(-1)?.status, 'delivered');
    assert.deepEqual(await pending(c, profileId), []);
    assert.equal((await c.error('POST', `/api/profiles/${profileId}/lab-results/${r.id}/save`, { measurements: [] })).code, 'not_pending');
    const [row] = await database.db.select().from(labOrders).where(eq(labOrders.id, o.id));
    assert.ok((await database.db.select().from(auditEvents).where(eq(auditEvents.userId, row.userId))).some(e => e.kind === 'lab_results_saved'));
  });

  test('partial then final: the final delivery replaces what the partial one saved', async () => {
    const env = labEnv(database, filesDir, { tags: ['partial'] });
    const { c, profileId, order: o } = await bookAndRun(env, 4);
    const [part] = await pending(c, profileId);
    assert.equal(part.partial, true);
    assert.ok(!part.bundle?.results.some(x => x.name === 'HbA1c'), 'slow tests come later');
    const first = await save(c, profileId, part);
    assert.equal((await order(c, profileId, o.id)).status, 'partial_report', 'a partial result does not deliver the order');

    await env.advance(STEP);
    const [final] = await pending(c, profileId);
    assert.equal(final.sequence, 2);
    assert.equal(final.partial, false);
    const second = await save(c, profileId, final);
    assert.equal(second.replaced, first.saved);
    const recs = await records(c, profileId);
    assert.equal(recs.measurements.length, 45);
    assert.ok(recs.measurements.some(m => m.markerId === 'hba1c'));
    assert.deepEqual(recs.documents.map(d => d.id), [second.documentId], 'the partial report\'s PDF is replaced');
    assert.equal((await order(c, profileId, o.id)).status, 'delivered');
    const all = (await c.json<{ results: LabResultView[] }>('GET', `/api/profiles/${profileId}/lab-results?status=all`)).results;
    assert.deepEqual(all.map(x => [x.sequence, x.status]), [[2, 'saved'], [1, 'superseded']]);
  });

  test('an unreviewed partial result is superseded when the final one arrives', async () => {
    const env = labEnv(database, filesDir, { tags: ['partial'] });
    const { c, profileId } = await bookAndRun(env, 5);
    const results = await pending(c, profileId);
    assert.deepEqual(results.map(r => [r.sequence, r.partial]), [[2, false]]);
    const all = (await c.json<{ results: LabResultView[] }>('GET', `/api/profiles/${profileId}/lab-results?status=all`)).results;
    const old = all.find(r => r.sequence === 1)!;
    assert.equal(old.status, 'superseded');
    assert.equal(old.hasPdf, false);
    assert.equal(old.bundle, undefined);
  });

  test('an amended report after saving arrives as a new result; saving it corrects the values and keeps the order delivered', async () => {
    const env = labEnv(database, filesDir, { tags: ['amended'] });
    const { c, profileId, order: o } = await bookAndRun(env, 4);
    const [first] = await pending(c, profileId);
    await save(c, profileId, first);
    const potassium = async () => (await records(c, profileId)).measurements.find(m => m.markerId === 'potassium');
    const before = await potassium();
    assert.equal(before?.status, 'high', 'the haemolysed sample read high');
    assert.equal((await order(c, profileId, o.id)).status, 'delivered');

    await env.advance(STEP);
    const [amended] = await pending(c, profileId);
    assert.equal(amended.sequence, 2);
    await save(c, profileId, amended);
    const corrected = await potassium();
    assert.equal(corrected?.status, 'normal');
    assert.ok(corrected!.value! < before!.value!);
    assert.equal((await records(c, profileId)).measurements.filter(m => m.markerId === 'potassium').length, 1, 'replaced, not added');
    assert.equal((await order(c, profileId, o.id)).status, 'delivered');
  });

  test('a PDF-only report: the app reads the values from the PDF', async () => {
    const env = labEnv(database, filesDir, { tags: ['pdf-only'] });
    const { c, profileId } = await bookAndRun(env, 5);
    const [r] = await pending(c, profileId);
    assert.deepEqual(r.bundle?.results, []);
    const res = await c.call('GET', `/api/profiles/${profileId}/lab-results/${r.id}/report`);
    const fromPdf = parseReportPages(await pdfPages(new Uint8Array(await res.arrayBuffer())), r.source);
    assert.equal(fromPdf.measurements.length, 45);
    const out = await save(c, profileId, r, fromPdf.measurements);
    assert.equal(out.saved, 45);
    assert.equal((await records(c, profileId)).measurements.length, 45);
  });

  test('dismissing a result drops it and its PDF, and adds nothing', async () => {
    const env = labEnv(database, filesDir);
    const { c, profileId } = await bookAndRun(env, 5);
    const [r] = await pending(c, profileId);
    const d = await c.json<{ result: LabResultView }>('POST', `/api/profiles/${profileId}/lab-results/${r.id}/dismiss`, {});
    assert.equal(d.result.status, 'dismissed');
    assert.equal(d.result.hasPdf, false);
    assert.equal((await c.error('GET', `/api/profiles/${profileId}/lab-results/${r.id}/report`)).status, 404);
    assert.equal((await c.error('POST', `/api/profiles/${profileId}/lab-results/${r.id}/save`, { measurements: [] })).code, 'not_pending');
    assert.deepEqual((await records(c, profileId)).measurements, []);
    assert.deepEqual(await pending(c, profileId), []);
  });

  test('other accounts and other profiles cannot see or save a result', async () => {
    const env = labEnv(database, filesDir);
    const { c, profileId } = await bookAndRun(env, 5);
    const [r] = await pending(c, profileId);
    const { c: other, profileId: otherProfile } = await env.signUp();
    assert.equal((await other.error('GET', `/api/profiles/${profileId}/lab-results`)).status, 404);
    assert.equal((await other.error('POST', `/api/profiles/${otherProfile}/lab-results/${r.id}/save`, { measurements: [] })).status, 404);
    assert.equal((await other.error('GET', `/api/profiles/${otherProfile}/lab-results/${r.id}/report`)).status, 404);
    const member = await c.json<{ id: string }>('POST', '/api/profiles', { displayName: 'Ravi', relationship: 'partner', confirmation: 'agreed' }, 201);
    assert.equal((await c.error('POST', `/api/profiles/${member.id}/lab-results/${r.id}/save`, { measurements: [] })).status, 404, 'saved only into the profile it was booked for');
  });

  test('deleting all of a profile\'s records clears its lab results too', async () => {
    const env = labEnv(database, filesDir);
    const { c, profileId } = await bookAndRun(env, 5);
    assert.equal((await pending(c, profileId)).length, 1);
    assert.equal((await c.call('DELETE', `/api/profiles/${profileId}/records`)).status, 204);
    assert.deepEqual((await c.json<{ results: LabResultView[] }>('GET', `/api/profiles/${profileId}/lab-results?status=all`)).results, []);
  });
});

describe('fetching reports', () => {
  test('each report version is stored once, however often the order is checked', async () => {
    const env = labEnv(database, filesDir);
    const { c, profileId } = await bookAndRun(env, 5);
    for (let i = 0; i < 3; i++) await env.advance(STEP);
    assert.equal((await c.json<{ results: LabResultView[] }>('GET', `/api/profiles/${profileId}/lab-results?status=all`)).results.length, 1);
  });

  test('a failing fetch is retried with backoff, then succeeds', async () => {
    let failures = 2;
    const env = labEnv(database, filesDir, {
      wrap: real => withOverrides(real, { report: async (ref: string) => { if (failures-- > 0) throw new PartnerError('unavailable', 'down'); return real.report(ref); } }),
    });
    const { c, profileId, order: o } = await bookAndRun(env, 5);
    assert.deepEqual(await pending(c, profileId), []);
    const [row] = await database.db.select().from(labOrders).where(eq(labOrders.id, o.id));
    assert.equal(row.reportAttempts, 1);
    assert.ok(row.nextReportAt && row.nextReportAt.getTime() > env.now());
    await env.advance(60_000);
    await env.advance(2 * 60_000);
    assert.equal((await pending(c, profileId)).length, 1);
    assert.ok(env.log.lines.some(l => l.msg === 'lab report fetch failed; will retry'));
    assert.deepEqual(env.log.alerts().filter(l => l.msg === 'lab report could not be fetched'), []);
  });

  test('a fetch that keeps failing raises an alert', async () => {
    const env = labEnv(database, filesDir, {
      wrap: real => withOverrides(real, { report: async () => { throw new PartnerError('unavailable', 'down'); } }),
    });
    await bookAndRun(env, 5);
    for (let i = 0; i < 8; i++) await env.advance(61 * 60_000);
    assert.ok(env.log.alerts().some(l => l.msg === 'lab report could not be fetched'));
  });
});
