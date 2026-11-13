// Gmail and Outlook as record agent sources, against local copies of the Gmail API and Microsoft Graph: the sign-in
// pages (Google's offline access, Microsoft's scopes), only health emails and only their report PDFs (not invoices,
// not other emails), password-protected PDFs noted, each attachment saved once across overlapping checks, Google's
// refresh that keeps the same refresh token and Microsoft's that rotates it, and Graph's paging.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { Hono, type Context } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import { RECORD_AGENT_NOTICE_VERSION, type RecordConnectionView, type RecordRunView, type SourcesInfo } from '../../shared/sources.ts';
import type { SessionInfo } from '../../shared/types.ts';
import { createApp } from '../src/app.ts';
import { singleCell } from '../src/cells.ts';
import { loadConfig } from '../src/config.ts';
import { ephemeralSecrets } from '../src/compliance/secrets.ts';
import { openDatabase, type Database } from '../src/db/client.ts';
import { DiskFileStore } from '../src/lib/files.ts';
import { localBrowsers } from '../src/records/browsers.ts';
import { createRecordAgent, type RecordAgent } from '../src/records/service.ts';
import { gmailFetcher, gmailQuery, isHealthEmail, isRecordPdf, outlookFetcher } from '../src/records/api/mail.ts';
import { makeClient, registration, type TestClient } from './helpers.ts';

const migrations = fileURLToPath(new URL('../drizzle', import.meta.url));
let clock = Date.parse('2026-11-13T06:00:00Z');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const DAY = 86_400_000;
const pdf = (s: string, locked = false) => Buffer.from(`%PDF-1.4\n% ${s}\n${locked ? '/Encrypt 5 0 R\n' : ''}%%EOF\n`);

/** A token endpoint: Google keeps the same refresh token, Microsoft rotates it (single use). */
function tokens(clientId: string, rotate: boolean) {
  const s = { codes: new Set(['good-code']), access: new Map<string, number>(), refresh: new Set<string>(), n: 0, refreshes: [] as Record<string, string>[] };
  const issue = (refresh?: string) => {
    const n = ++s.n;
    s.access.set(`acc-${n}`, clock + 3600_000);
    const r = refresh ?? `ref-${n}`;
    s.refresh.add(r);
    return { access_token: `acc-${n}`, token_type: 'Bearer', expires_in: 3599, ...(refresh && !rotate ? {} : { refresh_token: r }) };
  };
  const handler = async (c: Context) => {
    const p = Object.fromEntries(new URLSearchParams(await c.req.text()));
    if (p.client_id !== clientId || p.client_secret !== 'mail-secret-123') return c.json({ error: 'invalid_client' }, 401);
    if (p.grant_type === 'authorization_code' && s.codes.delete(p.code)) return c.json(issue());
    if (p.grant_type === 'refresh_token' && s.refresh.has(p.refresh_token)) {
      s.refreshes.push(p);
      if (rotate) { s.refresh.delete(p.refresh_token); return c.json(issue()); }
      return c.json(issue(p.refresh_token));
    }
    return c.json({ error: 'invalid_grant' }, 400);
  };
  const authed = (c: Context) => { const exp = s.access.get(c.req.header('authorization')?.replace(/^Bearer /, '') ?? ''); return !!exp && exp > clock; };
  return { s, handler, authed };
}

type Mail = { id: string; from: string; subject: string; at: number; files: { name: string; type: string; bytes: Buffer; inline?: boolean }[] };
const MAILS: Mail[] = [
  { id: 'm1', from: 'Thyrocare <reports@mail.thyrocare.com>', subject: 'Your Aarogyam report', at: clock - 40 * DAY,
    files: [{ name: 'TC823411_Report.pdf', type: 'application/pdf', bytes: pdf('thyrocare report') }, { name: 'Invoice_TC823411.pdf', type: 'application/pdf', bytes: pdf('invoice') }] },
  { id: 'm2', from: 'Shop <orders@shop.example>', subject: 'Your order has shipped', at: clock - 30 * DAY, files: [{ name: 'order.pdf', type: 'application/pdf', bytes: pdf('order') }] },
  { id: 'm3', from: 'Ravi <ravi@example.com>', subject: 'Lab report for mom', at: clock - 20 * DAY, files: [{ name: 'CBC.pdf', type: 'application/pdf', bytes: pdf('cbc') }, { name: 'photo.jpg', type: 'image/jpeg', bytes: Buffer.from('jpeg') }] },
  { id: 'm4', from: 'Dr Lal PathLabs <noreply@lalpathlabs.com>', subject: 'Report ready', at: clock - 10 * DAY, files: [{ name: 'DL55012345.pdf', type: 'application/pdf', bytes: pdf('drlal', true) }] },
  { id: 'm5', from: 'Old Lab <x@lalpathlabs.com>', subject: 'Report from 2024', at: clock - 400 * DAY, files: [{ name: 'old.pdf', type: 'application/pdf', bytes: pdf('old') }] },
  { id: 'm7', from: 'Clinic <desk@smallclinic.example>', subject: 'Scan report', at: clock - 5 * DAY, files: [{ name: 'USG_abdomen.pdf', type: 'application/pdf', bytes: pdf('usg'), inline: true }] },
];

