// A device source behind standard OAuth 2 (authorization code, client secret, rotating refresh tokens) that gives
// daily values: Oura, Ultrahuman. The person signs in on the provider's page; each check refreshes the token when it
// has run out (keeping the new refresh token at once: these providers accept each one only once), reads the days
// after the last day already read, up to yesterday in the person's time zone, and saves them as one FHIR file.
import { NeedsPersonError, PortalError, RunStoppedError, type PortalReport } from '../recipes/types.ts';
import type { ApiContext, OAuthFetcher } from './types.ts';
import { addDays, dayIn, vitalsReport, type DailyValue } from './vitals.ts';

export interface OAuthClient { clientId: string; clientSecret: string; redirectUri: string }

/** The provider's API, as a source definition. */
export interface DailyOAuthSource {
  sourceId: string;
  /** Its name in file names and the FHIR device ("Oura"). */
  device: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
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

interface Tokens { access: string; refresh: string; expiresAt: number; lastDay?: string; timeZone?: string }

export function dailyOAuthFetcher(def: DailyOAuthSource, client: OAuthClient, opts: { fetch?: typeof fetch; now?: () => number } = {}): OAuthFetcher {
  const f = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;

  async function token(params: Record<string, string>): Promise<Omit<Tokens, 'lastDay' | 'timeZone'>> {
    let res: Response;
    try {
      res = await f(def.tokenUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ ...params, client_id: client.clientId, client_secret: client.clientSecret }).toString(),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new ProviderError(0, `${def.device} did not answer`);
    }
    const b = await res.json().catch(() => null) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string } | null;
    if (!res.ok || !b?.access_token || !b.refresh_token) throw new ProviderError(res.ok ? 400 : res.status, b?.error ?? `${def.device} refused the sign-in`);
    return { access: b.access_token, refresh: b.refresh_token, expiresAt: now() + Math.max(60, (b.expires_in ?? 3600) - 60) * 1000 };
  }

  return {
    sourceId: def.sourceId,

    authorizeUrl(state) {
      const u = new URL(def.authorizeUrl);
      u.search = new URLSearchParams({ response_type: 'code', client_id: client.clientId, redirect_uri: client.redirectUri, scope: def.scopes.join(' '), state }).toString();
      return u.href;
    },

    async exchange(code) {
      try {
        return { session: JSON.stringify(await token({ grant_type: 'authorization_code', code, redirect_uri: client.redirectUri })) };
      } catch {
        throw new PortalError(`${def.device} did not finish the sign-in. Try connecting again.`);
      }
    },

    async run(ctx: ApiContext): Promise<PortalReport[]> {
      let t: Tokens | null = null;
      try { t = ctx.session ? JSON.parse(ctx.session) as Tokens : null; } catch { t = null; }
      if (!t?.refresh) throw new NeedsPersonError(`Connect ${def.device} again`);
      if (now() >= t.expiresAt) {
        await ctx.step(`Renewing the ${def.device} sign-in`);
        try {
          t = { ...t, ...(await token({ grant_type: 'refresh_token', refresh_token: t.refresh })) };
        } catch (e) {
          // A refused refresh token (access removed, or already used): only signing in again helps.
          if (e instanceof ProviderError && e.status >= 400 && e.status < 500) throw new NeedsPersonError(`Connect ${def.device} again`);
          throw new PortalError(`${def.device} is not answering right now. Try again later.`);
        }
        ctx.keep(JSON.stringify(t));
      }
      const tokens = t;

      // Stop, Disconnect and the run's deadline abort ctx.signal: no request is sent after that, and one in flight ends.
      const get = async (url: string): Promise<unknown> => {
        if (ctx.signal.aborted) throw new RunStoppedError('Cancelled.');
        let res: Response;
        try {
          res = await f(url, { headers: { Authorization: `Bearer ${tokens.access}`, Accept: 'application/json', 'User-Agent': 'LotusPondHealth/1.0' }, signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]) });
        } catch {
          if (ctx.signal.aborted) throw new RunStoppedError('Cancelled.');
          throw new PortalError(`${def.device} is not answering right now. Try again later.`);
        }
        if (res.status === 401) throw new NeedsPersonError(`Connect ${def.device} again`);
        if (res.status === 403) throw new PortalError(`${def.device} did not share the data: your ${def.device} membership or the permissions you gave LotusPond may not cover it.`);
        if (res.status === 429) throw new PortalError(`${def.device} is limiting requests right now. LotusPond will try again later.`);
        if (!res.ok) throw new PortalError(`${def.device} is not answering right now. Try again later.`);
        return res.json();
      };

      await ctx.step(`Reading your ${def.device} data`);
      const today = dayIn(Math.floor(now() / 1000), tokens.timeZone ?? 'Asia/Kolkata');
      const yesterday = addDays(today, -1);
      let from = tokens.lastDay ? addDays(tokens.lastDay, 1) : addDays(today, -def.firstDays);
      if (from < addDays(yesterday, -(def.maxDays - 1))) from = addDays(yesterday, -(def.maxDays - 1));
      if (from > yesterday) return [];
      const { rows, timeZone } = await def.read(get, from, yesterday);
      const kept = rows.filter(r => r.day >= from && r.day <= yesterday && (!tokens.lastDay || r.day > tokens.lastDay));
      // Next time, read from the day after the last day with data: a ring that syncs late still brings its days in.
      const lastDay = kept.reduce<string | undefined>((m, r) => (!m || r.day > m ? r.day : m), tokens.lastDay);
      ctx.keep(JSON.stringify({ ...tokens, ...(lastDay ? { lastDay } : {}), ...(timeZone ? { timeZone } : {}) }));
      const report = vitalsReport(kept, def.device);
      return report ? [report] : [];
    },
  };
}
