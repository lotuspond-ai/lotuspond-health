// Ultrahuman (Ring AIR and the M1 glucose monitor) through its OAuth API, as a record agent source:
//   Sign-in  https://auth.ultrahuman.com/authorise, token at https://partner.ultrahuman.com/api/partners/oauth/token
//            (form: grant_type, client_id, client_secret, code | refresh_token; each refresh gives a new refresh token).
//   Data     GET https://partner.ultrahuman.com/api/partners/v1/user_data/metrics?date=yyyy-mm-dd, one day per call:
//            { data: { metric_data: [{ type, object }], latest_time_zone } }.
// Read per day (scope ring_data):
//   sleep_rhr.object.value (else the last night_rhr value)       → resting heart rate
//   Sleep.object.spo2.value                                       → SpO2 during sleep (Ultrahuman marks it beta)
//   Sleep.object.respiratory_graph.gist_object.avg                → respiratory rate during sleep
// And with the cgm_data scope, which Ultrahuman grants on request (ULTRAHUMAN_CGM=on once it has):
//   average_glucose.object.value                                  → glucose (home meter / sensor), the day's mean
// Ultrahuman's estimated HbA1c and its scores are not read: they are not lab values.
//
// Written from Ultrahuman's OAuth documentation (November 2026) and tested against a copy of it
// (test/oura-ultrahuman.test.ts); not yet run against a real Ultrahuman account. The shape of the CGM summary entries
// is not shown in Ultrahuman's samples, so `value` (or `avg`) is assumed.
import { dailyOAuthFetcher, type OAuthClient } from './oauth2.ts';
import type { OAuthFetcher } from './types.ts';
import { addDays, vitalValue, type DailyValue } from './vitals.ts';

export const ULTRAHUMAN_AUTHORIZE_URL = 'https://auth.ultrahuman.com/authorise';
export const ULTRAHUMAN_TOKEN_URL = 'https://partner.ultrahuman.com/api/partners/oauth/token';
export const ULTRAHUMAN_API_URL = 'https://partner.ultrahuman.com';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : null);

/** One day's metrics → daily values. */
export function ultrahumanDay(day: string, metrics: { type?: string; object?: unknown }[]): DailyValue[] {
  const by = new Map(metrics.filter(m => m.type).map(m => [m.type!, obj(m.object)]));
  const rows: DailyValue[] = [];
  const add = (marker: DailyValue['marker'], v: unknown, note: string) => {
    const n = vitalValue(marker, v);
    if (n != null) rows.push({ marker, day, value: n, readings: 1, note });
  };
  const nightRhr = (by.get('night_rhr')?.values as { value?: number }[] | undefined)?.at(-1)?.value;
  add('resting_heart_rate', by.get('sleep_rhr')?.value ?? nightRhr, 'Resting heart rate during sleep');
  const sleep = by.get('Sleep');
  add('spo2', obj(sleep?.spo2)?.value, 'Average SpO2 during sleep (Ultrahuman beta)');
  add('respiratory_rate', obj(obj(sleep?.respiratory_graph)?.gist_object)?.avg, 'Average breathing rate during sleep');
  const g = by.get('average_glucose');
  add('glucose_meter', g?.value ?? g?.avg, 'Average glucose that day (Ultrahuman M1 sensor)');
  return rows;
}

export function ultrahumanFetcher(client: OAuthClient, opts: { cgm?: boolean; apiUrl?: string; authorizeUrl?: string; tokenUrl?: string; fetch?: typeof fetch; now?: () => number } = {}): OAuthFetcher {
  const api = (opts.apiUrl ?? ULTRAHUMAN_API_URL).replace(/\/+$/, '');
  return dailyOAuthFetcher({
    sourceId: 'ultrahuman', device: 'Ultrahuman',
    authorizeUrl: opts.authorizeUrl ?? ULTRAHUMAN_AUTHORIZE_URL, tokenUrl: opts.tokenUrl ?? ULTRAHUMAN_TOKEN_URL,
    scopes: ['ring_data', ...(opts.cgm ? ['cgm_data'] : [])],
    // One request per day, so the first check reads 3 months and a check at most 3 months.
    firstDays: 90, maxDays: 90,
    async read(get, from, to) {
      const rows: DailyValue[] = [];
      let timeZone: string | undefined;
      for (let day = from; day <= to; day = addDays(day, 1)) {
        const b = await get(`${api}/api/partners/v1/user_data/metrics?date=${day}`) as { data?: { metric_data?: { type?: string; object?: unknown }[]; latest_time_zone?: string } };
        timeZone = b.data?.latest_time_zone ?? timeZone;
        rows.push(...ultrahumanDay(day, b.data?.metric_data ?? []));
      }
      return { rows, ...(timeZone ? { timeZone } : {}) };
    },
  }, client, opts);
}
