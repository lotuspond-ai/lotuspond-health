// The iOS / Android client (src/api/http.ts in app mode with src/api/appSession.ts) against the real API, in process.
// fetch is replaced by a stand-in for the apps' web view: requests come from capacitor://localhost, cross-site,
// without cookies; non-simple requests are preflighted; and a response the browser's CORS check would refuse
// fails the way it does in the web view. Run: npm run test:app
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hono } from 'hono';
import { createApp } from '../server/src/app.ts';
import { loadConfig } from '../server/src/config.ts';
import { openDatabase, type Database } from '../server/src/db/client.ts';
import { DiskFileStore } from '../server/src/lib/files.ts';
import type { AppEnv } from '../server/src/http.ts';
import { registration } from '../server/test/helpers.ts';
import { HttpBackend } from '../src/api/http.ts';
import { ApiError } from '../src/api/backend.ts';
import { AppSession, serverOrigin, type StoredSession, type TokenStore } from '../src/api/appSession.ts';
import { appStartUrl, createPkce, readAppReturn } from '../src/api/accountsApp.ts';
import { singleCell } from '../server/src/cells.ts';
import { ephemeralSecrets } from '../server/src/compliance/secrets.ts';
import { memoryLogger } from '../server/src/lab/log.ts';
import { createLabs, fakePartner } from '../server/src/lab/runtime.ts';
import { istDate } from '../server/src/lab/time.ts';
import { LAB_BOOKING_NOTICE_VERSION } from '../shared/lab-bundle.ts';
import { nextDays, rupees, slotLabel, stepOf, timeRange } from '../src/components/labs/labFormat.ts';
import { parseJsonText } from '../src/lib/parse/json.ts';

const ORIGIN = 'capacitor://localhost';
const API = 'https://health.lotuspond.test';
const OTHER = 'https://in.health.lotuspond.test';
const migrations = fileURLToPath(new URL('../server/drizzle', import.meta.url));
let database: Database;
let app: Hono<AppEnv>;
let filesDir: string;
let n = 0;
const run = Date.now().toString(36);

/** Requests that reached the server, and a hook to answer some origins without it. */
let sent: { method: string; url: string }[] = [];
let intercept: ((url: string, init: RequestInit) => Response | null) | null = null;

/** What the web view does with a cross-site request: preflight when needed, then enforce CORS on the response. */
async function webViewFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = String(input);
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  assert.notEqual(init.credentials, 'include', 'the apps never send cookies');
  const faked = intercept?.(url, init);
  if (faked) return faked;
  sent.push({ method, url });
  const custom = [...headers.keys()].filter(h => !['accept', 'content-type'].includes(h));
  const simpleType = !headers.has('content-type') || /^(text\/plain|multipart\/form-data|application\/x-www-form-urlencoded)/.test(headers.get('content-type')!);
  const base = { origin: ORIGIN, 'sec-fetch-site': 'cross-site', 'x-forwarded-for': `10.9.${++n % 250}.1` };
  if (custom.length || !simpleType || !['GET', 'HEAD', 'POST'].includes(method)) {
    const pre = await app.request(url, { method: 'OPTIONS', headers: { ...base, 'access-control-request-method': method, 'access-control-request-headers': [...headers.keys()].join(',') } });
    const allowed = (pre.headers.get('access-control-allow-headers') ?? '').toLowerCase();
    if (!pre.ok || pre.headers.get('access-control-allow-origin') !== ORIGIN || [...headers.keys()].some(h => h !== 'content-type' && !allowed.includes(h))) {
      throw new TypeError(`Load failed (preflight refused for ${method} ${url})`);
    }
  }
  for (const [k, v] of Object.entries(base)) headers.set(k, v);
  const res = await app.request(url, { method, headers, body: init.body as BodyInit | undefined });
  if (res.headers.get('access-control-allow-origin') !== ORIGIN) throw new TypeError(`Load failed (CORS refused for ${method} ${url})`);
  // Clearing the browser cookie on sign-out is harmless; handing the app a session cookie is not.
  const cookie = res.headers.get('set-cookie');
  if (cookie && !/Max-Age=0/i.test(cookie)) throw new Error(`the server set a cookie for the app: ${cookie}`);
  return res;
}

function memoryStore(initial: StoredSession | null = null) {
  const store: TokenStore & { value: StoredSession | null } = {
    value: initial,
    async load() { return store.value; },
    async save(s) { store.value = s; },
  };
  return store;
}

