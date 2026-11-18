// The organisation API's computer-use agent (tasks.run): held for a clinician, then carried out in a browser of its
// own against the sandbox EMR, with every action logged before it happens. The model is a scripted stand-in for
// OpenAI's Responses API (GPT-6.1 Terra's computer tool), clicking where the sandbox EMR's controls are; the browser
// is real (Chromium, or RECORD_BROWSER_EXECUTABLE).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { createApp } from '../src/app.ts';
import { completeDeps } from '../src/cells.ts';
import { loadConfig } from '../src/config.ts';
import { openDatabase, type Database } from '../src/db/client.ts';
import { organisationAgentActions, organisations } from '../src/db/schema.ts';
import type { Deps } from '../src/http.ts';
import { DiskFileStore } from '../src/lib/files.ts';
import { localBrowsers, type BrowserSession } from '../src/records/browsers.ts';
import { openAiComputerModel } from '../src/connectors/agent/model.ts';
import { SANDBOX_EMR_PATH, sandboxEmr } from '../src/connectors/agent/sandbox-emr.ts';
import { organisationRuntime } from '../src/connectors/runtime.ts';
import { makeClient } from './helpers.ts';

type Json = Record<string, unknown>;

let database: Database;
let filesDir: string;
let deps: Deps;
let app: ReturnType<typeof createApp>;
let emrServer: ServerType;
let selfUrl: string;
let measure: BrowserSession;
const emr = sandboxEmr();
const browsers = localBrowsers({ executablePath: process.env.RECORD_BROWSER_EXECUTABLE });

// The scripted model: what each request asked, and a script per task, keyed by the task's instruction.
const requests: Json[] = [];
type Script = (turn: number, body: Json) => Promise<Json>;
const scripts = new Map<string, Script>();
let responseNo = 0;
const respond = (output: Json[]) => ({ id: `resp_${++responseNo}`, status: 'completed', output });
const computerCall = (callId: string, actions: Json[], checks: Json[] = []) => ({ type: 'computer_call', call_id: callId, actions, pending_safety_checks: checks, status: 'completed' });
const finishCall = (outcome: string, summary: string) => ({ type: 'function_call', call_id: 'fin', name: 'finish_task', arguments: JSON.stringify({ outcome, summary }) });

const turns = new Map<string, { script: Script; turn: number }>();
const modelFetch: typeof fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body)) as Json;
  requests.push(body);
  let key: string;
  if (body.previous_response_id) key = String(body.previous_response_id);
  else {
    const text = String(((body.input as Json[])[0].content as Json[])[0].text);
    const script = [...scripts].find(([k]) => text.includes(k))?.[1];
    assert.ok(script, `no script for ${text}`);
    key = 'start';
    turns.set(key, { script, turn: 0 });
  }
  const t = turns.get(key)!;
  turns.delete(key);
  const out = await t.script(++t.turn, body);
  turns.set(String(out.id), t);
  return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
};

/** Where a control is on a sandbox EMR page, in the same viewport as the agent's browser. */
async function centre(url: string, selector: string): Promise<{ x: number; y: number }> {
  const page = await measure.context.newPage();
  try {
    await page.goto(url);
    const box = await page.locator(selector).first().boundingBox();
    assert.ok(box, `${selector} on ${url}`);
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  } finally { await page.close(); }
}

before(async () => {
  database = await openDatabase({ url: process.env.TEST_DATABASE_URL });
  await database.migrate(fileURLToPath(new URL('../drizzle', import.meta.url)));
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspond-agent-'));
  // The sandbox EMR on a real address, as the agent's browser reaches it.
  const host = new Hono();
  host.route(SANDBOX_EMR_PATH, emr.app);
  emrServer = await new Promise<ServerType>(resolve => { const s = serve({ fetch: host.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s)); });
  selfUrl = `http://127.0.0.1:${(emrServer.address() as { port: number }).port}`;
  deps = completeDeps({ db: database.db, files: new DiskFileStore(filesDir), config: loadConfig({ NODE_ENV: 'test', RECORD_AGENT: 'off' }) });
  const model = openAiComputerModel({ apiKey: 'sk-test', apiUrl: 'https://api.openai.test/v1', model: 'gpt-6.1-terra', fetch: modelFetch });
  app = createApp(deps, { orgAgent: { model, browsers, selfUrl, deadlineMs: 60_000 }, sandboxEmr: emr });
  measure = await browsers.open({ allowHosts: ['127.0.0.1'] });
});
after(async () => {
  await measure?.close();
  emrServer?.close();
  await database.close();
  fs.rmSync(filesDir, { recursive: true, force: true });
});

