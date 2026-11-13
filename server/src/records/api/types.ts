// Sources the record agent reaches through an API instead of a browser (ABHA through Eka Care, Withings, ...).
import type { SourceInfo } from '../../../../shared/sources.ts';
import type { Ask, PortalReport } from '../recipes/types.ts';

export interface ApiContext {
  source: SourceInfo;
  /** What the person signed in with last time (an ABHA address), if any. */
  identifier: string | null;
  /** The sign-in kept from the last run (JSON), if any. */
  session: string | null;
  ask(q: Ask): Promise<string>;
  remember(identifier: string): void;
  /** Keep this sign-in, even if the run fails later; `ref` lets webhooks about the person find the connection. */
  keep(session: string, ref?: string): void;
  /**
   * Keep this sign-in with how far the check read (a day cursor), but only once the reports it returns are saved: a
   * run that fails to save them reads the same days again next time. Credentials refreshed earlier still go to keep().
   */
  progress(session: string, ref?: string): void;
  step(text: string): Promise<void>;
  /** A line for the person about how the run ended ("Approve the request in your ABHA app"). */
  note(text: string): void;
  signal: AbortSignal;
  maxBytes: number;
}

export interface ApiFetcher {
  sourceId: string;
  run(ctx: ApiContext): Promise<PortalReport[]>;
}

/** An API source the person signs in to on the provider's own page (OAuth 2), not by answering questions here. */
export interface OAuthFetcher extends ApiFetcher {
  /** The provider's sign-in page, carrying our one-time `state`. */
  authorizeUrl(state: string): string;
  /** The code the provider sent back → the sign-in to keep (sealed) and a reference for webhooks. */
  exchange(code: string): Promise<{ session: string; ref?: string }>;
}

export const isOAuth = (f: ApiFetcher): f is OAuthFetcher => typeof (f as OAuthFetcher).authorizeUrl === 'function';
