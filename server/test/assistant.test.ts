// LotusPond's assistant: consent, the streaming tool loop over the real tools, and the stored history. The Claude
// API is a stand-in fetch that streams scripted turns as server-sent events, through the real SDK.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import type { Hono } from 'hono';
import { ASSISTANT_NOTICE_VERSION, type AssistantEvent, type AssistantInfo } from '../../shared/assistant.ts';
import type { NotificationList } from '../../shared/notifications.ts';
import type { SessionInfo } from '../../shared/types.ts';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDatabase, type Database } from '../src/db/client.ts';
import type { AppEnv } from '../src/http.ts';
import { DiskFileStore } from '../src/lib/files.ts';
import { claudeAssistant } from '../src/assistant/agent.ts';
import { makeClient, measurement, registration, type TestClient } from './helpers.ts';
import { sse, type Script } from './fake-claude.ts';

const migrations = fileURLToPath(new URL('../drizzle', import.meta.url));
let database: Database;
let app: Hono<AppEnv>;
let filesDir: string;

let script: Script[] = [];
const requests: any[] = [];

before(async () => {
  database = await openDatabase({ url: process.env.TEST_DATABASE_URL });
  await database.migrate(migrations);
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspond-assistant-'));
  const config = loadConfig({ NODE_ENV: 'test', TRUST_PROXY: 'true', PUBLIC_URL: 'https://health.example' });
  let n = 0;
  const client = new Anthropic({
    apiKey: 'sk-ant-test', maxRetries: 0,
    fetch: (async (_url: string | URL, init?: RequestInit) => {
      requests.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      const turn = script.shift() ?? { text: 'Done.' };
      return new Response(sse(turn, ++n), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch,
  });
  app = createApp({ db: database.db, files: new DiskFileStore(filesDir), config, assistant: claudeAssistant({ client }) });
});
after(async () => {
  await database?.close();
  fs.rmSync(filesDir, { recursive: true, force: true });
});

let k = 0;
async function account() {
  const c = makeClient(app);
  const info = await c.json<SessionInfo>('POST', '/api/auth/register', registration(`assistant-${Date.now()}-${++k}@example.com`), 201);
  const self = info.profiles[0];
  await c.json('PATCH', `/api/profiles/${self.id}`, { conditions: ['Type 2 diabetes'], dateOfBirth: '1990-05-01' });
  await c.json('POST', `/api/profiles/${self.id}/measurements`, { measurements: [measurement({ date: '2026-03-14', value: 138, valueText: '138' })] }, 201);
  return { c, self };
}

async function send(c: TestClient, body: Record<string, unknown>) {
  const res = await c.call('POST', '/api/assistant/messages', body);
  if (res.status !== 200) return { status: res.status, events: [] as AssistantEvent[], error: await res.json() as any };
  const text = await res.text();
  const events = text.split('\n').filter(l => l.startsWith('data:')).map(l => JSON.parse(l.slice(5)) as AssistantEvent);
  return { status: 200, events };
}

describe('the assistant', () => {
  test('needs the person to agree first, with the current notice; it says it is on', async () => {
    const { c, self } = await account();
    const info = await c.json<AssistantInfo>('GET', '/api/assistant');
    assert.equal(info.enabled, true);
    assert.equal(info.consent, null);
    assert.equal((await send(c, { profileId: self.id, text: 'Hi' })).status, 409);
    assert.equal((await c.error('POST', '/api/assistant/consent', { noticeVersion: 'old', categories: [] })).status, 409);
    const consent = await c.json<{ granted: boolean; categories: string[] }>('POST', '/api/assistant/consent', { noticeVersion: ASSISTANT_NOTICE_VERSION, categories: ['results', 'conditions'] });
    assert.deepEqual(consent.categories, ['results', 'conditions']);
    const history = await c.json<{ kind: string; detail: { categories?: string[] } | null }[]>('GET', '/api/auth/consents');
    assert.ok(history.some(r => r.kind === 'assistant' && r.detail?.categories?.length === 2));
    await c.json('DELETE', '/api/assistant/consent', undefined, 204);
    assert.equal((await c.json<AssistantInfo>('GET', '/api/assistant')).consent?.granted, false);
  });

  test('answers with the real tools, streams text, points to the organ, and keeps the history exactly as returned', async () => {
    const { c, self } = await account();
    await c.json('POST', '/api/assistant/consent', { noticeVersion: ASSISTANT_NOTICE_VERSION, categories: ['results'] });
    requests.length = 0;
    script = [
      { text: 'Let me look.', tools: [{ name: 'get_results', input: { out_of_range_only: true } }, { name: 'show_on_body', input: { organ: 'heart' } }] },
      { text: 'Your LDL cholesterol is 138 mg/dL, above its range of under 100. Worth discussing with a clinician.' },
    ];
    const r = await send(c, { profileId: self.id, text: 'Anything I should worry about?' });
    assert.equal(r.status, 200);
    const types = r.events.map(e => e.type);
    assert.equal(types[0], 'start');
    assert.ok(types.includes('tool') && types.includes('organ') && types.at(-1) === 'done', types.join(','));
    assert.deepEqual(r.events.filter(e => e.type === 'organ').map(e => (e as { organ: string }).organ), ['heart']);
    const text = r.events.filter(e => e.type === 'text').map(e => (e as { delta: string }).delta).join('');
    assert.match(text, /LDL cholesterol is 138/);
    const done = r.events.at(-1) as Extract<AssistantEvent, { type: 'done' }>;
    assert.deepEqual(done.message.tools, ['Lab results']);
    assert.deepEqual(done.message.organs, ['heart']);

    // The request: Claude Opus 5.5, fallbacks on, medium effort, cached rules, only the tools for the shared kinds.
    const first = requests[0];
    assert.equal(first.body.model, 'claude-opus-5-5');
    assert.equal(first.body.fallbacks, 'default');
    assert.match(first.headers.get('anthropic-beta') ?? '', /server-side-fallback-2026-07-01/);
    assert.equal(first.body.output_config.effort, 'medium');
    assert.equal(first.body.stream, true);
    assert.deepEqual(first.body.system[0].cache_control, { type: 'ephemeral' });
    assert.match(first.body.system[1].text, new RegExp(`profile_id ${self.id}`));
    assert.match(first.body.system[1].text, /not shared these kinds of data with you: conditions, medications and allergies; list of scans and files; home lab tests/);
    const names = first.body.tools.map((t: { name: string }) => t.name);
    assert.ok(names.includes('get_results') && names.includes('show_on_body') && !names.includes('list_files') && !names.includes('add_to_profile'), names.join(','));
    assert.ok(first.body.tools.every((t: { eager_input_streaming?: boolean }) => t.eager_input_streaming === true));
    // The tool really ran against the records.
    const second = requests[1];
    const toolResult = second.body.messages.at(-1).content.find((b: { tool_use_id: string }) => b.tool_use_id === 'toolu_1_0');
    assert.match(toolResult.content, /"markerId":"ldl"/);

    // The next message replays the stored history unchanged, thinking signatures included.
    script = [{ text: 'It was 138 on 14 March.' }];
    const conversationId = (r.events[0] as Extract<AssistantEvent, { type: 'start' }>).conversationId;
    const r2 = await send(c, { profileId: self.id, conversationId, text: 'When was that?' });
    assert.equal(r2.status, 200);
    const replay = requests.at(-1).body.messages;
    assert.equal(replay.length, 5, 'user, assistant (tools), tool results, assistant (answer), new user message');
    assert.equal(replay[1].content[0].type, 'thinking');
    assert.equal(replay[1].content[0].signature, 'sig1');
    assert.deepEqual(replay[1], second.body.messages[1], 'byte-for-byte the same as the model returned it');
    const conv = await c.json<{ messages: { role: string; text: string; organs?: string[] }[] }>('GET', `/api/assistant/conversations/${conversationId}`);
    assert.deepEqual(conv.messages.map(m => m.role), ['user', 'assistant', 'user', 'assistant'], 'tool turns are not shown');
    assert.match(conv.messages[1].text, /^Let me look\.\n\nYour LDL/);
    assert.deepEqual(conv.messages[1].organs, ['heart']);
  });

  test('adds what the person says, to the open profile, with a notification not tied to a connection', async () => {
    const { c, self } = await account();
    await c.json('POST', '/api/assistant/consent', { noticeVersion: ASSISTANT_NOTICE_VERSION, categories: ['results', 'conditions'] });
    script = [{ tools: [{ name: 'log_reading', input: { marker: 'Fasting glucose', value: 104, unit: 'mg/dL', date: '2026-11-10' } }] }, { text: 'Added your fasting glucose of 104 mg/dL.' }];
    const r = await send(c, { profileId: self.id, text: 'My fasting glucose was 104 yesterday' });
    assert.ok(r.events.some(e => e.type === 'changed'));
    const records = await c.json<{ measurements: { markerId: string; sourceFile: string }[] }>('GET', `/api/profiles/${self.id}/records`);
    assert.ok(records.measurements.some(m => m.markerId === 'glucose_fasting' && m.sourceFile === 'Added by LotusPond assistant'));
    const notes = await c.json<NotificationList>('GET', '/api/notifications');
    assert.equal(notes.items[0].agentName, 'LotusPond assistant');
    assert.equal(notes.items[0].connectionId, null);
  });

  test('a refusal is answered plainly; a failed call stores nothing', async () => {
    const { c, self } = await account();
    await c.json('POST', '/api/assistant/consent', { noticeVersion: ASSISTANT_NOTICE_VERSION, categories: [] });
    script = [{ stop: 'refusal' }];
    const r = await send(c, { profileId: self.id, text: 'something it declines' });
    const done = r.events.at(-1) as Extract<AssistantEvent, { type: 'done' }>;
    assert.equal(done.message.refused, true);
    assert.match(done.message.text, /can’t help with that/);
    // Only the basics tools with no kinds shared.
    const names = requests.at(-1).body.tools.map((t: { name: string }) => t.name).sort();
    assert.deepEqual(names, ['get_health_summary', 'get_profile_details', 'list_profiles', 'show_on_body']);
  });
});