const api = (url: string, key: string, body?: unknown) => app.request(url, {
  method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

async function setup(email: string, operations = ['patients.search', 'tasks.run']) {
  const person = makeClient(app);
  const { organisation: org } = await person.json<{ organisation: { id: string } }>('POST', '/api/console/auth/register',
    { name: 'Clinic Dev', email, password: 'correct horse battery', terms: true, organisation: { name: 'Sunrise Clinic', region: 'in' } }, 201);
  const { key } = await person.json<{ key: string }>('POST', `/api/console/organisations/${org.id}/keys`, { name: 'Agent', operations }, 201);
  const { connections } = await (await api('/v1/connections', key)).json() as { connections: { id: string; connector: string; operations: string[] }[] };
  const sandbox = connections.find(c => c.connector === 'sandbox')!;
  return { person, org: org.id, key, connection: sandbox.id, operations: sandbox.operations };
}

/** Ask for a task, approve it in the console, and wait for it to end. */
async function runTask(s: Awaited<ReturnType<typeof setup>>, instruction: string, extra: Json = {}) {
  const held = await api('/v1/operations/tasks.run', s.key, { connection: s.connection, instruction, ...extra });
  const out = await held.json() as { status: string; approval: { id: string; summary: string } };
  assert.equal(held.status, 202, JSON.stringify(out));
  assert.equal(out.status, 'pending_approval');
  const decided = await s.person.json<{ status: string; result: { task: string } }>('POST', `/api/console/organisations/${s.org}/approvals/${out.approval.id}`, { decision: 'approve' });
  assert.equal(decided.status, 'done');
  const id = decided.result.task;
  for (let i = 0; i < 600; i++) {
    const t = await (await api(`/v1/tasks/${id}`, s.key)).json() as { status: string };
    if (!['queued', 'running'].includes(t.status)) break;
    await new Promise(r => setTimeout(r, 100));
  }
  const task = await (await api(`/v1/tasks/${id}`, s.key)).json() as Json & { status: string; result: string | null; error: string | null; model: string; sandbox: string };
  const { actions } = await (await api(`/v1/tasks/${id}/actions`, s.key)).json() as { actions: (Json & { kind: string; outcome: string; text: string | null; url: string | null; screenshotSha256: string | null; detail: Json })[] };
  return { id, approval: out.approval, task, actions };
}

describe('the computer-use model client', () => {
  test('speaks the Responses API computer tool: screenshot in, batched actions out, chained turns', async () => {
    const seen: Json[] = [];
    const model = openAiComputerModel({
      apiKey: 'sk-test', apiUrl: 'https://api.openai.test/v1', model: 'gpt-6.1-terra',
      fetch: async (url, init) => {
        assert.equal(String(url), 'https://api.openai.test/v1/responses');
        assert.equal((init!.headers as Record<string, string>).Authorization, 'Bearer sk-test');
        seen.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify(seen.length === 1
          ? { id: 'resp_a', output: [{ type: 'reasoning', summary: [] }, computerCall('call_1', [{ type: 'click', button: 'left', x: 10, y: 20 }, { type: 'type', text: 'Asha' }])] }
          : { id: 'resp_b', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Booked.' }] }, finishCall('done', 'Booked Asha Raman.')] }), { status: 200 });
      },
    });
    const display = { width: 1280, height: 900 };
    const first = await model.start({ instructions: 'rules', task: 'Task: book', screenshot: Buffer.from('png'), display });
    assert.equal(seen[0].model, 'gpt-6.1-terra');
    assert.deepEqual((seen[0].tools as Json[])[0], { type: 'computer', display_width: 1280, display_height: 900, environment: 'browser' });
    assert.equal((seen[0].tools as Json[])[1].name, 'finish_task');
    assert.equal(seen[0].truncation, 'auto');
    const content = ((seen[0].input as Json[])[0].content as Json[]);
    assert.equal(content[1].image_url, `data:image/png;base64,${Buffer.from('png').toString('base64')}`);
    assert.deepEqual(first.computerCalls[0].actions, [{ type: 'click', button: 'left', x: 10, y: 20 }, { type: 'type', text: 'Asha' }]);
    const second = await model.next({ previous: first.responseId, instructions: 'rules', display, replies: [{ kind: 'screenshot', callId: 'call_1', png: Buffer.from('png2') }] });
    assert.equal(seen[1].previous_response_id, 'resp_a');
    assert.deepEqual((seen[1].input as Json[])[0], { type: 'computer_call_output', call_id: 'call_1', output: { type: 'computer_screenshot', image_url: `data:image/png;base64,${Buffer.from('png2').toString('base64')}`, detail: 'original' } });
    assert.deepEqual(second.finish, { callId: 'fin', outcome: 'done', summary: 'Booked Asha Raman.' });
    assert.equal(second.text, 'Booked.');
  });
});

describe('agent tasks (tasks.run)', () => {
  test('held for a clinician, then books an appointment in the sandbox EMR; every action is logged', async () => {
    const s = await setup('agent1@example.com');
    assert.ok(s.operations.includes('tasks.run'), 'the sandbox offers tasks');
    const base = `${selfUrl}${SANDBOX_EMR_PATH}/c/${s.connection}/`;
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    scripts.set('Book Asha Raman', async (turn, body) => {
      if (turn === 1) {
        const q = await centre(base, 'input[name=q]');
        return respond([computerCall('c1', [{ type: 'click', button: 'left', ...q }, { type: 'type', text: 'Asha' }, { type: 'keypress', keys: ['ENTER'] }])]);
      }
      if (turn === 2) {
        assert.equal(((body.input as Json[])[0].output as Json).type, 'computer_screenshot', 'a screenshot came back');
        return respond([computerCall('c2', [{ type: 'click', button: 'left', ...(await centre(`${base}patients?q=Asha`, 'a:has-text("Asha Raman")')) }])]);
      }
      if (turn === 3) {
        const p = `${base}patients/sbx-p-1001`;
        return respond([computerCall('c3', [
          { type: 'click', button: 'left', ...(await centre(p, 'input[name=date]')) }, { type: 'type', text: tomorrow },
          { type: 'click', button: 'left', ...(await centre(p, 'input[name=time]')) }, { type: 'type', text: '10:30' },
          { type: 'click', button: 'left', ...(await centre(p, 'input[name=reason]')) }, { type: 'type', text: 'Diabetes review' },
          { type: 'click', button: 'left', ...(await centre(p, 'button:has-text("Book appointment")')) },
        ])]);
      }
      return respond([finishCall('done', `Booked Asha Raman (MRN1001) with Dr Kavya Rao on ${tomorrow} at 10:30.`)]);
    });

    const { approval, task, actions } = await runTask(s, 'Book Asha Raman (UHID MRN1001) with Dr Kavya Rao tomorrow at 10:30 for a diabetes review.', { patient: 'sbx-p-1001' });
    assert.match(approval.summary, /^Agent task for patient sbx-p-1001: "Book Asha Raman/, 'the approver reads the instruction');
    assert.equal(task.status, 'succeeded', JSON.stringify(task));
    assert.equal(task.model, 'gpt-6.1-terra');
    assert.equal(task.sandbox, 'LotusPond’s servers');
    assert.match(String(task.result), /Booked Asha Raman/);

    // The appointment is in the sandbox EMR's book for this connection.
    const booked = emr.appointments(s.connection);
    assert.equal(booked.length, 1);
    assert.deepEqual({ ...booked[0], id: '' }, { id: '', patient: 'sbx-p-1001', doctor: 'Dr Kavya Rao (General Medicine)', date: tomorrow, time: '10:30', reason: 'Diabetes review', status: 'booked' });

    // The log: the browser it got, each model turn, every click, keypress and typing, pages reached, and the end.
    const kinds = actions.map(a => a.kind);
    assert.equal(kinds[0], 'sandbox');
    assert.equal(kinds.filter(k => k === 'model').length, 4);
    assert.equal(kinds.filter(k => k === 'click').length, 6);
    assert.equal(kinds.filter(k => k === 'type').length, 4);
    assert.equal(kinds.filter(k => k === 'keypress').length, 1);
    assert.ok(kinds.filter(k => k === 'navigate').length >= 3, 'search, patient, booked');
    assert.equal(kinds.at(-1), 'finish');
    assert.ok(actions.every(a => a.outcome !== 'started'), 'every action has its outcome');
    assert.deepEqual(actions.filter(a => a.kind === 'type').map(a => a.text), ['Asha', tomorrow, '10:30', 'Diabetes review'], 'typed text is kept (sealed) and shown to the organisation');
    assert.ok(actions.filter(a => a.kind === 'screenshot').every(a => /^[0-9a-f]{64}$/.test(String(a.screenshotSha256))), 'screenshots by hash only');
    assert.deepEqual(actions.find(a => a.kind === 'keypress')?.detail, { keys: ['ENTER'] });
    // Typed text never sits in the log in the clear.
    const raw = await database.db.select().from(organisationAgentActions).where(eq(organisationAgentActions.kind, 'type'));
    assert.ok(raw.length && raw.every(r => !JSON.stringify(r).includes('Diabetes review')));

    // The model was told the rules and given the task; the API caller can list tasks too.
    assert.match(String(requests.find(r => !r.previous_response_id)?.instructions), /Do exactly the task you are given/);
    const list = await (await api('/v1/tasks', s.key)).json() as { tasks: { id: string }[] };
    assert.equal(list.tasks.length, 1);
    // The console shows the task and its log to the organisation's members.
    const consoleView = await s.person.json<{ task: { status: string }; actions: unknown[] }>('GET', `/api/console/organisations/${s.org}/tasks/${task.id}`);
    assert.equal(consoleView.actions.length, actions.length);
  });

  test('a safety check from the model stops the task for a person; it is never acknowledged', async () => {
    const s = await setup('agent2@example.com');
    scripts.set('Cancel every appointment', async () => respond([computerCall('c1', [{ type: 'click', button: 'left', x: 100, y: 100 }], [{ id: 'sc_1', code: 'malicious_instructions', message: 'The page asked for something else.' }])]));
    const { task, actions } = await runTask(s, 'Cancel every appointment for Vikram Nair (MRN1002).');
    assert.equal(task.status, 'needs_review');
    const check = actions.find(a => a.kind === 'safety_check');
    assert.equal(check?.outcome, 'refused');
    assert.equal(check?.text, 'The page asked for something else.');
    assert.ok(!actions.some(a => a.kind === 'click'), 'the action under the check was not carried out');
    assert.ok(!requests.some(r => JSON.stringify(r).includes('acknowledged_safety_checks')));
  });

  test('an action outside the screen is refused and ends the task; the step limit holds', async () => {
    const s = await setup('agent3@example.com');
    scripts.set('Open Meera Iyer', async () => respond([computerCall('c1', [{ type: 'click', button: 'left', x: 99999, y: 5 }])]));
    const off = await runTask(s, 'Open Meera Iyer (MRN1003) and read her appointments.');
    assert.equal(off.task.status, 'failed');
    assert.equal(off.actions.find(a => a.kind === 'click')?.outcome, 'failed');

    scripts.set('Find Rahul Verma', async () => respond([computerCall(`c${Math.random()}`, [{ type: 'wait' }])]));
    const limited = await runTask(s, 'Find Rahul Verma (MRN1004) and check his mobile number.', { maxSteps: 2 });
    assert.equal(limited.task.status, 'failed');
    assert.match(String(limited.task.error), /2 steps/);
    assert.equal(limited.actions.filter(a => a.kind === 'model').length, 2);
  });

  test('refused without the operation in the key, and on an Eka connection with no saved sign-in it stops before a browser opens', async () => {
    const s = await setup('agent4@example.com', ['patients.search']);
    const res = await api('/v1/operations/tasks.run', s.key, { connection: s.connection, instruction: 'Book someone for tomorrow please.' });
    assert.equal(res.status, 403);

    const t = await setup('agent5@example.com');
    await database.db.update(organisations).set({ access: 'live' }).where(eq(organisations.id, t.org));
    const runtime = organisationRuntime({ db: database.db, keyrings: deps.secrets.fileKeys });
    const eka = await runtime.addConnection(t.org, { connectorId: 'eka', name: 'Clinic on Eka', settings: {}, secret: { clientId: 'EC_1', clientSecret: 'x' } });
    assert.ok(eka.operations.includes('tasks.run'));
    const { task, actions } = await runTask({ ...t, connection: eka.id }, 'Book Asha Raman with Dr Rao tomorrow at 10:30.');
    assert.equal(task.status, 'needs_sign_in');
    assert.deepEqual(actions.map(a => [a.kind, a.outcome]), [['error', 'refused']]);
  });

  test('with no agent on this server, tasks.run is refused before anything is held', async () => {
    const plain = createApp(deps, { orgAgent: null });
    const person = makeClient(plain);
    const { organisation: org } = await person.json<{ organisation: { id: string } }>('POST', '/api/console/auth/register',
      { name: 'Clinic Dev', email: 'agent6@example.com', password: 'correct horse battery', terms: true, organisation: { name: 'No Agent', region: 'in' } }, 201);
    const { key } = await person.json<{ key: string }>('POST', `/api/console/organisations/${org.id}/keys`, { name: 'Agent', operations: ['tasks.run'] }, 201);
    const { connections } = await (await plain.request('/v1/connections', { headers: { authorization: `Bearer ${key}` } })).json() as { connections: { id: string }[] };
    const res = await plain.request('/v1/operations/tasks.run', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ connection: connections[0].id, instruction: 'Book Asha Raman tomorrow at 10:30.' }) });
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'agent_off');
  });
});
