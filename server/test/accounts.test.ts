// Sign-in through LotusPond Accounts (docs/identity.md), against the stand-in issuer (ACCOUNTS_ISSUER=fake):
// a first sign-in finishes sign-up on Health's page, a returning one signs straight in, an account from before
// Accounts is linked only when Accounts has verified its email, company-managed accounts are refused, and the flow's state,
// nonce and PKCE are checked.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDatabase, type Database } from '../src/db/client.ts';
import { auditEvents, profiles, sessions, users } from '../src/db/schema.ts';
import { createSession } from '../src/auth/sessions.ts';
import { DiskFileStore } from '../src/lib/files.ts';
import { AccountsClient, OidcError, pkceChallenge } from '../src/auth/oidc.ts';
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

/** A Health account from before LotusPond Accounts: no Accounts subject yet. */
async function existing(address: string) {
  const [u] = await database.db.insert(users).values({ email: address, country: 'IN', region: 'in', ageConfirmedAt: new Date() }).returning();
  await database.db.insert(profiles).values({ userId: u.id, relationship: 'self', displayName: 'Asha Rao' });
  return u;
}

/** A session from a Health password sign-in before M9, in this browser. Such sessions outlive the passwords. */
async function passwordSession(b: ReturnType<typeof browser>, userId: string) {
  const { token } = await createSession(database.db, 'in', userId, 30 * 86_400_000, undefined);
  b.jar.set('lp_session', token);
}

interface Choices { email: string; verified?: boolean; region?: string; enterprise?: boolean }

/** Start → the stand-in Accounts page → callback. Returns where Health sent the browser. */
async function signInWithAccounts(b: ReturnType<typeof browser>, who: Choices, intent: 'signup' | 'login' = 'login') {
  const callback = await throughAccounts(b, who, `intent=${intent}`, intent);
  assert.equal(callback.status, 302);
  return new URL(callback.headers.get('location')!, 'http://health.test');
}

/** The browser's way through the stand-in Accounts page; returns Health's answer to the callback. */
async function throughAccounts(b: ReturnType<typeof browser>, who: Choices, query: string, intent: 'signup' | 'login' = 'login') {
  const start = await b.go('GET', `/api/auth/accounts/start?${query}`);
  assert.equal(start.status, 302);
  const authorize = new URL(start.headers.get('location')!, 'http://health.test');
  assert.equal(authorize.pathname, '/api/dev-accounts/authorize');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  // Sign-up is asked with screen_hint=signup: Accounts' Hydra refuses prompt=create.
  assert.equal(authorize.searchParams.get('screen_hint'), intent === 'signup' ? 'signup' : null);
  assert.equal(authorize.searchParams.get('prompt'), null);
  const form = new URLSearchParams();
  for (const k of ['client_id', 'redirect_uri', 'state', 'nonce', 'code_challenge']) form.set(k, authorize.searchParams.get(k)!);
  form.set('email', who.email);
  if (who.verified !== false) form.set('email_verified', 'true');
  form.set('region', who.region ?? 'in');
  if (who.enterprise) form.set('enterprise', 'true');
  const issued = await b.go('POST', '/api/dev-accounts/authorize', form.toString(), 'application/x-www-form-urlencoded');
  assert.equal(issued.status, 302);
  return b.go('GET', issued.headers.get('location')!);
}

/** The app's side: a PKCE pair, the system browser's sign-in, and the link it hands back to the app. */
async function appThroughAccounts(who: Choices) {
  const { pkceChallenge } = await import('../src/auth/oidc.ts');
  const verifier = randomBytes(32).toString('base64url');
  const res = await throughAccounts(browser(), who, `intent=login&client=app&code_challenge=${pkceChallenge(verifier)}`);
  assert.equal(res.status, 200);
  const html = await res.text();
  const link = /content="0;url=([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, '&');
  assert.ok(link?.startsWith('ai.lotuspond.health:/accounts?'), html);
  const params = new URL(link!).searchParams;
  return { verifier, code: params.get('code'), error: params.get('error') };
}

