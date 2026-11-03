// Saving a searched point as a profile's home area.
import type { Profile } from '../../types';
import { roundCoord } from '../../../shared/facilities';
import { useSession } from '../../state/session';
import type { SearchPoint } from './store';

/** Same place as the saved area (to about 1 km)? */
export function sameArea(a: { lat: number; lon: number } | null, b: { lat: number; lon: number } | null): boolean {
  return !!a && !!b && roundCoord(a.lat) === roundCoord(b.lat) && roundCoord(a.lon) === roundCoord(b.lon);
}

/** Save a point as the open profile's home area, rounded to about 1 km. */
export async function saveArea(profile: Profile, p: SearchPoint | null): Promise<Profile> {
  const patch = p
    ? { country: p.country, locality: p.label.slice(0, 120), postalCode: p.postalCode, latitude: roundCoord(p.lat), longitude: roundCoord(p.lon) }
    : { country: null, locality: null, postalCode: null, latitude: null, longitude: null };
  return useSession.getState().saveProfile(profile.id, patch);
}
