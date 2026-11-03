// Unit tests for nearby search: Overpass and Nominatim parsing, classification, geocoder etiquette, map settings
// and opening hours. Recorded responses live in server/data/fixtures (and test/fixtures for edge cases).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { classifyFacility, cleanWebsite, overpassQuery, parseOverpass, pickPhone } from '../src/facilities/overpass.ts';
import { NominatimGeocoder, parseReverse, parseSearch } from '../src/facilities/nominatim.ts';
import { FacilityError, ProviderError } from '../src/facilities/errors.ts';
import { OverpassProvider } from '../src/facilities/providers.ts';
import { addCspSources, mapCspSources, mapSettings } from '../src/facilities/map.ts';
import { validatePartners } from '../src/facilities/partners.ts';
import { loadConfig } from '../src/config.ts';
import { haversineKm, roundCoord } from '../../shared/facilities.ts';
import { openState, parseOpeningHours } from '../../shared/opening-hours.ts';

const data = (name: string) => JSON.parse(fs.readFileSync(new URL(`../data/${name}`, import.meta.url), 'utf8'));
const fixture = (name: string) => data(`fixtures/${name}`);

describe('Overpass parsing', () => {
  const places = parseOverpass(fixture('overpass-indiranagar.json'));
  const byName = (n: string) => places.find(p => p.name === n);

  it('builds a radius query for every facility kind with centres for ways and relations', () => {
    const q = overpassQuery(12.97, 77.64, 6000);
    assert.match(q, /^\[out:json\]\[timeout:\d+\];/);
    assert.match(q, /nwr\(around:6000,12\.97,77\.64\)\["healthcare"="laboratory"\]/);
    for (const tag of ['"amenity"="hospital"', '"healthcare"="hospital"', '"amenity"="clinic"', '"healthcare"="clinic"', '"healthcare:speciality"~"radiology']) {
      assert.ok(q.includes(tag), `query includes ${tag}`);
    }
    assert.match(q, /"name"~"scan\|imaging\|diagnostic/);
    assert.match(q, /out center tags;$/);
  });

  it('classifies labs, imaging centres, hospitals and clinics', () => {
    assert.equal(byName('Lakeview Diagnostics Lab')?.kind, 'lab');
    assert.equal(byName('Sunrise Path Lab')?.kind, 'lab', 'a clinic named "Path Lab" is a lab');
    assert.equal(byName('Clearview Scans & Imaging')?.kind, 'imaging', 'radiology speciality');
    assert.equal(byName('Ulsoor Imaging')?.kind, 'imaging', 'nuclear medicine speciality');
    assert.equal(byName('Metro Diagnostic Centre')?.kind, 'imaging', 'named "Diagnostic"');
    assert.equal(byName('Domlur X-Ray Centre')?.kind, 'imaging', 'doctors named "X-Ray"');
    assert.equal(byName('Indiranagar Community Hospital')?.kind, 'hospital');
    assert.equal(byName('Old Airport Road General Hospital')?.kind, 'hospital');
    assert.equal(byName('12th Main Family Clinic')?.kind, 'clinic');
  });

  it('classifies from tags alone', () => {
    assert.equal(classifyFacility({ amenity: 'hospital', name: 'Imaging Hospital' }), 'hospital');
    assert.equal(classifyFacility({ healthcare: 'laboratory', 'healthcare:speciality': 'radiology' }), 'lab');
    assert.equal(classifyFacility({ healthcare: 'clinic', 'healthcare:speciality': 'pathology' }), 'lab');
    assert.equal(classifyFacility({ healthcare: 'clinic', name: 'City MRI & CT Scan' }), 'imaging');
    assert.equal(classifyFacility({ amenity: 'clinic', name: 'Labour Ward Clinic' }), 'clinic', '"Labour" is not a lab');
    assert.equal(classifyFacility({ amenity: 'pharmacy', name: 'Diagnostic Pharmacy' }), null);
    assert.equal(classifyFacility({ shop: 'chemist', name: 'Scan Mart' }), null);
    assert.equal(classifyFacility({ healthcare: 'dentist', name: 'Smile Dental' }), null);
  });

  it('drops unnamed and unrelated elements and merges a place mapped twice', () => {
    assert.ok(!places.some(p => p.name === 'Lily Pharmacy'));
    assert.ok(!places.some(p => p.name === 'HAL 2nd Stage Dental Care'));
    assert.equal(places.filter(p => p.name === 'Indiranagar Community Hospital').length, 1);
    const hospital = byName('Indiranagar Community Hospital')!;
    assert.equal(hospital.id, 'osm:way/9900000201', 'the more detailed copy is kept');
    assert.equal(places.length, 15);
    assert.equal(new Set(places.map(p => p.id)).size, places.length);
  });

  it('extracts name, address, phone, website, hours and operator', () => {
    const lab = byName('Lakeview Diagnostics Lab')!;
    assert.equal(lab.address, '512 100 Feet Road, Indiranagar, Bengaluru, 560038');
    assert.equal(lab.phone, '+91 80 0000 0101');
    assert.equal(lab.website, 'https://www.lakeview-diagnostics.example/');
    assert.equal(lab.openingHours, 'Mo-Sa 07:00-21:00; Su 07:00-13:00');
    const hospital = byName('Indiranagar Community Hospital')!;
    assert.equal(hospital.phone, '+91 80 0000 0201', 'contact:phone');
    assert.equal(hospital.website, 'https://community-hospital.example/', 'contact:website');
    assert.equal(hospital.operator, 'Indiranagar Health Trust');
    assert.equal(hospital.emergency, true);
    assert.deepEqual([hospital.lat, hospital.lon], [12.9781, 77.639], 'way centre');
    const relation = byName('Old Airport Road General Hospital')!;
    assert.deepEqual([relation.lat, relation.lon], [12.96, 77.662], 'relation centre');
    assert.equal(byName('CMH Road Clinic')!.phone, '+91 80 0000 1301', 'first of several numbers');
    assert.ok(byName('Arogya Clinic'), 'English name used when the name is in another script');
  });

  it('cleans phone numbers and websites', () => {
    assert.equal(pickPhone({ phone: 'call us' }), null);
    assert.equal(pickPhone({ 'contact:mobile': '+44 20 7946 0000' }), '+44 20 7946 0000');
    assert.equal(cleanWebsite('javascript:alert(1)'), null);
    assert.equal(cleanWebsite('ftp://files.example'), null);
    assert.equal(cleanWebsite('lab.example/path'), 'https://lab.example/path');
  });

  it('rejects malformed responses and runtime errors', () => {
    assert.throws(() => parseOverpass('<html>busy</html>'), ProviderError);
    assert.throws(() => parseOverpass({ elements: 'nope' }), ProviderError);
    assert.throws(() => parseOverpass({ elements: [], remark: 'runtime error: Query timed out in "query" at line 3 after 26 seconds.' }), ProviderError);
    assert.deepEqual(parseOverpass({ elements: [{ type: 'node', id: 1 }, { type: 'node', id: 2, lat: 'x', lon: 1, tags: { amenity: 'clinic', name: 'X' } }, null] }), []);
  });
});

describe('geocoder parsing', () => {
  const results = parseSearch(fixture('nominatim-search.json'), 50);

  it('turns search results into short labels with country and postcode', () => {
    const [indiranagar, chennai, postcode] = results;
    assert.deepEqual(
      { label: indiranagar.label, lat: indiranagar.lat, lon: indiranagar.lon, country: indiranagar.country, postalCode: indiranagar.postalCode },
      { label: 'Indiranagar, Bengaluru', lat: 12.9718915, lon: 77.6411545, country: 'IN', postalCode: '560038' },
    );
    assert.match(indiranagar.detail ?? '', /Karnataka/);
    assert.equal(chennai.label, 'Indira Nagar, Chennai');
    assert.equal(postcode.label, '560038, Bengaluru', 'postcode results are labelled by the postcode');
    assert.equal(results.find(r => r.country === 'GB')?.label, 'London, England');
  });

  it('returns at most five candidates and skips results without coordinates', () => {
    assert.equal(parseSearch(fixture('nominatim-search.json')).length, 5);
    assert.deepEqual(parseSearch([{ display_name: 'Nowhere' }, { lat: '91', lon: '0', name: 'Bad' }]), []);
    assert.throws(() => parseSearch({ error: 'nope' }), ProviderError);
  });

  it('names the area around a point', () => {
    assert.deepEqual(parseReverse(fixture('nominatim-reverse-indiranagar.json')), { label: 'Indiranagar, Bengaluru', country: 'IN', postalCode: '560038' });
    assert.equal(parseReverse({ error: 'Unable to geocode' }), null);
    assert.throws(() => parseReverse([]), ProviderError);
  });
});

/** fetch stand-in that records requests and answers with JSON (or fails). */
function fakeFetch(answer: (url: string, init?: RequestInit) => unknown | Promise<unknown>) {
  const calls: { url: string; init?: RequestInit; at: number }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init, at: Date.now() });
    const body = await answer(url, init);
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fn, calls };
}

