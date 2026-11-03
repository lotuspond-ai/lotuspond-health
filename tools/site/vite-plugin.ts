// Vite plugin for the public website (health.lotuspond.ai):
// - HTML partials (`<!-- @include header -->` reads src/site/partials/header.html), `%SITE_URL%`, and region tables
//   rendered from shared/regions.ts (`<!-- @regions storage-table -->`);
// - robots.txt and sitemap.xml generated from SITE_URL;
// - clean URLs and a 404 page in `vite` and `vite preview`, matching the production server;
// - precompressed .br and .gz copies of text assets, which the server sends when the browser accepts them.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { Connect, Plugin, ResolvedConfig, ViteDevServer } from 'vite';
import { APP_FILE, LEGAL_UPDATED, NOT_FOUND_FILE, SITE_PAGES, isAppPath } from '../../shared/site.ts';
import { renderRegionBlocks } from './regions.ts';

export interface SiteOptions {
  /** Canonical origin without a trailing slash, e.g. https://health.lotuspond.ai */
  siteUrl: string;
  /** Server-less preview build: only the app, no robots, sitemap or compressed copies. */
  artifact: boolean;
}

const PARTIALS = 'src/site/partials';

/** Rollup inputs: the static pages, the 404 page and the app shell. */
export function siteInputs(root = process.cwd()): Record<string, string> {
  const inputs: Record<string, string> = { app: path.resolve(root, APP_FILE), notFound: path.resolve(root, NOT_FOUND_FILE) };
  for (const p of SITE_PAGES) inputs[p.path === '/' ? 'index' : p.path.replace(/\//g, '')] = path.resolve(root, p.file);
  return inputs;
}

/** Validate SITE_URL and drop any trailing slash. */
export function normalizeSiteUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`SITE_URL is not a valid URL: ${raw}`); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`SITE_URL must be http(s): ${raw}`);
  return url.origin + url.pathname.replace(/\/+$/, '');
}

export function robotsTxt(siteUrl: string): string {
  return ['User-agent: *', 'Allow: /', 'Disallow: /api/', 'Disallow: /app', '', `Sitemap: ${siteUrl}/sitemap.xml`, ''].join('\n');
}

