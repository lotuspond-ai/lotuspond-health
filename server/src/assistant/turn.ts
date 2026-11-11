// One turn with the assistant, wherever the person writes from (the app's chat, or WhatsApp): build the per-turn
// context and tools from what they agreed to share, run the model, and append the turn to the conversation.
import { and, asc, desc, eq } from 'drizzle-orm';
import { AGENT_CATEGORIES, AGENT_CATEGORY_TEXT, type AgentCategory } from '../../../shared/agents.ts';
import { ASSISTANT_NAME, type AssistantConsent, type AssistantEvent } from '../../../shared/assistant.ts';
import { assistantConversations, assistantMessages, consents, profiles, type AgentGrantRow, type AssistantConversationRow, type AssistantMessageRow, type ProfileRow, type UserRow } from '../db/schema.ts';
import type { Db } from '../db/client.ts';
import type { Cell } from '../cells.ts';
import type { Deps } from '../http.ts';
import { relationshipOrder } from '../routes/profiles.ts';
import { cleanCategories } from '../agents/grants.ts';
import { toolsFor, type ToolContext } from '../agents/tools.ts';
import type { Assistant, AssistantTurn } from './agent.ts';

export async function assistantConsent(db: Db, userId: string): Promise<AssistantConsent | null> {
  const [row] = await db.select().from(consents).where(and(eq(consents.userId, userId), eq(consents.kind, 'assistant')))
    .orderBy(desc(consents.createdAt), desc(consents.id)).limit(1);
  if (!row) return null;
  return { granted: row.granted, version: row.version, categories: cleanCategories(row.detail?.categories ?? []), at: row.createdAt.toISOString() };
}

/** The assistant acts like a connection that sees every profile of the account, with the kinds of data agreed to. */
function assistantGrant(user: UserRow, profileIds: string[], categories: AgentCategory[]): AgentGrantRow {
  return {
    id: user.id, userId: user.id, kind: 'token', clientId: null, name: ASSISTANT_NAME, redirectHost: null,
    scopes: ['health:read', 'health:write'], categories, profileIds,
    createdAt: new Date(), lastUsedAt: null, lastLoggedAt: null, expiresAt: null,
  };
}

export const conversationTitle = (text: string) => { const t = text.replace(/\s+/g, ' ').trim(); return t.length > 60 ? `${t.slice(0, 57)}…` : t; };

export async function accountProfiles(db: Db, userId: string): Promise<ProfileRow[]> {
  return (await db.select().from(profiles).where(eq(profiles.userId, userId))).sort(relationshipOrder);
}

export async function conversationMessages(db: Db, conversationId: string): Promise<AssistantMessageRow[]> {
  return db.select().from(assistantMessages).where(eq(assistantMessages.conversationId, conversationId)).orderBy(asc(assistantMessages.seq));
}

export const userTurns = (rows: AssistantMessageRow[]) => rows.filter(r => r.role === 'user' && r.text).length;

export interface TurnInput {
  deps: Deps;
  assistant: Assistant;
  cell: Cell;
  user: UserRow;
  consent: AssistantConsent;
  /** Every profile of the account, and the one the conversation works on. */
  all: ProfileRow[];
  profile: ProfileRow;
  conversation: AssistantConversationRow;
  /** The conversation so far, as stored. */
  rows: AssistantMessageRow[];
  text: string;
  /** Where links in answers point (the app). */
  appUrl: string;
  emit: (e: AssistantEvent) => void;
  signal?: AbortSignal;
}

/** Run one turn and store it. Nothing is stored when it fails, so the conversation stays as it was. */
export async function runTurn(t: TurnInput): Promise<AssistantTurn> {
  const { deps, cell, user, profile, all, conversation, rows } = t;
  const whatsapp = conversation.channel === 'whatsapp';
  const categories = t.consent.categories;
  const notShared = AGENT_CATEGORIES.filter(k => !categories.includes(k)).map(k => AGENT_CATEGORY_TEXT[k].title.toLowerCase());
  const today = new Date().toISOString().slice(0, 10);
  const context = [
    `Today is ${today}.`,
    whatsapp
      ? `The person is writing on WhatsApp from their linked number. The conversation works on ${profile.displayName}'s records (profile_id ${profile.id}, ${profile.relationship === 'self' ? 'the account holder' : `their ${profile.relationship}`}) unless you pass another profile_id. There is no body map here, and WhatsApp shows plain text: use *single asterisks* for bold, short lines, and no headings or tables. Keep answers short. Links you give open the LotusPond app. If they send a report, it is saved to the files for them to check in the app.`
      : `The app has ${profile.displayName}'s records open (profile_id ${profile.id}, ${profile.relationship === 'self' ? 'the account holder' : `their ${profile.relationship}`}). Tools use this profile unless you pass another profile_id.`,
    `Profiles in this account: ${all.map(p => `${p.displayName} (${p.relationship}, ${p.id})`).join('; ')}.`,
    notShared.length ? `The person has not shared these kinds of data with you: ${notShared.join('; ')}.` : 'The person has shared every kind of data with you.',
  ].join('\n');

  const labs = !!deps.labs?.forCell(cell);
  const grant = assistantGrant(user, all.map(p => p.id), categories);
  const ctx: ToolContext = { deps, cell, user, grant, appUrl: t.appUrl, assistant: { defaultProfileId: profile.id } };
  const tools = toolsFor(grant.scopes, labs, categories);
  const history = rows.map(r => ({ role: r.role, content: r.content })) as Parameters<Assistant['reply']>[0]['history'];

  const turn = await t.assistant.reply({
    history: [...history, { role: 'user', content: t.text }], context, tools, ctx, emit: t.emit, signal: t.signal, bodyMap: !whatsapp,
  });
  // The person's message and every message of the answer, in order; the reply's text and what it did go on the last
  // one, which is what the app shows.
  let seq = rows.length;
  const lastAssistant = turn.added.map(m => m.role).lastIndexOf('assistant');
  await cell.db.insert(assistantMessages).values([
    { conversationId: conversation.id, seq: seq++, role: 'user', content: t.text, text: t.text },
    ...turn.added.map((m, i) => ({
      conversationId: conversation.id, seq: seq++, role: m.role as 'user' | 'assistant', content: m.content,
      text: i === lastAssistant ? turn.text.trim() || '…' : '',
      meta: i === lastAssistant ? { tools: turn.tools, organs: turn.organs, links: turn.links, wrote: turn.wrote, refused: turn.refused } : null,
    })),
  ]);
  await cell.db.update(assistantConversations).set({ updatedAt: new Date() }).where(eq(assistantConversations.id, conversation.id));
  return turn;
}
