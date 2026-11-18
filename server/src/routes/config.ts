// Public settings the app needs before sign-in (GET /api/config), and self-hosted map files (GET /api/map/files/*).
import path from 'node:path';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import type { PublicConfig } from '../../../shared/types.ts';
import type { AppEnv, Deps } from '../http.ts';
import { mapSettings } from '../facilities/map.ts';

export function configRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  app.get('/', c => {
    const body: PublicConfig = { map: mapSettings(deps.config), nearbySearch: deps.config.facilities.search, aiExtraction: !!deps.extractor, labBooking: !!deps.labs };
    c.header('Cache-Control', 'public, max-age=300');
    return c.json(body);
  });
  return app;
}

/** Serves MAP_TILES_DIR (PMTiles basemaps, fonts and sprites) with HTTP range requests, which PMTiles needs. */
export function mapFileRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  const dir = deps.config.map.tilesDir;
  if (!dir) return app;
  const serve = serveStatic({ root: path.resolve(dir), rewriteRequestPath: p => p.replace(/^\/api\/map\/files/, '') });
  app.use('/files/*', async (c, next) => {
    const res = await serve(c, next);
    if (res instanceof Response && res.status < 300) res.headers.set('Cache-Control', 'public, max-age=86400');
    return res;
  });
  return app;
}
