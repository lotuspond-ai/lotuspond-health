// Registers the service worker (public/sw.js), which keeps the app shell, the pre-rendered body map and the 3D model
// on the device. Production builds served by our server only: not in development, and not in the server-less preview
// build (VITE_BACKEND=browser), whose hosts cannot run service workers.
const enabled = import.meta.env.PROD && import.meta.env.VITE_BACKEND !== 'browser'
  && typeof window !== 'undefined' && window.isSecureContext && 'serviceWorker' in navigator;

function register() {
  // Versioned by this bundle's file name (it carries a content hash), so each deploy installs a fresh worker
  // that precaches the new shell and drops the old one.
  const version = new URL(import.meta.url).pathname.split('/').pop()?.replace(/\.js$/, '') ?? 'dev';
  const url = new URL(`${import.meta.env.BASE_URL}sw.js`, document.baseURI);
  url.searchParams.set('v', version);
  url.searchParams.set('shell', location.pathname);
  navigator.serviceWorker.register(url.href).catch(() => { /* the app works the same without it */ });
}

if (enabled) {
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

/**
 * Ask the worker to keep these files (fetching any it lacks, in the background) and to drop other body-map files.
 * Skipped when the person has asked their browser to save data.
 */
export function warmCache(fetch: string[], keep: string[] = fetch) {
  if (!enabled) return;
  if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return;
  const abs = (u: string) => new URL(u, document.baseURI).href;
  void navigator.serviceWorker.ready.then(reg => reg.active?.postMessage({ type: 'warm', fetch: fetch.map(abs), keep: keep.map(abs) }));
}
