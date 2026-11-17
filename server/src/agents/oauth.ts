// OAuth 2.1 for agents (MCP authorization, https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).
// This server is both the authorization server and the protected resource (/mcp):
//
//   GET  /.well-known/oauth-protected-resource[/mcp]  RFC 9728: where to sign in for /mcp
//   GET  /.well-known/oauth-authorization-server     RFC 8414: endpoints and what they support
//   POST /oauth/register                             RFC 7591 dynamic client registration (public clients only)
//   GET  /oauth/authorize                            consent screen: which profiles, which permissions
//   POST /oauth/authorize                            the person's decision
//   POST /oauth/token                                authorization_code (PKCE S256 required) and refresh_token
//   POST /oauth/revoke                               RFC 7009
//
// Clients are either registered (an opaque id from /oauth/register) or identified by an https URL to their client
// metadata document (Client ID Metadata Documents, the 2025-11-25 default). Every client is public and proves
// itself with PKCE; there are no client secrets.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { AGENT_BASICS_TEXT, AGENT_CATEGORIES, AGENT_CATEGORY_TEXT, AGENT_EXPIRY_CHOICES, AGENT_SCOPE_TEXT, AGENT_SCOPES, type AgentScope } from '../../../shared/agents.ts';
import type { Config } from '../config.ts';
import { eventContext, recordEvent } from '../compliance/audit.ts';
import { findSession, readSessionCookie } from '../auth/sessions.ts';
import { agentGrants, oauthClients, profiles } from '../db/schema.ts';
import { clientIp, type AppEnv, type Deps } from '../http.ts';
import { RateLimiter } from '../lib/rate-limit.ts';
import { relationshipOrder } from '../routes/profiles.ts';
import { recordSharingConsent } from './grants.ts';
import { ACCESS_TTL_MS, cleanCategories, cleanScopes, expiryIn, grantCategories, CODE_TTL_MS, issueSecret, ownProfiles, REFRESH_TTL_MS, resolveSecret, parseSecret, digest } from './grants.ts';
import { agentTokens } from '../db/schema.ts';

/** This server's public origin: PUBLIC_URL, or the request's (forwarded) host. */
export function publicOrigin(c: Context, config: Config): string {
  if (config.publicUrl) return config.publicUrl;
  const url = new URL(c.req.url);
  if (config.trustProxy) {
    const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim();
    const host = c.req.header('x-forwarded-host')?.split(',')[0]?.trim();
    if (host) return `${proto === 'http' ? 'http' : 'https'}://${host}`;
    if (proto === 'https' || proto === 'http') return `${proto}://${url.host}`;
  }
  return url.origin;
}

export const resourceMetadataUrl = (origin: string) => `${origin}/.well-known/oauth-protected-resource/mcp`;

export interface ClientInfo { id: string; name: string; redirectUris: string[] }

/** Fetches a client metadata document; replaceable in tests. */
export type MetadataFetcher = (url: string) => Promise<unknown>;

export interface OAuthOptions { fetchClientMetadata?: MetadataFetcher }

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^0\./];
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return PRIVATE_V4.some(r => r.test(ip));
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:');
}

/** https only, public addresses only, 5 seconds, 16 KB, no redirects: a client id must not let anyone probe our network. */
export const defaultFetchClientMetadata: MetadataFetcher = async url => {
  const u = new URL(url);
  const addrs = await lookup(u.hostname, { all: true });
  if (!addrs.length || addrs.some(a => isPrivateAddress(a.address))) throw new Error('private address');
  const res = await fetch(u, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`status ${res.status}`);
  const text = await res.text();
  if (text.length > 16_384) throw new Error('too large');
  return JSON.parse(text);
};

/** Redirect URIs we accept: https, http on loopback only (native apps, RFC 8252), or a private-use app scheme. */
export function validRedirectUri(uri: string): boolean {
  let u: URL;
  try { u = new URL(uri); } catch { return false; }
  if (u.hash) return false;
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol) && !['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:', 'ftp:', 'ws:', 'wss:'].includes(u.protocol);
}

