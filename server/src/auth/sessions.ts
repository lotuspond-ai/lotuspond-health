// Server-side sessions. The browser holds a random token in an HttpOnly cookie; the database stores its SHA-256.
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, lt, ne } from 'drizzle-orm';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Db } from '../db/client.ts';
import { sessions, users, type UserRow } from '../db/schema.ts';

export const SESSION_COOKIE = 'lp_session';
/** Extend a session's expiry at most once a day while it is in use. */
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

const digest = (token: string) => createHash('sha256').update(token).digest('hex');

export interface ActiveSession { id: string; user: UserRow }

export async function createSession(db: Db, userId: string, ttlMs: number, userAgent: string | undefined): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlMs);
  await db.insert(sessions).values({ id: digest(token), userId, expiresAt, userAgent: userAgent?.slice(0, 300) ?? null });
  return { token, expiresAt };
}

export async function findSession(db: Db, token: string, ttlMs: number): Promise<ActiveSession | null> {
  if (!/^[\w-]{20,100}$/.test(token)) return null;
  const id = digest(token);
  const rows = await db.select({ session: sessions, user: users }).from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId)).where(eq(sessions.id, id)).limit(1);
  const row = rows[0];
  if (!row) return null;
  const now = Date.now();
  if (row.session.expiresAt.getTime() <= now) {
    await db.delete(sessions).where(eq(sessions.id, id));
    return null;
  }
  if (now - row.session.lastSeenAt.getTime() > REFRESH_AFTER_MS) {
    await db.update(sessions).set({ lastSeenAt: new Date(now), expiresAt: new Date(now + ttlMs) }).where(eq(sessions.id, id));
  }
  return { id, user: row.user };
}

export async function deleteSessionByToken(db: Db, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, digest(token)));
}

/** Sign out every session of a user, optionally keeping the current one. */
export async function deleteUserSessions(db: Db, userId: string, keepId?: string): Promise<void> {
  await db.delete(sessions).where(keepId ? and(eq(sessions.userId, userId), ne(sessions.id, keepId)) : eq(sessions.userId, userId));
}

export async function purgeExpiredSessions(db: Db): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
}

export function readSessionCookie(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE);
}

export function writeSessionCookie(c: Context, token: string, expiresAt: Date, secure: boolean): void {
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: 'Lax', secure, path: '/', expires: expiresAt });
}

export function clearSessionCookie(c: Context, secure: boolean): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure });
}
