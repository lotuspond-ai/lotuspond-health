// Sign-in with LotusPond Accounts in the iOS and Android apps: the system browser (Custom Tabs on Android,
// SFSafariViewController on iOS) runs the sign-in, never the app's own web view (RFC 8252), and hands a one-time code
// back on APP_ACCOUNTS_REDIRECT. The PKCE verifier stays in the app until then.
import { Browser } from '@capacitor/browser';
import { backend, errorMessage } from '../api';
import { createPkce, readAppReturn } from '../api/accountsApp';
import { ACCOUNTS_ERRORS } from '../../shared/identity';
import { useSession } from '../state/session';

const VERIFIER_KEY = 'lotuspond:accounts-verifier';
let verifier: string | null = null;

/** Open the system browser on the server's sign-in with LotusPond Accounts. */
export async function startAccountsSignIn(intent: 'signup' | 'login'): Promise<void> {
  if (!backend.accountsAppStartUrl) throw new Error('Sign-in with LotusPond Accounts needs the LotusPond server.');
  const pkce = await createPkce();
  verifier = pkce.verifier;
  // Kept for the session too, in case the web view reloads while the browser is open (it is never sent anywhere
  // but the server, and is useless without the one-time code).
  try { sessionStorage.setItem(VERIFIER_KEY, pkce.verifier); } catch { /* storage unavailable */ }
  await Browser.open({ url: await backend.accountsAppStartUrl(intent, pkce.challenge), presentationStyle: 'popover' });
}

/** Sign out of LotusPond Accounts in the system browser, after Health's own sign-out (src/state/session.ts). */
export async function openAccountsSignOut(url: string): Promise<void> {
  await Browser.open({ url, presentationStyle: 'popover' }).catch(() => { /* no browser: Health's session has ended anyway */ });
}

/** A link opened the app: if it is the sign-in coming back, finish it. True when it was one. */
export function handleAccountsReturn(url: string): boolean {
  const back = readAppReturn(url);
  if (!back) return false;
  void Browser.close().catch(() => { /* already closed, or Android, where the tab closes itself */ });
  let kept = verifier;
  try { kept ??= sessionStorage.getItem(VERIFIER_KEY); sessionStorage.removeItem(VERIFIER_KEY); } catch { /* storage unavailable */ }
  verifier = null;
  const session = useSession.getState();
  if ('signedOut' in back) {
    session.showNotice('You are signed out of LotusPond Health and your LotusPond account.');
    return true;
  }
  if ('error' in back) {
    session.showNotice((ACCOUNTS_ERRORS as Record<string, string>)[back.error] ?? ACCOUNTS_ERRORS.sign_in_failed);
    return true;
  }
  if (!kept) { session.showNotice(ACCOUNTS_ERRORS.expired); return true; }
  void session.accountsAppExchange(back.code, kept, back.apiOrigin).catch(e => session.showNotice(errorMessage(e).replace(/^\w+: /, '')));
  return true;
}
