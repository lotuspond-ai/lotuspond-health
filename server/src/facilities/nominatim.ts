// Area and postcode search with Nominatim (OpenStreetMap). Format reference: https://nominatim.org/release-docs/develop/api/Output/
// Usage policy (https://operations.osmfoundation.org/policies/nominatim/): at most 1 request per second,
// an identifying User-Agent, and caching. The throttle lives here; caching is in the facility service.
import type { GeoCandidate, GeoReverse } from '../../../shared/types.ts';
import { FacilityError, ProviderError } from './errors.ts';

interface NominatimItem {
  lat?: string;
  lon?: string;
  name?: string;
  display_name?: string;
  addresstype?: string;
  address?: Record<string, string>;
  error?: string;
}

const pick = (a: Record<string, string>, keys: string[]) => keys.map(k => a[k]?.trim()).find(Boolean);
const AREA = ['suburb', 'neighbourhood', 'quarter', 'city_district', 'borough', 'hamlet', 'village', 'town'];
const CITY = ['city', 'town', 'village', 'municipality', 'county', 'state_district'];

function joinUnique(parts: (string | undefined)[], max = 2): string {
  const out: string[] = [];
  for (const p of parts) if (p && !out.some(x => x.toLowerCase() === p.toLowerCase())) out.push(p);
  return out.slice(0, max).join(', ');
}

function coords(item: NominatimItem): { lat: number; lon: number } | null {
  const lat = Number(item.lat), lon = Number(item.lon);
  if (!item.lat || !item.lon || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

/** Short label for a search result: "Indiranagar, Bengaluru", "560038, Bengaluru", "Pune, Maharashtra". */
function searchLabel(item: NominatimItem): string {
  const a = item.address ?? {};
  const primary = item.name?.trim() || (item.addresstype === 'postcode' ? a.postcode : undefined) || item.display_name?.split(',')[0]?.trim();
  return joinUnique([primary, pick(a, CITY), a.state, a.country]) || 'Unnamed place';
}

/** Candidates from a /search?format=jsonv2&addressdetails=1 response. */
export function parseSearch(json: unknown, limit = 5): GeoCandidate[] {
  if (!Array.isArray(json)) throw new ProviderError('The geocoder answered with something other than a list.');
  const out: GeoCandidate[] = [];
  for (const raw of json as NominatimItem[]) {
    if (!raw || typeof raw !== 'object') continue;
    const c = coords(raw);
    if (!c) continue;
    const a = raw.address ?? {};
    const label = searchLabel(raw);
    if (out.some(o => o.label === label)) continue;
    out.push({
      label, ...c,
      detail: raw.display_name?.trim().slice(0, 200) || null,
      country: a.country_code ? a.country_code.toUpperCase() : null,
      postalCode: a.postcode?.trim() || null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** The area around a point from a /reverse?format=jsonv2&addressdetails=1 response, or null when there is none. */
export function parseReverse(json: unknown): GeoReverse | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new ProviderError('The geocoder answered with something unexpected.');
  const item = json as NominatimItem;
  if (item.error || !item.address) return null;
  const a = item.address;
  const label = joinUnique([pick(a, AREA), pick(a, CITY), a.state]) || item.display_name?.split(',').slice(0, 2).join(',').trim();
  if (!label) return null;
  return { label, country: a.country_code ? a.country_code.toUpperCase() : null, postalCode: a.postcode?.trim() || null };
}

export interface Geocoder {
  search(q: string, lang: string): Promise<GeoCandidate[]>;
  reverse(lat: number, lon: number, lang: string): Promise<GeoReverse | null>;
}

export interface NominatimOptions {
  baseUrl: string;
  userAgent: string;
  email?: string;
  timeoutMs: number;
  /** Minimum gap between requests (the public server allows 1 per second). */
  minIntervalMs?: number;
  /** Give up instead of queueing longer than this. */
  maxWaitMs?: number;
  fetch?: typeof fetch;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class NominatimGeocoder implements Geocoder {
  private readonly opts: Required<Omit<NominatimOptions, 'email'>> & { email?: string };
  /** Earliest time the next request may start. */
  private nextAt = 0;

  constructor(opts: NominatimOptions) {
    this.opts = { minIntervalMs: 1000, maxWaitMs: 8000, fetch: globalThis.fetch, ...opts };
  }

  /** Wait for this request's turn, keeping requests at least minIntervalMs apart. */
  private async turn(): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.nextAt);
    if (at - now > this.opts.maxWaitMs) throw new FacilityError('busy');
    this.nextAt = at + this.opts.minIntervalMs;
    if (at > now) await sleep(at - now);
  }

  private async get(path: string, params: Record<string, string>): Promise<unknown> {
    await this.turn();
    const url = new URL(`${this.opts.baseUrl}${path}`);
    for (const [k, v] of Object.entries({ format: 'jsonv2', addressdetails: '1', ...params })) url.searchParams.set(k, v);
    if (this.opts.email) url.searchParams.set('email', this.opts.email);
    let res: Response;
    try {
      res = await this.opts.fetch(url, { headers: { 'User-Agent': this.opts.userAgent, Accept: 'application/json' }, signal: AbortSignal.timeout(this.opts.timeoutMs) });
    } catch (e) {
      throw new ProviderError('The geocoder could not be reached.', { cause: e });
    }
    if (!res.ok) throw new ProviderError(`The geocoder answered ${res.status}.`);
    try {
      return await res.json();
    } catch (e) {
      throw new ProviderError('The geocoder answered with something other than JSON.', { cause: e });
    }
  }

  async search(q: string, lang: string): Promise<GeoCandidate[]> {
    return parseSearch(await this.get('/search', { q, limit: '8', 'accept-language': lang }));
  }

  async reverse(lat: number, lon: number, lang: string): Promise<GeoReverse | null> {
    return parseReverse(await this.get('/reverse', { lat: String(lat), lon: String(lon), zoom: '16', 'accept-language': lang }));
  }
}
