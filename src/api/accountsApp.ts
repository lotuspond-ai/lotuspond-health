// Sign-in with LotusPond Accounts from the iOS and Android apps (RFC 8252): the app makes a PKCE pair, opens the
// server's /start page in the system browser, and gets back a one-time code on APP_ACCOUNTS_REDIRECT, which it trades
// with its verifier (src/api/http.ts, accountsAppExchange). No platform imports here, so this is tested in Node
// (tools/test-app-client.ts); the system browser and the return link are in src/native/accounts.ts.
import { APP_ACCOUNTS_REDIRECT, type AccountsErrorCode } from '../../shared/identity';

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

export type AppReturn = { code: string } | { error: AccountsErrorCode | string };

/** The code or error in a link the system browser opened, or null when the link is not a sign-in return. */
export function readAppReturn(url: string): AppReturn | null {
  if (!url.startsWith(`${APP_ACCOUNTS_REDIRECT}?`)) return null;
  const q = new URLSearchParams(url.slice(APP_ACCOUNTS_REDIRECT.length + 1));
  const code = q.get('code');
  if (code) return { code };
  return { error: q.get('error') || 'sign_in_failed' };
}
