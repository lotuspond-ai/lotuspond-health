// Oura and Ultrahuman through their APIs, against local copies of them (the endpoints and bodies in their
// references): the sign-in page and its scopes, the callback, one value per marker per day in a FHIR file, the next
// check reading only new days (and again a day the ring synced late), a refreshed token whose rotated refresh token is
// kept, a lapsed Oura membership, and Ultrahuman's CGM average once that scope is granted.
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
import { RECORD_AGENT_NOTICE_VERSION, sourceById, type RecordConnectionView, type RecordRunView, type SourcesInfo } from '../../shared/sources.ts';
import type { SessionInfo } from '../../shared/types.ts';
import { createApp } from '../src/app.ts';
import { singleCell } from '../src/cells.ts';
import { loadConfig } from '../src/config.ts';
import { ephemeralSecrets } from '../src/compliance/secrets.ts';
import { openDatabase, type Database } from '../src/db/client.ts';
import { documents } from '../src/db/schema.ts';
import { DiskFileStore } from '../src/lib/files.ts';
import { localBrowsers } from '../src/records/browsers.ts';
import { createRecordAgent, type RecordAgent } from '../src/records/service.ts';
import { ouraDaily, ouraFetcher } from '../src/records/api/oura.ts';
import { ultrahumanDay, ultrahumanFetcher } from '../src/records/api/ultrahuman.ts';
import type { ApiContext } from '../src/records/api/types.ts';
import { RunStoppedError } from '../src/records/recipes/types.ts';
import { makeClient, registration, type TestClient } from './helpers.ts';

const migrations = fileURLToPath(new URL('../drizzle', import.meta.url));
let clock = Date.parse('2026-11-12T06:00:00Z'); // 11:30 in India: "yesterday" is 11 Nov
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** A standard OAuth 2 token endpoint with single-use refresh tokens, and a Bearer check. */
function oauthServer(clientId: string) {
  const s = { codes: new Set(['good-code']), access: new Map<string, number>(), refresh: new Set<string>(), n: 0, refreshed: 0, revoked: false };
  const issue = () => {
    const n = ++s.n;
    s.access.set(`acc-${n}`, clock + 86_400_000);
    s.refresh.add(`ref-${n}`);
    return { access_token: `acc-${n}`, token_type: 'Bearer', expires_in: 86_400, refresh_token: `ref-${n}` };
  };
  const token = async (c: { req: { text(): Promise<string> }; json(b: unknown, s?: number): Response }) => {
    const p = new URLSearchParams(await c.req.text());
    if (p.get('client_id') !== clientId || p.get('client_secret') !== 'test-secret-123') return c.json({ error: 'invalid_client' }, 401);
    if (p.get('grant_type') === 'authorization_code' && s.codes.delete(p.get('code') ?? '')) return c.json(issue());
    if (p.get('grant_type') === 'refresh_token' && !s.revoked && s.refresh.delete(p.get('refresh_token') ?? '')) { s.refreshed++; return c.json(issue()); }
    return c.json({ error: 'invalid_grant' }, 400);
  };
  const authed = (h: string | undefined) => { const exp = s.access.get(h?.replace(/^Bearer /, '') ?? ''); return !s.revoked && !!exp && exp > clock; };
  return { s, token, authed };
}

