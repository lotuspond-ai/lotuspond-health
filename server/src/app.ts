// HTTP application: security middleware, API routes and (in production) the built frontend.
import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { serveStatic } from '@hono/node-server/serve-static';
import { forbidden, HttpError } from './lib/errors.ts';
import type { AppEnv } from './http.ts';
import { completeDeps, type DepsInput } from './cells.ts';
import { authRoutes } from './routes/auth.ts';
import { profileRoutes } from './routes/profiles.ts';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The frontend's policy: own scripts plus WebAssembly (3D model decoder), Google Fonts, and blob/data images for scans. */
const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function createApp(input: DepsInput): Hono<AppEnv> {
  const deps = completeDeps(input); // one default cell unless index.ts opened several
  const { config } = deps;
  const app = new Hono<AppEnv>();

  app.use('*', secureHeaders({
    contentSecurityPolicy: undefined,
    crossOriginEmbedderPolicy: false,
    strictTransportSecurity: config.cookieSecure ? 'max-age=31536000; includeSubDomains' : false,
    referrerPolicy: 'same-origin',
  }));

  // Cross-site request protection: changes must come from this site (or an origin listed in APP_ORIGINS).
  // Browsers send Sec-Fetch-Site; older ones send Origin. Requests with neither are not from a browser page.
  app.use('/api/*', async (c, next) => {
    if (UNSAFE.has(c.req.method)) {
      const site = c.req.header('sec-fetch-site');
      const origin = c.req.header('origin');
      const listed = !!origin && config.allowedOrigins.includes(origin);
      let ok = true;
      if (site) ok = site === 'same-origin' || site === 'none' || listed;
      else if (origin && origin !== 'null') {
        const host = (config.trustProxy && c.req.header('x-forwarded-host')) || c.req.header('host');
        try { ok = listed || new URL(origin).host === host; } catch { ok = false; }
      } else if (origin === 'null') ok = false;
      if (!ok) throw forbidden('This request came from another site and was blocked.');
    }
    c.header('Cache-Control', 'no-store');
    await next();
  });

  // JSON bodies (results, scan thumbnails) stay small; file uploads have their own limit.
  app.use('/api/*', async (c, next) => {
    if (c.req.path.endsWith('/documents') && c.req.method === 'POST') return next();
    return bodyLimit({ maxSize: 20 * 1024 * 1024, onError: () => { throw new HttpError(413, 'too_large', 'This request is too large.'); } })(c, next);
  });

  app.get('/api/health', c => c.json({ ok: true }));
  app.route('/api/auth', authRoutes(deps));
  app.route('/api/profiles', profileRoutes(deps));
  app.all('/api/*', c => c.json({ error: { code: 'not_found', message: 'No such API route.' } }, 404));

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message } }, err.status);
    console.error('[api] unhandled error', err);
    return c.json({ error: { code: 'server_error', message: 'Something went wrong on the server. Try again.' } }, 500);
  });

  if (config.staticDir && fs.existsSync(path.join(config.staticDir, 'index.html'))) {
    const root = path.relative(process.cwd(), config.staticDir) || '.';
    const indexHtml = fs.readFileSync(path.join(config.staticDir, 'index.html'), 'utf8');
    app.use('*', serveStatic({
      root,
      onFound: (file, c) => {
        if (file.endsWith('.html')) {
          c.header('Content-Security-Policy', PAGE_CSP);
          c.header('Cache-Control', 'no-cache');
        } else {
          c.header('Cache-Control', /[\\/]assets[\\/]/.test(file) ? 'public, max-age=31536000, immutable' : 'public, max-age=3600');
        }
      },
    }));
    // Single-page app: any other GET returns the shell.
    app.get('*', c => {
      c.header('Content-Security-Policy', PAGE_CSP);
      c.header('Cache-Control', 'no-cache');
      return c.html(indexHtml);
    });
  }

  return app;
}

export { PAGE_CSP };
