// OpenStreetMap places through the Overpass API: the radius query, and turning its JSON into facilities.
// Format reference: https://wiki.openstreetmap.org/wiki/Overpass_API/Overpass_QL (output `out center tags`).
import type { FacilityKind, Place } from '../../../shared/types.ts';
import { haversineKm } from '../../../shared/facilities.ts';
import { ProviderError } from './errors.ts';

/** A place as cached: everything except the distance, which depends on the searched point. */
export type PlaceRecord = Omit<Place, 'distanceKm'>;

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

const NAME_HINTS = 'scan|imaging|diagnostic|radiology|x-?ray|mri|patholog|laborator';

/** Overpass QL for health facilities within `radiusM` metres. Ways and relations come back with a centre point. */
export function overpassQuery(lat: number, lon: number, radiusM: number, timeoutS = 25): string {
  const around = `(around:${Math.round(radiusM)},${lat},${lon})`;
  return [
    `[out:json][timeout:${timeoutS}];`,
    '(',
    `  nwr${around}["healthcare"="laboratory"];`,
    `  nwr${around}["amenity"="hospital"];`,
    `  nwr${around}["healthcare"="hospital"];`,
    `  nwr${around}["amenity"="clinic"];`,
    `  nwr${around}["healthcare"="clinic"];`,
    `  nwr${around}["healthcare:speciality"~"radiology|nuclear_medicine|imaging",i];`,
    `  nwr${around}["healthcare"]["name"~"${NAME_HINTS}",i];`,
    `  nwr${around}["amenity"="doctors"]["name"~"${NAME_HINTS}",i];`,
    ');',
    'out center tags;',
  ].join('\n');
}

const IMAGING_SPECIALITY = /(^|;)\s*(radiology|diagnostic_radiology|nuclear_medicine|imaging|interventional_radiology)\s*(;|$)/i;
const LAB_SPECIALITY = /(^|;)\s*(pathology|clinical_pathology|biochemistry|haematology|microbiology)\s*(;|$)/i;
const LAB_NAME = /\b(lab|labs|laborator(y|ies)|patholog(y|ical)|path\s?lab|pathlabs?|blood\s+(test|collection))\b/i;
const IMAGING_NAME = /\b(scans?|scanning|imaging|radiology|x-?rays?|mri|ct|ultrasound|sonography|diagnostics?)\b/i;

/** Which kind of facility a set of OpenStreetMap tags describes, or null when it is none of ours. */
export function classifyFacility(tags: Record<string, string>): FacilityKind | null {
  const hc = (tags.healthcare ?? '').toLowerCase();
  const amenity = (tags.amenity ?? '').toLowerCase();
  const speciality = tags['healthcare:speciality'] ?? '';
  const name = `${tags.name ?? ''} ${tags['name:en'] ?? ''}`;
  if (amenity === 'hospital' || hc === 'hospital') return 'hospital';
  if (hc === 'laboratory' || amenity === 'laboratory' || (LAB_SPECIALITY.test(speciality) && !IMAGING_SPECIALITY.test(speciality))) return 'lab';
  if (hc === 'imaging' || hc === 'radiology' || IMAGING_SPECIALITY.test(speciality)) return 'imaging';
  const medical = !!hc || amenity === 'clinic' || amenity === 'doctors';
  if (medical && LAB_NAME.test(name)) return 'lab';
  if (medical && IMAGING_NAME.test(name)) return 'imaging';
  if (amenity === 'clinic' || hc === 'clinic' || amenity === 'doctors' || hc === 'doctor' || hc === 'centre') return 'clinic';
  return null;
}

const clean = (s: string | undefined, max = 200) => {
  const t = s?.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
};

function pickName(tags: Record<string, string>): string | null {
  const name = clean(tags.name), en = clean(tags['name:en']);
  if (name && (/[A-Za-z]/.test(name) || !en)) return name;
  return en ?? name ?? clean(tags.brand) ?? clean(tags.operator);
}