/** Loopback redirects may change port (RFC 8252 §7.3); everything else must match exactly. */
export function redirectMatches(registered: string[], uri: string): boolean {
  if (registered.includes(uri)) return true;
  let u: URL;
  try { u = new URL(uri); } catch { return false; }
  if (u.protocol !== 'http:') return false;
  return registered.some(r => {
    try {
      const v = new URL(r);
      return v.protocol === 'http:' && v.hostname === u.hostname && v.pathname === u.pathname && v.search === u.search;
    } catch { return false; }
  });
}

const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

const cleanName = (s: unknown, fallback: string) =>
  // eslint-disable-next-line no-control-regex
  (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 80) : '') || fallback;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

// No form-action: browsers apply it to the redirect after the form too, which would block app-scheme redirect URIs.
const CONSENT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'";

export function oauthRoutes(deps: Deps, opts: OAuthOptions = {}) {
  const { config } = deps;
  const fetchMetadata = opts.fetchClientMetadata ?? defaultFetchClientMetadata;
  const csrfKey = createHmac('sha256', deps.secrets.auditKey).update('lotuspond:oauth-consent:v1').digest();
  const registrations = new RateLimiter(20, 60 * 60_000);
  const tokenCalls = new RateLimiter(60, 60_000);
  const metadataCache = new Map<string, { info: ClientInfo; until: number }>();
  const app = new Hono<AppEnv>();

  const cors = (c: Context) => {
    c.header('Access-Control-Allow-Origin', '*');
    c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, MCP-Protocol-Version');
    c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    c.header('Cache-Control', 'no-store');
  };

  /* ---------------- metadata ---------------- */

  const protectedResource = (c: Context) => {
    cors(c);
    const origin = publicOrigin(c, config);
    return c.json({
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      scopes_supported: AGENT_SCOPES,
      bearer_methods_supported: ['header'],
      resource_name: 'LotusPond Health',
      resource_documentation: `${origin}/trust/`,
    });
  };
  app.get('/.well-known/oauth-protected-resource', protectedResource);
  app.get('/.well-known/oauth-protected-resource/mcp', protectedResource);

  const serverMetadata = (c: Context) => {
    cors(c);
    const origin = publicOrigin(c, config);
    return c.json({
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      revocation_endpoint: `${origin}/oauth/revoke`,
      scopes_supported: AGENT_SCOPES,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      service_documentation: `${origin}/trust/`,
    });
  };
  app.get('/.well-known/oauth-authorization-server', serverMetadata);
  app.get('/.well-known/oauth-authorization-server/mcp', serverMetadata);
  app.options('/.well-known/*', c => { cors(c); return c.body(null, 204); });
  app.options('/oauth/*', c => { cors(c); return c.body(null, 204); });

  /* ---------------- clients ---------------- */

  async function findClient(clientId: string): Promise<ClientInfo | null> {
    if (/^https:\/\//.test(clientId)) {
      const hit = metadataCache.get(clientId);
      if (hit && hit.until > Date.now()) return hit.info;
      let doc: Record<string, unknown>;
      try {
        const u = new URL(clientId);
        if (u.hash || u.username || u.password || u.pathname === '/') return null;
        doc = await fetchMetadata(clientId) as Record<string, unknown>;
      } catch {
        return null;
      }
      if (!doc || doc.client_id !== clientId || !Array.isArray(doc.redirect_uris)) return null;
      const uris = doc.redirect_uris.filter((u): u is string => typeof u === 'string' && validRedirectUri(u)).slice(0, 10);
      if (!uris.length) return null;
      const info = { id: clientId, name: cleanName(doc.client_name, new URL(clientId).hostname), redirectUris: uris };
      if (metadataCache.size > 1000) metadataCache.clear();
      metadataCache.set(clientId, { info, until: Date.now() + 10 * 60_000 });
      return info;
    }
    if (!/^lpcl_[\w-]{20,60}$/.test(clientId)) return null;
    const [row] = await deps.db.select().from(oauthClients).where(eq(oauthClients.id, clientId)).limit(1);
    return row ? { id: row.id, name: row.name, redirectUris: row.redirectUris } : null;
  }

  app.post('/oauth/register', async c => {
    cors(c);
    if (registrations.hit(clientIp(c, config.trustProxy))) return c.json({ error: 'temporarily_unavailable', error_description: 'Too many registrations. Try again later.' }, 429);
    let body: Record<string, unknown>;
    try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_client_metadata', error_description: 'Send client metadata as JSON.' }, 400); }
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
    if (!uris.length || uris.length > 10 || !uris.every(validRedirectUri)) {
      return c.json({ error: 'invalid_redirect_uri', error_description: 'Give 1 to 10 redirect URIs: https, http on localhost, or an app scheme.' }, 400);
    }
    const method = body.token_endpoint_auth_method ?? 'none';
    if (method !== 'none') return c.json({ error: 'invalid_client_metadata', error_description: 'Only public clients (token_endpoint_auth_method "none", with PKCE) are supported.' }, 400);
    const grants = Array.isArray(body.grant_types) ? body.grant_types : ['authorization_code', 'refresh_token'];
    if (grants.some(g => g !== 'authorization_code' && g !== 'refresh_token')) {
      return c.json({ error: 'invalid_client_metadata', error_description: 'Supported grant types: authorization_code, refresh_token.' }, 400);
    }
    const id = `lpcl_${randomBytes(24).toString('base64url')}`;
    const name = cleanName(body.client_name, new URL(uris[0]).hostname || 'AI agent');
    await deps.db.insert(oauthClients).values({ id, name, redirectUris: uris });
    return c.json({
      client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: name, redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
    }, 201);
  });

  /* ---------------- consent ---------------- */

  interface AuthRequest { clientId: string; redirectUri: string; state: string; challenge: string; scopes: AgentScope[]; resource: string | null }

  function readRequest(q: Record<string, string | undefined>): { req?: AuthRequest; problem?: string; redirectError?: string } {
    const clientId = q.client_id ?? '';
    const redirectUri = q.redirect_uri ?? '';
    if (!clientId || !redirectUri) return { problem: 'The agent did not say who it is or where to return to.' };
    const req: AuthRequest = {
      clientId, redirectUri, state: (q.state ?? '').slice(0, 500), challenge: q.code_challenge ?? '',
      scopes: q.scope ? cleanScopes(q.scope.split(/\s+/)) : ['health:read'],
      resource: q.resource || null,
    };
    if (q.response_type !== 'code') return { req, redirectError: 'unsupported_response_type' };
    if (q.code_challenge_method !== 'S256' || !/^[\w-]{43,128}$/.test(req.challenge)) return { req, redirectError: 'invalid_request' };
    if (!req.scopes.length) req.scopes = ['health:read'];
    if (!req.scopes.includes('health:read')) req.scopes.unshift('health:read');
    return { req };
  }

  const csrfFor = (sessionId: string, r: AuthRequest) =>
    createHmac('sha256', csrfKey).update(`${sessionId}\n${r.clientId}\n${r.redirectUri}\n${r.challenge}`).digest('base64url');

  function back(r: AuthRequest, origin: string, params: Record<string, string>) {
    const u = new URL(r.redirectUri);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    if (r.state) u.searchParams.set('state', r.state);
    u.searchParams.set('iss', origin);
    return u.toString();
  }

  function page(c: Context, title: string, body: string, status: 200 | 400 = 200) {
    c.header('Content-Security-Policy', CONSENT_CSP);
    c.header('X-Frame-Options', 'DENY');
    c.header('Cache-Control', 'no-store');
    return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · LotusPond Health</title><meta name="robots" content="noindex">
<style>
:root{--bg:#f6f7f5;--card:#fff;--ink:#16211c;--muted:#5b6b63;--line:#dfe5e1;--accent:#0f7a5a;--warn:#8a5300}
@media (prefers-color-scheme:dark){:root{--bg:#0f1512;--card:#17201b;--ink:#e6eee9;--muted:#9fb1a7;--line:#2a3730;--accent:#46c39a;--warn:#f0b35a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:520px;margin:0 auto;padding:32px 16px}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px}
h1{font-size:1.35rem;margin:0 0 4px}p{margin:8px 0}.muted{color:var(--muted);font-size:.92rem}.brand{font-weight:600;color:var(--accent);margin-bottom:16px}
fieldset{border:0;padding:0;margin:20px 0 0}legend{font-weight:600;margin-bottom:6px}label{display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-top:1px solid var(--line)}
label:first-of-type{border-top:0}select{font:inherit;padding:8px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--ink);margin:4px 0}fieldset .muted{margin:0 0 4px}input{margin-top:4px;accent-color:var(--accent)}small{display:block;color:var(--muted)}
.actions{display:flex;gap:12px;margin-top:24px}button{flex:1;font:inherit;padding:12px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--ink);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}.note{color:var(--warn);font-size:.92rem}code{font-size:.9em;word-break:break-all}
</style></head><body><main><div class="brand">LotusPond Health</div><div class="card">${body}</div></main></body></html>`, status);
  }

  async function signedIn(c: Context) {
    const token = readSessionCookie(c);
    return token ? findSession(deps.cells, token, config.sessionTtlMs) : null;
  }

  app.get('/oauth/authorize', async c => {
    const q = c.req.query();
    const { req, problem, redirectError } = readRequest(q);
    if (!req) return page(c, 'Cannot connect', `<h1>This link is incomplete</h1><p>${escapeHtml(problem!)}</p><p class="muted">Start connecting again from the agent.</p>`, 400);
    const client = await findClient(req.clientId);
    if (!client || !redirectMatches(client.redirectUris, req.redirectUri)) {
      return page(c, 'Cannot connect', '<h1>Unknown agent</h1><p>This agent is not registered, or asked to return somewhere it did not register. Nothing was shared.</p>', 400);
    }
    const origin = publicOrigin(c, config);
    if (redirectError) return c.redirect(back(req, origin, { error: redirectError, error_description: 'PKCE with S256 and response_type=code are required.' }), 302);
    if (req.resource && req.resource !== `${origin}/mcp` && req.resource !== origin) return c.redirect(back(req, origin, { error: 'invalid_target' }), 302);

    const session = await signedIn(c);
    if (!session) {
      const next = `/oauth/authorize?${new URLSearchParams(q as Record<string, string>)}`;
      // With LotusPond Accounts: someone already signed in there comes straight back here, without a sign-in page
      // (prompt=none); anyone else gets Health's sign-in page, which offers Accounts too (routes/accounts.ts).
      if (config.accounts) return c.redirect(`/api/auth/accounts/start?${new URLSearchParams({ intent: 'login', prompt: 'none', next })}`, 302);
      return c.redirect(`/login?next=${encodeURIComponent(next)}`, 302);
    }
    const { db } = session.cell;
    const rows = (await db.select().from(profiles).where(eq(profiles.userId, session.user.id))).sort(relationshipOrder);
    const [existing] = await db.select().from(agentGrants).where(eq(agentGrants.userId, session.user.id)).then(gs => gs.filter(g => g.clientId === client.id));
    const preselected = new Set(existing?.profileIds ?? rows.filter(p => p.relationship === 'self').map(p => p.id));
    const host = new URL(req.redirectUri).host || new URL(req.redirectUri).protocol;
    const hidden = Object.entries({
      client_id: req.clientId, redirect_uri: req.redirectUri, state: req.state, code_challenge: req.challenge,
      code_challenge_method: 'S256', response_type: 'code', resource: req.resource ?? '', csrf: csrfFor(session.id, req),
    }).map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`).join('');
    const profileRows = rows.map(p => `<label><input type="checkbox" name="profile" value="${p.id}"${preselected.has(p.id) ? ' checked' : ''}><span>${escapeHtml(p.displayName)}<small>${p.relationship === 'self' ? 'You' : escapeHtml(p.relationship[0].toUpperCase() + p.relationship.slice(1))}</small></span></label>`).join('');
    const shared = new Set(existing ? grantCategories(existing) : AGENT_CATEGORIES);
    const categoryRows = AGENT_CATEGORIES.map(k => `<label><input type="checkbox" name="category" value="${k}"${shared.has(k) ? ' checked' : ''}><span>${escapeHtml(AGENT_CATEGORY_TEXT[k].title)}<small>${escapeHtml(AGENT_CATEGORY_TEXT[k].detail)}</small></span></label>`).join('');
    // Reconnecting keeps a connection's remaining time as the nearest choice; a new one defaults to a year.
    const left = existing?.expiresAt ? (existing.expiresAt.getTime() - Date.now()) / 86_400_000 : existing ? null : 365;
    const pick = left == null ? null : AGENT_EXPIRY_CHOICES.filter(x => x.days != null).reduce((a, b) => (Math.abs(b.days! - left) < Math.abs(a.days! - left) ? b : a)).days;
    const expiryOptions = AGENT_EXPIRY_CHOICES.map(x => `<option value="${x.days ?? 'never'}"${x.days === pick ? ' selected' : ''}>${escapeHtml(x.label)}</option>`).join('');
    const scopeRows = AGENT_SCOPES.filter(s => req.scopes.includes(s)).map(s => `<label><input type="checkbox" name="scope" value="${s}" checked${s === 'health:read' ? ' disabled' : ''}><span>${escapeHtml(AGENT_SCOPE_TEXT[s].title)}<small>${escapeHtml(AGENT_SCOPE_TEXT[s].detail)}</small></span></label>`).join('');
    return page(c, 'Connect an agent', `
<h1>Connect ${escapeHtml(client.name)}?</h1>
<p class="muted">Signed in as ${escapeHtml(session.user.email)}. After you allow it, you return to <code>${escapeHtml(host)}</code>.</p>
<form method="post" action="/oauth/authorize">${hidden}<input type="hidden" name="scope" value="health:read">
<fieldset><legend>Whose records it may see</legend>${profileRows}</fieldset>
<fieldset><legend>What it may see</legend><input type="hidden" name="categories_shown" value="1"><p class="muted">${escapeHtml(AGENT_BASICS_TEXT)}</p>${categoryRows}</fieldset>
<fieldset><legend>What it may do</legend>${scopeRows}</fieldset>
<fieldset><legend>Keep connected for</legend><select name="expires" aria-label="Keep connected for">${expiryOptions}</select><small>After that the agent stops, and you can connect it again.</small></fieldset>
<p class="note">The agent's company receives what it reads, under its own privacy terms. You can remove this connection at any time on Account, Connected agents.</p>
<div class="actions"><button type="submit" name="decision" value="deny">Cancel</button><button class="primary" type="submit" name="decision" value="allow">Allow</button></div>
</form>`);
  });

  app.post('/oauth/authorize', async c => {
    const site = c.req.header('sec-fetch-site');
    if (site && site !== 'same-origin') return page(c, 'Blocked', '<h1>Blocked</h1><p>This request came from another site.</p>', 400);
    const form = await c.req.parseBody({ all: true });
    const one = (k: string) => (typeof form[k] === 'string' ? form[k] as string : undefined);
    const many = (k: string) => ([] as unknown[]).concat(form[k] ?? []).filter((v): v is string => typeof v === 'string');
    const { req } = readRequest({ ...Object.fromEntries(Object.keys(form).map(k => [k, one(k)])), scope: undefined });
    if (!req) return page(c, 'Cannot connect', '<h1>This form is incomplete</h1><p>Start connecting again from the agent.</p>', 400);
    const client = await findClient(req.clientId);
    if (!client || !redirectMatches(client.redirectUris, req.redirectUri)) return page(c, 'Cannot connect', '<h1>Unknown agent</h1>', 400);
    const session = await signedIn(c);
    if (!session) return page(c, 'Signed out', '<h1>You were signed out</h1><p>Start connecting again from the agent.</p>', 400);
    const csrf = Buffer.from(one('csrf') ?? '');
    const want = Buffer.from(csrfFor(session.id, req));
    if (csrf.length !== want.length || !timingSafeEqual(csrf, want)) return page(c, 'Expired', '<h1>This page expired</h1><p>Start connecting again from the agent.</p>', 400);
    const origin = publicOrigin(c, config);
    if (one('decision') !== 'allow') return c.redirect(back(req, origin, { error: 'access_denied', error_description: 'The person did not allow the connection.' }), 302);

    const { db } = session.cell;
    const scopes = cleanScopes(['health:read', ...many('scope')]);
    // A consent page from before the categories existed has no such field: it keeps sharing everything, as it said.
    const categories = one('categories_shown') ? cleanCategories(many('category')) : null;
    const days = Number(one('expires'));
    const expiresAt = AGENT_EXPIRY_CHOICES.some(x => x.days === days) ? expiryIn(days) : null;
    const profileIds = await ownProfiles(db, session.user.id, [...new Set(many('profile'))].slice(0, 50));
    if (!profileIds.length) return page(c, 'Choose a profile', '<h1>Choose at least one profile</h1><p>Go back and tick whose records the agent may see.</p>', 400);
    const redirectHost = (() => { try { return new URL(req.redirectUri).host || null; } catch { return null; } })();
    const [grant] = await db.insert(agentGrants)
      .values({ userId: session.user.id, kind: 'oauth', clientId: client.id, name: client.name, redirectHost, scopes, categories, profileIds, expiresAt })
      .onConflictDoUpdate({ target: [agentGrants.userId, agentGrants.clientId], set: { name: client.name, redirectHost, scopes, categories, profileIds, expiresAt } })
      .returning();
    const code = await issueSecret(db, session.user.region, grant.id, 'code', {
      ttlMs: CODE_TTL_MS, codeChallenge: req.challenge, redirectUri: req.redirectUri, resource: req.resource ? `${origin}/mcp` : null,
    });
    await recordSharingConsent(db, session.user, grant);
    await recordEvent(db, eventContext(c, deps), session.user.id, 'agent_connected', { connectionId: grant.id });
    return c.redirect(back(req, origin, { code }), 302);
  });

  /* ---------------- tokens ---------------- */

  async function readForm(c: Context): Promise<Record<string, string>> {
    const type = c.req.header('content-type') ?? '';
    try {
      if (type.includes('application/json')) {
        const j = await c.req.json() as Record<string, unknown>;
        return Object.fromEntries(Object.entries(j).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
      }
      const f = await c.req.parseBody();
      return Object.fromEntries(Object.entries(f).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
    } catch {
      return {};
    }
  }

  const tokenError = (c: Context, error: string, description: string, status: 400 | 401 | 429 = 400) => c.json({ error, error_description: description }, status);

  app.post('/oauth/token', async c => {
    cors(c);
    c.header('Pragma', 'no-cache');
    if (tokenCalls.hit(clientIp(c, config.trustProxy))) return tokenError(c, 'slow_down', 'Too many requests.', 429);
    const f = await readForm(c);
    const origin = publicOrigin(c, config);

    if (f.grant_type === 'authorization_code') {
      if (!f.code || !f.code_verifier || !f.client_id || !f.redirect_uri) return tokenError(c, 'invalid_request', 'code, code_verifier, client_id and redirect_uri are required.');
      const found = await resolveSecret(deps.cells, f.code, 'code', true);
      if (!found) return tokenError(c, 'invalid_grant', 'This code is unknown, used or expired.');
      const { token, grant, cell, user } = found;
      if (grant.clientId !== f.client_id || token.redirectUri !== f.redirect_uri || !token.codeChallenge || s256(f.code_verifier) !== token.codeChallenge) {
        return tokenError(c, 'invalid_grant', 'The code does not match this client, redirect URI or code verifier.');
      }
      if (f.resource && f.resource !== `${origin}/mcp` && f.resource !== origin) return tokenError(c, 'invalid_target', 'Unknown resource.');
      return c.json(await pair(cell.db, user.region, grant.id, grant.scopes, token.resource));
    }

    if (f.grant_type === 'refresh_token') {
      if (!f.refresh_token || !f.client_id) return tokenError(c, 'invalid_request', 'refresh_token and client_id are required.');
      const found = await resolveSecret(deps.cells, f.refresh_token, 'refresh', true);
      if (!found || found.grant.clientId !== f.client_id) return tokenError(c, 'invalid_grant', 'This refresh token is unknown, used or expired. Connect again.');
      return c.json(await pair(found.cell.db, found.user.region, found.grant.id, found.grant.scopes, found.token.resource));
    }

    return tokenError(c, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
  });

  async function pair(db: Deps['db'], region: Parameters<typeof issueSecret>[1], grantId: string, scopes: string[], resource: string | null) {
    const access = await issueSecret(db, region, grantId, 'access', { ttlMs: ACCESS_TTL_MS, resource });
    const refresh = await issueSecret(db, region, grantId, 'refresh', { ttlMs: REFRESH_TTL_MS, resource });
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope: cleanScopes(scopes).join(' ') };
  }

  app.post('/oauth/revoke', async c => {
    cors(c);
    const f = await readForm(c);
    const parsed = f.token ? parseSecret(deps.cells, f.token) : null;
    if (parsed) await parsed.cell.db.delete(agentTokens).where(eq(agentTokens.id, digest(f.token)));
    return c.body(null, 200);
  });

  return app;
}
