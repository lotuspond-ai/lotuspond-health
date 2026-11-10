// Agent connections end to end: OAuth discovery, registration, consent, PKCE token exchange, refresh rotation,
// the MCP endpoint and its tools, scoping to chosen profiles and permissions, tokens made on Account, and revocation.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hono } from 'hono';
import type { AgentConnectionsInfo, CreatedAgentToken } from '../../shared/agents.ts';
import type { ActivityEvent, Profile, SessionInfo } from '../../shared/types.ts';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDatabase, type Database } from '../src/db/client.ts';
import type { AppEnv } from '../src/http.ts';
import { DiskFileStore } from '../src/lib/files.ts';
import { redirectMatches, validRedirectUri } from '../src/agents/oauth.ts';
import { followUps, markerSummaries } from '../src/agents/synthesis.ts';
import { makeClient, measurement, registration, type TestClient } from './helpers.ts';

const migrations = fileURLToPath(new URL('../drizzle', import.meta.url));
const ORIGIN = 'https://health.example';
const CIMD = 'https://agent.example/oauth/client.json';
let database: Database;
let app: Hono<AppEnv>;
let filesDir: string;

before(async () => {
  database = await openDatabase({ url: process.env.TEST_DATABASE_URL });
  await database.migrate(migrations);
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspond-agents-'));
  const config = loadConfig({ NODE_ENV: 'test', TRUST_PROXY: 'true', PUBLIC_URL: ORIGIN });
  app = createApp({ db: database.db, files: new DiskFileStore(filesDir), config }, {
    oauth: {
      fetchClientMetadata: async url => {
        if (url !== CIMD) throw new Error('not found');
        return { client_id: CIMD, client_name: 'Metadata Agent', redirect_uris: ['https://agent.example/callback'] };
      },
    },
  });
});
after(async () => {
  await database?.close();
  fs.rmSync(filesDir, { recursive: true, force: true });
});

let n = 0;
async function account() {
  const c = makeClient(app);
  const info = await c.json<SessionInfo>('POST', '/api/auth/register', registration(`agents-${Date.now()}-${++n}@example.com`), 201);
  const self = info.profiles[0];
  await c.json('PATCH', `/api/profiles/${self.id}`, { conditions: ['Type 2 diabetes'], dateOfBirth: '1990-05-01', heightCm: 170, weightKg: 72 });
  await c.json('POST', `/api/profiles/${self.id}/measurements`, { measurements: [
    measurement({ date: '2025-01-10', value: 120, valueText: '120' }),
    measurement({ date: '2026-03-14', value: 138, valueText: '138' }),
    measurement({ markerId: 'tsh', rawName: 'TSH', value: 2.1, valueText: '2.1', unit: 'µIU/mL', range: { low: 0.4, high: 4.0, source: 'report' }, status: 'normal' }),
  ] }, 201);
  const child = await c.json<Profile>('POST', '/api/profiles', { displayName: 'Kiran', relationship: 'child', confirmation: 'guardian' }, 201);
  return { c, self, child };
}

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

async function register(redirect = 'https://claude.example/callback', name = 'Claude') {
  const res = await app.request('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.9.0.${++n % 250}` },
    body: JSON.stringify({ client_name: name, redirect_uris: [redirect], token_endpoint_auth_method: 'none' }) });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json() as { client_id: string }).client_id;
}

function authorizeUrl(clientId: string, challenge: string, over: Record<string, string> = {}, redirect = 'https://claude.example/callback') {
  return `/oauth/authorize?${new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256',
    state: 'xyz', scope: 'health:read health:write', resource: `${ORIGIN}/mcp`, ...over,
  })}`;
}

/** Open the consent page, then submit it with the given choices; returns the redirect. */
async function consent(c: TestClient, url: string, choose: { profiles: string[]; scopes?: string[]; decision?: string }) {
  const page = await c.call('GET', url);
  assert.equal(page.status, 200);
  const html = await page.text();
  const hidden = Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map(m => [m[1], m[2].replace(/&amp;/g, '&')]));
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(hidden)) if (k !== 'scope') form.append(k, v);
  for (const p of choose.profiles) form.append('profile', p);
  for (const s of choose.scopes ?? ['health:read']) form.append('scope', s);
  form.append('decision', choose.decision ?? 'allow');
  const real = await app.request('/oauth/authorize', {
    method: 'POST', body: form.toString(),
    headers: { cookie: c.cookie, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin', 'x-forwarded-for': c.ip },
  });
  assert.equal(real.status, 302, await real.clone().text());
  return { html, location: new URL(real.headers.get('location')!) };
}

