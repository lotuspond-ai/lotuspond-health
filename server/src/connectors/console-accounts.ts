// Organisation accounts for the developer console: sign-up, sign-in and sessions. They work like LotusPond Works'
// accounts (a person's account, with organisations as workspaces it is a member of) and are kept apart from personal
// LotusPond Health accounts: a different table in the default database, a different cookie sent only to
// /api/console, and no health consent or family profile. A personal Health session never opens the console, and a
// console session never opens anyone's records.
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Db } from '../db/client.ts';
import { organisationAccounts, organisationSessions } from '../db/schema.ts';
import { ORG_SESSION_COOKIE } from '../auth/sessions.ts';

export type OrganisationAccountRow = typeof organisationAccounts.$inferSelect;

const COOKIE_PATH = '/api/console';
/** Console sessions last 12 hours from sign-in, extended while in use, for at most 7 days without signing in again. */
export const CONSOLE_SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const REFRESH_AFTER_MS = 60 * 60 * 1000;
const TOKEN = /^lpo\.[\w-]{43}$/;
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

export async function createConsoleSession(db: Db, accountId: string, userAgent: string | undefined): Promise<{ token: string; expiresAt: Date }> {
  const token = `lpo.${randomBytes(32).toString('base64url')}`;
  const expiresAt = new Date(Date.now() + CONSOLE_SESSION_MS);
  await db.insert(organisationSessions).values({ id: digest(token), accountId, expiresAt, userAgent: userAgent?.slice(0, 300) ?? null });
  return { token, expiresAt };
}

export async function findConsoleSession(db: Db, token: string): Promise<{ id: string; account: OrganisationAccountRow } | null> {
  if (!TOKEN.test(token)) return null;
  const id = digest(token);
  const [row] = await db.select({ session: organisationSessions, account: organisationAccounts }).from(organisationSessions)
    .innerJoin(organisationAccounts, eq(organisationAccounts.id, organisationSessions.accountId)).where(eq(organisationSessions.id, id)).limit(1);
  if (!row) return null;
  const now = Date.now();
  if (row.session.expiresAt.getTime() <= now || now - row.session.createdAt.getTime() > MAX_AGE_MS) {
    await db.delete(organisationSessions).where(eq(organisationSessions.id, id));
    return null;
  }
  if (now - row.session.lastSeenAt.getTime() > REFRESH_AFTER_MS) {
    await db.update(organisationSessions).set({ lastSeenAt: new Date(now), expiresAt: new Date(now + CONSOLE_SESSION_MS) }).where(eq(organisationSessions.id, id));
  }
  return { id, account: row.account };
}

export async function deleteConsoleSession(db: Db, id: string): Promise<void> {
  await db.delete(organisationSessions).where(eq(organisationSessions.id, id));
}

export async function purgeExpiredConsoleSessions(db: Db, accountId?: string): Promise<void> {
  const expired = lt(organisationSessions.expiresAt, new Date());
  await db.delete(organisationSessions).where(accountId ? and(eq(organisationSessions.accountId, accountId), expired) : expired);
}

export const readConsoleToken = (c: Context) => getCookie(c, ORG_SESSION_COOKIE);

export function writeConsoleCookie(c: Context, token: string, expiresAt: Date, secure: boolean): void {
  setCookie(c, ORG_SESSION_COOKIE, token, { httpOnly: true, sameSite: 'Lax', secure, path: COOKIE_PATH, expires: expiresAt });
}

export function clearConsoleCookie(c: Context, secure: boolean): void {
  deleteCookie(c, ORG_SESSION_COOKIE, { path: COOKIE_PATH, secure });
}
