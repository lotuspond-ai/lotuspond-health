// ABHA through Eka Care's ABDM Connect, against a local copy of Eka's API (the endpoints and bodies in Eka's
// reference): signing in with a mobile number that has two ABHA addresses, a wrong OTP, renewing the gateway session,
// raising a consent and approving it with the consent PIN (after a wrong PIN), reading the FHIR bundles, checking
// again with nothing asked, the client token renewed on a 401, and the signed webhook that starts a check.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { Hono } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { RECORD_AGENT_NOTICE_VERSION, type RecordConnectionView, type RecordRunView, type SourcesInfo } from '../../shared/sources.ts';
import type { SessionInfo } from '../../shared/types.ts';
import { createApp } from '../src/app.ts';
import { singleCell } from '../src/cells.ts';
import { loadConfig } from '../src/config.ts';
import { ephemeralSecrets } from '../src/compliance/secrets.ts';
import { openDatabase, type Database } from '../src/db/client.ts';
import { recordConnections } from '../src/db/schema.ts';
import { DiskFileStore } from '../src/lib/files.ts';
import { localBrowsers } from '../src/records/browsers.ts';
import { createRecordAgent, type RecordAgent } from '../src/records/service.ts';
import { abhaFetcher, abhaLoginMethod } from '../src/records/abdm/abha.ts';
import { createEka, EkaSessionError } from '../src/records/abdm/eka.ts';
import { ekaRef, verifyEkaSignature } from '../src/records/abdm/webhook.ts';
import { makeClient, registration, type TestClient } from './helpers.ts';

