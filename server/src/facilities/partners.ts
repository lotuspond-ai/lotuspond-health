// Partner labs: the import format, upserts by slug, and nearby lookups.
import { and, between, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FacilityKind, PartnerLab, PartnerService } from '../../../shared/types.ts';
import { boundingBox, haversineKm, PARTNER_SERVICES } from '../../../shared/facilities.ts';
import { COUNTRY_CODES, countryPolicy, isCountryCode } from '../../../shared/regions.ts';
import type { Db } from '../db/client.ts';
import { partnerLabs, type PartnerLabRow } from '../db/schema.ts';
import { cleanWebsite } from './overpass.ts';

const text = (max: number) => z.string().trim().min(1).max(max);
const optional = (max: number) => z.string().trim().max(max).nullish().transform(v => v || null);
const httpUrl = z.string().trim().max(500).nullish()
  .refine(v => !v || (/^https?:\/\//i.test(v) && cleanWebsite(v) !== null), 'Use a full http(s) address.')
  .transform(v => (v ? cleanWebsite(v) : null));

/** One lab in an import file. See server/data/README.md. */
export const PartnerLabInput = z.object({
  slug: z.string().trim().min(2).max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lower-case letters, digits and hyphens.'),
  brand: text(120),
  name: text(200),
  address: text(300),
  locality: optional(120),
  region: optional(120),
  postalCode: optional(20),
  country: z.string().trim().toUpperCase().refine(isCountryCode, 'Use an ISO 3166-1 alpha-2 country code, such as IN.'),
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  phone: optional(40),
  website: httpUrl,
  bookingUrl: httpUrl,
  services: z.array(z.enum(PARTNER_SERVICES as [PartnerService, ...PartnerService[]])).max(20).default([]).transform(s => [...new Set(s)]),
  openingHours: optional(300),
  accreditation: optional(80),
  active: z.boolean().default(true),
}).strict();

export type PartnerLabInput = z.output<typeof PartnerLabInput>;

/** An import file: a list of labs, or { "labs": [...] }. */
export const PartnerImportFile = z.union([z.array(z.unknown()), z.object({ labs: z.array(z.unknown()) }).transform(f => f.labs)]);

export interface ImportProblem { index: number; slug?: string; message: string }

/** Validate every entry; returns the valid labs and a description of each invalid one. */
export function validatePartners(raw: unknown): { labs: PartnerLabInput[]; problems: ImportProblem[] } {
  const file = PartnerImportFile.safeParse(raw);
  if (!file.success) return { labs: [], problems: [{ index: -1, message: 'The file must hold a JSON list of labs, or an object with a "labs" list.' }] };
  const labs: PartnerLabInput[] = [];
  const problems: ImportProblem[] = [];
  const slugs = new Set<string>();
  file.data.forEach((entry, index) => {
    const r = PartnerLabInput.safeParse(entry);
    const slug = entry && typeof entry === 'object' && typeof (entry as { slug?: unknown }).slug === 'string' ? (entry as { slug: string }).slug : undefined;
    if (!r.success) {
      problems.push({ index, slug, message: r.error.issues.map(i => `${i.path.join('.') || 'entry'}: ${i.message}`).join('; ') });
    } else if (slugs.has(r.data.slug)) {
      problems.push({ index, slug, message: 'slug: appears more than once in this file' });
    } else {
      slugs.add(r.data.slug);
      labs.push(r.data);
    }
  });
  return { labs, problems };
}

/** Insert new labs and update existing ones (matched by slug). */
export async function upsertPartners(db: Db, labs: PartnerLabInput[]): Promise<{ created: number; updated: number }> {
  if (!labs.length) return { created: 0, updated: 0 };
  const existing = new Set((await db.select({ slug: partnerLabs.slug }).from(partnerLabs).where(inArray(partnerLabs.slug, labs.map(l => l.slug)))).map(r => r.slug));
  await db.transaction(async tx => {
    for (const lab of labs) {
      await tx.insert(partnerLabs).values(lab).onConflictDoUpdate({ target: partnerLabs.slug, set: { ...lab, updatedAt: new Date() } });
    }
  });
  const updated = labs.filter(l => existing.has(l.slug)).length;
  return { created: labs.length - updated, updated };
}

/** Countries whose policy offers partner labs (India today). */
export const PARTNER_COUNTRIES: readonly string[] = COUNTRY_CODES.filter(c => countryPolicy(c).partnerLabs);

/** Partner labs are offered to people whose country policy has them. */
export const partnersOffered = (country: string | null | undefined): boolean => !!country && countryPolicy(country).partnerLabs;

function partnerKind(services: string[]): FacilityKind {
  const specimens = services.some(s => s === 'blood' || s === 'urine' || s === 'home_collection');
  return services.includes('imaging') && !specimens ? 'imaging' : 'lab';
}

export function toPartnerLab(row: PartnerLabRow, distanceKm: number): PartnerLab {
  const services = row.services.filter((s): s is PartnerService => (PARTNER_SERVICES as readonly string[]).includes(s));
  return {
    source: 'partner', id: `partner:${row.slug}`, slug: row.slug, kind: partnerKind(services),
    brand: row.brand, name: row.name, lat: row.latitude, lon: row.longitude, distanceKm,
    address: row.address, locality: row.locality, region: row.region, postalCode: row.postalCode, country: row.country,
    phone: row.phone, website: row.website, bookingUrl: row.bookingUrl, services, openingHours: row.openingHours, accreditation: row.accreditation,
  };
}

/** Active partner labs within `radiusKm`, nearest first, in countries where partner labs are offered. */
export async function nearbyPartners(db: Db, lat: number, lon: number, radiusKm: number): Promise<PartnerLab[]> {
  if (!PARTNER_COUNTRIES.length) return [];
  const box = boundingBox(lat, lon, radiusKm);
  const rows = await db.select().from(partnerLabs).where(and(
    eq(partnerLabs.active, true),
    inArray(partnerLabs.country, [...PARTNER_COUNTRIES]),
    between(partnerLabs.latitude, box.south, box.north),
    // Longitude boxes that cross the antimeridian are rare for a 25 km radius; widen to everything there.
    box.west < -180 || box.east > 180 ? sql`true` : between(partnerLabs.longitude, box.west, box.east),
  ));
  return rows
    .map(r => toPartnerLab(r, haversineKm(lat, lon, r.latitude, r.longitude)))
    .filter(p => p.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);
}
