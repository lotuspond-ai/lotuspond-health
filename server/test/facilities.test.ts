// Nearby labs API: routes with injected fake providers (no network), partner filtering, caching, validation,
// rate limits, and the profile's home area. Same harness as api.test.ts: in-memory PGlite and app.request().
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDatabase, type Database } from '../src/db/client.ts';
import { facilityCache, profiles } from '../src/db/schema.ts';
import { DiskFileStore } from '../src/lib/files.ts';
import type { AppEnv } from '../src/http.ts';
import { facilityService, type FacilityDeps } from '../src/facilities/index.ts';
import { ProviderError } from '../src/facilities/errors.ts';
import { parseOverpass, type PlaceRecord } from '../src/facilities/overpass.ts';
import { parseReverse, parseSearch, type Geocoder } from '../src/facilities/nominatim.ts';
import type { FacilityProviders, PlacesProvider } from '../src/facilities/providers.ts';
import { upsertPartners, validatePartners } from '../src/facilities/partners.ts';
import type { FacilitySearchResult, GeoCandidate, GeoReverse, Profile, PublicConfig, SessionInfo } from '../../shared/types.ts';

const migrations = fileURLToPath(new URL('../drizzle', import.meta.url));
const data = (name: string) => JSON.parse(fs.readFileSync(new URL(`../data/${name}`, import.meta.url), 'utf8'));

/** Indiranagar, Bengaluru: the recorded area. */
const HERE = { lat: 12.97194, lon: 77.64123 };

class FakePlaces implements PlacesProvider {
  calls: [number, number, number][] = [];
  fail = false;
  extra: PlaceRecord[] = [];
  private readonly records = parseOverpass(data('fixtures/overpass-indiranagar.json'));
  async nearby(lat: number, lon: number, radiusKm: number) {
    this.calls.push([lat, lon, radiusKm]);
    if (this.fail) throw new ProviderError('Overpass answered 504.');
    return [...this.records, ...this.extra];
  }
}

class FakeGeocoder implements Geocoder {
  searches: string[] = [];
  reverses: [number, number][] = [];
  fail = false;
  async search(q: string): Promise<GeoCandidate[]> {
    this.searches.push(q);
    if (this.fail) throw new ProviderError('Nominatim answered 503.');
    return parseSearch(data('fixtures/nominatim-search.json')).filter(c => `${c.label} ${c.detail}`.toLowerCase().includes(q));
  }
  async reverse(lat: number, lon: number): Promise<GeoReverse | null> {
    this.reverses.push([lat, lon]);
    if (this.fail) throw new ProviderError('Nominatim answered 503.');
    return lat > 0 ? parseReverse(data('fixtures/nominatim-reverse-indiranagar.json')) : null;
  }
}

let database: Database;
let filesDir: string;
let places: FakePlaces;
let geocoder: FakeGeocoder;
let app: Hono<AppEnv>;
let deps: FacilityDeps;

function makeApp(env: Record<string, string> = {}, providers?: FacilityProviders) {
  const config = loadConfig({ NODE_ENV: 'test', TRUST_PROXY: 'true', ...env });
  const d: FacilityDeps = { db: database.db, files: new DiskFileStore(filesDir), config, facilityProviders: providers ?? { places, geocoder } };
  return { app: createApp(d), deps: d };
}

before(async () => {
  database = await openDatabase({ url: process.env.TEST_DATABASE_URL });
  await database.migrate(migrations);
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspond-facilities-'));
  places = new FakePlaces();
  geocoder = new FakeGeocoder();
  ({ app, deps } = makeApp());
  const example = validatePartners(data('partners.example.json'));
  const others = validatePartners([
    { slug: 'closed-branch', brand: 'Demo Diagnostics', name: 'Demo Diagnostics, closed branch', address: 'Old road', country: 'IN', latitude: 12.9722, longitude: 77.6415, active: false },
    { slug: 'london-partner', brand: 'Example UK', name: 'Example UK Lab', address: 'Example Street', country: 'GB', latitude: 51.5075, longitude: -0.1278, services: ['blood'] },
  ]);
  await upsertPartners(database.db, [...example.labs, ...others.labs]);
});

