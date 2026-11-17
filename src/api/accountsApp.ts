// Sign-in with LotusPond Accounts from the iOS and Android apps (RFC 8252): the app makes a PKCE pair, opens the
// server's /start page in the system browser, and gets back a one-time code on APP_ACCOUNTS_REDIRECT, which it trades
// with its verifier (src/api/http.ts, accountsAppExchange). No platform imports here, so this is tested in Node
// (tools/test-app-client.ts); the system browser and the return link are in src/native/accounts.ts.
import { APP_ACCOUNTS_REDIRECT, APP_LINK_PATH, type AccountsErrorCode } from '../../shared/identity';

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A PKCE verifier (32 random bytes) and its S256 challenge. */
export async function createPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge: b64url(digest) };
}

/** The page the system browser opens on the API host. */
export function appStartUrl(apiOrigin: string, intent: 'signup' | 'login', challenge: string): string {
  const q = new URLSearchParams({ intent, client: 'app', code_challenge: challenge });
  return `${apiOrigin.replace(/\/+$/, '')}/api/auth/accounts/start?${q}`;
}

/** `apiOrigin`: the regional host to trade the code at, when the account is held by another region's host. */
export type AppReturn = { code: string; apiOrigin?: string } | { error: AccountsErrorCode | string };

/** The code or error in a link that opened the app (the private-use scheme or an https app link), or null when the
 *  link is not a sign-in return. */
export function readAppReturn(url: string): AppReturn | null {
  let q: URLSearchParams;
  if (url.startsWith(`${APP_ACCOUNTS_REDIRECT}?`)) q = new URLSearchParams(url.slice(APP_ACCOUNTS_REDIRECT.length + 1));
  else {
    // An https app link: the OS hands the app only links on hosts it verified for this app.
    let parsed: URL;
    try { parsed = new URL(url); } catch { return null; }
    if (parsed.protocol !== 'https:' || parsed.pathname !== APP_LINK_PATH) return null;
    q = parsed.searchParams;
  }
  const code = q.get('code');
  const apiOrigin = q.get('api_origin');
  if (code) return apiOrigin ? { code, apiOrigin } : { code };
  return { error: q.get('error') || 'sign_in_failed' };
}
