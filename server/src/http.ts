// Hono context types and request helpers shared by the route modules.
import type { Context, MiddlewareHandler } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { z } from 'zod';
import type { Config } from './config.ts';
import type { Db } from './db/client.ts';
import type { ProfileRow, UserRow } from './db/schema.ts';
import type { FileStore } from './lib/files.ts';
import { badRequest, unauthorized } from './lib/errors.ts';
import { findSession, readSessionToken } from './auth/sessions.ts';
import type { Cell, CellRegistry } from './cells.ts';
import type { Secrets } from './compliance/secrets.ts';
import type { Labs } from './lab/runtime.ts';

export interface Deps {
  /** The default database: non-personal data (directory, partner labs, facility cache). Personal data is in `cells`. */
  db: Db;
  /** The default cell's file store. Routes use the request's cell (`c.var.cell.files`). */
  files: FileStore;
  config: Config;
  /** Where each region's accounts and records are kept. */
  cells: CellRegistry;
  secrets: Secrets;
  /** Lab booking, when LAB_PARTNERS switches any partner on (lab/runtime.ts). */
  labs?: Labs;
}

export interface AppEnv {
  Variables: {
    user: UserRow;
    sessionId: string;
    /** The signed-in account's cell. Every query for personal data uses `c.var.cell.db` and `c.var.cell.files`. */
    cell: Cell;
    profile: ProfileRow;
  };
}

export type Ctx = Context<AppEnv>;

/** Parse and validate a JSON body; validation problems become a 400 naming the field. */
export async function readJson<S extends z.ZodType>(c: Ctx, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest('Send the request body as JSON.');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.filter(p => typeof p === 'string').at(-1);
    throw badRequest(issue ? `${field ? `${String(field)}: ` : ''}${issue.message}` : 'The request was not valid.', 'invalid');
  }
  return parsed.data;
}

/** Client address for rate limiting. */
export function clientIp(c: Ctx, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (fwd) return fwd;
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Require a signed-in user (session cookie or `Authorization: Bearer`); sets `user`, `sessionId` and the account's `cell`. */
export function requireAuth(deps: Deps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const presented = readSessionToken(c);
    const session = presented ? await findSession(deps.cells, presented.token, deps.config.sessionTtlMs) : null;
    if (!session) throw unauthorized();
    c.set('user', session.user);
    c.set('sessionId', session.id);
    c.set('cell', session.cell);
    await next();
  };
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