after(async () => {
  await database.close();
  fs.rmSync(filesDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await database.db.delete(facilityCache);
  places.calls = [];
  places.fail = false;
  places.extra = [];
  geocoder.fail = false;
});

let clients = 0;
const run = Date.now().toString(36);
function client(target: () => Hono<AppEnv> = () => app) {
  const ip = `10.9.${++clients % 250}.1`;
  let cookie = '';
  async function call(method: string, url: string, body?: unknown) {
    const h: Record<string, string> = { 'sec-fetch-site': 'same-origin', 'x-forwarded-for': ip };
    if (cookie) h.cookie = cookie;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await target().request(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return res;
  }
  return {
    call,
    async json<T>(method: string, url: string, body?: unknown, expect = 200): Promise<T> {
      const res = await call(method, url, body);
      const text = await res.text();
      assert.equal(res.status, expect, `${method} ${url} → ${res.status} ${text}`);
      return (text ? JSON.parse(text) : null) as T;
    },
  };
}

let counter = 0;
async function signedIn(target?: () => Hono<AppEnv>) {
  const c = client(target);
  const info = await c.json<SessionInfo>('POST', '/api/auth/register', { email: `labs${++counter}.${run}@example.com`, password: 'lily pads everywhere', displayName: 'Asha' }, 201);
  return { c, self: info.profiles[0] };
}

const near = (q: Record<string, string | number>) => `/api/facilities?${new URLSearchParams(Object.entries({ lat: HERE.lat, lon: HERE.lon, ...q }).map(([k, v]): [string, string] => [k, String(v)]))}`;

describe('nearby facilities', () => {
  it('refuses signed-out requests', async () => {
    for (const url of [near({}), '/api/geo/search?q=indiranagar', '/api/geo/reverse?lat=12.97&lon=77.64']) {
      const res = await client().call('GET', url);
      assert.equal(res.status, 401, url);
    }
    assert.equal(places.calls.length + geocoder.searches.length, 0, 'no provider was asked');
  });

  it('lists places by distance within the radius', async () => {
    const { c } = await signedIn();
    const r = await c.json<FacilitySearchResult>('GET', near({ radius: 2 }));
    assert.equal(r.attribution, '© OpenStreetMap contributors');
    assert.equal(r.radiusKm, 2);
    assert.deepEqual(r.center, { lat: 12.9719, lon: 77.6412 });
    assert.ok(r.places.length >= 8, `${r.places.length} places`);
    assert.ok(r.places.every(p => p.distanceKm <= 2));
    const d = r.places.map(p => p.distanceKm);
    assert.deepEqual(d, [...d].sort((a, b) => a - b), 'sorted by distance');
    assert.equal(r.places[0].name, 'Lakeview Diagnostics Lab');
    assert.ok(!r.places.some(p => p.name === 'Koramangala Blood Test Centre'), '4.4 km away is outside 2 km');
    assert.equal(new Set(r.places.map(p => p.id)).size, r.places.length, 'no duplicates');
    const wide = await c.json<FacilitySearchResult>('GET', near({ radius: 25 }));
    assert.ok(wide.places.some(p => p.name === 'Whitefield Hospital'));
  });

  it('filters by kind', async () => {
    const { c } = await signedIn();
    const r = await c.json<FacilitySearchResult>('GET', near({ radius: 5, kinds: 'imaging,lab' }));
    assert.ok(r.places.length > 0);
    assert.ok(r.places.every(p => p.kind === 'imaging' || p.kind === 'lab'));
    const hospitals = await c.json<FacilitySearchResult>('GET', near({ radius: 5, kinds: 'hospital' }));
    assert.deepEqual(hospitals.places.map(p => p.name), ['Indiranagar Community Hospital', 'Old Airport Road General Hospital']);
  });

  it('calls out with rounded coordinates and never stores the precise point', async () => {
    const { c } = await signedIn();
    await c.json('GET', near({ radius: 5 }));
    assert.deepEqual(places.calls, [[12.97, 77.64, 6]], 'rounded to 2 decimals, radius bucket plus margin');
    const rows = await database.db.select().from(facilityCache);
    assert.deepEqual(rows.map(r => r.key), ['places:v1:12.97,77.64:5']);
    const stored = JSON.stringify(rows);
    assert.ok(!stored.includes('12.97194') && !stored.includes('77.64123'), 'precise coordinates are not in the cache');
  });

  it('answers from the cache for 7 days, then asks again', async () => {
    const { c } = await signedIn();
    const svc = facilityService(deps);
    const before = { ...svc.cache.stats };
    await c.json('GET', near({ radius: 5 }));
    await c.json('GET', `/api/facilities?lat=12.9741&lon=77.6377&radius=5`); // a neighbour in the same ~1 km cell
    assert.equal(places.calls.length, 1, 'second search was a cache hit');
    assert.equal(svc.cache.stats.misses - before.misses, 1);
    assert.equal(svc.cache.stats.hits - before.hits, 1);
    await database.db.update(facilityCache).set({ fetchedAt: new Date(Date.now() - 8 * 24 * 3600_000) });
    await c.json('GET', near({ radius: 5 }));
    assert.equal(places.calls.length, 2, 'a stale entry is fetched again');
    await c.json('GET', near({ radius: 10 }));
    assert.equal(places.calls.length, 3, 'another radius bucket is its own entry');
  });

  it('shares one provider call between concurrent searches', async () => {
    const { c } = await signedIn();
    await Promise.all([c.json('GET', near({ radius: 2 })), c.json('GET', near({ radius: 2 })), c.json('GET', near({ radius: 2 }))]);
    assert.equal(places.calls.length, 1);
  });

  it('validates coordinates, radius and kinds', async () => {
    const { c } = await signedIn();
    const cases: [string, RegExp][] = [
      ['/api/facilities?lon=77.64', /Latitude is required/],
      ['/api/facilities?lat=91&lon=77.64', /Latitude must be between -90 and 90/],
      ['/api/facilities?lat=12.97&lon=-181', /Longitude must be between/],
      ['/api/facilities?lat=abc&lon=77.64', /Latitude must be a number/],
      ['/api/facilities?lat=1e3&lon=77.64', /must be a number/],
      [near({ radius: 26 }), /Radius must be between 0.5 and 25/],
      [near({ radius: 0 }), /Radius must be between/],
      [near({ kinds: 'lab,pharmacy' }), /Kinds can be lab, imaging, hospital, clinic/],
      [near({ country: 'XX' }), /two-letter country code/],
    ];
    for (const [url, message] of cases) {
      const res = await c.call('GET', url);
      const body = await res.json() as { error: { code: string; message: string } };
      assert.equal(res.status, 400, url);
      assert.match(body.error.message, message, url);
    }
    assert.equal(places.calls.length, 0);
  });

  it('includes partner labs only where the country policy offers them', async () => {
    const { c } = await signedIn();
    const india = await c.json<FacilitySearchResult>('GET', near({ radius: 5, country: 'IN' }));
    assert.deepEqual(india.partners.map(p => p.slug), ['demo-diagnostics-indiranagar', 'example-path-lab-koramangala']);
    const demo = india.partners[0];
    assert.equal(demo.source, 'partner');
    assert.equal(demo.kind, 'lab');
    assert.equal(demo.bookingUrl, 'https://example.com/demo-diagnostics/book');
    assert.deepEqual(demo.services, ['blood', 'urine', 'home_collection', 'health_checkup']);
    assert.equal(demo.accreditation, 'NABL');
    assert.ok(demo.distanceKm < 0.2);
    assert.ok(!india.partners.some(p => p.slug === 'closed-branch'), 'inactive labs are hidden');
    const uk = await c.json<FacilitySearchResult>('GET', near({ radius: 5, country: 'GB' }));
    assert.deepEqual(uk.partners, [], 'not offered to people in the UK');
    const unknown = await c.json<FacilitySearchResult>('GET', near({ radius: 5 }));
    assert.deepEqual(unknown.partners, [], 'not offered when the country is unknown');
    const london = await c.json<FacilitySearchResult>('GET', '/api/facilities?lat=51.5074&lon=-0.1278&radius=5&country=IN');
    assert.deepEqual(london.partners, [], 'a partner in a country without partner labs never shows');
    const hsr = await c.json<FacilitySearchResult>('GET', near({ radius: 10, country: 'in', kinds: 'imaging' }));
    assert.deepEqual(hsr.partners.map(p => p.slug), ['sample-imaging-hsr-layout']);
    assert.equal(hsr.partners[0].kind, 'imaging');
  });

  it('leaves out the OpenStreetMap copy of a partner lab', async () => {
    const { c } = await signedIn();
    places.extra = [{ source: 'osm', id: 'osm:node/1', kind: 'lab', name: 'Demo Diagnostics', lat: 12.9728, lon: 77.6419, address: null, phone: null, website: null, openingHours: null, operator: null, emergency: false }];
    const india = await c.json<FacilitySearchResult>('GET', near({ radius: 2, country: 'IN' }));
    assert.ok(!india.places.some(p => p.id === 'osm:node/1'));
    const uk = await c.json<FacilitySearchResult>('GET', near({ radius: 2, country: 'GB' }));
    assert.ok(uk.places.some(p => p.id === 'osm:node/1'), 'shown as a public lab where partners are not offered');
  });

  it('says clearly when the provider is unreachable', async () => {
    const { c } = await signedIn();
    places.fail = true;
    const res = await c.call('GET', near({ radius: 2 }));
    assert.equal(res.status, 503);
    assert.ok(res.headers.get('retry-after'));
    const body = await res.json() as { error: { code: string; message: string } };
    assert.equal(body.error.code, 'search_unavailable');
    assert.match(body.error.message, /^Nearby search is unavailable right now/);
    const withPartners = await c.json<FacilitySearchResult>('GET', near({ radius: 2, country: 'IN' }));
    assert.equal(withPartners.partners.length, 1, 'partner labs still show');
    assert.deepEqual(withPartners.places, []);
    assert.equal(withPartners.notice?.code, 'search_unavailable');
    assert.equal((await database.db.select().from(facilityCache)).length, 0, 'failures are not cached');
  });

  it('rate-limits searches per account', async () => {
    const { c } = await signedIn();
    let last = 0;
    for (let i = 0; i < 41; i++) last = (await c.call('GET', near({ radius: 2 }))).status;
    assert.equal(last, 429);
    const other = await signedIn();
    assert.equal((await other.c.call('GET', near({ radius: 2 }))).status, 200, 'other accounts are not affected');
  });
});

describe('area search', () => {
  it('returns up to five candidates', async () => {
    const { c } = await signedIn();
    const r = await c.json<GeoCandidate[]>('GET', '/api/geo/search?q=Indira');
    assert.deepEqual(r.map(x => x.label), ['Indiranagar, Bengaluru', 'Indira Nagar, Chennai', '560038, Bengaluru']);
    assert.deepEqual(Object.keys(r[0]).sort(), ['country', 'detail', 'label', 'lat', 'lon', 'postalCode']);
    assert.equal(r[0].country, 'IN');
    const again = await c.json<GeoCandidate[]>('GET', '/api/geo/search?q=%20indira%20');
    assert.equal(again.length, 3);
    assert.deepEqual(geocoder.searches.filter(q => q === 'indira'), ['indira'], 'normalised queries share a cache entry');
  });

  it('validates the query', async () => {
    const { c } = await signedIn();
    for (const url of ['/api/geo/search', '/api/geo/search?q=a', `/api/geo/search?q=${'x'.repeat(121)}`]) {
      assert.equal((await c.call('GET', url)).status, 400, url);
    }
  });

  it('names a point, rounding it before asking', async () => {
    const { c } = await signedIn();
    geocoder.reverses = [];
    const r = await c.json<GeoReverse>('GET', '/api/geo/reverse?lat=12.971894&lon=77.641154');
    assert.deepEqual(r, { label: 'Indiranagar, Bengaluru', country: 'IN', postalCode: '560038' });
    assert.deepEqual(geocoder.reverses, [[12.97, 77.64]]);
    const sea = await c.json<GeoReverse>('GET', '/api/geo/reverse?lat=-30.5&lon=-20.25');
    assert.deepEqual(sea, { label: '30.50° S, 20.25° W', country: null, postalCode: null }, 'a point with no address');
    assert.equal((await c.call('GET', '/api/geo/reverse?lat=12.97')).status, 400);
  });

  it('reports an unreachable geocoder', async () => {
    const { c } = await signedIn();
    geocoder.fail = true;
    const res = await c.call('GET', '/api/geo/search?q=koramangala');
    assert.equal(res.status, 503);
    assert.match((await res.json() as { error: { message: string } }).error.message, /Nearby search is unavailable/);
  });
});

describe('turned off', () => {
  it('keeps partner labs but no outside lookups when FACILITY_SEARCH=off', async () => {
    const off = makeApp({ FACILITY_SEARCH: 'off' });
    const { c } = await signedIn(() => off.app);
    const cfg = await c.json<PublicConfig>('GET', '/api/config');
    assert.equal(cfg.nearbySearch, false);
    const res = await c.call('GET', '/api/geo/search?q=indiranagar');
    assert.equal(res.status, 503);
    assert.equal((await res.json() as { error: { code: string } }).error.code, 'search_off');
    const r = await c.json<FacilitySearchResult>('GET', near({ radius: 2, country: 'IN' }));
    assert.equal(r.partners.length, 1);
    assert.equal(r.notice?.code, 'search_off');
    assert.equal((await c.call('GET', near({ radius: 2 }))).status, 503);
    assert.equal(places.calls.length, 0);
  });
});

describe('public config', () => {
  it('serves map settings without sign-in', async () => {
    const res = await client().call('GET', '/api/config');
    assert.equal(res.status, 200);
    const cfg = await res.json() as PublicConfig;
    assert.equal(cfg.nearbySearch, true);
    assert.equal(cfg.map?.type, 'raster');
  });

  it('serves self-hosted map files with range requests', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspond-maps-'));
    fs.writeFileSync(path.join(dir, 'tiny.pmtiles'), Buffer.from('PMTiles\x03 example bytes'));
    const m = makeApp({ MAP_TILES_DIR: dir, MAP_PMTILES_URL: '/api/map/files/tiny.pmtiles' });
    const cfg = await (await m.app.request('/api/config')).json() as PublicConfig;
    assert.equal(cfg.map?.type, 'pmtiles');
    const res = await m.app.request('/api/map/files/tiny.pmtiles', { headers: { range: 'bytes=0-6' } });
    assert.equal(res.status, 206);
    assert.equal(await res.text(), 'PMTiles');
    assert.match(res.headers.get('cache-control') ?? '', /max-age=86400/);
    assert.equal((await m.app.request('/api/map/files/../etc/passwd')).status, 404);
    assert.equal((await m.app.request('/api/map/files/missing.pmtiles')).status, 404);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('home area on the profile', () => {
  it('stores the area with coordinates rounded to about 1 km', async () => {
    const { c, self } = await signedIn();
    const p = await c.json<Profile>('PATCH', `/api/profiles/${self.id}`, {
      country: 'in', locality: '  Indiranagar, Bengaluru ', postalCode: '560038', latitude: 12.971894, longitude: 77.641154,
    });
    assert.deepEqual([p.country, p.locality, p.postalCode, p.latitude, p.longitude], ['IN', 'Indiranagar, Bengaluru', '560038', 12.97, 77.64]);
    const [row] = await database.db.select({ latitude: profiles.latitude, longitude: profiles.longitude }).from(profiles).where(eq(profiles.id, self.id));
    assert.deepEqual([row.latitude, row.longitude], [12.97, 77.64], 'only the rounded value is in the database');
    const me = await c.json<SessionInfo>('GET', '/api/auth/me');
    assert.equal(me.profiles[0].locality, 'Indiranagar, Bengaluru');
    const cleared = await c.json<Profile>('PATCH', `/api/profiles/${self.id}`, { country: null, locality: null, postalCode: null, latitude: null, longitude: null });
    assert.deepEqual([cleared.country, cleared.locality, cleared.latitude, cleared.longitude], [null, null, null, null]);
    const family = await c.json<Profile>('POST', '/api/profiles', { displayName: 'Mira', relationship: 'child', locality: 'Koramangala', latitude: 12.935, longitude: 77.6245 }, 201);
    assert.deepEqual([family.latitude, family.longitude], [12.94, 77.62]);
  });

  it('validates the area', async () => {
    const { c, self } = await signedIn();
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ latitude: 12.97 }, /latitude and longitude together/],
      [{ latitude: 12.97, longitude: null }, /latitude and longitude together/],
      [{ latitude: 95, longitude: 77 }, /Latitude must be between -90 and 90/],
      [{ latitude: 12, longitude: 200 }, /Longitude must be between/],
      [{ country: 'Narnia' }, /Choose a country/],
      [{ postalCode: '<script>' }, /letters, digits/],
      [{ locality: 'x'.repeat(121) }, /120/],
    ];
    for (const [body, message] of bad) {
      const res = await c.call('PATCH', `/api/profiles/${self.id}`, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match((await res.json() as { error: { message: string } }).error.message, message);
    }
  });
});
