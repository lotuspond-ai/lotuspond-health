// The organisation API end to end: a person signs up, makes an organisation and a key in the developer console, and
// the key reaches the sandbox hospital over REST and MCP. Writes wait for an approver. A real FHIR R4 system is
// reached only after LotusPond gives live access and adds the connection, with its credentials sealed.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { createApp } from '../src/app.ts';
import { completeDeps } from '../src/cells.ts';
import type { Deps } from '../src/http.ts';
import { loadConfig } from '../src/config.ts';
import { openDatabase, type Database } from '../src/db/client.ts';
import { organisationApprovals, organisationConnections, organisations } from '../src/db/schema.ts';
import { DiskFileStore } from '../src/lib/files.ts';
import { organisationRuntime } from '../src/connectors/runtime.ts';
import { INTEGRATIONS, INTEGRATION_STATUS_TEXT } from '../../shared/integrations.ts';
import { HIS_ADAPTERS } from '../src/connectors/his/index.ts';
import { makeClient, registration } from './helpers.ts';

let database: Database;
let filesDir: string;
let app: ReturnType<typeof createApp>;
let deps: Deps;

// A small FHIR R4 server standing in for a hospital's HIS (Bahmni, TrakCare, …).
const fhirSeen: { method: string; path: string; auth: string | null }[] = [];
const fhir = new Hono();
fhir.use('*', async (c, next) => { fhirSeen.push({ method: c.req.method, path: new URL(c.req.url).pathname + new URL(c.req.url).search, auth: c.req.header('authorization') ?? null }); await next(); });
fhir.get('/fhir/Patient', c => c.json({ resourceType: 'Bundle', type: 'searchset', link: [{ relation: 'self', url: 'https://his.internal/secret' }], entry: [{ resource: { resourceType: 'Patient', id: 'p1', name: [{ text: 'Test Patient' }] } }, { resource: { resourceType: 'OperationOutcome' } }] }));
fhir.get('/fhir/Patient/p1', c => c.json({ resourceType: 'Patient', id: 'p1' }));
fhir.get('/fhir/Patient/:id', c => c.json({ resourceType: 'OperationOutcome' }, 404));
fhir.get('/fhir/Encounter', c => c.json({ resourceType: 'Bundle', entry: [{ resource: { resourceType: 'Encounter', id: 'e1' } }] }));
fhir.get('/fhir/DocumentReference', c => c.json({ resourceType: 'OperationOutcome' }, 400));
fhir.post('/fhir/DocumentReference', async c => c.json({ ...(await c.req.json() as object), id: 'd-new' }, 201));
const fakeFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  return fhir.request(url.pathname + url.search, init as RequestInit);
};

before(async () => {
  database = await openDatabase({ url: process.env.TEST_DATABASE_URL });
  await database.migrate(fileURLToPath(new URL('../drizzle', import.meta.url)));
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspond-org-api-'));
  deps = completeDeps({ db: database.db, files: new DiskFileStore(filesDir), config: loadConfig({ NODE_ENV: 'test', RECORD_AGENT: 'off' }) });
  app = createApp(deps, { orgFetch: fakeFetch });
});
after(async () => { await database.close(); fs.rmSync(filesDir, { recursive: true, force: true }); });

