// The assistant on WhatsApp: linking a number with a code sent from it, the signed webhook, messages answered by
// the assistant, reports saved to the files, and unlinking. WhatsApp's API is a stand-in client that records what
// would be sent; Claude is the scripted stand-in from fake-claude.ts, through the real SDK.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import type { Hono } from 'hono';
import { ASSISTANT_NOTICE_VERSION, type AssistantInfo } from '../../shared/assistant.ts';
import type { NotificationList } from '../../shared/notifications.ts';
import { WHATSAPP_NOTICE_VERSION, type WhatsAppInfo, type WhatsAppLinkStart } from '../../shared/whatsapp.ts';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDatabase, type Database } from '../src/db/client.ts';
import type { AppEnv } from '../src/http.ts';
import { DiskFileStore } from '../src/lib/files.ts';
import { claudeAssistant } from '../src/assistant/agent.ts';
import { splitText, validSignature, type WhatsAppClient } from '../src/whatsapp/client.ts';
import { toWhatsAppText, type InboundMessage, type WhatsAppService } from '../src/whatsapp/service.ts';
import { makeClient, measurement, registration } from './helpers.ts';
import { sse, type Script } from './fake-claude.ts';

const migrations = fileURLToPath(new URL('../drizzle', import.meta.url));
const APP_SECRET = 'test-app-secret-0123456789';
const VERIFY = 'test-verify-token-0123456789';
let database: Database;
let app: Hono<AppEnv>;
let filesDir: string;
let wa: WhatsAppService;

let script: Script[] = [];
const requests: any[] = [];
const sent: { to: string; body: string }[] = [];
const media = new Map<string, { bytes: Uint8Array; mimeType: string }>();
const fakeWhatsApp: WhatsAppClient = {
  async sendText(to, body) { sent.push({ to, body }); },
  async markRead() {},
  async download(id) { const m = media.get(id); if (!m) throw new Error('no such media'); return m; },
};

