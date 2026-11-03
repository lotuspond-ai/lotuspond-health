// Nearby search: partner labs from our table plus OpenStreetMap places, and area search.
// Privacy: outgoing queries and cache keys use coordinates rounded to about 1 km. The precise point a person
// searches from is only used in memory to work out distances; it is never stored or logged.
import type { FacilityKind, FacilitySearchResult, GeoCandidate, GeoReverse, PartnerLab, Place } from '../../../shared/types.ts';
import { FACILITY_KINDS, haversineKm, MAX_RADIUS_KM, OSM_ATTRIBUTION, roundCoord } from '../../../shared/facilities.ts';
import type { Db } from '../db/client.ts';
import type { FacilityConfig } from '../config.ts';
import { FacilityCache, GEOCODE_TTL_MS, PLACES_TTL_MS } from './cache.ts';
import { FacilityError, FACILITY_MESSAGES, ProviderError } from './errors.ts';
import { normalizeName, type PlaceRecord } from './overpass.ts';
import { nearbyPartners, partnersOffered } from './partners.ts';
import type { FacilityProviders } from './providers.ts';

/** Places are fetched for these radii only, so nearby people share cache entries. */
const RADIUS_BUCKETS_KM = [1, 2, 5, 10, MAX_RADIUS_KM];
/** Rounding moves the query centre up to ~0.8 km; fetch a little wider so nothing within the radius is missed. */
const ROUNDING_MARGIN_KM = 1;
/** Most places returned in one answer. */
export const MAX_PLACES = 150;

export interface NearbyQuery {
  lat: number;
  lon: number;
  radiusKm: number;
  kinds?: FacilityKind[];
  country?: string | null;
}

const fixed = (n: number) => roundCoord(n).toFixed(2);

export class FacilityService {
  readonly cache: FacilityCache;
  private readonly db: Db;
  private readonly cfg: FacilityConfig;
  private readonly providers: FacilityProviders;

  constructor(db: Db, cfg: FacilityConfig, providers: FacilityProviders) {
    this.db = db;
    this.cfg = cfg;
    this.providers = providers;
    this.cache = new FacilityCache(db);
  }

  get searchEnabled(): boolean {
    return this.cfg.search;
  }

  /** OpenStreetMap places around the rounded point, from the cache when fresh. */
  private async placeRecords(lat: number, lon: number, radiusKm: number): Promise<PlaceRecord[]> {
    const bucket = RADIUS_BUCKETS_KM.find(b => b >= radiusKm) ?? MAX_RADIUS_KM;
    const rLat = roundCoord(lat), rLon = roundCoord(lon);
    const key = `places:v1:${fixed(rLat)},${fixed(rLon)}:${bucket}`;
    return this.cache.through(key, PLACES_TTL_MS, () => this.providers.places.nearby(rLat, rLon, bucket + ROUNDING_MARGIN_KM));
  }

  async nearby(q: NearbyQuery): Promise<FacilitySearchResult> {
    const kinds = new Set(q.kinds?.length ? q.kinds : FACILITY_KINDS);
    const radiusKm = Math.min(q.radiusKm, MAX_RADIUS_KM);
    const partners = partnersOffered(q.country)
      ? (await nearbyPartners(this.db, q.lat, q.lon, radiusKm)).filter(p => kinds.has(p.kind) || (kinds.has('imaging') && p.services.includes('imaging')))
      : [];

    let records: PlaceRecord[] = [];
    let notice: FacilitySearchResult['notice'];
    if (!this.cfg.search) {
      if (!partners.length) throw new FacilityError('search_off');
      notice = { code: 'search_off', message: FACILITY_MESSAGES.search_off };
    } else {
      try {
        records = await this.placeRecords(q.lat, q.lon, radiusKm);
      } catch (e) {
        if (!(e instanceof ProviderError)) throw e;
        console.warn('[facilities] places provider failed:', e.message);
        if (!partners.length) throw new FacilityError('search_unavailable');
        notice = { code: 'search_unavailable', message: FACILITY_MESSAGES.search_unavailable };
      }
    }

    const places: Place[] = records
      .filter(r => kinds.has(r.kind))
      .map(r => ({ ...r, distanceKm: round3(haversineKm(q.lat, q.lon, r.lat, r.lon)) }))
      .filter(p => p.distanceKm <= radiusKm && !duplicatesPartner(p, partners))
      .sort((a, b) => a.distanceKm - b.distanceKm || a.name.localeCompare(b.name))
      .slice(0, MAX_PLACES);

    return {
      partners: partners.map(p => ({ ...p, distanceKm: round3(p.distanceKm) })),
      places,
      attribution: OSM_ATTRIBUTION,
      center: { lat: roundCoord(q.lat, 4), lon: roundCoord(q.lon, 4) },
      radiusKm,
      ...(notice ? { notice } : {}),
    };
  }

  async search(q: string, lang: string): Promise<GeoCandidate[]> {
    if (!this.cfg.search) throw new FacilityError('search_off');
    const norm = q.trim().replace(/\s+/g, ' ').toLowerCase();
    try {
      return await this.cache.through(`geo:search:v1:${lang}:${norm}`, GEOCODE_TTL_MS, () => this.providers.geocoder.search(norm, lang));
    } catch (e) {
      if (e instanceof ProviderError) {
        console.warn('[facilities] geocoder failed:', e.message);
        throw new FacilityError('search_unavailable');
      }
      throw e;
    }
  }

  async reverse(lat: number, lon: number, lang: string): Promise<GeoReverse> {
    if (!this.cfg.search) throw new FacilityError('search_off');
    const rLat = roundCoord(lat), rLon = roundCoord(lon);
    let found: GeoReverse | null;
    try {
      found = await this.cache.through(`geo:rev:v1:${lang}:${fixed(rLat)},${fixed(rLon)}`, GEOCODE_TTL_MS, () => this.providers.geocoder.reverse(rLat, rLon, lang));
    } catch (e) {
      if (e instanceof ProviderError) {
        console.warn('[facilities] geocoder failed:', e.message);
        throw new FacilityError('search_unavailable');
      }
      throw e;
    }
    return found ?? { label: coordinateLabel(rLat, rLon), country: null, postalCode: null };
  }
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** "12.97° N, 77.64° E" for points with no named area. */
export function coordinateLabel(lat: number, lon: number): string {
  return `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(2)}° ${lon >= 0 ? 'E' : 'W'}`;
}

/** An OpenStreetMap entry for a partner lab (same name, within 150 m) is left out; the partner card shows it. */
function duplicatesPartner(p: Place, partners: PartnerLab[]): boolean {
  if (!partners.length) return false;
  const n = normalizeName(p.name);
  return partners.some(x => {
    if (haversineKm(p.lat, p.lon, x.lat, x.lon) > 0.15) return false;
    const m = normalizeName(x.name), b = normalizeName(x.brand);
    return n === m || (n.length >= 4 && (m.includes(n) || n.includes(m) || (b.length >= 4 && n.includes(b))));
  });
}
