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
}
