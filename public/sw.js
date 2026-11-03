// LotusPond Health service worker: keeps the app shell, the pre-rendered body maps and the 3D models on the device.
// Registered by src/sw-register.ts (production builds served by our server only) as
//   sw.js?v=<entry bundle name>&shell=<path of the app page>
// so each deploy installs a new worker with its own shell cache and deletes the previous one.
//
// Never touches /api: health records, files and sign-in always go to the network.
/* eslint-env serviceworker */

const params = new URL(self.location.href).searchParams;
const VERSION = params.get('v') || 'dev';
const SHELL_URL = new URL(params.get('shell') || './', self.registration.scope).href;
const APP = `lotuspond-app-${VERSION}`;   // app page plus its hashed scripts, styles and fonts (one per deploy)
// Body-map images (content-hashed names) and the 3D models (versioned URLs). v2: the female and male bodies replaced
// the single model, so the old model and images are dropped from every device.
const MEDIA = 'lotuspond-media-v2';
const OURS = /^lotuspond-/;

const isApi = url => /^\/api(\/|$)/.test(url.pathname) || url.pathname.includes('/api/');
const isAsset = url => /\/assets\/[^/]+$/.test(url.pathname);
const isBodymap = url => /\/bodymap\/[^/]+\.(webp|png)$/.test(url.pathname);
const isModel = url => /\/models\/[^/]+$/.test(url.pathname);

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP);
    const res = await fetch(SHELL_URL, { cache: 'no-cache', credentials: 'same-origin' });
    if (!res.ok) throw new Error(`app shell: ${res.status}`);
    await cache.put(SHELL_URL, res.clone());
    // The shell's own scripts and styles; chunks loaded later (3D stage, PDF reader) are cached on first use.
    const html = await res.text();
    const assets = [...new Set([...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => new URL(m[1], SHELL_URL)))]
      .filter(u => u.origin === self.location.origin && isAsset(u)).map(u => u.href);
    await cache.addAll(assets);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (OURS.test(key) && key !== APP && key !== MEDIA) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || isApi(url)) return;
  if (req.mode === 'navigate') event.respondWith(page(req));
  else if (isAsset(url)) event.respondWith(cacheFirst(req, APP));
  else if (isBodymap(url)) event.respondWith(cacheFirst(req, MEDIA));
  else if (isModel(url) && url.searchParams.has('v')) event.respondWith(model(req));
});

/** Pages: the network first (so a deploy shows at once), the cached shell when offline. */
async function page(req) {
  const cache = await caches.open(APP);
  try {
    const res = await fetch(req);
    if (res.ok && res.type === 'basic' && new URL(req.url).pathname === new URL(SHELL_URL).pathname) await cache.put(SHELL_URL, res.clone());
    return res;
  } catch (e) {
    const hit = (await cache.match(req, { ignoreSearch: true })) || (await cache.match(SHELL_URL));
    if (hit) return hit;
    throw e;
  }
}

/** Content-hashed files never change: serve from the cache, fetch and keep on a miss. */
async function cacheFirst(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.status === 200 && res.type === 'basic') await cache.put(req, res.clone());
  return res;
}

/** The 3D model is requested as models/<file>?v=<content hash>: keep one copy, and drop it when the hash changes. */
async function model(req) {
  const cache = await caches.open(MEDIA);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.status === 200 && res.type === 'basic') {
    const path = new URL(req.url).pathname;
    for (const key of await cache.keys()) if (new URL(key.url).pathname === path && key.url !== req.url) await cache.delete(key);
    await cache.put(req, res.clone());
  }
  return res;
}

// The body map asks for its images to be kept (fetch: this screen's size; keep: every current file).
self.addEventListener('message', event => {
  const msg = event.data;
  if (!msg || msg.type !== 'warm' || !Array.isArray(msg.fetch)) return;
  const ours = list => list.map(u => { try { return new URL(u); } catch { return null; } }).filter(u => u && u.origin === self.location.origin && isBodymap(u)).map(u => u.href);
  const want = ours(msg.fetch).slice(0, 400);
  const keep = new Set(ours(Array.isArray(msg.keep) ? msg.keep : msg.fetch));
  event.waitUntil((async () => {
    const cache = await caches.open(MEDIA);
    for (const key of await cache.keys()) if (isBodymap(new URL(key.url)) && !keep.has(key.url)) await cache.delete(key);
    for (const u of want) {
      if (await cache.match(u)) continue;
      try { const res = await fetch(u); if (res.status === 200) await cache.put(u, res); } catch { return; }
    }
  })());
});
