// Eka Care's ABDM Connect API (docs/abdm.md §Eka): LotusPond reaches India's health records network through Eka,
// which holds the ABDM gateway connection, its callbacks and its encryption. Every call goes from this server to Eka,
// with LotusPond's client token; a call for a person also names their Eka id (oid), which Eka keys their ABHA
// gateway session to.
//
//   https://api.eka.care for clients made in the Eka console, sandbox or production: the client decides which NHA
//   environment it reaches (a console sandbox client is refused at api.dev.eka.care).
//
// Client token: POST /connect-auth/v1/account/login { client_id, client_secret } → access_token (about 30 minutes)
// and refresh_token. It is kept in memory, renewed before it runs out, and renewed once more on a 401.
// A 491 means the person's ABHA gateway session has ended: EkaSessionError, and the caller asks for a new OTP.
import { setTimeout as sleep } from 'node:timers/promises';

export const EKA_SANDBOX_URL = 'https://api.dev.eka.care';
export const EKA_PRODUCTION_URL = 'https://api.eka.care';

export interface EkaOptions {
  apiUrl: string;
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/** Eka (or ABDM behind it) refused a call. `code` is ABDM's own code ("ABDM-1100") when the gateway refused. */
export class EkaError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, message: string, code: string | null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** HTTP 491: the person's ABHA gateway session ended; a mobile OTP renews it. */
export class EkaSessionError extends EkaError {}

interface Call {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** The person the call is for: sent as X-Pt-Id and ?oid= (Eka's examples send both). */
  oid?: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
}

export interface Eka {
  call<T = Record<string, unknown>>(path: string, opts?: Call): Promise<T>;
}

/** Eka's error body: { code, error, source_error: { code, message } }. */
function errorOf(status: number, body: unknown): EkaError {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const src = (b.source_error && typeof b.source_error === 'object' ? b.source_error : {}) as Record<string, unknown>;
  const message = String(src.message ?? b.error ?? b.message ?? `Eka answered ${status}`);
  const code = typeof src.code === 'string' ? src.code : null;
  return status === 491 ? new EkaSessionError(status, message, code) : new EkaError(status, message, code);
}

export function createEka(o: EkaOptions): Eka {
  const f = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const base = o.apiUrl.replace(/\/+$/, '');
  let token: { access: string; refresh: string; renewAt: number; refreshUntil: number } | null = null;
  let pending: Promise<string> | null = null;

  async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    const res = await f(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw errorOf(res.status, json);
    return json as { access_token: string; refresh_token: string; expires_in: number; refresh_expires_in: number };
  }

  function keep(t: Awaited<ReturnType<typeof post>>) {
    const at = now();
    // Renew at 80% of the access token's life; the refresh token is used only while it lasts.
    token = { access: t.access_token, refresh: t.refresh_token, renewAt: at + Math.max(30, t.expires_in) * 800, refreshUntil: at + Math.max(0, t.refresh_expires_in - 30) * 1000 };
    return t.access_token;
  }

  async function signIn(): Promise<string> {
    if (token && now() < token.renewAt) return token.access;
    if (pending) return pending;
    pending = (async () => {
      try {
        if (token && now() < token.refreshUntil) {
          try {
            return keep(await post('/connect-auth/v1/account/refresh-token', { access_token: token.access, refresh_token: token.refresh }, { Authorization: `Bearer ${token.access}`, 'Client-Id': o.clientId }));
          } catch { /* sign in afresh */ }
        }
        return keep(await post('/connect-auth/v1/account/login', { client_id: o.clientId, client_secret: o.clientSecret }));
      } finally {
        pending = null;
      }
    })();
    return pending;
  }

  return {
    async call<T>(path: string, c: Call = {}): Promise<T> {
      const url = new URL(`${base}${path}`);
      for (const [k, v] of Object.entries({ ...c.query, ...(c.oid ? { oid: c.oid } : {}) })) if (v !== undefined) url.searchParams.set(k, v);
      for (let attempt = 0; ; attempt++) {
        const access = await signIn();
        const res = await f(url, {
          method: c.method ?? (c.body === undefined ? 'GET' : 'POST'),
          headers: {
            Authorization: `Bearer ${access}`, Accept: 'application/json',
            ...(c.oid ? { 'X-Pt-Id': c.oid } : {}),
            ...(c.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(c.body !== undefined ? { body: JSON.stringify(c.body) } : {}),
          signal: AbortSignal.timeout(30_000),
        });
        if (res.status === 401 && attempt === 0) { token = null; continue; }
        // Rate limited by the gateway: one short wait, then give up.
        if (res.status === 429 && attempt === 0) { await sleep(2000); continue; }
        const text = await res.text();
        let json: unknown = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        if (!res.ok) throw errorOf(res.status, json);
        // Several of Eka's calls answer 204 (sometimes with a body): an empty object then.
        return (json ?? {}) as T;
      }
    },
  };
}