function client(store = memoryStore()) {
  const session = new AppSession(API, store);
  const backend = new HttpBackend({ app: session });
  return { store, session, backend };
}

before(async () => {
  database = await openDatabase({ url: process.env.TEST_DATABASE_URL });
  await database.migrate(migrations);
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspond-app-client-'));
  // The stand-in LotusPond Accounts issuer, for sign-in through the system browser (docs/identity.md).
  const config = loadConfig({ NODE_ENV: 'test', TRUST_PROXY: 'true', ACCOUNTS_ISSUER: 'fake' });
  app = createApp({ db: database.db, files: new DiskFileStore(filesDir), config });
  globalThis.fetch = webViewFetch as typeof fetch;
});

after(async () => {
  await database.close();
  fs.rmSync(filesDir, { recursive: true, force: true });
});

beforeEach(() => { sent = []; intercept = null; });

const email = () => `client${++n}.${run}@example.com`;

describe('app client', () => {
  it('starts signed out without calling the server', async () => {
    const { backend } = client();
    assert.equal(await backend.me(), null);
    assert.equal(sent.length, 0);
  });

  it('signs up with a token, keeps it, and uses it for every request', async () => {
    const { backend, store } = client();
    await backend.service();
    const info = await backend.register(registration(email()));
    assert.ok(info.account.id && info.profiles.length >= 1);
    assert.ok(!('token' in info), 'the token is not handed to the interface');
    assert.ok(store.value?.token && store.value.origin === API);
    const me = await backend.me();
    assert.equal(me?.account.id, info.account.id);
    const records = await backend.records(info.profiles[0].id);
    assert.ok(Array.isArray(records.measurements));
  });

  it('uploads, fetches the original and the export with the token; offers no plain links', async () => {
    const { backend } = client();
    const info = await backend.register(registration(email()));
    const pid = info.profiles[0].id;
    const bytes = new TextEncoder().encode('Hemoglobin,13.5,g/dL\n');
    const doc = await backend.uploadDocument(pid, new Blob([bytes], { type: 'text/csv' }), 'report.csv', 'report');
    const back = new Uint8Array(await (await backend.documentFile(pid, doc.id)).arrayBuffer());
    assert.deepEqual([...back], [...bytes]);
    const exported = JSON.parse(await (await backend.exportFile(pid)).text()) as Record<string, unknown>;
    assert.ok(exported && typeof exported === 'object');
    assert.equal(backend.documentUrl(pid, doc.id), null);
    assert.equal(backend.exportUrl(pid), null);
  });

  it('stays signed in across a restart and signs out cleanly', async () => {
    const first = client();
    const address = email();
    await first.backend.register(registration(address));
    const again = client(first.store); // a new launch reading the same Keychain entry
    assert.ok((await again.backend.me())?.account);
    await again.backend.logout();
    assert.equal(first.store.value, null);
    sent = [];
    assert.equal(await again.backend.me(), null);
    assert.equal(sent.length, 0, 'no request once the token is gone');
    const info = await again.backend.login({ email: address, password: registration(address).password });
    assert.ok(info.account && first.store.value?.token);
  });

  it('drops an expired token without using it', async () => {
    const store = memoryStore({ token: 'in.stale', origin: API, expiresAt: new Date(Date.now() - 60_000).toISOString() });
    const { backend } = client(store);
    assert.equal(await backend.me(), null);
    assert.equal(store.value, null);
    assert.equal(sent.length, 0);
  });

  it('a session ended elsewhere signs the app out', async () => {
    const { backend, store } = client();
    const info = await backend.register(registration(email()));
    const elsewhere = client(memoryStore({ ...store.value! }));
    await elsewhere.backend.logout(); // revokes the same token
    let ended = 0;
    backend.onSessionEnded = () => { ended++; };
    await assert.rejects(backend.records(info.profiles[0].id), (e: unknown) => e instanceof ApiError && e.status === 401);
    assert.equal(ended, 1);
    assert.equal(store.value, null);
  });

  it('resolves self-hosted map tile paths against the API host', async () => {
    const config = loadConfig({ NODE_ENV: 'test', TRUST_PROXY: 'true', MAP_PMTILES_URL: '/api/map/files/india.pmtiles', MAP_ASSETS_URL: '/api/map/files/assets/' });
    const usual = app;
    app = createApp({ db: database.db, files: new DiskFileStore(filesDir), config });
    try {
      const map = (await client().backend.publicConfig()).map;
      assert.equal(map?.type, 'pmtiles');
      if (map?.type !== 'pmtiles') return;
      assert.equal(map.url, `${API}/api/map/files/india.pmtiles`);
      assert.equal(map.assetsUrl, `${API}/api/map/files/assets`);
    } finally {
      app = usual;
    }
    const raster = (await client().backend.publicConfig()).map;
    assert.ok(raster?.type === 'raster' && raster.tiles.every(t => t.startsWith('https://') && t.includes('{z}')), 'absolute tile templates are left alone');
  });

  it('follows wrong_region to the host that holds the account, and keeps using it', async () => {
    const { backend, store } = client();
    const address = email();
    await backend.register(registration(address));
    await backend.logout();
    // The default host does not hold the account: it answers with the host that does. Requests to OTHER reach
    // the same server here (its records are what that host would hold).
    intercept = url => url.startsWith(`${API}/api/auth/login`)
      ? Response.json({ error: { code: 'wrong_region', message: 'Sign in through LotusPond Health for India.', region: 'in', apiOrigin: OTHER } },
        { status: 403, headers: { 'access-control-allow-origin': ORIGIN } })
      : null;
    const realRequest = app.request.bind(app);
    const seen: string[] = [];
    app.request = ((u: string, i?: RequestInit) => { seen.push(String(u)); return realRequest(String(u).replace(OTHER, API), i); }) as typeof app.request;
    try {
      const info = await backend.login({ email: address, password: registration(address).password });
      assert.ok(info.account);
      assert.equal(store.value?.origin, OTHER);
      await backend.me();
      assert.ok(seen.some(u => u.startsWith(`${OTHER}/api/auth/me`)), 'later requests go to the account\'s host');
    } finally {
      app.request = realRequest;
    }
  });
});

