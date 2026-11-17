// The Eka Care connector against a stand-in for Eka's API, shaped from developer.eka.care (17 November 2026):
// sign-in with the client's id, secret and the clinic's sharing key; patients by mobile, clinic id or Eka id; visits
// from appointments, with prescriptions as documents; one token reused, and renewed once when Eka says it expired.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { createApp } from '../src/app.ts';
import { completeDeps } from '../src/cells.ts';
import { loadConfig } from '../src/config.ts';
import { openDatabase, type Database } from '../src/db/client.ts';
import { organisations } from '../src/db/schema.ts';
import type { Deps } from '../src/http.ts';
import { DiskFileStore } from '../src/lib/files.ts';
import { organisationRuntime } from '../src/connectors/runtime.ts';
import { resetEkaTokens } from '../src/connectors/his/eka.ts';
import { makeClient, registration } from './helpers.ts';

let database: Database;
let filesDir: string;
let deps: Deps;
let app: ReturnType<typeof createApp>;

// The stand-in for api.eka.care.
const seen: { method: string; path: string; headers: Record<string, string>; body?: unknown }[] = [];
let logins = 0;
let expireNext = false;
const ASHA = { oid: '175074536120088', username: 'UH1001', fln: 'Asha Raman', fn: 'Asha', ln: 'Raman', gen: 'F', dob: '1968-04-12', mobile: '9000001001', ccd: '+91', abha: 'asha@abdm' };
const eka = new Hono();
eka.use('*', async (c, next) => {
  const u = new URL(c.req.url);
  const body = c.req.method === 'POST' ? await c.req.raw.clone().json().catch(() => undefined) : undefined;
  seen.push({ method: c.req.method, path: u.pathname + u.search, headers: Object.fromEntries(c.req.raw.headers), body });
  await next();
});
eka.post('/connect-auth/v1/account/login', async c => {
  const b = await c.req.json() as { client_id?: string; client_secret?: string; sharing_key?: string };
  if (b.client_id !== 'EC_1431' || b.client_secret !== 'secret') return c.json({ code: 401, error: 'bad client' }, 401);
  logins++;
  return c.json({ access_token: `tok-${logins}-${b.sharing_key ?? 'own'}`, refresh_token: 'r', expires_in: 1800, refresh_expires_in: 86400 });
});
const authed = (c: { req: { header: (n: string) => string | undefined } }) => /^Bearer tok-/.test(c.req.header('authorization') ?? '');
eka.get('/profiles/v1/patient/by-mobile/', c => {
  if (!authed(c)) return c.json({}, 401);
  if (expireNext) { expireNext = false; return c.json({ error: 'expired' }, 401); }
  return c.json(c.req.query('mob') === '+919000001001' ? [ASHA] : []);
});
eka.get('/profiles/v1/patient/search', c => c.json({ error: { code: 'forbidden', message: 'Global search is not enabled' } }, 403));
eka.get('/profiles/v1/patient/:id/username/', c => (c.req.param('id') === 'UH1001' ? c.json([ASHA]) : c.json({ message: 'Not found', code: 'profile_not_found' }, 404)));
eka.get('/profiles/v1/patient/:oid', c => (c.req.param('oid') === ASHA.oid ? c.json({ ...ASHA, wid: '77088166996724' }) : c.json({ error: { message: 'not found' } }, 404)));
eka.get('/dr/v1/appointment', c => c.json({
  appointments: c.req.query('patient_id') === ASHA.oid ? [
    { appointment_id: 'apt_001', patient_id: ASHA.oid, doctor_id: 'doc_123', clinic_id: 'cln_456', status: 'CM', mode: 'in_clinic', start_time: 1730189586, end_time: 1730191386, prescription_id: 'presc_001', prescription_url: 'https://prescription-store-s3.eka.care/P-DW-1234.pdf' },
    { appointment_id: 'apt_002', patient_id: ASHA.oid, doctor_id: 'doc_123', clinic_id: 'cln_456', status: 'BK', mode: 'tele', start_time: 1731189586, end_time: 1731189586 },
  ] : [],
}));
const fakeFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  return eka.request(url.pathname + url.search, init as RequestInit);
};

before(async () => {
  database = await openDatabase({ url: process.env.TEST_DATABASE_URL });
  await database.migrate(fileURLToPath(new URL('../drizzle', import.meta.url)));
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspond-eka-'));
  deps = completeDeps({ db: database.db, files: new DiskFileStore(filesDir), config: loadConfig({ NODE_ENV: 'test', RECORD_AGENT: 'off' }) });
  app = createApp(deps, { orgFetch: fakeFetch });
});
after(async () => { await database.close(); fs.rmSync(filesDir, { recursive: true, force: true }); });
beforeEach(() => { resetEkaTokens(); seen.length = 0; logins = 0; expireNext = false; });

const api = (url: string, key: string, body: unknown) => app.request(url, {
  method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
});

/** A live organisation with an Eka connection and a key for both reads. */
async function setup(email: string, secret: Record<string, string> = { clientId: 'EC_1431', clientSecret: 'secret', sharingKey: 'clinic-share-1' }) {
  const person = makeClient(app);
  await person.json('POST', '/api/auth/register', registration(email), 201);
  const org = await person.json<{ id: string }>('POST', '/api/console/organisations', { name: 'Clinic Tools' }, 201);
  await database.db.update(organisations).set({ access: 'live' }).where(eq(organisations.id, org.id));
  const runtime = organisationRuntime({ db: database.db, keyrings: deps.secrets.fileKeys, fetch: fakeFetch });
  const conn = await runtime.addConnection(org.id, { connectorId: 'eka', name: 'Clinic on Eka', settings: { baseUrl: 'http://localhost/' }, secret });
  const { key } = await person.json<{ key: string }>('POST', `/api/console/organisations/${org.id}/keys`, { name: 'Eka', operations: ['patients.search', 'encounters.list', 'documents.upload'] }, 201);
  return { key, connection: conn.id };
}

