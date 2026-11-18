// The app's own addresses (/app, /login, /signup) and its links to the public website.
// The server-less preview (VITE_BACKEND=browser) has no website and its host only passes a #hash into the page,
// so there sign-in or sign-up is chosen with #login or #signup, and website links open the live site in a new tab.
// The iOS and Android apps work the same way: they hold only the app shell, and website links open in the browser.
import { agentConsentNext } from '../../shared/identity';
import { inApp, isPreview } from '../api';

/** No website around the app: the preview and the iOS / Android apps. */
const shellOnly = isPreview || inApp;

declare const __SITE_URL__: string;

/** Canonical address of the public site (SITE_URL at build time). */
export const SITE_URL: string = __SITE_URL__;

export type AuthMode = 'in' | 'up';
export type SitePath = '/' | '/privacy/' | '/terms/' | '/trust/';

const TITLE = 'LotusPond Health';
const AUTH_PATH = /^\/(login|signup)\/?$/;
const AUTH_HASH = /^#(login|signup)$/;

/** A link to a page of the public website. */
export function siteHref(path: SitePath): string {
  return shellOnly ? `${SITE_URL}${path}` : path;
}

/** Attributes for website links: the preview opens them in a new tab. */
export const siteLinkProps: { target?: string; rel?: string } = shellOnly ? { target: '_blank', rel: 'noopener' } : {};

/** Sign-up on /signup (or #signup in the preview); sign-in everywhere else. */
export function authModeFromLocation(): AuthMode {
  if (typeof location === 'undefined') return 'in';
  return location.pathname.match(AUTH_PATH)?.[1] === 'signup' || location.hash === '#signup' ? 'up' : 'in';
}

/** Follow #login and #signup when they change on an open page (the preview host can set the hash at any time). */
export function onAuthHash(change: (mode: AuthMode) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const read = () => { if (AUTH_HASH.test(location.hash)) change(location.hash === '#signup' ? 'up' : 'in'); };
  window.addEventListener('hashchange', read);
  return () => window.removeEventListener('hashchange', read);
}

function replaceUrl(url: string): void {
  if (typeof history === 'undefined') return;
  try { history.replaceState(history.state, '', url); } catch { /* sandboxed frame */ }
}

/** Keep the title, and the address on /login and /signup, in step with the auth screen. */
export function showAuthMode(mode: AuthMode): void {
  if (typeof document === 'undefined') return;
  document.title = `${mode === 'up' ? 'Create your account' : 'Sign in'} · ${TITLE}`;
  if (shellOnly) {
    if (!location.hash || AUTH_HASH.test(location.hash)) replaceUrl(`${location.pathname}${location.search}#${mode === 'up' ? 'signup' : 'login'}`);
  } else if (AUTH_PATH.test(location.pathname)) {
    replaceUrl(`/${mode === 'up' ? 'signup' : 'login'}${location.search}`);
  }
}

/** Signed in: /login and /signup become /app; an app view in the hash (/app#markers) is kept. */
export function enterApp(): void {
  if (typeof document === 'undefined') return;
  document.title = TITLE;
  const hash = AUTH_HASH.test(location.hash) ? '' : location.hash;
  const url = !shellOnly && AUTH_PATH.test(location.pathname) ? `/app${hash}` : `${location.pathname}${location.search}${hash}`;
  if (url !== `${location.pathname}${location.search}${location.hash}`) replaceUrl(url);
}

/** Signed out: the address becomes /login. */
export function leaveApp(): void {
  if (typeof document === 'undefined' || shellOnly) return;
  replaceUrl('/login');
}

/**
 * Where to go after signing in when an agent sent the person here to approve a connection (/login?next=/oauth/authorize?…),
 * or the developer console sent them (/login?next=/developers/console/). Only those same-origin paths are followed, so
 * the parameter cannot send anyone elsewhere.
 */
export function oauthReturn(): string | null {
  if (shellOnly || typeof location === 'undefined') return null;
  const next = new URLSearchParams(location.search).get('next');
  // The developer console (/developers/console/) sends people here to sign in, and back.
  if (next === '/developers/console/') return next;
  return agentConsentNext(next);
}