function fakeOura() {
  const o = oauthServer('oura-client-id');
  const state = { lapsed: false, calls: [] as string[],
    sleep: [
      { day: '2026-11-09', type: 'long_sleep', total_sleep_duration: 25000, lowest_heart_rate: 52, average_breath: 14.25 },
      { day: '2026-11-09', type: 'late_nap', total_sleep_duration: 1800, lowest_heart_rate: 61, average_breath: 15 },
      { day: '2026-11-10', type: 'long_sleep', total_sleep_duration: 26000, lowest_heart_rate: 54, average_breath: 13.75 },
      { day: '2026-11-10', type: 'rest', lowest_heart_rate: 70 },
      { day: '2026-11-11', type: 'long_sleep', total_sleep_duration: 27000, lowest_heart_rate: 51, average_breath: 14 },
      { day: '2026-11-12', type: 'long_sleep', total_sleep_duration: 27000, lowest_heart_rate: 50, average_breath: 14 },
    ] as Record<string, unknown>[],
    spo2: [{ day: '2026-11-09', spo2_percentage: { average: 96.6 } }, { day: '2026-11-10', spo2_percentage: null }, { day: '2026-11-11', spo2_percentage: { average: 97.2 } }] as Record<string, unknown>[],
  };
  const app = new Hono();
  app.post('/oauth/token', c => o.token(c));
  const list = (rows: Record<string, unknown>[]) => (c: { req: { header(n: string): string | undefined; query(n: string): string | undefined; url: string }; json(b: unknown, s?: number): Response }) => {
    if (!o.authed(c.req.header('authorization'))) return c.json({ detail: 'Unauthorized' }, 401);
    if (state.lapsed) return c.json({ detail: 'Membership required' }, 403);
    state.calls.push(new URL(c.req.url).pathname + new URL(c.req.url).search);
    const from = c.req.query('start_date')!, to = c.req.query('end_date')!;
    const all = rows.filter(r => String(r.day) >= from && String(r.day) <= to);
    // Two per page, to exercise next_token.
    const at = Number(c.req.query('next_token') ?? 0);
    return c.json({ data: all.slice(at, at + 2), next_token: at + 2 < all.length ? String(at + 2) : null });
  };
  app.get('/v2/usercollection/sleep', list(state.sleep));
  app.get('/v2/usercollection/daily_spo2', list(state.spo2));
  return { app, state, oauth: o.s };
}

function fakeUltrahuman() {
  const o = oauthServer('uh-client-id');
  const days: Record<string, { type: string; object?: unknown }[]> = {
    '2026-11-10': [
      { type: 'hr', object: { values: [{ timestamp: 1, value: 70 }], last_reading: 70 } },
      { type: 'night_rhr', object: { values: [{ timestamp: 1, value: 58 }, { timestamp: 2, value: 57 }], avg: 57 } },
      { type: 'sleep_rhr', object: { value: 56 } },
      { type: 'Sleep', object: { spo2: { value: 97, is_beta: true }, respiratory_graph: { gist_object: { avg: 14, min: 9, max: 19 } } } },
      { type: 'average_glucose', object: { value: 104 } },
      { type: 'hba1c', object: { value: 5.4 } },
    ],
    // No sleep_rhr: the last night_rhr value is used. No glucose.
    '2026-11-11': [
      { type: 'night_rhr', object: { values: [{ timestamp: 1, value: 59 }] } },
      { type: 'Sleep', object: { spo2: { value: 96 } } },
      { type: 'hr' },
    ],
  };
  const state = { calls: [] as string[], days };
  const app = new Hono();
  app.post('/api/partners/oauth/token', c => o.token(c));
  app.get('/api/partners/v1/user_data/metrics', c => {
    if (!o.authed(c.req.header('authorization'))) return c.json({ error: 'unauthorized' }, 401);
    const date = c.req.query('date')!;
    state.calls.push(date);
    return c.json({ data: { metric_data: state.days[date] ?? [{ type: 'hr' }, { type: 'recovery_index', object: { value: null } }], latest_time_zone: 'Asia/Kolkata' }, status: 200 });
  });
  return { app, state, oauth: o.s };
}

let database: Database;
let filesDir: string;
const servers: ServerType[] = [];
async function host(app: Hono): Promise<string> {
  const s = await new Promise<ServerType>(resolve => { const x = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(x)); });
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
let oura: ReturnType<typeof fakeOura>;
let uh: ReturnType<typeof fakeUltrahuman>;
let ouraUrl: string;
let uhUrl: string;

