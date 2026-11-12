// The record agent end to end: a real Chromium (Playwright) signs in to the demo portal with the person's answers,
// downloads the reports and saves the new ones to the files; checking again saves only new reports; scheduled runs
// never ask and mark the connection when the sign-in has expired. The navigator (Claude) is driven by scripted turns.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import Anthropic from '@anthropic-ai/sdk';
import { Hono } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { DEMO_SOURCE_ID, RECORD_AGENT_NOTICE_VERSION, type RecordConnectionView, type RecordRunView, type SourcesInfo } from '../../shared/sources.ts';
import type { NotificationList } from '../../shared/notifications.ts';
import type { ConsentRecord, ProfileRecords, SessionInfo } from '../../shared/types.ts';
import { createApp } from '../src/app.ts';
import { singleCell } from '../src/cells.ts';
import { loadConfig } from '../src/config.ts';
import { ephemeralSecrets } from '../src/compliance/secrets.ts';
import { openDatabase, type Database } from '../src/db/client.ts';
import { recordConnections } from '../src/db/schema.ts';
import { DiskFileStore } from '../src/lib/files.ts';
import { localBrowsers, hostAllowed } from '../src/records/browsers.ts';
import { DEMO_OTP, DEMO_PORTAL_PATH, demoPortal, type DemoPortal } from '../src/records/demo-portal.ts';
import { navigatorRecipe } from '../src/records/navigator.ts';
import { RecipeDriftError } from '../src/records/recipes/kit.ts';
import { createRecordAgent, type RecordAgent } from '../src/records/service.ts';
import { makeClient, registration, type TestClient } from './helpers.ts';

const migrations = fileURLToPath(new URL('../drizzle', import.meta.url));
let database: Database;
let filesDir: string;
let portal: DemoPortal;
let portalServer: ServerType;
let selfUrl: string;
let clock = Date.now();

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