describe('outside services', () => {
  it('identifies itself to Nominatim and spaces requests at least a second apart', async () => {
    const f = fakeFetch(() => fixture('nominatim-search.json'));
    const g = new NominatimGeocoder({ baseUrl: 'https://geo.example', userAgent: 'LotusPondHealth/test (contact ops@example.com)', email: 'ops@example.com', timeoutMs: 2000, minIntervalMs: 300, fetch: f.fn });
    await Promise.all([g.search('indiranagar', 'en'), g.search('koramangala', 'en'), g.reverse(12.97, 77.64, 'en-IN').catch(() => null)]);
    assert.equal(f.calls.length, 3);
    const gaps = f.calls.slice(1).map((c, i) => c.at - f.calls[i].at);
    // Unthrottled, the gaps would be about 0 ms; the margin absorbs timer jitter on a busy machine.
    assert.ok(gaps.every(g => g >= 220) && f.calls[2].at - f.calls[0].at >= 540, `requests were spaced out (${gaps.join(', ')} ms)`);
    const first = new URL(f.calls[0].url);
    assert.equal(first.pathname, '/search');
    assert.equal(first.searchParams.get('format'), 'jsonv2');
    assert.equal(first.searchParams.get('email'), 'ops@example.com');
    const headers = f.calls[0].init?.headers as Record<string, string> | undefined;
    assert.equal(headers?.['User-Agent'], 'LotusPondHealth/test (contact ops@example.com)');
    assert.equal(new URL(f.calls[2].url).searchParams.get('accept-language'), 'en-IN');
  });

  it('refuses to queue a long way behind other requests', async () => {
    const f = fakeFetch(() => []);
    const g = new NominatimGeocoder({ baseUrl: 'https://geo.example', userAgent: 'x', timeoutMs: 1000, minIntervalMs: 400, maxWaitMs: 500, fetch: f.fn });
    const results = await Promise.allSettled([g.search('a', 'en'), g.search('b', 'en'), g.search('c', 'en')]);
    assert.equal(results[2].status, 'rejected');
    assert.ok((results[2] as PromiseRejectedResult).reason instanceof FacilityError);
  });

  it('reports errors, bad answers and timeouts as provider errors', async () => {
    const down = new NominatimGeocoder({ baseUrl: 'https://geo.example', userAgent: 'x', timeoutMs: 1000, minIntervalMs: 0, fetch: fakeFetch(() => new Response('slow down', { status: 429 })).fn });
    await assert.rejects(down.search('x', 'en'), ProviderError);
    const html = new NominatimGeocoder({ baseUrl: 'https://geo.example', userAgent: 'x', timeoutMs: 1000, minIntervalMs: 0, fetch: fakeFetch(() => new Response('<html>', { status: 200 })).fn });
    await assert.rejects(html.search('x', 'en'), ProviderError);
    // AbortSignal.timeout does not keep the process alive, so the stand-in holds a timer of its own.
    const hang = fakeFetch((_url, init) => new Promise((_, reject) => {
      const backstop = setTimeout(() => reject(new Error('the request was never aborted')), 3000);
      init?.signal?.addEventListener('abort', () => { clearTimeout(backstop); reject(init.signal!.reason); });
    }));
    const overpass = new OverpassProvider({ url: 'https://overpass.example/api/interpreter', userAgent: 'x', timeoutMs: 100, fetch: hang.fn });
    const started = Date.now();
    await assert.rejects(overpass.nearby(12.97, 77.64, 3), ProviderError);
    assert.ok(Date.now() - started < 2000, 'timed out promptly');
  });

  it('posts the Overpass query as form data', async () => {
    const f = fakeFetch(() => fixture('overpass-indiranagar.json'));
    const overpass = new OverpassProvider({ url: 'https://overpass.example/api/interpreter', userAgent: 'LotusPondHealth/test', timeoutMs: 5000, fetch: f.fn });
    const places = await overpass.nearby(12.97, 77.64, 3);
    assert.equal(places.length, 15);
    assert.equal(f.calls[0].init?.method, 'POST');
    const sent = new URLSearchParams(String(f.calls[0].init?.body)).get('data') ?? '';
    assert.match(sent, /around:3000,12\.97,77\.64/);
  });
});

