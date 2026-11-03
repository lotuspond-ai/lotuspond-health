// The device's position for "Find a lab". The apps ask through the geolocation plugin, which uses the app's own
// permission (a web view would add a second "capacitor://localhost wants your location" prompt on iOS); browsers
// use the Geolocation API. Only an approximate position is needed: searches round it to about 1 km.
import { Geolocation } from '@capacitor/geolocation';
import { isNative } from './platform';

export class LocationError extends Error {}

const OPTIONS = { enableHighAccuracy: false, timeout: 15_000, maximumAge: 10 * 60_000 };

function browserMessage(err: GeolocationPositionError | null): string {
  if (!err) return 'This browser cannot share its location here. Search for your area instead.';
  if (err.code === err.PERMISSION_DENIED) return 'Location is blocked for this site. Allow it in your browser settings, or search for your area.';
  if (err.code === err.TIMEOUT) return 'Finding your location took too long. Try again, or search for your area.';
  return 'Your device could not find its location. Search for your area instead.';
}

async function appPosition(): Promise<{ lat: number; lon: number }> {
  let status = await Geolocation.checkPermissions().catch(() => null);
  const allowed = (s: typeof status) => s?.location === 'granted' || s?.coarseLocation === 'granted';
  if (!allowed(status)) status = await Geolocation.requestPermissions({ permissions: ['coarseLocation'] }).catch(() => null);
  if (!allowed(status)) throw new LocationError('Location is off for LotusPond Health. Allow it in your phone’s settings, or search for your area.');
  try {
    const pos = await Geolocation.getCurrentPosition(OPTIONS);
    return { lat: pos.coords.latitude, lon: pos.coords.longitude };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new LocationError(/timeout/i.test(msg)
      ? 'Finding your location took too long. Try again, or search for your area.'
      : /disabled|services/i.test(msg)
        ? 'Location services are turned off on this phone. Turn them on in Settings, or search for your area.'
        : 'Your phone could not find its location. Search for your area instead.');
  }
}

export function currentPosition(): Promise<{ lat: number; lon: number }> {
  if (isNative) return appPosition();
  if (!('geolocation' in navigator) || !window.isSecureContext) return Promise.reject(new LocationError(browserMessage(null)));
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      err => reject(new LocationError(browserMessage(err))),
      OPTIONS,
    );
  });
}
