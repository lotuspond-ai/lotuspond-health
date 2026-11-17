// Sign-in through LotusPond Accounts (docs/identity.md), against the stand-in issuer (ACCOUNTS_ISSUER=fake):
// a first sign-in finishes sign-up on Health's page, a returning one signs straight in, an existing password account
// is linked only when Accounts has verified its email, company-managed accounts are refused, and the flow's state,
// nonce and PKCE are checked.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDatabase, type Database } from '../src/db/client.ts';
import { auditEvents, users } from '../src/db/schema.ts';
import { DiskFileStore } from '../src/lib/files.ts';
import { AccountsClient, OidcError } from '../src/auth/oidc.ts';
import { fakeAccounts } from '../src/auth/fake-accounts.ts';
import type { AppEnv } from '../src/http.ts';
import type { SessionInfo } from '../../shared/types.ts';
import { registration } from './helpers.ts';

let database: Database;
let filesDir: string;
let app: Hono<AppEnv>;

before(async () => {
  database = await openDatabase({ url: process.env.TEST_DATABASE_URL });
  await database.migrate(fileURLToPath(new URL('../drizzle', import.meta.url)));
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspond-accounts-'));
  app = createApp({ db: database.db, files: new DiskFileStore(filesDir), config: loadConfig({ NODE_ENV: 'test', RECORD_AGENT: 'off', ACCOUNTS_ISSUER: 'fake' }) });
});
after(async () => { await database.close(); fs.rmSync(filesDir, { recursive: true, force: true }); });

let n = 0;
const email = (tag: string) => `${tag}.${Date.now().toString(36)}.${++n}@example.com`;

/** A browser: keeps cookies by name and sends same-origin fetch metadata. */
function browser() {
  const jar = new Map<string, string>();
  async function go(method: string, url: string, body?: string, type?: string) {
    const headers: Record<string, string> = { 'sec-fetch-site': 'same-origin', host: 'health.test' };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (type) headers['content-type'] = type;
    const res = await app.request(new URL(url, 'http://health.test').toString(), { method, headers, body });
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';');
      const [k, ...v] = pair.split('=');
      const gone = attrs.some(a => /max-age=0\b/i.test(a.trim())) || attrs.some(a => /^\s*expires=Thu, 01 Jan 1970/i.test(a));
      if (gone || !v.join('=')) jar.delete(k.trim()); else jar.set(k.trim(), v.join('='));
    }
    return res;
  }
  return { jar, go, json: (method: string, url: string, body?: unknown) => go(method, url, body === undefined ? undefined : JSON.stringify(body), body === undefined ? undefined : 'application/json') };
}

interface Choices { email: string; verified?: boolean; region?: string; enterprise?: boolean }

/** Start → the stand-in Accounts page → callback. Returns where Health sent the browser. */
async function signInWithAccounts(b: ReturnType<typeof browser>, who: Choices, intent: 'signup' | 'login' = 'login') {
  const start = await b.go('GET', `/api/auth/accounts/start?intent=${intent}`);
  assert.equal(start.status, 302);
  const authorize = new URL(start.headers.get('location')!, 'http://health.test');
  assert.equal(authorize.pathname, '/api/dev-accounts/authorize');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorize.searchParams.get('prompt'), intent === 'signup' ? 'create' : null);
  const form = new URLSearchParams();
  for (const k of ['client_id', 'redirect_uri', 'state', 'nonce', 'code_challenge']) form.set(k, authorize.searchParams.get(k)!);
  form.set('email', who.email);
  if (who.verified !== false) form.set('email_verified', 'true');
  form.set('region', who.region ?? 'in');
  if (who.enterprise) form.set('enterprise', 'true');
  const issued = await b.go('POST', '/api/dev-accounts/authorize', form.toString(), 'application/x-www-form-urlencoded');
  assert.equal(issued.status, 302);
  const callback = await b.go('GET', issued.headers.get('location')!);
  assert.equal(callback.status, 302);
  return new URL(callback.headers.get('location')!, 'http://health.test');
}

const finish = (country = 'IN') => {
  const { email: _e, password: _p, ...rest } = registration('unused@example.com', country);
  return rest;
};