const migrations = fileURLToPath(new URL('../drizzle', import.meta.url));
const OTP = '482913';
const PIN = '4321';
const OID = '171234567890123';
const SIGNING_KEY = 'test-signing-key-0123456789';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** A copy of the Eka endpoints LotusPond uses, with one person on it. */
function fakeEka() {
  const state = {
    logins: 0, loggedIn: false, revokeNextToken: false, consents: [] as unknown[], approved: [] as unknown[], log: [] as string[],
    tokens: new Set<string>(),
    hips: [{ hip_id: 'HIP-A', hip_name: 'Apollo Hospitals Hyderabad' }, { hip_id: 'HIP-B', hip_name: 'City Diagnostics' }],
    contexts: {
      'HIP-A': [{ care_context_id: 'cc-a1', display: 'Discharge summary', created_at: '2026-08-02T10:00:00Z', status: 'DataProcessed' as string | null }],
      'HIP-B': [{ care_context_id: 'cc-b1', display: 'Complete Blood Count', created_at: '2026-10-21T06:30:00Z', status: null as string | null }],
    } as Record<string, { care_context_id: string; display: string; created_at: string; status: string | null }[]>,
    inbox: [] as { id: string; created_at: string }[],
  };
  const err = (code: number, message: string, abdm?: string) => ({ code, error: message, ...(abdm ? { source_error: { code: abdm, message } } : {}) });
  const app = new Hono();
  app.post('/connect-auth/v1/account/login', async c => {
    const b = await c.req.json();
    if (b.client_id !== 'EC_TEST' || b.client_secret !== 'secret-for-tests') return c.json(err(401, 'bad client'), 401);
    const t = `tok-${++state.logins}`;
    state.tokens.add(t);
    return c.json({ access_token: t, refresh_token: `r-${t}`, expires_in: 1800, refresh_expires_in: 86400 });
  });
  app.use('/abdm/*', async (c, next) => {
    const t = c.req.header('authorization')?.replace(/^Bearer /, '') ?? '';
    if (state.revokeNextToken) { state.revokeNextToken = false; state.tokens.delete(t); }
    if (!state.tokens.has(t)) return c.json({ message: 'Unauthorized' }, 401);
    state.log.push(`${c.req.method} ${c.req.path}`);
    await next();
  });
  app.use('/health/*', async (c, next) => (state.tokens.has(c.req.header('authorization')?.replace(/^Bearer /, '') ?? '') ? next() : c.json({ message: 'Unauthorized' }, 401)));
  // Patient calls need the person's id and a live gateway session.
  const person = (c: { req: { header(n: string): string | undefined; query(n: string): string | undefined } }) => c.req.header('x-pt-id') === OID && c.req.query('oid') === OID;

  app.post('/abdm/na/v1/profile/login/init', async c => {
    const b = await c.req.json();
    if (b.method !== 'mobile' || b.identifier !== '9876543210') return c.json(err(400, 'No ABHA found', 'ABDM-1114'), 400);
    return c.json({ txn_id: 'login-1', hint: 'OTP sent to mobile number ******3210' });
  });
  app.post('/abdm/na/v1/profile/login/verify', async c => {
    const b = await c.req.json();
    if (b.txn_id !== 'login-1' || b.otp !== OTP) return c.json(err(400, 'Invalid OTP', 'ABDM-1003'), 400);
    return c.json({ txn_id: 'login-2', skip_state: 'abha_select', eka: { oid: null }, abha_profiles: [{ abha_address: 'asha.r@abdm', name: 'Asha' }, { abha_address: 'asharao@abdm', name: 'Asha Rao' }] });
  });
  app.post('/abdm/na/v1/profile/login/phr', async c => {
    const b = await c.req.json();
    assert.equal(b.txn_id, 'login-2');
    return c.json({ skip_state: 'abha_end', eka: { oid: OID }, profile: { abha_address: b.phr_address } });
  });
  app.get('/abdm/v1/session/status', c => (person(c) ? c.json({ logged_in: state.loggedIn, kyc_verified: true }) : c.json(err(400, 'who?'), 400)));
  app.post('/abdm/v1/session/init', async c => { assert.ok(person(c)); assert.equal((await c.req.json()).abha_address, 'asharao@abdm'); return c.json({ txn_id: 'sess-1' }); });
  app.post('/abdm/v1/session/verify', async c => {
    const b = await c.req.json();
    if (b.otp !== OTP) return c.json(err(400, 'Invalid OTP', 'ABDM-1003'), 400);
    state.loggedIn = true;
    return c.json({ token: 'abha-token', refresh_token: null });
  });
  const session = async (c: Parameters<typeof person>[0], next: () => Promise<void>) => { if (!state.loggedIn) return (c as unknown as { json(b: unknown, s: number): Response }).json(err(491, 'session expired'), 491); return next(); };
  app.use('/abdm/v1/care-contexts/*', session);
  app.use('/abdm/v1/consents/*', session);
  app.get('/abdm/v1/care-contexts/providers', c => c.json({ providers: state.hips }));
  app.get('/abdm/v1/care-contexts/linked', c => c.json({ care_contexts: state.contexts[c.req.query('hip_id') ?? ''] ?? null }));
  app.post('/abdm/v1/consents/create', async c => {
    const b = await c.req.json();
    state.consents.push(b);
    for (const list of Object.values(state.contexts)) for (const cc of list) if (!cc.status) cc.status = 'ConsentRaised';
    state.inbox.push({ id: `req-${state.consents.length}`, created_at: new Date().toISOString() });
    return c.body(JSON.stringify({ consent_init_id: `init-${state.consents.length}` }), 200);
  });
  app.get('/abdm/v1/requests', c => c.json({ consents: c.req.query('status') === 'requested' ? state.inbox : [], subscriptions: [], authorizations: [] }));
  app.get('/abdm/v1/consents/pin/exists', c => c.json({ exist: true }));
  app.get('/abdm/v1/request', c => c.json({
    hi_types: ['DiagnosticReport'], duration: { from: '1990-01-01T00:00:00Z', to: '2026-11-11T00:00:00Z' }, erase_at: '2027-11-11T00:00:00Z',
    providers: [{ hip: { id: 'HIP-B', name: 'City Diagnostics' }, care_contexts: [{ id: 'cc-b1', display: 'Complete Blood Count' }] }], id: c.req.query('id'),
  }));
  app.post('/abdm/v1/consents/pin/verify', async c => ((await c.req.json()).pin === PIN ? c.body(null, 204) : c.json(err(400, 'Invalid PIN', 'ABDM-1205'), 400)));
  app.post('/abdm/v1/consents/approve', async c => {
    const b = await c.req.json();
    state.approved.push(b);
    state.inbox = state.inbox.filter(r => r.id !== b.id);
    // Eka fetches the data a little later.
    setTimeout(() => { for (const list of Object.values(state.contexts)) for (const cc of list) if (cc.status === 'ConsentRaised') cc.status = 'DataProcessed'; }, 100);
    return c.body(null, 204);
  });
  app.get('/health/api/v1/fhir/retrieve', c => {
    const id = c.req.query('identifier');
    return c.json({
      resourceType: 'Bundle', type: 'document', id: `bundle-${id}`,
      entry: [
        { resource: { resourceType: 'Composition', title: id, status: 'final' } },
        { resource: { resourceType: 'Observation', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '718-7', display: 'Hemoglobin' }] }, valueQuantity: { value: 13.4, unit: 'g/dL' }, effectiveDateTime: '2026-10-21' } },
      ],
    });
  });
  return { app, state };
}