/**
 * The system browser: same-origin to the API host, with its own cookies. It opens the app's start URL, goes through
 * the stand-in Accounts page, and returns the link Health hands back to the app.
 */
async function systemBrowser(startUrl: string, who: { email: string; enterprise?: boolean }): Promise<string> {
  const jar = new Map<string, string>();
  const go = async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('sec-fetch-site', 'same-origin');
    if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
    const res = await app.request(new URL(url, API).toString(), { ...init, headers });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const [k, ...v] = pair.split('=');
      if (v.join('=')) jar.set(k.trim(), v.join('=')); else jar.delete(k.trim());
    }
    return res;
  };
  const start = await go(startUrl);
  assert.equal(start.status, 302);
  const authorize = new URL(start.headers.get('location')!, API);
  const form = new URLSearchParams();
  for (const k of ['client_id', 'redirect_uri', 'state', 'nonce', 'code_challenge']) form.set(k, authorize.searchParams.get(k)!);
  form.set('email', who.email);
  form.set('email_verified', 'true');
  form.set('region', 'in');
  if (who.enterprise) form.set('enterprise', 'true');
  const issued = await go(authorize.pathname, { method: 'POST', body: form.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const page = await (await go(issued.headers.get('location')!)).text();
  return /content="0;url=([^"]+)"/.exec(page)![1].replace(/&amp;/g, '&');
}

