// LotusPond's own assistant: a chat in the app (and later on WhatsApp) with an agent that reads and adds to the
// records through the same tools connected agents use (server/src/agents/tools.ts). It runs on Claude, so each turn
// sends the parts of the records it needs to Anthropic: the person agrees to that once, choosing the kinds of data,
// and can withdraw on Account. docs/assistant.md has the details.
import type { AgentCategory } from './agents.ts';

/** Version of the notice shown before the first chat. A newer version asks again. */
export const ASSISTANT_NOTICE_VERSION = '2026-11-11';

export const ASSISTANT_NAME = 'LotusPond assistant';

export interface AssistantConsent {
  granted: boolean;
  version: string;
  /** The kinds of data it may read (the basics of each profile are always shared). */
  categories: AgentCategory[];
  at: string;
}

export interface AssistantConversationSummary {
  id: string;
  profileId: string;
  title: string;
  updatedAt: string;
}

export interface AssistantLink { label: string; url: string }

/** One message as the app shows it. */
export interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Tools it used, by title ("Lab results"), organs it pointed to on the body, links it proposed. */
  tools?: string[];
  organs?: string[];
  links?: AssistantLink[];
  /** It added something to the records in this answer. */
  wrote?: boolean;
  refused?: boolean;
  createdAt: string;
}

export interface AssistantInfo {
  /** False when the server has no Anthropic credentials or ASSISTANT=off. */
  enabled: boolean;
  noticeVersion: string;
  consent: AssistantConsent | null;
  conversations: AssistantConversationSummary[];
}

/** What the server streams while the assistant answers (server-sent events, one JSON object per event). */
export type AssistantEvent =
  | { type: 'start'; conversationId: string; title: string }
  | { type: 'text'; delta: string }
  /** It is using a tool: shown as "Looking at lab results…". */
  | { type: 'tool'; name: string; title: string; writes?: boolean }
  /** It points to an organ: the app shows it on the body. */
  | { type: 'organ'; organ: string }
  | { type: 'link'; label: string; url: string }
  /** It added something to the records (the app reloads them). */
  | { type: 'changed'; profileId: string }
  | { type: 'done'; message: AssistantMessage }
  | { type: 'error'; message: string };

/** Longest message the person can send. */
export const ASSISTANT_MAX_INPUT = 4000;
/** Turns kept in one conversation; after that the app offers a new one. */
export const ASSISTANT_MAX_TURNS = 40;
