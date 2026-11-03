// API integration tests: in-memory PGlite database, temporary file store, requests through app.request().
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
import { EncryptedFileStore } from '../src/lib/files-encrypted.ts';
import type { AppEnv } from '../src/http.ts';
import type { Measurement, ProfileRecords, ScanItem, SessionInfo, StoredDocument, Profile } from '../../shared/types.ts';

const migrations = fileURLToPath(new URL('../drizzle', import.meta.url));
let database: Database;
let app: Hono<AppEnv>;
let filesDir: string;

// TEST_DATABASE_URL runs the suite against a real PostgreSQL server; otherwise an in-memory PGlite database is used.
const run = Date.now().toString(36);

before(async () => {
  database = await openDatabase({ url: process.env.TEST_DATABASE_URL });
  await database.migrate(migrations);
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspond-files-'));
  const config = loadConfig({ NODE_ENV: 'test', TRUST_PROXY: 'true' });
  // Files go through the same encryption layer as production; tests read them back through the API.
  const files = new EncryptedFileStore(new DiskFileStore(filesDir), { current: crypto.getRandomValues(Buffer.alloc(32)), previous: [] });
  app = createApp({ db: database.db, files, config });
});

after(async () => {
  await database.close();
  fs.rmSync(filesDir, { recursive: true, force: true });
});

/** A browser-like client: keeps the session cookie and sends same-origin fetch metadata. */
let clients = 0;
function client(ip = `10.0.${++clients % 250}.${Math.floor(clients / 250) + 1}`) {
  let cookie = '';
  async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { 'sec-fetch-site': 'same-origin', 'x-forwarded-for': ip, ...headers };
    if (cookie) h.cookie = cookie;
    let payload: FormData | string | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
    const res = await app.request(url, { method, headers: h, body: payload });
    const set = res.headers.get('set-cookie');
    if (set) {
      const [pair] = set.split(';');
      cookie = pair.endsWith('=') ? '' : pair;
    }
    return res;
  }
  return {
    call,
    get cookie() { return cookie; },
    json: async <T>(method: string, url: string, body?: unknown, expect = 200): Promise<T> => {
      const res = await call(method, url, body);
      const text = await res.text();
      assert.equal(res.status, expect, `${method} ${url} → ${res.status} ${text}`);
      return (text ? JSON.parse(text) : null) as T;
    },
  };
}

const measurement = (over: Partial<Measurement> = {}): Omit<Measurement, 'id'> => ({
  markerId: 'ldl', rawName: 'LDL Cholesterol', value: 138, valueText: '138', unit: 'mg/dL',
  range: { high: 100, text: '< 100', source: 'report' }, status: 'high', date: '2026-03-14',
  sourceFile: 'report.pdf', confidence: 'high', ...over,
});

/** A complete sign-up body: an adult in India who agreed to everything required. */
const registration = (email: string, over: Record<string, unknown> = {}) => ({
  email, password: 'correct horse battery', displayName: 'Asha', country: 'IN', ageConfirmed: true,
  consents: { termsAndPrivacy: true, healthData: true, crossBorder: false, marketing: false }, ...over,
});

let counter = 0;
async function signUp(c = client()) {
  const email = `person${++counter}.${run}@example.com`;
  const info = await c.json<SessionInfo>('POST', '/api/auth/register', registration(email), 201);
  return { c, email, info, self: info.profiles[0] };
}

