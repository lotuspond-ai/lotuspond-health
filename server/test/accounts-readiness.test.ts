// Readiness to turn Health passwords off (build plan M8): counts of who is active and how they sign in.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDatabase, type Database } from '../src/db/client.ts';
import { sessions, users } from '../src/db/schema.ts';
import { DiskFileStore } from '../src/lib/files.ts';
import { singleCell } from '../src/cells.ts';
import { formatReadiness, readiness } from '../src/auth/accounts-migration.ts';
import { registration } from './helpers.ts';

let database: Database;
let filesDir: string;
before(async () => {
  database = await openDatabase({});
  await database.migrate(fileURLToPath(new URL('../drizzle', import.meta.url)));
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspond-readiness-'));
});
after(async () => { await database.close(); fs.rmSync(filesDir, { recursive: true, force: true }); });

test('readiness counts active people by how they sign in, and who has not moved yet', async () => {
  const app = createApp({ db: database.db, files: new DiskFileStore(filesDir), config: loadConfig({ NODE_ENV: 'test', RECORD_AGENT: 'off' }) });
  const register = async (address: string) => {
    const res = await app.request('http://health.test/api/auth/register', {
      method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify(registration(address)),
    });
    assert.equal(res.status, 201);
    const [u] = await database.db.select().from(users).where(eq(users.email, address));
    return u.id;
  };
  const moved = await register('moved@example.com');
  const linked = await register('linked@example.com');
  const plain = await register('plain@example.com');
  const idle = await register('idle@example.com');
  // moved: signed in with Accounts, and has an Accounts session too. linked: imported, not moved. idle: inactive.
  await database.db.update(users).set({ accountsSubject: 'sub-moved', accountsSignedInAt: new Date() }).where(eq(users.id, moved));
  await database.db.insert(sessions).values({ id: 'accounts-session-digest', userId: moved, expiresAt: new Date(Date.now() + 86_400_000), viaAccounts: true });
  await database.db.update(users).set({ accountsSubject: 'sub-linked' }).where(eq(users.id, linked));
  await database.db.update(sessions).set({ lastSeenAt: new Date(Date.now() - 30 * 86_400_000) }).where(eq(sessions.userId, idle));

  const cells = [singleCell(database.db, new DiskFileStore(filesDir), ['in', 'eu', 'us', 'global']).defaultCell];
  const r = await readiness(cells, 14);
  assert.deepEqual(r, {
    days: 14, active: 3, activeWithPassword: 3, activeWithAccounts: 1, activeNotMoved: 2,
    linkedNotMoved: 1, notLinked: 2, moved: 1,
  });
  assert.ok(plain);
  const text = formatReadiness(r);
  assert.match(text, /never signed in with Accounts yet: 2 \(67%\)/);
  assert.doesNotMatch(text, /@|[0-9a-f]{8}-[0-9a-f]{4}-/, 'counts only');
});
