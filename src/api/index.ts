// Picks where records are kept. Preview builds (VITE_BACKEND=browser) keep everything in this browser.
// The iOS and Android apps talk to the LotusPond API across sites with a token session (./appSession.ts):
// VITE_API_ORIGIN, or the public site's origin by default.
import { Capacitor } from '@capacitor/core';
import type { Backend } from './backend';
import { BrowserBackend } from './browser';
import { HttpBackend } from './http';
import { AppSession } from './appSession';
import { nativeTokens } from '../native/tokens';

declare const __SITE_URL__: string;

/** Running inside the iOS or Android app shell. */
export const inApp = Capacitor.isNativePlatform();

/** API origin the apps call (the website uses its own origin). */
export const appApiOrigin = (import.meta.env.VITE_API_ORIGIN || new URL(__SITE_URL__).origin).replace(/\/+$/, '');

export const backend: Backend = import.meta.env.VITE_BACKEND === 'browser' ? new BrowserBackend()
  : new HttpBackend(inApp ? { app: new AppSession(appApiOrigin, nativeTokens) } : {});
export const isPreview = backend.kind === 'browser';
export { ApiError, errorMessage } from './backend';
export type { Backend } from './backend';
