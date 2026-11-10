// Agent lab tools with lab booking switched on (the simulated lab): find tests, propose a booking the person
// confirms in the app, and read bookings back. Nothing is booked by an agent.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CreatedAgentToken } from '../../shared/agents.ts';
import { openDatabase, type Database } from '../src/db/client.ts';
import { labEnv } from './lab-helpers.ts';

const migrations = fileURLToPath(new URL('../drizzle', import.meta.url));
let database: Database;
let filesDir: string;

before(async () => {
  database = await openDatabase({ url: process.env.TEST_DATABASE_URL });
  await database.migrate(migrations);
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspond-agent-labs-'));
});
after(async () => {
  await database?.close();
  fs.rmSync(filesDir, { recursive: true, force: true });
});

test('agents find tests and propose a booking; booking stays with the person', async () => {
  const env = labEnv(database, filesDir);
  const { c, profileId } = await env.signUp();
  const made = await c.json<CreatedAgentToken>('POST', '/api/agents/tokens', { name: 'ChatGPT', scopes: ['health:read'], profileIds: [profileId], expiresInDays: null }, 201);
  let id = 0;
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await env.app.request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${made.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) });
    return (await res.json() as { result: { isError: boolean; structuredContent: Record<string, any>; content: { text: string }[] } }).result;
  };
  const found = await call('find_lab_tests', { pincode: '560034' });
  assert.equal(found.isError, false, found.content[0].text);
  assert.ok(found.structuredContent.tests.some((t: { code: string }) => t.code === 'FL_ESSENTIAL'));
  const proposal = await call('propose_lab_booking', { test_codes: ['FL_ESSENTIAL'], pincode: '560034', reason: 'Yearly check' });
  assert.equal(proposal.structuredContent.status, 'needs_confirmation');
  const url = new URL(proposal.structuredContent.confirmUrl);
  assert.equal(url.pathname, '/app');
  assert.equal(url.searchParams.get('book'), 'FL_ESSENTIAL');
  assert.equal(url.searchParams.get('profile'), profileId);
  assert.equal(url.hash, '#labs');
  assert.equal((await call('propose_lab_booking', { test_codes: ['NOPE'], pincode: '560034' })).isError, true);
  assert.deepEqual((await call('list_lab_orders', {})).structuredContent.orders, [], 'nothing was booked');
  await env.book(c, profileId);
  assert.equal((await call('list_lab_orders', {})).structuredContent.orders.length, 1);
});
