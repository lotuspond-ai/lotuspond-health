// Withings (scales, blood pressure monitors, thermometers, oximeters) through its public API, as a record agent
// source: the person signs in on Withings' own page (OAuth 2), and each check reads their new measurements, one value
// per marker per day, as a FHIR bundle of Observations that goes to the same review as a report. Nothing is written
// back to Withings.
//
//   Sign-in   https://account.withings.com/oauth2_user/authorize2?response_type=code&client_id&scope=user.metrics
//             &redirect_uri&state
//   Tokens    POST https://wbsapi.withings.net/v2/oauth2 action=requesttoken grant_type=authorization_code|refresh_token
//             client_id client_secret (code redirect_uri | refresh_token) → { status: 0, body: { userid, access_token,
//             refresh_token, expires_in (3 hours), scope } }. Each refresh gives a new refresh token: it is kept at once.
//   Measures  POST https://wbsapi.withings.net/measure action=getmeas meastypes category=1 startdate|lastupdate offset,
//             Authorization: Bearer → { status: 0, body: { timezone, measuregrps: [{ grpid, date, category, measures:
//             [{ value, type, unit }] }], more, offset } }. A value is value × 10^unit.
// Withings answers HTTP 200 with a non-zero `status` for errors (401: the token is not valid).
//
// Written from Withings' API reference (November 2026) and tested against a copy of it (test/withings.test.ts); not
// yet run against a real Withings account.
import { createHash } from 'node:crypto';
import { NeedsPersonError, PortalError, type PortalReport } from '../recipes/types.ts';
import type { ApiContext, OAuthFetcher } from './types.ts';

export const WITHINGS_AUTHORIZE_URL = 'https://account.withings.com/oauth2_user/authorize2';
export const WITHINGS_API_URL = 'https://wbsapi.withings.net';

export interface WithingsOptions {
  clientId: string;
  clientSecret: string;
  /** Where Withings sends the person back: PUBLIC_URL/api/records/oauth/withings/callback, registered with Withings. */
  redirectUri: string;
  apiUrl?: string;
  authorizeUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

interface Tokens { userid: string; access: string; refresh: string; expiresAt: number; /** The last day already read (yyyy-mm-dd). */ lastDay?: string }

/**
 * The measure types read, the marker each becomes (by its catalogue name, which the FHIR reader matches), LOINC and
 * UCUM for the Observation, plausible bounds (readings outside are device or unit errors) and decimals.
 */
const TYPES: Record<number, { name: string; loinc: string; unit: string; ucum: string; bounds: [number, number]; decimals: number }> = {
  1: { name: 'Body weight', loinc: '29463-7', unit: 'kg', ucum: 'kg', bounds: [1, 650], decimals: 1 },
  6: { name: 'Body fat', loinc: '41982-0', unit: '%', ucum: '%', bounds: [1, 75], decimals: 1 },
  10: { name: 'Systolic blood pressure', loinc: '8480-6', unit: 'mmHg', ucum: 'mm[Hg]', bounds: [50, 300], decimals: 0 },
  9: { name: 'Diastolic blood pressure', loinc: '8462-4', unit: 'mmHg', ucum: 'mm[Hg]', bounds: [30, 200], decimals: 0 },
  // Heart pulse from a blood pressure monitor or scale, taken at rest.
  11: { name: 'Resting heart rate', loinc: '40443-4', unit: 'bpm', ucum: '/min', bounds: [20, 250], decimals: 0 },
  54: { name: 'Oxygen saturation (SpO2)', loinc: '59408-5', unit: '%', ucum: '%', bounds: [50, 100], decimals: 0 },
  71: { name: 'Body temperature', loinc: '8310-5', unit: '°C', ucum: 'Cel', bounds: [30, 45], decimals: 1 },
  // Type 12 is "Temperature": older thermometers report body temperature with it.
  12: { name: 'Body temperature', loinc: '8310-5', unit: '°C', ucum: 'Cel', bounds: [30, 45], decimals: 1 },
};
const MEASTYPES = Object.keys(TYPES).join(',');
/** How far back the first check reads. */
const FIRST_DAYS = 365;
/** Pages of measurements per check, at most (Withings pages by offset). */
const MAX_PAGES = 50;

/** Withings refused (`http` false: a non-zero status in a 200 reply) or did not answer properly (`http` true). */
export class WithingsError extends Error {
  readonly status: number;
  readonly http: boolean;
  constructor(status: number, message: string, http = false) { super(message); this.status = status; this.http = http; }
}

/** The calendar day of a unix time in a time zone (Withings gives the person's), yyyy-mm-dd. */
export function dayIn(unixSeconds: number, timeZone: string): string {
  let tz = timeZone;
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); } catch { tz = 'Asia/Kolkata'; }
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(unixSeconds * 1000));
}

