// A hospital system adapter: how one connector runs the organisation operations. An adapter is given the
// connection's settings and its unsealed credentials for one call and returns FHIR R4 resources. It never sees which
// organisation or key is calling; the API layer checks that before it is reached.
import type { OperationInput, RunnableOperation } from './operations.ts';

/** Credentials for one connection, unsealed for the length of a call. */
export interface HisSecret {
  /** Sent as `Authorization: Bearer`. */
  token?: string;
  /** Sent as HTTP Basic. */
  username?: string;
  password?: string;
  /** An API client's credentials, exchanged for an access token (Eka Care). */
  clientId?: string;
  clientSecret?: string;
  /** A key a clinic gives so the client can reach its own workspace (Eka Care). */
  sharingKey?: string;
  /**
   * The web app's sign-in for the computer-use agent (tasks.run), as Playwright storage state: cookies and local
   * storage saved after someone at the clinic signed in once (org:web-signin), never a password.
   */
  webSession?: { cookies: unknown[]; origins: unknown[] };
}

/** Where the computer-use agent works for tasks.run: the system's own web app. */
export interface AgentTarget {
  /** Shown to the model, e.g. "Eka Care EMR". */
  name: string;
  startUrl: string;
  /** Hosts its browser may reach (subdomains included); everything else is blocked. */
  allowHosts: string[];
  /** The web app needs a saved sign-in (HisSecret.webSession); the sandbox does not. */
  needsSignIn: boolean;
  /** What the model should know about this app, in a sentence or two. */
  notes: string;
}

export interface HisContext {
  /** The connection's id: the sandbox keeps each connection's uploads apart with it. */
  connectionId: string;
  /** Non-secret settings of the connection (base address, facility). */
  settings: Record<string, string>;
  secret: HisSecret | null;
  fetch: typeof fetch;
  now: Date;
}

/** A failure the caller can act on: the message is safe to show (no patient data, no credentials). */
export class HisError extends Error {
  constructor(public status: 400 | 404 | 409 | 422 | 502 | 504, public code: string, message: string) {
    super(message);
  }
}

export interface HisAdapter {
  connectorId: string;
  operations: RunnableOperation[];
  /** Settings a connection must have (checked when LotusPond adds one). */
  requiredSettings: string[];
  run<O extends RunnableOperation>(op: O, input: OperationInput<O>, ctx: HisContext): Promise<unknown>;
  /** For adapters that offer tasks.run: where the agent works. `selfUrl` is this server's own address (the sandbox). */
  agentTarget?(c: { connectionId: string; settings: Record<string, string>; selfUrl: string }): AgentTarget;
}