describe('Eka Care connector', () => {
  test('signs in with the client and the clinic’s sharing key, and finds a patient by mobile as FHIR', async () => {
    const { key, connection } = await setup('eka1@example.com');
    const res = await api('/v1/operations/patients.search', key, { connection, phone: '90000 01001' });
    const out = await res.json() as { status: string; result: { entry: { resource: Record<string, unknown> & { identifier: { system: string; value: string }[]; telecom: { value: string }[] } }[] } };
    assert.equal(res.status, 200, JSON.stringify(out));
    const login = seen.find(s => s.path === '/connect-auth/v1/account/login');
    assert.deepEqual(login?.body, { client_id: 'EC_1431', client_secret: 'secret', sharing_key: 'clinic-share-1' });
    const call = seen.find(s => s.path.startsWith('/profiles/v1/patient/by-mobile/'));
    assert.match(call!.path, /mob=%2B919000001001/, 'ten digits become +91…');
    assert.match(call!.path, /full_profile=true/);
    assert.equal(call!.headers['client-id'], 'EC_1431');
    assert.equal(call!.headers.authorization, 'Bearer tok-1-clinic-share-1');
    const p = out.result.entry[0].resource;
    assert.equal(p.resourceType, 'Patient');
    assert.equal(p.id, ASHA.oid);
    assert.equal(p.gender, 'female');
    assert.equal(p.birthDate, '1968-04-12');
    assert.ok(p.identifier.some(i => i.value === 'UH1001'));
    assert.ok(p.identifier.some(i => i.value === 'asha@abdm'));
    assert.equal(p.telecom[0].value, '+919000001001');
    assert.ok(!JSON.stringify(out).includes('secret'), 'no credentials in the answer');
  });

  test('by the clinic’s patient id, then by Eka’s id; one sign-in for both calls', async () => {
    const { key, connection } = await setup('eka2@example.com');
    const byUhid = await (await api('/v1/operations/patients.search', key, { connection, identifier: 'UH1001' })).json() as { result: { total: number } };
    assert.equal(byUhid.result.total, 1);
    const byOid = await (await api('/v1/operations/patients.search', key, { connection, identifier: ASHA.oid })).json() as { result: { entry: { resource: { id: string } }[] } };
    assert.equal(byOid.result.entry[0].resource.id, ASHA.oid, 'an all-digit id that is no clinic id is tried as an Eka id');
    const none = await (await api('/v1/operations/patients.search', key, { connection, identifier: 'NOPE' })).json() as { result: { total: number } };
    assert.equal(none.result.total, 0);
    assert.equal(logins, 1, 'the token is reused');
  });

  test('a workspace without name search says so plainly', async () => {
    const { key, connection } = await setup('eka3@example.com');
    const res = await api('/v1/operations/patients.search', key, { connection, name: 'Asha' });
    assert.equal(res.status, 422);
    assert.equal((await res.json() as { error: { code: string } }).error.code, 'name_search_unavailable');
  });

  test('visits come from appointments, newest first, with the prescription as a document', async () => {
    const { key, connection } = await setup('eka4@example.com');
    const res = await api('/v1/operations/encounters.list', key, { connection, patient: ASHA.oid });
    const out = await res.json() as { result: { entry: { resource: Record<string, unknown> }[] } };
    assert.equal(res.status, 200, JSON.stringify(out));
    const r = out.result.entry.map(e => e.resource);
    assert.deepEqual(r.map(x => `${x.resourceType}/${x.id}`), ['Encounter/apt_002', 'Encounter/apt_001', 'DocumentReference/presc_001']);
    assert.equal(r[0].status, 'planned');
    assert.equal((r[0].class as { code: string }).code, 'VR', 'tele becomes a virtual visit');
    assert.equal(r[1].status, 'finished');
    assert.equal((r[1].period as { start: string }).start, '2024-10-29T08:13:06.000Z');
    const doc = r[2] as { content: { attachment: { url: string; contentType: string } }[]; context: { encounter: { reference: string }[] } };
    assert.equal(doc.content[0].attachment.contentType, 'application/pdf');
    assert.equal(doc.context.encounter[0].reference, 'Encounter/apt_001');
    assert.equal((await api('/v1/operations/encounters.list', key, { connection, patient: '999999' })).status, 404);
  });

  test('an expired token is renewed once; bad client credentials are refused without leaking them', async () => {
    const { key, connection } = await setup('eka5@example.com');
    await api('/v1/operations/patients.search', key, { connection, phone: '+919000001001' });
    expireNext = true;
    const res = await api('/v1/operations/patients.search', key, { connection, phone: '+919000001001' });
    assert.equal(res.status, 200);
    assert.equal(logins, 2, 'signed in again after the 401');

    const bad = await setup('eka6@example.com', { clientId: 'EC_1431', clientSecret: 'wrong' });
    const refused = await api('/v1/operations/patients.search', bad.key, { connection: bad.connection, phone: '+919000001001' });
    assert.equal(refused.status, 502);
    const text = await refused.text();
    assert.match(text, /system_refused/);
    assert.ok(!text.includes('wrong'));
  });

  test('uploads are not offered on Eka connections, and are refused before anything is held', async () => {
    const { key, connection } = await setup('eka7@example.com');
    const res = await api('/v1/operations/documents.upload', key, { connection, patient: ASHA.oid, title: 'Note', contentType: 'text/plain', data: Buffer.from('x').toString('base64') });
    assert.equal(res.status, 422);
    assert.equal((await res.json() as { error: { code: string } }).error.code, 'not_supported');
  });
});
