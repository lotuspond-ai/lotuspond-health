// LotusPond Accounts as the only way in (M9): linking Accounts' answer to its import, the old password routes, and
// finding a Health account by email without the email directory, which M9 dropped with the password hashes.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDatabase, type Database } from '../src/db/client.ts';
import { auditEvents, profiles, users } from '../src/db/schema.ts';
import { DiskFileStore } from '../src/lib/files.ts';
import { singleCell } from '../src/cells.ts';
import { ephemeralSecrets } from '../src/compliance/secrets.ts';
import { linkAccounts, readJsonLines } from '../src/auth/accounts-migration.ts';
import { fakeSubject } from '../src/auth/fake-accounts.ts';
import type { AppEnv } from '../src/http.ts';
import type { ServiceInfo, SessionInfo } from '../../shared/types.ts';
import { registration } from './helpers.ts';

let database: Database;
let filesDir: string;
let app: Hono<AppEnv>;
const secrets = ephemeralSecrets();

before(async () => {
  database = await openDatabase({ url: process.env.TEST_DATABASE_URL });
  await database.migrate(fileURLToPath(new URL('../drizzle', import.meta.url)));
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspond-accounts-migration-'));
  const files = new DiskFileStore(filesDir);
  // PASSWORD_SIGN_IN=off, as every host had it set before M9: still accepted, and it changes nothing.
  const config = loadConfig({ NODE_ENV: 'test', RECORD_AGENT: 'off', ACCOUNTS_ISSUER: 'fake', PASSWORD_SIGN_IN: 'off' });
  app = createApp({ db: database.db, files, config, cells: singleCell(database.db, files, config.servedRegions), secrets });
});
after(async () => { await database.close(); fs.rmSync(filesDir, { recursive: true, force: true }); });

let n = 0;
const email = (tag: string) => `${tag}.${Date.now().toString(36)}.${++n}@example.com`;
const cellsOf = () => [singleCell(database.db, new DiskFileStore(filesDir), ['in', 'eu', 'us', 'global']).defaultCell];

/** A Health account from before LotusPond Accounts, as the import found it: no Accounts subject yet. */
async function existing(address: string) {
  const [u] = await database.db.insert(users).values({ email: address, country: 'IN', region: 'in', ageConfirmedAt: new Date() }).returning();
  await database.db.insert(profiles).values({ userId: u.id, relationship: 'self', displayName: 'Asha Rao' });
  return u;
}

/** A browser: cookies, same-origin requests, and a sign-in through the stand-in. */
function browser() {
  const jar = new Map<string, string>();
  async function go(method: string, url: string, body?: string, type?: string) {
    const headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (type) headers['content-type'] = type;
    const res = await app.request(new URL(url, 'http://health.test').toString(), { method, headers, body });
    for (const line of res.headers.getSetCookie()) {
      const [k, ...v] = line.split(';')[0].split('=');
      if (v.join('=') && !/Max-Age=0/i.test(line)) jar.set(k.trim(), v.join('=')); else jar.delete(k.trim());
    }
    return res;
  }
  const json = (method: string, url: string, body?: unknown) => go(method, url, body === undefined ? undefined : JSON.stringify(body), body === undefined ? undefined : 'application/json');
  async function accounts(address: string, region = 'in') {
    const start = await go('GET', '/api/auth/accounts/start?intent=login');
    const authorize = new URL(start.headers.get('location')!, 'http://health.test');
    const form = new URLSearchParams({ email: address, email_verified: 'true', region });
    for (const k of ['client_id', 'redirect_uri', 'state', 'nonce', 'code_challenge']) form.set(k, authorize.searchParams.get(k)!);
    const issued = await go('POST', authorize.pathname, form.toString(), 'application/x-www-form-urlencoded');
    const done = await go('GET', issued.headers.get('location')!);
    return new URL(done.headers.get('location')!, 'http://health.test');
  }
  return { go, json, accounts };
}

