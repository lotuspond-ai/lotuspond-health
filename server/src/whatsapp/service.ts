// The assistant on WhatsApp (docs/whatsapp.md).
//
// Linking: the app asks for a code (POST /api/whatsapp/link) and opens WhatsApp with "Link my LotusPond account:
// CODE" written to LotusPond's number. When that message arrives, the sender's number is linked to the account that
// asked for the code: only someone holding that phone could have sent it. The code works once, for 15 minutes.
//
// After that, text from the linked number goes to the assistant (assistant/turn.ts) and the answer is sent back; a
// photo or PDF is saved to the profile's files, with a notification that has Undo, and the reply links to the app to
// check what was read. STOP unlinks, HELP explains, NEW starts a fresh conversation.
//
// Numbers and codes are found through HMACs in the default database (whatsappDirectory, whatsappLinkCodes), like
// the email directory; the number itself is kept only in the account's cell (whatsappLinks).
import { createHash, createHmac, randomInt } from 'node:crypto';
import { and, desc, eq, gt, lt } from 'drizzle-orm';
import { ASSISTANT_MAX_INPUT, ASSISTANT_MAX_TURNS, ASSISTANT_NAME, ASSISTANT_NOTICE_VERSION } from '../../../shared/assistant.ts';
import { WHATSAPP_CODE_MINUTES, WHATSAPP_NOTICE_VERSION } from '../../../shared/whatsapp.ts';
import { recordEvent } from '../compliance/audit.ts';
import { recordConsents } from '../compliance/consents.ts';
import {
  assistantConversations, consents, documents, users, whatsappDirectory, whatsappInbound, whatsappLinkCodes, whatsappLinks,
  type UserRow, type WhatsAppLinkRow,
} from '../db/schema.ts';
import type { Db } from '../db/client.ts';
import type { Cell } from '../cells.ts';
import type { Deps } from '../http.ts';
import type { DataRegion } from '../../../shared/regions.ts';
import { RateLimiter } from '../lib/rate-limit.ts';
import { notifyAgentWrite } from '../notifications.ts';
import { AssistantError, type Assistant } from '../assistant/agent.ts';
import { accountProfiles, assistantConsent, conversationMessages, conversationTitle, runTurn, userTurns } from '../assistant/turn.ts';
import { WhatsAppError, type WhatsAppClient, type WhatsAppConfig } from './client.ts';

/** Letters and digits that can't be mistaken for each other (no I, O, 0, 1). */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_IN_TEXT = /\b[A-HJ-NP-Z2-9]{6}\b/g;
/** Messages per linked number per hour, like the app's chat. */
const PER_HOUR = 60;
/** A WhatsApp conversation carries on while it is this fresh; after a quiet day the next message starts a new one. */
const CONVERSATION_IDLE_MS = 24 * 60 * 60_000;
/** Kinds of file saved as a report. */
const REPORT_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

export const HELP_TEXT = [
  'This is the LotusPond assistant. You can:',
  '• Ask about your results, e.g. "How is my cholesterol?"',
  '• Tell me a reading, e.g. "My blood pressure today was 130/85"',
  '• Send a photo or PDF of a lab report to save it to your files',
  '',
  'NEW starts a fresh conversation. STOP unlinks this number. Answers explain results; they are not a diagnosis.',
].join('\n');

/** One incoming message, as the webhook delivers it (only the fields used). */
export interface InboundMessage {
  id: string;
  from: string;
  timestamp?: string;
  type: string;
  text?: { body?: string };
  image?: { id?: string; mime_type?: string; caption?: string };
  document?: { id?: string; mime_type?: string; filename?: string; caption?: string };
  button?: { text?: string };
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
}

interface Linked { cell: Cell; region: DataRegion; user: UserRow; link: WhatsAppLinkRow }

/** WhatsApp markdown: *bold* (not **bold**), and no headings. */
export function toWhatsAppText(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/^[ \t]*[-*][ \t]+/gm, '• ')
    .trim();
}