describe('LotusPond Accounts sign-in', () => {
  test('first sign-in finishes sign-up on Health, with no Health password; the next one signs straight in', async () => {
    const b = browser();
    const address = email('new');
    const to = await signInWithAccounts(b, { email: address }, 'signup');
    assert.equal(`${to.pathname}${to.search}`, '/signup?accounts=continue');
    assert.equal((await (await b.go('GET', '/api/auth/me')).json()), null, 'not signed in until sign-up is finished');

    const pending = await (await b.go('GET', '/api/auth/accounts/pending')).json() as { email: string; region: string };
    assert.deepEqual(pending, { email: address, region: 'in' });
    const done = await b.json('POST', '/api/auth/accounts/complete', finish());
    assert.equal(done.status, 201, await done.clone().text());
    const info = await done.json() as SessionInfo;
    assert.equal(info.account.email, address);
    assert.equal(info.account.region, 'in');
    assert.equal(info.profiles[0].displayName, 'Asha Rao');
    assert.equal((await b.go('GET', '/api/auth/accounts/pending')).status, 404, 'the pending sign-up is used up');

    const [row] = await database.db.select().from(users).where(eq(users.email, address));
    assert.equal(row.passwordHash, null);
    assert.match(row.accountsSubject ?? '', /^dev\|/);

    // The password form explains where this account signs in.
    const pw = await browser().json('POST', '/api/auth/login', { email: address, password: 'anything at all' });
    assert.equal(pw.status, 409);
    assert.equal(((await pw.json()) as { error: { code: string } }).error.code, 'use_accounts');

    const again = browser();
    const back = await signInWithAccounts(again, { email: address });
    assert.equal(back.pathname, '/app');
    assert.equal(((await (await again.go('GET', '/api/auth/me')).json()) as SessionInfo).account.email, address);
  });

  test('an existing password account is linked when Accounts has verified the email, and keeps its password', async () => {
    const address = email('existing');
    const reg = await browser().json('POST', '/api/auth/register', registration(address));
    assert.equal(reg.status, 201, await reg.clone().text());

    const unverified = await signInWithAccounts(browser(), { email: address, verified: false });
    assert.equal(unverified.searchParams.get('accounts_error'), 'email_unverified');
    let [row] = await database.db.select().from(users).where(eq(users.email, address));
    assert.equal(row.accountsSubject, null, 'not linked without a verified email');

    const b = browser();
    assert.equal((await signInWithAccounts(b, { email: address })).pathname, '/app');
    [row] = await database.db.select().from(users).where(eq(users.email, address));
    assert.match(row.accountsSubject ?? '', /^dev\|/);
    const events = await database.db.select().from(auditEvents).where(eq(auditEvents.userId, row.id));
    assert.ok(events.some(e => e.kind === 'accounts_linked'));
    const pw = await browser().json('POST', '/api/auth/login', { email: address, password: 'correct horse battery' });
    assert.equal(pw.status, 200, 'the old password still works while both ways are open');
  });

  test('an account made through a company single sign-on is refused', async () => {
    const to = await signInWithAccounts(browser(), { email: email('work'), enterprise: true });
    assert.equal(to.searchParams.get('accounts_error'), 'enterprise_account');
  });

  test('a callback without its own state, or from another browser, is refused', async () => {
    const b = browser();
    await b.go('GET', '/api/auth/accounts/start');
    const forged = await b.go('GET', '/api/auth/accounts/callback?code=x&state=not-the-state');
    assert.equal(new URL(forged.headers.get('location')!).searchParams.get('accounts_error'), 'expired');
    const stranger = await browser().go('GET', '/api/auth/accounts/callback?code=x&state=y');
    assert.equal(new URL(stranger.headers.get('location')!).searchParams.get('accounts_error'), 'expired');
    const cancelled = browser();
    const start = await cancelled.go('GET', '/api/auth/accounts/start');
    const state = new URL(start.headers.get('location')!, 'http://health.test').searchParams.get('state');
    const res = await cancelled.go('GET', `/api/auth/accounts/callback?error=access_denied&state=${state}`);
    assert.equal(new URL(res.headers.get('location')!).searchParams.get('accounts_error'), 'cancelled');
  });

  test('finishing sign-up checks Health\'s own questions and the region Accounts gave', async () => {
    const b = browser();
    await signInWithAccounts(b, { email: email('checks'), region: 'eu' });
    const noConsent = await b.json('POST', '/api/auth/accounts/complete', { ...finish(), consents: { termsAndPrivacy: true, healthData: false, crossBorder: false, marketing: false } });
    assert.equal(noConsent.status, 400);
    const mismatch = await b.json('POST', '/api/auth/accounts/complete', finish('IN'));
    assert.equal(mismatch.status, 409);
    assert.equal(((await mismatch.json()) as { error: { code: string } }).error.code, 'region_mismatch');
    const expired = await browser().json('POST', '/api/auth/accounts/complete', finish());
    assert.equal(expired.status, 409);
  });

  test('an account without a Health password can delete itself only soon after signing in', async () => {
    const b = browser();
    const address = email('delete');
    await signInWithAccounts(b, { email: address }, 'signup');
    assert.equal((await b.json('POST', '/api/auth/accounts/complete', finish())).status, 201);
    const change = await b.json('POST', '/api/auth/password', { currentPassword: '', newPassword: 'a new password here' });
    assert.equal(change.status, 409);
    const del = await b.json('DELETE', '/api/auth/account', {});
    assert.equal(del.status, 204, await del.clone().text());
    assert.equal((await database.db.select().from(users).where(eq(users.email, address))).length, 0);
  });
});

