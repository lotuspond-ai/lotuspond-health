// The organisation side of the connector core: API keys (kept only as SHA-256), operations limited to the key's list
// and to organisation authority, planned operations answering 501, every call recorded, and the public catalogue
// still open without a key.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDatabase, type Database } from '../src/db/client.ts';
import { organisationCalls, organisationKeys } from '../src/db/schema.ts';
import { DiskFileStore } from '../src/lib/files.ts';
import { createOrganisation, createOrganisationKey, revokeOrganisationKey } from '../src/connectors/organisations.ts';

let database: Database;
let filesDir: string;
let app: ReturnType<typeof createApp>;

before(async () => {
  database = await openDatabase({ url: process.env.TEST_DATABASE_URL });
  await database.migrate(fileURLToPath(new URL('../drizzle', import.meta.url)));
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspond-orgs-'));
  app = createApp({ db: database.db, files: new DiskFileStore(filesDir), config: loadConfig({ NODE_ENV: 'test', RECORD_AGENT: 'off' }) });
});
after(async () => { await database.close(); fs.rmSync(filesDir, { recursive: true, force: true }); });

const call = (url: string, key?: string, method = 'GET') =>
  app.request(url, { method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });

describe('organisation API', () => {
  test('a key: only its hash is stored, and it names its organisation and operations', async () => {
    const org = await createOrganisation(database.db, 'City Hospital', 'in');
    const { key, row } = await createOrganisationKey(database.db, org.id, 'Pilot', ['claims.status']);
    assert.match(key, /^lpk_[A-Za-z0-9_-]{43}$/);
    const [stored] = await database.db.select().from(organisationKeys).where(eq(organisationKeys.id, row.id));
    assert.ok(!JSON.stringify(stored).includes(key.slice(4)), 'the key itself is never stored');
    const res = await call('/v1/organisation', key);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const me = await res.json() as { name: string; region: string; key: { operations: string[]; prefix: string } };
    assert.equal(me.name, 'City Hospital');
    assert.equal(me.region, 'in');
    assert.deepEqual(me.key.operations, ['claims.status']);
    assert.equal(me.key.prefix, key.slice(0, 12));
  });

  test('no key, a made-up key or a revoked key: 401', async () => {
    assert.equal((await call('/v1/organisation')).status, 401);
    assert.equal((await call('/v1/organisation', `lpk_${'A'.repeat(43)}`)).status, 401);
    assert.equal((await call('/v1/organisation', 'not-a-key')).status, 401);
    const org = await createOrganisation(database.db, 'Revoked Co', 'in');
    const { key, row } = await createOrganisationKey(database.db, org.id, 'Old', ['claims.status']);
    assert.equal((await call('/v1/organisation', key)).status, 200);
    assert.ok(await revokeOrganisationKey(database.db, row.id));
    const res = await call('/v1/organisation', key);
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate') ?? '', /invalid_token/);
  });

  test('operations: person-only and out-of-key calls are refused, planned ones answer 501, all are recorded', async () => {
    const org = await createOrganisation(database.db, 'Claims Desk', 'in');
    const { key } = await createOrganisationKey(database.db, org.id, 'Claims', ['claims.status']);
    const person = await call('/v1/operations/records.fetch', key, 'POST');
    assert.equal(person.status, 403);
    assert.equal((await person.json() as { error: { code: string } }).error.code, 'wrong_authority');
    const outside = await call('/v1/operations/preauth.submit', key, 'POST');
    assert.equal(outside.status, 403);
    assert.equal((await outside.json() as { error: { code: string } }).error.code, 'not_in_key');
    const planned = await call('/v1/operations/claims.status', key, 'POST');
    assert.equal(planned.status, 501);
    assert.equal((await planned.json() as { error: { code: string; operation: string } }).error.operation, 'claims.status');
    assert.equal((await call('/v1/operations/teleport', key, 'POST')).status, 404);
    const calls = await database.db.select().from(organisationCalls).where(eq(organisationCalls.organisationId, org.id));
    assert.deepEqual(calls.map(c => `${c.operation}:${c.outcome}`).sort(), ['claims.status:not_offered', 'preauth.submit:refused', 'records.fetch:refused']);
  });

  test('a key cannot be given a person-only operation', async () => {
    const org = await createOrganisation(database.db, 'Builder', 'in');
    await assert.rejects(createOrganisationKey(database.db, org.id, 'x', ['records.fetch']), /Not organisation operations/);
  });

  test('the connector catalogue stays public', async () => {
    assert.equal((await call('/v1/connectors')).status, 200);
  });
});