async function token(body: Record<string, string>) {
  const res = await app.request('/oauth/token', { method: 'POST', body: new URLSearchParams(body).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  return { status: res.status, body: await res.json() as Record<string, string> };
}

let rpcId = 0;
async function mcp(accessToken: string | null, method: string, params?: unknown) {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

async function call(accessToken: string, name: string, args: Record<string, unknown> = {}) {
  const r = await mcp(accessToken, 'tools/call', { name, arguments: args });
  assert.equal(r.status, 200);
  return r.body.result as { isError: boolean; structuredContent?: Record<string, any>; content: { text: string }[] };
}

/** A full OAuth connection; returns its tokens. */
async function connect(c: TestClient, profiles: string[], scopes = ['health:read']) {
  const clientId = await register();
  const { verifier, challenge } = pkce();
  const { location } = await consent(c, authorizeUrl(clientId, challenge), { profiles, scopes });
  const code = location.searchParams.get('code')!;
  const t = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: 'https://claude.example/callback', resource: `${ORIGIN}/mcp` });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  return { clientId, access_token: t.body.access_token, refresh_token: t.body.refresh_token };
}

describe('discovery', () => {
  test('an unauthenticated MCP call points to the protected resource metadata, which points to the authorization server', async () => {
    const r = await mcp(null, 'initialize', { protocolVersion: '2025-06-18' });
    assert.equal(r.status, 401);
    const www = r.headers.get('www-authenticate')!;
    assert.match(www, /resource_metadata="https:\/\/health\.example\/\.well-known\/oauth-protected-resource\/mcp"/);
    const prm = await (await app.request('/.well-known/oauth-protected-resource/mcp')).json() as Record<string, unknown>;
    assert.equal(prm.resource, `${ORIGIN}/mcp`);
    assert.deepEqual(prm.authorization_servers, [ORIGIN]);
    const as = await (await app.request('/.well-known/oauth-authorization-server')).json() as Record<string, unknown>;
    assert.equal(as.token_endpoint, `${ORIGIN}/oauth/token`);
    assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
    assert.equal(as.client_id_metadata_document_supported, true);
  });

  test('redirect URIs: https, loopback http on any port, app schemes; never javascript: or remote http', () => {
    assert.ok(validRedirectUri('https://claude.ai/api/mcp/auth_callback'));
    assert.ok(validRedirectUri('http://127.0.0.1:3334/callback'));
    assert.ok(validRedirectUri('cursor://anysphere.cursor-mcp/oauth/callback'));
    assert.ok(!validRedirectUri('http://evil.example/cb'));
    assert.ok(!validRedirectUri('javascript:alert(1)'));
    assert.ok(redirectMatches(['http://localhost:1/cb'], 'http://localhost:5555/cb'));
    assert.ok(!redirectMatches(['https://a.example/cb'], 'https://a.example/cb2'));
  });

  test('registration refuses confidential clients and bad redirect URIs', async () => {
    const bad = await app.request('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://evil.example/cb'] }) });
    assert.equal(bad.status, 400);
    const secret = await app.request('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://a.example/cb'], token_endpoint_auth_method: 'client_secret_basic' }) });
    assert.equal(secret.status, 400);
  });
});