describe('geometry and partner files', () => {
  it('rounds coordinates to about a kilometre and measures distances', () => {
    assert.equal(roundCoord(12.971894), 12.97);
    assert.equal(roundCoord(-0.127765), -0.13);
    assert.equal(roundCoord(-0.001), 0);
    const km = haversineKm(12.9719, 77.6412, 12.9352, 77.6245);
    assert.ok(km > 4.4 && km < 4.6, `${km}`);
    assert.ok(haversineKm(12.97, 77.64, 12.975, 77.645) < 0.8, 'rounding moves a point by under a kilometre');
  });

  it('validates the example partner file and reports problems by entry', () => {
    const ok = validatePartners(data('partners.example.json'));
    assert.equal(ok.problems.length, 0);
    assert.equal(ok.labs.length, 3);
    assert.ok(ok.labs.every(l => l.name.endsWith('(example)') && l.country === 'IN'));
    const bad = validatePartners([
      { slug: 'Bad Slug', brand: 'X', name: 'X', address: 'X', country: 'IN', latitude: 1, longitude: 1 },
      { slug: 'no-country', brand: 'X', name: 'X', address: 'X', country: 'ZZ', latitude: 1, longitude: 1 },
      { slug: 'bad-link', brand: 'X', name: 'X', address: 'X', country: 'IN', latitude: 1, longitude: 1, bookingUrl: 'javascript:alert(1)' },
      { slug: 'extra', brand: 'X', name: 'X', address: 'X', country: 'IN', latitude: 1, longitude: 1, surprise: true },
      { slug: 'ok-one', brand: 'X', name: 'X', address: 'X', country: 'in', latitude: 1, longitude: 1, services: ['blood', 'blood'] },
      { slug: 'ok-one', brand: 'Y', name: 'Y', address: 'Y', country: 'IN', latitude: 2, longitude: 2 },
    ]);
    assert.deepEqual(bad.problems.map(p => p.index), [0, 1, 2, 3, 5]);
    assert.match(bad.problems[0].message, /slug/);
    assert.match(bad.problems[4].message, /more than once/);
    assert.deepEqual(bad.labs.map(l => [l.slug, l.country, l.services]), [['ok-one', 'IN', ['blood']]]);
    assert.equal(validatePartners('nope').problems[0].index, -1);
  });
});

