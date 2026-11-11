// LotusPond's assistant in the app (shared/assistant.ts):
//   GET    /api/assistant                     whether it is on, the person's consent, their conversations
//   POST   /api/assistant/consent             agree, with the kinds of data it may read ({ noticeVersion, categories })
//   DELETE /api/assistant/consent             withdraw: the assistant stops until they agree again
//   GET    /api/assistant/conversations/:id   a conversation's messages
//   DELETE /api/assistant/conversations/:id   delete a conversation
//   POST   /api/assistant/messages            send a message ({ profileId, conversationId?, text }); the answer is
//                                             streamed as server-sent events (AssistantEvent)
import { and, asc, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { AGENT_CATEGORIES, AGENT_CATEGORY_TEXT, type AgentCategory } from '../../../shared/agents.ts';
import {
  ASSISTANT_MAX_INPUT, ASSISTANT_MAX_TURNS, ASSISTANT_NAME, ASSISTANT_NOTICE_VERSION,
  type AssistantConsent, type AssistantEvent, type AssistantInfo, type AssistantMessage,
} from '../../../shared/assistant.ts';
import { eventContext, recordEvent } from '../compliance/audit.ts';
import { recordConsents } from '../compliance/consents.ts';
import { assistantConversations, assistantMessages, consents, profiles, type AgentGrantRow, type AssistantMessageRow, type UserRow } from '../db/schema.ts';
import type { Db } from '../db/client.ts';
import { conflict, HttpError, notFound, tooMany } from '../lib/errors.ts';
import { RateLimiter } from '../lib/rate-limit.ts';
import { readJson, requireAuth, UUID, type AppEnv, type Deps } from '../http.ts';
import { relationshipOrder } from '../routes/profiles.ts';
import { cleanCategories } from '../agents/grants.ts';
import { publicOrigin } from '../agents/oauth.ts';
import { toolsFor, type ToolContext } from '../agents/tools.ts';
import { AssistantError, type Assistant } from './agent.ts';

/** Messages per account per hour. */
const PER_HOUR = 60;

const ConsentBody = z.object({
  noticeVersion: z.string(),
  categories: z.array(z.enum(AGENT_CATEGORIES as [string, ...string[]])).max(AGENT_CATEGORIES.length),
});
const MessageBody = z.object({
  profileId: z.string().regex(UUID),
  conversationId: z.string().regex(UUID).optional(),
  text: z.string().trim().min(1, 'Write a message.').max(ASSISTANT_MAX_INPUT),
});

export async function assistantConsent(db: Db, userId: string): Promise<AssistantConsent | null> {
  const [row] = await db.select().from(consents).where(and(eq(consents.userId, userId), eq(consents.kind, 'assistant')))
    .orderBy(desc(consents.createdAt), desc(consents.id)).limit(1);
  if (!row) return null;
  return { granted: row.granted, version: row.version, categories: cleanCategories(row.detail?.categories ?? []), at: row.createdAt.toISOString() };
}

const toMessage = (r: AssistantMessageRow): AssistantMessage => ({
  id: r.id, role: r.role, text: r.text, createdAt: r.createdAt.toISOString(),
  ...(r.meta?.tools?.length ? { tools: r.meta.tools } : {}),
  ...(r.meta?.organs?.length ? { organs: r.meta.organs } : {}),
  ...(r.meta?.links?.length ? { links: r.meta.links } : {}),
  ...(r.meta?.wrote ? { wrote: true } : {}),
  ...(r.meta?.refused ? { refused: true } : {}),
});

/** The assistant acts like a connection that sees every profile of the account, with the kinds of data agreed to. */
function assistantGrant(user: UserRow, profileIds: string[], categories: AgentCategory[]): AgentGrantRow {
  return {
    id: user.id, userId: user.id, kind: 'token', clientId: null, name: ASSISTANT_NAME, redirectHost: null,
    scopes: ['health:read', 'health:write'], categories, profileIds,
    createdAt: new Date(), lastUsedAt: null, lastLoggedAt: null, expiresAt: null,
  };
}

const title = (text: string) => { const t = text.replace(/\s+/g, ' ').trim(); return t.length > 60 ? `${t.slice(0, 57)}…` : t; };

export function assistantRoutes(deps: Deps, assistant: Assistant | undefined) {
  const limiter = new RateLimiter(PER_HOUR, 60 * 60_000);
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth(deps));

  app.get('/', async c => {
    const { db } = c.var.cell;
    const rows = await db.select().from(assistantConversations).where(eq(assistantConversations.userId, c.var.user.id))
      .orderBy(desc(assistantConversations.updatedAt)).limit(30);
    const body: AssistantInfo = {
      enabled: !!assistant, noticeVersion: ASSISTANT_NOTICE_VERSION, consent: await assistantConsent(db, c.var.user.id),
      conversations: rows.map(r => ({ id: r.id, profileId: r.profileId, title: r.title, updatedAt: r.updatedAt.toISOString() })),
    };
    return c.json(body);
  });

  app.post('/consent', async c => {
    const body = await readJson(c, ConsentBody);
    if (body.noticeVersion !== ASSISTANT_NOTICE_VERSION) throw conflict('The notice about the assistant has changed since this page was loaded. Reload the app and try again.', 'notice_outdated');
    const { db } = c.var.cell;
    await recordConsents(db, c.var.user.id, c.var.user.country, [{ kind: 'assistant', granted: true, version: ASSISTANT_NOTICE_VERSION, detail: { categories: cleanCategories(body.categories) } }]);
    await recordEvent(db, eventContext(c, deps), c.var.user.id, 'consent_changed', { consent: 'assistant', granted: true });
    return c.json(await assistantConsent(db, c.var.user.id));
  });

  app.delete('/consent', async c => {
    const { db } = c.var.cell;
    const now = await assistantConsent(db, c.var.user.id);
    if (now?.granted) {
      await recordConsents(db, c.var.user.id, c.var.user.country, [{ kind: 'assistant', granted: false, version: ASSISTANT_NOTICE_VERSION, detail: { categories: [] } }]);
      await recordEvent(db, eventContext(c, deps), c.var.user.id, 'consent_changed', { consent: 'assistant', granted: false });
    }
    return c.body(null, 204);
  });

  app.get('/conversations/:id', async c => {
    const id = c.req.param('id');
    if (!UUID.test(id)) throw notFound('That conversation');
    const { db } = c.var.cell;
    const [conv] = await db.select().from(assistantConversations).where(and(eq(assistantConversations.id, id), eq(assistantConversations.userId, c.var.user.id))).limit(1);
    if (!conv) throw notFound('That conversation');
    const rows = await db.select().from(assistantMessages).where(eq(assistantMessages.conversationId, id)).orderBy(asc(assistantMessages.seq));
    return c.json({ id: conv.id, profileId: conv.profileId, title: conv.title, messages: rows.filter(r => r.text).map(toMessage) });
  });

  app.delete('/conversations/:id', async c => {
    const id = c.req.param('id');
    if (!UUID.test(id)) throw notFound('That conversation');
    const gone = await c.var.cell.db.delete(assistantConversations).where(and(eq(assistantConversations.id, id), eq(assistantConversations.userId, c.var.user.id))).returning({ id: assistantConversations.id });
    if (!gone.length) throw notFound('That conversation');
    return c.body(null, 204);
  });

  app.post('/messages', async c => {
    if (!assistant) throw new HttpError(503, 'assistant_unavailable', 'The assistant is not switched on for this server.');
    const body = await readJson(c, MessageBody);
    const { db } = c.var.cell;
    const user = c.var.user;
    const consent = await assistantConsent(db, user.id);
    if (!consent?.granted || consent.version !== ASSISTANT_NOTICE_VERSION) throw conflict('Agree to the assistant notice first.', 'consent_required');
    const wait = limiter.hit(user.id);
    if (wait) throw tooMany(`You have sent many messages in the last hour. Try again in ${Math.ceil(wait / 60)} minutes.`);

    const all = (await db.select().from(profiles).where(eq(profiles.userId, user.id))).sort(relationshipOrder);
    const profile = all.find(p => p.id === body.profileId);
    if (!profile) throw notFound('That profile');

    let conv = body.conversationId
      ? (await db.select().from(assistantConversations).where(and(eq(assistantConversations.id, body.conversationId), eq(assistantConversations.userId, user.id))).limit(1))[0]
      : undefined;
    if (body.conversationId && !conv) throw notFound('That conversation');
    const rows = conv ? await db.select().from(assistantMessages).where(eq(assistantMessages.conversationId, conv.id)).orderBy(asc(assistantMessages.seq)) : [];
    const turns = rows.filter(r => r.role === 'user' && r.text).length;
    if (turns >= ASSISTANT_MAX_TURNS) throw conflict('This conversation is long. Start a new one to keep answers quick.', 'conversation_full');

    const categories = consent.categories;
    const notShared = AGENT_CATEGORIES.filter(k => !categories.includes(k)).map(k => AGENT_CATEGORY_TEXT[k].title.toLowerCase());
    const today = new Date().toISOString().slice(0, 10);
    const context = [
      `Today is ${today}.`,
      `The app has ${profile.displayName}'s records open (profile_id ${profile.id}, ${profile.relationship === 'self' ? 'the account holder' : `their ${profile.relationship}`}). Tools use this profile unless you pass another profile_id.`,
      `Profiles in this account: ${all.map(p => `${p.displayName} (${p.relationship}, ${p.id})`).join('; ')}.`,
      notShared.length ? `The person has not shared these kinds of data with you: ${notShared.join('; ')}.` : 'The person has shared every kind of data with you.',
    ].join('\n');

    const labs = !!deps.labs?.forCell(c.var.cell);
    const grant = assistantGrant(user, all.map(p => p.id), categories);
    const ctx: ToolContext = { deps, cell: c.var.cell, user, grant, appUrl: `${publicOrigin(c, deps.config)}/app`, assistant: { defaultProfileId: profile.id } };
    const tools = toolsFor(grant.scopes, labs, categories);
    const history = rows.map(r => ({ role: r.role, content: r.content })) as Parameters<Assistant['reply']>[0]['history'];
    const userMsg = { role: 'user' as const, content: body.text };

    if (!conv) {
      [conv] = await db.insert(assistantConversations).values({ userId: user.id, profileId: profile.id, title: title(body.text) }).returning();
      await recordEvent(db, eventContext(c, deps), user.id, 'assistant_chat', { profileId: profile.id });
    }
    const conversation = conv;
    const abort = new AbortController();

    return streamSSE(c, async stream => {
      stream.onAbort(() => abort.abort());
      // Events go out in order, and the stream stays open until the last one is written.
      let queue = Promise.resolve();
      const send = (e: AssistantEvent) => { queue = queue.then(() => stream.writeSSE({ data: JSON.stringify(e) })).catch(() => {}); };
      send({ type: 'start', conversationId: conversation.id, title: conversation.title });
      try {
        const turn = await assistant.reply({ history: [...history, userMsg], context, tools, ctx, emit: send, signal: abort.signal });
        // The person's message and every message of the answer, in order; the reply's text and what it did go on the
        // last one, which is what the app shows.
        let seq = rows.length;
        const lastAssistant = turn.added.map(m => m.role).lastIndexOf('assistant');
        await db.insert(assistantMessages).values([
          { conversationId: conversation.id, seq: seq++, role: 'user', content: body.text, text: body.text },
          ...turn.added.map((m, i) => ({
            conversationId: conversation.id, seq: seq++, role: m.role as 'user' | 'assistant', content: m.content,
            text: i === lastAssistant ? turn.text.trim() || '…' : '',
            meta: i === lastAssistant ? { tools: turn.tools, organs: turn.organs, links: turn.links, wrote: turn.wrote, refused: turn.refused } : null,
          })),
        ]);
        await db.update(assistantConversations).set({ updatedAt: new Date() }).where(eq(assistantConversations.id, conversation.id));
        if (turn.wrote) send({ type: 'changed', profileId: profile.id });
        send({
          type: 'done',
          message: {
            id: conversation.id, role: 'assistant', text: turn.text.trim(), createdAt: new Date().toISOString(),
            ...(turn.tools.length ? { tools: turn.tools } : {}), ...(turn.organs.length ? { organs: turn.organs } : {}),
            ...(turn.links.length ? { links: turn.links } : {}), ...(turn.wrote ? { wrote: true } : {}), ...(turn.refused ? { refused: true } : {}),
          },
        });
      } catch (e) {
        if (abort.signal.aborted) return;
        // Nothing is stored for a failed answer, so the conversation stays as it was.
        send({ type: 'error', message: e instanceof AssistantError ? e.message : 'Something went wrong. Try again.' });
        if (!(e instanceof AssistantError)) console.error('[assistant] reply failed', e);
      } finally {
        await queue;
      }
    });
  });

  return app;
}