export function sitemapXml(siteUrl: string): string {
  const urls = SITE_PAGES.filter(p => p.sitemap).map(p =>
    `  <url><loc>${siteUrl}${p.path}</loc><lastmod>${LEGAL_UPDATED}</lastmod></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

function renderHtml(html: string, file: string, root: string, siteUrl: string, depth = 0): string {
  const included = html.replace(/<!--\s*@include\s+([\w-]+)\s*-->/g, (_, name: string) => {
    if (depth > 3) throw new Error(`${file}: includes nest too deeply`);
    const partial = path.join(root, PARTIALS, `${name}.html`);
    if (!fs.existsSync(partial)) throw new Error(`${file}: missing partial ${path.relative(root, partial)}`);
    return renderHtml(fs.readFileSync(partial, 'utf8').trim(), partial, root, siteUrl, depth + 1);
  });
  return renderRegionBlocks(included, file).replaceAll('%SITE_URL%', siteUrl);
}

const COMPRESSIBLE = /\.(?:html|js|mjs|css|svg|json|txt|xml|wasm|glb|webmanifest)$/i;

/** Write .br and .gz next to every compressible file of 1 KB or more, when they save space. */
export function precompress(dir: string): { files: number; saved: number } {
  let files = 0, saved = 0;
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !COMPRESSIBLE.test(entry.name)) continue;
    const file = path.join(entry.parentPath, entry.name);
    const raw = fs.readFileSync(file);
    if (raw.length < 1024) continue;
    const br = zlib.brotliCompressSync(raw, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: raw.length > 4 * 1024 * 1024 ? 9 : 11,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
      },
    });
    const gz = zlib.gzipSync(raw, { level: 9 });
    let wrote = false;
    if (br.length < raw.length * 0.95) { fs.writeFileSync(`${file}.br`, br); saved += raw.length - br.length; wrote = true; }
    if (gz.length < raw.length * 0.95) { fs.writeFileSync(`${file}.gz`, gz); wrote = true; }
    if (wrote) files++;
  }
  return { files, saved };
}

function send(res: Parameters<Connect.NextHandleFunction>[1], status: number, type: string, body: string) {
  res.statusCode = status;
  res.setHeader('Content-Type', `${type}; charset=utf-8`);
  res.setHeader('Cache-Control', 'no-cache');
  res.end(body);
}

/** Clean URLs, as the production server routes them: /login and /signup open the app shell, folders get a slash. */
function routes(hasApp: () => boolean): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const [pathname, query] = (req.url ?? '/').split(/\?(.*)/s);
    const qs = query ? `?${query}` : '';
    if (isAppPath(pathname) && hasApp()) { req.url = `/${APP_FILE}${qs}`; return next(); }
    if (SITE_PAGES.some(p => p.path !== '/' && p.path === `${pathname}/`)) {
      res.statusCode = 301;
      res.setHeader('Location', `${pathname}/${qs}`);
      res.end();
      return;
    }
    next();
  };
}

/** Pages nobody built get the 404 page with a 404 status. Only document requests; assets keep Vite's own 404. */
function notFound(dir: string, load: () => Promise<string | null>): Connect.NextHandleFunction {
  return (req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || !req.headers.accept?.includes('text/html')) return next();
    const pathname = decodeURI((req.url ?? '/').split('?')[0]);
    if (pathname.endsWith('.html') && fs.existsSync(path.join(dir, pathname))) return next();
    load().then(html => (html == null ? next() : send(res, 404, 'text/html', html)), next);
  };
}

export function site(options: SiteOptions): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'lotuspond-site',

    configResolved(c) { config = c; },

    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        return renderHtml(html, ctx.filename, config.root, options.siteUrl);
      },
    },

    configureServer(server: ViteDevServer) {
      const root = server.config.root;
      server.watcher.add(path.join(root, PARTIALS));
      server.watcher.on('change', file => {
        if (file.startsWith(path.join(root, PARTIALS))) server.ws.send({ type: 'full-reload' });
      });
      server.middlewares.use(routes(() => true));
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? '').split('?')[0];
        if (pathname === '/robots.txt') return send(res, 200, 'text/plain', robotsTxt(options.siteUrl));
        if (pathname === '/sitemap.xml') return send(res, 200, 'application/xml', sitemapXml(options.siteUrl));
        next();
      });
      return () => {
        server.middlewares.use(notFound(root, async () => {
          const file = path.join(root, NOT_FOUND_FILE);
          return fs.existsSync(file) ? server.transformIndexHtml(`/${NOT_FOUND_FILE}`, fs.readFileSync(file, 'utf8')) : null;
        }));
      };
    },

    configurePreviewServer(server) {
      const dist = path.resolve(server.config.root, server.config.build.outDir);
      server.middlewares.use(routes(() => fs.existsSync(path.join(dist, APP_FILE))));
      return () => {
        server.middlewares.use(notFound(dist, async () => {
          const file = path.join(dist, NOT_FOUND_FILE);
          return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
        }));
      };
    },

    generateBundle() {
      if (options.artifact) return;
      this.emitFile({ type: 'asset', fileName: 'robots.txt', source: robotsTxt(options.siteUrl) });
      this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: sitemapXml(options.siteUrl) });
    },

    closeBundle() {
      if (options.artifact || config.command !== 'build') return;
      const out = path.resolve(config.root, config.build.outDir);
      if (!fs.existsSync(out)) return;
      const { files, saved } = precompress(out);
      config.logger.info(`precompressed ${files} files (brotli saves ${(saved / 1024 / 1024).toFixed(1)} MB)`);
    },
  };
}