function pickAddress(tags: Record<string, string>): string | null {
  const full = clean(tags['addr:full']);
  if (full) return full;
  const street = [tags['addr:housenumber'] ?? tags['addr:housename'], tags['addr:street'] ?? tags['addr:place']].filter(Boolean).join(' ');
  const area = tags['addr:suburb'] ?? tags['addr:neighbourhood'] ?? tags['addr:quarter'] ?? tags['addr:district'];
  const city = tags['addr:city'] ?? tags['addr:town'] ?? tags['addr:village'];
  const parts: string[] = [];
  for (const p of [street, area, city, tags['addr:postcode']]) {
    const c = clean(p, 120);
    if (c && !parts.some(x => x.toLowerCase() === c.toLowerCase())) parts.push(c);
  }
  return parts.length ? parts.join(', ') : null;
}

/** First usable phone number ("+91 80 1234 5678; +91 98…" → the first). */
export function pickPhone(tags: Record<string, string>): string | null {
  for (const key of ['phone', 'contact:phone', 'contact:mobile', 'mobile']) {
    for (const raw of (tags[key] ?? '').split(/[;,]/)) {
      const p = raw.trim();
      if (p.replace(/\D/g, '').length >= 5 && p.length <= 40 && /^[+\d\s().\-/]+$/.test(p)) return p;
    }
  }
  return null;
}

/** An http(s) website, with a scheme added when the tag leaves it out. */
export function cleanWebsite(raw: string | undefined | null): string | null {
  const v = raw?.split(';')[0]?.trim();
  if (!v || v.length > 300) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

function isElement(e: unknown): e is OverpassElement {
  if (!e || typeof e !== 'object') return false;
  const x = e as Record<string, unknown>;
  return (x.type === 'node' || x.type === 'way' || x.type === 'relation') && typeof x.id === 'number';
}

/** Facilities in an Overpass JSON response (classified, named, de-duplicated). Throws on a malformed response. */
export function parseOverpass(json: unknown): PlaceRecord[] {
  if (!json || typeof json !== 'object' || !Array.isArray((json as { elements?: unknown }).elements)) {
    throw new ProviderError('Overpass answered with something other than JSON elements.');
  }
  const remark = (json as { remark?: unknown }).remark;
  if (typeof remark === 'string' && /runtime error|timed out|out of memory/i.test(remark)) {
    throw new ProviderError(`Overpass could not finish the query: ${remark.slice(0, 120)}`);
  }
  const out: PlaceRecord[] = [];
  const seen = new Set<string>();
  for (const el of (json as { elements: unknown[] }).elements) {
    if (!isElement(el) || !el.tags) continue;
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const kind = classifyFacility(el.tags);
    const name = pickName(el.tags);
    if (!kind || !name) continue;
    const id = `osm:${el.type}/${el.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const t = el.tags;
    out.push({
      source: 'osm', id, kind, name, lat, lon,
      address: pickAddress(t),
      phone: pickPhone(t),
      website: cleanWebsite(t.website ?? t['contact:website'] ?? t.url),
      openingHours: clean(t.opening_hours, 300),
      operator: clean(t.operator, 120),
      emergency: t.emergency === 'yes',
    });
  }
  return dedupePlaces(out);
}

export const normalizeName = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '');

const richness = (p: PlaceRecord) => [p.address, p.phone, p.website, p.openingHours, p.operator].filter(Boolean).length;

/** The same facility is often mapped twice (a point and a building outline). Keep the more detailed one. */
export function dedupePlaces(list: PlaceRecord[], withinKm = 0.08): PlaceRecord[] {
  const kept: PlaceRecord[] = [];
  const byName = new Map<string, number[]>();
  for (const p of list) {
    const k = normalizeName(p.name);
    const group = byName.get(k) ?? [];
    const twin = group.find(i => { const q = kept[i]; return haversineKm(p.lat, p.lon, q.lat, q.lon) <= withinKm; });
    if (twin === undefined) {
      group.push(kept.length);
      kept.push(p);
    } else if (richness(p) > richness(kept[twin])) {
      // A hospital mapped twice stays a hospital even if the richer copy is tagged differently.
      kept[twin] = { ...p, kind: kept[twin].kind === 'hospital' ? 'hospital' : p.kind };
    }
    byName.set(k, group);
  }
  return kept;
}
