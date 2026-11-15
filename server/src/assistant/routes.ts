// LotusPond's assistant in the app (shared/assistant.ts):
//   GET    /api/assistant                     whether it is on, the person's consent, their conversations
//   POST   /api/assistant/consent             agree, with the kinds of data it may read ({ noticeVersion, categories })
//   DELETE /api/assistant/consent             withdraw: the assistant stops until they agree again
//   GET    /api/assistant/conversations/:id   a conversation's messages
//   DELETE /api/assistant/conversations/:id   delete a conversation
//   POST   /api/assistant/messages            send a message ({ profileId, conversationId?, text }); the answer is
//                                             streamed as server-sent events (AssistantEvent)
import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { AGENT_CATEGORIES } from '../../../shared/agents.ts';
import {
  ASSISTANT_MAX_INPUT, ASSISTANT_MAX_TURNS, ASSISTANT_NOTICE_VERSION,
  type AssistantEvent, type AssistantInfo, type AssistantMessage,
} from '../../../shared/assistant.ts';
import { eventContext, recordEvent } from '../compliance/audit.ts';
import { recordConsents } from '../compliance/consents.ts';
import { assistantConversations, type AssistantMessageRow } from '../db/schema.ts';
import { conflict, HttpError, notFound, tooMany } from '../lib/errors.ts';
import { RateLimiter } from '../lib/rate-limit.ts';
import { readJson, requireAuth, UUID, type AppEnv, type Deps } from '../http.ts';
import { cleanCategories } from '../agents/grants.ts';
import { publicOrigin } from '../agents/oauth.ts';
import { AssistantError, type Assistant } from './agent.ts';
import { accountProfiles, assistantConsent, conversationMessages, conversationTitle, runTurn, userTurns } from './turn.ts';

export { assistantConsent };

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

const toMessage = (r: AssistantMessageRow): AssistantMessage => ({
  id: r.id, role: r.role, text: r.text, createdAt: r.createdAt.toISOString(),
  ...(r.meta?.tools?.length ? { tools: r.meta.tools } : {}),
  ...(r.meta?.organs?.length ? { organs: r.meta.organs } : {}),
  ...(r.meta?.links?.length ? { links: r.meta.links } : {}),
  ...(r.meta?.wrote ? { wrote: true } : {}),
  ...(r.meta?.refused ? { refused: true } : {}),
});

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
      conversations: rows.map(r => ({ id: r.id, profileId: r.profileId, title: r.title, updatedAt: r.updatedAt.toISOString(), ...(r.channel === 'whatsapp' ? { channel: 'whatsapp' as const } : {}) })),
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
    const rows = await conversationMessages(db, id);
    return c.json({ id: conv.id, profileId: conv.profileId, title: conv.title, ...(conv.channel === 'whatsapp' ? { channel: 'whatsapp' } : {}), messages: rows.filter(r => r.text).map(toMessage) });
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

    const all = await accountProfiles(db, user.id);
    const profile = all.find(p => p.id === body.profileId);
    if (!profile) throw notFound('That profile');

    let conv = body.conversationId
      ? (await db.select().from(assistantConversations).where(and(eq(assistantConversations.id, body.conversationId), eq(assistantConversations.userId, user.id))).limit(1))[0]
      : undefined;
    if (body.conversationId && !conv) throw notFound('That conversation');
    // WhatsApp conversations are read in the app; they carry on from WhatsApp only.
    if (conv?.channel === 'whatsapp') throw conflict('This conversation happens on WhatsApp. Start a new chat here.', 'whatsapp_conversation');
    const rows = conv ? await conversationMessages(db, conv.id) : [];
    if (userTurns(rows) >= ASSISTANT_MAX_TURNS) throw conflict('This conversation is long. Start a new one to keep answers quick.', 'conversation_full');

    if (!conv) {
      [conv] = await db.insert(assistantConversations).values({ userId: user.id, profileId: profile.id, title: conversationTitle(body.text) }).returning();
      await recordEvent(db, eventContext(c, deps), user.id, 'assistant_chat', { profileId: profile.id });
    }
    const conversation = conv;
    const appUrl = `${publicOrigin(c, deps.config)}/app`;
    const abort = new AbortController();

    return streamSSE(c, async stream => {
      stream.onAbort(() => abort.abort());
      // Events go out in order, and the stream stays open until the last one is written.
      let queue = Promise.resolve();
      const send = (e: AssistantEvent) => { queue = queue.then(() => stream.writeSSE({ data: JSON.stringify(e) })).catch(() => {}); };
      send({ type: 'start', conversationId: conversation.id, title: conversation.title });
      try {
        const turn = await runTurn({
          deps, assistant, cell: c.var.cell, user, consent, all, profile, conversation, rows, text: body.text, appUrl, emit: send, signal: abort.signal,
        });
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
