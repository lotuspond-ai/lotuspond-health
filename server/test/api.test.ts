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
import type { Measurement, ProfileRecords, RegisterInput, ScanItem, SessionInfo, StoredDocument, Profile } from '../../shared/types.ts';
import { makeClient, registration } from './helpers.ts';

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
  const config = loadConfig({ NODE_ENV: 'test', TRUST_PROXY: 'true', ACCOUNTS_ISSUER: 'fake' });
  // Files go through the same encryption layer as production; tests read them back through the API.
  const files = new EncryptedFileStore(new DiskFileStore(filesDir), { current: crypto.getRandomValues(Buffer.alloc(32)), previous: [] });
  app = createApp({ db: database.db, files, config });
});

after(async () => {
  await database.close();
  fs.rmSync(filesDir, { recursive: true, force: true });
});

/** A browser-like client (test/helpers.ts): cookies, same-origin fetch metadata, sign-up through the stand-in Accounts. */
let clients = 0;
const client = (ip = `10.0.${++clients % 250}.${Math.floor(clients / 250) + 1}`) => makeClient(app, { ip });

const measurement = (over: Partial<Measurement> = {}): Omit<Measurement, 'id'> => ({
  markerId: 'ldl', rawName: 'LDL Cholesterol', value: 138, valueText: '138', unit: 'mg/dL',
  range: { high: 100, text: '< 100', source: 'report' }, status: 'high', date: '2026-03-14',
  sourceFile: 'report.pdf', confidence: 'high', ...over,
});

/** A complete sign-up: an adult in India who agreed to everything required. */
const asha = (email: string, over: Partial<RegisterInput> = {}) => registration(email, 'IN', { displayName: 'Asha', ...over });

let counter = 0;
async function signUp(c = client()) {
  const email = `person${++counter}.${run}@example.com`;
  const info = await c.signUp(asha(email));
  return { c, email, info, self: info.profiles[0] };
}

describe('accounts', () => {
  it('signs up through LotusPond Accounts, creates the own profile, and keeps the session', async () => {
    const { c, email, info } = await signUp();
    assert.equal(info.account.email, email);
    assert.equal(info.profiles.length, 1);
    assert.equal(info.profiles[0].relationship, 'self');
    assert.equal(info.profiles[0].displayName, 'Asha');
    assert.match(c.cookie, /(^|; )lp_session=/);
    const me = await c.json<SessionInfo>('GET', '/api/auth/me');
    assert.equal(me.account.id, info.account.id);
  });

  it('sets an HttpOnly, SameSite cookie', async () => {
    const res = await client().signUpCall(asha(`cookie.${run}@example.com`, { displayName: 'C' }));
    const set = res.headers.getSetCookie().find(c => c.startsWith('lp_session=')) ?? '';
    assert.match(set, /HttpOnly/i);
    assert.match(set, /SameSite=Lax/i);
  });

  it('validates Health\'s sign-up questions', async () => {
    const res = await client().signUpCall(asha(`unnamed.${run}@example.com`, { displayName: ' ' }));
    assert.equal(res.status, 400);
    assert.match((await res.json() as { error: { message: string } }).error.message, /Enter your name/);
  });

  it('signs in and out', async () => {
    const { email } = await signUp();
    const c = client();
    assert.equal((await c.signIn(email)).pathname, '/app');
    await c.json('GET', '/api/auth/me');
    await c.json('POST', '/api/auth/logout');
    assert.equal(await c.json('GET', '/api/auth/me'), null, 'signed out: no session');
  });

  it('requires a session for profile data', async () => {
    assert.equal((await client().call('GET', '/api/profiles')).status, 401);
    assert.equal(await client().json('GET', '/api/auth/me'), null);
    const forged = await app.request('/api/auth/me', { headers: { cookie: 'lp_session=not-a-real-token-but-long-enough' } });
    assert.equal(await forged.json(), null);
  });

  it('signing out other devices ends their sessions', async () => {
    const { c, email } = await signUp();
    const other = client();
    await other.signIn(email);
    await c.json('DELETE', '/api/auth/sessions', undefined, 204);
    assert.equal(await other.json('GET', '/api/auth/me'), null, 'other session revoked');
    assert.equal((await other.call('GET', '/api/profiles')).status, 401, 'revoked session cannot read data');
    await c.json('GET', '/api/auth/me');
  });

  it('blocks changes sent from another site', async () => {
    const { c } = await signUp();
    const res = await c.call('POST', '/api/profiles', { displayName: 'Kid', relationship: 'child', confirmation: 'guardian' }, { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' });
    assert.equal(res.status, 403);
    const legacy = await app.request('/api/profiles', {
      method: 'POST', body: JSON.stringify({ displayName: 'Kid' }),
      headers: { cookie: c.cookie, origin: 'https://evil.example', host: 'localhost', 'content-type': 'application/json' },
    });
    assert.equal(legacy.status, 403);
  });
});

describe('profiles', () => {
  it('creates, updates and lists family profiles', async () => {
    const { c } = await signUp();
    const kid = await c.json<Profile>('POST', '/api/profiles', { displayName: 'Mira', relationship: 'child', confirmation: 'guardian', dateOfBirth: '2019-05-02', sex: 'female' }, 201);
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
    assert.equal((await c.call('PATCH', `/api/profiles/${self.id}`, { relationship: 'child', confirmation: 'guardian' })).status, 400);
    assert.equal((await c.call('POST', '/api/profiles', { displayName: 'Me again', relationship: 'self' })).status, 400);
  });

  it('keeps the own profile and removes family profiles', async () => {
    const { c, self } = await signUp();
    assert.equal((await c.call('DELETE', `/api/profiles/${self.id}`)).status, 409);
    const kid = await c.json<Profile>('POST', '/api/profiles', { displayName: 'Mira', relationship: 'child', confirmation: 'guardian' }, 201);
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
    await c.json('DELETE', '/api/auth/account', {}, 204);
    assert.equal(fs.existsSync(path.join(filesDir, self.id)), false);
    assert.equal((await client().signIn(email)).pathname, '/signup', 'Health holds no account for that email now');
  });
});

function scanFor(documentId: string) {
  return {
    fileName: 'chest x-ray.jpg', kind: 'image', organ: null, modality: 'XR', date: '2026-03-14',
    thumbDataUrl: 'data:image/png;base64,iVBORw0KGgo=', blobKey: documentId, width: 10, height: 10,
  };
}
