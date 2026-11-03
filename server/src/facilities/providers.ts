// Where places and geocoding come from: the live OpenStreetMap services, or recorded responses (development).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { GeoCandidate, GeoReverse } from '../../../shared/types.ts';
import { haversineKm } from '../../../shared/facilities.ts';
import type { FacilityConfig } from '../config.ts';
import { ProviderError } from './errors.ts';
import { NominatimGeocoder, parseReverse, parseSearch, type Geocoder } from './nominatim.ts';
import { overpassQuery, parseOverpass, type PlaceRecord } from './overpass.ts';

export type { Geocoder } from './nominatim.ts';

export interface PlacesProvider {
  /** Facilities within `radiusKm` of a (rounded) point. */
  nearby(lat: number, lon: number, radiusKm: number): Promise<PlaceRecord[]>;
}

export interface FacilityProviders {
  places: PlacesProvider;
  geocoder: Geocoder;
}

export interface OverpassOptions {
  url: string;
  userAgent: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export class OverpassProvider implements PlacesProvider {
  private readonly opts: OverpassOptions;
  constructor(opts: OverpassOptions) {
    this.opts = opts;
  }

  async nearby(lat: number, lon: number, radiusKm: number): Promise<PlaceRecord[]> {
    const query = overpassQuery(lat, lon, radiusKm * 1000, Math.max(5, Math.floor(this.opts.timeoutMs / 1000) - 2));
    let res: Response;
    try {
      res = await (this.opts.fetch ?? fetch)(this.opts.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': this.opts.userAgent, Accept: 'application/json' },
        body: new URLSearchParams({ data: query }).toString(),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (e) {
      throw new ProviderError('Overpass could not be reached.', { cause: e });
    }
    if (!res.ok) throw new ProviderError(`Overpass answered ${res.status}.`);
    let json: unknown;
    try {
      json = await res.json();
    } catch (e) {
      throw new ProviderError('Overpass answered with something other than JSON.', { cause: e });
    }
    return parseOverpass(json);
  }
}

/* ---------- recorded responses (FACILITY_PROVIDER=fixture; development and tests) ---------- */

/** server/data/fixtures, from src/facilities (tsx) or dist (bundle). */
export function fixturesDir(): string {
  for (const rel of ['../../data/fixtures/', '../data/fixtures/']) {
    const dir = fileURLToPath(new URL(rel, import.meta.url));
    if (fs.existsSync(dir)) return dir;
  }
  throw new Error('Recorded facility responses (server/data/fixtures) were not found.');
}

const readFixture = (name: string): unknown => JSON.parse(fs.readFileSync(`${fixturesDir()}${name}`, 'utf8'));

/** The recorded area: Indiranagar, Bengaluru. */
export const FIXTURE_CENTER = { lat: 12.9719, lon: 77.6412 };

/** Answers every query from one recorded Overpass response; the service then keeps what is within the radius. */
export class FixturePlaces implements PlacesProvider {
  async nearby(): Promise<PlaceRecord[]> {
    return parseOverpass(readFixture('overpass-indiranagar.json'));
  }
}

/** Searches recorded Nominatim results by name or postcode; reverse geocodes points near the recorded area. */
export class FixtureGeocoder implements Geocoder {
  async search(q: string): Promise<GeoCandidate[]> {
    const needle = q.trim().toLowerCase();
    const all = parseSearch(readFixture('nominatim-search.json'), 50);
    return all.filter(c => `${c.label} ${c.detail ?? ''} ${c.postalCode ?? ''}`.toLowerCase().includes(needle)).slice(0, 5);
  }

  async reverse(lat: number, lon: number): Promise<GeoReverse | null> {
    if (haversineKm(lat, lon, FIXTURE_CENTER.lat, FIXTURE_CENTER.lon) > 30) return null;
    return parseReverse(readFixture('nominatim-reverse-indiranagar.json'));
  }
}

export function userAgent(cfg: FacilityConfig): string {
  return `LotusPondHealth/0.1 (nearby labs; ${cfg.contactEmail ? `contact ${cfg.contactEmail}` : 'set GEO_CONTACT_EMAIL'})`;
}

export function providersFromConfig(cfg: FacilityConfig): FacilityProviders {
  if (cfg.provider === 'fixture') return { places: new FixturePlaces(), geocoder: new FixtureGeocoder() };
  return {
    places: new OverpassProvider({ url: cfg.overpassUrl, userAgent: userAgent(cfg), timeoutMs: cfg.timeoutMs }),
    geocoder: new NominatimGeocoder({ baseUrl: cfg.geocoderUrl, userAgent: userAgent(cfg), email: cfg.contactEmail, timeoutMs: Math.min(cfg.timeoutMs, 10_000) }),
  };
}