export interface WhatsAppService {
  config: WhatsAppConfig;
  /** Start linking: a fresh code for this account (earlier codes stop working). */
  startLink(cell: Cell, region: DataRegion, user: UserRow): Promise<{ code: string; expiresAt: Date }>;
  pendingCode(userId: string): Promise<{ expiresAt: Date } | null>;
  linkOf(cell: Cell, userId: string): Promise<WhatsAppLinkRow | null>;
  unlink(cell: Cell, user: UserRow, notify: boolean): Promise<boolean>;
  setProfile(cell: Cell, userId: string, profileId: string): Promise<WhatsAppLinkRow | null>;
  /** Handle one delivery (the webhook body). Work runs in the background; `idle()` resolves when it is done. */
  receive(body: unknown): void;
  idle(): Promise<void>;
  /** Remove expired codes and old message ids. */
  purge(): Promise<void>;
}

export function whatsappService(deps: Deps, assistant: Assistant, client: WhatsAppClient, config: WhatsAppConfig, appUrl: string): WhatsAppService {
  const key = deps.secrets.directoryKey;
  const phoneHash = (phone: string) => createHmac('sha256', key).update(`whatsapp:${phone}`).digest('hex');
  const codeHash = (code: string) => createHmac('sha256', key).update(`whatsapp-code:${code}`).digest('hex');
  const limiter = new RateLimiter(PER_HOUR, 60 * 60_000);
  /** Unlinked numbers get the "not linked" reply at most once a day. */
  const strangers = new RateLimiter(1, 24 * 60 * 60_000);
  // Each number's messages are handled one after another, in the order they arrived.
  const chains = new Map<string, Promise<void>>();
  const running = new Set<Promise<void>>();

  async function findLinked(phone: string): Promise<Linked | null> {
    const [entry] = await deps.db.select().from(whatsappDirectory).where(eq(whatsappDirectory.phoneHash, phoneHash(phone))).limit(1);
    if (!entry) return null;
    const cell = deps.cells.forRegion(entry.region);
    if (!cell) return null; // linked to an account another deployment serves
    const [link] = await cell.db.select().from(whatsappLinks).where(and(eq(whatsappLinks.userId, entry.userId), eq(whatsappLinks.phone, phone))).limit(1);
    const [user] = link ? await cell.db.select().from(users).where(eq(users.id, entry.userId)).limit(1) : [];
    if (!link || !user) {
      // The link was removed with its profile or account: the entry is stale.
      await deps.db.delete(whatsappDirectory).where(eq(whatsappDirectory.phoneHash, phoneHash(phone)));
      return null;
    }
    return { cell, region: entry.region, user, link };
  }

  async function removeLink(cell: Cell, userId: string): Promise<WhatsAppLinkRow | null> {
    const [gone] = await cell.db.delete(whatsappLinks).where(eq(whatsappLinks.userId, userId)).returning();
    await deps.db.delete(whatsappDirectory).where(eq(whatsappDirectory.userId, userId));
    return gone ?? null;
  }

  async function withdrawConsent(db: Db, user: UserRow) {
    await recordConsents(db, user.id, user.country, [{ kind: 'whatsapp', granted: false, version: WHATSAPP_NOTICE_VERSION }]);
  }

  async function reply(to: string, text: string) {
    try { await client.sendText(to, text); } catch (e) { console.error(`[whatsapp] reply failed: ${e instanceof Error ? e.message : String(e)}`); }
  }

  /** The number sent a code: link it to the account that asked for it. */
  async function tryLink(phone: string, text: string): Promise<boolean> {
    for (const code of new Set(text.toUpperCase().match(CODE_IN_TEXT) ?? [])) {
      const [entry] = await deps.db.delete(whatsappLinkCodes)
        .where(and(eq(whatsappLinkCodes.codeHash, codeHash(code)), gt(whatsappLinkCodes.expiresAt, new Date()))).returning();
      if (!entry) continue;
      const cell = deps.cells.forRegion(entry.region);
      const [user] = cell ? await cell.db.select().from(users).where(eq(users.id, entry.userId)).limit(1) : [];
      if (!cell || !user) continue;
      // A number belongs to one account: linking it here unlinks it from any other, and this account's earlier number.
      const before = await findLinked(phone);
      if (before && before.user.id !== user.id) {
        await removeLink(before.cell, before.user.id);
        await withdrawConsent(before.cell.db, before.user);
        await recordEvent(before.cell.db, null, before.user.id, 'whatsapp_unlinked');
      }
      await removeLink(cell, user.id);
      const [self] = await accountProfiles(cell.db, user.id);
      if (!self) continue;
      await cell.db.insert(whatsappLinks).values({ userId: user.id, phone, profileId: self.id });
      await deps.db.insert(whatsappDirectory).values({ phoneHash: phoneHash(phone), region: entry.region, userId: user.id })
        .onConflictDoUpdate({ target: whatsappDirectory.phoneHash, set: { region: entry.region, userId: user.id } });
      await deps.db.delete(whatsappLinkCodes).where(eq(whatsappLinkCodes.userId, user.id));
      await recordEvent(cell.db, null, user.id, 'whatsapp_linked', { profileId: self.id });
      await reply(phone, `Linked. This number now talks to the LotusPond assistant about ${self.relationship === 'self' ? 'your' : `${self.displayName}’s`} records.\n\n${HELP_TEXT}`);
      return true;
    }
    return false;
  }

  async function latestConsent(db: Db, userId: string, kind: 'whatsapp') {
    const [row] = await db.select().from(consents).where(and(eq(consents.userId, userId), eq(consents.kind, kind)))
      .orderBy(desc(consents.createdAt), desc(consents.id)).limit(1);
    return row ?? null;
  }

  /** The conversation WhatsApp carries on: the latest one, unless it is full or has been quiet for a day. */
  async function conversationFor(l: Linked, firstText: string, fresh: boolean) {
    if (!fresh) {
      const [conv] = await l.cell.db.select().from(assistantConversations)
        .where(and(eq(assistantConversations.userId, l.user.id), eq(assistantConversations.channel, 'whatsapp'), eq(assistantConversations.profileId, l.link.profileId)))
        .orderBy(desc(assistantConversations.updatedAt)).limit(1);
      if (conv && Date.now() - conv.updatedAt.getTime() < CONVERSATION_IDLE_MS) {
        const rows = await conversationMessages(l.cell.db, conv.id);
        if (userTurns(rows) < ASSISTANT_MAX_TURNS) return { conv, rows };
      }
    }
    const [conv] = await l.cell.db.insert(assistantConversations)
      .values({ userId: l.user.id, profileId: l.link.profileId, title: conversationTitle(firstText), channel: 'whatsapp' }).returning();
    await recordEvent(l.cell.db, null, l.user.id, 'assistant_chat', { profileId: l.link.profileId });
    return { conv, rows: [] };
  }

  async function ask(l: Linked, text: string, messageId: string) {
    const consent = await assistantConsent(l.cell.db, l.user.id);
    if (!consent?.granted || consent.version !== ASSISTANT_NOTICE_VERSION) {
      await reply(l.link.phone, 'The assistant is turned off for your account. Turn it on in the LotusPond app (Ask), then message me again.');
      return;
    }
    const all = await accountProfiles(l.cell.db, l.user.id);
    const profile = all.find(p => p.id === l.link.profileId);
    if (!profile) return;
    await client.markRead(messageId, true);
    const { conv, rows } = await conversationFor(l, text, false);
    try {
      const turn = await runTurn({ deps, assistant, cell: l.cell, user: l.user, consent, all, profile, conversation: conv, rows, text, appUrl, emit: () => {} });
      const links = turn.links.map(k => `${k.label}: ${k.url}`).join('\n');
      await reply(l.link.phone, [toWhatsAppText(turn.text) || 'Sorry, I have no answer to that.', links].filter(Boolean).join('\n\n'));
    } catch (e) {
      if (!(e instanceof AssistantError)) console.error('[whatsapp] assistant failed', e);
      await reply(l.link.phone, e instanceof AssistantError ? e.message : 'Something went wrong. Try again in a moment.');
    }
  }

  /** Save a photo or PDF of a report to the profile's files, and tell the person where to check it. */
  async function saveReport(l: Linked, m: InboundMessage) {
    const media = m.type === 'image' ? m.image : m.document;
    const declared = (media?.mime_type ?? '').split(';')[0].trim().toLowerCase();
    if (!media?.id || !REPORT_TYPES[declared]) {
      await reply(l.link.phone, 'I can save photos (JPEG, PNG, WebP) and PDFs of reports. Send the report as one of those.');
      return;
    }
    await client.markRead(m.id, false);
    let file: { bytes: Uint8Array; mimeType: string };
    try {
      file = await client.download(media.id, deps.config.maxUploadBytes);
    } catch (e) {
      const big = e instanceof WhatsAppError && e.code === 'too_large';
      if (!big) console.error(`[whatsapp] download failed: ${e instanceof Error ? e.message : String(e)}`);
      await reply(l.link.phone, big ? `That file is too large. Files can be up to ${Math.round(deps.config.maxUploadBytes / 1048576)} MB.` : 'I could not download that file. Try sending it again.');
      return;
    }
    const contentType = REPORT_TYPES[file.mimeType] ? file.mimeType : declared;
    const stamp = new Date().toISOString().slice(0, 10);
    const given = m.type === 'document' ? (m.document?.filename ?? '').replace(/[^\w .()-]+/g, '').trim().slice(0, 120) : '';
    const fileName = given || `WhatsApp report ${stamp}.${REPORT_TYPES[contentType]}`;
    const profileId = l.link.profileId;
    const id = crypto.randomUUID();
    const storageKey = `${profileId}/${id}`;
    await l.cell.files.put(storageKey, file.bytes);
    try {
      await l.cell.db.insert(documents).values({
        id, profileId, storageKey, kind: 'report', fileName, contentType, sizeBytes: file.bytes.byteLength,
        sha256: createHash('sha256').update(file.bytes).digest('hex'),
      });
    } catch (e) {
      await l.cell.files.delete(storageKey);
      throw e;
    }
    await notifyAgentWrite(l.cell.db, { userId: l.user.id, profileId, connectionId: null, agentName: `${ASSISTANT_NAME} (WhatsApp)`, detail: { type: 'document', documentId: id, fileName } });
    await recordEvent(l.cell.db, null, l.user.id, 'whatsapp_report', { profileId });
    const [profile] = (await accountProfiles(l.cell.db, l.user.id)).filter(p => p.id === profileId);
    const whose = profile?.relationship === 'self' ? 'your' : `${profile?.displayName ?? 'the'}’s`;
    await reply(l.link.phone, `Saved *${fileName}* to ${whose} files. Check what was read and add the results in the app:\n${appUrl}?review=${id}&profile=${profileId}`);
  }

  async function handle(m: InboundMessage) {
    const phone = m.from.replace(/\D/g, '');
    if (!phone) return;
    // Meta may deliver a message more than once: each is handled once.
    const fresh = await deps.db.insert(whatsappInbound).values({ messageId: m.id }).onConflictDoNothing().returning();
    if (!fresh.length) return;
    const text = (m.text?.body ?? m.image?.caption ?? m.document?.caption ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? '').trim();
    if (text && await tryLink(phone, text)) return;
    const l = await findLinked(phone);
    if (!l) {
      if (!strangers.hit(phone)) await reply(phone, 'This number is not linked to a LotusPond account. To link it, open LotusPond, go to Account, Connected agents and assistant, and choose Link WhatsApp.');
      return;
    }
    const wcon = await latestConsent(l.cell.db, l.user.id, 'whatsapp');
    if (!wcon?.granted) { await removeLink(l.cell, l.user.id); return; }
    await l.cell.db.update(whatsappLinks).set({ lastMessageAt: new Date() }).where(eq(whatsappLinks.userId, l.user.id));
    const command = text.toUpperCase().replace(/[^A-Z]/g, '');
    if (['STOP', 'UNLINK', 'UNSUBSCRIBE'].includes(command)) {
      await removeLink(l.cell, l.user.id);
      await withdrawConsent(l.cell.db, l.user);
      await recordEvent(l.cell.db, null, l.user.id, 'whatsapp_unlinked');
      await reply(phone, 'Unlinked. This number no longer reaches your LotusPond records. You can link it again in the app.');
      return;
    }
    if (['HELP', 'MENU'].includes(command)) { await reply(phone, HELP_TEXT); return; }
    if (command === 'NEW') {
      await conversationFor(l, 'New conversation', true);
      await reply(phone, 'Started a new conversation. What would you like to know?');
      return;
    }
    const wait = limiter.hit(l.user.id);
    if (wait) { await reply(phone, `You have sent many messages in the last hour. Try again in ${Math.ceil(wait / 60)} minutes.`); return; }
    if (m.type === 'image' || m.type === 'document') { await saveReport(l, m); return; }
    if (!text) { await reply(phone, 'I can read text messages, and photos or PDFs of reports.'); return; }
    await ask(l, text.slice(0, ASSISTANT_MAX_INPUT), m.id);
  }

  function enqueue(m: InboundMessage) {
    const key = m.from;
    const next = (chains.get(key) ?? Promise.resolve()).then(() => handle(m)).catch(e => console.error('[whatsapp] message failed', e));
    chains.set(key, next);
    running.add(next);
    void next.finally(() => { running.delete(next); if (chains.get(key) === next) chains.delete(key); });
  }

  return {
    config,
    async startLink(cell, region, user) {
      await deps.db.delete(whatsappLinkCodes).where(eq(whatsappLinkCodes.userId, user.id));
      for (;;) {
        const code = Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
        const expiresAt = new Date(Date.now() + WHATSAPP_CODE_MINUTES * 60_000);
        const rows = await deps.db.insert(whatsappLinkCodes).values({ codeHash: codeHash(code), region, userId: user.id, expiresAt }).onConflictDoNothing().returning();
        if (rows.length) {
          await recordConsents(cell.db, user.id, user.country, [{ kind: 'whatsapp', granted: true, version: WHATSAPP_NOTICE_VERSION }]);
          return { code, expiresAt };
        }
      }
    },
    async pendingCode(userId) {
      const [row] = await deps.db.select().from(whatsappLinkCodes).where(and(eq(whatsappLinkCodes.userId, userId), gt(whatsappLinkCodes.expiresAt, new Date()))).limit(1);
      return row ? { expiresAt: row.expiresAt } : null;
    },
    async linkOf(cell, userId) {
      const [row] = await cell.db.select().from(whatsappLinks).where(eq(whatsappLinks.userId, userId)).limit(1);
      return row ?? null;
    },
    async unlink(cell, user, notify) {
      await deps.db.delete(whatsappLinkCodes).where(eq(whatsappLinkCodes.userId, user.id));
      const gone = await removeLink(cell, user.id);
      await withdrawConsent(cell.db, user);
      if (gone) {
        await recordEvent(cell.db, null, user.id, 'whatsapp_unlinked');
        if (notify) await reply(gone.phone, 'This number was unlinked from LotusPond in the app. It no longer reaches your records.');
      }
      return !!gone;
    },
    async setProfile(cell, userId, profileId) {
      const [row] = await cell.db.update(whatsappLinks).set({ profileId }).where(eq(whatsappLinks.userId, userId)).returning();
      return row ?? null;
    },
    receive(body) {
      const b = body as { entry?: { changes?: { field?: string; value?: { messages?: InboundMessage[] } }[] }[] };
      for (const entry of b?.entry ?? []) {
        for (const change of entry.changes ?? []) {
          if (change.field && change.field !== 'messages') continue;
          // Delivery and read statuses come in the same field; only messages are acted on.
          for (const m of change.value?.messages ?? []) {
            if (m && typeof m.id === 'string' && typeof m.from === 'string' && typeof m.type === 'string') enqueue(m);
          }
        }
      }
    },
    async idle() {
      while (running.size) await Promise.allSettled([...running]);
    },
    async purge() {
      await deps.db.delete(whatsappLinkCodes).where(lt(whatsappLinkCodes.expiresAt, new Date()));
      await deps.db.delete(whatsappInbound).where(lt(whatsappInbound.receivedAt, new Date(Date.now() - 7 * 24 * 60 * 60_000)));
    },
  };
}
