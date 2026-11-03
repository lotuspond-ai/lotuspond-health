// GET /api/facilities: partner labs and public labs, imaging centres, hospitals and clinics near a point.
import { Hono } from 'hono';
import { z } from 'zod';
import type { FacilityKind } from '../../../shared/types.ts';
import { DEFAULT_RADIUS_KM, FACILITY_KINDS, MAX_RADIUS_KM } from '../../../shared/facilities.ts';
import { isCountryCode } from '../../../shared/regions.ts';
import { tooMany } from '../lib/errors.ts';
import { RateLimiter } from '../lib/rate-limit.ts';
import { requireAuth, type AppEnv } from '../http.ts';
import { facilityService, type FacilityDeps } from '../facilities/index.ts';
import { latParam, lonParam, readQuery, unavailable } from '../facilities/http.ts';

const NearbyQuery = z.object({
  lat: latParam,
  lon: lonParam,
  radius: z.string().trim().regex(/^\d{1,2}(\.\d{1,3})?$/, 'Radius must be a number of kilometres.').transform(Number)
    .pipe(z.number().min(0.5, `Radius must be between 0.5 and ${MAX_RADIUS_KM} km.`).max(MAX_RADIUS_KM, `Radius must be between 0.5 and ${MAX_RADIUS_KM} km.`))
    .optional(),
  kinds: z.string().trim().max(60).optional().transform((s, ctx) => {
    if (!s) return undefined;
    const list = [...new Set(s.split(',').map(k => k.trim()).filter(Boolean))];
    const bad = list.find(k => !(FACILITY_KINDS as readonly string[]).includes(k));
    if (bad) {
      ctx.issues.push({ code: 'custom', message: `Kinds can be ${FACILITY_KINDS.join(', ')}.`, input: s });
      return z.NEVER;
    }
    return list as FacilityKind[];
  }),
  country: z.string().trim().toUpperCase().refine(isCountryCode, 'Use a two-letter country code.').optional(),
});

export function facilityRoutes(deps: FacilityDeps) {
  const app = new Hono<AppEnv>();
  const perUser = new RateLimiter(40, 5 * 60_000);
  app.use('*', requireAuth(deps));

  app.get('/', async c => {
    const wait = perUser.hit(c.var.user.id);
    if (wait) throw tooMany(`Too many searches. Try again in ${wait} seconds.`);
    const q = readQuery(c, NearbyQuery);
    try {
      const result = await facilityService(deps).nearby({ lat: q.lat, lon: q.lon, radiusKm: q.radius ?? DEFAULT_RADIUS_KM, kinds: q.kinds, country: q.country });
      return c.json(result);
    } catch (e) {
      return unavailable(c, e);
    }
  });

  return app;
}
