// Accounts: register, sign in/out, current session, password change, account deletion, and the compliance
// endpoints (service info, unit preference, consents, recent activity).
// Personal data is read and written in the account's cell; the directory (default database) says which cell that is.
import { Hono } from 'hono';
import { asc, eq } from 'drizzle-orm';
import { CONSENT_VERSION, countryPolicy, REGIONS, signUpProblem } from '../../../shared/regions.ts';
import type { ServiceInfo, SessionInfo } from '../../../shared/types.ts';
import { profiles, users, type UserRow } from '../db/schema.ts';
import type { Db } from '../db/client.ts';
import type { Cell } from '../cells.ts';
import { hashPassword, verifyAgainstDummy, verifyPassword } from '../auth/password.ts';
import {
  clearSessionCookie, createSession, deleteSession, deleteUserSessions, findSession, readSessionToken, wantsTokenSession, writeSessionCookie,
} from '../auth/sessions.ts';
import { eventContext, eraseHistory, recentActivity, recordEvent } from '../compliance/audit.ts';
import { currentConsents, listConsents, outdatedConsents, recordConsents, REQUIRED_CONSENTS } from '../compliance/consents.ts';
import { claim, locate, release } from '../compliance/directory.ts';
import { badRequest, conflict, HttpError, tooMany } from '../lib/errors.ts';
import { RateLimiter } from '../lib/rate-limit.ts';
import { clientIp, readJson, requireAuth, type AppEnv, type Ctx, type Deps } from '../http.ts';
import { ChangePasswordBody, ConsentPatchBody, DeleteAccountBody, LoginBody, PreferencesBody, RegisterBody } from '../schemas.ts';
import { toAccount, toProfile } from '../serialize.ts';
import { relationshipOrder } from './profiles.ts';

const MINUTE = 60_000;
const EMAIL_TAKEN = 'An account with this email already exists. Sign in instead.';

export async function sessionInfo(db: Db, user: UserRow): Promise<SessionInfo> {
  const [rows, consents] = await Promise.all([
    db.select().from(profiles).where(eq(profiles.userId, user.id)).orderBy(asc(profiles.createdAt)),
    listConsents(db, user.id),
  ]);
  return { account: toAccount(user), profiles: rows.sort(relationshipOrder).map(toProfile), consentsOutdated: outdatedConsents(consents) };
}

const isUniqueViolation = (e: unknown) => !!e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === '23505';