const api = (url: string, key: string, body?: unknown) => app.request(url, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const mcp = (key: string, method: string, params?: unknown) => app.request('/v1/mcp', {
  method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
});

async function consoleOrg(email: string) {
  const person = makeClient(app);
  await person.json('POST', '/api/auth/register', registration(email), 201);
  const org = await person.json<{ id: string; access: string; role: string }>('POST', '/api/console/organisations', { name: 'Scribe Startup' }, 201);
  return { person, org };
}

describe('organisation API: sandbox, console, MCP', () => {
  test('every integration with an adapter is in the catalogue, and only available or on-request ones have one', () => {
    for (const id of HIS_ADAPTERS.keys()) assert.ok(INTEGRATIONS.some(i => i.id === id), `${id} is listed`);
    for (const i of INTEGRATIONS) assert.equal(HIS_ADAPTERS.has(i.id), i.status === 'available' || i.status === 'on_request', i.id);
  });

  test('the console: make an organisation and a key; the key reaches the sandbox over REST', async () => {
    const { person, org } = await consoleOrg('dev1@example.com');
    assert.equal(org.access, 'sandbox');
    assert.equal(org.role, 'owner');
    const made = await person.json<{ key: string; operations: string[] }>('POST', `/api/console/organisations/${org.id}/keys`, { name: 'Dev', operations: ['patients.search', 'encounters.list', 'documents.upload', 'claims.status'] }, 201);
    assert.match(made.key, /^lpk_/);
    const me = await (await api('/v1/organisation', made.key)).json() as { access: string };
    assert.equal(me.access, 'sandbox');
    const { connections } = await (await api('/v1/connections', made.key)).json() as { connections: { id: string; connector: string; sandbox: boolean }[] };
    assert.equal(connections.length, 1);
    assert.ok(connections[0].sandbox);
    const connection = connections[0].id;

    const found = await api('/v1/operations/patients.search', made.key, { connection, name: 'asha' });
    assert.equal(found.status, 200);
    const out = await found.json() as { status: string; result: { entry: { resource: { id: string } }[] } };
    assert.equal(out.status, 'done');
    assert.deepEqual(out.result.entry.map(e => e.resource.id), ['sbx-p-1001']);

    const visits = await (await api('/v1/operations/encounters.list', made.key, { connection, patient: 'sbx-p-1001' })).json() as { result: { entry: { resource: { resourceType: string } }[] } };
    assert.ok(visits.result.entry.some(e => e.resource.resourceType === 'Encounter'));
    const claim = await (await api('/v1/operations/claims.status', made.key, { connection, claim: 'clm-1002' })).json() as { result: { outcome: string } };
    assert.equal(claim.result.outcome, 'partial');

    assert.equal((await api('/v1/operations/patients.search', made.key, { connection })).status, 400, 'needs something to search by');
    assert.equal((await api('/v1/operations/encounters.list', made.key, { connection, patient: 'nobody' })).status, 404);
    assert.equal((await api('/v1/operations/patients.search', made.key, { connection: '00000000-0000-4000-8000-000000000000', name: 'asha' })).status, 404);
    assert.equal((await api('/v1/operations/preauth.submit', made.key, { connection })).status, 403, 'not in the key');

    const page = await person.json<{ calls: { operation: string; outcome: string }[]; keys: unknown[] }>('GET', `/api/console/organisations/${org.id}`);
    assert.ok(page.calls.some(c => c.operation === 'patients.search' && c.outcome === 'done'));
    assert.equal(page.keys.length, 1);
  });

  test('an upload waits for an approver, then goes to the system; a rejection never does', async () => {
    const { person, org } = await consoleOrg('dev2@example.com');
    const { key } = await person.json<{ key: string }>('POST', `/api/console/organisations/${org.id}/keys`, { name: 'Writer', operations: ['documents.upload', 'encounters.list'] }, 201);
    const { connections } = await (await api('/v1/connections', key)).json() as { connections: { id: string }[] };
    const doc = { connection: connections[0].id, patient: 'sbx-p-1002', encounter: 'sbx-e-2003', title: 'Visit note', contentType: 'text/plain', data: Buffer.from('Synthetic note').toString('base64'), author: 'Dr Test' };
    const held = await api('/v1/operations/documents.upload', key, doc);
    assert.equal(held.status, 202);
    const { approval } = await held.json() as { approval: { id: string; status: string; summary: string } };
    assert.equal(approval.status, 'pending');
    assert.match(approval.summary, /Visit note/);
    const [stored] = await database.db.select().from(organisationApprovals).where(eq(organisationApprovals.id, approval.id));
    assert.ok(!stored.inputCt.includes('Synthetic note'), 'the held document is not stored in the clear');

    const done = await person.json<{ status: string; result: { resourceType: string } }>('POST', `/api/console/organisations/${org.id}/approvals/${approval.id}`, { decision: 'approve' });
    assert.equal(done.status, 'done');
    assert.equal(done.result.resourceType, 'DocumentReference');
    assert.equal((await person.error('POST', `/api/console/organisations/${org.id}/approvals/${approval.id}`, { decision: 'approve' })).status, 409, 'not sent twice');
    const [after] = await database.db.select().from(organisationApprovals).where(eq(organisationApprovals.id, approval.id));
    assert.equal(after.inputCt, '', 'the held input is dropped once sent');
    const checked = await (await api(`/v1/approvals/${approval.id}`, key)).json() as { status: string };
    assert.equal(checked.status, 'done');
    const visits = await (await api('/v1/operations/encounters.list', key, { connection: connections[0].id, patient: 'sbx-p-1002' })).json() as { result: { entry: { resource: { resourceType: string; description?: string } }[] } };
    assert.ok(visits.result.entry.some(e => e.resource.description === 'Visit note'), 'the upload shows on the visit');

    const second = await (await api('/v1/operations/documents.upload', key, doc)).json() as { approval: { id: string } };
    const rejected = await person.json<{ status: string }>('POST', `/api/console/organisations/${org.id}/approvals/${second.approval.id}`, { decision: 'reject' });
    assert.equal(rejected.status, 'rejected');
  });

  test('organisations are private to their members', async () => {
    const { org } = await consoleOrg('owner3@example.com');
    const other = makeClient(app);
    await other.json('POST', '/api/auth/register', registration('other3@example.com'), 201);
    assert.equal((await other.error('GET', `/api/console/organisations/${org.id}`)).status, 404);
    assert.equal((await other.error('POST', `/api/console/organisations/${org.id}/keys`, { name: 'x', operations: ['patients.search'] })).status, 404);
    const anonymous = makeClient(app);
    assert.equal((await anonymous.call('GET', '/api/console')).status, 401);
  });

  test('MCP: tools follow the key, and a tool call reaches the sandbox', async () => {
    const { person, org } = await consoleOrg('dev4@example.com');
    const { key } = await person.json<{ key: string }>('POST', `/api/console/organisations/${org.id}/keys`, { name: 'Agent', operations: ['patients.search'] }, 201);
    const init = await (await mcp(key, 'initialize', { protocolVersion: '2025-06-18' })).json() as { result: { protocolVersion: string; instructions: string } };
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.match(init.result.instructions, /sandbox access only/);
    const tools = await (await mcp(key, 'tools/list')).json() as { result: { tools: { name: string }[] } };
    assert.deepEqual(tools.result.tools.map(t => t.name).sort(), ['get_approval', 'list_connections', 'search_patients']);
    const conns = await (await mcp(key, 'tools/call', { name: 'list_connections', arguments: {} })).json() as { result: { structuredContent: { connections: { id: string }[] } } };
    const connection = conns.result.structuredContent.connections[0].id;
    const res = await (await mcp(key, 'tools/call', { name: 'search_patients', arguments: { connection, identifier: 'MRN1004' } })).json() as { result: { isError: boolean; structuredContent: { result: { entry: { resource: { id: string } }[] } } } };
    assert.equal(res.result.isError, false);
    assert.equal(res.result.structuredContent.result.entry[0].resource.id, 'sbx-p-1004');
    const denied = await (await mcp(key, 'tools/call', { name: 'upload_document', arguments: {} })).json() as { error: { code: number } };
    assert.equal(denied.error.code, -32602);
    assert.equal((await app.request('/v1/mcp', { method: 'POST', body: '{}' })).status, 401);
  });

  test('a real FHIR system: only with live access, credentials sealed, nothing of the hospital server passed back', async () => {
    const { person, org } = await consoleOrg('dev5@example.com');
    await person.json('POST', `/api/console/organisations/${org.id}/live-request`, { systems: 'Bahmni', hospital: 'Test Hospital, Pune', note: 'Signed letter attached' });
    const runtime = organisationRuntime({ db: database.db, keyrings: deps.secrets.fileKeys, fetch: fakeFetch });
    await assert.rejects(runtime.addConnection(org.id, { connectorId: 'bahmni', name: 'Test HIS', settings: { baseUrl: 'http://localhost/fhir' }, secret: { token: 'his-token' } }), /live access first/);
    await database.db.update(organisations).set({ access: 'live' }).where(eq(organisations.id, org.id));
    await assert.rejects(runtime.addConnection(org.id, { connectorId: 'akhil', name: 'x', settings: {}, secret: null }), /no connector/);
    await assert.rejects(runtime.addConnection(org.id, { connectorId: 'bahmni', name: 'x', settings: {}, secret: null }), /baseUrl/);
    const conn = await runtime.addConnection(org.id, { connectorId: 'bahmni', name: 'Test HIS', settings: { baseUrl: 'http://localhost/fhir' }, secret: { token: 'his-token' } });
    const [row] = await database.db.select().from(organisationConnections).where(eq(organisationConnections.id, conn.id));
    assert.ok(row.secretCt);

    const { key } = await person.json<{ key: string }>('POST', `/api/console/organisations/${org.id}/keys`, { name: 'Live', operations: ['patients.search', 'encounters.list', 'documents.upload'] }, 201);
    const foundRes = await api('/v1/operations/patients.search', key, { connection: conn.id, identifier: 'UHID|42' });
    const found = await foundRes.json() as { result: Record<string, unknown> & { entry: { resource: { resourceType: string } }[] } };
    assert.equal(foundRes.status, 200, JSON.stringify(found));
    assert.deepEqual(found.result.entry.map(e => e.resource.resourceType), ['Patient'], 'only patients come back');
    assert.ok(!JSON.stringify(found.result).includes('his.internal'), "the hospital server's own links are dropped");
    assert.equal(fhirSeen.at(-1)?.auth, 'Bearer his-token');
    assert.match(fhirSeen.at(-1)?.path ?? '', /identifier=UHID%7C42/);

    const visits = await (await api('/v1/operations/encounters.list', key, { connection: conn.id, patient: 'p1' })).json() as { result: { entry: { resource: { id: string } }[] } };
    assert.deepEqual(visits.result.entry.map(e => e.resource.id), ['e1'], 'visits still come when the server has no document search');
    assert.equal((await api('/v1/operations/encounters.list', key, { connection: conn.id, patient: 'p2' })).status, 404);
    assert.equal((await api('/v1/operations/claims.status', key, { connection: conn.id, claim: 'X' })).status, 403, 'not in this key');

    const held = await (await api('/v1/operations/documents.upload', key, { connection: conn.id, patient: 'p1', title: 'Note', contentType: 'text/plain', data: Buffer.from('x').toString('base64') })).json() as { approval: { id: string } };
    const sent = await person.json<{ status: string; result: { id: string } }>('POST', `/api/console/organisations/${org.id}/approvals/${held.approval.id}`, { decision: 'approve' });
    assert.equal(sent.status, 'done');
    assert.equal(sent.result.id, 'd-new');
    assert.equal(fhirSeen.at(-1)?.method, 'POST');
  });

  test('a sandbox organisation cannot reach a live connection', async () => {
    const { person, org } = await consoleOrg('dev6@example.com');
    await database.db.update(organisations).set({ access: 'live' }).where(eq(organisations.id, org.id));
    const runtime = organisationRuntime({ db: database.db, keyrings: deps.secrets.fileKeys, fetch: fakeFetch });
    const conn = await runtime.addConnection(org.id, { connectorId: 'fhir', name: 'HIS', settings: { baseUrl: 'http://localhost/fhir' }, secret: null });
    await database.db.update(organisations).set({ access: 'sandbox' }).where(eq(organisations.id, org.id));
    const { key } = await person.json<{ key: string }>('POST', `/api/console/organisations/${org.id}/keys`, { name: 'K', operations: ['patients.search'] }, 201);
    const res = await api('/v1/operations/patients.search', key, { connection: conn.id, name: 'test' });
    assert.equal(res.status, 403);
    assert.equal((await res.json() as { error: { code: string } }).error.code, 'not_live');
  });

  test('the developers page shows every system with the status the catalogue gives it', () => {
    const html = fs.readFileSync(fileURLToPath(new URL('../../developers/index.html', import.meta.url)), 'utf8');
    for (const i of INTEGRATIONS) {
      const row = new RegExp(`<tr data-integration="${i.id}">(.*?)</tr>`).exec(html)?.[1];
      assert.ok(row, `${i.id} has a row`);
      assert.match(row, new RegExp(`<td>(<b>)?${INTEGRATION_STATUS_TEXT[i.status].label}(</b>)?</td>`), `${i.id} shows "${INTEGRATION_STATUS_TEXT[i.status].label}"`);
    }
    assert.equal((html.match(/data-integration=/g) ?? []).length, INTEGRATIONS.length, 'no system the catalogue does not list');
  });

  test('the public catalogue lists the hospital systems with their status', async () => {
    const res = await app.request('/v1/connectors?region=in');
    const body = await res.json() as { systems: { id: string; status: string; runsHere: boolean }[] };
    assert.equal(body.systems.find(s => s.id === 'sandbox')?.status, 'available');
    assert.equal(body.systems.find(s => s.id === 'akhil')?.runsHere, false);
    const eu = await (await app.request('/v1/connectors?region=eu')).json() as { systems: unknown[] };
    assert.equal(eu.systems.length, 0);
  });
});
