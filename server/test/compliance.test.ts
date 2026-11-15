// Data residency, sign-up rules, consents, preferences and the audit log, on a deployment with three cells:
//   default database: the directory, plus the "global" cell
//   India cell: its own database and file store
//   EU cell:    its own database and file store
// The United States is deliberately not served. Each database is in-memory PGlite unless TEST_DATABASE_URL
// (default database), TEST_CELL_IN_DATABASE_URL or TEST_CELL_EU_DATABASE_URL name real PostgreSQL databases.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { eq, inArray } from 'drizzle-orm';
import type { Hono } from 'hono';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDatabase, type Database, type Db } from '../src/db/client.ts';
import { auditEvents, consents, directory, documents, measurements, profiles, sessions, users } from '../src/db/schema.ts';
import { CellRegistry, fileStore, type Cell } from '../src/cells.ts';
import { ephemeralSecrets } from '../src/compliance/secrets.ts';
import { emailHash } from '../src/compliance/directory.ts';
import type { AppEnv } from '../src/http.ts';
import { CONSENT_VERSION } from '../../shared/regions.ts';
import type { ActivityEvent, ConsentRecord, ServiceInfo, SessionInfo } from '../../shared/types.ts';
import { makeClient, measurement, registration, upload, type TestClient } from './helpers.ts';

const migrations = fileURLToPath(new URL('../drizzle', import.meta.url));
const run = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const secrets = ephemeralSecrets();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspond-cells-'));

let app: Hono<AppEnv>;
const dbs: Database[] = [];
let main: Db;
let inCell: Cell;
let euCell: Cell;
let globalCell: Cell;
const filesRoot = { default: path.join(tmp, 'default'), in: path.join(tmp, 'in'), eu: path.join(tmp, 'eu') };

async function open(url: string | undefined) {
  const d = await openDatabase({ url });
  dbs.push(d);
  await d.migrate(migrations);
  return d.db;
}

before(async () => {
  main = await open(process.env.TEST_DATABASE_URL);
  const key = () => ({ current: randomBytes(32), previous: [] });
  globalCell = { id: 'default', db: main, files: fileStore(filesRoot.default, key()) };
  inCell = { id: 'in', db: await open(process.env.TEST_CELL_IN_DATABASE_URL), files: fileStore(filesRoot.in, key()) };
  euCell = { id: 'eu', db: await open(process.env.TEST_CELL_EU_DATABASE_URL), files: fileStore(filesRoot.eu, key()) };
  const cells = new CellRegistry(globalCell, [['in', inCell], ['eu', euCell], ['global', globalCell]]);
  const config = loadConfig({
    NODE_ENV: 'test', TRUST_PROXY: 'true', SERVED_REGIONS: 'in,eu,global',
    GRIEVANCE_CONTACT: 'Grievance Officer, grievance@lotuspond.example', DPO_CONTACT: 'dpo@lotuspond.example',
  });
  app = createApp({ db: main, files: globalCell.files, config, cells, secrets });
});