export function authRoutes(deps: Deps) {
  const { config, cells } = deps;
  const app = new Hono<AppEnv>();
  const loginByIp = new RateLimiter(20, 15 * MINUTE);
  const loginByEmail = new RateLimiter(8, 15 * MINUTE);
  // Sign-ups per network per hour. Relaxed outside production so local testing does not lock itself out.
  const registerByIp = new RateLimiter(config.env === 'production' ? 10 : 500, 60 * MINUTE);
  const auth = requireAuth(deps);

  /**
   * Start a session. Browsers get an HttpOnly cookie. Apps (X-LotusPond-Client: app) get the token in the response
   * instead, to send as `Authorization: Bearer`; it is stored and expires exactly like a cookie session.
   */
  async function startSession(c: Ctx, cell: Cell, user: UserRow): Promise<{ token: string; expiresAt: string } | null> {
    const { token, expiresAt } = await createSession(cell.db, user.region, user.id, config.sessionTtlMs, c.req.header('user-agent'));
    if (wantsTokenSession(c)) return { token, expiresAt: expiresAt.toISOString() };
    writeSessionCookie(c, token, expiresAt, config.cookieSecure);
    return null;
  }

  /** Public facts for sign-up and the Account page. */
  app.get('/config', c => c.json<ServiceInfo>({
    servedRegions: cells.servedRegions,
    consentVersion: CONSENT_VERSION,
    contacts: { grievance: config.grievanceContact ?? null, dpo: config.dpoContact ?? null },
    apiOrigins: config.regionApiOrigins,
  }));

  app.post('/register', async c => {
    const wait = registerByIp.hit(clientIp(c, config.trustProxy));
    if (wait) throw tooMany(`Too many new accounts from this network. Try again in ${Math.ceil(wait / 60)} minutes.`);
    const body = await readJson(c, RegisterBody);
    const problem = signUpProblem(body, cells.servedRegions);
    if (problem) {
      const refused = problem.code === 'country_unavailable' || problem.code === 'region_not_served';
      throw new HttpError(refused ? 403 : 400, problem.code, problem.message);
    }
    const policy = countryPolicy(body.country);
    const cell = cells.forRegion(policy.region)!;
    if (await locate(deps, body.email)) throw conflict(EMAIL_TAKEN, 'email_taken');

    const passwordHash = await hashPassword(body.password);
    const userId = crypto.randomUUID();
    // Reserve the email in the directory first: its key is unique across every cell.
    if (!(await claim(deps, body.email, policy.region, userId))) throw conflict(EMAIL_TAKEN, 'email_taken');
    let user: UserRow;
    try {
      user = await cell.db.transaction(async tx => {
        const [u] = await tx.insert(users).values({
          id: userId, email: body.email, passwordHash, country: policy.code, region: policy.region, unitSystem: policy.units, ageConfirmedAt: new Date(),
        }).returning();
        await tx.insert(profiles).values({ userId: u.id, relationship: 'self', displayName: body.displayName });
        await recordConsents(tx as unknown as Db, u.id, policy.code, [
          { kind: 'terms', granted: true },
          { kind: 'privacy', granted: true },
          { kind: 'health_data', granted: true },
          ...(policy.crossBorder ? [{ kind: 'cross_border' as const, granted: true }] : []),
          { kind: 'marketing', granted: body.consents.marketing },
        ]);
        return u;
      });
    } catch (e) {
      await release(deps, userId).catch(() => {});
      // An account from before the directory, or two sign-ups racing in one cell: the unique index rejects it.
      if (isUniqueViolation(e)) throw conflict(EMAIL_TAKEN, 'email_taken');
      throw e;
    }
    await recordEvent(cell.db, eventContext(c, deps), user.id, 'account_created');
    const appSession = await startSession(c, cell, user);
    return c.json({ ...(await sessionInfo(cell.db, user)), ...appSession }, 201);
  });

  app.post('/login', async c => {
    const body = await readJson(c, LoginBody);
    const ipWait = loginByIp.hit(clientIp(c, config.trustProxy));
    const emailWait = loginByEmail.hit(body.email);
    const wait = Math.max(ipWait, emailWait);
    if (wait) throw tooMany(`Too many sign-in attempts. Try again in ${Math.ceil(wait / 60)} minutes.`);
    const found = await locate(deps, body.email);
    if (found && !found.cell) {
      throw new HttpError(403, 'wrong_region', `This account's records are kept on ${REGIONS[found.region].storage}, and this server does not hold them. Sign in through LotusPond Health for that region.`,
        { region: found.region, apiOrigin: config.regionApiOrigins[found.region] ?? null });
    }
    const ok = found ? await verifyPassword(found.user.passwordHash, body.password) : await verifyAgainstDummy(body.password);
    if (!found || !ok) {
      if (found) await recordEvent(found.cell.db, eventContext(c, deps), found.user.id, 'sign_in_failed');
      throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect.');
    }
    loginByEmail.reset(body.email);
    await recordEvent(found.cell.db, eventContext(c, deps), found.user.id, 'sign_in');
    const appSession = await startSession(c, found.cell, found.user);
    return c.json({ ...(await sessionInfo(found.cell.db, found.user)), ...appSession });
  });

  app.post('/logout', async c => {
    const presented = readSessionToken(c);
    const session = presented ? await findSession(cells, presented.token, config.sessionTtlMs) : null;
    if (session) {
      await deleteSession(session.cell.db, session.id);
      await recordEvent(session.cell.db, eventContext(c, deps), session.user.id, 'sign_out');
    }
    clearSessionCookie(c, config.cookieSecure);
    return c.body(null, 204);
  });

  /** The current session, or null when signed out (a normal state for the app's first request, so not a 401). */
  app.get('/me', async c => {
    const presented = readSessionToken(c);
    const session = presented ? await findSession(cells, presented.token, config.sessionTtlMs) : null;
    if (!session) {
      if (presented?.via === 'cookie') clearSessionCookie(c, config.cookieSecure);
      return c.json(null);
    }
    return c.json(await sessionInfo(session.cell.db, session.user));
  });

  app.post('/password', auth, async c => {
    const { db } = c.var.cell;
    const body = await readJson(c, ChangePasswordBody);
    if (!(await verifyPassword(c.var.user.passwordHash, body.currentPassword))) {
      throw new HttpError(400, 'wrong_password', 'Your current password is incorrect.');
    }
    await db.update(users).set({ passwordHash: await hashPassword(body.newPassword), updatedAt: new Date() }).where(eq(users.id, c.var.user.id));
    await deleteUserSessions(db, c.var.user.id, c.var.sessionId);
    await recordEvent(db, eventContext(c, deps), c.var.user.id, 'password_changed');
    return c.body(null, 204);
  });

  /** Sign out every other browser and device. */
  app.delete('/sessions', auth, async c => {
    await deleteUserSessions(c.var.cell.db, c.var.user.id, c.var.sessionId);
    await recordEvent(c.var.cell.db, eventContext(c, deps), c.var.user.id, 'sessions_revoked');
    return c.body(null, 204);
  });

  app.delete('/account', auth, async c => {
    const { db, files } = c.var.cell;
    const user = c.var.user;
    const body = await readJson(c, DeleteAccountBody);
    if (!(await verifyPassword(user.passwordHash, body.password))) {
      throw new HttpError(400, 'wrong_password', 'Your password is incorrect.');
    }
    const owned = await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.userId, user.id));
    await db.delete(users).where(eq(users.id, user.id)); // cascades to sessions, profiles, records and consents
    await release(deps, user.id);
    await Promise.all(owned.map(p => files.deletePrefix(p.id)));
    await eraseHistory(db, user.id);
    clearSessionCookie(c, config.cookieSecure);
    return c.body(null, 204);
  });

  /* ---------- preferences, consents, activity ---------- */

  app.patch('/preferences', auth, async c => {
    const { db } = c.var.cell;
    const body = await readJson(c, PreferencesBody);
    const [row] = await db.update(users).set({ unitSystem: body.unitSystem, updatedAt: new Date() }).where(eq(users.id, c.var.user.id)).returning();
    if (body.unitSystem !== c.var.user.unitSystem) {
      await recordEvent(db, eventContext(c, deps), row.id, 'preferences_changed', { unitSystem: body.unitSystem });
    }
    return c.json(toAccount(row));
  });

  app.get('/consents', auth, async c => c.json(await listConsents(c.var.cell.db, c.var.user.id)));

  /** Grant or withdraw a consent. Required consents can be given again (for a new version) but not withdrawn. */
  app.patch('/consents', auth, async c => {
    const { db } = c.var.cell;
    const user = c.var.user;
    const body = await readJson(c, ConsentPatchBody);
    if (body.kind === 'cross_border' && !(user.country && countryPolicy(user.country).crossBorder)) {
      throw badRequest('Your records are stored in your own region, so this consent does not apply to your account.');
    }
    if (!body.granted && REQUIRED_CONSENTS.includes(body.kind)) {
      throw conflict(
        'LotusPond cannot keep your records without this consent. To withdraw it, delete your account. That removes every profile, result and file on it.',
        'withdraw_requires_deletion',
      );
    }
    const current = currentConsents(await listConsents(db, user.id))[body.kind];
    if (!current || current.granted !== body.granted || current.version !== CONSENT_VERSION) {
      await recordConsents(db, user.id, user.country, [{ kind: body.kind, granted: body.granted }]);
      await recordEvent(db, eventContext(c, deps), user.id, 'consent_changed', { consent: body.kind, granted: body.granted });
    }
    return c.json(await listConsents(db, user.id));
  });

  app.get('/activity', auth, async c => c.json(await recentActivity(c.var.cell.db, c.var.user.id)));

  return app;
}