before(async () => {
  database = await openDatabase({ url: process.env.TEST_DATABASE_URL });
  await database.migrate(migrations);
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspond-whatsapp-'));
  const config = loadConfig({
    NODE_ENV: 'test', ACCOUNTS_ISSUER: 'fake', TRUST_PROXY: 'true', PUBLIC_URL: 'https://health.example',
    WHATSAPP_PHONE_NUMBER_ID: '1234567890', WHATSAPP_NUMBER: '+91 98765 43210', WHATSAPP_ACCESS_TOKEN: 'EAAtest-access-token-0123456789',
    WHATSAPP_APP_SECRET: APP_SECRET, WHATSAPP_VERIFY_TOKEN: VERIFY,
  });
  let n = 0;
  const client = new Anthropic({
    apiKey: 'sk-ant-test', maxRetries: 0,
    fetch: (async (_url: string | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(sse(script.shift() ?? { text: 'Done.' }, ++n), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch,
  });
  app = createApp({ db: database.db, files: new DiskFileStore(filesDir), config, assistant: claudeAssistant({ client }) }, {
    whatsapp: { client: fakeWhatsApp, onService: s => { wa = s; } },
  });
});
after(async () => {
  await database?.close();
  fs.rmSync(filesDir, { recursive: true, force: true });
});

let k = 0;
let msg = 0;
async function account(agree = true) {
  const c = makeClient(app);
  const info = await c.signUp(registration(`wa-${Date.now()}-${++k}@example.com`));
  const self = info.profiles[0];
  await c.json('POST', `/api/profiles/${self.id}/measurements`, { measurements: [measurement({ date: '2026-03-14', value: 138, valueText: '138' })] }, 201);
  if (agree) await c.json('POST', '/api/assistant/consent', { noticeVersion: ASSISTANT_NOTICE_VERSION, categories: ['results', 'files'] });
  return { c, self };
}

/** Deliver messages as Meta does: signed, in the WhatsApp Business Account envelope. Waits until they are handled. */
async function deliver(messages: Partial<InboundMessage>[], opts: { sign?: boolean } = {}) {
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '1234567890' }, messages } }] }],
  });
  const sig = `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;
  const res = await app.request('/hooks/whatsapp', { method: 'POST', body, headers: { 'content-type': 'application/json', ...(opts.sign === false ? {} : { 'x-hub-signature-256': sig }) } });
  await wa.idle();
  return res;
}
const text = (from: string, body: string): Partial<InboundMessage> => ({ id: `wamid.${++msg}`, from, type: 'text', text: { body } });
const lastTo = (to: string) => sent.filter(s => s.to === to).at(-1)?.body ?? '';

async function link(c: ReturnType<typeof makeClient>, phone: string) {
  const start = await c.json<WhatsAppLinkStart>('POST', '/api/whatsapp/link', { noticeVersion: WHATSAPP_NOTICE_VERSION }, 201);
  await deliver([text(phone, decodeURIComponent(start.url.split('text=')[1]))]);
  return start;
}

describe('WhatsApp', () => {
  test('signatures, splitting and formatting', () => {
    const body = '{"a":1}';
    assert.ok(validSignature('s3cret-key-123456', body, `sha256=${createHmac('sha256', 's3cret-key-123456').update(body).digest('hex')}`));
    assert.ok(!validSignature('s3cret-key-123456', body, 'sha256=00'));
    assert.ok(!validSignature('s3cret-key-123456', body, undefined));
    const parts = splitText(`${'a'.repeat(3000)}\n\n${'b'.repeat(3000)}`);
    assert.equal(parts.length, 2);
    assert.ok(parts.every(p => p.length <= 4096));
    assert.equal(toWhatsAppText('## Results\nYour **LDL** is high.\n\n- one\n* two'), '*Results*\nYour *LDL* is high.\n\n• one\n• two');
  });

  test('Meta verifies the webhook with the verify token; unsigned deliveries are refused', async () => {
    assert.equal(await (await app.request(`/hooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=4242`)).text(), '4242');
    assert.equal((await app.request('/hooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1')).status, 403);
    assert.equal((await deliver([text('919800000001', 'hello')], { sign: false })).status, 401);
    assert.equal(sent.filter(s => s.to === '919800000001').length, 0);
  });

  test('links a number with the code sent from it, once, and only after the assistant is on', async () => {
    const { c, self } = await account(false);
    const info = await c.json<WhatsAppInfo>('GET', '/api/whatsapp');
    assert.equal(info.enabled, true);
    assert.equal(info.link, null);
    assert.equal((await c.error('POST', '/api/whatsapp/link', { noticeVersion: WHATSAPP_NOTICE_VERSION })).status, 409);
    await c.json('POST', '/api/assistant/consent', { noticeVersion: ASSISTANT_NOTICE_VERSION, categories: ['results'] });
    assert.equal((await c.error('POST', '/api/whatsapp/link', { noticeVersion: 'old' })).status, 409);

    const start = await c.json<WhatsAppLinkStart>('POST', '/api/whatsapp/link', { noticeVersion: WHATSAPP_NOTICE_VERSION }, 201);
    assert.match(start.code, /^[A-HJ-NP-Z2-9]{6}$/);
    assert.equal(start.url, `https://wa.me/919876543210?text=${encodeURIComponent(`Link my LotusPond account: ${start.code}`)}`);
    assert.equal(start.number, '+91 98765 43210');
    assert.ok((await c.json<WhatsAppInfo>('GET', '/api/whatsapp')).pending);

    // A wrong code links nothing; the right one, from any wording, links the number that sent it.
    await deliver([text('919811112222', 'Link my LotusPond account: ZZZZZZ')]);
    assert.match(lastTo('919811112222'), /not linked/);
    const delivery = text('919811112222', `link ${start.code.toLowerCase()} please`);
    await deliver([delivery]);
    assert.match(lastTo('919811112222'), /^Linked\./);
    const linked = await c.json<WhatsAppInfo>('GET', '/api/whatsapp');
    assert.equal(linked.link?.phone, '+91 ••••• •2222');
    assert.equal(linked.link?.profileId, self.id);
    assert.equal(linked.pending, null);

    // Meta may send the same message again: it is handled once.
    const before = sent.length;
    await deliver([delivery]);
    assert.equal(sent.length, before);
    // The code worked once.
    const other = await account();
    await deliver([text('919833334444', `Link my LotusPond account: ${start.code}`)]);
    assert.equal((await other.c.json<WhatsAppInfo>('GET', '/api/whatsapp')).link, null);

    const consents = await c.json<{ kind: string; granted: boolean }[]>('GET', '/api/auth/consents');
    assert.ok(consents.some(r => r.kind === 'whatsapp' && r.granted));
    const activity = await c.json<{ kind: string }[]>('GET', '/api/auth/activity');
    assert.ok(activity.some(e => e.kind === 'whatsapp_linked'));
  });

  test('answers messages with the assistant, without the body map, in WhatsApp formatting, and adds readings', async () => {
    const { c, self } = await account();
    const phone = '919855556666';
    await link(c, phone);
    requests.length = 0;
    script = [
      { tools: [{ name: 'get_results', input: { out_of_range_only: true } }] },
      { text: 'Your **LDL cholesterol** is 138 mg/dL, above its range of under 100.' },
    ];
    await deliver([text(phone, 'How is my cholesterol?')]);
    assert.equal(lastTo(phone), 'Your *LDL cholesterol* is 138 mg/dL, above its range of under 100.');
    const first = requests[0];
    assert.ok(!first.tools.some((t: { name: string }) => t.name === 'show_on_body'));
    assert.match(first.system[1].text, /writing on WhatsApp/);
    assert.match(first.system[1].text, new RegExp(`profile_id ${self.id}`));

    // The next message carries on the same conversation, which the app lists as a WhatsApp one.
    script = [
      { tools: [{ name: 'log_reading', input: { marker: 'Systolic blood pressure', value: 130, unit: 'mmHg' } }] },
      { text: 'Added your systolic blood pressure of 130 mmHg.' },
    ];
    await deliver([text(phone, 'My systolic was 130 today')]);
    assert.match(lastTo(phone), /Added your systolic/);
    // The first turn (question, tool use, result, answer) is replayed, then the new question.
    assert.equal(requests.at(-2).messages.length, 5);
    const info = await c.json<AssistantInfo>('GET', '/api/assistant');
    const conv = info.conversations[0];
    assert.equal(conv.channel, 'whatsapp');
    assert.equal(info.conversations.length, 1);
    const shown = await c.json<{ messages: { role: string; text: string }[] }>('GET', `/api/assistant/conversations/${conv.id}`);
    assert.deepEqual(shown.messages.map(m => m.role), ['user', 'assistant', 'user', 'assistant']);
    // It continues on WhatsApp only.
    assert.equal((await c.error('POST', '/api/assistant/messages', { profileId: self.id, conversationId: conv.id, text: 'Hi' })).status, 409);
    const bell = await c.json<NotificationList>('GET', '/api/notifications');
    assert.equal(bell.items[0].detail.type, 'reading');

    // NEW starts a fresh one; HELP explains.
    await deliver([text(phone, 'new')]);
    assert.match(lastTo(phone), /new conversation/);
    await deliver([text(phone, 'HELP')]);
    assert.match(lastTo(phone), /STOP unlinks/);
    assert.equal((await c.json<AssistantInfo>('GET', '/api/assistant')).conversations.length, 2);
  });

  test('saves a photo or PDF of a report to the files, with Undo, and links to the review in the app', async () => {
    const { c, self } = await account();
    const phone = '919877778888';
    await link(c, phone);
    const pdf = new TextEncoder().encode('%PDF-1.4 a report');
    media.set('media-1', { bytes: pdf, mimeType: 'application/pdf' });
    await deliver([{ id: `wamid.${++msg}`, from: phone, type: 'document', document: { id: 'media-1', mime_type: 'application/pdf', filename: 'Lipid profile.pdf' } }]);
    const docs = await (await c.json<{ documents: { id: string; fileName: string; kind: string; sizeBytes: number }[] }>('GET', `/api/profiles/${self.id}/records`)).documents;
    const doc = docs.find(d => d.fileName === 'Lipid profile.pdf');
    assert.ok(doc);
    assert.equal(doc.kind, 'report');
    assert.equal(doc.sizeBytes, pdf.byteLength);
    assert.equal(lastTo(phone), `Saved *Lipid profile.pdf* to your files. Check what was read and add the results in the app:\nhttps://health.example/app?review=${doc.id}&profile=${self.id}`);
    const bell = await c.json<NotificationList>('GET', '/api/notifications');
    const n = bell.items.find(i => i.detail.type === 'document');
    assert.ok(n);
    assert.equal(n.agentName, 'LotusPond assistant (WhatsApp)');
    await c.json('POST', `/api/notifications/${n.id}/undo`, {});
    assert.ok(!(await c.json<{ documents: { id: string }[] }>('GET', `/api/profiles/${self.id}/records`)).documents.some(d => d.id === doc.id));

    // Other kinds of file are not saved.
    await deliver([{ id: `wamid.${++msg}`, from: phone, type: 'document', document: { id: 'media-2', mime_type: 'application/zip', filename: 'x.zip' } }]);
    assert.match(lastTo(phone), /photos \(JPEG, PNG, WebP\) and PDFs/);
    // A photo with no file name gets one.
    media.set('media-3', { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), mimeType: 'image/jpeg' });
    await deliver([{ id: `wamid.${++msg}`, from: phone, type: 'image', image: { id: 'media-3', mime_type: 'image/jpeg' } }]);
    assert.match(lastTo(phone), /Saved \*WhatsApp report \d{4}-\d{2}-\d{2}\.jpg\*/);
  });

  test('STOP, or unlinking in the app, ends it; a number moves to the account that links it last', async () => {
    const a = await account();
    const phone = '919899990000';
    await link(a.c, phone);
    await deliver([text(phone, 'STOP')]);
    assert.match(lastTo(phone), /^Unlinked\./);
    assert.equal((await a.c.json<WhatsAppInfo>('GET', '/api/whatsapp')).link, null);
    await deliver([text(phone, 'How is my cholesterol?')]);
    assert.match(lastTo(phone), /not linked/);

    await link(a.c, phone);
    const b = await account();
    await link(b.c, phone);
    assert.equal((await a.c.json<WhatsAppInfo>('GET', '/api/whatsapp')).link, null);
    assert.ok((await b.c.json<WhatsAppInfo>('GET', '/api/whatsapp')).link);

    await b.c.json('DELETE', '/api/whatsapp/link', undefined, 204);
    assert.match(lastTo(phone), /unlinked from LotusPond in the app/);
    assert.equal((await b.c.json<WhatsAppInfo>('GET', '/api/whatsapp')).link, null);
    const consents = await b.c.json<{ kind: string; granted: boolean }[]>('GET', '/api/auth/consents');
    assert.equal(consents.find(r => r.kind === 'whatsapp')?.granted, false);
  });

  test('turning the assistant off stops the answers; deleting the account removes the link', async () => {
    const { c } = await account();
    const phone = '919812341234';
    await link(c, phone);
    await c.json('DELETE', '/api/assistant/consent', undefined, 204);
    await deliver([text(phone, 'Hello')]);
    assert.match(lastTo(phone), /assistant is turned off/);
    await c.json('DELETE', '/api/auth/account', { password: 'correct horse battery' }, 204);
    await deliver([text(phone, 'Hello again')]);
    assert.match(lastTo(phone), /not linked/);
  });
});