interface Group { date: number; category?: number; measures: { value: number; type: number; unit: number }[] }

/** Measurement groups → one value per marker per day (the mean of the day's readings), oldest first; not today. */
export function dailyReadings(groups: Group[], timeZone: string, today: string): { name: string; type: number; day: string; value: number; readings: number }[] {
  const sums = new Map<string, { type: number; day: string; total: number; n: number }>();
  for (const g of groups) {
    if (g.category !== undefined && g.category !== 1) continue; // 2 = the person's goals, not measurements
    const day = dayIn(g.date, timeZone);
    if (day >= today) continue;
    for (const m of g.measures ?? []) {
      const t = TYPES[m.type];
      if (!t || !Number.isFinite(m.value) || !Number.isFinite(m.unit)) continue;
      const v = m.value * 10 ** m.unit;
      if (v < t.bounds[0] || v > t.bounds[1]) continue;
      const key = `${t.name}\u0000${day}`;
      const s = sums.get(key) ?? { type: m.type, day, total: 0, n: 0 };
      s.total += v; s.n++;
      sums.set(key, s);
    }
  }
  return [...sums.values()]
    .map(s => { const t = TYPES[s.type]; const f = 10 ** t.decimals; return { name: t.name, type: s.type, day: s.day, value: Math.round((s.total / s.n) * f) / f, readings: s.n }; })
    .sort((a, b) => a.day.localeCompare(b.day) || a.name.localeCompare(b.name));
}

/** Daily values as a FHIR R4 collection Bundle of Observations (what the app's FHIR reader takes). */
export function readingsBundle(rows: ReturnType<typeof dailyReadings>, from: string, to: string): Record<string, unknown> {
  return {
    resourceType: 'Bundle', type: 'collection', id: `withings-${from}-${to}`, timestamp: new Date().toISOString(),
    entry: rows.map(r => {
      const t = TYPES[r.type];
      return {
        resource: {
          resourceType: 'Observation', status: 'final',
          category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }],
          code: { coding: [{ system: 'http://loinc.org', code: t.loinc, display: t.name }], text: t.name },
          effectiveDateTime: r.day,
          valueQuantity: { value: r.value, unit: t.unit, system: 'http://unitsofmeasure.org', code: t.ucum },
          device: { display: 'Withings' },
          note: [{ text: r.readings === 1 ? '1 reading' : `Mean of ${r.readings} readings that day` }],
        },
      };
    }),
  };
}