describe('map settings', () => {
  it('falls back to OpenStreetMap raster tiles and lists their host for the CSP', () => {
    const cfg = loadConfig({ NODE_ENV: 'test' });
    const s = mapSettings(cfg);
    assert.equal(s.type, 'raster');
    assert.deepEqual(mapCspSources(cfg), { img: ['https://tile.openstreetmap.org'], connect: ['https://tile.openstreetmap.org'] });
    const csp = addCspSources("default-src 'self'; img-src 'self' data:; connect-src 'self'", mapCspSources(cfg));
    assert.equal(csp, "default-src 'self'; img-src 'self' data: https://tile.openstreetmap.org; connect-src 'self' https://tile.openstreetmap.org");
  });

  it('prefers a self-hosted PMTiles file, then a style URL', () => {
    const own = loadConfig({ NODE_ENV: 'test', MAP_PMTILES_URL: '/api/map/files/india.pmtiles', MAP_ASSETS_URL: '/api/map/files/assets/' });
    const s = mapSettings(own);
    assert.ok(s.type === 'pmtiles');
    assert.deepEqual([s.url, s.assetsUrl], ['/api/map/files/india.pmtiles', '/api/map/files/assets']);
    assert.match(s.attribution, /OpenStreetMap/);
    assert.deepEqual(mapCspSources(own), { img: [], connect: [] }, 'nothing extra when everything is served by this server');
    const cdn = loadConfig({ NODE_ENV: 'test', MAP_PMTILES_URL: 'https://maps.example.org/india.pmtiles' });
    assert.deepEqual(mapCspSources(cdn).connect, ['https://maps.example.org', 'https://protomaps.github.io']);
    const style = loadConfig({ NODE_ENV: 'test', MAP_STYLE_URL: 'https://tiles.example.net/styles/light.json' });
    assert.deepEqual(mapSettings(style), { type: 'style', url: 'https://tiles.example.net/styles/light.json' });
  });

  it('keeps the fixture provider out of production', () => {
    assert.throws(() => loadConfig({ NODE_ENV: 'production', FACILITY_PROVIDER: 'fixture' }), /development only/);
    assert.equal(loadConfig({ NODE_ENV: 'test', FACILITY_SEARCH: 'off' }).facilities.search, false);
  });
});

