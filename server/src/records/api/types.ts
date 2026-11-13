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
  /** New reports one check saves, at most: a source with more should return the oldest and resume next time. */
  maxReports: number;
  /** Whether a report with this key was already brought in on this connection (skip downloading it again). */
  alreadySaved(key: string): Promise<boolean>;
}

export interface ApiFetcher {
  sourceId: string;
  run(ctx: ApiContext): Promise<PortalReport[]>;
}

/** An API source the person signs in to on the provider's own page (OAuth 2), not by answering questions here. */
export interface OAuthFetcher extends ApiFetcher {
  /** The provider's sign-in page, carrying our one-time `state`. */
  authorizeUrl(state: string): string;
  /** The code the provider sent back (with the state it carried) → the sign-in to keep (sealed) and a webhook reference. */
  exchange(code: string, state: string): Promise<{ session: string; ref?: string }>;
  /**
   * The provider gives no refresh token (DigiLocker: an access token lasts an hour), so every check starts on its
   * sign-in page: connecting or Check now sends the person there, and no check is scheduled.
   */
  oneTime?: boolean;
}

export const isOAuth = (f: ApiFetcher): f is OAuthFetcher => typeof (f as OAuthFetcher).authorizeUrl === 'function';