after(async () => {
  await Promise.all(dbs.map(d => d.close()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

let n = 0;
const email = (tag: string) => `${tag}.${++n}.${run}@example.com`;
const client = (opts?: Parameters<typeof makeClient>[1]) => makeClient(app, opts);

async function signUp(country: string, c: TestClient = client(), over = {}) {
  const address = email(country.toLowerCase());
  const info = await c.json<SessionInfo>('POST', '/api/auth/register', registration(address, country, over), 201);
  return { c, email: address, info, user: info.account, self: info.profiles[0] };
}

async function usersWithEmail(db: Db, address: string) {
  return db.select().from(users).where(eq(users.email, address));
}

function dirHas(root: string, name: string) {
  return fs.existsSync(path.join(root, name));
}

describe('data residency cells', () => {
  it('keeps an India account and its records in the India cell only', async () => {
    const { c, email: address, user, self } = await signUp('IN');
    assert.equal(user.country, 'IN');
    assert.equal(user.region, 'in');
    assert.match(c.cookie, /^lp_session=in\./, 'the session token names its cell');
    await c.json('POST', `/api/profiles/${self.id}/measurements`, { measurements: [measurement({ rawName: `LDL ${run}` })] }, 201);
    const doc = await upload(c, self.id, 'labs.pdf', new TextEncoder().encode('%PDF-1.4 india'));

    assert.equal((await usersWithEmail(inCell.db, address)).length, 1);
    assert.equal((await inCell.db.select().from(measurements).where(eq(measurements.profileId, self.id))).length, 1);
    assert.equal((await inCell.db.select().from(documents).where(eq(documents.id, doc.id))).length, 1);
    assert.ok(dirHas(filesRoot.in, self.id), 'file stored in the India cell');
    for (const other of [euCell, globalCell]) {
      assert.equal((await usersWithEmail(other.db, address)).length, 0, `no account in the ${other.id} cell`);
      assert.equal((await other.db.select().from(profiles).where(eq(profiles.userId, user.id))).length, 0);
      assert.equal((await other.db.select().from(measurements).where(eq(measurements.profileId, self.id))).length, 0);
    }
    assert.ok(!dirHas(filesRoot.eu, self.id) && !dirHas(filesRoot.default, self.id), 'no file outside the India cell');

    const [entry] = await main.select().from(directory).where(eq(directory.userId, user.id));
    assert.equal(entry.region, 'in');
    assert.equal(entry.emailHash, emailHash(secrets.directoryKey, address));
    assert.match(entry.emailHash, /^[0-9a-f]{64}$/, 'the directory keeps a keyed hash, not the email');
    assert.equal((await inCell.db.select().from(directory).where(eq(directory.userId, user.id))).length, 0, 'cells keep no directory');
  });

  it('never puts an EU account’s data in the India database', async () => {
    const fr = await signUp('FR');
    const gb = await signUp('GB'); // UK records are kept in the EU cell
    for (const p of [fr, gb]) {
      assert.equal(p.user.region, 'eu');
      await p.c.json('POST', `/api/profiles/${p.self.id}/measurements`, { measurements: [measurement({ rawName: `EU ${run}` })] }, 201);
      await upload(p.c, p.self.id, 'eu.pdf', new TextEncoder().encode('%PDF eu'));
      assert.equal((await usersWithEmail(euCell.db, p.email)).length, 1);
    }
    const ids = [fr.user.id, gb.user.id];
    const profileIds = [fr.self.id, gb.self.id];
    for (const other of [inCell, globalCell]) {
      assert.equal((await other.db.select().from(users).where(inArray(users.id, ids))).length, 0);
      assert.equal((await other.db.select().from(profiles).where(inArray(profiles.id, profileIds))).length, 0);
      assert.equal((await other.db.select().from(measurements).where(inArray(measurements.profileId, profileIds))).length, 0);
      assert.equal((await other.db.select().from(sessions).where(inArray(sessions.userId, ids))).length, 0);
      assert.equal((await other.db.select().from(consents).where(inArray(consents.userId, ids))).length, 0);
      assert.equal((await other.db.select().from(auditEvents).where(inArray(auditEvents.userId, ids))).length, 0);
    }
    assert.ok(profileIds.every(id => !dirHas(filesRoot.in, id) && dirHas(filesRoot.eu, id)));
  });

  it('places other countries in the international cell', async () => {
    const au = await signUp('AU');
    assert.equal(au.user.region, 'global');
    assert.equal((await usersWithEmail(globalCell.db, au.email)).length, 1);
    assert.equal((await usersWithEmail(inCell.db, au.email)).length, 0);
  });

  it('signs in through the directory and routes later requests by the token', async () => {
    const india = await signUp('IN');
    const europe = await signUp('DE');
    for (const p of [india, europe]) {
      const c = client();
      const info = await c.json<SessionInfo>('POST', '/api/auth/login', { email: p.email.toUpperCase(), password: 'correct horse battery' });
      assert.equal(info.account.id, p.user.id);
      assert.ok(c.cookie.startsWith(`lp_session=${p.user.region}.`));
      const records = await c.json<{ measurements: unknown[] }>('GET', `/api/profiles/${p.self.id}/records`);
      assert.deepEqual(records.measurements, []);
    }
    // A token is only valid in its own cell: the same secret with another region, or none, finds nothing.
    const token = india.c.cookie.replace(/^lp_session=in\./, '');
    for (const forged of [`eu.${token}`, `global.${token}`, token, `xx.${token}`]) {
      const res = await app.request('/api/auth/me', { headers: { cookie: `lp_session=${forged}` } });
      assert.equal(await res.json(), null, forged.slice(0, 8));
    }
  });

  it('finds accounts the directory does not know yet, and adds them', async () => {
    const p = await signUp('IN');
    await main.delete(directory).where(eq(directory.userId, p.user.id));
    await client().json('POST', '/api/auth/login', { email: p.email, password: 'correct horse battery' });
    const [entry] = await main.select().from(directory).where(eq(directory.userId, p.user.id));
    assert.equal(entry?.region, 'in');
    const again = await client().error('POST', '/api/auth/register', registration(p.email, 'IN'));
    assert.equal(again.code, 'email_taken');
  });

  it('keeps one email to one account across cells', async () => {
    const p = await signUp('IN');
    const res = await client().error('POST', '/api/auth/register', registration(p.email, 'FR'));
    assert.equal(res.status, 409);
    assert.equal((await usersWithEmail(euCell.db, p.email)).length, 0);
  });

  it('refuses sign-up for a region this server does not serve', async () => {
    const address = email('us');
    const res = await client().error('POST', '/api/auth/register', registration(address, 'US'));
    assert.equal(res.status, 403);
    assert.equal(res.code, 'region_not_served');
    assert.match(res.message, /servers in the United States/);
    for (const cell of [inCell, euCell, globalCell]) assert.equal((await usersWithEmail(cell.db, address)).length, 0);
    assert.equal((await main.select().from(directory).where(eq(directory.emailHash, emailHash(secrets.directoryKey, address)))).length, 0);
  });

  it('describes the service', async () => {
    const info = await client().json<ServiceInfo>('GET', '/api/auth/config');
    assert.deepEqual([...info.servedRegions].sort(), ['eu', 'global', 'in']);
    assert.equal(info.consentVersion, CONSENT_VERSION);
    assert.equal(info.contacts.dpo, 'dpo@lotuspond.example');
    assert.match(info.contacts.grievance ?? '', /Grievance Officer/);
  });

  it('serves a tampered file as an error, never as data', async () => {
    const p = await signUp('IN');
    const doc = await upload(p.c, p.self.id, 'scan.pdf', new TextEncoder().encode('%PDF-1.4 original bytes'));
    const file = path.join(filesRoot.in, p.self.id, doc.id);
    const bytes = fs.readFileSync(file);
    bytes[bytes.length - 3] ^= 0x01;
    fs.writeFileSync(file, bytes);
    const res = await p.c.call('GET', `/api/profiles/${p.self.id}/documents/${doc.id}/file`);
    assert.equal(res.status, 500);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'file_unreadable');
  });
});

describe('sign-up rules', () => {
  it('refuses countries where LotusPond is not available', async () => {
    for (const country of ['AE', 'SA', 'CN', 'RU']) {
      const res = await client().error('POST', '/api/auth/register', registration(email('x'), country));
      assert.equal(res.status, 403, country);
      assert.equal(res.code, 'country_unavailable');
    }
    const uae = await client().error('POST', '/api/auth/register', registration(email('x'), 'AE'));
    assert.match(uae.message, /stored inside the UAE/);
  });

  it('refuses people under the minimum age and points to family profiles', async () => {
    const address = email('young');
    const res = await client().error('POST', '/api/auth/register', registration(address, 'IN', { ageConfirmed: false }));
    assert.equal(res.status, 400);
    assert.equal(res.code, 'under_age');
    assert.match(res.message, /18 or older/);
    assert.match(res.message, /parent or guardian/);
    assert.equal((await usersWithEmail(inCell.db, address)).length, 0);
  });

  it('requires a country, the required consents, and cross-border consent where records go abroad', async () => {
    const base = registration(email('c'), 'GB');
    const cases: [object, string][] = [
      [{ ...base, country: '' }, 'country_required'],
      [{ ...base, country: 'ZZ' }, 'country_required'],
      [{ ...base, consents: { ...base.consents, termsAndPrivacy: false } }, 'consent_required'],
      [{ ...base, consents: { ...base.consents, healthData: false } }, 'consent_required'],
      [{ ...base, consents: { ...base.consents, crossBorder: false } }, 'consent_required'],
    ];
    for (const [body, code] of cases) {
      const res = await client().error('POST', '/api/auth/register', body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.code, code);
    }
    const { country: _c, ...noCountry } = base;
    assert.equal((await client().error('POST', '/api/auth/register', noCountry)).status, 400);
    // India stores records in India, so no cross-border consent is needed or recorded.
    const india = await signUp('IN', client(), { consents: { termsAndPrivacy: true, healthData: true, crossBorder: false, marketing: false } });
    const list = await india.c.json<ConsentRecord[]>('GET', '/api/auth/consents');
    assert.ok(!list.some(r => r.kind === 'cross_border'));
  });
});

describe('consents', () => {
  it('records each consent with its version and country', async () => {
    const gb = await signUp('GB', client(), { consents: { termsAndPrivacy: true, healthData: true, crossBorder: true, marketing: false } });
    const list = await gb.c.json<ConsentRecord[]>('GET', '/api/auth/consents');
    assert.deepEqual(list.map(r => r.kind).sort(), ['cross_border', 'health_data', 'marketing', 'privacy', 'terms']);
    for (const r of list) {
      assert.equal(r.version, CONSENT_VERSION);
      assert.equal(r.country, 'GB');
      assert.equal(r.granted, r.kind !== 'marketing', r.kind);
    }
    const rows = await euCell.db.select().from(consents).where(eq(consents.userId, gb.user.id));
    assert.equal(rows.length, 5, 'stored in the account’s cell');
  });

  it('lets the optional consent change and explains that withdrawing health-data consent means deletion', async () => {
    const p = await signUp('IN');
    let list = await p.c.json<ConsentRecord[]>('PATCH', '/api/auth/consents', { kind: 'marketing', granted: true });
    assert.equal(list[0].kind, 'marketing');
    assert.equal(list[0].granted, true, 'newest first');
    list = await p.c.json<ConsentRecord[]>('PATCH', '/api/auth/consents', { kind: 'marketing', granted: false });
    assert.equal(list.filter(r => r.kind === 'marketing').length, 3, 'history is kept');

    const withdraw = await p.c.error('PATCH', '/api/auth/consents', { kind: 'health_data', granted: false });
    assert.equal(withdraw.status, 409);
    assert.equal(withdraw.code, 'withdraw_requires_deletion');
    assert.match(withdraw.message, /delete your account/);
    assert.equal((await p.c.error('PATCH', '/api/auth/consents', { kind: 'cross_border', granted: true })).status, 400, 'India stores in India');
    assert.equal((await p.c.error('PATCH', '/api/auth/consents', { kind: 'everything', granted: true })).status, 400);
    assert.equal((await client().error('GET', '/api/auth/consents')).status, 401);
  });
});

describe('preferences', () => {
  it('defaults units from the country and lets the person change them', async () => {
    const gb = await signUp('GB');
    const india = await signUp('IN');
    assert.equal(gb.user.unitSystem, 'si');
    assert.equal(india.user.unitSystem, 'conventional');
    const account = await india.c.json<SessionInfo['account']>('PATCH', '/api/auth/preferences', { unitSystem: 'si' });
    assert.equal(account.unitSystem, 'si');
    const me = await india.c.json<SessionInfo>('GET', '/api/auth/me');
    assert.equal(me.account.unitSystem, 'si');
    assert.equal(me.account.region, 'in');
    assert.equal((await india.c.error('PATCH', '/api/auth/preferences', { unitSystem: 'imperial' })).status, 400);
  });
});

describe('audit log', () => {
  it('records account events without health data', async () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:142.0) Gecko/20100101 Firefox/142.0';
    const c = client({ userAgent: ua, ip: '203.0.113.42' });
    const p = await signUp('IN', c, { displayName: 'Meera Krishnan' });
    const kid = await c.json<{ id: string }>('POST', '/api/profiles', { displayName: 'Anaya Krishnan', relationship: 'child', confirmation: 'guardian', conditions: ['Asthma'] }, 201);
    await c.json('POST', `/api/profiles/${p.self.id}/measurements`, { measurements: [measurement({ rawName: 'Haemoglobin A1c', value: 9.7, valueText: '9.7' })] }, 201);
    await upload(c, p.self.id, 'diabetes-clinic-report.pdf', new TextEncoder().encode('%PDF secret'));
    assert.equal((await c.call('GET', `/api/profiles/${p.self.id}/export`)).status, 200);
    await c.json('DELETE', `/api/profiles/${p.self.id}/records`, undefined, 204);
    await c.json('DELETE', `/api/profiles/${kid.id}`, undefined, 204);
    await c.json('PATCH', '/api/auth/preferences', { unitSystem: 'si' });
    await c.json('PATCH', '/api/auth/consents', { kind: 'marketing', granted: true });
    await c.json('POST', '/api/auth/password', { currentPassword: 'correct horse battery', newPassword: 'another long password' }, 204);
    await c.json('DELETE', '/api/auth/sessions', undefined, 204);
    const other = client({ userAgent: ua });
    assert.equal((await other.call('POST', '/api/auth/login', { email: p.email, password: 'wrong password!!' })).status, 401);
    await other.json('POST', '/api/auth/login', { email: p.email, password: 'another long password' });
    await other.json('POST', '/api/auth/logout', undefined, 204);

    const activity = await c.json<ActivityEvent[]>('GET', '/api/auth/activity');
    const kinds = activity.map(e => e.kind);
    for (const k of ['account_created', 'export', 'records_deleted', 'profile_deleted', 'preferences_changed', 'consent_changed',
      'password_changed', 'sessions_revoked', 'sign_in_failed', 'sign_in', 'sign_out'] as const) {
      assert.ok(kinds.includes(k), `${k} recorded`);
    }
    assert.equal(activity[0].kind, 'sign_out', 'newest first');
    assert.equal(activity.find(e => e.kind === 'account_created')?.device, 'Firefox on Windows');
    assert.deepEqual(activity.find(e => e.kind === 'consent_changed')?.detail, { consent: 'marketing', granted: true });

    const rows = await inCell.db.select().from(auditEvents).where(eq(auditEvents.userId, p.user.id));
    // Every field that could carry data (ids and timestamps aside: a time such as 10:41:49.7… would match "9.7").
    const text = JSON.stringify(rows.map(r => [r.kind, r.detail, r.ipHash, r.userAgent]));
    for (const secret of ['Meera', 'Anaya', 'Asthma', 'Haemoglobin', '9.7', 'diabetes', 'clinic', p.email, '203.0.113.42', 'Mozilla', 'correct horse']) {
      assert.ok(!text.includes(secret), `audit rows do not contain "${secret}"`);
    }
    const created = rows.find(r => r.kind === 'account_created')!;
    assert.match(created.ipHash ?? '', /^[0-9a-f]{32}$/);
    assert.equal(rows.filter(r => r.ipHash === created.ipHash).length >= 2, true, 'same address, same hash');
  });

  it('deleting the account removes it from its cell and the directory, keeping only a deletion record', async () => {
    const p = await signUp('FR');
    const doc = await upload(p.c, p.self.id, 'x.pdf', new TextEncoder().encode('%PDF'));
    assert.ok(fs.existsSync(path.join(filesRoot.eu, p.self.id, doc.id)));
    await p.c.json('DELETE', '/api/auth/account', { password: 'correct horse battery' }, 204);
    assert.equal((await usersWithEmail(euCell.db, p.email)).length, 0);
    assert.equal((await euCell.db.select().from(consents).where(eq(consents.userId, p.user.id))).length, 0);
    assert.equal((await main.select().from(directory).where(eq(directory.userId, p.user.id))).length, 0);
    assert.ok(!dirHas(filesRoot.eu, p.self.id));
    const left = await euCell.db.select().from(auditEvents).where(eq(auditEvents.userId, p.user.id));
    assert.deepEqual(left.map(r => [r.kind, r.ipHash, r.userAgent]), [['account_deleted', null, null]]);
    assert.equal((await client().error('POST', '/api/auth/login', { email: p.email, password: 'correct horse battery' })).status, 401);
    // The email is free again.
    await signUp('FR', client(), { email: p.email } as object);
  });
});
