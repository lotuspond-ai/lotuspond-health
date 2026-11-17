// Public website routes for health.lotuspond.ai, shared by the Vite build, the API server and the app.

/** Canonical address of the public site when SITE_URL is not set at build time. */
export const DEFAULT_SITE_URL = 'https://health.lotuspond.ai';

/** Paths that serve the app shell (app.html). The app picks sign-in or sign-up from the path. */
export const APP_PATHS = ['/app', '/login', '/signup'] as const;
export type AppPath = (typeof APP_PATHS)[number];

export interface SitePage {
  /** Clean URL, with a trailing slash for folders. */
  path: string;
  /** Built HTML file, relative to the output folder. */
  file: string;
  /** Listed in sitemap.xml. */
  sitemap: boolean;
}

/** Static pages built from HTML entries at the project root. */
export const SITE_PAGES: readonly SitePage[] = [
  { path: '/', file: 'index.html', sitemap: true },
  { path: '/privacy/', file: 'privacy/index.html', sitemap: true },
  { path: '/terms/', file: 'terms/index.html', sitemap: true },
  { path: '/trust/', file: 'trust/index.html', sitemap: true },
  { path: '/developers/', file: 'developers/index.html', sitemap: true },
  { path: '/developers/console/', file: 'developers/console/index.html', sitemap: false },
];

/** Shown with a 404 status for any other non-API path. */
export const NOT_FOUND_FILE = '404.html';
export const APP_FILE = 'app.html';

/** Date the legal pages were last changed (yyyy-mm-dd), shown on them and used in the sitemap. */
export const LEGAL_UPDATED = '2026-11-03';

/** Is this an app path, with or without a trailing slash? */
export function isAppPath(pathname: string): boolean {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return (APP_PATHS as readonly string[]).includes(p);
}