function fakeGmail(mails: Mail[]) {
  const t = tokens('gmail-client-id', false);
  const state = { queries: [] as string[], attachmentCalls: 0, requests: [] as string[] };
  const app = new Hono();
  app.post('/token', t.handler);
  app.use('/gmail/*', async (c, next) => (t.authed(c) ? next() : c.json({ error: { code: 401 } }, 401)));
  app.get('/gmail/v1/users/me/messages', c => {
    const q = c.req.query('q')!;
    state.queries.push(q);
    const after = Number(/after:(\d+)/.exec(q)![1]) * 1000;
    // Gmail's search is broad: return every email with a PDF since then; the local rule decides.
    const hits = mails.filter(m => m.at >= after && m.files.some(f => f.name.endsWith('.pdf'))).sort((a, b) => b.at - a.at);
    const page = Number(c.req.query('pageToken') ?? 0);
    return c.json({ messages: hits.slice(page, page + 2).map(m => ({ id: m.id })), ...(page + 2 < hits.length ? { nextPageToken: String(page + 2) } : {}) });
  });
  app.get('/gmail/v1/users/me/messages/:id', c => {
    const m = mails.find(x => x.id === c.req.param('id'))!;
    const format = c.req.query('format');
    const fields = c.req.query('fields');
    const headers = [{ name: 'From', value: m.from }, { name: 'Subject', value: m.subject }];
    if (format === 'metadata') {
      state.requests.push(`${m.id}:metadata`);
      return c.json({ id: m.id, internalDate: String(m.at), payload: { headers } });
    }
    assert.equal(format, 'full');
    // Fresh attachment ids on every request, as Gmail does; an inline file carries its bytes in body.data.
    const parts = m.files.map((f, i) => ({ partId: String(i + 1), filename: f.name, mimeType: f.type,
      body: f.inline ? { size: f.bytes.length, data: f.bytes.toString('base64url') } : { attachmentId: `${m.id}-${i}-${Math.random().toString(36).slice(2)}`, size: f.bytes.length } }));
    const tree = { mimeType: 'multipart/mixed', headers, parts: [{ partId: '0', mimeType: 'text/plain', filename: '', body: { size: 10, data: 'aGk' } }, ...parts] };
    if (fields) {
      // Gmail's partial response: no body data anywhere.
      assert.ok(!fields.includes('data'), fields);
      state.requests.push(`${m.id}:parts`);
      const strip = (p: Record<string, unknown>): Record<string, unknown> => ({ ...p, headers: undefined, body: { ...(p.body as object), data: undefined }, ...(p.parts ? { parts: (p.parts as Record<string, unknown>[]).map(strip) } : {}) });
      return c.json({ id: m.id, payload: strip(tree) });
    }
    state.requests.push(`${m.id}:body`);
    return c.json({ id: m.id, internalDate: String(m.at), payload: tree });
  });
  app.get('/gmail/v1/users/me/messages/:id/attachments/:att', c => {
    state.attachmentCalls++;
    const [mid, i] = c.req.param('att').split('-');
    const f = mails.find(x => x.id === mid)!.files[Number(i)];
    return c.json({ size: f.bytes.length, data: f.bytes.toString('base64url') });
  });
  return { app, state, tokens: t.s };
}

