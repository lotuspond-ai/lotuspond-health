// Withings through its API, against a local copy of it (the endpoints and bodies in Withings' reference): connecting
// sends the person to Withings' sign-in page with a one-time state; the callback keeps the sign-in and starts a check;
// measurements become one value per marker per day in a FHIR bundle the app's reader turns into results; the next check
// reads only new days; an expired token is refreshed (and the new refresh token kept); a revoked sign-in asks the
// person to connect again; bad, reused or late states are refused.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
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
import { documents, recordConnections } from '../src/db/schema.ts';
import { DiskFileStore } from '../src/lib/files.ts';
import { localBrowsers } from '../src/records/browsers.ts';
import { createRecordAgent, type RecordAgent } from '../src/records/service.ts';
import { dailyReadings, dayIn, withingsFetcher } from '../src/records/api/withings.ts';
import { VITALS } from '../src/records/api/vitals.ts';
import { makeClient, registration } from './helpers.ts';

const migrations = fileURLToPath(new URL('../drizzle', import.meta.url));
const DAY = 86_400;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let clock = Date.parse('2026-11-11T12:00:00Z');
const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);

function fakeWithings() {
  const state = {
    codes: new Map([['good-code', 'user-1']]),
    access: new Map<string, number>(), refresh: new Set<string>(), issued: 0, refreshed: 0, revoked: false,
    groups: [
      // Two weigh-ins and a blood pressure reading on 1 Nov (IST), one implausible weight, a goal (category 2).
      { grpid: 1, date: at('2026-11-01T02:00:00Z'), category: 1, measures: [{ value: 72400, type: 1, unit: -3 }, { value: 1820, type: 6, unit: -2 }] },
      { grpid: 2, date: at('2026-11-01T14:00:00Z'), category: 1, measures: [{ value: 72600, type: 1, unit: -3 }] },
      { grpid: 3, date: at('2026-11-01T03:00:00Z'), category: 1, measures: [{ value: 128, type: 10, unit: 0 }, { value: 84, type: 9, unit: 0 }, { value: 71, type: 11, unit: 0 }] },
      { grpid: 4, date: at('2026-11-02T03:00:00Z'), category: 1, measures: [{ value: 9999, type: 1, unit: 0 }, { value: 97, type: 54, unit: 0 }, { value: 3680, type: 71, unit: -2 }] },
      { grpid: 5, date: at('2026-11-02T03:00:00Z'), category: 2, measures: [{ value: 70000, type: 1, unit: -3 }] },
      // Today (11 Nov): left for the next check.
      { grpid: 6, date: at('2026-11-11T03:00:00Z'), category: 1, measures: [{ value: 72000, type: 1, unit: -3 }] },
    ] as { grpid: number; date: number; category: number; measures: { value: number; type: number; unit: number }[] }[],
    measureCalls: [] as Record<string, string>[],
  };
  const issue = (userid: string) => {
    const n = ++state.issued;
    state.access.set(`acc-${n}`, clock + 3 * 3600_000);
    state.refresh.add(`ref-${n}`);
    return { status: 0, body: { userid, access_token: `acc-${n}`, refresh_token: `ref-${n}`, expires_in: 10800, scope: 'user.metrics', token_type: 'Bearer' } };
  };
  const app = new Hono();
  app.post('/v2/oauth2', async c => {
    const p = new URLSearchParams(await c.req.text());
    if (p.get('action') !== 'requesttoken' || p.get('client_id') !== 'withings-client' || p.get('client_secret') !== 'withings-secret') return c.json({ status: 503, error: 'Invalid params' });
    if (p.get('grant_type') === 'authorization_code') {
      const user = state.codes.get(p.get('code') ?? '');
      if (!user || p.get('redirect_uri') !== 'https://health.example/records/oauth/withings/callback') return c.json({ status: 503, error: 'Invalid code' });
      state.codes.delete(p.get('code')!);
      return c.json(issue(user));
    }
    if (p.get('grant_type') === 'refresh_token') {
      const r = p.get('refresh_token') ?? '';
      if (state.revoked || !state.refresh.has(r)) return c.json({ status: 503, error: 'Invalid refresh_token' });
      state.refresh.delete(r); // rotated: the old one stops working
      state.refreshed++;
      return c.json(issue('user-1'));
    }
    return c.json({ status: 503, error: 'Invalid grant_type' });
  });
  app.post('/measure', async c => {
    const token = c.req.header('authorization')?.replace(/^Bearer /, '') ?? '';
    const exp = state.access.get(token);
    if (state.revoked || !exp || exp < clock) return c.json({ status: 401, error: 'invalid_token' });
    const p = Object.fromEntries(new URLSearchParams(await c.req.text()));
    state.measureCalls.push(p);
    const from = Number(p.startdate), to = Number(p.enddate);
    const types = new Set(p.meastypes.split(',').map(Number));
    const all = state.groups.filter(g => g.date >= from && g.date <= to && String(g.category) === p.category)
      .map(g => ({ ...g, measures: g.measures.filter(m => types.has(m.type)) }));
    // Two per page, to exercise paging.
    const offset = Number(p.offset ?? 0);
    const page = all.slice(offset, offset + 2);
    const more = offset + 2 < all.length;
    return c.json({ status: 0, body: { timezone: 'Asia/Kolkata', updatetime: String(Math.floor(clock / 1000)), measuregrps: page, more: more ? 1 : 0, offset: more ? offset + 2 : 0 } });
  });
  return { app, state };
}

