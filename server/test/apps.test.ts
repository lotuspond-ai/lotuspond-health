// The iOS and Android apps: token sessions, bearer authentication, the cross-site check, and CORS for app origins.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hono } from 'hono';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDatabase, type Database } from '../src/db/client.ts';
import { DiskFileStore } from '../src/lib/files.ts';
import type { AppEnv } from '../src/http.ts';
import type { Profile, ServiceInfo, SessionInfo } from '../../shared/types.ts';
import { makeClient, registration } from './helpers.ts';
import { profiles, users } from '../src/db/schema.ts';
import { createSession } from '../src/auth/sessions.ts';

const migrations = fileURLToPath(new URL('../drizzle', import.meta.url));
const run = Date.now().toString(36);
const IOS = 'capacitor://localhost';
const ANDROID = 'https://localhost';
let database: Database;
let app: Hono<AppEnv>;
let filesDir: string;
let n = 0;

before(async () => {
  database = await openDatabase({ url: process.env.TEST_DATABASE_URL });
  await database.migrate(migrations);
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspond-apps-'));
  const config = loadConfig({ NODE_ENV: 'test', TRUST_PROXY: 'true', ACCOUNTS_ISSUER: 'fake', REGION_API_ORIGINS: 'in=https://in.health.lotuspond.ai' });
  app = createApp({ db: database.db, files: new DiskFileStore(filesDir), config });
});

after(async () => {
  await database.close();
  fs.rmSync(filesDir, { recursive: true, force: true });
});

/** A request the way the app's web view sends it: cross-site, from the app origin, never with cookies. */
function fromApp(method: string, url: string, opts: { token?: string; body?: unknown; origin?: string; app?: boolean } = {}) {
  const headers: Record<string, string> = {
    origin: opts.origin ?? IOS, 'sec-fetch-site': 'cross-site', 'x-forwarded-for': `10.7.${++n % 250}.1`,
  };
  if (opts.app) headers['x-lotuspond-client'] = 'app';
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let body: string | undefined;
  if (opts.body !== undefined) { body = JSON.stringify(opts.body); headers['content-type'] = 'application/json'; }
  return app.request(url, { method, headers, body });
}

/**
 * A person signed in on the app, with a token session. The app's own way there, through LotusPond Accounts in the
 * system browser and /api/auth/accounts/app-exchange, is tested in accounts.test.ts; here it is what the token does.
 */
async function appSignUp() {
  const email = `app${++n}.${run}@example.com`;
  const [user] = await database.db.insert(users).values({ email, country: 'IN', region: 'in', ageConfirmedAt: new Date() }).returning();
  await database.db.insert(profiles).values({ userId: user.id, relationship: 'self', displayName: 'Asha Rao' });
  const token = await another(user.id);
  const data = await (await fromApp('GET', '/api/auth/me', { token })).json() as SessionInfo;
  return { data, email, userId: user.id, token };
}

/** Another token session for the same person, as from signing in on another device. */
const another = async (userId: string) => (await createSession(database.db, 'in', userId, 30 * 86_400_000, undefined)).token;