describe('opening hours', () => {
  // 2026-11-02 is a Monday.
  const at = (day: number, time: string) => new Date(`2026-11-${String(2 + day).padStart(2, '0')}T${time}:00`);

  it('evaluates weekday ranges, split days and overrides', () => {
    const v = 'Mo-Sa 07:00-21:00; Su 07:00-13:00';
    assert.deepEqual(openState(v, at(0, '08:30')), { open: true, until: '21:00' });
    assert.deepEqual(openState(v, at(6, '14:00')), { open: false, opensAt: undefined });
    assert.deepEqual(openState(v, at(2, '06:00')), { open: false, opensAt: '07:00' });
    const split = 'Mo-Fr 09:00-13:00,17:00-21:00; Sa 09:00-13:00';
    assert.equal(openState(split, at(1, '15:00'))?.open, false);
    assert.equal(openState(split, at(1, '15:00'))?.opensAt, '17:00');
    assert.equal(openState(split, at(5, '10:00'))?.open, true);
    assert.equal(openState(split, at(6, '10:00'))?.open, false);
    assert.equal(openState('Mo-Fr 08:00-20:00, Sa 09:00-14:00', at(5, '13:00'))?.open, true);
    assert.equal(openState('Mo-Su 08:00-20:00; We off', at(2, '10:00'))?.open, false);
    assert.equal(openState('Mo,We,Fr 09:00-17:00', at(1, '10:00'))?.open, false);
    assert.equal(openState('Mo-Sa 09:00-21:00; Su off; PH off', at(0, '10:00'))?.open, true);
  });

  it('handles 24/7 and hours past midnight', () => {
    assert.deepEqual(openState('24/7'), { open: true, always: true });
    assert.deepEqual(openState('Mo-Su 00:00-24:00'), { open: true, always: true });
    assert.deepEqual(openState('Mo-Su 18:00-02:00', at(1, '01:00')), { open: true, until: '02:00' });
    assert.deepEqual(openState('Fr 20:00-03:00', at(5, '01:30')), { open: true, until: '03:00' }, 'Friday night into Saturday');
    assert.equal(openState('Fr 20:00-03:00', at(6, '01:30'))?.open, false);
  });

  it('declines values outside the simple subset', () => {
    for (const v of ['Mo-Fr 08:00-18:00; Sa 08:00-12:00 "by appointment"', 'sunrise-sunset', 'Jan-Mar Mo-Fr 09:00-17:00', 'Mo[1] 09:00-12:00',
      'Mo-Fr 09:00-17:00 || "call ahead"', 'Mo-Fr 9am-5pm', 'by appointment', '', 'Mo-Fr 25:00-26:00']) {
      assert.equal(openState(v, at(0, '10:00')), null, v);
    }
    assert.equal(parseOpeningHours('PH off'), null, 'only a holiday rule');
  });
});
