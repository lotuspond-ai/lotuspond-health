// Serving the built frontend: page routing, per-page Content Security Policy, caching, precompressed files and 404s.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import type { Hono } from 'hono';
import { APP_CSP, SITE_CSP, createApp } from '../src/app.ts';
import { addCspSources, mapCspSources } from '../src/facilities/index.ts';
import { loadConfig } from '../src/config.ts';
import { openDatabase, type Database } from '../src/db/client.ts';
import { DiskFileStore } from '../src/lib/files.ts';
import type { AppEnv } from '../src/http.ts';

let database: Database;
let app: Hono<AppEnv>;
let config: ReturnType<typeof loadConfig>;
let site: string;
let filesDir: string;
const script = 'console.log("LotusPond");\n'.repeat(400);

before(async () => {
  site = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspond-site-'));
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspond-site-files-'));
  const write = (file: string, body: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(site, file)), { recursive: true });
    fs.writeFileSync(path.join(site, file), body);
  };
  write('index.html', '<!doctype html><title>Landing</title>');
  write('app.html', '<!doctype html><title>App shell</title><div id="root"></div>');
  write('404.html', '<!doctype html><title>Page not found</title>');
  write('privacy/index.html', '<!doctype html><title>Privacy</title>');
  write('assets/app-Ab12Cd34.js', script);
  write('assets/app-Ab12Cd34.js.br', zlib.brotliCompressSync(script));
  write('assets/app-Ab12Cd34.js.gz', zlib.gzipSync(script));
  write('robots.txt', 'User-agent: *\nAllow: /\n');
  database = await openDatabase({});
  config = loadConfig({ NODE_ENV: 'test', STATIC_DIR: site });
  app = createApp({ db: database.db, files: new DiskFileStore(filesDir), config });
});

after(async () => {
  await database.close();
  fs.rmSync(site, { recursive: true, force: true });
  fs.rmSync(filesDir, { recursive: true, force: true });
});

const get = (url: string, headers: Record<string, string> = {}) => app.request(url, { headers });

describe('public site and app shell', () => {
  it('serves the landing page at / with the site policy', async () => {
    const res = await get('/');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Landing/);
    assert.equal(res.headers.get('content-security-policy'), SITE_CSP);
    assert.doesNotMatch(SITE_CSP, /wasm-unsafe-eval|unsafe-inline/);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });

  it('serves the app shell at /app, /login and /signup with the app policy', async () => {
    for (const url of ['/app', '/app/', '/login', '/signup', '/signup/']) {
      const res = await get(url);
      assert.equal(res.status, 200, url);
      assert.match(await res.text(), /App shell/, url);
      // The app policy plus the hosts of the configured map tiles (Find a lab).
      assert.equal(res.headers.get('content-security-policy'), addCspSources(APP_CSP, mapCspSources(config)), url);
      assert.equal(res.headers.get('cache-control'), 'no-cache', url);
    }
    assert.match(APP_CSP, /'wasm-unsafe-eval'/);
  });

  it('serves folder pages, and redirects them to their trailing-slash address', async () => {
    const page = await get('/privacy/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Privacy/);
    assert.equal(page.headers.get('content-security-policy'), SITE_CSP);
    const bare = await get('/privacy?from=footer');
    assert.equal(bare.status, 301);
    assert.equal(bare.headers.get('location'), '/privacy/?from=footer');
  });

  it('answers other paths with the 404 page', async () => {
    for (const url of ['/nope', '/app/labs', '/assets/missing.js', '/privacy/nothing-here']) {
      const res = await get(url, { accept: 'text/html' });
      assert.equal(res.status, 404, url);
      assert.match(await res.text(), /Page not found/, url);
      assert.equal(res.headers.get('content-security-policy'), SITE_CSP, url);
    }
    const post = await app.request('/nope', { method: 'POST' });
    assert.equal(post.status, 404);
  });

  it('keeps JSON 404s for unknown API routes', async () => {
    const res = await get('/api/nope');
    assert.equal(res.status, 404);
    assert.equal((await res.json() as { error: { code: string } }).error.code, 'not_found');
  });

  it('caches hashed assets for a year and sends precompressed copies', async () => {
    const br = await get('/assets/app-Ab12Cd34.js', { 'accept-encoding': 'gzip, deflate, br' });
    assert.equal(br.status, 200);
    assert.equal(br.headers.get('content-encoding'), 'br');
    assert.match(br.headers.get('content-type') ?? '', /javascript/);
    assert.equal(br.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.match(br.headers.get('vary') ?? '', /Accept-Encoding/);
    assert.equal(zlib.brotliDecompressSync(Buffer.from(await br.arrayBuffer())).toString(), script);

    const gz = await get('/assets/app-Ab12Cd34.js', { 'accept-encoding': 'gzip' });
    assert.equal(gz.headers.get('content-encoding'), 'gzip');
    assert.equal(zlib.gunzipSync(Buffer.from(await gz.arrayBuffer())).toString(), script);

    const plain = await get('/assets/app-Ab12Cd34.js');
    assert.equal(plain.headers.get('content-encoding'), null);
    assert.match(plain.headers.get('vary') ?? '', /Accept-Encoding/);
    assert.equal(await plain.text(), script);
  });

  it('caches other public files for an hour', async () => {
    const res = await get('/robots.txt');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=3600');
  });
});
