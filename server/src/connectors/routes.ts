// GET /v1/connectors: the public catalogue of the connector core. Which systems LotusPond can reach, on whose
// authority, with which operations, and whether this server runs each one now. No sign-in: it describes connectors,
// never connections, people or credentials. ?region=in narrows it to one data region's connectors. `systems` lists
// the hospital and clinic systems the organisation API reaches, with each one's status.
import { Hono } from 'hono';
import { SOURCES } from '../../../shared/sources.ts';
import { REGIONS, type DataRegion } from '../../../shared/regions.ts';
import { connectorRegistry, type ConnectorRegistry } from './registry.ts';
import { OPERATIONS } from './types.ts';
import { INTEGRATIONS, INTEGRATION_STATUS_TEXT } from '../../../shared/integrations.ts';
import { HIS_ADAPTERS } from './his/index.ts';

export function connectorRoutes(registry: ConnectorRegistry | null) {
  // With the record agent off, the same catalogue, with nothing available on this server.
  const reg = registry ?? connectorRegistry({ sources: SOURCES, recipes: [], apis: [], navigator: false, typedPortals: false });
  const app = new Hono();
  app.get('/', c => {
    const q = c.req.query('region');
    if (q !== undefined && !(q in REGIONS)) return c.json({ error: { code: 'invalid_region', message: `Unknown region. Use one of: ${Object.keys(REGIONS).join(', ')}.` } }, 400);
    const region = q as DataRegion | undefined;
    const list = reg.list().filter(x => !region || x.regions.includes(region));
    c.header('Cache-Control', 'public, max-age=300');
    // Public and credential-free: documentation sites may read it from their own origin.
    c.header('Access-Control-Allow-Origin', '*');
    return c.json({
      version: 1,
      operations: Object.values(OPERATIONS),
      connectors: list.map(x => reg.info(x)),
      // Hospital and clinic systems for the organisation API, with an honest status each (shared/integrations.ts).
      // India only for now: these systems, and the organisations reaching them, are in India.
      systems: !region || region === 'in'
        ? INTEGRATIONS.map(i => ({ ...i, authority: 'organisation', statusText: INTEGRATION_STATUS_TEXT[i.status].detail, runsHere: HIS_ADAPTERS.has(i.id) }))
        : [],
    });
  });
  return app;
}
