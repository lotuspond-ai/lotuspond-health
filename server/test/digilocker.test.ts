// DigiLocker through its Authorized Partner API, against a local copy of it (the endpoints and bodies in the
// specification v2.0): PKCE on the sign-in, only health documents (issued and uploaded, never identity documents),
// each file's hmac checked before it is saved, and no schedule: DigiLocker gives no refresh token, so every check
// starts on its page.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { Hono } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import { RECORD_AGENT_NOTICE_VERSION, type RecordConnectionView, type RecordRunView, type SourcesInfo } from '../../shared/sources.ts';
import type { SessionInfo } from '../../shared/types.ts';
import { createApp } from '../src/app.ts';
import { singleCell } from '../src/cells.ts';
import { loadConfig } from '../src/config.ts';
import { ephemeralSecrets } from '../src/compliance/secrets.ts';
import { openDatabase, type Database } from '../src/db/client.ts';
import { DiskFileStore } from '../src/lib/files.ts';
import { localBrowsers } from '../src/records/browsers.ts';
import { createRecordAgent, type RecordAgent } from '../src/records/service.ts';
import { digilockerFetcher, hmacOk, isHealthIssued, isHealthUpload } from '../src/records/api/digilocker.ts';
import { makeClient, registration } from './helpers.ts';

const migrations = fileURLToPath(new URL('../drizzle', import.meta.url));
const SECRET = 'digilocker-secret-123';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const pdf = (s: string) => Buffer.from(`%PDF-1.4\n% ${s}\n%%EOF\n`);

function fakeDigiLocker() {
  const files = new Map<string, Buffer>([
    ['in.gov.cowin-VACER-1234', pdf('covid vaccination')],
    ['com.starhealth-HLPOL-5678', pdf('health policy')],
    ['in.gov.uidai-ADHAR-1', pdf('aadhaar')],
    ['in.gov.pan-PANCR-1', pdf('pan')],
    ['upload-1', pdf('blood test')],
    ['upload-2', pdf('passport')],
    ['upload-3', pdf('discharge summary')],
    ['upload-4', pdf('electricity bill')],
    ['upload-5', pdf('xray tampered')],
  ]);
  const state = { challenges: new Map<string, string>(), access: new Set<string>(), downloads: [] as string[], tamper: new Set(['upload-5']) };
  const app = new Hono();
  app.post('/public/oauth2/2/token', async c => {
    const p = Object.fromEntries(new URLSearchParams(await c.req.text()));
    if (p.client_id !== 'DLCLIENT' || p.client_secret !== SECRET || p.grant_type !== 'authorization_code') return c.json({ error: 'invalid_client' }, 401);
    const challenge = state.challenges.get(p.code);
    if (!challenge || createHash('sha256').update(p.code_verifier ?? '').digest('base64url') !== challenge) return c.json({ error: 'invalid_grant', error_description: 'code_verifier mismatch' }, 400);
    state.challenges.delete(p.code);
    const t = `acc-${state.access.size + 1}`;
    state.access.add(t);
    // Version 2.0: no refresh token.
    return c.json({ access_token: t, expires_in: 3600, token_type: 'Bearer', scope: 'openid', id_token: 'x.y.z' });
  });
  app.use('/public/oauth2/1/*', async (c, next) => (state.access.has(c.req.header('authorization')?.replace(/^Bearer /, '') ?? '') ? next() : c.json({ error: 'invalid_token' }, 401)));
  app.use('/public/oauth2/2/files/*', async (c, next) => (state.access.has(c.req.header('authorization')?.replace(/^Bearer /, '') ?? '') ? next() : c.json({ error: 'invalid_token' }, 401)));
  app.get('/public/oauth2/2/files/issued', c => c.json({ items: [
    { name: 'COVID-19 Vaccination Certificate', type: 'file', size: '', date: ' 2022-01-15T10:00:00Z', parent: '', mime: 'application/pdf', uri: 'in.gov.cowin-VACER-1234', doctype: 'VACER', description: 'Vaccination Certificate', issuerid: 'in.gov.cowin', issuer: 'CoWIN' },
    { name: 'Health Insurance Policy', type: 'file', size: '', date: '2025-04-01T00:00:00Z', parent: '', mime: ['application/pdf', 'application/xml'], uri: 'com.starhealth-HLPOL-5678', doctype: 'HLPOL', description: 'Health Insurance Policy', issuerid: 'com.starhealth', issuer: 'Star Health' },
    { name: 'Aadhaar Card', type: 'file', mime: 'application/pdf', uri: 'in.gov.uidai-ADHAR-1', doctype: 'ADHAR', description: 'Aadhaar Card', issuer: 'UIDAI' },
    { name: 'PAN Verification Record', type: 'file', mime: 'application/pdf', uri: 'in.gov.pan-PANCR-1', doctype: 'PANCR', description: 'PAN Verification Record', issuer: 'Income Tax Department' },
  ] }));
  const folders: Record<string, unknown[]> = {
    '': [
      { name: 'Blood test report Oct.pdf', type: 'file', size: '1200', date: '2026-10-20', mime: 'application/pdf', uri: 'upload-1' },
      { name: 'Passport.pdf', type: 'file', size: '900', mime: 'application/pdf', uri: 'upload-2' },
      { name: 'Medical', type: 'dir', id: 'dir-medical', mime: '', uri: '' },
      { name: 'Bills', type: 'dir', id: 'dir-bills', mime: '', uri: '' },
    ],
    'dir-medical': [
      { name: 'Discharge summary Apollo.pdf', type: 'file', mime: 'application/pdf', uri: 'upload-3', date: '2026-02-02' },
      { name: 'Chest X-ray.pdf', type: 'file', mime: 'application/pdf', uri: 'upload-5', date: '2026-03-03' },
    ],
    'dir-bills': [{ name: 'Electricity bill.pdf', type: 'file', mime: 'application/pdf', uri: 'upload-4' }],
  };
  app.get('/public/oauth2/1/files/', c => c.json({ directory: '/', items: folders[''] }));
  app.get('/public/oauth2/1/files/:id', c => c.json({ directory: c.req.param('id'), items: folders[c.req.param('id')] ?? [] }));
  app.get('/public/oauth2/1/file/:uri', c => {
    const uri = decodeURIComponent(c.req.param('uri'));
    state.downloads.push(uri);
    const bytes = files.get(uri);
    if (!bytes) return c.json({ error: 'invalid_uri' }, 404);
    const hmac = createHmac('sha256', state.tamper.has(uri) ? 'wrong-key' : SECRET).update(bytes).digest('base64');
    return c.body(new Uint8Array(bytes), 200, { 'Content-Type': 'application/pdf', 'Content-Length': String(bytes.length), hmac });
  });
  return { app, state };
}

