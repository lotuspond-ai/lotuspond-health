// A stand-in for LotusPond Accounts (ACCOUNTS_ISSUER=fake), for development and tests only: a minimal OpenID Connect
// issuer inside this server, so Health's side of "one LotusPond account" (docs/identity.md) can be built and tried
// before Accounts exists. Its page asks for an email and lets you choose the claims Accounts would send. It keeps
// nothing on disk: codes live in memory for a minute and the signing key is new each time the server starts.
import { createHash, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { DATA_REGIONS } from '../config.ts';
import { pkceChallenge, type Fetch, type IssuerMetadata } from './oidc.ts';

export const FAKE_ACCOUNTS_PATH = '/api/dev-accounts';
export const FAKE_ACCOUNTS_ISSUER = 'urn:lotuspond:dev-accounts';
const CODE_TTL_MS = 60_000;
/** The stand-in's own remembered sign-in, in this browser only (development; not signed). */
const SIGNED_IN_COOKIE = 'dev_accounts_signed_in';

interface PendingCode {
  clientId: string; redirectUri: string; challenge: string; nonce: string; claims: Record<string, unknown>; expiresAt: number;
}

const esc = (s: string) => s.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);

export interface FakeAccounts {
  app: Hono;
  metadata: IssuerMetadata;
  /** Routes the server's own calls (token, keys) to the stand-in without a network round trip. */
  fetch: Fetch;
  /** A signed logout token (Back-Channel Logout) for an account (`sub`), a session (`sid`) or both, with any changes. */
  logoutToken(who: { sub?: string; sid?: string }, change?: Record<string, unknown>): string;
  /** Where the stand-in delivers logout tokens: Health's handler, in process (routes/accounts.ts). */
  onLogoutToken(deliver: (token: string) => Promise<number>): void;
}

/** The subject the stand-in gives an email: the same email always gets the same one, as a real account would. */
export const fakeSubject = (email: string) => `dev|${createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 24)}`;