before(async () => {
  database = await openDatabase({ url: process.env.TEST_DATABASE_URL });
  await database.migrate(migrations);
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspond-rings-'));
  oura = fakeOura();
  uh = fakeUltrahuman();
  ouraUrl = await host(oura.app);
  uhUrl = await host(uh.app);
});
after(async () => {
  for (const s of servers) s.close();
  await database?.close();
  fs.rmSync(filesDir, { recursive: true, force: true });
});

function setup() {
  const config = loadConfig({
    NODE_ENV: 'test', TRUST_PROXY: 'true', PUBLIC_URL: 'https://health.example',
    OURA_CLIENT_ID: 'oura-client-id', OURA_CLIENT_SECRET: 'test-secret-123',
    ULTRAHUMAN_CLIENT_ID: 'uh-client-id', ULTRAHUMAN_CLIENT_SECRET: 'test-secret-123', ULTRAHUMAN_CGM: 'on',
  });
  const r = config.records!;
  assert.equal(r.oura!.redirectUri, 'https://health.example/records/oauth/oura/callback');
  assert.equal(r.ultrahuman!.redirectUri, 'https://health.example/records/oauth/ultrahuman/callback');
  const files = new DiskFileStore(filesDir);
  const cells = singleCell(database.db, files);
  const secrets = ephemeralSecrets();
  const now = () => clock;
  const agent = createRecordAgent({
    cells, secrets, config: r, browsers: localBrowsers(), selfUrl: 'http://127.0.0.1:1', maxBytes: config.maxUploadBytes, now,
    apis: [
      ouraFetcher(r.oura!, { apiUrl: ouraUrl, tokenUrl: `${ouraUrl}/oauth/token`, authorizeUrl: 'https://cloud.ouraring.example/oauth/authorize', now }),
      ultrahumanFetcher(r.ultrahuman!, { cgm: r.ultrahuman!.cgm, apiUrl: uhUrl, tokenUrl: `${uhUrl}/api/partners/oauth/token`, authorizeUrl: 'https://auth.ultrahuman.example/authorise', now }),
    ],
  });
  return { app: createApp({ db: database.db, files, config, cells, secrets, records: agent }), agent };
}

/** Connect a source, come back from its sign-in page, and wait for the first check. */
async function connect(app: ReturnType<typeof setup>['app'], agent: RecordAgent, c: TestClient, profileId: string, sourceId: string) {
  const r = await c.json<{ connection: RecordConnectionView; run: RecordRunView | null; authorizeUrl?: string }>('POST', '/api/records/connections',
    { sourceId, profileId, refreshDays: 7, noticeVersion: RECORD_AGENT_NOTICE_VERSION }, 201);
  const auth = new URL(r.authorizeUrl!);
  const back = await app.request(`/records/oauth/${sourceId}/callback?state=${auth.searchParams.get('state')}&code=good-code`);
  assert.equal(back.status, 302, await back.text());
  await sleep(20);
  await agent.idle();
  const conn = (await c.json<RecordConnectionView[]>('GET', '/api/records/connections')).find(x => x.sourceId === sourceId)!;
  return { auth, conn };
}

async function bundleOf(docId: string) {
  const [doc] = await database.db.select().from(documents).where(eq(documents.id, docId));
  assert.equal(doc.contentType, 'application/fhir+json');
  const b = JSON.parse(fs.readFileSync(path.join(filesDir, doc.storageKey), 'utf8')) as { entry: { resource: { code: { coding: { code: string }[] }; effectiveDateTime: string; valueQuantity: { value: number } } }[] };
  return b.entry.map(e => `${e.resource.effectiveDateTime} ${e.resource.code.coding[0].code} ${e.resource.valueQuantity.value}`);
}