before(async () => {
  database = await openDatabase({ url: process.env.TEST_DATABASE_URL });
  await database.migrate(migrations);
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspond-records-'));
  portal = demoPortal();
  const site = new Hono().route(DEMO_PORTAL_PATH, portal.app);
  portalServer = await new Promise<ServerType>(resolve => {
    const s = serve({ fetch: site.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
  });
  selfUrl = `http://127.0.0.1:${(portalServer.address() as AddressInfo).port}`;
});
after(async () => {
  portalServer?.close();
  await database?.close();
  fs.rmSync(filesDir, { recursive: true, force: true });
});

function setup(extra: Partial<Parameters<typeof createRecordAgent>[0]> = {}) {
  const config = loadConfig({ NODE_ENV: 'test', TRUST_PROXY: 'true' });
  const files = new DiskFileStore(filesDir);
  const cells = singleCell(database.db, files);
  const secrets = ephemeralSecrets();
  const agent = createRecordAgent({
    cells, secrets, config: config.records!, browsers: localBrowsers(), selfUrl, maxBytes: config.maxUploadBytes,
    questionMs: 20_000, now: () => clock, ...extra,
  });
  const app = createApp({ db: database.db, files, config, cells, secrets, records: agent });
  return { app, agent };
}

let k = 0;
async function account(app: ReturnType<typeof setup>['app']) {
  const c = makeClient(app);
  const info = await c.json<SessionInfo>('POST', '/api/auth/register', registration(`records-${Date.now()}-${++k}@example.com`), 201);
  return { c, self: info.profiles[0] };
}

async function until(c: TestClient, runId: string, ok: (r: RecordRunView) => boolean, what: string): Promise<RecordRunView> {
  const end = Date.now() + 60_000;
  let r: RecordRunView;
  do {
    r = await c.json<RecordRunView>('GET', `/api/records/runs/${runId}`);
    if (ok(r)) return r;
    if (['succeeded', 'failed', 'cancelled'].includes(r.status) && !ok(r)) assert.fail(`run ended ${r.status} (${r.error}) while waiting for ${what}`);
    await sleep(100);
  } while (Date.now() < end);
  assert.fail(`timed out waiting for ${what}; last: ${JSON.stringify(r)}`);
}

describe('record agent', { timeout: 180_000 }, () => {
  let app: ReturnType<typeof setup>['app'];
  let agent: RecordAgent;
  before(() => { ({ app, agent } = setup()); });
  after(() => agent.idle());

  test('browsers reach only the portal’s hosts', () => {
    assert.ok(hostAllowed('https://www.lalpathlabs.com/report/1', ['lalpathlabs.com']));
    assert.ok(hostAllowed('https://lalpathlabs.com/', ['lalpathlabs.com']));
    assert.ok(!hostAllowed('https://evil-lalpathlabs.com/', ['lalpathlabs.com']));
    assert.ok(!hostAllowed('https://lalpathlabs.com.evil.example/', ['lalpathlabs.com']));
    assert.ok(!hostAllowed('file:///etc/passwd', ['lalpathlabs.com']));
    assert.ok(hostAllowed('data:text/plain,hi', ['lalpathlabs.com']));
    // A path entry: that sign-in service only, not the rest of the shared host.
    const apollo = ['apollo247.com', 'www.googleapis.com/identitytoolkit/'];
    assert.ok(hostAllowed('https://www.googleapis.com/identitytoolkit/v3/relyingparty/verifyCustomToken?key=x', apollo));
    assert.ok(!hostAllowed('https://www.googleapis.com/upload/storage/v1/b/x/o', apollo));
    assert.ok(!hostAllowed('https://evil.www.googleapis.com/identitytoolkit/v3', apollo));
    assert.ok(!hostAllowed('http://www.googleapis.com/identitytoolkit/v3', apollo));
  });

  test('lists the sources, with the demo portal and what each can do', async () => {
    const { c } = await account(app);
    const info = await c.json<SourcesInfo>('GET', '/api/records');
    assert.equal(info.enabled, true);
    assert.equal(info.browser, 'LotusPond’s servers');
    const demo = info.sources.find(s => s.id === DEMO_SOURCE_ID)!;
    assert.equal(demo.availability, 'recipe');
    // Dr Lal, Thyrocare, Metropolis and Apollo 24|7 have recipes; without Claude, portals without one are not offered
    // yet; ABDM and APIs never through the browser.
    for (const id of ['drlal', 'thyrocare', 'metropolis', 'apollo']) assert.equal(info.sources.find(s => s.id === id)!.availability, 'recipe', id);
    assert.equal(info.sources.find(s => s.id === 'redcliffe')!.availability, 'unavailable');
    assert.equal(info.sources.find(s => s.id === 'abha')!.availability, 'unavailable');
    assert.ok(info.sources.find(s => s.id === 'other-lab')!.needsUrl);
    assert.ok(info.sources.length > 40);
  });

  test('signs in with the person’s answers, saves each report once, and checks again without asking', async () => {
    const { c, self } = await account(app);
    assert.equal((await c.error('POST', '/api/records/connections', { sourceId: DEMO_SOURCE_ID, profileId: self.id, noticeVersion: 'old' })).code, 'notice_outdated');
    assert.equal((await c.error('POST', '/api/records/connections', { sourceId: 'redcliffe', profileId: self.id, noticeVersion: RECORD_AGENT_NOTICE_VERSION })).code, 'source_unavailable');

    const made = await c.json<{ connection: RecordConnectionView; run: RecordRunView }>('POST', '/api/records/connections', {
      sourceId: DEMO_SOURCE_ID, profileId: self.id, refreshDays: 30, noticeVersion: RECORD_AGENT_NOTICE_VERSION,
    }, 201);
    const runId = made.run.id;
    const phone = await until(c, runId, r => r.status === 'waiting', 'the phone question');
    assert.equal(phone.question?.kind, 'phone');
    assert.equal((await c.error('POST', `/api/records/runs/${runId}/answer`, { answer: '' })).status, 400);
    await c.json('POST', `/api/records/runs/${runId}/answer`, { answer: '98765 43210' });
    const otp = await until(c, runId, r => r.status === 'waiting' && r.question?.kind === 'otp', 'the code question');
    assert.match(otp.question!.hint!, new RegExp(DEMO_OTP));
    await c.json('POST', `/api/records/runs/${runId}/answer`, { answer: '000000' });
    const again = await until(c, runId, r => r.status === 'waiting' && /not accepted/.test(r.question?.label ?? ''), 'a second code question');
    assert.equal(again.question?.kind, 'otp');
    await c.json('POST', `/api/records/runs/${runId}/answer`, { answer: DEMO_OTP });
    const done = await until(c, runId, r => r.status === 'succeeded', 'success');
    assert.equal(done.found, 3);
    assert.equal(done.saved, 3);
    assert.equal(done.documents.length, 3);
    assert.ok(done.documents.every(d => /^Demo Lab .+\.pdf$/.test(d.fileName)));
    assert.deepEqual(portal.signIns.at(-1), '9876543210');
    // Answering a finished run is refused.
    assert.equal((await c.error('POST', `/api/records/runs/${runId}/answer`, { answer: DEMO_OTP })).code, 'not_waiting');

    const records = await c.json<ProfileRecords>('GET', `/api/profiles/${self.id}/records`);
    const reports = records.documents.filter(d => done.documents.some(x => x.id === d.id));
    assert.equal(reports.length, 3);
    assert.ok(reports.every(d => d.kind === 'report' && d.contentType === 'application/pdf'));
    const pdf = await c.call('GET', `/api/profiles/${self.id}/documents/${reports[0].id}/file`);
    assert.equal(pdf.status, 200);
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
    const bell = await c.json<NotificationList>('GET', '/api/notifications');
    assert.equal(bell.items.filter(n => n.agentName === 'Record agent · Demo Lab portal (simulated)').length, 3);

    const [conn] = await c.json<RecordConnectionView[]>('GET', '/api/records/connections');
    assert.equal(conn.signedIn, true);
    assert.equal(conn.identifier, '••••• •3210');
    assert.equal(conn.reportsSaved, 3);
    assert.ok(conn.nextRunAt);
    const consents = await c.json<ConsentRecord[]>('GET', '/api/auth/consents');
    assert.ok(consents.some(r => r.kind === 'record_agent' && r.granted && r.detail?.source === DEMO_SOURCE_ID));

    // Check now: the kept sign-in works, nothing is asked, nothing is saved twice.
    const second = await c.json<RecordRunView>('POST', `/api/records/connections/${conn.id}/run`, undefined, 201);
    const secondDone = await until(c, second.id, r => r.status === 'succeeded' || r.status === 'waiting', 'the second run');
    assert.equal(secondDone.status, 'succeeded', 'the kept sign-in should not need a question');
    assert.equal(secondDone.found, 3);
    assert.equal(secondDone.saved, 0);

    // A new report on the portal, and the schedule comes round: only the new one is saved.
    portal.addReport({ id: 'DL-24-1400', title: 'Kidney function', date: '2026-11-01', panels: [{ title: 'KIDNEY FUNCTION', rows: [{ name: 'Creatinine', value: '1.1', unit: 'mg/dL', range: '0.7 - 1.3', flag: '' }] }] });
    clock += 31 * 24 * 60 * 60_000;
    await agent.tick();
    await agent.idle();
    const [after1] = await c.json<RecordConnectionView[]>('GET', '/api/records/connections');
    assert.equal(after1.lastRun?.trigger, 'schedule');
    assert.equal(after1.lastRun?.status, 'succeeded');
    assert.equal(after1.lastRun?.saved, 1);
    assert.equal(after1.reportsSaved, 4);

    // The kept sign-in stops working: a scheduled run never asks, and the connection waits for the person.
    await database.db.update(recordConnections).set({ sessionCt: Buffer.from('gone').toString('base64'), nextRunAt: new Date(clock - 1000) }).where(eq(recordConnections.id, conn.id));
    await agent.tick();
    await agent.idle();
    const [after2] = await c.json<RecordConnectionView[]>('GET', '/api/records/connections');
    assert.equal(after2.status, 'needs_sign_in');
    assert.equal(after2.lastRun?.status, 'failed');
    assert.match(after2.lastRun?.error ?? '', /sign in again/);
    assert.equal(after2.nextRunAt, null);

    // A connected agent sees where the records come from (with the list of files shared), not otherwise.
    const callTool = async (token: string, name: string) => {
      const res = await app.request('/mcp', {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }),
      });
      return (await res.json()) as { result?: { isError?: boolean; structuredContent?: any }; error?: { code: number } };
    };
    const withFiles = await c.json<{ token: string }>('POST', '/api/agents/tokens', { name: 'My agent', scopes: ['health:read'], categories: ['files'], profileIds: [self.id], expiresInDays: 7 }, 201);
    const listed = (await callTool(withFiles.token, 'list_record_sources')).result!.structuredContent;
    assert.equal(listed.sources.length, 1);
    assert.equal(listed.sources[0].source, 'Demo Lab portal (simulated)');
    assert.equal(listed.sources[0].reportsBroughtIn, 4);
    assert.equal(listed.sources[0].status, 'needs the person to sign in again');
    const noFiles = await c.json<{ token: string }>('POST', '/api/agents/tokens', { name: 'Other agent', scopes: ['health:read'], categories: ['results'], profileIds: [self.id], expiresInDays: 7 }, 201);
    assert.equal((await callTool(noFiles.token, 'list_record_sources')).error?.code, -32602, 'not offered without the list of files');

    // Disconnecting forgets the sign-in; the saved reports stay in the files.
    assert.equal((await c.call('DELETE', `/api/records/connections/${conn.id}`)).status, 204);
    assert.deepEqual(await c.json('GET', '/api/records/connections'), []);
    const kept = await c.json<ProfileRecords>('GET', `/api/profiles/${self.id}/records`);
    assert.equal(kept.documents.length, 4);
    const consents2 = await c.json<ConsentRecord[]>('GET', '/api/auth/consents');
    assert.equal(consents2.find(r => r.kind === 'record_agent')?.granted, false);
  });

  test('a run can be cancelled while it waits, and only its owner sees it', async () => {
    const { c, self } = await account(app);
    const made = await c.json<{ run: RecordRunView }>('POST', '/api/records/connections', { sourceId: DEMO_SOURCE_ID, profileId: self.id, noticeVersion: RECORD_AGENT_NOTICE_VERSION }, 201);
    await until(c, made.run.id, r => r.status === 'waiting', 'a question');
    const other = await account(app);
    assert.equal((await other.c.error('GET', `/api/records/runs/${made.run.id}`)).status, 404);
    assert.equal((await other.c.error('POST', `/api/records/runs/${made.run.id}/answer`, { answer: '9876543210' })).status, 404);
    const cancelled = await c.json<RecordRunView>('POST', `/api/records/runs/${made.run.id}/cancel`);
    assert.equal(cancelled.status, 'cancelled');
    await agent.idle();
    assert.equal((await c.json<RecordRunView>('GET', `/api/records/runs/${made.run.id}`)).status, 'cancelled');
  });

  test('a recipe that no longer matches its portal tells the person, without Claude to take over', async () => {
    const drifted = setup({ recipes: [{ sourceId: DEMO_SOURCE_ID, run: async () => { throw new RecipeDriftError('no login button'); } }] });
    const { c, self } = await account(drifted.app);
    const made = await c.json<{ run: RecordRunView }>('POST', '/api/records/connections', { sourceId: DEMO_SOURCE_ID, profileId: self.id, noticeVersion: RECORD_AGENT_NOTICE_VERSION }, 201);
    await drifted.agent.idle();
    const r = await c.json<RecordRunView>('GET', `/api/records/runs/${made.run.id}`);
    assert.equal(r.status, 'failed');
    assert.match(r.error ?? '', /has changed its website/);
  });

  test('two reports with the same name are both saved, the second numbered', async () => {
    const pdf = (s: string) => new Uint8Array(Buffer.from(`%PDF-1.4\n% ${s}\n%%EOF\n`));
    const twins = setup({ recipes: [{ sourceId: DEMO_SOURCE_ID, run: async () => [1, 2, 3].map(i => ({
      key: `twin-${i}`, title: 'Lab Report', date: '2026-09-01', fileName: 'Lab Report SL NIZAMABAD 2026-09-01.pdf', contentType: 'application/pdf', bytes: pdf(`report ${i}`),
    })) }] });
    const { c, self } = await account(twins.app);
    const made = await c.json<{ run: RecordRunView }>('POST', '/api/records/connections', { sourceId: DEMO_SOURCE_ID, profileId: self.id, noticeVersion: RECORD_AGENT_NOTICE_VERSION }, 201);
    await twins.agent.idle();
    const r = await c.json<RecordRunView>('GET', `/api/records/runs/${made.run.id}`);
    assert.equal(r.saved, 3, r.error ?? '');
    assert.deepEqual(r.documents.map(d => d.fileName), ['Lab Report SL NIZAMABAD 2026-09-01.pdf', 'Lab Report SL NIZAMABAD 2026-09-01 (2).pdf', 'Lab Report SL NIZAMABAD 2026-09-01 (3).pdf']);
  });

  test('portal addresses must be public https sites', async () => {
    const withClaude = setup({ navigator: { client: new Anthropic({ apiKey: 'sk-ant-test' }) }, resolve: async h => (h === 'reports.example-lab.in' ? ['203.0.113.10'] : h === 'sneaky.example' ? ['10.0.0.5'] : []) });
    const { c, self } = await account(withClaude.app);
    const post = (portalUrl: string | undefined) => c.error('POST', '/api/records/connections', { sourceId: 'other-lab', profileId: self.id, portalUrl, noticeVersion: RECORD_AGENT_NOTICE_VERSION });
    assert.equal((await post(undefined)).code, 'portal_url_required');
    for (const bad of ['http://reports.example-lab.in', 'https://127.0.0.1/', 'https://localhost/', 'https://sneaky.example/', 'https://nowhere.example/', 'not a url']) {
      assert.equal((await post(bad)).code, 'invalid_portal', bad);
    }
  });
});

