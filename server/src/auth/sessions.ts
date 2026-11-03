// Server-side sessions. The browser holds a random token in an HttpOnly cookie; the cell's database stores its SHA-256.
// Tokens start with the account's region ("in.", "eu.", …) so each request goes straight to the right cell without
// a directory lookup. Tokens without a prefix (issued before cells existed) are looked up in the default cell.
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, lt, ne } from 'drizzle-orm';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { DataRegion } from '../../../shared/regions.ts';
import type { Db } from '../db/client.ts';
import { sessions, users, type UserRow } from '../db/schema.ts';
import type { Cell, CellRegistry } from '../cells.ts';

export const SESSION_COOKIE = 'lp_session';
/** Extend a session's expiry at most once a day while it is in use. */
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;
const TOKEN = /^(?:(in|eu|us|global)\.)?([\w-]{20,100})$/;

const digest = (token: string) => createHash('sha256').update(token).digest('hex');

export interface ActiveSession { id: string; user: UserRow; cell: Cell }

export async function createSession(db: Db, region: DataRegion, userId: string, ttlMs: number, userAgent: string | undefined): Promise<{ token: string; expiresAt: Date }> {
  const token = `${region}.${randomBytes(32).toString('base64url')}`;
  const expiresAt = new Date(Date.now() + ttlMs);
  await db.insert(sessions).values({ id: digest(token), userId, expiresAt, userAgent: userAgent?.slice(0, 300) ?? null });
  return { token, expiresAt };
}

/** The cell a token belongs to, or null when the token is malformed or its region is not served here. */
export function cellForToken(cells: CellRegistry, token: string): { cell: Cell; region: DataRegion | null } | null {
  const m = TOKEN.exec(token);
  if (!m) return null;
  const region = (m[1] as DataRegion | undefined) ?? null;
  const cell = region ? cells.forRegion(region) : cells.defaultCell;
  return cell ? { cell, region } : null;
}

export async function findSession(cells: CellRegistry, token: string, ttlMs: number): Promise<ActiveSession | null> {
  const found = cellForToken(cells, token);
  if (!found) return null;
  const { cell: { db }, region } = found;
  const id = digest(token);
  const rows = await db.select({ session: sessions, user: users }).from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId)).where(eq(sessions.id, id)).limit(1);
  const row = rows[0];
  if (!row) return null;
  if (region && row.user.region !== region) return null;
  const now = Date.now();
  if (row.session.expiresAt.getTime() <= now) {
    await db.delete(sessions).where(eq(sessions.id, id));
    return null;
  }
  if (now - row.session.lastSeenAt.getTime() > REFRESH_AFTER_MS) {
    await db.update(sessions).set({ lastSeenAt: new Date(now), expiresAt: new Date(now + ttlMs) }).where(eq(sessions.id, id));
  }
  return { id, user: row.user, cell: found.cell };
}

export async function deleteSession(db: Db, id: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, id));
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
