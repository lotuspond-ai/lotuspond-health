// Moving account identity into LotusPond Accounts: the export for Accounts to import, linking Accounts' answer, and a
// server with PASSWORD_SIGN_IN=off, where Accounts is the only way in and Health's email directory is no longer used.
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
import { auditEvents, directory, users } from '../src/db/schema.ts';
import { DiskFileStore } from '../src/lib/files.ts';
import { singleCell } from '../src/cells.ts';
import { ephemeralSecrets } from '../src/compliance/secrets.ts';
import { emailHash } from '../src/compliance/directory.ts';
import { exportAccounts, linkAccounts, readJsonLines, type ExportedAccount } from '../src/auth/accounts-migration.ts';
import { fakeSubject } from '../src/auth/fake-accounts.ts';
import type { AppEnv } from '../src/http.ts';
import type { ServiceInfo, SessionInfo } from '../../shared/types.ts';
import { registration } from './helpers.ts';

let database: Database;
let filesDir: string;
let withPasswords: Hono<AppEnv>;
let accountsOnly: Hono<AppEnv>;
const secrets = ephemeralSecrets();

before(async () => {
  database = await openDatabase({ url: process.env.TEST_DATABASE_URL });
  await database.migrate(fileURLToPath(new URL('../drizzle', import.meta.url)));
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspond-accounts-migration-'));
  const files = new DiskFileStore(filesDir);
  const base = { NODE_ENV: 'test', RECORD_AGENT: 'off', ACCOUNTS_ISSUER: 'fake' } as const;
  const on = loadConfig(base);
  const off = loadConfig({ ...base, PASSWORD_SIGN_IN: 'off' });
  const cells = singleCell(database.db, files, on.servedRegions);
  withPasswords = createApp({ db: database.db, files, config: on, cells, secrets });
  accountsOnly = createApp({ db: database.db, files, config: off, cells, secrets });
});
after(async () => { await database.close(); fs.rmSync(filesDir, { recursive: true, force: true }); });

let n = 0;
const email = (tag: string) => `${tag}.${Date.now().toString(36)}.${++n}@example.com`;
const cellsOf = () => [singleCell(database.db, new DiskFileStore(filesDir), ['in', 'eu', 'us', 'global']).defaultCell];

/** A browser on one of the two apps: cookies, same-origin requests, and a sign-in through the stand-in. */
function browser(app: Hono<AppEnv>) {
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

describe('export and link', () => {
  test('the export lists each account with its Argon2id hash as it is, its region and any link already made', async () => {
    const pw = email('export-pw');
    assert.equal((await browser(withPasswords).json('POST', '/api/auth/register', registration(pw))).status, 201);
    const lines: string[] = [];
    const count = await exportAccounts(cellsOf(), l => lines.push(l));
    assert.equal(count, lines.length);
    const mine = lines.map(l => JSON.parse(l) as ExportedAccount).find(a => a.email === pw)!;
    assert.match(mine.password_hash ?? '', /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    assert.equal(mine.region, 'in');
    assert.equal(mine.country, 'IN');
    assert.equal(mine.accounts_subject, null);
    assert.deepEqual(Object.keys(mine).sort(), ['accounts_subject', 'country', 'created_at', 'email', 'health_user_id', 'password_hash', 'region']);
  });

  test('linking Accounts\' answer: new links, unchanged ones, conflicts, unknown ids and unreadable lines', async () => {
    const a = email('link-a');
    const b = email('link-b');
    for (const x of [a, b]) assert.equal((await browser(withPasswords).json('POST', '/api/auth/register', registration(x))).status, 201);
    const [ua] = await database.db.select().from(users).where(eq(users.email, a));
    const [ub] = await database.db.select().from(users).where(eq(users.email, b));
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

describe('PASSWORD_SIGN_IN=off', () => {
  test('the password routes say to use LotusPond Accounts, and the service says so', async () => {
    const b = browser(accountsOnly);
    const info = await (await b.go('GET', '/api/auth/config')).json() as ServiceInfo;
    assert.equal(info.passwordSignIn, false);
    assert.equal(info.accounts, true);
    for (const [url, body] of [['/api/auth/register', registration(email('off'))], ['/api/auth/login', { email: 'x@example.com', password: 'whatever it is' }]] as const) {
      const res = await b.json('POST', url, body);
      assert.equal(res.status, 409);
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'use_accounts');
    }
  });

  test('an account linked by the migration signs in by its subject; one never linked is still found by email, without the directory', async () => {
    const linked = email('off-linked');
    const unlinked = email('off-unlinked');
    for (const x of [linked, unlinked]) assert.equal((await browser(withPasswords).json('POST', '/api/auth/register', registration(x))).status, 201);
    const [ul] = await database.db.select().from(users).where(eq(users.email, linked));
    await linkAccounts(cellsOf(), [{ health_user_id: ul.id, sub: fakeSubject(linked) }]);
    // The directory is gone for these two (as after it is dropped): sign-in must not need it.
    for (const x of [linked, unlinked]) await database.db.delete(directory).where(eq(directory.emailHash, emailHash(secrets.directoryKey, x)));

    for (const x of [linked, unlinked]) {
      const b = browser(accountsOnly);
      assert.equal((await b.accounts(x)).pathname, '/app', x);
      assert.equal(((await (await b.go('GET', '/api/auth/me')).json()) as SessionInfo).account.email, x);
    }
    const [uu] = await database.db.select().from(users).where(eq(users.email, unlinked));
    assert.equal(uu.accountsSubject, fakeSubject(unlinked));
  });

  test('someone new signs up through Accounts without a directory entry', async () => {
    const address = email('off-new');
    const b = browser(accountsOnly);
    assert.equal((await b.accounts(address)).pathname, '/signup');
    const { email: _e, password: _p, ...answers } = registration('unused@example.com');
    assert.equal((await b.json('POST', '/api/auth/accounts/complete', answers)).status, 201);
    assert.equal((await database.db.select().from(directory).where(eq(directory.emailHash, emailHash(secrets.directoryKey, address)))).length, 0);
    assert.equal((await database.db.select().from(users).where(eq(users.email, address))).length, 1);
  });

  test('it needs ACCOUNTS_ISSUER', () => {
    assert.throws(() => loadConfig({ NODE_ENV: 'test', PASSWORD_SIGN_IN: 'off' }), /needs ACCOUNTS_ISSUER/);
  });
});