describe('the navigator', { timeout: 180_000 }, () => {
  test('finds its way through a portal with the person, without seeing what they type', async () => {
    const turns: { name: string; input: unknown }[][] = [
      [{ name: 'look', input: {} }],
      [{ name: 'fill_from_person', input: { ref: 'e1', kind: 'phone', label: 'Mobile number registered with this lab' } }, { name: 'click', input: { ref: 'e2' } }],
      [{ name: 'look', input: {} }],
      [{ name: 'fill_from_person', input: { ref: 'e1', kind: 'otp', label: 'Code the lab sent to your phone' } }, { name: 'click', input: { ref: 'e2' } }],
      [{ name: 'look', input: {} }],
      [{ name: 'go_to', input: { url: 'https://evil.example/steal' } }],
      [
        { name: 'save_report', input: { ref: 'e1', title: 'Kidney function', date: '2026-11-01' } },
        { name: 'save_report', input: { ref: 'e2', title: 'Thyroid profile', date: '2026-09-21' } },
        { name: 'save_report', input: { ref: 'e2', title: 'Thyroid profile', date: '2026-09-21' } },
      ],
      [{ name: 'finish', input: { outcome: 'done', message: 'Saved 2 reports.' } }],
    ];
    const bodies: string[] = [];
    let n = 0;
    const client = new Anthropic({
      apiKey: 'sk-ant-test', maxRetries: 0,
      fetch: (async (_url: string | URL, init?: RequestInit) => {
        bodies.push(String(init?.body));
        const tools = turns.shift() ?? [{ name: 'finish', input: { outcome: 'done', message: '' } }];
        n++;
        return Response.json({
          id: `msg_${n}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'tool_use', stop_sequence: null,
          content: tools.map((t, i) => ({ type: 'tool_use', id: `toolu_${n}_${i}`, name: t.name, input: t.input })),
          usage: { input_tokens: 10, output_tokens: 10 },
        });
      }) as typeof fetch,
    });
    const { app, agent } = setup({ recipes: [navigatorRecipe(DEMO_SOURCE_ID, { client })] });
    const { c, self } = await account(app);
    const made = await c.json<{ run: RecordRunView }>('POST', '/api/records/connections', { sourceId: DEMO_SOURCE_ID, profileId: self.id, noticeVersion: RECORD_AGENT_NOTICE_VERSION }, 201);
    const q1 = await until(c, made.run.id, r => r.status === 'waiting', 'the phone question');
    assert.equal(q1.question?.label, 'Mobile number registered with this lab');
    await c.json('POST', `/api/records/runs/${made.run.id}/answer`, { answer: '9123456789' });
    await until(c, made.run.id, r => r.status === 'waiting' && r.question?.kind === 'otp', 'the code question');
    await c.json('POST', `/api/records/runs/${made.run.id}/answer`, { answer: DEMO_OTP });
    const done = await until(c, made.run.id, r => r.status === 'succeeded', 'success');
    await agent.idle();
    assert.equal(done.saved, 2, 'the same file twice is saved once');
    const all = bodies.join('\n');
    assert.ok(!all.includes('9123456789') && !all.includes(DEMO_OTP), 'the model never sees what the person typed');
    assert.match(all, /Refused: that address is not on this portal/);
    assert.match(all, /<page_text>/);
  });
});
