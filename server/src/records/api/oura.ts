// Oura (rings) through its API v2, as a record agent source (OAuth 2: cloud.ouraring.com/oauth/authorize, token at
// api.ouraring.com/oauth/token, scopes `daily heartrate spo2`). Each check reads, per day:
//   GET /v2/usercollection/sleep?start_date&end_date[&next_token]   the night's main sleep (type long_sleep, else the
//       longest): lowest_heart_rate → resting heart rate (what Oura's app shows as resting heart rate), average_breath
//       → respiratory rate.
//   GET /v2/usercollection/daily_spo2?start_date&end_date           spo2_percentage.average → SpO2 during sleep.
// A 403 means the person's Oura membership has lapsed, and Oura shares no data then.
//
// Written from Oura's API reference (November 2026) and tested against a copy of it (test/oura-ultrahuman.test.ts);
// not yet run against a real Oura account. Oura limits a new application's users until Oura approves it.
import { dailyOAuthFetcher, type OAuthClient } from './oauth2.ts';
import type { OAuthFetcher } from './types.ts';
import { vitalValue, type DailyValue } from './vitals.ts';

export const OURA_AUTHORIZE_URL = 'https://cloud.ouraring.com/oauth/authorize';
export const OURA_TOKEN_URL = 'https://api.ouraring.com/oauth/token';
export const OURA_API_URL = 'https://api.ouraring.com';

interface Page<T> { data?: T[]; next_token?: string | null }
interface Sleep { day?: string; type?: string; total_sleep_duration?: number | null; lowest_heart_rate?: number | null; average_breath?: number | null }
interface Spo2 { day?: string; spo2_percentage?: { average?: number | null } | null }

/** Oura's sleep and SpO2 documents → daily values. */
export function ouraDaily(sleeps: Sleep[], spo2: Spo2[]): DailyValue[] {
  const rows: DailyValue[] = [];
  // One night per day: the main sleep, else the longest period.
  const nights = new Map<string, Sleep>();
  for (const s of sleeps) {
    if (!s.day || s.type === 'deleted' || s.type === 'rest') continue;
    const best = nights.get(s.day);
    const rank = (x: Sleep) => (x.type === 'long_sleep' ? 1e9 : 0) + (x.total_sleep_duration ?? 0);
    if (!best || rank(s) > rank(best)) nights.set(s.day, s);
  }
  for (const [day, s] of nights) {
    const hr = vitalValue('resting_heart_rate', s.lowest_heart_rate);
    if (hr != null) rows.push({ marker: 'resting_heart_rate', day, value: hr, readings: 1, note: 'Lowest heart rate during sleep (Oura’s resting heart rate)' });
    const br = vitalValue('respiratory_rate', s.average_breath);
    if (br != null) rows.push({ marker: 'respiratory_rate', day, value: br, readings: 1, note: 'Average breathing rate during sleep' });
  }
  for (const d of spo2) {
    const v = d.day ? vitalValue('spo2', d.spo2_percentage?.average) : null;
    if (v != null) rows.push({ marker: 'spo2', day: d.day!, value: v, readings: 1, note: 'Average SpO2 during sleep' });
  }
  return rows;
}

export function ouraFetcher(client: OAuthClient, opts: { apiUrl?: string; authorizeUrl?: string; tokenUrl?: string; fetch?: typeof fetch; now?: () => number } = {}): OAuthFetcher {
  const api = (opts.apiUrl ?? OURA_API_URL).replace(/\/+$/, '');
  return dailyOAuthFetcher({
    sourceId: 'oura', device: 'Oura',
    authorizeUrl: opts.authorizeUrl ?? OURA_AUTHORIZE_URL, tokenUrl: opts.tokenUrl ?? OURA_TOKEN_URL,
    scopes: ['daily', 'heartrate', 'spo2'],
    forbidden: 'Oura did not share the data: Oura shares data only while your Oura membership is active.',
    firstDays: 365, maxDays: 400,
    async read(get, from, to) {
      async function all<T>(path: string): Promise<T[]> {
        const out: T[] = [];
        let next: string | null | undefined;
        for (let page = 0; page < 30; page++) {
          const q = new URLSearchParams({ start_date: from, end_date: to, ...(next ? { next_token: next } : {}) });
          const b = await get(`${api}${path}?${q}`) as Page<T>;
          out.push(...(b.data ?? []));
          next = b.next_token;
          if (!next) break;
        }
        return out;
      }
      // Oura keys a night's sleep document to the day it ends.
      const [sleeps, spo2] = await Promise.all([all<Sleep>('/v2/usercollection/sleep'), all<Spo2>('/v2/usercollection/daily_spo2')]);
      return { rows: ouraDaily(sleeps, spo2) };
    },
  }, client, opts);
}