/** A request as the app makes it: no cookies, the app header, a bearer token once it has one. */
const appCall = (method: string, url: string, body?: unknown, token?: string) => app.request(new URL(url, 'http://health.test').toString(), {
  method,
  headers: { 'x-lotuspond-client': 'app', origin: 'capacitor://localhost', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});

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
    const [made] = await database.db.select().from(users).where(eq(users.email, address));
    assert.ok(made.accountsSignedInAt, 'made by signing in with Accounts: moved from the start');
    const info = await done.json() as SessionInfo;
    assert.equal(info.account.email, address);
    assert.equal(info.account.region, 'in');
    assert.equal(info.profiles[0].displayName, 'Asha Rao');
    assert.equal((await b.go('GET', '/api/auth/accounts/pending')).status, 404, 'the pending sign-up is used up');

    const [row] = await database.db.select().from(users).where(eq(users.email, address));
    assert.match(row.accountsSubject ?? '', /^dev\|/);

    // An app from before Accounts, signing in with a password, is told where this account signs in.
    const pw = await browser().json('POST', '/api/auth/login', { email: address, password: 'anything at all' });
    assert.equal(pw.status, 409);
    assert.equal(((await pw.json()) as { error: { code: string } }).error.code, 'use_accounts');

    const again = browser();
    const back = await signInWithAccounts(again, { email: address });
    assert.equal(back.pathname, '/app');
    assert.equal(((await (await again.go('GET', '/api/auth/me')).json()) as SessionInfo).account.email, address);
  });

  test('an account from before Accounts is linked when Accounts has verified the email', async () => {
    const address = email('existing');
    await existing(address);

    const unverified = await signInWithAccounts(browser(), { email: address, verified: false });
    assert.equal(unverified.searchParams.get('accounts_error'), 'email_unverified');
    let [row] = await database.db.select().from(users).where(eq(users.email, address));
    assert.equal(row.accountsSubject, null, 'not linked without a verified email');

    const b = browser();
    assert.equal((await signInWithAccounts(b, { email: address })).pathname, '/app');
    [row] = await database.db.select().from(users).where(eq(users.email, address));
    assert.match(row.accountsSubject ?? '', /^dev\|/);
    assert.ok(row.accountsSignedInAt, 'the first Accounts sign-in is recorded');
    const events = await database.db.select().from(auditEvents).where(eq(auditEvents.userId, row.id));
    assert.ok(events.some(e => e.kind === 'accounts_linked'));

    // Health has no passwords: the old routes give the same answer, whatever is sent.
    for (const password of ['correct horse battery', 'not the password at all']) {
      const pw = await browser().json('POST', '/api/auth/login', { email: address, password });
      assert.equal(pw.status, 409);
      assert.equal(((await pw.json()) as { error: { code: string } }).error.code, 'use_accounts');
    }
    const me = (await (await b.go('GET', '/api/auth/me')).json()) as SessionInfo;
    assert.equal('hasPassword' in me.account, false, 'the Account page has no Health password to offer');
    const change = await b.json('POST', '/api/auth/password', { currentPassword: 'correct horse battery', newPassword: 'another long password' });
    assert.equal(change.status, 409);
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

  test('a session kept from before ID tokens were stored signs out at Accounts without asking to come back', async () => {
    const b = browser();
    const address = email('old-session');
    await signInWithAccounts(b, { email: address }, 'signup');
    assert.equal((await b.json('POST', '/api/auth/accounts/complete', finish())).status, 201);
    const [user] = await database.db.select({ id: users.id }).from(users).where(eq(users.email, address));
    await database.db.update(sessions).set({ accountsIdToken: null }).where(eq(sessions.userId, user.id));
    await b.go('POST', '/api/auth/logout');
    const end = new URL((await b.go('GET', '/api/auth/accounts/sign-out')).headers.get('location')!, 'http://health.test');
    assert.equal(end.searchParams.get('client_id'), 'lotuspond-health');
    assert.equal(end.searchParams.get('post_logout_redirect_uri'), null, 'no return address without a hint: Accounts would refuse it');
    assert.equal((await b.go('GET', `${end.pathname}${end.search}`)).status, 200);
  });

  test('the stand-in refuses what Accounts refuses: prompt=create, and a return after sign-out without a hint', async () => {
    const q = new URLSearchParams({ client_id: 'lotuspond-health', response_type: 'code', redirect_uri: 'http://health.test/cb', state: 's'.repeat(12), nonce: 'n'.repeat(12), code_challenge: 'c'.repeat(43), code_challenge_method: 'S256', prompt: 'create' });
    const create = await browser().go('GET', `/api/dev-accounts/authorize?${q}`);
    assert.equal(create.status, 400);
    assert.match(await create.text(), /unknown value (&#39;|')create(&#39;|') for prompt/);
    const back = await browser().go('GET', `/api/dev-accounts/logout?${new URLSearchParams({ client_id: 'lotuspond-health', post_logout_redirect_uri: 'http://health.test/login' })}`);
    assert.equal(back.status, 400);
    assert.match(await back.text(), /id_token_hint is missing/);
  });

  test('signing out of a session from Accounts goes on to sign out there, once, and only from Health\'s own sign-out', async () => {
    const b = browser();
    const address = email('signout');
    await signInWithAccounts(b, { email: address }, 'signup');
    assert.equal((await b.json('POST', '/api/auth/accounts/complete', finish())).status, 201);
    const out = await b.go('POST', '/api/auth/logout');
    assert.equal(out.status, 200);
    assert.deepEqual(await out.json(), { accountsSignOut: '/api/auth/accounts/sign-out' });
    assert.equal((await (await b.go('GET', '/api/auth/me')).json()), null, 'Health\'s session has ended');

    const toAccounts = await b.go('GET', '/api/auth/accounts/sign-out');
    assert.equal(toAccounts.status, 302);
    const end = new URL(toAccounts.headers.get('location')!, 'http://health.test');
    assert.equal(end.pathname, '/api/dev-accounts/logout');
    // The session's own ID token goes as the hint: without it, Accounts refuses to send the browser back.
    const hint = end.searchParams.get('id_token_hint') ?? '';
    assert.match(hint, /^[\w-]+\.[\w-]+\.[\w-]+$/);
    assert.equal(JSON.parse(Buffer.from(hint.split('.')[1], 'base64url').toString()).email, address);
    assert.equal(end.searchParams.get('post_logout_redirect_uri'), 'http://health.test/login');
    assert.equal((await b.go('GET', `${end.pathname}${end.search}`)).status, 200, 'the stand-in shows its sign-out page');
    const again = await b.go('GET', '/api/auth/accounts/sign-out');
    assert.equal(new URL(again.headers.get('location')!).pathname, '/login', 'the ticket works once');

    // A link from another site, without Health's sign-out first, only goes to the sign-in page.
    const stranger = await browser().go('GET', '/api/auth/accounts/sign-out');
    assert.equal(new URL(stranger.headers.get('location')!).pathname, '/login');
  });

  test('signing out of a session from a Health password, from before M9, stays on Health', async () => {
    const b = browser();
    await passwordSession(b, (await existing(email('pw-out'))).id);
    assert.ok(await (await b.go('GET', '/api/auth/me')).json(), 'the session outlives the passwords');
    assert.equal((await b.go('POST', '/api/auth/logout')).status, 204);
  });

  test('an account can delete itself only soon after signing in with Accounts', async () => {
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

describe('LotusPond Accounts sign-in from the apps', () => {
  test('an existing account: the one-time code and the app\'s verifier give a token session, once', async () => {
    const address = email('app');
    await existing(address);
    const { code, verifier } = await appThroughAccounts({ email: address });
    assert.ok(code);

    assert.equal((await appCall('POST', '/api/auth/accounts/app-exchange', { code, verifier: randomBytes(32).toString('base64url') })).status, 400, 'another verifier is refused');
    const res = await appCall('POST', '/api/auth/accounts/app-exchange', { code, verifier });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(res.headers.get('set-cookie'), null, 'no cookie for the app');
    const signedIn = await res.json() as SessionInfo & { token: string; expiresAt: string };
    assert.match(signedIn.token, /^in\./);
    assert.equal(signedIn.account.email, address);
    const me = await (await appCall('GET', '/api/auth/me', undefined, signedIn.token)).json() as SessionInfo;
    assert.equal(me.account.email, address);
    assert.equal((await appCall('POST', '/api/auth/accounts/app-exchange', { code, verifier })).status, 400, 'a code works once');
  });

  test('someone new finishes sign-up in the app with the token the exchange gave', async () => {
    const address = email('app-new');
    const { code, verifier } = await appThroughAccounts({ email: address });
    const res = await appCall('POST', '/api/auth/accounts/app-exchange', { code, verifier });
    const started = await res.json() as { pending: { email: string; region: string }; pendingToken: string };
    assert.deepEqual(started.pending, { email: address, region: 'in' });
    assert.equal((await appCall('POST', '/api/auth/accounts/complete', finish())).status, 409, 'not without the token');
    const done = await appCall('POST', '/api/auth/accounts/complete', { ...finish(), pendingToken: started.pendingToken });
    assert.equal(done.status, 201, await done.clone().text());
    const info = await done.json() as SessionInfo & { token: string };
    assert.equal(info.account.email, address);
    assert.equal(((await (await appCall('GET', '/api/auth/me', undefined, info.token)).json()) as SessionInfo).account.email, address);
    // Signing out in the app: Health's session ends, and the app gets an address to open in the system browser.
    const out = await appCall('POST', '/api/auth/logout', undefined, info.token);
    assert.equal(out.status, 200);
    assert.ok(out.headers.getSetCookie().every(c => /Max-Age=0/.test(c)), 'no cookie is set for the app (clearing one is harmless)');
    const { accountsSignOut } = await out.json() as { accountsSignOut: string };
    assert.match(accountsSignOut, /^http:\/\/health\.test\/api\/auth\/accounts\/sign-out\?ticket=/);
    assert.equal(await (await appCall('GET', '/api/auth/me', undefined, info.token)).json(), null);
    // The system browser (no cookies from the app): on to Accounts, back to Health's page, on to the app.
    const sys = browser();
    const toAccounts = await sys.go('GET', accountsSignOut);
    const end = new URL(toAccounts.headers.get('location')!, 'http://health.test');
    assert.equal(end.pathname, '/api/dev-accounts/logout');
    assert.equal(end.searchParams.get('post_logout_redirect_uri'), 'http://health.test/api/auth/accounts/signed-out');
    assert.ok(end.searchParams.get('id_token_hint'), 'the app\'s sign-out carries the ID token as the hint too');
    assert.doesNotMatch(accountsSignOut, /eyJ/, 'the ticket in the address is encrypted: no readable token in it');
    assert.equal((await sys.go('GET', `${end.pathname}${end.search}`)).status, 200, 'the stand-in accepts it');
    const page = await (await sys.go('GET', '/api/auth/accounts/signed-out')).text();
    assert.match(page, /url=ai\.lotuspond\.health:\/accounts\?signed_out=1"/);
    assert.match(page, /Signed out of your LotusPond account/);
    // A ticket made up, or a website ticket put in the address, goes nowhere.
    assert.equal(new URL((await browser().go('GET', '/api/auth/accounts/sign-out?ticket=abc.def')).headers.get('location')!).pathname, '/login');
    // The website's cookie-held sign-up cannot be finished with an app token, nor the other way round.
    assert.equal((await browser().json('POST', '/api/auth/accounts/complete', { ...finish(), pendingToken: started.pendingToken })).status, 409);
  });

  test('refusals go back to the app; a start without the app\'s PKCE challenge is refused', async () => {
    const refused = await appThroughAccounts({ email: email('app-work'), enterprise: true });
    assert.equal(refused.code, null);
    assert.equal(refused.error, 'enterprise_account');
    assert.equal((await browser().go('GET', '/api/auth/accounts/start?client=app')).status, 400);
    assert.equal((await appCall('POST', '/api/auth/accounts/app-exchange', { code: 'made-up', verifier: randomBytes(32).toString('base64url') })).status, 400);
  });
});

describe('an agent\'s consent page with LotusPond Accounts', () => {
  async function registerAgent() {
    const res = await app.request('http://health.test/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude', redirect_uris: ['https://claude.example/callback'], token_endpoint_auth_method: 'none' }) });
    assert.equal(res.status, 201, await res.clone().text());
    return (await res.json() as { client_id: string }).client_id;
  }
  const consentUrl = (clientId: string) => `/oauth/authorize?${new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: 'https://claude.example/callback',
    code_challenge: pkceChallenge(randomBytes(32).toString('base64url')), code_challenge_method: 'S256', state: 'xyz', scope: 'health:read',
  })}`;
  /** Follow Health's redirects (on this host) until a page answers; returns the path it ended on and the answer. */
  async function follow(b: ReturnType<typeof browser>, url: string) {
    for (let i = 0; i < 8; i++) {
      const res = await b.go('GET', url);
      if (res.status !== 302) return { path: new URL(url, 'http://health.test'), res };
      url = new URL(res.headers.get('location')!, 'http://health.test').toString();
    }
    throw new Error('too many redirects');
  }

  test('signed out everywhere: a silent check at Accounts, then Health\'s sign-in page, which keeps the consent page', async () => {
    const consent = consentUrl(await registerAgent());
    const first = await browser().go('GET', consent);
    const start = new URL(first.headers.get('location')!, 'http://health.test');
    assert.equal(start.pathname, '/api/auth/accounts/start');
    assert.equal(start.searchParams.get('prompt'), 'none');
    assert.equal(start.searchParams.get('next'), consent);
    const { path } = await follow(browser(), consent);
    assert.equal(path.pathname, '/login');
    assert.equal(path.searchParams.get('next'), consent);
  });

  test('signing in with Accounts from there returns to the consent page; later, Accounts\' own sign-in is enough', async () => {
    const consent = consentUrl(await registerAgent());
    const address = email('agent');
    await existing(address);
    const b = browser();
    const back = await throughAccounts(b, { email: address }, `intent=login&${new URLSearchParams({ next: consent })}`);
    assert.equal(new URL(back.headers.get('location')!).pathname + new URL(back.headers.get('location')!).search, consent);
    assert.equal((await b.go('GET', consent)).status, 200, 'the consent page shows');

    // Health's session ends (signed out of Health only); Accounts still remembers this browser.
    b.jar.delete('lp_session');
    const { path, res } = await follow(b, consent);
    assert.equal(path.pathname + path.search, consent, 'back on the consent page without a sign-in page');
    assert.match(await res.text(), /<form/);
  });

  test('only this site\'s consent page is a place to return to', async () => {
    for (const next of ['https://evil.example/oauth/authorize?x=1', '//evil.example/oauth/authorize?x', '/app', '/oauth/authorize?a=1//b']) {
      const b = browser();
      const start = await b.go('GET', `/api/auth/accounts/start?${new URLSearchParams({ intent: 'login', prompt: 'none', next })}`);
      const authorize = new URL(start.headers.get('location')!, 'http://health.test');
      assert.equal(authorize.searchParams.get('prompt'), 'none');
      const res = await b.go('GET', `/api/auth/accounts/callback?error=login_required&state=${authorize.searchParams.get('state')}`);
      assert.equal(res.headers.get('location'), 'http://health.test/login', `${next} is dropped`);
    }
  });
});

describe('back-channel logout', () => {
  const everywhere = (address: string, sid?: string) => browser().go('POST', '/api/dev-accounts/logout-everywhere',
    new URLSearchParams({ email: address, ...(sid ? { sid } : {}) }).toString(), 'application/x-www-form-urlencoded');

  test('signing out everywhere at Accounts ends the website and app sessions from Accounts, not password sessions', async () => {
    const address = email('bcl');
    const pw = browser();
    await passwordSession(pw, (await existing(address)).id);
    const web = browser();
    assert.equal((await signInWithAccounts(web, { email: address })).pathname, '/app', 'links the account');
    const { code, verifier } = await appThroughAccounts({ email: address });
    const appSession = await (await appCall('POST', '/api/auth/accounts/app-exchange', { code, verifier })).json() as { token: string };

    const res = await everywhere(address);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /2 LotusPond Health sessions ended/);
    assert.equal(await (await web.go('GET', '/api/auth/me')).json(), null, 'the website session from Accounts has ended');
    assert.equal(await (await appCall('GET', '/api/auth/me', undefined, appSession.token)).json(), null, 'the app session from Accounts has ended');
    assert.ok(await (await pw.go('GET', '/api/auth/me')).json(), 'the password session stays');
    const [row] = await database.db.select().from(users).where(eq(users.email, address));
    const events = await database.db.select().from(auditEvents).where(eq(auditEvents.userId, row.id));
    assert.ok(events.some(e => e.kind === 'accounts_signed_out'));
  });

  test('a logout naming one Accounts session ends only the Health sessions from it', async () => {
    const address = email('bcl-sid');
    const one = browser();
    const two = browser();
    await signInWithAccounts(one, { email: address }, 'signup');
    assert.equal((await one.json('POST', '/api/auth/accounts/complete', finish())).status, 201);
    await signInWithAccounts(two, { email: address });
    const [row] = await database.db.select().from(users).where(eq(users.email, address));
    const rows = await database.db.select().from(sessions).where(eq(sessions.userId, row.id));
    assert.equal(rows.length, 2);
    assert.ok(rows.every(r => r.viaAccounts && r.accountsSid), 'each session keeps its Accounts session');
    // The first sign-in's session ends; the second stays.
    const first = rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
    assert.match(await (await everywhere(address, first.accountsSid!)).text(), /1 LotusPond Health session ended/);
    assert.equal(await (await one.go('GET', '/api/auth/me')).json(), null);
    assert.ok(await (await two.go('GET', '/api/auth/me')).json());
  });

  test('the endpoint refuses a missing token and one signed with another key', async () => {
    const post = (token?: string) => app.request('http://health.test/api/auth/accounts/backchannel-logout', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: token === undefined ? '' : new URLSearchParams({ logout_token: token }).toString(),
    });
    assert.equal((await post()).status, 400);
    const impostor = fakeAccounts('lotuspond-health');
    const forged = await post(impostor.logoutToken({ sub: 'dev|x' }));
    assert.equal(forged.status, 400);
    assert.equal(forged.headers.get('cache-control'), 'no-store');
  });
});

describe('logout token checks', () => {
  const fake = fakeAccounts('lotuspond-health');
  const client = new AccountsClient({ issuer: 'fake', clientId: 'lotuspond-health' }, fake.fetch, fake.metadata);
  const refused = (token: string, why: RegExp) => assert.rejects(client.verifyLogoutToken(token), (e: unknown) => e instanceof OidcError && why.test(e.message));

  test('a good token names the account or the session', async () => {
    assert.deepEqual((({ subject, sessionId }) => ({ subject, sessionId }))(await client.verifyLogoutToken(fake.logoutToken({ sub: 'dev|a' }))), { subject: 'dev|a', sessionId: null });
    assert.equal((await client.verifyLogoutToken(fake.logoutToken({ sid: 's1' }))).sessionId, 's1');
  });

  test('refused: no event, a nonce, no jti, neither sub nor sid, too old, another client', async () => {
    await refused(fake.logoutToken({ sub: 'dev|a' }, { events: {} }), /back-channel logout event/);
    await refused(fake.logoutToken({ sub: 'dev|a' }, { nonce: 'n' }), /nonce/);
    await refused(fake.logoutToken({ sub: 'dev|a' }, { jti: undefined }), /jti/);
    await refused(fake.logoutToken({}), /neither/);
    await refused(fake.logoutToken({ sub: 'dev|a' }, { iat: Math.floor(Date.now() / 1000) - 3600 }), /too old/);
    await refused(fake.logoutToken({ sub: 'dev|a' }, { aud: 'someone-else' }), /another service/);
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