describe('ID token checks', () => {
  async function tokenFor(fake: ReturnType<typeof fakeAccounts>, nonce: string, verifier = 'v'.repeat(43)) {
    const { pkceChallenge } = await import('../src/auth/oidc.ts');
    const form = new URLSearchParams({ client_id: 'lotuspond-health', redirect_uri: 'http://health.test/cb', state: 's', nonce, code_challenge: pkceChallenge(verifier), email: 'a@example.com', email_verified: 'true' });
    const res = await fake.app.request('/authorize', { method: 'POST', body: form, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    return new URL(res.headers.get('location')!).searchParams.get('code')!;
  }

  test('a wrong nonce, a wrong PKCE verifier, another issuer\'s key or another client are refused', async () => {
    const fake = fakeAccounts('lotuspond-health');
    const client = new AccountsClient({ issuer: 'fake', clientId: 'lotuspond-health' }, fake.fetch, fake.metadata);
    const ok = await client.signIn({ code: await tokenFor(fake, 'n1'), verifier: 'v'.repeat(43), redirectUri: 'http://health.test/cb', nonce: 'n1' });
    assert.equal(ok.email, 'a@example.com');
    await assert.rejects(client.signIn({ code: await tokenFor(fake, 'n2'), verifier: 'v'.repeat(43), redirectUri: 'http://health.test/cb', nonce: 'other' }),
      (e: unknown) => e instanceof OidcError && /this sign-in/.test(e.message));
    await assert.rejects(client.signIn({ code: await tokenFor(fake, 'n3'), verifier: 'w'.repeat(43), redirectUri: 'http://health.test/cb', nonce: 'n3' }),
      (e: unknown) => e instanceof OidcError && e.code === 'sign_in_failed');

    // Same issuer name and endpoints, a different signing key: refused (unknown key, or a signature that fails).
    const impostor = fakeAccounts('lotuspond-health');
    const code = await tokenFor(impostor, 'n4');
    const tokens = await (await impostor.fetch('/api/dev-accounts/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: 'lotuspond-health', redirect_uri: 'http://health.test/cb', code_verifier: 'v'.repeat(43) }), headers: { 'content-type': 'application/x-www-form-urlencoded' } })).json() as { id_token: string };
    const strict = new AccountsClient({ issuer: 'fake', clientId: 'lotuspond-health' }, fake.fetch, fake.metadata);
    await assert.rejects(strict.verifyIdToken(tokens.id_token, 'n4'), (e: unknown) => e instanceof OidcError && /signature|does not publish/.test(e.message));
    const otherClient = new AccountsClient({ issuer: 'fake', clientId: 'someone-else' }, impostor.fetch, impostor.metadata);
    await assert.rejects(otherClient.verifyIdToken(tokens.id_token, 'n4'), (e: unknown) => e instanceof OidcError && /another service/.test(e.message));
  });

  test('the stand-in issuer is refused in production', () => {
    assert.throws(() => loadConfig({ NODE_ENV: 'production', ACCOUNTS_ISSUER: 'fake', DIRECTORY_SECRET: 'x'.repeat(44), FILE_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64') }), /stand-in/);
    assert.throws(() => loadConfig({ NODE_ENV: 'test', ACCOUNTS_ISSUER: 'http://accounts.example.com', ACCOUNTS_CLIENT_ID: 'x' }), /https/);
    assert.throws(() => loadConfig({ NODE_ENV: 'test', ACCOUNTS_ISSUER: 'https://accounts.example.com' }), /ACCOUNTS_CLIENT_ID/);
  });
});
