// Sources behind standard OAuth 2 (authorization code with the client secret): the person signs in on the provider's
// page, LotusPond keeps the tokens sealed, and each check refreshes the access token when it has run out. Providers
// that rotate refresh tokens (Oura, Ultrahuman, Microsoft) accept each one only once, so the new one is kept at once;
// providers that don't (Google) keep sending the same one, which is kept as it is.
//
//   oauthSession()      the sign-in, token refresh and authorised GET, for any such source (email uses it directly)
//   dailyOAuthFetcher() device sources that give daily values (Oura, Ultrahuman): reads the days after the last day
//                       with data, up to yesterday in the person's time zone, and saves them as one FHIR file
import { NeedsPersonError, PortalError, RunStoppedError, type PortalReport } from '../recipes/types.ts';
import type { ApiContext, OAuthFetcher } from './types.ts';
import { addDays, dayIn, vitalsReport, type DailyValue } from './vitals.ts';

export interface OAuthClient { clientId: string; clientSecret: string; redirectUri: string }

export interface OAuthProvider {
  sourceId: string;
  /** Its name for the person ("Oura", "Gmail"). */
  device: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** Extra sign-in page parameters (Google: access_type=offline and prompt=consent, to get a refresh token). */
  authorizeParams?: Record<string, string>;
  /** Send the scopes again when refreshing (Microsoft asks for them). */
  refreshWithScope?: boolean;
  /** What a 403 means for this provider. */
  forbidden?: string;
}

/** The provider's API, as a daily-values source. */
export interface DailyOAuthSource extends OAuthProvider {
  /** How far back the first check reads, and the most days one check reads. */
  firstDays: number;
  maxDays: number;
  /** Daily values for the days from..to (inclusive), and the person's time zone when the provider says. */
  read(get: (url: string) => Promise<unknown>, from: string, to: string): Promise<{ rows: DailyValue[]; timeZone?: string }>;
}

/** The API refused: `status` is the HTTP status (0 when it did not answer). */
export class ProviderError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** Tokens, and whatever else a source keeps between checks (a cursor). */
export type Tokens = { access: string; refresh: string; expiresAt: number } & Record<string, unknown>;

export interface SignedIn<T extends Tokens> {
  tokens: T;
  /** An authorised GET returning JSON; 401 asks the person to connect again, 403/429/5xx become messages. */
  get(url: string): Promise<unknown>;
  /**
   * Keep the tokens with these extra fields (a read cursor) for the next check, but only once the reports this check
   * returns are saved (ctx.progress): a check that fails to save them reads the same range again.
   */
  progress(extra: Partial<T>): void;
}

