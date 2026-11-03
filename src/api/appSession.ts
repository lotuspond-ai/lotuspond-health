// Sign-in state for the iOS and Android apps. Their pages are served from capacitor://localhost (iOS) and
// https://localhost (Android), so every API call is cross-site and cookies are not sent. Instead the server
// hands the app a session token (X-LotusPond-Client: app on sign-in), sent as a bearer token on every request.
// The token is kept in the Keychain / Android Keystore (src/native/tokens.ts) with the server that issued it:
// with regional hosts an account lives on one of them (README, "Mobile apps (iOS and Android)").
//
// No platform imports here, so this is tested in Node (tools/test-parsers.mjs).

export interface StoredSession {
  token: string;
  /** API origin that issued the token, for example https://health.lotuspond.ai. */
  origin: string;
  /** ISO time the server gave for the token's expiry. */
  expiresAt?: string;
}

export interface TokenStore {
  load(): Promise<StoredSession | null>;
  save(session: StoredSession | null): Promise<void>;
}

export type Region = 'in' | 'eu' | 'us' | 'global';

/** Header the server uses to recognise the apps (token sign-in, CORS and the cross-site check). */
export const APP_CLIENT_HEADER = 'X-LotusPond-Client';

const trimOrigin = (o: string) => o.replace(/\/+$/, '');

export class AppSession {
  /** Origin requests go to: the one that issued the token, else the default. */
  origin: string;
  private token: string | null = null;
  private expiresAt: number | null = null;
  readonly ready: Promise<void>;
  private readonly defaultOrigin: string;
  private readonly store: TokenStore;
  private readonly now: () => number;

  constructor(defaultOrigin: string, store: TokenStore, now: () => number = Date.now) {
    this.defaultOrigin = trimOrigin(defaultOrigin);
    this.origin = this.defaultOrigin;
    this.store = store;
    this.now = now;
    this.ready = store.load().then(s => {
      if (!s?.token) return;
      const exp = s.expiresAt ? Date.parse(s.expiresAt) : NaN;
      if (Number.isFinite(exp) && exp <= this.now()) { void store.save(null).catch(() => {}); return; }
      this.token = s.token;
      this.expiresAt = Number.isFinite(exp) ? exp : null;
      this.origin = trimOrigin(s.origin || this.defaultOrigin);
    }).catch(() => { /* secure storage unavailable: start signed out */ });
  }

  /** True when a token is held and not known to have expired. */
  get signedIn(): boolean {
    return !!this.token && (this.expiresAt === null || this.expiresAt > this.now());
  }

  /** Headers for every API request from the app. */
  headers(): Record<string, string> {
    const h: Record<string, string> = { [APP_CLIENT_HEADER]: 'app' };
    if (this.signedIn) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  /** Keep the token the server returned on sign-in or sign-up. */
  async keep(token: string, expiresAt: string | undefined): Promise<void> {
    this.token = token;
    const exp = expiresAt ? Date.parse(expiresAt) : NaN;
    this.expiresAt = Number.isFinite(exp) ? exp : null;
    await this.store.save({ token, origin: this.origin, expiresAt });
  }

  /** Forget the token (signed out, session ended or account deleted); later calls go to the default origin. */
  async clear(): Promise<void> {
    this.token = null;
    this.expiresAt = null;
    this.origin = this.defaultOrigin;
    await this.store.save(null).catch(() => {});
  }

  /** Call this origin from now on, for example after a `wrong_region` answer. */
  useOrigin(origin: string): void {
    this.origin = trimOrigin(origin);
  }

  /** Origin to create an account on: the host for the country's data region when regions have their own hosts. */
  originForRegion(region: Region | null | undefined, apiOrigins: Partial<Record<Region, string>> | undefined): string {
    const listed = region ? apiOrigins?.[region] : undefined;
    return trimOrigin(listed || this.defaultOrigin);
  }
}
