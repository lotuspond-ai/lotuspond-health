// Area and postcode search (GET /api/geo/search) and naming a point (GET /api/geo/reverse), through this server
// so the person's browser never sends their location to a third party.
import { Hono } from 'hono';
import { z } from 'zod';
import { tooMany } from '../lib/errors.ts';
import { RateLimiter } from '../lib/rate-limit.ts';
import { requireAuth, type AppEnv } from '../http.ts';
import { facilityService, type FacilityDeps } from '../facilities/index.ts';
import { latParam, lonParam, readQuery, requestLanguage, unavailable } from '../facilities/http.ts';

const SearchQuery = z.object({
  q: z.string({ error: 'Type an area or postcode.' }).trim().min(2, 'Type at least 2 characters.').max(120, 'Use at most 120 characters.'),
});
const ReverseQuery = z.object({ lat: latParam, lon: lonParam });

export function geoRoutes(deps: FacilityDeps) {
  const app = new Hono<AppEnv>();
  const searches = new RateLimiter(60, 5 * 60_000);
  const reverses = new RateLimiter(30, 5 * 60_000);
  app.use('*', requireAuth(deps));

  app.get('/search', async c => {
    const wait = searches.hit(c.var.user.id);
    if (wait) throw tooMany(`Too many searches. Try again in ${wait} seconds.`);
    const { q } = readQuery(c, SearchQuery);
    try {
      return c.json(await facilityService(deps).search(q, requestLanguage(c)));
    } catch (e) {
      return unavailable(c, e, 'Area search');
    }
  });

  app.get('/reverse', async c => {
    const wait = reverses.hit(c.var.user.id);
    if (wait) throw tooMany(`Too many location lookups. Try again in ${wait} seconds.`);
    const { lat, lon } = readQuery(c, ReverseQuery);
    try {
      return c.json(await facilityService(deps).reverse(lat, lon, requestLanguage(c)));
    } catch (e) {
      return unavailable(c, e, 'Area search');
    }
  });

  return app;
}
