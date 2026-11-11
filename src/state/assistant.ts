// The chat with LotusPond's assistant (shared/assistant.ts): whether it is open, the conversation, and the answer
// streaming in. The panel is src/components/chat/AssistantPanel.tsx.
import { create } from 'zustand';
import { backend, errorMessage } from '../api';
import type { AgentCategory } from '../../shared/agents';
import type { AssistantInfo, AssistantLink, AssistantMessage } from '../../shared/assistant';
import { useHealth } from '../lib/store';
import { useUI } from './ui';
import type { OrganId } from '../types';

/** The answer being written: its text so far, what it is doing, and what it pointed to. */
export interface LiveAnswer { text: string; doing: string | null; tools: string[]; organs: string[]; links: AssistantLink[]; wrote?: boolean }

interface AssistantState {
  info: AssistantInfo | null;
  open: boolean;
  conversationId: string | null;
  messages: AssistantMessage[];
  live: LiveAnswer | null;
  error: string | null;
  /** Text typed before the chat could send it (before agreeing to the notice). */
  draft: string;
  /** The profile the current conversation is about. */
  forProfile: string | null;
  load: () => Promise<void>;
  setOpen: (open: boolean) => void;
  agree: (categories: AgentCategory[]) => Promise<void>;
  newChat: () => void;
  openConversation: (id: string) => Promise<void>;
  send: (profileId: string, text: string) => Promise<void>;
  stop: () => void;
}

let controller: AbortController | null = null;

/** Show an organ the assistant pointed to on the body map. */
function showOrgan(organ: string) {
  useUI.getState().setView('body');
  useHealth.getState().selectOrgan(organ as OrganId);
}

export const useAssistant = create<AssistantState>()((set, get) => ({
  info: null,
  open: false,
  conversationId: null,
  messages: [],
  live: null,
  error: null,
  draft: '',
  forProfile: null,

  load: async () => {
    try { set({ info: await backend.assistantInfo() }); } catch { /* not signed in yet, or offline: the button stays hidden */ }
  },
  setOpen: open => { set({ open }); if (open && !get().info) void get().load(); },

  agree: async categories => {
    const consent = await backend.agreeToAssistant(categories);
    set(s => ({ info: s.info && { ...s.info, consent } }));
  },

  newChat: () => { get().stop(); set({ conversationId: null, messages: [], live: null, error: null }); },

  openConversation: async id => {
    get().stop();
    try {
      const c = await backend.assistantConversation(id);
      set({ conversationId: c.id, messages: c.messages, live: null, error: null, forProfile: c.profileId });
    } catch (e) { set({ error: errorMessage(e) }); }
  },

  send: async (profileId, text) => {
    if (get().live) return;
    // A conversation is about one profile: switching profiles starts a new one.
    if (get().forProfile && get().forProfile !== profileId) set({ conversationId: null, messages: [], error: null });
    set({ forProfile: profileId });
    const mine: AssistantMessage = { id: `local-${Date.now()}`, role: 'user', text, createdAt: new Date().toISOString() };
    set(s => ({ messages: [...s.messages, mine], live: { text: '', doing: 'Thinking…', tools: [], organs: [], links: [] }, error: null }));
    controller = new AbortController();
    const patch = (p: Partial<LiveAnswer>) => set(s => ({ live: s.live && { ...s.live, ...p } }));
    try {
      await backend.sendToAssistant({ profileId, conversationId: get().conversationId ?? undefined, text }, e => {
        const live = get().live;
        switch (e.type) {
          case 'start':
            set(s => ({ conversationId: e.conversationId, info: s.info && !s.info.conversations.some(c => c.id === e.conversationId)
              ? { ...s.info, conversations: [{ id: e.conversationId, profileId, title: e.title, updatedAt: new Date().toISOString() }, ...s.info.conversations] }
              : s.info }));
            break;
          case 'text': patch({ text: (live?.text ?? '') + e.delta, doing: null }); break;
          case 'tool': patch(e.writes ? { doing: 'Saving to your records…', wrote: true } : { doing: `Looking at ${e.title.toLowerCase()}…`, tools: [...(live?.tools ?? []), e.title] }); break;
          case 'organ': patch({ organs: [...(live?.organs ?? []), e.organ] }); showOrgan(e.organ); break;
          case 'link': patch({ links: [...(live?.links ?? []), { label: e.label, url: e.url }] }); break;
          case 'changed':
            if (useHealth.getState().profileId === e.profileId) void useHealth.getState().openProfile(e.profileId);
            // The bell checks at once instead of at its next minute.
            window.dispatchEvent(new Event('lotuspond:notifications'));
            break;
          case 'done': set(s => ({ messages: [...s.messages, { ...e.message, id: `a-${Date.now()}` }], live: null })); break;
          case 'error': set({ live: null, error: e.message }); break;
        }
      }, controller.signal);
      // The stream ended without a final event (connection dropped).
      if (get().live) set({ live: null, error: 'The answer was cut off. Try again.' });
    } catch (e) {
      set({ live: null, error: errorMessage(e) });
    } finally {
      controller = null;
    }
  },

  stop: () => { controller?.abort(); controller = null; set(s => (s.live ? { live: null, messages: s.live.text ? [...s.messages, { id: `a-${Date.now()}`, role: 'assistant', text: `${s.live.text} …`, createdAt: new Date().toISOString() }] : s.messages } : {})); },
}));