export function oauthSession<T extends Tokens>(p: OAuthProvider, client: OAuthClient, opts: { fetch?: typeof fetch; now?: () => number } = {}) {
  const f = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;

  async function token(params: Record<string, string>, previousRefresh?: string): Promise<Tokens> {
    let res: Response;
    try {
      res = await f(p.tokenUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ ...params, client_id: client.clientId, client_secret: client.clientSecret }).toString(),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new ProviderError(0, `${p.device} did not answer`);
    }
    const b = await res.json().catch(() => null) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string } | null;
    const refresh = b?.refresh_token ?? previousRefresh;
    if (!res.ok || !b?.access_token || !refresh) throw new ProviderError(res.ok ? 400 : res.status, b?.error ?? `${p.device} refused the sign-in`);
    return { access: b.access_token, refresh, expiresAt: now() + Math.max(60, (b.expires_in ?? 3600) - 60) * 1000 };
  }

  return {
    authorizeUrl(state: string): string {
      const u = new URL(p.authorizeUrl);
      u.search = new URLSearchParams({ response_type: 'code', client_id: client.clientId, redirect_uri: client.redirectUri, scope: p.scopes.join(' '), state, ...p.authorizeParams }).toString();
      return u.href;
    },

    async exchange(code: string): Promise<{ session: string }> {
      try {
        return { session: JSON.stringify(await token({ grant_type: 'authorization_code', code, redirect_uri: client.redirectUri })) };
      } catch {
        throw new PortalError(`${p.device} did not finish the sign-in. Try connecting again.`);
      }
    },

    /** The kept sign-in, refreshed when needed (and kept at once), with an authorised GET. */
    async signIn(ctx: ApiContext): Promise<SignedIn<T>> {
      let t: T | null = null;
      try { t = ctx.session ? JSON.parse(ctx.session) as T : null; } catch { t = null; }
      if (!t?.refresh) throw new NeedsPersonError(`Connect ${p.device} again`);
      if (now() >= t.expiresAt) {
        await ctx.step(`Renewing the ${p.device} sign-in`);
        try {
          t = { ...t, ...(await token({ grant_type: 'refresh_token', refresh_token: t.refresh, ...(p.refreshWithScope ? { scope: p.scopes.join(' ') } : {}) }, t.refresh)) };
        } catch (e) {
          // A refused refresh token (access removed, or already used): only signing in again helps.
          if (e instanceof ProviderError && e.status >= 400 && e.status < 500) throw new NeedsPersonError(`Connect ${p.device} again`);
          throw new PortalError(`${p.device} is not answering right now. Try again later.`);
        }
        ctx.keep(JSON.stringify(t));
      }
      const tokens = t;
      return {
        tokens,
        progress: extra => { ctx.progress(JSON.stringify({ ...tokens, ...extra })); },
        // Stop, Disconnect and the run's deadline abort ctx.signal: no request is sent after that, and one in flight ends.
        async get(url) {
          if (ctx.signal.aborted) throw new RunStoppedError('Cancelled.');
          let res: Response;
          try {
            res = await f(url, { headers: { Authorization: `Bearer ${tokens.access}`, Accept: 'application/json', 'User-Agent': 'LotusPondHealth/1.0' }, signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]) });
          } catch {
            if (ctx.signal.aborted) throw new RunStoppedError('Cancelled.');
            throw new PortalError(`${p.device} is not answering right now. Try again later.`);
          }
          if (res.status === 401) throw new NeedsPersonError(`Connect ${p.device} again`);
          if (res.status === 403) throw new PortalError(p.forbidden ?? `${p.device} did not share the data: the permissions you gave LotusPond may not cover it.`);
          if (res.status === 429) throw new PortalError(`${p.device} is limiting requests right now. LotusPond will try again later.`);
          if (!res.ok) throw new PortalError(`${p.device} is not answering right now. Try again later.`);
          return res.json();
        },
      };
    },
  };
}

export function dailyOAuthFetcher(def: DailyOAuthSource, client: OAuthClient, opts: { fetch?: typeof fetch; now?: () => number } = {}): OAuthFetcher {
  const now = opts.now ?? Date.now;
  const session = oauthSession<Tokens & { lastDay?: string; timeZone?: string }>(def, client, opts);
  return {
    sourceId: def.sourceId,
    authorizeUrl: state => session.authorizeUrl(state),
    exchange: code => session.exchange(code),

    async run(ctx: ApiContext): Promise<PortalReport[]> {
      const s = await session.signIn(ctx);
      const tokens = s.tokens;
      await ctx.step(`Reading your ${def.device} data`);
      const today = dayIn(Math.floor(now() / 1000), tokens.timeZone ?? 'Asia/Kolkata');
      const yesterday = addDays(today, -1);
      let from = tokens.lastDay ? addDays(tokens.lastDay, 1) : addDays(today, -def.firstDays);
      if (from < addDays(yesterday, -(def.maxDays - 1))) from = addDays(yesterday, -(def.maxDays - 1));
      if (from > yesterday) return [];
      const { rows, timeZone } = await def.read(url => s.get(url), from, yesterday);
      const kept = rows.filter(r => r.day >= from && r.day <= yesterday && (!tokens.lastDay || r.day > tokens.lastDay));
      // Next time, read from the day after the last day with data: a ring that syncs late still brings its days in.
      const lastDay = kept.reduce<string | undefined>((m, r) => (!m || r.day > m ? r.day : m), tokens.lastDay);
      s.progress({ ...(lastDay ? { lastDay } : {}), ...(timeZone ? { timeZone } : {}) });
      const report = vitalsReport(kept, def.device);
      return report ? [report] : [];
    },
  };
}