describe('consent and tokens', () => {
  test('signed out, the consent page sends the person to sign in and back', async () => {
    const clientId = await register();
    const url = authorizeUrl(clientId, pkce().challenge);
    const res = await app.request(url);
    assert.equal(res.status, 302);
    const loc = res.headers.get('location')!;
    assert.ok(loc.startsWith('/login?next='));
    assert.equal(decodeURIComponent(loc.slice('/login?next='.length)).split('?')[0], '/oauth/authorize');
  });

  test('an unknown client or a redirect it did not register gets an error page, not a redirect', async () => {
    const { c } = await account();
    const clientId = await register();
    assert.equal((await c.call('GET', authorizeUrl('lpcl_nobodyNobodyNobodyNobody', pkce().challenge))).status, 400);
    assert.equal((await c.call('GET', authorizeUrl(clientId, pkce().challenge, { redirect_uri: 'https://attacker.example/cb' }))).status, 400);
  });

  test('allow → code → PKCE token exchange; the code works once and only with its verifier', async () => {
    const { c, self, child } = await account();
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const { html, location } = await consent(c, authorizeUrl(clientId, challenge), { profiles: [self.id] });
    assert.match(html, /Connect Claude\?/);
    assert.match(html, /Kiran/, 'family members are offered');
    assert.equal(location.origin + location.pathname, 'https://claude.example/callback');
    assert.equal(location.searchParams.get('state'), 'xyz');
    assert.equal(location.searchParams.get('iss'), ORIGIN);
    const code = location.searchParams.get('code')!;
    const wrong = await token({ grant_type: 'authorization_code', code, code_verifier: pkce().verifier, client_id: clientId, redirect_uri: 'https://claude.example/callback' });
    assert.equal(wrong.body.error, 'invalid_grant');
    // The failed attempt used the code up.
    const again = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: 'https://claude.example/callback' });
    assert.equal(again.body.error, 'invalid_grant');

    const { challenge: ch2, verifier: v2 } = pkce();
    const second = await consent(c, authorizeUrl(clientId, ch2), { profiles: [self.id, child.id] });
    const ok = await token({ grant_type: 'authorization_code', code: second.location.searchParams.get('code')!, code_verifier: v2, client_id: clientId, redirect_uri: 'https://claude.example/callback' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.token_type, 'Bearer');
    assert.match(ok.body.access_token, /^lpa_in\./);
    assert.equal(ok.body.scope, 'health:read');

    // Refresh tokens rotate: the old one stops working.
    const r1 = await token({ grant_type: 'refresh_token', refresh_token: ok.body.refresh_token, client_id: clientId });
    assert.equal(r1.status, 200);
    assert.notEqual(r1.body.refresh_token, ok.body.refresh_token);
    assert.equal((await token({ grant_type: 'refresh_token', refresh_token: ok.body.refresh_token, client_id: clientId })).body.error, 'invalid_grant');
    assert.equal((await mcp(r1.body.access_token, 'ping')).status, 200);

    // One connection per agent: reconnecting updated it.
    const list = await c.json<AgentConnectionsInfo>('GET', '/api/agents');
    assert.equal(list.connections.length, 1);
    assert.deepEqual(new Set(list.connections[0].profileIds), new Set([self.id, child.id]));
    assert.equal(list.mcpUrl, `${ORIGIN}/mcp`);
  });

  test('cancel returns access_denied', async () => {
    const { c, self } = await account();
    const clientId = await register();
    const { location } = await consent(c, authorizeUrl(clientId, pkce().challenge), { profiles: [self.id], decision: 'deny' });
    assert.equal(location.searchParams.get('error'), 'access_denied');
    assert.equal(location.searchParams.get('code'), null);
  });

  test('a client identified by its metadata document URL (CIMD) can connect without registering', async () => {
    const { c, self } = await account();
    const { verifier, challenge } = pkce();
    const redirect = 'https://agent.example/callback';
    const { html, location } = await consent(c, authorizeUrl(CIMD, challenge, {}, redirect), { profiles: [self.id] });
    assert.match(html, /Connect Metadata Agent\?/);
    const t = await token({ grant_type: 'authorization_code', code: location.searchParams.get('code')!, code_verifier: verifier, client_id: CIMD, redirect_uri: redirect });
    assert.equal(t.status, 200);
  });

  test('the consent form cannot be submitted from another site or without its CSRF value', async () => {
    const { c, self } = await account();
    const clientId = await register();
    const form = new URLSearchParams({ client_id: clientId, redirect_uri: 'https://claude.example/callback', code_challenge: pkce().challenge, code_challenge_method: 'S256', response_type: 'code', profile: self.id, decision: 'allow', csrf: 'forged' });
    const cross = await app.request('/oauth/authorize', { method: 'POST', body: form.toString(), headers: { cookie: c.cookie, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'cross-site' } });
    assert.equal(cross.status, 400);
    const forged = await app.request('/oauth/authorize', { method: 'POST', body: form.toString(), headers: { cookie: c.cookie, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' } });
    assert.equal(forged.status, 400);
  });
});

describe('MCP tools', () => {
  test('initialize, list tools for the granted permissions, and read a health summary', async () => {
    const { c, self } = await account();
    const t = await connect(c, [self.id]);
    const init = await mcp(t.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.body.result.protocolVersion, '2025-06-18');
    assert.equal(init.body.result.serverInfo.name, 'lotuspond-health');
    const note = await app.request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t.access_token}` }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    assert.equal(note.status, 202, 'notifications get 202 and no body');

    const tools = (await mcp(t.access_token, 'tools/list')).body.result.tools as { name: string; inputSchema: { type: string } }[];
    const names = tools.map(x => x.name);
    assert.ok(names.includes('get_health_summary'));
    assert.ok(!names.includes('log_reading'), 'no write tools without health:write');
    assert.ok(!names.includes('find_lab_tests'), 'no lab tools when lab booking is off');
    assert.ok(tools.every(x => x.inputSchema.type === 'object'));

    const summary = await call(t.access_token, 'get_health_summary');
    assert.equal(summary.isError, false);
    const s = summary.structuredContent!;
    assert.equal(s.profile.bmi, 24.9);
    assert.equal(s.outOfRange.length, 1);
    assert.equal(s.outOfRange[0].markerId, 'ldl');
    assert.equal(s.outOfRange[0].direction, 'away_from_range');
    assert.ok(s.followUps.some((f: { marker: string }) => f.marker === 'HbA1c'), 'diabetes with no HbA1c on file suggests asking about it');
    assert.match(s.disclaimer, /not a diagnosis/);
    assert.deepEqual(JSON.parse(summary.content[0].text), s);

    const history = await call(t.access_token, 'get_marker_history', { marker: 'LDL cholesterol' });
    assert.equal(history.structuredContent!.results.length, 2);
    const results = await call(t.access_token, 'get_results', { out_of_range_only: true });
    assert.equal(results.structuredContent!.markers.length, 1);
    const unknown = await call(t.access_token, 'get_marker_history', { marker: 'ferritin' });
    assert.equal(unknown.isError, true);

    const unknownTool = await mcp(t.access_token, 'tools/call', { name: 'log_reading', arguments: {} });
    assert.equal(unknownTool.body.error.code, -32602);
  });

  test('only profiles shared with the connection can be read', async () => {
    const { c, self, child } = await account();
    const t = await connect(c, [child.id]);
    const profiles = await call(t.access_token, 'list_profiles');
    assert.deepEqual(profiles.structuredContent!.profiles.map((p: { id: string }) => p.id), [child.id]);
    const denied = await call(t.access_token, 'get_health_summary', { profile_id: self.id });
    assert.equal(denied.isError, true);
    // With only the child shared, leaving out profile_id means the child.
    assert.equal((await call(t.access_token, 'get_profile_details')).structuredContent!.id, child.id);
    // Another account's agent cannot see this account's profiles at all.
    const other = await account();
    const t2 = await connect(other.c, [other.self.id]);
    assert.equal((await call(t2.access_token, 'get_results', { profile_id: self.id })).isError, true);
  });

  test('with health:write, readings and profile entries are saved and marked with the agent', async () => {
    const { c, self } = await account();
    const t = await connect(c, [self.id], ['health:read', 'health:write']);
    const saved = await call(t.access_token, 'log_reading', { marker: 'Fasting glucose', value: 131, unit: 'mg/dL', date: '2026-11-01' });
    assert.equal(saved.isError, false, saved.content[0].text);
    assert.equal(saved.structuredContent!.saved.status, 'high');
    assert.equal(saved.structuredContent!.saved.source, 'Added by Claude');
    const added = await call(t.access_token, 'add_to_profile', { medications: ['Metformin 500 mg twice daily'], conditions: ['type 2 diabetes'] });
    assert.deepEqual(added.structuredContent!.profile.conditions, ['Type 2 diabetes'], 'duplicates are skipped');
    assert.deepEqual(added.structuredContent!.profile.medications, ['Metformin 500 mg twice daily']);
    const records = await c.json<{ measurements: { sourceFile: string }[] }>('GET', `/api/profiles/${self.id}/records`);
    assert.ok(records.measurements.some(m => m.sourceFile === 'Added by Claude'));
    const activity = await c.json<ActivityEvent[]>('GET', '/api/auth/activity');
    assert.ok(activity.some(e => e.kind === 'agent_wrote'));
    assert.ok(activity.some(e => e.kind === 'agent_connected'));
  });

  test('disconnecting on Account stops the agent at once', async () => {
    const { c, self } = await account();
    const t = await connect(c, [self.id]);
    const { connections } = await c.json<AgentConnectionsInfo>('GET', '/api/agents');
    await c.json('DELETE', `/api/agents/${connections[0].id}`, undefined, 204);
    assert.equal((await mcp(t.access_token, 'ping')).status, 401);
    assert.equal((await token({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.clientId })).body.error, 'invalid_grant');
  });
});

describe('tokens made on Account', () => {
  test('create, use, narrow and revoke a token for an agent that takes one', async () => {
    const { c, self, child } = await account();
    const made = await c.json<CreatedAgentToken>('POST', '/api/agents/tokens', { name: 'Claude Desktop', scopes: ['health:read'], profileIds: [self.id, child.id], expiresInDays: 30 }, 201);
    assert.match(made.token, /^lpt_in\./);
    assert.equal(made.mcpUrl, `${ORIGIN}/mcp`);
    assert.ok(made.connection.expiresAt);
    assert.equal((await call(made.token, 'list_profiles')).structuredContent!.profiles.length, 2);
    // Several profiles and the account holder is among them: default is the account holder.
    assert.equal((await call(made.token, 'get_profile_details')).structuredContent!.id, self.id);

    const narrowed = await c.json<{ profileIds: string[] }>('PATCH', `/api/agents/${made.connection.id}`, { profileIds: [child.id] });
    assert.deepEqual(narrowed.profileIds, [child.id]);
    assert.equal((await call(made.token, 'get_health_summary', { profile_id: self.id })).isError, true);

    const list = await c.json<AgentConnectionsInfo>('GET', '/api/agents');
    assert.ok(list.connections[0].lastUsedAt);
    assert.ok(!JSON.stringify(list).includes(made.token), 'tokens are never listed');

    await c.json('DELETE', `/api/agents/${made.connection.id}`, undefined, 204);
    assert.equal((await mcp(made.token, 'ping')).status, 401);
  });

  test('profiles of another account are refused', async () => {
    const a = await account();
    const b = await account();
    const res = await a.c.error('POST', '/api/agents/tokens', { name: 'x', scopes: ['health:read'], profileIds: [b.self.id], expiresInDays: null });
    assert.equal(res.status, 400);
  });
});

describe('synthesis', () => {
  test('trend and direction follow the range; conditions suggest tests that are missing or old', () => {
    const now = Date.parse('2026-11-10T00:00:00Z');
    const ms = [
      { ...measurement({ markerId: 'hba1c', rawName: 'HbA1c', value: 7.4, valueText: '7.4', unit: '%', range: { high: 5.7, source: 'report' }, status: 'high', date: '2025-06-01' }), id: '1' },
      { ...measurement({ markerId: 'hba1c', rawName: 'HbA1c', value: 6.6, valueText: '6.6', unit: '%', range: { high: 5.7, source: 'report' }, status: 'high', date: '2025-12-01' }), id: '2' },
    ] as Parameters<typeof markerSummaries>[0];
    const [s] = markerSummaries(ms, now);
    assert.equal(s.trend, 'falling');
    assert.equal(s.direction, 'toward_range');
    const f = followUps({ conditions: ['Diabetes', 'Hypothyroidism'] }, [s]);
    assert.ok(f.some(x => x.marker === 'HbA1c' && /repeat/.test(x.suggestion)), 'out of range for more than 3 months');
    assert.ok(f.some(x => x.marker === 'TSH' && /No TSH result/.test(x.reason)));
  });
});