let database: Database;
let filesDir: string;
let eka: ReturnType<typeof fakeEka>;
let ekaServer: ServerType;
let ekaUrl: string;

before(async () => {
  database = await openDatabase({ url: process.env.TEST_DATABASE_URL });
  await database.migrate(migrations);
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspond-abha-'));
  eka = fakeEka();
  ekaServer = await new Promise<ServerType>(resolve => { const s = serve({ fetch: eka.app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s)); });
  ekaUrl = `http://127.0.0.1:${(ekaServer.address() as AddressInfo).port}`;
});
after(async () => {
  ekaServer?.close();
  await database?.close();
  fs.rmSync(filesDir, { recursive: true, force: true });
});

function setup() {
  const config = loadConfig({ NODE_ENV: 'test', TRUST_PROXY: 'true', EKA_CLIENT_ID: 'EC_TEST', EKA_CLIENT_SECRET: 'secret-for-tests', EKA_API_URL: ekaUrl, EKA_HIU_CLINIC_ID: 'clinic-1', EKA_HIU_DOCTOR_OID: 'doc-1', EKA_WEBHOOK_SIGNING_KEY: SIGNING_KEY });
  const files = new DiskFileStore(filesDir);
  const cells = singleCell(database.db, files);
  const secrets = ephemeralSecrets();
  const e = config.records!.eka!;
  const agent = createRecordAgent({
    cells, secrets, config: config.records!, browsers: localBrowsers(), selfUrl: 'http://127.0.0.1:1', maxBytes: config.maxUploadBytes, questionMs: 20_000,
    abdm: abhaFetcher({ eka: createEka(e), hiu: e.hiu, waitMs: 5000, pollMs: 50 }),
  });
  const app = createApp({ db: database.db, files, config, cells, secrets, records: agent });
  return { app, agent };
}

async function until(c: TestClient, runId: string, ok: (r: RecordRunView) => boolean, what: string): Promise<RecordRunView> {
  const end = Date.now() + 30_000;
  let r: RecordRunView;
  do {
    r = await c.json<RecordRunView>('GET', `/api/records/runs/${runId}`);
    if (ok(r)) return r;
    if (['succeeded', 'failed', 'cancelled'].includes(r.status)) assert.fail(`run ended ${r.status} (${r.error}) while waiting for ${what}`);
    await sleep(40);
  } while (Date.now() < end);
  assert.fail(`timed out waiting for ${what}; last: ${JSON.stringify(r)}`);
}
const asked = (c: TestClient, id: string, kind: string, what: string) => until(c, id, r => r.status === 'waiting' && r.question?.kind === kind, what);
async function endOf(c: TestClient, id: string): Promise<RecordRunView> {
  const end = Date.now() + 30_000;
  for (;;) {
    const r = await c.json<RecordRunView>('GET', `/api/records/runs/${id}`);
    if (['succeeded', 'failed', 'cancelled'].includes(r.status) || Date.now() > end) return r;
    await sleep(40);
  }
}
const answer = (c: TestClient, id: string, a: string) => c.json<RecordRunView>('POST', `/api/records/runs/${id}/answer`, { answer: a });

function signed(body: unknown, key = SIGNING_KEY, t = Math.floor(Date.now() / 1000)) {
  const raw = JSON.stringify(body);
  return { raw, header: `t=${t},v1=${createHmac('sha256', key).update(`${t}.${raw}`).digest('hex')}` };
}

