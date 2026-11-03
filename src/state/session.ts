// Signed-in account, its profiles, and which profile is open.
import { create } from 'zustand';
import type { Account, Profile, ProfileInput, SessionInfo } from '../types';
import { backend } from '../api';
import { HttpBackend } from '../api/http';
import { useHealth } from '../lib/store';
import { useUI } from './ui';

type Status = 'loading' | 'signed-out' | 'signed-in' | 'offline';

interface SessionState {
  status: Status;
  account: Account | null;
  profiles: Profile[];
  activeId: string | null;
  /** True right after sign-up, until the person finishes or skips the setup step. */
  onboarding: boolean;
  /** Shown on the sign-in screen, e.g. after the session ended elsewhere. */
  notice: string | null;

  init: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (input: { displayName: string; email: string; password: string }) => Promise<void>;
  signOut: () => Promise<void>;
  sessionEnded: () => void;
  switchProfile: (id: string) => void;
  createProfile: (input: ProfileInput) => Promise<Profile>;
  saveProfile: (id: string, patch: Partial<ProfileInput>) => Promise<Profile>;
  deleteProfile: (id: string) => Promise<void>;
  finishOnboarding: () => void;
  deleteAccount: (password: string) => Promise<void>;
}

const activeKey = (accountId: string) => `lotuspond:active-profile:${accountId}`;

function remember(accountId: string, profileId: string): void {
  try { localStorage.setItem(activeKey(accountId), profileId); } catch { /* storage unavailable */ }
}

function recall(accountId: string): string | null {
  try { return localStorage.getItem(activeKey(accountId)); } catch { return null; }
}

export const useSession = create<SessionState>((set, get) => {
  function start(info: SessionInfo, onboarding = false) {
    const saved = recall(info.account.id);
    const activeId = info.profiles.find(p => p.id === saved)?.id ?? info.profiles[0]?.id ?? null;
    set({ status: 'signed-in', account: info.account, profiles: info.profiles, activeId, onboarding, notice: null });
    void useHealth.getState().openProfile(activeId);
  }

  function reset(notice: string | null = null) {
    set({ status: 'signed-out', account: null, profiles: [], activeId: null, onboarding: false, notice });
    void useHealth.getState().openProfile(null);
    useUI.getState().setView('body');
  }

  if (backend instanceof HttpBackend) {
    backend.onSessionEnded = () => {
      if (get().status === 'signed-in') reset('You were signed out. Sign in again to continue.');
    };
  }

  return {
    status: 'loading',
    account: null,
    profiles: [],
    activeId: null,
    onboarding: false,
    notice: null,

    init: async () => {
      try {
        const info = await backend.me();
        if (info) start(info);
        else set({ status: 'signed-out' });
      } catch {
        set({ status: 'offline' });
      }
    },

    signIn: async (email, password) => start(await backend.login({ email, password })),

    signUp: async input => start(await backend.register(input), true),

    signOut: async () => {
      try { await backend.logout(); } finally { reset(); }
    },

    sessionEnded: () => reset('You were signed out. Sign in again to continue.'),

    switchProfile: id => {
      const { account, activeId } = get();
      if (!account || id === activeId) return;
      remember(account.id, id);
      set({ activeId: id });
      void useHealth.getState().openProfile(id);
    },

    createProfile: async input => {
      const profile = await backend.createProfile(input);
      set(s => ({ profiles: [...s.profiles, profile] }));
      get().switchProfile(profile.id);
      return profile;
    },

    saveProfile: async (id, patch) => {
      const profile = await backend.updateProfile(id, patch);
      set(s => ({ profiles: s.profiles.map(p => (p.id === id ? profile : p)) }));
      return profile;
    },

    deleteProfile: async id => {
      await backend.deleteProfile(id);
      const profiles = get().profiles.filter(p => p.id !== id);
      set({ profiles });
      if (get().activeId === id) {
        const next = profiles.find(p => p.relationship === 'self') ?? profiles[0];
        set({ activeId: null });
        if (next) get().switchProfile(next.id);
      }
    },

    finishOnboarding: () => set({ onboarding: false }),

    deleteAccount: async password => {
      await backend.deleteAccount(password);
      reset('Your account and all of its records were deleted.');
    },
  };
});

/** How lab values are shown for this account (conventional mg/dL until the account says otherwise). */
export function useUnitSystem(): 'conventional' | 'si' {
  return useSession(s => s.account?.unitSystem ?? 'conventional');
}

/** The open profile. */
export function useActiveProfile(): Profile | null {
  return useSession(s => s.profiles.find(p => p.id === s.activeId) ?? null);
}

/** "Your" for the account holder, "Mira's" for others. */
export function possessive(p: Profile | null): string {
  if (!p || p.relationship === 'self') return 'Your';
  const first = p.displayName.split(/\s+/)[0];
  return first.endsWith('s') ? `${first}’` : `${first}’s`;
}

export function firstName(p: Profile | null): string {
  return p?.displayName.split(/\s+/)[0] ?? '';
}

/** Whole years between a yyyy-mm-dd birth date and today. */
export function ageFrom(dateOfBirth: string | null, today = new Date()): number | null {
  if (!dateOfBirth) return null;
  const [y, m, d] = dateOfBirth.split('-').map(Number);
  if (!y || !m || !d) return null;
  let age = today.getFullYear() - y;
  if (today.getMonth() + 1 < m || (today.getMonth() + 1 === m && today.getDate() < d)) age--;
  return age >= 0 && age < 150 ? age : null;
}

export const RELATIONSHIP_LABEL: Record<Profile['relationship'], string> = {
  self: 'You', partner: 'Partner', child: 'Child', parent: 'Parent', sibling: 'Sibling', other: 'Family member',
};
