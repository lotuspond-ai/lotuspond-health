// HTTP application: security middleware, API routes and (in production) the built frontend: the public website and the app.
import fs from 'node:fs';
import path from 'node:path';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { serveStatic } from '@hono/node-server/serve-static';
import { APP_FILE, APP_PATHS, NOT_FOUND_FILE, SITE_PAGES } from '../../shared/site.ts';
import { forbidden, HttpError } from './lib/errors.ts';
import { isAppRequest } from './auth/sessions.ts';
import type { AppEnv } from './http.ts';
import { completeDeps, type DepsInput } from './cells.ts';
import { authRoutes } from './routes/auth.ts';
import { accountsRoutes, accountsRuntime, FAKE_ACCOUNTS_PATH } from './routes/accounts.ts';
import { profileRoutes } from './routes/profiles.ts';
import { facilityRoutes } from './routes/facilities.ts';
import { geoRoutes } from './routes/geo.ts';
import { configRoutes, mapFileRoutes } from './routes/config.ts';
import { addCspSources, mapCspSources } from './facilities/index.ts';
import { hookRoutes, labOrderRoutes, labResultRoutes, labRoutes } from './lab/routes.ts';
import { agentRoutes } from './agents/routes.ts';
import { notificationRoutes } from './routes/notifications.ts';
import { assistantRoutes } from './assistant/routes.ts';
import { whatsappHookRoutes, whatsappRoutes } from './whatsapp/routes.ts';
import { whatsappService, type WhatsAppService } from './whatsapp/service.ts';
import { cloudApiClient, type WhatsAppClient } from './whatsapp/client.ts';
import { extractionRoutes } from './extraction/routes.ts';
import { mcpRoutes } from './agents/mcp.ts';
import { oauthRoutes, type OAuthOptions } from './agents/oauth.ts';
import { recordOAuthRoutes, recordRoutes } from './records/routes.ts';
import { connectorRoutes } from './connectors/routes.ts';
import { organisationRoutes } from './connectors/organisation-routes.ts';
import { ekaWebhookRoutes } from './records/abdm/webhook.ts';
import { DEMO_PORTAL_PATH, type DemoPortal } from './records/demo-portal.ts';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The app shell (/app, /login, /signup): own scripts plus WebAssembly (3D model decoder), and blob/data images for scans. */
const APP_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** The public website (landing, legal pages, 404): static HTML and CSS, no inline styles, no WebAssembly. */
const SITE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const IMMUTABLE = 'public, max-age=31536000, immutable';
/** Files whose names change with their content: built assets, and the pre-rendered body-map images (name.<hash>.webp/png). */
// …and the OCR files, in a folder named by the tesseract.js version (tools/ocr-assets.ts).
const HASHED = /[\\/]assets[\\/]|[\\/]bodymap[\\/][^\\/]+\.[0-9a-f]{10}\.(webp|png)$|[\\/]ocr[\\/]\d+\.\d+\.\d+[\\/]/;

export interface AppOptions {
  oauth?: OAuthOptions;
  /** WhatsApp: a client other than the Cloud API (tests), and a way to reach the service once it exists. */
  whatsapp?: { client?: WhatsAppClient; onService?: (s: WhatsAppService) => void };
  /** The pretend lab portal for the record agent (development and tests), served at /demo-portal. */
  demoPortal?: DemoPortal;
}