function fakeGraph(mails: Mail[]) {
  const t = tokens('outlook-client-id', true);
  const state = { filters: [] as string[] };
  let base = '';
  const app = new Hono();
  app.post('/common/oauth2/v2.0/token', t.handler);
  app.use('/v1.0/*', async (c, next) => (t.authed(c) ? next() : c.json({ error: { code: 'InvalidAuthenticationToken' } }, 401)));
  app.get('/v1.0/me/messages', c => {
    const filter = c.req.query('$filter')!;
    state.filters.push(filter);
    assert.equal(c.req.query('$orderby'), 'receivedDateTime asc');
    const since = Date.parse(/receivedDateTime ge (\S+)/.exec(filter)![1]);
    const hits = mails.filter(m => m.at >= since).sort((a, b) => a.at - b.at);
    const skip = Number(c.req.query('$skip') ?? 0);
    const page = hits.slice(skip, skip + 2).map(m => ({ id: `AAMk-${m.id}`, subject: m.subject, receivedDateTime: new Date(m.at).toISOString(), from: { emailAddress: { address: /<([^>]+)>/.exec(m.from)?.[1] ?? m.from, name: 'x' } } }));
    const next = skip + 2 < hits.length ? `${base}/v1.0/me/messages?${new URLSearchParams({ $filter: filter, $orderby: 'receivedDateTime asc', $skip: String(skip + 2) })}` : undefined;
    return c.json({ value: page, ...(next ? { '@odata.nextLink': next } : {}) });
  });
  app.get('/v1.0/me/messages/:id/attachments', c => {
    const m = mails.find(x => `AAMk-${x.id}` === c.req.param('id'))!;
    return c.json({ value: [
      ...m.files.map((f, i) => ({ '@odata.type': '#microsoft.graph.fileAttachment', id: `att-${i}`, name: f.name, contentType: f.type, size: f.bytes.length, contentBytes: f.bytes.toString('base64') })),
      { '@odata.type': '#microsoft.graph.itemAttachment', id: 'att-item', name: 'Forwarded.pdf', contentType: 'application/pdf', size: 10 },
    ] });
  });
  return { app, state, tokens: t.s, setBase: (b: string) => { base = b; } };
}

let database: Database;
let filesDir: string;
const servers: ServerType[] = [];
async function host(app: Hono): Promise<string> {
  const s = await new Promise<ServerType>(resolve => { const x = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(x)); });
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
let gmail: ReturnType<typeof fakeGmail>;
let graph: ReturnType<typeof fakeGraph>;
let gmailUrl: string;
let graphUrl: string;

before(async () => {
  database = await openDatabase({ url: process.env.TEST_DATABASE_URL });
  await database.migrate(migrations);
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspond-mail-'));
  gmail = fakeGmail(MAILS);
  graph = fakeGraph(MAILS);
  gmailUrl = await host(gmail.app);
  graphUrl = await host(graph.app);
  graph.setBase(graphUrl);
});
after(async () => {
  for (const s of servers) s.close();
  await database?.close();
  fs.rmSync(filesDir, { recursive: true, force: true });
});

function setup(maxReports?: number) {
  const config = loadConfig({
    NODE_ENV: 'test', TRUST_PROXY: 'true', PUBLIC_URL: 'https://health.example',
    GMAIL_CLIENT_ID: 'gmail-client-id', GMAIL_CLIENT_SECRET: 'mail-secret-123', OUTLOOK_CLIENT_ID: 'outlook-client-id', OUTLOOK_CLIENT_SECRET: 'mail-secret-123',
  });
  const r = config.records!;
  const files = new DiskFileStore(filesDir);
  const cells = singleCell(database.db, files);
  const secrets = ephemeralSecrets();
  const now = () => clock;
  const agent = createRecordAgent({
    cells, secrets, config: r, browsers: localBrowsers(), selfUrl: 'http://127.0.0.1:1', maxBytes: config.maxUploadBytes, now, ...(maxReports ? { maxReports } : {}),
    apis: [
      gmailFetcher(r.gmail!, { apiUrl: gmailUrl, tokenUrl: `${gmailUrl}/token`, authorizeUrl: 'https://accounts.google.example/o/oauth2/v2/auth', now }),
      outlookFetcher(r.outlook!, { apiUrl: graphUrl, tokenUrl: `${graphUrl}/common/oauth2/v2.0/token`, authorizeUrl: 'https://login.microsoftonline.example/common/oauth2/v2.0/authorize', now }),
    ],
  });
  return { app: createApp({ db: database.db, files, config, cells, secrets, records: agent }), agent };
}

