// Health as an OpenID Connect relying party of LotusPond Accounts (docs/identity.md): the authorization-code flow
// with PKCE (S256), a state and a nonce, and an ID token checked here (signature against the issuer's JWKS, issuer,
// audience, expiry, nonce). Only Node's crypto is used; RS256 and ES256 are accepted.
import { createHash, createPublicKey, randomBytes, verify, type JsonWebKey, type KeyObject } from 'node:crypto';
import type { DataRegion } from '../../../shared/regions.ts';
import { DATA_REGIONS } from '../config.ts';
import type { AccountsConfig } from '../config.ts';

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface IssuerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  /** OpenID Connect RP-Initiated Logout 1.0: where Health sends the browser to sign out of Accounts too. */
  end_session_endpoint?: string;
}

/**
 * What Health reads from an Accounts ID token. `region` and `org` are LotusPond claims, as LotusPond Accounts
 * publishes them (lotuspond-ai/lotuspond ADR-0001; docs/identity.md, "Claims").
 */
export interface AccountsIdentity {
  subject: string;
  email: string;
  emailVerified: boolean;
  /** The data region that holds the account, when Accounts says. */
  region: DataRegion | null;
  /** The organisation that manages the account (`org`), set only for a company-managed account. Health refuses those. */
  org: string | null;
  /** The Accounts session (`sid`), when Accounts sends one: a back-channel logout can name it. */
  sessionId?: string;
  /**
   * The ID token itself, kept with the session it starts: signing out of Accounts with a return to Health needs it
   * as `id_token_hint` (Hydra refuses `post_logout_redirect_uri` without one, and accepts an expired one).
   */
  idToken?: string;
}

export class OidcError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

const ALLOWED_ALGS = new Set(['RS256', 'ES256']);
/** Clock difference allowed between Accounts and this server. */
const SKEW_S = 60;
const METADATA_TTL_MS = 60 * 60 * 1000;
/** Logout tokens older than this are refused, which bounds how long their `jti` must be remembered. */
export const LOGOUT_TOKEN_MAX_AGE_S = 5 * 60;
export const BACKCHANNEL_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

const b64url = (b: Buffer) => b.toString('base64url');
export const randomToken = () => b64url(randomBytes(32));
export const pkceChallenge = (verifier: string) => b64url(createHash('sha256').update(verifier).digest());

export class AccountsClient {
  private metadataCache: { value: IssuerMetadata; at: number } | null = null;
  private keys = new Map<string, KeyObject>();

  constructor(
    private readonly config: AccountsConfig,
    private readonly fetchImpl: Fetch = fetch,
    /** The fake issuer passes its metadata directly; a real issuer is discovered. */
    private readonly fixedMetadata?: IssuerMetadata,
  ) {}

