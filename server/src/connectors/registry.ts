// Every connector this server knows, and which of them it can run. Built once from the source list and the recipes,
// APIs and navigator this server has set up.
import { DEMO_SOURCE_ID, type SourceInfo } from '../../../shared/sources.ts';
import type { ApiFetcher } from '../records/api/types.ts';
import type { Recipe } from '../records/recipes/types.ts';
import type { Connector, ConnectorInfo, Reach, RecordsImpl } from './types.ts';

export interface ConnectorRegistry {
  get(id: string): Connector | undefined;
  list(): Connector[];
  /** The public description (no implementation). */
  info(c: Connector): ConnectorInfo;
}

export interface RegistryOptions {
  sources: SourceInfo[];
  recipes: Recipe[];
  apis: ApiFetcher[];
  /** Claude's navigator is set up: browser sources without a recipe can still run. */
  navigator: boolean;
  /** Portal addresses typed by the person may be opened (config.typedPortals). */
  typedPortals: boolean;
}

const reachOf = (s: SourceInfo): Reach => (s.access === 'abdm' ? 'abdm' : s.access === 'browser' ? 'browser' : 'api');

export function connectorRegistry(o: RegistryOptions): ConnectorRegistry {
  const recipes = new Map(o.recipes.map(r => [r.sourceId, r] as const));
  const apis = new Map(o.apis.map(f => [f.sourceId, f] as const));

  // A source's own API, when it is set up here, takes over from the browser (DigiLocker). Browser sources run a
  // recipe, or the navigator when there is none.
  const recordsOf = (s: SourceInfo): RecordsImpl | null => {
    const f = apis.get(s.id);
    if (f) return { via: 'api', fetcher: f };
    if (s.access !== 'browser') return null;
    const r = recipes.get(s.id);
    if (r) return { via: 'recipe', recipe: r };
    return o.navigator ? { via: 'navigator' } : null;
  };
  // A portal the person names by address (no start page) is offered only where typed addresses are allowed.
  const typedPortalBlocked = (s: SourceInfo, records: RecordsImpl | null) =>
    records?.via !== 'api' && s.access === 'browser' && !s.startUrl && s.id !== DEMO_SOURCE_ID && !o.typedPortals;

  const all: Connector[] = o.sources.filter(s => s.access !== 'app').map(s => {
    const records = recordsOf(s);
    return {
      id: s.id, name: s.name, category: s.category, regions: s.regions, authority: 'person', reach: apis.has(s.id) ? (s.access === 'abdm' ? 'abdm' : 'api') : reachOf(s),
      signIn: s.signIn, operations: ['records.fetch'], available: records !== null && !typedPortalBlocked(s, records), records,
    };
  });
  const byId = new Map(all.map(c => [c.id, c] as const));

  return {
    get: id => byId.get(id),
    list: () => all,
    info: ({ records: _records, ...info }) => info,
  };
}
