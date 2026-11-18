// Sign-in with LotusPond Accounts from the apps across regional hosts (REGION_API_ORIGINS): each host keeps one
// region's cell, and the hosts share the directory database and DIRECTORY_SECRET. A sign-in started on the Europe
// host for an account held in India comes back with a code for the India host, which decides there.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDatabase, type Database, type Db } from '../src/db/client.ts';
import { users } from '../src/db/schema.ts';
import { CellRegistry, fileStore, type Cell } from '../src/cells.ts';
import { ephemeralSecrets } from '../src/compliance/secrets.ts';
import { pkceChallenge } from '../src/auth/oidc.ts';
import { purgeSpentTokens, spendOnce } from '../src/auth/spent-tokens.ts';
import type { SessionInfo } from '../../shared/types.ts';
import { registration } from './helpers.ts';

const IN = 'https://in.health.test';
const EU = 'https://eu.health.test';
const migrations = fileURLToPath(new URL('../drizzle', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspond-accounts-regions-'));
const dbs: Database[] = [];
let inDb: Db;
let hostIn: ReturnType<typeof createApp>;
/** A second instance of the India host: same databases and secrets, its own memory. */
let hostIn2: ReturnType<typeof createApp>;
let directoryDb: Db;
let hostEu: ReturnType<typeof createApp>;

async function open() {
  const d = await openDatabase({ url: undefined });
  dbs.push(d);
  await d.migrate(migrations);
  return d.db;
}

before(async () => {
  const directory = await open();
  directoryDb = directory;
  inDb = await open();
  const euDb = await open();
  const secrets = ephemeralSecrets(); // shared, as DIRECTORY_SECRET is across the hosts
  const key = () => ({ current: randomBytes(32), previous: [] });
  const inCell: Cell = { id: 'in', db: inDb, files: fileStore(path.join(tmp, 'in'), key()) };
  const euCell: Cell = { id: 'eu', db: euDb, files: fileStore(path.join(tmp, 'eu'), key()) };
  const settings = { NODE_ENV: 'test', RECORD_AGENT: 'off', ACCOUNTS_ISSUER: 'fake', OPEN_COUNTRIES: 'all', REGION_API_ORIGINS: `in=${IN},eu=${EU}` } as const;
  hostIn = createApp({ db: directory, files: inCell.files, config: loadConfig({ ...settings, SERVED_REGIONS: 'in' }), cells: new CellRegistry(inCell, [['in', inCell]]), secrets });
  hostIn2 = createApp({ db: directory, files: inCell.files, config: loadConfig({ ...settings, SERVED_REGIONS: 'in' }), cells: new CellRegistry(inCell, [['in', inCell]]), secrets });
  hostEu = createApp({ db: directory, files: euCell.files, config: loadConfig({ ...settings, SERVED_REGIONS: 'eu' }), cells: new CellRegistry(euCell, [['eu', euCell]]), secrets });
});
after(async () => { await Promise.all(dbs.map(d => d.close())); fs.rmSync(tmp, { recursive: true, force: true }); });

const hostFor = (origin: string) => origin === IN ? hostIn : hostEu;

/** The system browser on one host: start (as an app), the stand-in Accounts page, and the link back to the app. */
async function signInFromApp(origin: string, who: { email: string; region?: string }) {
  const host = hostFor(origin);
  const verifier = randomBytes(32).toString('base64url');
  const jar: string[] = [];
  const go = async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('sec-fetch-site', 'same-origin');
    if (jar.length) headers.set('cookie', jar.join('; '));
    const res = await host.request(new URL(url, origin).toString(), { ...init, headers });
    for (const line of res.headers.getSetCookie()) { const pair = line.split(';')[0]; if (!pair.endsWith('=')) jar.push(pair); }
    return res;
  };
  const start = await go(`/api/auth/accounts/start?client=app&code_challenge=${pkceChallenge(verifier)}`);
  const authorize = new URL(start.headers.get('location')!, origin);
  const form = new URLSearchParams({ email: who.email, email_verified: 'true' });
  if (who.region) form.set('region', who.region);
  for (const k of ['client_id', 'redirect_uri', 'state', 'nonce', 'code_challenge']) form.set(k, authorize.searchParams.get(k)!);
  const issued = await go(authorize.pathname, { method: 'POST', body: form.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const page = await (await go(issued.headers.get('location')!)).text();
  const link = new URL(/content="0;url=([^"]+)"/.exec(page)![1].replace(/&amp;/g, '&'));
  return { verifier, code: link.searchParams.get('code'), apiOrigin: link.searchParams.get('api_origin'), error: link.searchParams.get('error') };
}

/** A browser on the website: cookies per host, as browsers keep them; goes through the stand-in Accounts page on
 *  whichever host it is sent to. Returns the final redirect from Health and the cookies each host set. */
async function webSignIn(startOrigin: string, who: { email: string; region?: string }, intent = 'login') {
  const jars = new Map<string, string[]>();
  const go = async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const jar = jars.get(u.origin) ?? [];
    jars.set(u.origin, jar);
    const headers = new Headers(init.headers);
    headers.set('sec-fetch-site', 'same-origin');
    if (jar.length) headers.set('cookie', jar.join('; '));
    const res = await hostFor(u.origin).request(u.toString(), { ...init, headers });
    for (const line of res.headers.getSetCookie()) { const pair = line.split(';')[0]; if (!pair.endsWith('=')) jar.push(pair); }
    return res;
  };
  let next = `${startOrigin}/api/auth/accounts/start?intent=${intent}`;
  const hosts: string[] = [];
  for (let i = 0; i < 3; i++) {
    const origin = new URL(next).origin;
    hosts.push(origin);
    const start = await go(next);
    assert.equal(start.status, 302, await start.clone().text());
    const authorize = new URL(start.headers.get('location')!, origin);
    const form = new URLSearchParams({ email: who.email, email_verified: 'true' });
    if (who.region) form.set('region', who.region);
    for (const k of ['client_id', 'redirect_uri', 'state', 'nonce', 'code_challenge']) form.set(k, authorize.searchParams.get(k)!);
    const issued = await go(`${origin}${authorize.pathname}`, { method: 'POST', body: form.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    const done = await go(issued.headers.get('location')!);
    const to = new URL(done.headers.get('location')!, origin);
    if (!to.pathname.endsWith('/accounts/start')) return { to, hosts, jars };
    next = to.toString();
  }
  throw new Error('handed between hosts more than twice');
}

const appCall = (origin: string, method: string, url: string, body?: unknown, token?: string) => hostFor(origin).request(new URL(url, origin).toString(), {
  method,
  headers: { 'x-lotuspond-client': 'app', origin: 'capacitor://localhost', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});

let n = 0;
const email = (tag: string) => `${tag}.${Date.now().toString(36)}.${++n}@example.com`;

describe('LotusPond Accounts across regional hosts', () => {
  test('an India account signed in from the Europe host is handed to the India host, which links it and signs in', async () => {
    const address = email('india');
    assert.equal((await hostIn.request(`${IN}/api/auth/register`, {
      method: 'POST', body: JSON.stringify(registration(address, 'IN')),
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    })).status, 201);

    // Accounts says nothing about the region here: the shared directory finds the account on the India host.
    const back = await signInFromApp(EU, { email: address });
    assert.equal(back.apiOrigin, IN);
    assert.ok(back.code);
    assert.equal((await appCall(EU, 'POST', '/api/auth/accounts/app-exchange', { code: back.code, verifier: back.verifier })).status, 409,
      'the Europe host does not sign in an India account');
    const res = await appCall(IN, 'POST', '/api/auth/accounts/app-exchange', { code: back.code, verifier: back.verifier });
    assert.equal(res.status, 200, await res.clone().text());
    const info = await res.json() as SessionInfo & { token: string };
    assert.match(info.token, /^in\./);
    assert.equal(info.account.email, address);
    const [row] = await inDb.select().from(users).where(eq(users.email, address));
    assert.match(row.accountsSubject ?? '', /^dev\|/, 'linked in the India cell');
  });

  test('someone new whose LotusPond account is in India finishes sign-up on the India host', async () => {
    const address = email('new-india');
    const back = await signInFromApp(EU, { email: address, region: 'in' });
    assert.equal(back.apiOrigin, IN);
    const started = await (await appCall(IN, 'POST', '/api/auth/accounts/app-exchange', { code: back.code, verifier: back.verifier })).json() as { pendingToken: string };
    const { email: _e, password: _p, ...answers } = registration('unused@example.com', 'IN');
    const done = await appCall(IN, 'POST', '/api/auth/accounts/complete', { ...answers, pendingToken: started.pendingToken });
    assert.equal(done.status, 201, await done.clone().text());
    assert.equal((await inDb.select().from(users).where(eq(users.email, address))).length, 1);
  });

  test('the website: an India account signing in on the Europe site is sent to sign in on the India site', async () => {
    const address = email('web-india');
    assert.equal((await hostIn.request(`${IN}/api/auth/register`, {
      method: 'POST', body: JSON.stringify(registration(address, 'IN')),
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    })).status, 201);
    const { to, hosts, jars } = await webSignIn(EU, { email: address });
    assert.deepEqual(hosts, [EU, IN], 'started on Europe, finished on India');
    assert.equal(to.toString(), `${IN}/app`);
    assert.ok((jars.get(IN) ?? []).some(c => /^lp_session=in\./.test(c)), 'the India site holds the session');
    assert.ok(!(jars.get(EU) ?? []).some(c => c.startsWith('lp_session=')), 'the Europe site holds none');
  });

  test('the website: someone new whose LotusPond account is in India finishes sign-up on the India site', async () => {
    const { to, hosts } = await webSignIn(EU, { email: email('web-new'), region: 'in' }, 'signup');
    assert.deepEqual(hosts, [EU, IN]);
    assert.equal(`${to.origin}${to.pathname}${to.search}`, `${IN}/signup?accounts=continue`);
  });

  test('the website is handed on once at most', async () => {
    // Accounts says Europe while the shared directory holds the account in India: India must not send it back.
    const address = email('web-loop');
    await hostIn.request(`${IN}/api/auth/register`, {
      method: 'POST', body: JSON.stringify(registration(address, 'IN')),
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    });
    const { to, hosts } = await webSignIn(EU, { email: address, region: 'eu' });
    assert.deepEqual(hosts, [EU, IN]);
    assert.equal(to.searchParams.get('accounts_error'), 'wrong_region');
  });

  test('an app code works once across instances of a host, not once per instance', async () => {
    const address = email('instances');
    const back = await signInFromApp(IN, { email: address, region: 'in' });
    assert.equal((await appCall(IN, 'POST', '/api/auth/accounts/app-exchange', { code: back.code, verifier: back.verifier })).status, 200);
    const replay = await hostIn2.request(`${IN}/api/auth/accounts/app-exchange`, {
      method: 'POST', body: JSON.stringify({ code: back.code, verifier: back.verifier }),
      headers: { 'x-lotuspond-client': 'app', origin: 'capacitor://localhost', 'content-type': 'application/json' },
    });
    assert.equal(replay.status, 400, 'the other instance refuses it too');
  });

  test('spent tokens: once each, kinds apart, forgotten after they expire', async () => {
    const soon = new Date(Date.now() + 60_000);
    assert.equal(await spendOnce(directoryDb, 'logout-token', 'jti-1', soon), true);
    assert.equal(await spendOnce(directoryDb, 'logout-token', 'jti-1', soon), false);
    assert.equal(await spendOnce(directoryDb, 'app-code', 'jti-1', soon), true, 'another kind with the same id is separate');
    await spendOnce(directoryDb, 'logout-token', 'old', new Date(Date.now() - 1000));
    await purgeSpentTokens(directoryDb);
    assert.equal(await spendOnce(directoryDb, 'logout-token', 'old', soon), true, 'an expired record is gone');
    assert.equal(await spendOnce(directoryDb, 'logout-token', 'jti-1', soon), false, 'a live one stays');
  });

  test('the link back offers only hosts this deployment lists', async () => {
    const page = await (await hostEu.request(`${EU}/accounts-return?code=${'a'.repeat(30)}&api_origin=https://evil.example`)).text();
    assert.ok(!page.includes('evil.example'));
    const listed = await (await hostEu.request(`${EU}/accounts-return?code=${'a'.repeat(30)}&api_origin=${encodeURIComponent(IN)}`)).text();
    assert.ok(listed.includes(`api_origin=${encodeURIComponent(IN)}`));
  });
});
