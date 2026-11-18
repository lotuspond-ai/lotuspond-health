// Signed-in account, its profiles, and which profile is open.
import { create } from 'zustand';
import type { Account, ConsentKind, FamilyConfirmation, Profile, ProfileInput, RegisterInput, ServiceInfo, SessionInfo } from '../types';
import { backend, inApp } from '../api';
import { HttpBackend } from '../api/http';
import { useHealth } from '../lib/store';
import { enterApp, leaveApp, oauthReturn } from '../site/links';
import { readAgentProposal, useLab } from './lab';
import { readReviewLink, useUI } from './ui';
import { countryPolicy } from '../../shared/regions';

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
  /** Regions this server holds records for, and its published contacts. Loaded with the session. */
  service: ServiceInfo | null;

  init: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (input: RegisterInput) => Promise<void>;
  /** Finish sign-up after LotusPond Accounts (see Backend.completeAccountsSignUp). */
  completeAccountsSignUp: (input: Omit<RegisterInput, 'email' | 'password'>) => Promise<void>;
  /** The apps: a sign-up with LotusPond Accounts waiting for Health's own questions (the sign-in screen shows them). */
  accountsPending: boolean;
  /** The apps: trade the one-time code the system browser handed back (src/native/accounts.ts). */
  accountsAppExchange: (code: string, verifier: string, apiOrigin?: string) => Promise<void>;
  /** Show a message on the sign-in screen. */
  showNotice: (notice: string) => void;
  signOut: () => Promise<void>;
  sessionEnded: () => void;
  switchProfile: (id: string) => void;
  createProfile: (input: ProfileInput, confirmation: FamilyConfirmation) => Promise<Profile>;
  /** Required consents given for older texts; the app asks to accept the current ones. */
  consentsOutdated: ConsentKind[];
  acceptUpdatedTexts: () => Promise<void>;
  /** Put an updated profile (from the server) in place, e.g. after undoing an agent's addition. */
  replaceProfile: (profile: Profile) => void;
  saveProfile: (id: string, patch: Partial<ProfileInput>) => Promise<Profile>;
  deleteProfile: (id: string) => Promise<void>;
  finishOnboarding: () => void;
  deleteAccount: (password: string) => Promise<void>;
  setUnitSystem: (unitSystem: 'conventional' | 'si') => Promise<void>;
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
    // Signing in to connect an agent: go back to its consent page (agents/oauth.ts) instead of opening the app.
    const back = oauthReturn();
    if (back) { location.assign(back); return; }
    const proposal = readAgentProposal();
    const review = readReviewLink();
    const linked = review?.profileId ?? proposal?.profileId;
    const saved = linked && info.profiles.some(p => p.id === linked) ? linked : recall(info.account.id);
    if (proposal) useLab.getState().setProposal(proposal);
    const activeId = info.profiles.find(p => p.id === saved)?.id ?? info.profiles[0]?.id ?? null;
    set({ status: 'signed-in', account: info.account, profiles: info.profiles, activeId, onboarding, notice: null, consentsOutdated: info.consentsOutdated ?? [] });
    enterApp();
    void useHealth.getState().openProfile(activeId);
    if (review && review.profileId === activeId) useUI.getState().openReview(review);
  }

  function reset(notice: string | null = null) {
    set({ status: 'signed-out', account: null, profiles: [], activeId: null, onboarding: false, notice, consentsOutdated: [], accountsPending: false });
    void useHealth.getState().openProfile(null);
    useUI.getState().setView('home');
    leaveApp();
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
    service: null,

    init: async () => {
      // Service facts are optional: without them sign-up assumes every region is served and the server decides.
      void backend.service().then(service => set({ service }), () => {});
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

    completeAccountsSignUp: async input => {
      if (!backend.completeAccountsSignUp) throw new Error('Sign-in with LotusPond Accounts needs the LotusPond server.');
      start(await backend.completeAccountsSignUp(input), true);
      set({ accountsPending: false });
    },

    accountsPending: false,

    accountsAppExchange: async (code, verifier, apiOrigin) => {
      if (!backend.accountsAppExchange) throw new Error('Sign-in with LotusPond Accounts needs the LotusPond server.');
      const r = await backend.accountsAppExchange(code, verifier, apiOrigin);
      if ('session' in r) start(r.session);
      else set({ accountsPending: true, notice: null });
    },

    showNotice: notice => set({ notice }),

    signOut: async () => {
      let next: string | undefined;
      try { next = (await backend.logout())?.accountsSignOut; } finally { reset(); }
      // Signed in with LotusPond Accounts: sign out there too. The website goes there and comes back to the sign-in
      // page; the apps open it in the system browser, where their Accounts sign-in is (src/native/accounts.ts).
      if (!next) return;
      if (inApp) void import('../native/accounts').then(m => m.openAccountsSignOut(next));
      else location.assign(next);
    },

    sessionEnded: () => reset('You were signed out. Sign in again to continue.'),

    switchProfile: id => {
      const { account, activeId } = get();
      if (!account || id === activeId) return;
      remember(account.id, id);
      set({ activeId: id });
      void useHealth.getState().openProfile(id);
    },

    consentsOutdated: [],

    acceptUpdatedTexts: async () => {
      for (const kind of get().consentsOutdated) await backend.setConsent(kind, true);
      set({ consentsOutdated: [] });
    },

    createProfile: async (input, confirmation) => {
      const profile = await backend.createProfile(input, confirmation);
      set(s => ({ profiles: [...s.profiles, profile] }));
      get().switchProfile(profile.id);
      return profile;
    },

    replaceProfile: profile => set(s => ({ profiles: s.profiles.map(p => (p.id === profile.id ? profile : p)) })),

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

    setUnitSystem: async unitSystem => {
      const account = await backend.updatePreferences({ unitSystem });
      set(s => ({ account: s.account ? { ...s.account, ...account } : account }));
    },
  };
});

/** How lab values are shown for this account (conventional mg/dL until the account says otherwise). */
export function useUnitSystem(): 'conventional' | 'si' {
  return useSession(s => s.account?.unitSystem ?? 'conventional');
}

/** Height and weight entry: feet, inches and pounds where the account's country uses them, otherwise cm and kg. */
export function useMeasurementSystem(): 'metric' | 'us' {
  return useSession(s => (s.account?.country ? countryPolicy(s.account.country).measurement : 'metric'));
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
