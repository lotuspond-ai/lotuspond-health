// Hono context types and request helpers shared by the route modules.
import type { Context, MiddlewareHandler } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { z } from 'zod';
import type { Config } from './config.ts';
import type { Db } from './db/client.ts';
import type { ProfileRow, UserRow } from './db/schema.ts';
import type { FileStore } from './lib/files.ts';
import { badRequest, unauthorized } from './lib/errors.ts';
import { findSession, readSessionCookie } from './auth/sessions.ts';

export interface Deps {
  db: Db;
  files: FileStore;
  config: Config;
}

export interface AppEnv {
  Variables: {
    user: UserRow;
    sessionId: string;
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

/** Require a signed-in user; sets `user` and `sessionId`. */
export function requireAuth(deps: Deps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = readSessionCookie(c);
    const session = token ? await findSession(deps.db, token, deps.config.sessionTtlMs) : null;
    if (!session) throw unauthorized();
    c.set('user', session.user);
    c.set('sessionId', session.id);
    await next();
  };
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