export function fakeAccounts(clientId: string): FakeAccounts {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  /** The client an ID token from this issuer was given to, checking the signature but not the expiry, or null. */
  const hintClient = (token: string): string | null => {
    const [h, p, s] = token.split('.');
    if (!h || !p || !s) return null;
    if (!verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))) return null;
    try {
      const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as { iss?: string; aud?: string };
      return claims.iss === FAKE_ACCOUNTS_ISSUER && typeof claims.aud === 'string' ? claims.aud : null;
    } catch { return null; }
  };
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
      : !q.state || !q.nonce ? 'state and nonce are required.'
      // As LotusPond Accounts' Hydra does: prompt=create is not a value it knows. Sign-up is asked with screen_hint=signup.
      : q.prompt && q.prompt !== 'none' && q.prompt !== 'login' ? `Used unknown value '${q.prompt}' for prompt parameter.` : null;
    if (problem) return c.html(page(`<p class="err">${esc(problem)}</p>`), 400);
    // prompt=none: answer at once from the remembered sign-in, or say there is none (login_required).
    if (q.prompt === 'none') {
      const remembered = rememberedOf(c);
      if (remembered) return issue(c, { redirectUri: q.redirect_uri, state: q.state, nonce: q.nonce, challenge: q.code_challenge }, remembered);
      const to = new URL(q.redirect_uri);
      to.searchParams.set('error', 'login_required');
      to.searchParams.set('state', q.state);
      return c.redirect(to.toString(), 302);
    }
    const hidden = ['client_id', 'redirect_uri', 'state', 'nonce', 'code_challenge']
      .map(k => `<input type="hidden" name="${k}" value="${esc(q[k] ?? '')}">`).join('');
    const regions = DATA_REGIONS.map(r => `<option value="${r}"${r === 'in' ? ' selected' : ''}>${r}</option>`).join('');
    return c.html(page(`
      <h1>${q.screen_hint === 'signup' ? 'Create' : 'Sign in to'} your LotusPond account</h1>
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
  // then goes back to Health. Like LotusPond Accounts' Hydra, it goes back only with the ID token as id_token_hint,
  // refuses post_logout_redirect_uri or state without one, and accepts an expired one.
  app.get('/logout', c => {
    const q = c.req.query();
    const hinted = q.id_token_hint ? hintClient(q.id_token_hint) : null;
    if (q.id_token_hint && hinted !== clientId) return c.html(page('<p class="err">The id_token_hint is not an ID token this issuer gave this client.</p>'), 400);
    if (!q.id_token_hint && (q.post_logout_redirect_uri || q.state)) {
      return c.html(page('<p class="err">Logout failed because post_logout_redirect_uri or state is set but id_token_hint is missing.</p>'), 400);
    }
    if (!hinted && q.client_id !== clientId) return c.html(page('<p class="err">Unknown client_id.</p>'), 400);
    const back = q.post_logout_redirect_uri && /^https?:\/\//.test(q.post_logout_redirect_uri) ? q.post_logout_redirect_uri : null;
    deleteCookie(c, SIGNED_IN_COOKIE, { path: FAKE_ACCOUNTS_PATH });
    return c.html(page(`<h1>Signed out of your LotusPond account</h1>
      <p class="note">Stand-in for LotusPond Accounts, for development only.</p>
      ${back ? `<p><a href="${esc(back)}">Back to LotusPond Health</a></p>` : ''}
      ${everywhereForm()}`));
  });

  // Back-channel logout, as Accounts would send it when someone signs out everywhere or their account is closed:
  // a logout token naming the account, delivered to Health server to server.
  let deliver: ((token: string) => Promise<number>) | null = null;
  const everywhereForm = () => `<form method="post" action="${FAKE_ACCOUNTS_PATH}/logout-everywhere">
      <p class="note">Or sign an account out of LotusPond Health everywhere (back-channel logout):</p>
      <label>Email <input name="email" type="email" required></label>
      <button>Sign out everywhere</button></form>`;
  app.get('/logout-everywhere', c => c.html(page(`<h1>Sign out everywhere</h1>${everywhereForm()}`)));
  app.post('/logout-everywhere', async c => {
    const f = await c.req.parseBody() as Record<string, string>;
    const email = (f.email ?? '').trim().toLowerCase();
    if (!email.includes('@') || !deliver) return c.text('Bad request', 400);
    // With `sid` (tests): only that Accounts session, as when someone signs out of one browser.
    const ended = await deliver(logoutToken(f.sid ? { sub: fakeSubject(email), sid: f.sid } : { sub: fakeSubject(email) }));
    return c.html(page(`<h1>Signed out everywhere</h1><p>${ended} LotusPond Health ${ended === 1 ? 'session' : 'sessions'} ended for ${esc(email)}.</p>`));
  });

  app.post('/authorize', async c => {
    const f = await c.req.parseBody() as Record<string, string>;
    if (f.client_id !== clientId || !f.redirect_uri || !f.code_challenge || !f.state || !f.nonce) return c.text('Bad request', 400);
    const email = (f.email ?? '').trim().toLowerCase();
    if (!email.includes('@')) return c.text('An email address is needed.', 400);
    const claims: Record<string, unknown> = {
      sub: fakeSubject(email),
      // A new Accounts session for each sign-in, so a back-channel logout can name one.
      sid: `dev-sid-${randomBytes(9).toString('base64url')}`,
      email,
      email_verified: f.email_verified === 'true',
      ...(f.region ? { region: f.region } : {}),
      ...(f.enterprise === 'true' ? { org: 'dev-company' } : {}),
    };
    // Remember the sign-in in this browser, as Accounts would: a later prompt=none answers from it.
    setCookie(c, SIGNED_IN_COOKIE, Buffer.from(JSON.stringify(claims)).toString('base64url'), { httpOnly: true, sameSite: 'Lax', path: FAKE_ACCOUNTS_PATH });
    return issue(c, { redirectUri: f.redirect_uri, state: f.state, nonce: f.nonce, challenge: f.code_challenge }, claims);
  });

  function issue(c: Context, req: { redirectUri: string; state: string; nonce: string; challenge: string }, claims: Record<string, unknown>) {
    const code = randomBytes(24).toString('base64url');
    codes.set(code, { clientId, redirectUri: req.redirectUri, challenge: req.challenge, nonce: req.nonce, expiresAt: Date.now() + CODE_TTL_MS, claims });
    const to = new URL(req.redirectUri);
    to.searchParams.set('code', code);
    to.searchParams.set('state', req.state);
    return c.redirect(to.toString(), 302);
  }

  function rememberedOf(c: Context): Record<string, unknown> | null {
    const raw = getCookie(c, SIGNED_IN_COOKIE);
    if (!raw) return null;
    try { return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<string, unknown>; } catch { return null; }
  }

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
  function logoutToken(who: { sub?: string; sid?: string }, change: Record<string, unknown> = {}): string {
    return signJwt(privateKey, kid, {
      iss: FAKE_ACCOUNTS_ISSUER, aud: clientId, iat: Math.floor(Date.now() / 1000), jti: randomBytes(12).toString('base64url'),
      events: { 'http://schemas.openid.net/event/backchannel-logout': {} }, ...who, ...change,
    });
  }
  return { app, metadata, fetch: fetchImpl, logoutToken, onLogoutToken: d => { deliver = d; } };
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