describe('app client: sign-in with LotusPond Accounts', () => {
  it('a new person: system browser, one-time code, Health\'s questions in the app, then a token session', async () => {
    const { backend, store } = client();
    const pkce = await createPkce();
    assert.match(pkce.verifier, /^[A-Za-z0-9_-]{43}$/);
    const start = await backend.accountsAppStartUrl('signup', pkce.challenge);
    assert.equal(start, appStartUrl(API, 'signup', pkce.challenge));
    const link = await systemBrowser(start, { email: email() });
    const back = readAppReturn(link);
    assert.ok(back && 'code' in back, link);
    assert.equal(readAppReturn('https://example.com/?code=x'), null, 'other links are not sign-in returns');
    assert.deepEqual(readAppReturn('https://open.health.lotuspond.ai/accounts-return?code=abc'), { code: 'abc' }, 'the universal link / app link form');
    assert.equal(readAppReturn('http://open.health.lotuspond.ai/accounts-return?code=abc'), null, 'never plain http');

    const r = await backend.accountsAppExchange(back.code, pkce.verifier);
    assert.ok('pending' in r);
    assert.equal(store.value, null, 'no session until sign-up is finished');
    assert.equal((await backend.accountsPending())?.email, r.pending.email);
    const { email: _e, password: _p, ...answers } = registration('unused@example.com');
    const info = await backend.completeAccountsSignUp(answers);
    assert.equal(info.account.email, r.pending.email);
    assert.ok(store.value?.token, 'the token is kept like a password sign-in\'s');
    assert.equal((await backend.me())?.account.id, info.account.id);
    assert.equal(await backend.accountsPending(), null);

    // Next time: straight to a session.
    const again = client();
    const pkce2 = await createPkce();
    const link2 = await systemBrowser(await again.backend.accountsAppStartUrl('login', pkce2.challenge), { email: info.account.email });
    const back2 = readAppReturn(link2);
    assert.ok(back2 && 'code' in back2);
    const r2 = await again.backend.accountsAppExchange(back2.code, pkce2.verifier);
    assert.ok('session' in r2 && r2.session.account.id === info.account.id);
    assert.ok(again.store.value?.token);
  });

  it('follows a regional host only when the server lists it, so the verifier never goes elsewhere', async () => {
    assert.deepEqual(readAppReturn('ai.lotuspond.health:/accounts?code=c1&api_origin=https%3A%2F%2Fin.health.lotuspond.test'),
      { code: 'c1', apiOrigin: 'https://in.health.lotuspond.test' });
    const { backend, session } = client();
    sent = [];
    await assert.rejects(backend.accountsAppExchange('c1', 'v'.repeat(43), 'https://evil.example'),
      (e: unknown) => e instanceof ApiError && e.code === 'unknown_host');
    assert.ok(!sent.some(r => r.url.startsWith('https://evil.example')), 'nothing was sent to the unlisted host');
    assert.equal(session.origin, API, 'the app stays on its host');
  });

  it('a refusal comes back as an error code the app shows', async () => {
    const { backend } = client();
    const pkce = await createPkce();
    const link = await systemBrowser(await backend.accountsAppStartUrl('login', pkce.challenge), { email: email(), enterprise: true });
    assert.deepEqual(readAppReturn(link), { error: 'enterprise_account' });
  });
});

describe('server picker addresses (test builds)', () => {
  it('turns what a tester types into an API origin', () => {
    assert.equal(serverOrigin('192.168.1.20:8787'), 'http://192.168.1.20:8787');
    assert.equal(serverOrigin(' http://192.168.1.20:8787/app#body '), 'http://192.168.1.20:8787');
    assert.equal(serverOrigin('localhost:8787'), 'http://localhost:8787');
    assert.equal(serverOrigin('my-laptop.local:8787'), 'http://my-laptop.local:8787');
    assert.equal(serverOrigin('health.lotuspond.ai'), 'https://health.lotuspond.ai');
    assert.equal(serverOrigin('https://staging.example.org/'), 'https://staging.example.org');
    assert.equal(serverOrigin('HTTPS://Health.LotusPond.ai'), 'https://health.lotuspond.ai');
  });

  it('the picker\'s server check passes the web view\'s CORS', async () => {
    const res = await fetch(`${API}/api/auth/config`, { credentials: 'omit', headers: { 'X-LotusPond-Client': 'app' } });
    assert.equal(res.status, 200);
    assert.ok(await res.json());
  });

  it('refuses what is not an http(s) address', () => {
    for (const bad of ['', '   ', 'ftp://example.org', 'javascript:alert(1)', 'http://', 'http:// spaces .org']) {
      assert.equal(serverOrigin(bad), null, bad);
    }
  });
});

