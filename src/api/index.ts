// Picks where records are kept. Preview builds (VITE_BACKEND=browser) keep everything in this browser.
// The iOS and Android apps talk to the LotusPond API across sites with a token session (./appSession.ts):
// VITE_API_ORIGIN, or the public site's origin by default. Test builds of the apps (VITE_SERVER_PICKER=1) can
// switch to another server from the sign-in screen (src/components/ServerPicker.tsx).
import { Capacitor } from '@capacitor/core';
import type { Backend } from './backend';
import { BrowserBackend } from './browser';
import { HttpBackend } from './http';
import { APP_CLIENT_HEADER, AppSession } from './appSession';
import { nativeTokens } from '../native/tokens';

declare const __SITE_URL__: string;

/** Running inside the iOS or Android app shell. */
export const inApp = Capacitor.isNativePlatform();

/** API origin the apps call (the website uses its own origin). */
export const appApiOrigin = (import.meta.env.VITE_API_ORIGIN || new URL(__SITE_URL__).origin).replace(/\/+$/, '');

/** Test builds of the apps only: the sign-in screen can point the app at another LotusPond server. */
export const serverPicker = import.meta.env.VITE_SERVER_PICKER === '1' && inApp;
const PICKED_SERVER = 'lotuspond.server';

function pickedServer(): string | null {
  if (!serverPicker) return null;
  try { return localStorage.getItem(PICKED_SERVER); } catch { return null; }
}

/** Token session of the apps; null on the website and in preview builds. */
export const appSession = inApp && import.meta.env.VITE_BACKEND !== 'browser' ? new AppSession(pickedServer() ?? appApiOrigin, nativeTokens) : null;

export const backend: Backend = import.meta.env.VITE_BACKEND === 'browser' ? new BrowserBackend()
  : new HttpBackend(appSession ? { app: appSession } : {});

/** The API origin the app calls now. */
export const currentServer = (): string => appSession?.origin ?? appApiOrigin;

/** Server picker: check that a LotusPond server answers at this origin, the way the app will call it. */
export async function checkServer(origin: string): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${origin}/api/auth/config`, { credentials: 'omit', headers: { [APP_CLIENT_HEADER]: 'app' }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`answered ${res.status}`);
    await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Server picker: switch to this origin (null for the build's own), signed out, and start the app again. */
export async function chooseServer(origin: string | null): Promise<void> {
  await appSession?.clear();
  try {
    if (origin && origin !== appApiOrigin) localStorage.setItem(PICKED_SERVER, origin);
    else localStorage.removeItem(PICKED_SERVER);
  } catch { /* storage unavailable: the choice lasts until the app restarts */ }
  location.reload();
}
export const isPreview = backend.kind === 'browser';
export { ApiError, errorMessage } from './backend';
export type { Backend } from './backend';