export function withingsFetcher(o: WithingsOptions): OAuthFetcher {
  const f = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const api = (o.apiUrl ?? WITHINGS_API_URL).replace(/\/+$/, '');

  async function call<T>(path: string, params: Record<string, string>, access?: string): Promise<T> {
    const res = await f(`${api}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(access ? { Authorization: `Bearer ${access}` } : {}) },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(30_000),
    });
    const json = await res.json().catch(() => null) as { status?: number; body?: T; error?: string } | null;
    if (!res.ok || !json) throw new WithingsError(res.status, `Withings answered ${res.status}`, true);
    if (json.status !== 0) throw new WithingsError(json.status ?? -1, json.error ?? `Withings refused the request (status ${json.status ?? '?'})`);
    return json.body as T;
  }

  const keepTokens = (b: { userid: number | string; access_token: string; refresh_token: string; expires_in: number }): Tokens =>
    ({ userid: String(b.userid), access: b.access_token, refresh: b.refresh_token, expiresAt: now() + Math.max(60, b.expires_in - 60) * 1000 });

  const ref = (userid: string) => createHash('sha256').update(`withings-user\u0000${userid}`).digest('hex');

  return {
    sourceId: 'withings',

    authorizeUrl(state) {
      const u = new URL(o.authorizeUrl ?? WITHINGS_AUTHORIZE_URL);
      u.search = new URLSearchParams({ response_type: 'code', client_id: o.clientId, scope: 'user.metrics', redirect_uri: o.redirectUri, state }).toString();
      return u.href;
    },

    async exchange(code) {
      let t: Tokens;
      try {
        t = keepTokens(await call('/v2/oauth2', { action: 'requesttoken', grant_type: 'authorization_code', client_id: o.clientId, client_secret: o.clientSecret, code, redirect_uri: o.redirectUri }));
      } catch (e) {
        throw new PortalError(`Withings did not finish the sign-in${e instanceof WithingsError ? ` (${e.status})` : ''}. Try connecting again.`);
      }
      return { session: JSON.stringify(t), ref: ref(t.userid) };
    },

    async run(ctx: ApiContext): Promise<PortalReport[]> {
      let t: Tokens | null = null;
      try { t = ctx.session ? JSON.parse(ctx.session) as Tokens : null; } catch { t = null; }
      // No sign-in (or one that cannot be read): connecting again on Withings' page is the only way.
      if (!t?.refresh) throw new NeedsPersonError('Connect Withings again');
      if (now() >= t.expiresAt) {
        await ctx.step('Renewing the Withings sign-in');
        try {
          const lastDay = t.lastDay;
          t = { ...keepTokens(await call('/v2/oauth2', { action: 'requesttoken', grant_type: 'refresh_token', client_id: o.clientId, client_secret: o.clientSecret, refresh_token: t.refresh })), ...(lastDay ? { lastDay } : {}) };
        } catch (e) {
          // Withings refused the refresh token (removed access, or it was used already): only signing in again helps.
          if (e instanceof WithingsError && !e.http) throw new NeedsPersonError('Connect Withings again');
          throw new PortalError('Withings is not answering right now. Try again later.');
        }
        // Withings has already invalidated the old refresh token: keep the new one even if this run fails later.
        ctx.keep(JSON.stringify(t), ref(t.userid));
      }

      await ctx.step('Reading your Withings measurements');
      const nowS = Math.floor(now() / 1000);
      // From the last day already read (with a day of margin for time zones), else a year back.
      const since = t.lastDay ? Math.floor(Date.parse(`${t.lastDay}T00:00:00Z`) / 1000) - 86_400 : nowS - FIRST_DAYS * 86_400;
      const groups: Group[] = [];
      let timezone = 'Asia/Kolkata';
      let offset: number | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        let body: { timezone?: string; measuregrps?: Group[]; more?: number | boolean; offset?: number };
        try {
          body = await call('/measure', {
            action: 'getmeas', meastypes: MEASTYPES, category: '1', startdate: String(since), enddate: String(nowS), ...(offset ? { offset: String(offset) } : {}),
          }, t.access);
        } catch (e) {
          if (e instanceof WithingsError && !e.http && e.status === 401) throw new NeedsPersonError('Connect Withings again');
          if (e instanceof WithingsError && !e.http && e.status === 601) throw new PortalError('Withings is limiting requests right now. LotusPond will try again later.');
          throw new PortalError('Withings is not answering right now. Try again later.');
        }
        if (body.timezone) timezone = body.timezone;
        groups.push(...(body.measuregrps ?? []));
        if (!body.more || !body.offset) break;
        offset = body.offset;
      }

      const today = dayIn(nowS, timezone);
      const rows = dailyReadings(groups, timezone, today).filter(r => !t!.lastDay || r.day > t!.lastDay);
      if (!rows.length) return [];
      const from = rows[0].day, to = rows[rows.length - 1].day;
      const bytes = new Uint8Array(Buffer.from(JSON.stringify(readingsBundle(rows, from, to)), 'utf8'));
      const days = new Set(rows.map(r => r.day)).size;
      // Next time, read only the days after these.
      t = { ...t, lastDay: to };
      ctx.keep(JSON.stringify(t), ref(t.userid));
      const key = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
      return [{
        key, title: `Withings measurements, ${from === to ? from : `${from} to ${to}`}`, date: to,
        fileName: `Withings ${from === to ? from : `${from} to ${to}`} (${days} day${days === 1 ? '' : 's'})`,
        contentType: 'application/fhir+json', bytes,
      }];
    },
  };
}