describe('mobile apps', () => {
  it('browsers get a cookie and no token', async () => {
    const res = await makeClient(app).signUpCall(registration(`browser.${run}@example.com`));
    assert.equal(res.status, 201);
    assert.ok(res.headers.getSetCookie().some(c => c.startsWith('lp_session=')));
    assert.equal((await res.json() as { token?: string }).token, undefined);
  });

  it('a bearer token works on profile routes, including changes sent cross-site from the app', async () => {
    const { token } = await appSignUp();
    const list = await fromApp('GET', '/api/profiles', { token });
    assert.equal(list.status, 200);
    const created = await fromApp('POST', '/api/profiles', { token, body: { displayName: 'Mira', relationship: 'child', confirmation: 'guardian' } });
    assert.equal(created.status, 201, await created.clone().text());
    const kid = await created.json() as Profile;
    const patched = await fromApp('PATCH', `/api/profiles/${kid.id}`, { token, body: { heightCm: 118 } });
    assert.equal(patched.status, 200);
    const me = await fromApp('GET', '/api/auth/me', { token });
    assert.equal((await me.json() as SessionInfo).profiles.length, 2);
  });

  it('another site cannot sign in for an app without a preflight (custom header), and gets no cookie if it tries', async () => {
    // Without the app header the request is an ordinary cross-site form post: blocked.
    const plain = await fromApp('POST', '/api/auth/accounts/app-exchange', { body: { code: 'x', verifier: 'v'.repeat(43) }, origin: 'https://evil.example' });
    assert.equal(plain.status, 403);
    assert.deepEqual(plain.headers.getSetCookie(), []);
  });

  it('a wrong or missing token is refused', async () => {
    assert.equal((await fromApp('GET', '/api/profiles', { token: 'in.not-a-real-token-but-long-enough' })).status, 401);
    assert.equal((await fromApp('GET', '/api/profiles')).status, 401);
    assert.equal(await (await fromApp('GET', '/api/auth/me', { token: 'in.not-a-real-token-but-long-enough' })).json(), null);
  });

  it('a cookie request from another site is still blocked, even with a bearer token added', async () => {
    const browser = makeClient(app);
    await browser.signUp(registration(`victim.${run}@example.com`));
    const cookie = browser.cookie;
    const { token } = await appSignUp();
    for (const extra of [{}, { authorization: `Bearer ${token}` }]) {
      const res = await app.request('/api/profiles', {
        method: 'POST', body: JSON.stringify({ displayName: 'Forged', relationship: 'other' }),
        headers: { 'content-type': 'application/json', cookie, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', ...extra },
      });
      assert.equal(res.status, 403);
    }
  });

  it('answers preflight requests from the app origins only', async () => {
    for (const origin of [IOS, ANDROID]) {
      const res = await app.request('/api/profiles', {
        method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type' },
      });
      assert.equal(res.status, 204);
      assert.equal(res.headers.get('access-control-allow-origin'), origin);
      assert.match(res.headers.get('access-control-allow-headers') ?? '', /Authorization/);
      assert.match(res.headers.get('access-control-allow-headers') ?? '', /Content-Type/);
      assert.match(res.headers.get('access-control-allow-headers') ?? '', /Range/, 'map tiles are read in byte ranges');
      assert.equal(res.headers.get('access-control-allow-credentials'), null, 'cookies are never shared with the apps');
    }
    const other = await app.request('/api/profiles', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    assert.equal(other.headers.get('access-control-allow-origin'), null);
    const plain = await app.request('/api/health', { headers: { origin: 'https://evil.example' } });
    assert.equal(plain.headers.get('access-control-allow-origin'), null);
  });

  it('app responses, errors included, carry CORS headers and expose Content-Disposition', async () => {
    const { token, data } = await appSignUp();
    const exported = await fromApp('GET', `/api/profiles/${data.profiles[0].id}/export`, { token });
    assert.equal(exported.status, 200);
    assert.equal(exported.headers.get('access-control-allow-origin'), IOS);
    assert.match(exported.headers.get('access-control-expose-headers') ?? '', /Content-Disposition/);
    assert.match(exported.headers.get('access-control-expose-headers') ?? '', /Content-Range/);
    assert.match(exported.headers.get('access-control-expose-headers') ?? '', /ETag/);
    assert.match(exported.headers.get('content-disposition') ?? '', /attachment/);
    const denied = await fromApp('GET', '/api/profiles');
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get('access-control-allow-origin'), IOS, 'the app can read error messages');
  });

  it('signing out with a bearer token revokes that session only', async () => {
    const { userId, token: first } = await appSignUp();
    const second = await another(userId);
    assert.equal((await fromApp('POST', '/api/auth/logout', { token: first })).status, 204);
    assert.equal((await fromApp('GET', '/api/profiles', { token: first })).status, 401);
    assert.equal((await fromApp('GET', '/api/profiles', { token: second })).status, 200);
  });

  it('signing out other devices with a bearer token keeps only that session', async () => {
    const { userId, token: phone } = await appSignUp();
    const tablet = await another(userId);
    assert.equal((await fromApp('DELETE', '/api/auth/sessions', { token: phone })).status, 204);
    assert.equal((await fromApp('GET', '/api/profiles', { token: tablet })).status, 401);
    assert.equal((await fromApp('GET', '/api/profiles', { token: phone })).status, 200);
  });

  it('tells apps which API origin serves each region', async () => {
    const info = await (await fromApp('GET', '/api/auth/config')).json() as ServiceInfo;
    assert.deepEqual(info.apiOrigins, { in: 'https://in.health.lotuspond.ai' });
  });
});
