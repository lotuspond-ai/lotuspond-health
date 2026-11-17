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
 * What Health reads from an Accounts ID token. `region` and `enterprise_connection` are LotusPond claims; their names
 * are this side's proposal until LotusPond Accounts publishes its own (docs/identity.md, "Claims").
 */
export interface AccountsIdentity {
  subject: string;
  email: string;
  emailVerified: boolean;
  /** The data region that holds the account, when Accounts says. */
  region: DataRegion | null;
  /** Set when the account was created through a company's single sign-on. Health refuses such accounts. */
  enterpriseConnection: string | null;
}

export class OidcError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

const ALLOWED_ALGS = new Set(['RS256', 'ES256']);
/** Clock difference allowed between Accounts and this server. */
const SKEW_S = 60;
const METADATA_TTL_MS = 60 * 60 * 1000;

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

  async authorizeUrl(p: { redirectUri: string; state: string; nonce: string; verifier: string; signUp?: boolean }): Promise<string> {
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
    // OpenID Connect's prompt=create asks the issuer to open on its sign-up page.
    if (p.signUp) q.set('prompt', 'create');
    return `${m.authorization_endpoint}?${q}`;
  }

  /**
   * Where to sign out of Accounts (RP-Initiated Logout), coming back to `postLogoutRedirectUri`, which must be
   * registered at Accounts. Null when Accounts publishes no end-session endpoint. Without an ID token hint, Accounts
   * may ask the person to confirm.
   */
  async endSessionUrl(postLogoutRedirectUri: string): Promise<string | null> {
    const m = await this.metadata();
    if (!m.end_session_endpoint) return null;
    const q = new URLSearchParams({ client_id: this.config.clientId, post_logout_redirect_uri: postLogoutRedirectUri });
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
    return this.verifyIdToken(tokens.id_token, p.nonce);
  }

  async verifyIdToken(token: string, nonce: string): Promise<AccountsIdentity> {
    const m = await this.metadata();
    const parts = token.split('.');
    if (parts.length !== 3) throw new OidcError('invalid_token', 'The sign-in token is malformed.');
    const [h, p, sig] = parts;
    let header: { alg?: string; kid?: string };
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    } catch {
      throw new OidcError('invalid_token', 'The sign-in token is malformed.');
    }
    if (!header.alg || !ALLOWED_ALGS.has(header.alg)) throw new OidcError('invalid_token', 'The sign-in token uses an algorithm this server does not accept.');
    const key = await this.key(m, header.kid);
    const ok = verify(
      'sha256',
      Buffer.from(`${h}.${p}`),
      header.alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key,
      Buffer.from(sig, 'base64url'),
    );
    if (!ok) throw new OidcError('invalid_token', 'The sign-in token signature does not match.');

    const now = Math.floor(Date.now() / 1000);
    const aud = claims.aud;
    const audiences = Array.isArray(aud) ? aud : [aud];
    if (claims.iss !== m.issuer) throw new OidcError('invalid_token', 'The sign-in token is from another issuer.');
    if (!audiences.includes(this.config.clientId)) throw new OidcError('invalid_token', 'The sign-in token is for another service.');
    if (audiences.length > 1 && claims.azp !== this.config.clientId) throw new OidcError('invalid_token', 'The sign-in token is for another service.');
    if (typeof claims.exp !== 'number' || claims.exp < now - SKEW_S) throw new OidcError('invalid_token', 'The sign-in token has expired.');
    if (typeof claims.iat === 'number' && claims.iat > now + SKEW_S) throw new OidcError('invalid_token', 'The sign-in token is dated in the future.');
    if (claims.nonce !== nonce) throw new OidcError('invalid_token', 'The sign-in token does not belong to this sign-in.');
    if (typeof claims.sub !== 'string' || !claims.sub) throw new OidcError('invalid_token', 'The sign-in token names no account.');
    if (typeof claims.email !== 'string' || !claims.email.includes('@')) throw new OidcError('invalid_token', 'LotusPond Accounts did not share an email address.');

    const region = typeof claims.region === 'string' && (DATA_REGIONS as readonly string[]).includes(claims.region) ? claims.region as DataRegion : null;
    const enterprise = claims.enterprise_connection;
    return {
      subject: claims.sub,
      email: claims.email.trim().toLowerCase(),
      emailVerified: claims.email_verified === true,
      region,
      enterpriseConnection: typeof enterprise === 'string' && enterprise ? enterprise : null,
    };
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