describe('accounts', () => {
  it('registers, creates the own profile, and keeps the session', async () => {
    const { c, email, info } = await signUp();
    assert.equal(info.account.email, email);
    assert.equal(info.profiles.length, 1);
    assert.equal(info.profiles[0].relationship, 'self');
    assert.equal(info.profiles[0].displayName, 'Asha');
    assert.match(c.cookie, /^lp_session=/);
    const me = await c.json<SessionInfo>('GET', '/api/auth/me');
    assert.equal(me.account.id, info.account.id);
  });

  it('sets an HttpOnly, SameSite cookie', async () => {
    const res = await client().call('POST', '/api/auth/register', registration(`cookie.${run}@example.com`, { password: 'long enough password', displayName: 'C' }));
    const set = res.headers.get('set-cookie') ?? '';
    assert.match(set, /HttpOnly/i);
    assert.match(set, /SameSite=Lax/i);
  });

  it('rejects a duplicate email, case-insensitively', async () => {
    const { email } = await signUp();
    const res = await client().call('POST', '/api/auth/register', registration(email.toUpperCase(), { password: 'another password', displayName: 'B' }));
    assert.equal(res.status, 409);
  });

  it('validates sign-up input', async () => {
    const short = await client().call('POST', '/api/auth/register', registration('x@example.com', { password: 'short', displayName: 'X' }));
    assert.equal(short.status, 400);
    assert.match((await short.json() as { error: { message: string } }).error.message, /at least 10/);
    const bad = await client().call('POST', '/api/auth/register', registration('not-an-email', { password: 'long enough password', displayName: 'X' }));
    assert.equal(bad.status, 400);
  });

  it('signs in and out', async () => {
    const { email } = await signUp();
    const c = client();
    const wrong = await c.call('POST', '/api/auth/login', { email, password: 'wrong password!' });
    assert.equal(wrong.status, 401);
    await c.json('POST', '/api/auth/login', { email: email.toUpperCase(), password: 'correct horse battery' });
    await c.json('GET', '/api/auth/me');
    await c.json('POST', '/api/auth/logout', undefined, 204);
    assert.equal(await c.json('GET', '/api/auth/me'), null, 'signed out: no session');
  });

  it('requires a session for profile data', async () => {
    assert.equal((await client().call('GET', '/api/profiles')).status, 401);
    assert.equal(await client().json('GET', '/api/auth/me'), null);
    const forged = await app.request('/api/auth/me', { headers: { cookie: 'lp_session=not-a-real-token-but-long-enough' } });
    assert.equal(await forged.json(), null);
  });

  it('changing the password signs out other sessions', async () => {
    const { c, email } = await signUp();
    const other = client();
    await other.json('POST', '/api/auth/login', { email, password: 'correct horse battery' });
    const wrong = await c.call('POST', '/api/auth/password', { currentPassword: 'nope nope nope', newPassword: 'a brand new password' });
    assert.equal(wrong.status, 400);
    await c.json('POST', '/api/auth/password', { currentPassword: 'correct horse battery', newPassword: 'a brand new password' }, 204);
    assert.equal(await other.json('GET', '/api/auth/me'), null, 'other session revoked');
    assert.equal((await other.call('GET', '/api/profiles')).status, 401, 'revoked session cannot read data');
    await c.json('GET', '/api/auth/me');
    await client().json('POST', '/api/auth/login', { email, password: 'a brand new password' });
  });

  it('blocks changes sent from another site', async () => {
    const { c } = await signUp();
    const res = await c.call('POST', '/api/profiles', { displayName: 'Kid', relationship: 'child' }, { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' });
    assert.equal(res.status, 403);
    const legacy = await app.request('/api/profiles', {
      method: 'POST', body: JSON.stringify({ displayName: 'Kid' }),
      headers: { cookie: c.cookie, origin: 'https://evil.example', host: 'localhost', 'content-type': 'application/json' },
    });
    assert.equal(legacy.status, 403);
  });

  it('rate-limits repeated failed sign-ins', async () => {
    const { email } = await signUp();
    const c = client('10.9.9.9');
    let last = 0;
    for (let i = 0; i < 10; i++) last = (await c.call('POST', '/api/auth/login', { email, password: `wrong-${i}-password` })).status;
    assert.equal(last, 429);
  });
});

describe('profiles', () => {
  it('creates, updates and lists family profiles', async () => {
    const { c } = await signUp();
    const kid = await c.json<Profile>('POST', '/api/profiles', { displayName: 'Mira', relationship: 'child', dateOfBirth: '2019-05-02', sex: 'female' }, 201);
    assert.equal(kid.relationship, 'child');
    const updated = await c.json<Profile>('PATCH', `/api/profiles/${kid.id}`, { heightCm: 118, allergies: ['Peanuts', 'Peanuts', 'Penicillin'] });
    assert.equal(updated.heightCm, 118);
    assert.deepEqual(updated.allergies, ['Peanuts', 'Penicillin']);
    const list = await c.json<Profile[]>('GET', '/api/profiles');
    assert.deepEqual(list.map(p => p.relationship), ['self', 'child']);
  });

  it('validates profile fields', async () => {
    const { c, self } = await signUp();
    assert.equal((await c.call('PATCH', `/api/profiles/${self.id}`, { dateOfBirth: '2999-01-01' })).status, 400);
    assert.equal((await c.call('PATCH', `/api/profiles/${self.id}`, { heightCm: 900 })).status, 400);
    assert.equal((await c.call('PATCH', `/api/profiles/${self.id}`, { relationship: 'child' })).status, 400);
    assert.equal((await c.call('POST', '/api/profiles', { displayName: 'Me again', relationship: 'self' })).status, 400);
  });

  it('keeps the own profile and removes family profiles', async () => {
    const { c, self } = await signUp();
    assert.equal((await c.call('DELETE', `/api/profiles/${self.id}`)).status, 409);
    const kid = await c.json<Profile>('POST', '/api/profiles', { displayName: 'Mira', relationship: 'child' }, 201);
    await c.json('DELETE', `/api/profiles/${kid.id}`, undefined, 204);
    assert.equal((await c.call('GET', `/api/profiles/${kid.id}`)).status, 404);
  });

  it('never shows one account another account’s profile', async () => {
    const a = await signUp();
    const b = await signUp();
    for (const [m, url] of [['GET', ''], ['GET', '/records'], ['PATCH', ''], ['DELETE', '/records'], ['GET', '/export']] as const) {
      const res = await b.c.call(m, `/api/profiles/${a.self.id}${url}`, m === 'PATCH' ? { displayName: 'x' } : undefined);
      assert.equal(res.status, 404, `${m} ${url}`);
    }
    assert.equal((await b.c.call('GET', '/api/profiles/not-a-uuid/records')).status, 404);
  });
});

describe('records', () => {
  it('stores, edits and deletes measurements', async () => {
    const { c, self } = await signUp();
    const base = `/api/profiles/${self.id}`;
    const created = await c.json<Measurement[]>('POST', `${base}/measurements`, { measurements: [measurement(), measurement({ markerId: 'hdl', rawName: 'HDL', value: 38, valueText: '38', status: 'low', range: { low: 40, source: 'report' } })] }, 201);
    assert.equal(created.length, 2);
    assert.ok(created.every(m => /^[0-9a-f-]{36}$/.test(m.id)));
    const edited = await c.json<Measurement>('PATCH', `${base}/measurements/${created[0].id}`, { value: 99, valueText: '99', status: 'normal' });
    assert.equal(edited.value, 99);
    await c.json('DELETE', `${base}/measurements/${created[1].id}`, undefined, 204);
    const records = await c.json<ProfileRecords>('GET', `${base}/records`);
    assert.equal(records.measurements.length, 1);
    assert.deepEqual(records.measurements[0].range, { high: 100, text: '< 100', source: 'report' });
  });

  it('rejects malformed measurements', async () => {
    const { c, self } = await signUp();
    const res = await c.call('POST', `/api/profiles/${self.id}/measurements`, { measurements: [{ ...measurement(), status: 'bad' }] });
    assert.equal(res.status, 400);
    const empty = await c.call('POST', `/api/profiles/${self.id}/measurements`, { measurements: [] });
    assert.equal(empty.status, 400);
  });

  it('stores original files and serves them only to their owner', async () => {
    const { c, self } = await signUp();
    const base = `/api/profiles/${self.id}`;
    const form = new FormData();
    form.append('file', new File([new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3])], 'chest x-ray.jpg', { type: 'image/jpeg' }));
    form.append('kind', 'scan');
    const res = await c.call('POST', `${base}/documents`, form);
    assert.equal(res.status, 201, await res.clone().text());
    const doc = await res.json() as StoredDocument;
    assert.equal(doc.fileName, 'chest x-ray.jpg');
    assert.equal(doc.sizeBytes, 6);
    assert.equal(doc.kind, 'scan');

    const file = await c.call('GET', `${base}/documents/${doc.id}/file`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'image/jpeg');
    assert.match(file.headers.get('content-security-policy') ?? '', /sandbox/);
    assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [0xff, 0xd8, 0xff, 1, 2, 3]);
    const onDisk = fs.readFileSync(path.join(filesDir, self.id, doc.id));
    assert.equal(onDisk.subarray(0, 4).toString('latin1'), 'LPEF', 'stored encrypted');
    assert.equal(onDisk.includes(Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3])), false, 'no plaintext on disk');
    const dl = await c.call('GET', `${base}/documents/${doc.id}/file?download=1`);
    assert.match(dl.headers.get('content-disposition') ?? '', /^attachment/);
    await dl.arrayBuffer();

    const stranger = await signUp();
    assert.equal((await stranger.c.call('GET', `${base}/documents/${doc.id}/file`)).status, 404);
    assert.equal((await stranger.c.call('GET', `/api/profiles/${stranger.self.id}/documents/${doc.id}/file`)).status, 404);
    assert.equal((await stranger.c.call('POST', `/api/profiles/${stranger.self.id}/scans`, { scans: [scanFor(doc.id)] })).status, 400, 'cannot link another profile’s file');

    const [scan] = await c.json<ScanItem[]>('POST', `${base}/scans`, { scans: [scanFor(doc.id)] }, 201);
    assert.equal(scan.blobKey, doc.id);
    const moved = await c.json<ScanItem>('PATCH', `${base}/scans/${scan.id}`, { organ: 'lungs', note: 'Annual check' });
    assert.equal(moved.organ, 'lungs');
    await c.json('DELETE', `${base}/scans/${scan.id}`, undefined, 204);
    const records = await c.json<ProfileRecords>('GET', `${base}/records`);
    assert.equal(records.scans.length, 0);
    assert.equal(records.documents.length, 0, 'deleting a scan deletes its file');
    assert.equal(fs.existsSync(path.join(filesDir, self.id, doc.id)), false);
  });

  it('never serves uploaded HTML inline', async () => {
    const { c, self } = await signUp();
    const form = new FormData();
    form.append('file', new File(['<script>alert(1)</script>'], 'x.html', { type: 'text/html' }));
    const doc = await (await c.call('POST', `/api/profiles/${self.id}/documents`, form)).json() as StoredDocument;
    const res = await c.call('GET', `/api/profiles/${self.id}/documents/${doc.id}/file`);
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    assert.match(res.headers.get('content-disposition') ?? '', /^attachment/);
    await res.arrayBuffer();
  });

  it('links results to their report and clears everything on request', async () => {
    const { c, self } = await signUp();
    const base = `/api/profiles/${self.id}`;
    const form = new FormData();
    form.append('file', new File(['%PDF-1.4 fake'], 'labs.pdf', { type: 'application/pdf' }));
    form.append('kind', 'report');
    const doc = await (await c.call('POST', `${base}/documents`, form)).json() as StoredDocument;
    const [m] = await c.json<Measurement[]>('POST', `${base}/measurements`, { measurements: [measurement({ documentId: doc.id })] }, 201);
    assert.equal(m.documentId, doc.id);
    await c.json('DELETE', `${base}/documents/${doc.id}`, undefined, 204);
    const after1 = await c.json<ProfileRecords>('GET', `${base}/records`);
    assert.equal(after1.measurements[0].documentId, null, 'results stay when their report file is deleted');
    const exported = await c.call('GET', `${base}/export`);
    assert.match(exported.headers.get('content-disposition') ?? '', /attachment; filename="lotuspond-asha-/);
    const body = await exported.json() as { version: number; measurements: unknown[]; profile: Profile; account?: { country: string; consents: { kind: string }[]; activity: { kind: string }[] } };
    assert.equal(body.version, 1);
    assert.equal(body.measurements.length, 1);
    assert.equal(body.account?.country, 'IN', 'own profile export carries the account');
    assert.ok(body.account?.consents.some(x => x.kind === 'health_data'), 'export lists consents');
    assert.ok(body.account?.activity.some(x => x.kind === 'account_created'), 'export lists activity');
    await c.json('DELETE', `${base}/records`, undefined, 204);
    const after2 = await c.json<ProfileRecords>('GET', `${base}/records`);
    assert.equal(after2.measurements.length + after2.scans.length + after2.documents.length, 0);
  });

  it('deleting the account removes every profile and file', async () => {
    const { c, self, email } = await signUp();
    const form = new FormData();
    form.append('file', new File(['abc'], 'a.png', { type: 'image/png' }));
    const doc = await (await c.call('POST', `/api/profiles/${self.id}/documents`, form)).json() as StoredDocument;
    assert.ok(fs.existsSync(path.join(filesDir, self.id, doc.id)));
    assert.equal((await c.call('DELETE', '/api/auth/account', { password: 'wrong password!!' })).status, 400);
    await c.json('DELETE', '/api/auth/account', { password: 'correct horse battery' }, 204);
    assert.equal(fs.existsSync(path.join(filesDir, self.id)), false);
    assert.equal((await client().call('POST', '/api/auth/login', { email, password: 'correct horse battery' })).status, 401);
  });
});

function scanFor(documentId: string) {
  return {
    fileName: 'chest x-ray.jpg', kind: 'image', organ: null, modality: 'XR', date: '2026-03-14',
    thumbDataUrl: 'data:image/png;base64,iVBORw0KGgo=', blobKey: documentId, width: 10, height: 10,
  };
}