let database: Database;
let filesDir: string;
let withings: ReturnType<typeof fakeWithings>;
let server: ServerType;
let apiUrl: string;

before(async () => {
  database = await openDatabase({ url: process.env.TEST_DATABASE_URL });
  await database.migrate(migrations);
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspond-withings-'));
  withings = fakeWithings();
  server = await new Promise<ServerType>(resolve => { const s = serve({ fetch: withings.app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s)); });
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server?.close();
  await database?.close();
  fs.rmSync(filesDir, { recursive: true, force: true });
});

function setup() {
  const config = loadConfig({ NODE_ENV: 'test', TRUST_PROXY: 'true', PUBLIC_URL: 'https://health.example', WITHINGS_CLIENT_ID: 'withings-client', WITHINGS_CLIENT_SECRET: 'withings-secret' });
  assert.equal(config.records!.withings!.redirectUri, 'https://health.example/records/oauth/withings/callback');
  const files = new DiskFileStore(filesDir);
  const cells = singleCell(database.db, files);
  const secrets = ephemeralSecrets();
  const agent = createRecordAgent({
    cells, secrets, config: config.records!, browsers: localBrowsers(), selfUrl: 'http://127.0.0.1:1', maxBytes: config.maxUploadBytes, now: () => clock,
    apis: [withingsFetcher({ ...config.records!.withings!, apiUrl, authorizeUrl: 'https://account.withings.example/oauth2_user/authorize2', now: () => clock })],
  });
  const app = createApp({ db: database.db, files, config, cells, secrets, records: agent });
  return { app, agent };
}

