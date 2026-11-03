// Small helpers for the Find a lab page: kind labels and colours, distances, links that open the maps app.
import type { Facility, FacilityKind, Profile } from '../../types';

export const KIND: Record<FacilityKind, { label: string; plural: string; color: string }> = {
  lab: { label: 'Lab', plural: 'Labs', color: '#2f7d63' },
  imaging: { label: 'Imaging', plural: 'Imaging', color: '#5b70c9' },
  hospital: { label: 'Hospital', plural: 'Hospitals', color: '#b9506d' },
  clinic: { label: 'Clinic', plural: 'Clinics', color: '#b07d12' },
};

export function formatDistance(km: number): string {
  if (km < 0.95) return `${Math.max(10, Math.round((km * 1000) / 10) * 10)} m`;
  if (km < 9.95) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}

/** iPhone, iPad and Mac open Apple Maps; everything else gets Google Maps' universal link (app or web). */
export function isAppleDevice(nav: Pick<Navigator, 'userAgent' | 'maxTouchPoints'> = navigator): boolean {
  return /iPhone|iPad|iPod|Macintosh|Mac OS X/.test(nav.userAgent) && !/Android|Windows/.test(nav.userAgent);
}

export function directionsUrl(lat: number, lon: number, apple = isAppleDevice()): string {
  const dest = `${lat.toFixed(6)},${lon.toFixed(6)}`;
  return apple ? `https://maps.apple.com/?daddr=${dest}` : `https://www.google.com/maps/dir/?api=1&destination=${dest}`;
}

/** tel: link with only the characters a dialler understands. */
export function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, '')}`;
}

/** Website without the scheme and trailing slash, for a compact label. */
export function shortHost(url: string): string {
  try { return new URL(url).host.replace(/^www\./, ''); } catch { return url; }
}

export function isPartner(f: Facility): f is Extract<Facility, { source: 'partner' }> {
  return f.source === 'partner';
}

/** The open profile's saved home area, if it has one. */
export function savedArea(p: Profile | null) {
  if (!p || p.latitude == null || p.longitude == null) return null;
  return { lat: p.latitude, lon: p.longitude, label: p.locality || 'Home area', country: p.country ?? null, postalCode: p.postalCode ?? null };
}
