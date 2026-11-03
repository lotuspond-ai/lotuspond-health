// Nearby labs and facilities: one service per app instance, shared by the facilities, geo and config routes.
import type { Deps } from '../http.ts';
import { providersFromConfig, type FacilityProviders } from './providers.ts';
import { FacilityService } from './service.ts';

/** Deps may carry providers (tests inject fakes); otherwise they come from the configuration. */
export type FacilityDeps = Deps & { facilityProviders?: FacilityProviders };

const services = new WeakMap<object, FacilityService>();

export function facilityService(deps: FacilityDeps): FacilityService {
  let s = services.get(deps);
  if (!s) {
    // Partner labs and the cache are not personal data: they live in the default database.
    s = new FacilityService(deps.db, deps.config.facilities, deps.facilityProviders ?? providersFromConfig(deps.config.facilities));
    services.set(deps, s);
  }
  return s;
}

export { addCspSources, mapCspSources, mapSettings } from './map.ts';
export { FacilityError } from './errors.ts';