async function connect(app: ReturnType<typeof setup>['app'], agent: RecordAgent, c: TestClient, profileId: string, sourceId: string) {
  const r = await c.json<{ authorizeUrl?: string }>('POST', '/api/records/connections', { sourceId, profileId, refreshDays: 7, noticeVersion: RECORD_AGENT_NOTICE_VERSION }, 201);
  const auth = new URL(r.authorizeUrl!);
  const back = await app.request(`/records/oauth/${sourceId}/callback?state=${auth.searchParams.get('state')}&code=good-code`);
  assert.equal(back.status, 302, await back.text());
  await sleep(20);
  await agent.idle();
  const conn = (await c.json<RecordConnectionView[]>('GET', '/api/records/connections')).find(x => x.sourceId === sourceId)!;
  return { auth, conn };
}

async function checkNow(c: TestClient, agent: RecordAgent, id: string): Promise<RecordRunView> {
  const run = await c.json<RecordRunView>('POST', `/api/records/connections/${id}/run`, {}, 201);
  await agent.idle();
  return c.json<RecordRunView>('GET', `/api/records/runs/${run.id}`);
}

describe('email sources', { timeout: 60_000 }, () => {
  let app: ReturnType<typeof setup>['app'];
  let agent: RecordAgent;
  before(() => { ({ app, agent } = setup()); });
  after(() => agent.idle());

  test('only health emails, and only their report PDFs', () => {
    assert.ok(isHealthEmail('Thyrocare <reports@mail.thyrocare.com>', 'Hello'), 'a lab subdomain');
    assert.ok(isHealthEmail('ravi@example.com', 'Lab report for mom'));
    assert.ok(isHealthEmail('clinic@example.com', 'Discharge summary - Asha'));
    assert.ok(isHealthEmail('lab@example.com', 'Your reports are ready'));
    assert.ok(!isHealthEmail('boss@work.example', 'Expense report Q3'));
    for (const s of ['Scan report', 'Radiology report', 'Blood results', 'X-ray report', 'Health check-up report']) assert.ok(isHealthEmail('a@b.example', s), s);
    assert.ok(!isHealthEmail('a@b.example', 'Latest test of the app'));
    assert.ok(!isHealthEmail('news@notthyrocare.com', 'Offers'), 'not a lookalike domain');
    assert.ok(isRecordPdf('Report.PDF', 'application/octet-stream', 100, 1000));
    assert.ok(!isRecordPdf('Invoice_123.pdf', 'application/pdf', 100, 1000));
    assert.ok(!isRecordPdf('photo.jpg', 'image/jpeg', 100, 1000));
    assert.ok(!isRecordPdf('huge.pdf', 'application/pdf', 5000, 1000));
    assert.match(gmailQuery(Date.parse('2026-01-01T00:00:00Z')), /^has:attachment filename:pdf after:1767225600 \{from:lalpathlabs\.com OR /);
  });

  test('Gmail: offline access, the reports from a year of mail once, then only new mail; refresh keeps the token', async () => {
    const c = makeClient(app);
    const info = await c.json<SessionInfo>('POST', '/api/auth/register', registration(`gmail-${Date.now()}@example.com`), 201);
    assert.equal((await c.json<SourcesInfo>('GET', '/api/records')).sources.find(s => s.id === 'gmail')!.availability, 'api');
    const { auth, conn } = await connect(app, agent, c, info.profiles[0].id, 'gmail');
    assert.equal(auth.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.readonly');
    assert.equal(auth.searchParams.get('access_type'), 'offline');
    assert.equal(auth.searchParams.get('prompt'), 'consent');
    assert.equal(auth.searchParams.get('redirect_uri'), 'https://health.example/records/oauth/gmail/callback');

    const r = conn.lastRun!;
    assert.equal(r.status, 'succeeded', r.error ?? '');
    assert.deepEqual(r.documents.map(d => d.fileName).sort(), ['CBC.pdf', 'DL55012345.pdf', 'TC823411_Report.pdf', 'USG_abdomen.pdf'], 'no invoice, no order, no photo, nothing older than a year; the inline PDF too');
    assert.match(r.note ?? '', /1 of the reports are password-protected/);
    // Only headers decide; the part tree comes without body data; a body is fetched only for the inline PDF.
    assert.ok(gmail.state.requests.includes('m2:metadata') && !gmail.state.requests.some(x => x.startsWith('m2:') && x !== 'm2:metadata'), 'the order email is never opened further');
    assert.deepEqual(gmail.state.requests.filter(x => x.endsWith(':body')), ['m7:body']);
    assert.ok(gmail.state.queries[0].includes('"scan report"') && gmail.state.queries[0].includes('"blood results"'), 'the search covers every subject the rule accepts');
    assert.ok(gmail.state.queries[0].includes(`after:${Math.floor((clock - 365 * DAY) / 1000)}`));

    // Two hours later the token has run out: Google refreshes without a new refresh token, and the old one is kept.
    clock += 2 * 3600_000;
    MAILS.push({ id: 'm6', from: 'Metropolis <noreply@metropolisindia.com>', subject: 'Test report', at: clock - 3600_000, files: [{ name: 'Lipid.pdf', type: 'application/pdf', bytes: pdf('lipid') }] });
    const r2 = await checkNow(c, agent, conn.id);
    assert.equal(r2.status, 'succeeded', r2.error ?? '');
    assert.deepEqual(r2.documents.map(d => d.fileName), ['Lipid.pdf'], 'only the new email; the overlap day saves nothing twice');
    assert.ok(gmail.state.queries.at(-1)!.includes(`after:${Math.floor((clock - 2 * 3600_000 - DAY) / 1000)}`), 'from the last check, with a day of overlap');
    clock += 2 * 3600_000;
    assert.equal((await checkNow(c, agent, conn.id)).status, 'succeeded');
    assert.equal(gmail.tokens.refreshes.length, 2);
    assert.equal(gmail.tokens.refreshes[1].refresh_token, gmail.tokens.refreshes[0].refresh_token, 'the same refresh token, kept');
    MAILS.pop();
  });

  test('Outlook: Mail.Read, paging, file attachments only, and the rotated refresh token kept', async () => {
    const c = makeClient(app);
    const info = await c.json<SessionInfo>('POST', '/api/auth/register', registration(`outlook-${Date.now()}@example.com`), 201);
    const { auth, conn } = await connect(app, agent, c, info.profiles[0].id, 'outlook');
    assert.equal(auth.searchParams.get('scope'), 'offline_access Mail.Read');
    const r = conn.lastRun!;
    assert.equal(r.status, 'succeeded', r.error ?? '');
    assert.deepEqual(r.documents.map(d => d.fileName).sort(), ['CBC.pdf', 'DL55012345.pdf', 'TC823411_Report.pdf', 'USG_abdomen.pdf']);
    assert.match(graph.state.filters[0], /^receivedDateTime ge \S+ and hasAttachments eq true$/);

    clock += 2 * 3600_000;
    assert.equal((await checkNow(c, agent, conn.id)).saved, 0);
    clock += 2 * 3600_000;
    assert.equal((await checkNow(c, agent, conn.id)).status, 'succeeded');
    assert.equal(graph.tokens.refreshes.length, 2);
    assert.notEqual(graph.tokens.refreshes[1].refresh_token, graph.tokens.refreshes[0].refresh_token, 'the rotated refresh token was kept');
    assert.equal(graph.tokens.refreshes[0].scope, 'offline_access Mail.Read', 'Microsoft gets the scopes again');
  });

  test('a backlog larger than one check comes in over several checks, oldest first, nothing skipped', async () => {
    const small = setup(2);
    graph.tokens.codes.add('good-code');
    const c = makeClient(small.app);
    const info = await c.json<SessionInfo>('POST', '/api/auth/register', registration(`backlog-${Date.now()}@example.com`), 201);
    const { conn } = await connect(small.app, small.agent, c, info.profiles[0].id, 'outlook');
    const r1 = conn.lastRun!;
    assert.deepEqual(r1.documents.map(d => d.fileName), ['TC823411_Report.pdf', 'CBC.pdf'], 'the two oldest');
    assert.match(r1.note ?? '', /more emails to look at/);
    const r2 = await checkNow(c, small.agent, conn.id);
    assert.deepEqual(r2.documents.map(d => d.fileName), ['DL55012345.pdf', 'USG_abdomen.pdf']);
    const r3 = await checkNow(c, small.agent, conn.id);
    assert.equal(r3.saved, 0);
    assert.ok(!/more emails/.test(r3.note ?? ''));
    await small.agent.idle();
  });
});