describe('Oura and Ultrahuman', { timeout: 60_000 }, () => {
  let app: ReturnType<typeof setup>['app'];
  let agent: RecordAgent;
  before(() => { ({ app, agent } = setup()); });
  after(() => agent.idle());

  test('read the right night and fall back sensibly', () => {
    const rows = ouraDaily(oura.state.sleep as never, oura.state.spo2 as never);
    const hr = rows.filter(r => r.marker === 'resting_heart_rate').map(r => `${r.day} ${r.value}`).sort();
    assert.deepEqual(hr, ['2026-11-09 52', '2026-11-10 54', '2026-11-11 51', '2026-11-12 50'], 'the main sleep, not the nap or rest');
    assert.deepEqual(ultrahumanDay('2026-11-11', uh.state.days['2026-11-11'] as never).map(r => `${r.marker} ${r.value}`), ['resting_heart_rate 59', 'spo2 96']);
  });

  test('Oura: sign in, a year of nights in one file, then only new nights; a lapsed membership is explained', async () => {
    const c = makeClient(app);
    const info = await c.json<SessionInfo>('POST', '/api/auth/register', registration(`oura-${Date.now()}@example.com`), 201);
    const sources = await c.json<SourcesInfo>('GET', '/api/records');
    assert.equal(sources.sources.find(s => s.id === 'oura')!.availability, 'api');

    const { auth, conn } = await connect(app, agent, c, info.profiles[0].id, 'oura');
    assert.equal(auth.origin + auth.pathname, 'https://cloud.ouraring.example/oauth/authorize');
    assert.equal(auth.searchParams.get('scope'), 'daily heartrate spo2');
    assert.equal(auth.searchParams.get('redirect_uri'), 'https://health.example/records/oauth/oura/callback');
    assert.equal(conn.lastRun!.status, 'succeeded', conn.lastRun!.error ?? '');
    assert.equal(conn.lastRun!.saved, 1);
    assert.match(conn.lastRun!.documents[0].fileName, /^Oura 2026-11-09 to 2026-11-11 \(3 days\)\.json$/);
    assert.ok(oura.state.calls.some(x => x.includes('start_date=2025-11-12') && x.includes('end_date=2026-11-11')), oura.state.calls.join(' '));
    assert.ok(oura.state.calls.some(x => x.includes('next_token=2')), 'paged');
    assert.deepEqual(await bundleOf(conn.lastRun!.documents[0].id), [
      '2026-11-09 59408-5 97', '2026-11-09 9279-1 14', '2026-11-09 40443-4 52',
      '2026-11-10 9279-1 14', '2026-11-10 40443-4 54',
      '2026-11-11 59408-5 97', '2026-11-11 9279-1 14', '2026-11-11 40443-4 51',
    ]);

    // Two days later, after the token has expired: refreshed, the rotated refresh token kept, and only 12 Nov read.
    clock += 2 * 86_400_000;
    const run2 = await c.json<RecordRunView>('POST', `/api/records/connections/${conn.id}/run`, {}, 201);
    await agent.idle();
    const r2 = await c.json<RecordRunView>('GET', `/api/records/runs/${run2.id}`);
    assert.equal(r2.status, 'succeeded', r2.error ?? '');
    assert.equal(r2.saved, 1);
    assert.match(r2.documents[0].fileName, /^Oura 2026-11-12 \(1 day\)\.json$/);
    assert.equal(oura.oauth.refreshed, 1);
    // A second refresh works too: the new refresh token was kept.
    clock += 2 * 86_400_000;
    const run3 = await c.json<RecordRunView>('POST', `/api/records/connections/${conn.id}/run`, {}, 201);
    await agent.idle();
    assert.equal((await c.json<RecordRunView>('GET', `/api/records/runs/${run3.id}`)).status, 'succeeded');
    assert.equal(oura.oauth.refreshed, 2);

    oura.state.lapsed = true;
    const run4 = await c.json<RecordRunView>('POST', `/api/records/connections/${conn.id}/run`, {}, 201);
    await agent.idle();
    const r4 = await c.json<RecordRunView>('GET', `/api/records/runs/${run4.id}`);
    assert.equal(r4.status, 'failed');
    assert.match(r4.error!, /Oura membership/);
    oura.state.lapsed = false;
    clock = Date.parse('2026-11-12T06:00:00Z');
  });

  test('Ultrahuman: one call per day, resting HR, SpO2, breathing and CGM glucose; a late-synced day comes in next time', async () => {
    const c = makeClient(app);
    const info = await c.json<SessionInfo>('POST', '/api/auth/register', registration(`uh-${Date.now()}@example.com`), 201);
    const { auth, conn } = await connect(app, agent, c, info.profiles[0].id, 'ultrahuman');
    assert.equal(auth.origin + auth.pathname, 'https://auth.ultrahuman.example/authorise');
    assert.equal(auth.searchParams.get('scope'), 'ring_data cgm_data');
    assert.equal(conn.lastRun!.status, 'succeeded', conn.lastRun!.error ?? '');
    assert.equal(uh.state.calls.length, 90, 'the first check reads 90 days, one call each');
    assert.equal(uh.state.calls.at(-1), '2026-11-11', 'up to yesterday in India');
    assert.deepEqual(await bundleOf(conn.lastRun!.documents[0].id), [
      '2026-11-10 41653-7 104', '2026-11-10 59408-5 97', '2026-11-10 9279-1 14', '2026-11-10 40443-4 56',
      '2026-11-11 59408-5 96', '2026-11-11 40443-4 59',
    ]);

    // The next day the ring syncs 12 Nov late (after the first check of 13 Nov); it still comes in.
    clock += 86_400_000;
    uh.state.calls = [];
    const run2 = await c.json<RecordRunView>('POST', `/api/records/connections/${conn.id}/run`, {}, 201);
    await agent.idle();
    assert.deepEqual(uh.state.calls, ['2026-11-12']);
    assert.equal((await c.json<RecordRunView>('GET', `/api/records/runs/${run2.id}`)).saved, 0, 'nothing synced for 12 Nov yet');
    uh.state.days['2026-11-12'] = [{ type: 'sleep_rhr', object: { value: 55 } }];
    uh.state.calls = [];
    const run3 = await c.json<RecordRunView>('POST', `/api/records/connections/${conn.id}/run`, {}, 201);
    await agent.idle();
    const r3 = await c.json<RecordRunView>('GET', `/api/records/runs/${run3.id}`);
    assert.deepEqual(uh.state.calls, ['2026-11-12'], 'read again, since it had no data last time');
    assert.equal(r3.saved, 1);
    assert.deepEqual(await bundleOf(r3.documents[0].id), ['2026-11-12 40443-4 55']);
  });
});

describe('stopping a device API check', () => {
  test('no request is sent after the run is stopped, and one in flight ends', async () => {
    const stop = new AbortController();
    const urls: string[] = [];
    // Ultrahuman reads one day per request; the person presses Stop during the first one.
    const slow: typeof fetch = async (input, init) => {
      urls.push(String(input));
      stop.abort();
      await new Promise(r => setTimeout(r, 20));
      if (init?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      return new Response(JSON.stringify({ data: { metric_data: [] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const now = () => Date.parse('2026-11-12T12:00:00Z');
    const uh = ultrahumanFetcher({ clientId: 'c', clientSecret: 's', redirectUri: 'https://lotuspond.example/records/oauth/ultrahuman/callback' }, { apiUrl: 'https://uh.example', fetch: slow, now });
    const ctx: ApiContext = {
      source: sourceById('ultrahuman')!, identifier: null, session: JSON.stringify({ access: 'a', refresh: 'r', expiresAt: now() + 3_600_000 }),
      ask: async () => '', remember() {}, keep() {}, step: async () => {}, note() {}, signal: stop.signal, maxBytes: 1_000_000,
    };
    await assert.rejects(uh.run(ctx), RunStoppedError);
    assert.equal(urls.length, 1, 'the other days are not requested');
  });
});