  async metadata(): Promise<IssuerMetadata> {
    if (this.fixedMetadata) return this.fixedMetadata;
    if (this.metadataCache && Date.now() - this.metadataCache.at < METADATA_TTL_MS) return this.metadataCache.value;
    const res = await this.fetchImpl(`${this.config.issuer}/.well-known/openid-configuration`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new OidcError('accounts_unavailable', `LotusPond Accounts did not answer (${res.status}).`);
    const m = await res.json() as Partial<IssuerMetadata>;
    if (m.issuer !== this.config.issuer || !m.authorization_endpoint || !m.token_endpoint || !m.jwks_uri) {
      throw new OidcError('accounts_unavailable', 'LotusPond Accounts published settings this server cannot use.');
    }
    this.metadataCache = { value: m as IssuerMetadata, at: Date.now() };
    return m as IssuerMetadata;
  }

  async authorizeUrl(p: { redirectUri: string; state: string; nonce: string; verifier: string; signUp?: boolean; silent?: boolean }): Promise<string> {
    const m = await this.metadata();
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: p.redirectUri,
      scope: 'openid email',
      state: p.state,
      nonce: p.nonce,
      code_challenge: pkceChallenge(p.verifier),
      code_challenge_method: 'S256',
    });
    // Ask Accounts to open on its sign-up page. Not prompt=create: Accounts' Hydra refuses that value and aborts the
    // sign-in. screen_hint=signup passes through to Accounts, which opens sign-up for it.
    if (p.signUp) q.set('screen_hint', 'signup');
    // prompt=none: only if the person is already signed in at Accounts; it answers login_required otherwise.
    else if (p.silent) q.set('prompt', 'none');
    return `${m.authorization_endpoint}?${q}`;
  }

  /**
   * Where to sign out of Accounts (RP-Initiated Logout), coming back to `postLogoutRedirectUri`, which must be
   * registered at Accounts. Null when Accounts publishes no end-session endpoint.
   *
   * Accounts returns to Health only with the session's ID token as `id_token_hint`: its Hydra refuses
   * `post_logout_redirect_uri` without one (and accepts an expired one). A session with no ID token kept (started
   * before Health kept them) signs out at Accounts and stays on Accounts' signed-out page.
   */
  async endSessionUrl(postLogoutRedirectUri: string, idTokenHint?: string | null): Promise<string | null> {
    const m = await this.metadata();
    if (!m.end_session_endpoint) return null;
    const q = idTokenHint
      ? new URLSearchParams({ id_token_hint: idTokenHint, post_logout_redirect_uri: postLogoutRedirectUri })
      : new URLSearchParams({ client_id: this.config.clientId });
    return `${m.end_session_endpoint}?${q}`;
  }

  /** Trade the code for tokens and return the checked identity. */
  async signIn(p: { code: string; verifier: string; redirectUri: string; nonce: string }): Promise<AccountsIdentity> {
    const m = await this.metadata();
    const body = new URLSearchParams({ grant_type: 'authorization_code', code: p.code, redirect_uri: p.redirectUri, code_verifier: p.verifier });
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    if (this.config.clientSecret) {
      headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(this.config.clientId)}:${encodeURIComponent(this.config.clientSecret)}`).toString('base64')}`;
    } else {
      body.set('client_id', this.config.clientId);
    }
    const res = await this.fetchImpl(m.token_endpoint, { method: 'POST', headers, body: body.toString() });
    const tokens = await res.json().catch(() => null) as { id_token?: unknown; error?: unknown } | null;
    if (!res.ok || typeof tokens?.id_token !== 'string') {
      throw new OidcError('sign_in_failed', `LotusPond Accounts refused the sign-in${typeof tokens?.error === 'string' ? ` (${tokens.error})` : ''}.`);
    }
    return { ...(await this.verifyIdToken(tokens.id_token, p.nonce)), idToken: tokens.id_token };
  }

  /** Check a JWT from Accounts: its signature against the published keys, its issuer and its audience. */
  private async verifySigned(token: string): Promise<Record<string, unknown>> {
    const m = await this.metadata();
    const parts = token.split('.');
    if (parts.length !== 3) throw new OidcError('invalid_token', 'The token is malformed.');
    const [h, p, sig] = parts;
    let header: { alg?: string; kid?: string; typ?: string };
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    } catch {
      throw new OidcError('invalid_token', 'The token is malformed.');
    }
    if (!header.alg || !ALLOWED_ALGS.has(header.alg)) throw new OidcError('invalid_token', 'The token uses an algorithm this server does not accept.');
    const key = await this.key(m, header.kid);
    const ok = verify('sha256', Buffer.from(`${h}.${p}`), header.alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key, Buffer.from(sig, 'base64url'));
    if (!ok) throw new OidcError('invalid_token', 'The token signature does not match.');
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== m.issuer) throw new OidcError('invalid_token', 'The token is from another issuer.');
    if (!audiences.includes(this.config.clientId)) throw new OidcError('invalid_token', 'The token is for another service.');
    if (audiences.length > 1 && claims.azp !== this.config.clientId) throw new OidcError('invalid_token', 'The token is for another service.');
    const now = Math.floor(Date.now() / 1000);
    if (claims.exp !== undefined && (typeof claims.exp !== 'number' || claims.exp < now - SKEW_S)) throw new OidcError('invalid_token', 'The token has expired.');
    if (typeof claims.iat === 'number' && claims.iat > now + SKEW_S) throw new OidcError('invalid_token', 'The token is dated in the future.');
    return claims;
  }

  async verifyIdToken(token: string, nonce: string): Promise<AccountsIdentity> {
    const claims = await this.verifySigned(token);
    if (typeof claims.exp !== 'number') throw new OidcError('invalid_token', 'The sign-in token has no expiry.');
    if (claims.nonce !== nonce) throw new OidcError('invalid_token', 'The sign-in token does not belong to this sign-in.');
    if (typeof claims.sub !== 'string' || !claims.sub) throw new OidcError('invalid_token', 'The sign-in token names no account.');
    if (typeof claims.email !== 'string' || !claims.email.includes('@')) throw new OidcError('invalid_token', 'LotusPond Accounts did not share an email address.');

    const region = typeof claims.region === 'string' && (DATA_REGIONS as readonly string[]).includes(claims.region) ? claims.region as DataRegion : null;
    const org = claims.org;
    return {
      subject: claims.sub,
      email: claims.email.trim().toLowerCase(),
      emailVerified: claims.email_verified === true,
      region,
      org: typeof org === 'string' && org ? org : null,
      ...(typeof claims.sid === 'string' && claims.sid ? { sessionId: claims.sid } : {}),
    };
  }

  /**
   * Check a logout token (OpenID Connect Back-Channel Logout 1.0, section 2.6): signed by Accounts for this client,
   * recent, with the back-channel logout event, naming the account (`sub`), the Accounts session (`sid`) or both,
   * with a `jti`, and without a nonce. Replays are refused by the caller, by `jti`.
   */
  async verifyLogoutToken(token: string): Promise<{ subject: string | null; sessionId: string | null; jti: string; iat: number }> {
    const claims = await this.verifySigned(token);
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.iat !== 'number' || claims.iat < now - LOGOUT_TOKEN_MAX_AGE_S) throw new OidcError('invalid_token', 'The logout token is too old.');
    const events = claims.events as Record<string, unknown> | undefined;
    if (!events || typeof events !== 'object' || typeof events[BACKCHANNEL_EVENT] !== 'object') throw new OidcError('invalid_token', 'The logout token has no back-channel logout event.');
    if ('nonce' in claims) throw new OidcError('invalid_token', 'A logout token must not carry a nonce.');
    if (typeof claims.jti !== 'string' || !claims.jti) throw new OidcError('invalid_token', 'The logout token has no jti.');
    const subject = typeof claims.sub === 'string' && claims.sub ? claims.sub : null;
    const sessionId = typeof claims.sid === 'string' && claims.sid ? claims.sid : null;
    if (!subject && !sessionId) throw new OidcError('invalid_token', 'The logout token names neither an account nor a session.');
    return { subject, sessionId, jti: claims.jti, iat: claims.iat };
  }

  /** The signing key named by `kid`, fetching the JWKS again once when it is not known (key rotation). */
  private async key(m: IssuerMetadata, kid: string | undefined): Promise<KeyObject> {
    const pick = () => kid ? this.keys.get(kid) : this.keys.size === 1 ? [...this.keys.values()][0] : undefined;
    let key = pick();
    if (!key) {
      const res = await this.fetchImpl(m.jwks_uri, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new OidcError('accounts_unavailable', `LotusPond Accounts did not share its signing keys (${res.status}).`);
      const { keys = [] } = await res.json() as { keys?: (JsonWebKey & { kid?: string; use?: string })[] };
      this.keys.clear();
      for (const jwk of keys) {
        if (jwk.use && jwk.use !== 'sig') continue;
        try { this.keys.set(jwk.kid ?? '', createPublicKey({ key: jwk, format: 'jwk' })); } catch { /* a key type this server cannot use */ }
      }
      key = pick();
    }
    if (!key) throw new OidcError('invalid_token', 'The sign-in token is signed with a key LotusPond Accounts does not publish.');
    return key;
  }
}