let database: Database;
let filesDir: string;
let dl: ReturnType<typeof fakeDigiLocker>;
let server: ServerType;
let apiUrl: string;

before(async () => {
  database = await openDatabase({ url: process.env.TEST_DATABASE_URL });
  await database.migrate(migrations);
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspond-digilocker-'));
  dl = fakeDigiLocker();
  server = await new Promise<ServerType>(resolve => { const s = serve({ fetch: dl.app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s)); });
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server?.close();
  await database?.close();
  fs.rmSync(filesDir, { recursive: true, force: true });
});

function setup(maxReports?: number) {
  const config = loadConfig({ NODE_ENV: 'test', TRUST_PROXY: 'true', PUBLIC_URL: 'https://health.example', DIGILOCKER_CLIENT_ID: 'DLCLIENT', DIGILOCKER_CLIENT_SECRET: SECRET, DIGILOCKER_API_URL: apiUrl });
  const r = config.records!;
  assert.equal(r.digilocker!.redirectUri, 'https://health.example/records/oauth/digilocker/callback');
  const files = new DiskFileStore(filesDir);
  const cells = singleCell(database.db, files);
  const secrets = ephemeralSecrets();
  const agent = createRecordAgent({
    cells, secrets, config: r, browsers: localBrowsers(), selfUrl: 'http://127.0.0.1:1', maxBytes: config.maxUploadBytes, ...(maxReports ? { maxReports } : {}),
    apis: [digilockerFetcher(r.digilocker!, { apiUrl: r.digilocker!.apiUrl })],
  });
  return { app: createApp({ db: database.db, files, config, cells, secrets, records: agent }), agent };
}