describe('linking Accounts\' answer to its import', () => {
  test('new links, unchanged ones, conflicts, unknown ids and unreadable lines', async () => {
    const a = email('link-a');
    const b = email('link-b');
    const ua = await existing(a);
    const ub = await existing(b);
    const answer = [
      JSON.stringify({ health_user_id: ua.id, sub: fakeSubject(a) }),
      JSON.stringify({ health_user_id: ub.id, sub: fakeSubject(a) }), // the same LotusPond account for another Health account
      JSON.stringify({ health_user_id: randomUUID(), sub: 'dev|nobody' }),
      'not json',
      JSON.stringify({ health_user_id: ua.id }),
    ].join('\n');
    const first = await linkAccounts(cellsOf(), readJsonLines(answer));
    assert.equal(first.linked, 1);
    assert.equal(first.conflicts.length, 1);
    assert.equal(first.conflicts[0].health_user_id, ub.id);
    assert.equal(first.missing.length, 1);
    assert.equal(first.invalid, 2);
    const again = await linkAccounts(cellsOf(), readJsonLines(`${JSON.stringify({ health_user_id: ua.id, sub: fakeSubject(a) })}\n${JSON.stringify({ health_user_id: ua.id, sub: 'dev|other' })}`));
    assert.equal(again.unchanged, 1);
    assert.equal(again.conflicts[0].reason, 'already linked to another LotusPond account');
    const events = await database.db.select().from(auditEvents).where(eq(auditEvents.userId, ua.id));
    assert.ok(events.some(e => e.kind === 'accounts_linked'));
  });
});

describe('LotusPond Accounts only (M9)', () => {
  test('the old password routes tell an app from before Accounts to use it, and the service says Accounts is on', async () => {
    const b = browser();
    const info = await (await b.go('GET', '/api/auth/config')).json() as ServiceInfo;
    assert.equal(info.accounts, true);
    assert.equal('passwordSignIn' in info, false);
    const old = [
      ['/api/auth/register', registration(email('old-app'))],
      ['/api/auth/login', { email: 'x@example.com', password: 'whatever it is' }],
      ['/api/auth/password', { currentPassword: 'whatever it is', newPassword: 'another long one' }],
    ] as const;
    for (const [url, body] of old) {
      const res = await b.json('POST', url, body);
      assert.equal(res.status, 409, url);
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'use_accounts');
    }
  });

  test('an account linked by the import signs in by its subject; one never linked is found by email in the cells', async () => {
    const linked = email('linked');
    const unlinked = email('unlinked');
    const ul = await existing(linked);
    await existing(unlinked);
    await linkAccounts(cellsOf(), [{ health_user_id: ul.id, sub: fakeSubject(linked) }]);
    for (const x of [linked, unlinked]) {
      const b = browser();
      assert.equal((await b.accounts(x)).pathname, '/app', x);
      assert.equal(((await (await b.go('GET', '/api/auth/me')).json()) as SessionInfo).account.email, x);
    }
    const [uu] = await database.db.select().from(users).where(eq(users.email, unlinked));
    assert.equal(uu.accountsSubject, fakeSubject(unlinked));
  });

  test('someone new signs up through Accounts, and signs straight in the next time', async () => {
    const address = email('new');
    const b = browser();
    assert.equal((await b.accounts(address)).pathname, '/signup');
    const { email: _e, password: _p, ...answers } = registration('unused@example.com');
    assert.equal((await b.json('POST', '/api/auth/accounts/complete', answers)).status, 201);
    assert.equal((await database.db.select().from(users).where(eq(users.email, address))).length, 1);
    assert.equal((await browser().accounts(address)).pathname, '/app');
  });

  test('settings: Accounts is required in production and the default in development and npm run local; PASSWORD_SIGN_IN=on is refused', () => {
    assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /ACCOUNTS_ISSUER is required/);
    assert.equal(loadConfig({ NODE_ENV: 'development' }).accounts?.issuer, 'fake');
    // npm run local: a production build only this computer reaches signs in with the stand-in; a server never does.
    assert.equal(loadConfig({ NODE_ENV: 'production', LOCAL_SECRETS: 'true', HOST: '127.0.0.1' }).accounts?.issuer, 'fake');
    assert.throws(() => loadConfig({ NODE_ENV: 'production', LOCAL_SECRETS: 'true', HOST: '0.0.0.0' }), /ACCOUNTS_ISSUER is required/);
    assert.throws(() => loadConfig({ NODE_ENV: 'production', HOST: '127.0.0.1', ACCOUNTS_ISSUER: 'fake' }), /stand-in/);
    assert.equal(loadConfig({ NODE_ENV: 'test' }).accounts, undefined);
    assert.throws(() => loadConfig({ NODE_ENV: 'test', ACCOUNTS_ISSUER: 'fake', PASSWORD_SIGN_IN: 'on' }), /removed in M9/);
    assert.equal(loadConfig({ NODE_ENV: 'test', ACCOUNTS_ISSUER: 'fake', PASSWORD_SIGN_IN: 'off' }).accounts?.issuer, 'fake');
  });
});
