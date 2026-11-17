// A stand-in for LotusPond Accounts (ACCOUNTS_ISSUER=fake), for development and tests only: a minimal OpenID Connect
// issuer inside this server, so Health's side of "one LotusPond account" (docs/identity.md) can be built and tried
// before Accounts exists. Its page asks for an email and lets you choose the claims Accounts would send. It keeps
// nothing on disk: codes live in memory for a minute and the signing key is new each time the server starts.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { Hono } from 'hono';
import { DATA_REGIONS } from '../config.ts';
import { pkceChallenge, type Fetch, type IssuerMetadata } from './oidc.ts';

export const FAKE_ACCOUNTS_PATH = '/api/dev-accounts';
export const FAKE_ACCOUNTS_ISSUER = 'urn:lotuspond:dev-accounts';
const CODE_TTL_MS = 60_000;

interface PendingCode {
  clientId: string; redirectUri: string; challenge: string; nonce: string; claims: Record<string, unknown>; expiresAt: number;
}

const esc = (s: string) => s.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);

export interface FakeAccounts {
  app: Hono;
  metadata: IssuerMetadata;
  /** Routes the server's own calls (token, keys) to the stand-in without a network round trip. */
  fetch: Fetch;
}

export function fakeAccounts(clientId: string): FakeAccounts {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const kid = randomBytes(6).toString('hex');
  const codes = new Map<string, PendingCode>();
  const app = new Hono();

  const metadata: IssuerMetadata = {
    issuer: FAKE_ACCOUNTS_ISSUER,
    authorization_endpoint: `${FAKE_ACCOUNTS_PATH}/authorize`,
    token_endpoint: `${FAKE_ACCOUNTS_PATH}/token`,
    jwks_uri: `${FAKE_ACCOUNTS_PATH}/jwks`,
    end_session_endpoint: `${FAKE_ACCOUNTS_PATH}/logout`,
  };

  app.get('/.well-known/openid-configuration', c => c.json({ ...metadata, response_types_supported: ['code'], code_challenge_methods_supported: ['S256'] }));
  app.get('/jwks', c => c.json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'ES256' }] }));

  app.get('/authorize', c => {
    const q = c.req.query();
    const problem = q.client_id !== clientId ? 'Unknown client_id.'
      : q.response_type !== 'code' ? 'Only response_type=code is supported.'
      : q.code_challenge_method !== 'S256' || !q.code_challenge ? 'PKCE (S256) is required.'
      : !q.redirect_uri || !/^https?:\/\//.test(q.redirect_uri) ? 'redirect_uri is missing.'
      : !q.state || !q.nonce ? 'state and nonce are required.' : null;
    if (problem) return c.html(page(`<p class="err">${esc(problem)}</p>`), 400);
    const hidden = ['client_id', 'redirect_uri', 'state', 'nonce', 'code_challenge']
      .map(k => `<input type="hidden" name="${k}" value="${esc(q[k] ?? '')}">`).join('');
    const regions = DATA_REGIONS.map(r => `<option value="${r}"${r === 'in' ? ' selected' : ''}>${r}</option>`).join('');
    return c.html(page(`
      <h1>${q.prompt === 'create' ? 'Create' : 'Sign in to'} your LotusPond account</h1>
      <p class="note">Stand-in for LotusPond Accounts, for development only. No password is asked; choose what Accounts would say about this account.</p>
      <form method="post" action="${FAKE_ACCOUNTS_PATH}/authorize">${hidden}
        <label>Email <input name="email" type="email" required autofocus></label>
        <label><input type="checkbox" name="email_verified" value="true" checked> Email address verified</label>
        <label>Region <select name="region">${regions}<option value="">(not sent)</option></select></label>
        <label><input type="checkbox" name="enterprise" value="true"> Created through a company's single sign-on</label>
        <button>Continue</button>
      </form>`));
  });

  // Signing out. The stand-in keeps no sign-in of its own, so there is nothing to end: it shows that it was asked,
  // then goes back to Health.
  app.get('/logout', c => {
    const q = c.req.query();
    if (q.client_id !== clientId) return c.html(page('<p class="err">Unknown client_id.</p>'), 400);
    const back = q.post_logout_redirect_uri && /^https?:\/\//.test(q.post_logout_redirect_uri) ? q.post_logout_redirect_uri : null;
    return c.html(page(`<h1>Signed out of your LotusPond account</h1>
      <p class="note">Stand-in for LotusPond Accounts, for development only.</p>
      ${back ? `<p><a href="${esc(back)}">Back to LotusPond Health</a></p>` : ''}`));
  });

  app.post('/authorize', async c => {
    const f = await c.req.parseBody() as Record<string, string>;
    if (f.client_id !== clientId || !f.redirect_uri || !f.code_challenge || !f.state || !f.nonce) return c.text('Bad request', 400);
    const email = (f.email ?? '').trim().toLowerCase();
    if (!email.includes('@')) return c.text('An email address is needed.', 400);
    const code = randomBytes(24).toString('base64url');
    codes.set(code, {
      clientId, redirectUri: f.redirect_uri, challenge: f.code_challenge, nonce: f.nonce, expiresAt: Date.now() + CODE_TTL_MS,
      claims: {
        // The same email always gets the same subject, as a real account would.
        sub: `dev|${createHash('sha256').update(email).digest('hex').slice(0, 24)}`,
        email,
        email_verified: f.email_verified === 'true',
        ...(f.region ? { region: f.region } : {}),
        ...(f.enterprise === 'true' ? { enterprise_connection: 'dev-company-sso' } : {}),
      },
    });
    const to = new URL(f.redirect_uri);
    to.searchParams.set('code', code);
    to.searchParams.set('state', f.state);
    return c.redirect(to.toString(), 302);
  });

  app.post('/token', async c => {
    const f = await c.req.parseBody() as Record<string, string>;
    const pending = codes.get(f.code ?? '');
    codes.delete(f.code ?? '');
    const bad = (error: string) => c.json({ error }, 400);
    if (f.grant_type !== 'authorization_code') return bad('unsupported_grant_type');
    if (!pending || pending.expiresAt < Date.now()) return bad('invalid_grant');
    if (f.client_id !== pending.clientId || f.redirect_uri !== pending.redirectUri) return bad('invalid_grant');
    if (!f.code_verifier || pkceChallenge(f.code_verifier) !== pending.challenge) return bad('invalid_grant');
    const now = Math.floor(Date.now() / 1000);
    const idToken = signJwt(privateKey, kid, { iss: FAKE_ACCOUNTS_ISSUER, aud: clientId, iat: now, exp: now + 300, nonce: pending.nonce, ...pending.claims });
    return c.json({ id_token: idToken, access_token: randomBytes(24).toString('base64url'), token_type: 'Bearer', expires_in: 300 });
  });

  const fetchImpl: Fetch = async (url, init) => {
    if (!url.startsWith(FAKE_ACCOUNTS_PATH)) throw new Error(`The stand-in Accounts issuer does not serve ${url}`);
    return app.request(url.slice(FAKE_ACCOUNTS_PATH.length) || '/', init);
  };
  return { app, metadata, fetch: fetchImpl };
}

function signJwt(key: KeyObject, kid: string, claims: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const input = `${enc({ alg: 'ES256', typ: 'JWT', kid })}.${enc(claims)}`;
  const sig = sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
  return `${input}.${sig.toString('base64url')}`;
}

const page = (body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>LotusPond Accounts (stand-in)</title><style>
body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;color:#12302e;background:#f3f6f5}
h1{font-size:1.4rem}.note{color:#5b6f6c;font-size:.9rem}.err{color:#a3243b}
form{display:grid;gap:.8rem}label{display:grid;gap:.25rem}label:has(input[type=checkbox]){display:flex;gap:.5rem;align-items:center}
input,select,button{font:inherit;padding:.5rem;border:1px solid #b9c8c5;border-radius:.5rem}button{background:#b8506d;color:#fff;border:0;cursor:pointer}
</style></head><body>${body}</body></html>`;
