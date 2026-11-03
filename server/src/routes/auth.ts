// Accounts: register, sign in/out, current session, password change, account deletion.
import { Hono } from 'hono';
import { asc, eq } from 'drizzle-orm';
import type { SessionInfo } from '../../../shared/types.ts';
import { profiles, users, type UserRow } from '../db/schema.ts';
import type { Db } from '../db/client.ts';
import { hashPassword, verifyAgainstDummy, verifyPassword } from '../auth/password.ts';
import {
  clearSessionCookie, createSession, deleteSessionByToken, deleteUserSessions, findSession, readSessionCookie, writeSessionCookie,
} from '../auth/sessions.ts';
import { conflict, HttpError, tooMany } from '../lib/errors.ts';
import { RateLimiter } from '../lib/rate-limit.ts';
import { clientIp, readJson, requireAuth, type AppEnv, type Ctx, type Deps } from '../http.ts';
import { ChangePasswordBody, DeleteAccountBody, LoginBody, RegisterBody } from '../schemas.ts';
import { toAccount, toProfile } from '../serialize.ts';
import { relationshipOrder } from './profiles.ts';

const MINUTE = 60_000;

export async function sessionInfo(db: Db, user: UserRow): Promise<SessionInfo> {
  const rows = await db.select().from(profiles).where(eq(profiles.userId, user.id)).orderBy(asc(profiles.createdAt));
  return { account: toAccount(user), profiles: rows.sort(relationshipOrder).map(toProfile) };
}

export function authRoutes(deps: Deps) {
  const { db, config, files } = deps;
  const app = new Hono<AppEnv>();
  const loginByIp = new RateLimiter(20, 15 * MINUTE);
  const loginByEmail = new RateLimiter(8, 15 * MINUTE);
  // Sign-ups per network per hour. Relaxed outside production so local testing does not lock itself out.
  const registerByIp = new RateLimiter(config.env === 'production' ? 10 : 500, 60 * MINUTE);
  const auth = requireAuth(deps);

  async function startSession(c: Ctx, user: UserRow) {
    const { token, expiresAt } = await createSession(db, user.id, config.sessionTtlMs, c.req.header('user-agent'));
    writeSessionCookie(c, token, expiresAt, config.cookieSecure);
  }

  app.post('/register', async c => {
    const wait = registerByIp.hit(clientIp(c, config.trustProxy));
    if (wait) throw tooMany(`Too many new accounts from this network. Try again in ${Math.ceil(wait / 60)} minutes.`);
    const body = await readJson(c, RegisterBody);
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, body.email)).limit(1);
    if (existing.length) throw conflict('An account with this email already exists. Sign in instead.', 'email_taken');
    const passwordHash = await hashPassword(body.password);
    const user = await db.transaction(async tx => {
      const [u] = await tx.insert(users).values({ email: body.email, passwordHash }).returning();
      await tx.insert(profiles).values({ userId: u.id, relationship: 'self', displayName: body.displayName });
      return u;
    }).catch((e: unknown) => {
      // Two sign-ups racing for the same email: the unique index rejects the second.
      if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === '23505') {
        throw conflict('An account with this email already exists. Sign in instead.', 'email_taken');
      }
      throw e;
    });
    await startSession(c, user);
    return c.json(await sessionInfo(db, user), 201);
  });

  app.post('/login', async c => {
    const body = await readJson(c, LoginBody);
    const ipWait = loginByIp.hit(clientIp(c, config.trustProxy));
    const emailWait = loginByEmail.hit(body.email);
    const wait = Math.max(ipWait, emailWait);
    if (wait) throw tooMany(`Too many sign-in attempts. Try again in ${Math.ceil(wait / 60)} minutes.`);
    const [user] = await db.select().from(users).where(eq(users.email, body.email)).limit(1);
    const ok = user ? await verifyPassword(user.passwordHash, body.password) : await verifyAgainstDummy(body.password);
    if (!user || !ok) throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect.');
    loginByEmail.reset(body.email);
    await startSession(c, user);
    return c.json(await sessionInfo(db, user));
  });

  app.post('/logout', async c => {
    const token = readSessionCookie(c);
    if (token) await deleteSessionByToken(db, token);
    clearSessionCookie(c, config.cookieSecure);
    return c.body(null, 204);
  });

  /** The current session, or null when signed out (a normal state for the app's first request, so not a 401). */
  app.get('/me', async c => {
    const token = readSessionCookie(c);
    const session = token ? await findSession(db, token, config.sessionTtlMs) : null;
    if (!session) {
      if (token) clearSessionCookie(c, config.cookieSecure);
      return c.json(null);
    }
    return c.json(await sessionInfo(db, session.user));
  });

  app.post('/password', auth, async c => {
    const body = await readJson(c, ChangePasswordBody);
    if (!(await verifyPassword(c.var.user.passwordHash, body.currentPassword))) {
      throw new HttpError(400, 'wrong_password', 'Your current password is incorrect.');
    }
    await db.update(users).set({ passwordHash: await hashPassword(body.newPassword), updatedAt: new Date() }).where(eq(users.id, c.var.user.id));
    await deleteUserSessions(db, c.var.user.id, c.var.sessionId);
    return c.body(null, 204);
  });

  /** Sign out every other browser and device. */
  app.delete('/sessions', auth, async c => {
    await deleteUserSessions(db, c.var.user.id, c.var.sessionId);
    return c.body(null, 204);
  });

  app.delete('/account', auth, async c => {
    const body = await readJson(c, DeleteAccountBody);
    if (!(await verifyPassword(c.var.user.passwordHash, body.password))) {
      throw new HttpError(400, 'wrong_password', 'Your password is incorrect.');
    }
    const owned = await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.userId, c.var.user.id));
    await db.delete(users).where(eq(users.id, c.var.user.id)); // cascades to sessions, profiles and records
    await Promise.all(owned.map(p => files.deletePrefix(p.id)));
    clearSessionCookie(c, config.cookieSecure);
    return c.body(null, 204);
  });

  return app;
}
