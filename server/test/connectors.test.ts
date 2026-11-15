// The connector core: the registry maps sources to how they run here (official API, recipe, navigator), keeps a
// typed portal unavailable where typed addresses are not allowed, and GET /v1/connectors describes connectors
// without anything about connections, people or credentials.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SOURCES, sourceById } from '../../shared/sources.ts';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDatabase, type Database } from '../src/db/client.ts';
import { DiskFileStore } from '../src/lib/files.ts';
import { connectorRegistry } from '../src/connectors/registry.ts';
import { connectorRoutes } from '../src/connectors/routes.ts';
import { OPERATIONS } from '../src/connectors/types.ts';
import type { ApiFetcher } from '../src/records/api/types.ts';
import type { Recipe } from '../src/records/recipes/types.ts';

const recipe = (sourceId: string): Recipe => ({ sourceId, run: async () => [] });
const api = (sourceId: string): ApiFetcher => ({ sourceId, run: async () => [] });
// A browser source with a start page and no recipe of its own, and the typed-address source.
const browserNoRecipe = SOURCES.find(s => s.access === 'browser' && s.startUrl && !['drlal', 'thyrocare', 'metropolis', 'apollo', 'digilocker'].includes(s.id))!;
const typed = SOURCES.find(s => s.access === 'browser' && !s.startUrl)!;

describe('connector registry', () => {
  test('an official API, a recipe, the navigator, or nothing', () => {
    const digilocker = sourceById('digilocker')!;
    const reg = connectorRegistry({ sources: SOURCES, recipes: [recipe('apollo')], apis: [api('digilocker')], navigator: false, typedPortals: false });
    const d = reg.get('digilocker')!;
    assert.equal(d.records?.via, 'api', 'its own API takes over from the browser');
    assert.equal(d.available, true);
    assert.equal(d.reach, digilocker.access === 'abdm' ? 'abdm' : 'api');
    assert.equal(reg.get('apollo')!.records?.via, 'recipe');
    assert.equal(reg.get(browserNoRecipe.id)!.available, false, 'no recipe and no navigator');
    const withNav = connectorRegistry({ sources: SOURCES, recipes: [], apis: [], navigator: true, typedPortals: true });
    assert.equal(withNav.get(browserNoRecipe.id)!.records?.via, 'navigator');
    for (const c of reg.list()) {
      assert.equal(c.authority, 'person', 'every connector today runs on a person’s own authority');
      assert.deepEqual(c.operations, ['records.fetch']);
    }
    assert.ok(!reg.list().some(c => sourceById(c.id)?.access === 'app'), 'what is already in the app is not a connector');
  });

  test('a typed portal address keeps its navigator but is not offered without typedPortals', () => {
    const off = connectorRegistry({ sources: SOURCES, recipes: [], apis: [], navigator: true, typedPortals: false }).get(typed.id)!;
    assert.equal(off.records?.via, 'navigator', 'a connection saved earlier still fails with the typed-portal reason');
    assert.equal(off.available, false);
    const on = connectorRegistry({ sources: SOURCES, recipes: [], apis: [], navigator: true, typedPortals: true }).get(typed.id)!;
    assert.equal(on.available, true);
  });
});

describe('GET /v1/connectors', () => {
  test('operations and connectors, with nothing private', async () => {
    const reg = connectorRegistry({ sources: SOURCES, recipes: [recipe('apollo')], apis: [api('digilocker')], navigator: false, typedPortals: false });
    const res = await connectorRoutes(reg).request('/');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    const body = await res.json() as { version: number; operations: { id: string; stage: string; authority: string[] }[]; connectors: Record<string, unknown>[] };
    assert.equal(body.version, 1);
    assert.deepEqual(body.operations.map(o => o.id).sort(), Object.keys(OPERATIONS).sort());
    assert.equal(body.operations.find(o => o.id === 'records.fetch')!.stage, 'live');
    assert.ok(body.operations.filter(o => o.authority.includes('organisation')).every(o => o.stage === 'planned'), 'organisation operations are announced as planned, not offered');
    const apollo = body.connectors.find(c => c.id === 'apollo')!;
    assert.equal(apollo.available, true);
    assert.deepEqual(Object.keys(apollo).sort(), ['authority', 'available', 'category', 'id', 'name', 'operations', 'reach', 'regions', 'signIn'].sort(), 'no implementation, hosts or start pages');
  });

  test('?region narrows the list; an unknown region is refused', async () => {
    const r = connectorRoutes(connectorRegistry({ sources: SOURCES, recipes: [], apis: [], navigator: false, typedPortals: false }));
    const india = await (await r.request('/?region=in')).json() as { connectors: { regions: string[] }[] };
    assert.ok(india.connectors.length > 0 && india.connectors.every(c => c.regions.includes('in')));
    assert.equal((await r.request('/?region=mars')).status, 400);
  });
});

describe('the catalogue on a server without the record agent', () => {
  let database: Database;
  let filesDir: string;
  before(async () => { database = await openDatabase({}); filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspond-connectors-')); });
  after(async () => { await database.close(); fs.rmSync(filesDir, { recursive: true, force: true }); });

  test('is served, with nothing available here', async () => {
    const config = loadConfig({ NODE_ENV: 'test', RECORD_AGENT: 'off' });
    const app = createApp({ db: database.db, files: new DiskFileStore(filesDir), config });
    const res = await app.request('/v1/connectors');
    assert.equal(res.status, 200);
    const body = await res.json() as { connectors: { available: boolean }[] };
    assert.ok(body.connectors.length > 10);
    assert.ok(body.connectors.every(c => !c.available));
  });
});