export function createApp(input: DepsInput, opts: AppOptions = {}): Hono<AppEnv> {
  const deps = completeDeps(input); // one default cell unless index.ts opened several
  const { config } = deps;
  // The assistant on WhatsApp needs both the Cloud API settings and the assistant itself.
  const wa = config.whatsapp && deps.assistant
    ? whatsappService(deps, deps.assistant, opts.whatsapp?.client ?? cloudApiClient(config.whatsapp), config.whatsapp, `${config.publicUrl ?? `http://localhost:${config.port}`}/app`)
    : undefined;
  if (wa) opts.whatsapp?.onService?.(wa);
  const app = new Hono<AppEnv>();
  // Map tiles on the Labs page may come from another host (see facilities/map.ts).
  const appCsp = addCspSources(APP_CSP, mapCspSources(config));

  app.use('*', secureHeaders({
    contentSecurityPolicy: undefined,
    crossOriginEmbedderPolicy: false,
    strictTransportSecurity: config.cookieSecure ? 'max-age=31536000; includeSubDomains' : false,
    referrerPolicy: 'same-origin',
  }));

  // The mobile apps (capacitor://localhost, https://localhost) call the API cross-origin with bearer tokens.
  // CORS for those origins only, without credentials: cookies are never shared with them.
  app.use('/api/*', async (c, next) => {
    const origin = c.req.header('origin');
    if (!origin || !config.appClientOrigins.includes(origin)) return next();
    if (c.req.method === 'OPTIONS') {
      return c.body(null, 204, {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE',
        // Range: map tiles (.pmtiles) are read in byte ranges; some web views preflight it.
        // Idempotency-Key: lab bookings (lab/routes.ts) need one, so a retried booking can't book twice.
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-LotusPond-Client, Range, Idempotency-Key',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin',
      });
    }
    await next();
    c.res.headers.set('Access-Control-Allow-Origin', origin);
    c.res.headers.set('Access-Control-Expose-Headers', 'Content-Disposition, Content-Range, ETag, Idempotent-Replayed');
    c.res.headers.append('Vary', 'Origin');
  });

  // Cross-site request protection: changes must come from this site (or an origin listed in APP_ORIGINS).
  // Browsers send Sec-Fetch-Site; older ones send Origin. Requests with neither are not from a browser page.
  // App requests (no session cookie; a bearer token or the X-LotusPond-Client header) are exempt; see isAppRequest.
  app.use('/api/*', async (c, next) => {
    if (UNSAFE.has(c.req.method) && !isAppRequest(c)) {
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
    if ((c.req.path.endsWith('/documents') || c.req.path.endsWith('/extract')) && c.req.method === 'POST') return next();
    return bodyLimit({ maxSize: 20 * 1024 * 1024, onError: () => { throw new HttpError(413, 'too_large', 'This request is too large.'); } })(c, next);
  });

  app.get('/api/health', c => c.json({ ok: true }));
  // Sign-in through LotusPond Accounts, when ACCOUNTS_ISSUER is set (docs/identity.md).
  const accounts = accountsRuntime(deps);
  if (accounts) app.route('/api/auth/accounts', accountsRoutes(deps, accounts));
  if (accounts?.fake && config.env !== 'production') {
    const fake = accounts.fake.app;
    app.use(`${FAKE_ACCOUNTS_PATH}/*`, async (c, next) => {
      await next();
      c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    });
    app.route(FAKE_ACCOUNTS_PATH, fake);
  }
  app.route('/api/auth', authRoutes(deps));
  if (deps.labs) {
    // Before /api/profiles, so lab-order requests are answered here (with the same session and profile checks).
    app.route('/api/lab', labRoutes(deps, deps.labs));
    app.route('/api/profiles/:pid/lab-orders', labOrderRoutes(deps, deps.labs));
    app.route('/api/profiles/:pid/lab-results', labResultRoutes(deps, deps.labs));
  }
  app.route('/api/agents', agentRoutes(deps));
  app.route('/api/notifications', notificationRoutes(deps));
  app.route('/api/assistant', assistantRoutes(deps, deps.assistant));
  app.route('/api/whatsapp', whatsappRoutes(deps, wa));
  app.route('/api/records', recordRoutes(deps, deps.records));
  if (deps.extractor) app.route('/api/profiles/:pid/extract', extractionRoutes(deps, deps.extractor));
  app.route('/api/profiles', profileRoutes(deps));
  app.route('/api/facilities', facilityRoutes(deps));
  app.route('/api/geo', geoRoutes(deps));
  app.route('/api/config', configRoutes(deps));
  app.route('/api/map', mapFileRoutes(deps));
  app.all('/api/*', c => c.json({ error: { code: 'not_found', message: 'No such API route.' } }, 404));

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: { ...err.details, code: err.code, message: err.message } }, err.status);
    console.error('[api] unhandled error', err);
    return c.json({ error: { code: 'server_error', message: 'Something went wrong on the server. Try again.' } }, 500);
  });

  // Agents (Claude, ChatGPT, …): the MCP endpoint and the OAuth sign-in it points to. Bearer tokens only, never
  // cookies (except the consent page), so these sit outside /api and its browser checks. CORS is open, without credentials.
  app.use('/mcp', async (c, next) => {
    if (c.req.method === 'OPTIONS') {
      return c.body(null, 204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET, DELETE',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID',
        'Access-Control-Max-Age': '600',
      });
    }
    await next();
    c.res.headers.set('Access-Control-Allow-Origin', '*');
    c.res.headers.set('Access-Control-Expose-Headers', 'WWW-Authenticate, Mcp-Session-Id');
    c.res.headers.set('Cache-Control', 'no-store');
  });
  app.use('/mcp', bodyLimit({ maxSize: 1024 * 1024, onError: c => c.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request too large.' } }, 413) }));
  app.route('/mcp', mcpRoutes(deps));
  // The connector core's public catalogue (docs/connectors.md); versioned, outside /api like /mcp.
  app.route('/v1/connectors', connectorRoutes(deps.records?.connectors ?? null));
  // Health's organisation API: API keys, operations on an organisation's authority. Bodies are small.
  app.use('/v1/operations/*', bodyLimit({ maxSize: 256 * 1024, onError: () => { throw new HttpError(413, 'too_large', 'This request is too large.'); } }));
  app.route('/v1', organisationRoutes(deps.db));
  app.use('/oauth/*', bodyLimit({ maxSize: 64 * 1024, onError: c => c.json({ error: 'invalid_request', error_description: 'Request too large.' }, 413) }));
  app.route('/', oauthRoutes(deps, opts.oauth));

  // Lab partner webhooks: server to server, so outside /api (no browser checks, no CORS).
  if (deps.labs) app.route('/hooks', hookRoutes(deps, deps.labs));
  if (wa) app.route('/hooks/whatsapp', whatsappHookRoutes(wa));
  if (deps.records) app.route('/records/oauth', recordOAuthRoutes(deps.records, config.allowedOrigins[0] ?? config.publicUrl ?? ''));
  const ekaKey = config.records?.eka?.webhookSigningKey;
  if (deps.records && ekaKey) { const records = deps.records; app.route('/hooks/eka', ekaWebhookRoutes({ signingKey: ekaKey, wake: ref => records.wake(ref) })); }
  // A pretend portal for the record agent's browsers; its own pages, so outside /api and the app's policy.
  if (opts.demoPortal && config.env !== 'production') app.route(DEMO_PORTAL_PATH, opts.demoPortal.app);

  if (config.staticDir && fs.existsSync(path.join(config.staticDir, 'index.html'))) serveSite(app, config.staticDir, appCsp);

  return app;
}

/**
 * The built frontend: the public site at / and its folders, the app shell at /app, /login and /signup, hashed assets
 * with immutable caching, precompressed .br/.gz copies when the browser accepts them, and a 404 page for anything else.
 */
function serveSite(app: Hono<AppEnv>, dir: string, appCsp: string): void {
  const root = path.relative(process.cwd(), dir) || '.';
  const abs = (f: string) => path.resolve(f);
  // Builds before the public site existed had the app as index.html.
  const appFile = fs.existsSync(path.join(dir, APP_FILE)) ? APP_FILE : 'index.html';
  const appPath = abs(path.join(dir, appFile));
  const notFoundPath = path.join(dir, NOT_FOUND_FILE);
  const notFoundHtml = fs.existsSync(notFoundPath) ? fs.readFileSync(notFoundPath, 'utf8') : '<!doctype html><title>Not found</title><p>Page not found.</p>';
  // Files with a compressed copy vary by Accept-Encoding even when sent uncompressed.
  const compressed = new Set<string>();
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && /\.(br|gz)$/.test(entry.name)) compressed.add(abs(path.join(entry.parentPath, entry.name.replace(/\.(br|gz)$/, ''))));
  }

  /** Caching and policy for a served file (its .br/.gz copy counts as the file itself). */
  const headersFor = (served: string): Record<string, string> => {
    const file = abs(served.replace(/\.(br|gz|zst)$/, ''));
    const h: Record<string, string> = file.endsWith('.html')
      ? { 'Content-Security-Policy': file === appPath ? appCsp : SITE_CSP, 'Cache-Control': 'no-cache' }
      : { 'Cache-Control': HASHED.test(file) ? IMMUTABLE : /[\\/]sw\.js$/.test(file) ? 'no-cache' : 'public, max-age=3600' };
    if (compressed.has(file)) h.Vary = 'Accept-Encoding';
    return h;
  };
  // serveStatic builds its response before calling onFound, so headers are added to the response it returns.
  const servedFile = new WeakMap<Context, string>();
  const statics = (options: { path?: string }): MiddlewareHandler<AppEnv> => {
    const serve = serveStatic<AppEnv>({ root, precompressed: true, ...options, onFound: (file, c) => { servedFile.set(c, file); } });
    return async (c, next) => {
      const res = await serve(c, next);
      const file = servedFile.get(c);
      if (res && file) for (const [name, value] of Object.entries(headersFor(file))) res.headers.set(name, value);
      return res;
    };
  };

  // Folder pages have one address each: /privacy redirects to /privacy/.
  for (const page of SITE_PAGES) {
    if (page.path === '/') continue;
    app.get(page.path.slice(0, -1), c => c.redirect(`${page.path}${new URL(c.req.url).search}`, 301));
  }
  const shell = statics({ path: appFile });
  for (const p of APP_PATHS) app.get(p, shell).get(`${p}/`, shell);
  app.use('*', statics({}));
  // API paths never get here: /api/* has its own JSON 404 above.
  app.notFound(c => {
    c.header('Content-Security-Policy', SITE_CSP);
    c.header('Cache-Control', 'no-cache');
    return c.html(notFoundHtml, 404);
  });
}

export { APP_CSP, SITE_CSP };
