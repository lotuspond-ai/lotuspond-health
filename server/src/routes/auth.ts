// Accounts: sign-out, current session, account deletion, and the compliance endpoints (service info, unit
// preference, consents, recent activity). People sign up and sign in with LotusPond Accounts (routes/accounts.ts):
// Health's own passwords were removed in M9 (docs/identity.md). The old password routes answer `use_accounts`, so an
// app from before Accounts tells its person to update instead of failing.
// Personal data is read and written in the account's cell; the session token names it.
import { Hono } from 'hono';
import { asc, eq } from 'drizzle-orm';
import { CONSENT_VERSION, countryPolicy } from '../../../shared/regions.ts';
import type { ServiceInfo, SessionInfo } from '../../../shared/types.ts';
import { profiles, sessions, users, type UserRow } from '../db/schema.ts';
import type { Db } from '../db/client.ts';
import type { Cell } from '../cells.ts';
import {
  clearSessionCookie, deleteSession, deleteUserSessions, findSession, readSessionToken, wantsTokenSession,
} from '../auth/sessions.ts';
import { eventContext, eraseHistory, recentActivity, recordEvent } from '../compliance/audit.ts';
import { currentConsents, listConsents, outdatedConsents, recordConsents, REQUIRED_CONSENTS } from '../compliance/consents.ts';
import { release } from '../compliance/directory.ts';
import { badRequest, conflict, HttpError } from '../lib/errors.ts';
import { readJson, requireAuth, type AppEnv, type Deps } from '../http.ts';
import { ConsentPatchBody, PreferencesBody } from '../schemas.ts';
import { toAccount, toProfile } from '../serialize.ts';
import { relationshipOrder } from './profiles.ts';
import { appSignOutUrl, issueSignOutTicket } from './accounts.ts';

const MINUTE = 60_000;
/** Deleting an account needs a sign-in with LotusPond Accounts this recent: the proof that the holder is present. */
export const RECENT_SIGN_IN_MS = 10 * MINUTE;

export async function sessionInfo(db: Db, user: UserRow): Promise<SessionInfo> {
  const [rows, consents] = await Promise.all([
    db.select().from(profiles).where(eq(profiles.userId, user.id)).orderBy(asc(profiles.createdAt)),
    listConsents(db, user.id),
  ]);
  return { account: toAccount(user), profiles: rows.sort(relationshipOrder).map(toProfile), consentsOutdated: outdatedConsents(consents) };
}

/** A new account in its cell: the user, their own profile, and the consents given at sign-up. */
export async function insertAccount(
  cell: Cell, who: { id: string; email: string; accountsSubject: string; accountsSignedInAt: Date },
  policy: ReturnType<typeof countryPolicy>, displayName: string, marketing: boolean,
): Promise<UserRow> {
  return cell.db.transaction(async tx => {
    const [u] = await tx.insert(users).values({
      ...who, country: policy.code, region: policy.region, unitSystem: policy.units, ageConfirmedAt: new Date(),
    }).returning();
    await tx.insert(profiles).values({ userId: u.id, relationship: 'self', displayName });
    await recordConsents(tx as unknown as Db, u.id, policy.code, [
      { kind: 'terms', granted: true },
      { kind: 'privacy', granted: true },
      { kind: 'health_data', granted: true },
      ...(policy.crossBorder ? [{ kind: 'cross_border' as const, granted: true }] : []),
      { kind: 'marketing', granted: marketing },
    ]);
    return u;
  });
}

/** A unique index refused the row (PostgreSQL 23505). Drizzle wraps the driver's error, so its cause is checked too. */
export const isUniqueViolation = (e: unknown): boolean => {
  const err = e as { code?: unknown; cause?: unknown } | null;
  return !!err && typeof err === 'object' && (err.code === '23505' || (!!err.cause && isUniqueViolation(err.cause)));
};

export function authRoutes(deps: Deps) {
  const { config, cells } = deps;
  const app = new Hono<AppEnv>();
  const auth = requireAuth(deps);

  /** Public facts for sign-up and the Account page. */
  app.get('/config', c => c.json<ServiceInfo>({
    servedRegions: cells.servedRegions,
    consentVersion: CONSENT_VERSION,
    accounts: !!config.accounts,
    contacts: { grievance: config.grievanceContact ?? null, dpo: config.dpoContact ?? null },
    apiOrigins: config.regionApiOrigins,
  }));

  /** Health's password routes, for apps from before LotusPond Accounts: the person continues with their LotusPond account. */
  const accountsOnly = () => new HttpError(409, 'use_accounts', 'LotusPond Health now uses your LotusPond account. Update the app if you need to, then continue with LotusPond Account.');
  for (const path of ['/register', '/login', '/password']) app.post(path, () => { throw accountsOnly(); });

  app.post('/logout', async c => {
    const presented = readSessionToken(c);
    const session = presented ? await findSession(cells, presented.token, config.sessionTtlMs) : null;
    if (session) {
      await deleteSession(session.cell.db, session.id);
      await recordEvent(session.cell.db, eventContext(c, deps), session.user.id, 'sign_out');
    }
    clearSessionCookie(c, config.cookieSecure);
    // Signed in with LotusPond Accounts on the website: the page goes on to sign out there too (routes/accounts.ts).
    // The apps open it in the system browser, where their Accounts sign-in is.
    if (session?.viaAccounts && config.accounts) {
      const hint = session.accountsIdToken;
      return c.json({ accountsSignOut: wantsTokenSession(c) ? appSignOutUrl(c, deps, hint) : issueSignOutTicket(c, deps, hint) });
    }
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

  /** Sign out every other browser and device. */
  app.delete('/sessions', auth, async c => {
    await deleteUserSessions(c.var.cell.db, c.var.user.id, c.var.sessionId);
    await recordEvent(c.var.cell.db, eventContext(c, deps), c.var.user.id, 'sessions_revoked');
    return c.body(null, 204);
  });

  app.delete('/account', auth, async c => {
    const { db, files } = c.var.cell;
    const user = c.var.user;
    const [session] = await db.select({ createdAt: sessions.createdAt }).from(sessions).where(eq(sessions.id, c.var.sessionId)).limit(1);
    if (!session || Date.now() - session.createdAt.getTime() > RECENT_SIGN_IN_MS) {
      throw new HttpError(409, 'recent_sign_in_required', 'To delete your account, sign out and sign in with LotusPond Accounts again, then delete it within 10 minutes.');
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