describe('Withings', { timeout: 60_000 }, () => {
  let app: ReturnType<typeof setup>['app'];
  let agent: RecordAgent;
  before(() => { ({ app, agent } = setup()); });
  after(() => agent.idle());

  test('one value per marker per day, in the person’s time zone, without goals, implausible values or today', () => {
    assert.equal(dayIn(at('2026-11-01T20:00:00Z'), 'Asia/Kolkata'), '2026-11-02');
    assert.equal(dayIn(at('2026-11-01T20:00:00Z'), 'Not/AZone'), '2026-11-02', 'an unknown zone falls back to India');
    const rows = dailyReadings(withings.state.groups, 'Asia/Kolkata', '2026-11-11');
    assert.deepEqual(rows.map(r => [r.day, VITALS[r.marker].name, r.value, r.readings]), [
      ['2026-11-01', 'Body fat', 18.2, 1],
      ['2026-11-01', 'Body weight', 72.5, 2],
      ['2026-11-01', 'Diastolic blood pressure', 84, 1],
      ['2026-11-01', 'Resting heart rate', 71, 1],
      ['2026-11-01', 'Systolic blood pressure', 128, 1],
      ['2026-11-02', 'Body temperature', 36.8, 1],
      ['2026-11-02', 'Oxygen saturation (SpO2)', 97, 1],
    ]);
  });

  test('connect on Withings’ page, come back, check: a FHIR file of daily values; again: only new days', async () => {
    const c = makeClient(app);
    const info = await c.json<SessionInfo>('POST', '/api/auth/register', registration(`withings-${Date.now()}@example.com`), 201);
    const sources = await c.json<SourcesInfo>('GET', '/api/records');
    assert.equal(sources.sources.find(s => s.id === 'withings')!.availability, 'api');

    const r = await c.json<{ connection: RecordConnectionView; run: RecordRunView | null; authorizeUrl?: string }>('POST', '/api/records/connections',
      { sourceId: 'withings', profileId: info.profiles[0].id, refreshDays: 7, noticeVersion: RECORD_AGENT_NOTICE_VERSION }, 201);
    assert.equal(r.run, null);
    assert.equal(r.connection.status, 'needs_sign_in');
    const auth = new URL(r.authorizeUrl!);
    assert.equal(auth.origin + auth.pathname, 'https://account.withings.example/oauth2_user/authorize2');
    assert.equal(auth.searchParams.get('scope'), 'user.metrics');
    assert.equal(auth.searchParams.get('client_id'), 'withings-client');
    assert.equal(auth.searchParams.get('redirect_uri'), 'https://health.example/records/oauth/withings/callback');
    const stateParam = auth.searchParams.get('state')!;
    assert.ok(stateParam.length >= 40);

    // A made-up state is refused.
    assert.equal((await app.request('/records/oauth/withings/callback?state=made-up-state-0123456789abcdef&code=good-code')).status, 400);
    // Check now before signing in asks to connect instead.
    await c.json('POST', `/api/records/connections/${r.connection.id}/run`, {}, 409);

    // Back from Withings with the code: the sign-in is kept and the first check starts (no session cookie needed).
    const back = await app.request(`/records/oauth/withings/callback?state=${stateParam}&code=good-code`);
    assert.equal(back.status, 302);
    assert.match(back.headers.get('location')!, /\/app#sources$/);
    // The state works once.
    const again = await app.request(`/records/oauth/withings/callback?state=${stateParam}&code=good-code`);
    assert.equal(again.status, 400);
    assert.match(await again.text(), /already been used or has expired/);

    await sleep(20);
    await agent.idle();
    let [conn] = await c.json<RecordConnectionView[]>('GET', '/api/records/connections');
    assert.equal(conn.status, 'active');
    assert.equal(conn.lastRun!.status, 'succeeded', conn.lastRun!.error ?? '');
    assert.equal(conn.lastRun!.saved, 1);
    assert.match(conn.lastRun!.documents[0].fileName, /^Withings 2026-11-01 to 2026-11-02 \(2 days\)\.json$/);
    assert.equal(withings.state.measureCalls.length, 3, 'three pages of two measurement groups');
    assert.equal(Number(withings.state.measureCalls[0].startdate), Math.floor(clock / 1000) - 365 * DAY, 'the first check reads a year back');

    // The saved file is a FHIR bundle of vital-sign Observations with LOINC codes; tools/test-parsers.mjs checks the
    // app's reader turns one (tools/fixtures/fhir/withings-daily.json) into the vitals markers.
    const [doc] = await database.db.select().from(documents).where(eq(documents.id, conn.lastRun!.documents[0].id));
    assert.equal(doc.contentType, 'application/fhir+json');
    const bundle = JSON.parse(fs.readFileSync(path.join(filesDir, doc.storageKey), 'utf8')) as { resourceType: string; entry: { resource: { code: { coding: { code: string }[] }; effectiveDateTime: string; valueQuantity: { value: number } } }[] };
    assert.equal(bundle.resourceType, 'Bundle');
    assert.deepEqual(bundle.entry.map(e => `${e.resource.effectiveDateTime} ${e.resource.code.coding[0].code} ${e.resource.valueQuantity.value}`), [
      '2026-11-01 41982-0 18.2', '2026-11-01 29463-7 72.5', '2026-11-01 8462-4 84', '2026-11-01 40443-4 71', '2026-11-01 8480-6 128',
      '2026-11-02 8310-5 36.8', '2026-11-02 59408-5 97',
    ]);

    // Next day, after the access token has expired: refreshed (the rotated token kept), and only 11 Nov comes in.
    clock += 24 * 3600_000;
    const run2 = await c.json<RecordRunView>('POST', `/api/records/connections/${conn.id}/run`, {}, 201);
    await agent.idle();
    const r2 = await c.json<RecordRunView>('GET', `/api/records/runs/${run2.id}`);
    assert.equal(r2.status, 'succeeded', r2.error ?? '');
    assert.equal(r2.saved, 1);
    assert.match(r2.documents[0].fileName, /^Withings 2026-11-11 \(1 day\)\.json$/);
    assert.equal(withings.state.refreshed, 1);
    // A check with nothing new saves nothing.
    const run3 = await c.json<RecordRunView>('POST', `/api/records/connections/${conn.id}/run`, {}, 201);
    await agent.idle();
    assert.equal((await c.json<RecordRunView>('GET', `/api/records/runs/${run3.id}`)).saved, 0);

    // The person removes LotusPond in their Withings account: the next check asks them to connect again.
    withings.state.revoked = true;
    clock += 4 * 3600_000;
    const run4 = await c.json<RecordRunView>('POST', `/api/records/connections/${conn.id}/run`, {}, 201);
    await agent.idle();
    const r4 = await c.json<RecordRunView>('GET', `/api/records/runs/${run4.id}`);
    assert.equal(r4.status, 'failed');
    assert.match(r4.error!, /Connect again/);
    [conn] = await c.json<RecordConnectionView[]>('GET', '/api/records/connections');
    assert.equal(conn.status, 'needs_sign_in');
    // Check now now asks to connect; connecting again gives a new Withings page.
    await c.json('POST', `/api/records/connections/${conn.id}/run`, {}, 409);
    const re = await c.json<{ authorizeUrl?: string }>('POST', '/api/records/connections', { sourceId: 'withings', profileId: info.profiles[0].id, refreshDays: 7, noticeVersion: RECORD_AGENT_NOTICE_VERSION }, 201);
    assert.notEqual(new URL(re.authorizeUrl!).searchParams.get('state'), stateParam);

    // A state left too long is refused.
    clock += 16 * 60_000;
    const late = await app.request(`/records/oauth/withings/callback?state=${new URL(re.authorizeUrl!).searchParams.get('state')}&code=good-code`);
    assert.equal(late.status, 400);
    assert.match(await late.text(), /took too long/);

    // The tokens are sealed on the connection.
    const [row] = await database.db.select().from(recordConnections).where(eq(recordConnections.id, conn.id));
    assert.ok(row.sessionCt && !Buffer.from(row.sessionCt, 'base64').toString('latin1').includes('ref-'));
  });
});
