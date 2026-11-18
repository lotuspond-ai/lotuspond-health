// Sign-in through LotusPond Accounts (docs/identity.md): what the server and the sign-in page share.

/** Short messages for the sign-in page, by the code in `?accounts_error=`. */
export const ACCOUNTS_ERRORS = {
  cancelled: 'Sign-in with LotusPond Accounts was cancelled.',
  expired: 'That sign-in took too long or was started in another browser. Try again.',
  enterprise_account: 'This LotusPond account is managed by a company. LotusPond Health needs your personal account, so that no employer can manage the account that holds your health records.',
  email_unverified: 'Confirm your email address at LotusPond Accounts first, then sign in again.',
  already_linked: 'This LotusPond Health account is already linked to a different LotusPond account.',
  wrong_region: 'Your LotusPond account is held in a region this server does not serve.',
  sign_in_failed: 'LotusPond Accounts could not complete the sign-in. Try again.',
} as const satisfies Record<string, string>;

export type AccountsErrorCode = keyof typeof ACCOUNTS_ERRORS;

/** The iOS bundle id and Android package name. */
export const APP_ID = 'ai.lotuspond.health';

/**
 * Where the system browser hands a sign-in back to the iOS and Android apps (RFC 8252, a private-use URI scheme
 * named after the app id). Registered in android/app/src/main/AndroidManifest.xml and ios/App/App/Info.plist.
 */
export const APP_ACCOUNTS_REDIRECT = `${APP_ID}:/accounts`;

/**
 * The same return as an https link the apps claim (universal links on iOS, verified app links on Android), on a host
 * of its own: iOS keeps a link in the browser when it stays on the domain the browser is already showing, and the
 * sign-in runs on health.lotuspond.ai. The host is APP_LINKS_ORIGIN on the server and is named in
 * ios/App/App/App.entitlements and android/app/src/main/AndroidManifest.xml.
 */
export const APP_LINKS_HOST = 'open.health.lotuspond.ai';
export const APP_LINK_PATH = '/accounts-return';

/**
 * Where to go after signing in: an agent's consent page when an agent sent the person to approve a connection
 * (/oauth/authorize?…), or the developer console in the app (CONSOLE_PATH). Only these, so the parameter cannot send
 * anyone elsewhere. Null for anything else.
 */
export function agentConsentNext(next: string | null | undefined): string | null {
  if (next === CONSOLE_PATH) return next;
  return next && /^\/oauth\/authorize\?[^\\]*$/.test(next) && !next.includes('//') ? next : null;
}

/** The developer console: a page of the app, opened with the Health sign-in (src/pages/Console.tsx). */
export const CONSOLE_PATH = '/app#console';

/** Where the website starts a sign-in through LotusPond Accounts; `next` brings an agent's consent page back after. */
export const accountsStartPath = (intent: 'signup' | 'login', next?: string | null) =>
  `/api/auth/accounts/start?${new URLSearchParams({ intent, ...(agentConsentNext(next) ? { next: next! } : {}) })}`;
