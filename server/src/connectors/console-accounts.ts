// Organisation accounts for the developer console. The console opens with the person's LotusPond Health sign-in (the
// same session cookie as the app, or the apps' bearer token; settled by the owner, 2026-11-18). Each Health account
// has one organisation account, made the first time it opens the console; organisations are workspaces that account is
// a member of, as in LotusPond Works. The organisation account holds no records and opens none: it only names who is
// in which organisation, with which role.
import { and, eq, isNull, lt } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { organisationAccounts, organisationSessions, profiles, type UserRow } from '../db/schema.ts';
import type { ActiveSession } from '../auth/sessions.ts';
import { HttpError } from '../lib/errors.ts';

export type OrganisationAccountRow = typeof organisationAccounts.$inferSelect;

/** Refused with this code when an earlier console account (with its own password) uses the person's email. */
export const LINK_REQUIRED = 'link_required';

/** A unique-index refusal, whether the driver's error comes bare or wrapped by Drizzle (as `cause`). */
export const isUniqueViolation = (e: unknown): boolean => !!e && typeof e === 'object'
  && (('code' in e && (e as { code: unknown }).code === '23505') || ('cause' in e && isUniqueViolation((e as { cause: unknown }).cause)));

const byHealthUser = (user: UserRow) => and(eq(organisationAccounts.healthRegion, user.region), eq(organisationAccounts.healthUserId, user.id));

/** The console account of a Health account, if it has opened the console before. */
async function linked(db: Db, user: UserRow): Promise<OrganisationAccountRow | null> {
  const [row] = await db.select().from(organisationAccounts).where(byHealthUser(user)).limit(1);
  return row ?? null;
}

/** An earlier console account with this email that no Health account opens yet. */
export async function unlinkedByEmail(db: Db, email: string): Promise<OrganisationAccountRow | null> {
  const [row] = await db.select().from(organisationAccounts)
    .where(and(eq(organisationAccounts.email, email), isNull(organisationAccounts.healthUserId))).limit(1);
  return row ?? null;
}

/** The name the console shows for a person: their own profile's name in Health, else their email. */
async function displayName(session: ActiveSession): Promise<string> {
  const [self] = await session.cell.db.select({ name: profiles.displayName }).from(profiles)
    .where(and(eq(profiles.userId, session.user.id), eq(profiles.relationship, 'self'))).limit(1);
  return (self?.name?.trim() || session.user.email).slice(0, 120);
}

export async function linkConsoleAccount(db: Db, account: OrganisationAccountRow, user: UserRow): Promise<OrganisationAccountRow> {
  const [row] = await db.update(organisationAccounts).set({ healthUserId: user.id, healthRegion: user.region, updatedAt: new Date() })
    .where(and(eq(organisationAccounts.id, account.id), isNull(organisationAccounts.healthUserId))).returning();
  if (!row) throw new HttpError(409, 'already_linked', 'That console account is already opened by another LotusPond Health account.');
  return row;
}

/**
 * The console account for a signed-in Health account, made on first use.
 *
 * An earlier console account (from when the console had its own sign-up) with the same email is joined to it only
 * when the email is known to be the person's: when they signed in through LotusPond Accounts, which joins only
 * verified emails (docs/identity.md). Otherwise the console asks once for that account's console password
 * (POST /api/console/link), so someone who signed up to Health with another person's email cannot take over their
 * organisations.
 */
export async function consoleAccountFor(db: Db, session: ActiveSession): Promise<OrganisationAccountRow> {
  const { user } = session;
  const found = await linked(db, user);
  if (found) {
    if (found.email === user.email) return found;
    // The Health email changed: follow it, unless another console account already has the new one.
    try {
      const [row] = await db.update(organisationAccounts).set({ email: user.email, updatedAt: new Date() }).where(eq(organisationAccounts.id, found.id)).returning();
      return row;
    } catch (e) {
      if (isUniqueViolation(e)) return found;
      throw e;
    }
  }
  const earlier = await unlinkedByEmail(db, user.email);
  if (earlier) {
    if (user.accountsSubject) return linkConsoleAccount(db, earlier, user);
    throw new HttpError(409, LINK_REQUIRED, 'You made a developer console account with this email before the console used your LotusPond Health sign-in. Enter its console password once to bring its organisations here.');
  }
  try {
    const [row] = await db.insert(organisationAccounts)
      .values({ email: user.email, name: await displayName(session), passwordHash: null, healthUserId: user.id, healthRegion: user.region }).returning();
    return row;
  } catch (e) {
    // Two first requests at once: the other one made it.
    if (isUniqueViolation(e)) {
      const again = await linked(db, user);
      if (again) return again;
      throw new HttpError(409, 'email_taken', 'Another LotusPond Health account already opens a console account with this email.');
    }
    throw e;
  }
}

/**
 * Sessions of the console's own sign-in, from before it used the Health sign-in. Nothing makes or reads them now; the
 * hourly sweep removes them as they expire (at most 7 days after they were made).
 */
export async function purgeExpiredConsoleSessions(db: Db): Promise<void> {
  await db.delete(organisationSessions).where(lt(organisationSessions.expiresAt, new Date()));
}