describe('app client: lab booking', () => {
  let plain: Hono<AppEnv>;
  let fake: ReturnType<typeof fakePartner>;
  let labs: ReturnType<typeof createLabs>;
  before(() => {
    plain = app;
    const config = loadConfig({ NODE_ENV: 'test', TRUST_PROXY: 'true' });
    const files = new DiskFileStore(filesDir);
    const cells = singleCell(database.db, files, config.servedRegions);
    const secrets = ephemeralSecrets();
    // A fast simulated lab: one step per millisecond, so a tick plays the whole order out. Its webhooks are server to server.
    fake = fakePartner({ stepMs: 1, deliver: async (hookPath, req) => { await app.request(hookPath, { method: 'POST', headers: req.headers, body: req.rawBody }); } });
    labs = createLabs({ cells, secrets, partners: [fake.config], log: memoryLogger() });
    app = createApp({ db: database.db, files, config, cells, secrets, labs });
  });
  after(() => { app = plain; });

  it('books across sites with an idempotency key, follows the order and saves the results into the profile', async () => {
    const { backend } = client();
    const info = await backend.register(registration(email()));
    const pid = info.profiles[0].id;
    const catalog = await backend.labCatalog('560034');
    assert.ok(catalog.items.some(i => i.code === 'FL_ESSENTIAL'));
    const [slot] = await backend.labSlots({ partner: 'fake', pincode: '560034', date: istDate(Date.now() + 86_400_000), items: ['FL_ESSENTIAL'] });
    const input = {
      partner: 'fake' as const, items: ['FL_ESSENTIAL'], slot, patient: { name: 'Asha Rao', age: 34, sex: 'female' as const }, phone: '+919812345678',
      address: { line1: '12 Lake Road', city: 'Bengaluru', pincode: '560034' }, consent: { noticeVersion: LAB_BOOKING_NOTICE_VERSION, accepted: true },
    };
    // The preflight must allow Idempotency-Key, or the web view refuses the booking outright.
    const order = await backend.bookLab(pid, input, `app-booking-${run}`);
    assert.equal(order.status, 'booked');
    assert.equal((await backend.bookLab(pid, input, `app-booking-${run}`)).id, order.id, 'a retry with the same key is the same booking');
    assert.deepEqual((await backend.labOrders(pid)).map(o => o.id), [order.id]);

    await new Promise(r => setTimeout(r, 20));
    await fake.lab.tick();
    await labs.tick();
    assert.equal((await backend.labOrder(pid, order.id)).status, 'report_ready');
    const [result] = await backend.labResults(pid);
    const pdf = new Uint8Array(await (await backend.labReport(pid, result.id)).arrayBuffer());
    assert.equal(new TextDecoder().decode(pdf.subarray(0, 5)), '%PDF-');
    const reviewed = parseJsonText(JSON.stringify(result.bundle), result.source).measurements;
    const saved = await backend.saveLabResult(pid, result.id, reviewed);
    assert.equal(saved.saved, reviewed.length);
    assert.equal((await backend.records(pid)).measurements.length, reviewed.length);
    assert.equal((await backend.labOrder(pid, order.id)).status, 'delivered');
    assert.deepEqual(await backend.labResults(pid), []);
  });
});

describe('app: lab booking display', () => {
  const slot = (a: string, b: string) => ({ start: `2026-11-08T${a}:00+05:30`, end: `2026-11-08T${b}:00+05:30` });

  it('shows prices in rupees with Indian grouping', () => {
    assert.equal(rupees(99900), '₹999');
    assert.equal(rupees(18990000), '₹1,89,900');
    assert.equal(rupees(34950), '₹349.50');
  });

  it('shows visits in India time, whatever the device clock says', () => {
    assert.equal(timeRange(slot('07:00', '08:00')), '7:00 – 8:00 am');
    assert.equal(timeRange(slot('11:00', '12:00')), '11:00 am – 12:00 pm');
    assert.equal(slotLabel(slot('16:00', '17:00')), 'Sun, 8 Nov, 4:00 – 5:00 pm');
    // 01:30 on 4 November in India is still 3 November in UTC: the days start from India's today.
    assert.deepEqual(nextDays(3, Date.parse('2026-11-03T20:00:00Z')), [
      { date: '2026-11-04', label: 'Today' }, { date: '2026-11-05', label: 'Tomorrow' }, { date: '2026-11-06', label: 'Fri, 6 Nov' },
    ]);
  });

  it('places each order status on the tracker', () => {
    const at = (status: string) => stepOf({ status } as Parameters<typeof stepOf>[0]);
    assert.deepEqual(['booked', 'collector_assigned', 'sample_collected', 'processing', 'report_ready', 'delivered'].map(at), [0, 1, 2, 3, 4, 4]);
    assert.equal(at('recollection_needed'), 0, 'a new sample starts the visit again');
    assert.deepEqual(['placing', 'failed', 'cancelled', 'expired'].map(at), [-1, -1, -1, -1]);
  });
});