describe('DigiLocker', { timeout: 60_000 }, () => {
  let app: ReturnType<typeof setup>['app'];
  let agent: RecordAgent;
  before(() => { ({ app, agent } = setup()); });
  after(() => agent.idle());

  test('health documents only, never identity documents; the hmac must match', () => {
    assert.ok(isHealthIssued({ description: 'Vaccination Certificate', issuer: 'CoWIN' }));
    assert.ok(isHealthIssued({ description: 'Health Insurance Policy', issuer: 'Star Health' }));
    assert.ok(isHealthIssued({ description: 'Ayushman Card', issuer: 'NHA' }));
    assert.ok(!isHealthIssued({ description: 'Aadhaar Card', issuer: 'UIDAI' }));
    assert.ok(!isHealthIssued({ description: 'Vehicle Fitness Certificate', issuer: 'MoRTH' }));
    assert.ok(!isHealthIssued({ description: 'Class XII Marksheet', issuer: 'CBSE' }));
    assert.ok(isHealthUpload({ type: 'file', uri: 'u', name: 'MRI brain.pdf' }));
    assert.ok(!isHealthUpload({ type: 'file', uri: 'u', name: 'Electricity bill.pdf' }));
    assert.ok(!isHealthUpload({ type: 'file', uri: 'u', name: 'Aadhaar report.pdf' }), 'identity wins over the word "report"');
    // Not health, though they contain "ct", "test" or "insurance".
    assert.ok(!isHealthUpload({ type: 'file', uri: 'u', name: 'contract.pdf' }));
    assert.ok(!isHealthUpload({ type: 'file', uri: 'u', name: 'latest bank statement.pdf' }));
    assert.ok(!isHealthIssued({ description: 'Life Insurance Policy', issuer: 'LIC' }));
    assert.ok(!isHealthIssued({ description: 'Motor Insurance Policy', issuer: 'ICICI Lombard' }));
    assert.ok(isHealthUpload({ type: 'file', uri: 'u', name: 'Blood_test_report.pdf' }));
    assert.ok(isHealthUpload({ type: 'file', uri: 'u', name: 'CT scan report.pdf' }));
    const b = new Uint8Array(Buffer.from('abc'));
    assert.ok(hmacOk(b, createHmac('sha256', SECRET).update(b).digest('base64'), SECRET));
    assert.ok(!hmacOk(b, createHmac('sha256', 'other').update(b).digest('base64'), SECRET));
    assert.ok(!hmacOk(b, null, SECRET));
  });

  test('connect: PKCE sign-in, health documents saved, no schedule, and each check starts on DigiLocker’s page', async () => {
    const c = makeClient(app);
    const info = await c.json<SessionInfo>('POST', '/api/auth/register', registration(`dl-${Date.now()}@example.com`), 201);
    const src = (await c.json<SourcesInfo>('GET', '/api/records')).sources.find(s => s.id === 'digilocker')!;
    assert.equal(src.availability, 'api', 'the API takes over from the browser');
    assert.equal(src.oneTime, true);
    assert.equal(src.needsUrl, false);

    const r = await c.json<{ connection: RecordConnectionView; run: RecordRunView | null; authorizeUrl?: string }>('POST', '/api/records/connections',
      { sourceId: 'digilocker', profileId: info.profiles[0].id, refreshDays: 30, noticeVersion: RECORD_AGENT_NOTICE_VERSION }, 201);
    assert.equal(r.connection.refreshDays, null, 'no schedule');
    const auth = new URL(r.authorizeUrl!);
    assert.equal(auth.origin + auth.pathname, `${apiUrl}/public/oauth2/1/authorize`);
    assert.equal(auth.searchParams.get('scope'), 'openid');
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
    const challenge = auth.searchParams.get('code_challenge')!;
    assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);

    // DigiLocker sends the person back; the verifier must match the challenge.
    dl.state.challenges.set('good-code', challenge);
    const back = await app.request(`/records/oauth/digilocker/callback?state=${auth.searchParams.get('state')}&code=good-code`);
    assert.equal(back.status, 302, await back.text());
    await sleep(20);
    await agent.idle();
    const [conn] = await c.json<RecordConnectionView[]>('GET', '/api/records/connections');
    const run = conn.lastRun!;
    assert.equal(run.status, 'succeeded', run.error ?? '');
    assert.deepEqual(run.documents.map(d => d.fileName).sort(), [
      'DigiLocker Blood test report Oct.pdf', 'DigiLocker COVID-19 Vaccination Certificate.pdf', 'DigiLocker Discharge summary Apollo.pdf', 'DigiLocker Health Insurance Policy.pdf',
    ]);
    assert.ok(!dl.state.downloads.some(u => /ADHAR|PANCR|upload-2|upload-4/.test(u)), `identity documents and bills are never downloaded: ${dl.state.downloads.join(', ')}`);
    assert.match(run.note ?? '', /1 document did not pass DigiLocker’s integrity check/);

    // No schedule can be set, and Check now asks to go to DigiLocker's page again.
    assert.equal((await c.error('PATCH', `/api/records/connections/${conn.id}`, { refreshDays: 30 })).code, 'no_schedule');
    assert.equal((await c.error('POST', `/api/records/connections/${conn.id}/run`, {})).code, 'oauth_needed');
    const again = await c.json<{ authorizeUrl?: string; run: RecordRunView | null }>('POST', '/api/records/connections',
      { sourceId: 'digilocker', profileId: info.profiles[0].id, refreshDays: null, noticeVersion: RECORD_AGENT_NOTICE_VERSION }, 201);
    assert.ok(again.authorizeUrl, 'connecting again opens DigiLocker even though the connection is active');
    assert.equal(again.run, null);

    // A second approval saves only what is new.
    const auth2 = new URL(again.authorizeUrl!);
    dl.state.challenges.set('code-2', auth2.searchParams.get('code_challenge')!);
    assert.equal((await app.request(`/records/oauth/digilocker/callback?state=${auth2.searchParams.get('state')}&code=code-2`)).status, 302);
    await sleep(20);
    await agent.idle();
    const [conn2] = await c.json<RecordConnectionView[]>('GET', '/api/records/connections');
    assert.equal(conn2.lastRun!.status, 'succeeded');
    assert.equal(conn2.lastRun!.saved, 0);
    assert.equal(conn2.reportsSaved, 4);

    // A code with the wrong verifier (someone else's state) is refused.
    const third = await c.json<{ authorizeUrl?: string }>('POST', '/api/records/connections', { sourceId: 'digilocker', profileId: info.profiles[0].id, refreshDays: null, noticeVersion: RECORD_AGENT_NOTICE_VERSION }, 201);
    dl.state.challenges.set('code-3', challenge);
    const bad = await app.request(`/records/oauth/digilocker/callback?state=${new URL(third.authorizeUrl!).searchParams.get('state')}&code=code-3`);
    assert.equal(bad.status, 400);
  });

  test('more health documents than one check saves: the rest come in on the next approval, none downloaded twice', async () => {
    const small = setup(2);
    const c = makeClient(small.app);
    const info = await c.json<SessionInfo>('POST', '/api/auth/register', registration(`dl-small-${Date.now()}@example.com`), 201);
    const approve = async (code: string) => {
      const r = await c.json<{ authorizeUrl?: string }>('POST', '/api/records/connections', { sourceId: 'digilocker', profileId: info.profiles[0].id, refreshDays: null, noticeVersion: RECORD_AGENT_NOTICE_VERSION }, 201);
      const auth = new URL(r.authorizeUrl!);
      dl.state.challenges.set(code, auth.searchParams.get('code_challenge')!);
      assert.equal((await small.app.request(`/records/oauth/digilocker/callback?state=${auth.searchParams.get('state')}&code=${code}`)).status, 302);
      await sleep(20);
      await small.agent.idle();
      return (await c.json<RecordConnectionView[]>('GET', '/api/records/connections'))[0].lastRun!;
    };
    dl.state.downloads = [];
    const first = await approve('small-1');
    assert.equal(first.saved, 2);
    assert.match(first.note ?? '', /more health documents/);
    const before = dl.state.downloads.length;
    const second = await approve('small-2');
    assert.equal(second.saved, 2, 'the next two; the tampered X-ray is not saved');
    assert.ok(!dl.state.downloads.slice(before).some(u => /VACER|HLPOL/.test(u)), 'documents already saved are not downloaded again');
    const third = await approve('small-3');
    assert.equal(third.saved, 0);
    await small.agent.idle();
  });
});
