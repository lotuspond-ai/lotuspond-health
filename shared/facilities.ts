// Constants and small geometry helpers for nearby labs and facilities, used by the browser and the server.
import type { FacilityKind, PartnerService } from './types.ts';

export const FACILITY_KINDS: readonly FacilityKind[] = ['lab', 'imaging', 'hospital', 'clinic'];
export const PARTNER_SERVICES: readonly PartnerService[] = ['blood', 'urine', 'imaging', 'home_collection', 'ecg', 'health_checkup'];

/** Radius choices offered in the interface, in kilometres. The API accepts any value up to the maximum. */
export const RADIUS_OPTIONS_KM = [2, 5, 10, 25] as const;
export const MAX_RADIUS_KM = 25;
export const DEFAULT_RADIUS_KM = 5;

export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';

/** Saved coordinates and outgoing queries are rounded to 2 decimals: about 1.1 km north-south. */
export const COORD_DECIMALS = 2;

export function roundCoord(value: number, decimals = COORD_DECIMALS): number {
  const f = 10 ** decimals;
  // Math.round on negative halves rounds toward +∞; that bias is irrelevant at this precision.
  return Math.round(value * f) / f + 0;
}

export function isLatitude(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= -90 && v <= 90;
}

export function isLongitude(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= -180 && v <= 180;
}

const EARTH_KM = 6371.0088;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in kilometres. */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Latitude/longitude box around a point (used to pre-filter before exact distances). */
export function boundingBox(lat: number, lon: number, radiusKm: number) {
  const dLat = radiusKm / 111.32;
  const dLon = radiusKm / (111.32 * Math.max(0.01, Math.cos(rad(lat))));
  return { south: lat - dLat, north: lat + dLat, west: lon - dLon, east: lon + dLon };
}
