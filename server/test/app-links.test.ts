// Universal links and app links for the apps' sign-in return: the two association files, the fallback page on the
// link host, and the sign-in callback choosing the https link once APP_LINKS_ORIGIN is set.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDatabase, type Database } from '../src/db/client.ts';
import { DiskFileStore } from '../src/lib/files.ts';
import { pkceChallenge } from '../src/auth/oidc.ts';

const PRINT = Array.from({ length: 32 }, (_, i) => (i * 7 % 256).toString(16).padStart(2, '0').toUpperCase()).join(':');
let database: Database;
let filesDir: string;
let linked: ReturnType<typeof createApp>;
let plain: ReturnType<typeof createApp>;

before(async () => {
  database = await openDatabase({ url: process.env.TEST_DATABASE_URL });
  await database.migrate(fileURLToPath(new URL('../drizzle', import.meta.url)));
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspond-app-links-'));
  const files = new DiskFileStore(filesDir);
  const base = { NODE_ENV: 'test', RECORD_AGENT: 'off', ACCOUNTS_ISSUER: 'fake' } as const;
  linked = createApp({ db: database.db, files, config: loadConfig({ ...base, APP_LINKS_ORIGIN: 'https://open.health.lotuspond.ai', APPLE_TEAM_ID: 'A1B2C3D4E5', ANDROID_APP_SHA256: PRINT.toLowerCase() }) });
  plain = createApp({ db: database.db, files, config: loadConfig(base) });
});
after(async () => { await database.close(); fs.rmSync(filesDir, { recursive: true, force: true }); });

/** The system browser through the stand-in Accounts page; returns the page Health shows to send it back to the app. */
async function returnPage(app: ReturnType<typeof createApp>) {
  const jar: string[] = [];
  const go = async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('sec-fetch-site', 'same-origin');
    if (jar.length) headers.set('cookie', jar.join('; '));
    const res = await app.request(new URL(url, 'http://health.test').toString(), { ...init, headers });
    for (const line of res.headers.getSetCookie()) { const pair = line.split(';')[0]; if (!pair.endsWith('=')) jar.push(pair); }
    return res;
  };
  const start = await go(`/api/auth/accounts/start?client=app&code_challenge=${pkceChallenge(randomBytes(32).toString('base64url'))}`);
  const authorize = new URL(start.headers.get('location')!, 'http://health.test');
  const form = new URLSearchParams({ email: `links.${Date.now()}@example.com`, email_verified: 'true', region: 'in' });
  for (const k of ['client_id', 'redirect_uri', 'state', 'nonce', 'code_challenge']) form.set(k, authorize.searchParams.get(k)!);
  const issued = await go(authorize.pathname, { method: 'POST', body: form.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  return (await go(issued.headers.get('location')!)).text();
}

describe('app links', () => {
  test('apple-app-site-association names the app and claims only the sign-in return', async () => {
    const res = await linked.request('/.well-known/apple-app-site-association');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^application\/json/);
    assert.deepEqual(await res.json(), { applinks: { details: [{ appIDs: ['A1B2C3D4E5.ai.lotuspond.health'], components: [{ '/': '/accounts-return', comment: 'Sign-in with LotusPond Accounts returning to the app' }] }] } });
  });

  test('assetlinks.json names the package and its signing certificate', async () => {
    const res = await linked.request('/.well-known/assetlinks.json');
    assert.equal(res.status, 200);
    const [entry] = await res.json() as { relation: string[]; target: { package_name: string; sha256_cert_fingerprints: string[] } }[];
    assert.deepEqual(entry.relation, ['delegate_permission/common.handle_all_urls']);
    assert.equal(entry.target.package_name, 'ai.lotuspond.health');
    assert.deepEqual(entry.target.sha256_cert_fingerprints, [PRINT]);
  });

  test('without the settings neither file is served', async () => {
    assert.equal((await plain.request('/.well-known/apple-app-site-association')).status, 404);
    assert.equal((await plain.request('/.well-known/assetlinks.json')).status, 404);
  });

  test('the sign-in comes back as an https app link when it is set up, else through the app\'s scheme', async () => {
    assert.match(await returnPage(linked), /url=https:\/\/open\.health\.lotuspond\.ai\/accounts-return\?code=[\w-]+"/);
    assert.match(await returnPage(plain), /url=ai\.lotuspond\.health:\/accounts\?code=[\w-]+"/);
  });

  test('opened in the browser, the link offers the app\'s own scheme with the same code, and nothing else', async () => {
    const code = randomBytes(40).toString('base64url');
    const page = await (await linked.request(`/accounts-return?code=${code}`)).text();
    assert.ok(page.includes(`href="ai.lotuspond.health:/accounts?code=${code}"`));
    const odd = await (await linked.request('/accounts-return?code=%22%3E%3Cscript%3E')).text();
    assert.ok(odd.includes('href="ai.lotuspond.health:/accounts?error=expired"') && !odd.includes('<script>'));
  });

  test('opened in the browser, a sign-out return goes on to the app too', async () => {
    const page = await (await linked.request('/accounts-return?signed_out=1')).text();
    assert.ok(page.includes('href="ai.lotuspond.health:/accounts?signed_out=1"'));
  });

  test('a fingerprint that is not SHA-256 is refused at start-up', () => {
    assert.throws(() => loadConfig({ NODE_ENV: 'test', ANDROID_APP_SHA256: 'AB:CD' }), /ANDROID_APP_SHA256/);
    assert.throws(() => loadConfig({ NODE_ENV: 'test', APP_LINKS_ORIGIN: 'http://open.example.com' }), /https/);
  });
});