describe('ABHA through Eka Care', { timeout: 120_000 }, () => {
  let app: ReturnType<typeof setup>['app'];
  let agent: RecordAgent;
  before(() => { ({ app, agent } = setup()); });
  after(() => agent.idle());

  test('reads what the person types as an address, ABHA number or mobile number', () => {
    assert.deepEqual(abhaLoginMethod('Asha.Rao@abdm'), { method: 'phr_address', identifier: 'asha.rao@abdm' });
    assert.deepEqual(abhaLoginMethod('asharao'), { method: 'phr_address', identifier: 'asharao@abdm' });
    assert.deepEqual(abhaLoginMethod('91 2345 6789 0123'), { method: 'abha_number', identifier: '91-2345-6789-0123' });
    assert.deepEqual(abhaLoginMethod('+91 98765 43210'), { method: 'mobile', identifier: '9876543210' });
    assert.equal(abhaLoginMethod('12345'), null);
    assert.equal(abhaLoginMethod('2345 6789 0123'), null, 'an Aadhaar number is not used to sign in');
  });

  test('checks webhook signatures over the raw body, within three minutes', () => {
    const now = Date.now();
    const { raw, header } = signed({ a: 1 }, SIGNING_KEY, Math.floor(now / 1000));
    assert.ok(verifyEkaSignature(header, raw, SIGNING_KEY, now));
    assert.ok(!verifyEkaSignature(header, raw.replace('1', '2'), SIGNING_KEY, now));
    assert.ok(!verifyEkaSignature(header, raw, 'another-key-0123456789', now));
    assert.ok(!verifyEkaSignature(header, raw, SIGNING_KEY, now + 181_000));
    assert.ok(!verifyEkaSignature(undefined, raw, SIGNING_KEY, now));
    assert.ok(!verifyEkaSignature('t=1,v1=zz', raw, SIGNING_KEY, now));
  });

  test('the client token is renewed on a 401; a 491 says the gateway session ended', async () => {
    const client = createEka({ apiUrl: ekaUrl, clientId: 'EC_TEST', clientSecret: 'secret-for-tests' });
    const before = eka.state.logins;
    eka.state.loggedIn = false;
    assert.deepEqual(await client.call('/abdm/v1/session/status', { oid: OID }), { logged_in: false, kyc_verified: true });
    eka.state.revokeNextToken = true;
    await client.call('/abdm/v1/session/status', { oid: OID });
    assert.equal(eka.state.logins, before + 2, 'signed in again after the 401');
    await assert.rejects(client.call('/abdm/v1/care-contexts/providers', { oid: OID }), EkaSessionError);
  });

  test('connect: sign in, renew the session, approve the consent with the PIN, save the FHIR records once', async () => {
    const c = makeClient(app);
    const info = await c.json<SessionInfo>('POST', '/api/auth/register', registration(`abha-${Date.now()}@example.com`), 201);
    const sources = await c.json<SourcesInfo>('GET', '/api/records');
    assert.equal(sources.sources.find(s => s.id === 'abha')!.availability, 'abdm');
    assert.equal(sources.sources.find(s => s.id === 'abha')!.needsUrl, false);
    eka.state.loggedIn = false;

    const { connection, run } = await c.json<{ connection: RecordConnectionView; run: RecordRunView }>('POST', '/api/records/connections',
      { sourceId: 'abha', profileId: info.profiles[0].id, refreshDays: 30, noticeVersion: RECORD_AGENT_NOTICE_VERSION }, 201);
    let r = await asked(c, run.id, 'text', 'the ABHA id');
    assert.match(r.question!.label, /ABHA address, ABHA number or mobile/);
    await answer(c, run.id, '98765 43210');
    r = await asked(c, run.id, 'otp', 'the sign-in OTP');
    assert.match(r.question!.label, /\*\*\*\*\*\*3210/);
    await answer(c, run.id, '000000');
    r = await until(c, run.id, x => x.status === 'waiting' && /not accepted/.test(x.question?.label ?? ''), 'the OTP asked again');
    await answer(c, run.id, OTP);
    r = await asked(c, run.id, 'text', 'which address');
    assert.match(r.question!.hint!, /1\. asha\.r@abdm {2}2\. asharao@abdm/);
    await answer(c, run.id, '2');
    // Signed in, but the gateway session has ended: one more OTP.
    r = await until(c, run.id, x => x.status === 'waiting' && /mobile number on your ABHA/.test(x.question?.label ?? ''), 'the session OTP');
    await answer(c, run.id, OTP);
    r = await asked(c, run.id, 'password', 'the consent PIN');
    assert.equal(r.question!.secret, true);
    assert.match(r.question!.hint!, /City Diagnostics/);
    await answer(c, run.id, '0000');
    r = await until(c, run.id, x => x.status === 'waiting' && /PIN was not accepted/.test(x.question?.label ?? ''), 'the PIN asked again');
    await answer(c, run.id, PIN);
    r = await endOf(c, run.id);
    assert.equal(r.status, 'succeeded', r.error ?? '');
    assert.equal(r.saved, 2);
    assert.deepEqual(r.documents.map(d => d.fileName).sort(), ['Apollo Hospitals Hyderabad Discharge summary.json', 'City Diagnostics Complete Blood Count.json']);

    // The consent LotusPond raised, and what was approved.
    const consent = eka.state.consents[0] as { purpose: string; patient: { health_id: string; oid: string }; hiu: { clinic_id: string; d_oid: string }; record_types: string[] };
    assert.equal(consent.purpose, 'Self Requested');
    assert.deepEqual(consent.patient, { health_id: 'asharao@abdm', oid: OID });
    assert.deepEqual(consent.hiu, { clinic_id: 'clinic-1', d_oid: 'doc-1' });
    assert.ok(consent.record_types.includes('DiagnosticReport'));
    const approved = eka.state.approved[0] as { id: string; consent_artefacts: { hip_id: string; access_mode: string }[] };
    assert.equal(approved.id, 'req-1');
    assert.deepEqual(approved.consent_artefacts.map(a => [a.hip_id, a.access_mode]), [['HIP-B', 'view']]);

    // The connection keeps the person's ABHA address (masked here) and the webhook reference, not the OTP or PIN.
    const [row] = await database.db.select().from(recordConnections).where(eq(recordConnections.id, connection.id));
    assert.equal(row.externalRef, ekaRef(OID));
    assert.ok(row.sessionCt && !Buffer.from(row.sessionCt, 'base64').toString('latin1').includes(OID), 'the Eka id is sealed');
    const views = await c.json<RecordConnectionView[]>('GET', '/api/records/connections');
    assert.equal(views[0].identifier, 'a•••abdm');
    assert.equal(views[0].signedIn, true);

    // Checking again: the session is live, nothing is asked, nothing new is saved.
    const again = await c.json<RecordRunView>('POST', `/api/records/connections/${connection.id}/run`, undefined, 201);
    const a = await endOf(c, again.id);
    assert.equal(a.status, 'succeeded', a.error ?? '');
    assert.equal(a.saved, 0);
    assert.equal(a.found, 2);
    assert.equal(eka.state.consents.length, 1, 'no second consent request');

    // A webhook about the person (a facility linked a new record) starts a check; a bad signature does not.
    eka.state.contexts['HIP-A'].push({ care_context_id: 'cc-a2', display: 'Lipid Profile', created_at: '2026-11-10T08:00:00Z', status: 'DataProcessed' });
    const event = { service: 'abdm', event: 'abha.subscription_notify', transaction_id: 'evt-1', data: { oid: OID, subscription_meta: { hip_id: 'HIP-A', care_contexts: [{ care_context_id: 'cc-a2' }] } } };
    const forged = signed(event, 'not-the-key-0123456789');
    assert.equal((await app.request('/hooks/eka', { method: 'POST', body: forged.raw, headers: { 'content-type': 'application/json', 'eka-webhook-signature': forged.header } })).status, 401);
    const good = signed(event);
    const res = await app.request('/hooks/eka', { method: 'POST', body: good.raw, headers: { 'content-type': 'application/json', 'eka-webhook-signature': good.header } });
    assert.equal(res.status, 200);
    const dup = await app.request('/hooks/eka', { method: 'POST', body: good.raw, headers: { 'content-type': 'application/json', 'eka-webhook-signature': good.header } });
    assert.deepEqual(await dup.json(), { ok: true, duplicate: true });
    await sleep(50);
    await agent.idle();
    const after = await c.json<RecordConnectionView[]>('GET', '/api/records/connections');
    assert.equal(after[0].lastRun!.trigger, 'schedule');
    assert.equal(after[0].lastRun!.saved, 1);
    assert.equal(after[0].reportsSaved, 3);

    // A scheduled check after the session ended asks nobody: the connection waits for the person.
    eka.state.loggedIn = false;
    const resend = signed({ ...event, transaction_id: 'evt-2' });
    await app.request('/hooks/eka', { method: 'POST', body: resend.raw, headers: { 'content-type': 'application/json', 'eka-webhook-signature': resend.header } });
    await sleep(50);
    await agent.idle();
    const waiting = await c.json<RecordConnectionView[]>('GET', '/api/records/connections');
    assert.equal(waiting[0].status, 'needs_sign_in');
    assert.match(waiting[0].lastRun!.error!, /sign in again/);
  });
});
