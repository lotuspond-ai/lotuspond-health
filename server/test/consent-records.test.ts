// Consent records added for the legal review (Notion: legal review brief, gaps 1–3): a new consent version asks
// people to accept the updated texts; adding a family member records what the account holder confirmed; every agent
// connection, change and disconnection records the sharing consent with its profiles and permissions.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import type { CreatedAgentToken } from '../../shared/agents.ts';
import { confirmationFor, needsGuardian } from '../../shared/family.ts';
import { CONSENT_VERSION } from '../../shared/regions.ts';
import type { ConsentRecord, Profile, SessionInfo } from '../../shared/types.ts';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDatabase, type Database } from '../src/db/client.ts';
import { consents } from '../src/db/schema.ts';
import type { AppEnv } from '../src/http.ts';
import { DiskFileStore } from '../src/lib/files.ts';
import { makeClient, registration } from './helpers.ts';

const migrations = fileURLToPath(new URL('../drizzle', import.meta.url));
let database: Database;
let app: Hono<AppEnv>;
let filesDir: string;

before(async () => {
  database = await openDatabase({ url: process.env.TEST_DATABASE_URL });
  await database.migrate(migrations);
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspond-consents-'));
  app = createApp({ db: database.db, files: new DiskFileStore(filesDir), config: loadConfig({ NODE_ENV: 'test', ACCOUNTS_ISSUER: 'fake', TRUST_PROXY: 'true' }) });
});
after(async () => {
  await database?.close();
  fs.rmSync(filesDir, { recursive: true, force: true });
});

let n = 0;
async function account() {
  const c = makeClient(app);
  const info = await c.signUp(registration(`consents-${Date.now()}-${++n}@example.com`));
  return { c, info };
}

describe('updated texts', () => {
  test('a consent given for older texts is reported until the person accepts the current ones', async () => {
    const { c, info } = await account();
    assert.deepEqual(info.consentsOutdated, [], 'a new account has accepted the current texts');
    // As if this account signed up before the texts changed.
    await database.db.update(consents).set({ version: '2026-11-03' }).where(eq(consents.userId, info.account.id));
    assert.deepEqual((await c.json<SessionInfo>('GET', '/api/auth/me')).consentsOutdated, ['terms', 'privacy']);
    await c.json('PATCH', '/api/auth/consents', { kind: 'privacy', granted: true });
    await c.json('PATCH', '/api/auth/consents', { kind: 'terms', granted: true });
    assert.deepEqual((await c.json<SessionInfo>('GET', '/api/auth/me')).consentsOutdated, []);
    const list = await c.json<ConsentRecord[]>('GET', '/api/auth/consents');
    assert.equal(list.find(r => r.kind === 'privacy')!.version, CONSENT_VERSION);
  });

  test('per-item consents cannot be set through the consent endpoint', async () => {
    const { c } = await account();
    assert.equal((await c.error('PATCH', '/api/auth/consents', { kind: 'agent_sharing', granted: true })).status, 400);
    assert.equal((await c.error('PATCH', '/api/auth/consents', { kind: 'family_profile', granted: true })).status, 400);
  });
});

describe('family members', () => {
  test('which confirmation applies: children and anyone under 18 need a guardian', () => {
    const now = new Date('2026-11-10T00:00:00Z');
    assert.equal(needsGuardian('child', null, now), true);
    assert.equal(needsGuardian('sibling', '2012-01-01', now), true);
    assert.equal(needsGuardian('sibling', '2008-11-10', now), false, '18 today');
    assert.equal(needsGuardian('parent', null, now), false);
    assert.equal(confirmationFor('other', '2020-03-03'), 'guardian');
  });

  test('adding a family member needs a confirmation, and it is recorded with the profile', async () => {
    const { c } = await account();
    const missing = await c.error('POST', '/api/profiles', { displayName: 'Kiran', relationship: 'child' });
    assert.equal(missing.status, 400);
    const wrong = await c.error('POST', '/api/profiles', { displayName: 'Kiran', relationship: 'sibling', dateOfBirth: '2015-04-04', confirmation: 'agreed' });
    assert.equal(wrong.code, 'guardian_required', 'someone under 18 needs the guardian confirmation');
    const kid = await c.json<Profile>('POST', '/api/profiles', { displayName: 'Kiran', relationship: 'child', confirmation: 'guardian' }, 201);
    const mum = await c.json<Profile>('POST', '/api/profiles', { displayName: 'Lakshmi', relationship: 'parent', confirmation: 'agreed' }, 201);
    let list = await c.json<ConsentRecord[]>('GET', '/api/auth/consents');
    const family = list.filter(r => r.kind === 'family_profile');
    assert.deepEqual(family.map(r => r.detail).sort((a, b) => a!.profileId!.localeCompare(b!.profileId!)),
      [{ profileId: kid.id, relationship: 'child', confirmation: 'guardian' }, { profileId: mum.id, relationship: 'parent', confirmation: 'agreed' }]
        .sort((a, b) => a.profileId.localeCompare(b.profileId)));
    assert.ok(family.every(r => r.granted && r.version === CONSENT_VERSION));

    await c.json('DELETE', `/api/profiles/${kid.id}`, undefined, 204);
    list = await c.json<ConsentRecord[]>('GET', '/api/auth/consents');
    const ended = list.find(r => r.kind === 'family_profile' && r.detail?.profileId === kid.id && !r.granted);
    assert.ok(ended, 'removing the profile ends its consent');
  });
});

describe('agent sharing', () => {
  test('connecting, changing and disconnecting an agent each record the sharing consent', async () => {
    const { c, info } = await account();
    const self = info.profiles[0];
    const kid = await c.json<Profile>('POST', '/api/profiles', { displayName: 'Kiran', relationship: 'child', confirmation: 'guardian' }, 201);
    const made = await c.json<CreatedAgentToken>('POST', '/api/agents/tokens', { name: 'Claude Desktop', scopes: ['health:read'], profileIds: [self.id], expiresInDays: null }, 201);
    await c.json('PATCH', `/api/agents/${made.connection.id}`, { profileIds: [self.id, kid.id], scopes: ['health:read', 'health:write'] });
    await c.json('DELETE', `/api/agents/${made.connection.id}`, undefined, 204);
    const sharing = (await c.json<ConsentRecord[]>('GET', '/api/auth/consents')).filter(r => r.kind === 'agent_sharing').reverse(); // oldest first
    assert.equal(sharing.length, 3);
    assert.deepEqual(sharing.map(r => r.granted), [true, true, false]);
    assert.deepEqual(sharing[0].detail, { connectionId: made.connection.id, agent: 'Claude Desktop', profileIds: [self.id], scopes: ['health:read'], categories: ['results', 'conditions', 'files', 'labs'], expiresAt: null });
    assert.deepEqual(sharing[1].detail?.profileIds, [self.id, kid.id]);
    assert.deepEqual(sharing[1].detail?.scopes, ['health:read', 'health:write']);
    assert.ok(sharing.every(r => r.version === CONSENT_VERSION && r.country === 'IN'));
  });
});
