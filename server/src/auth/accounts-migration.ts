// Moving account identity into LotusPond Accounts (docs/identity.md, "Moving the directory into Accounts").
//
//   linkAccounts  Accounts' answer to its import, which Accounts subject (`sub`) each Health account became: linked
//                 in one go, so no one had to be found by email at their first sign-in.
//   readiness     who is active and how they signed in: Health password sessions from before M9, or Accounts.
//
// The export for Accounts' import, and the M9 gate (accounts:cleanup-check), read Health's password hashes. They
// went with them in M9.
import { eq, gte } from 'drizzle-orm';
import { sessions, users } from '../db/schema.ts';
import type { Cell } from '../cells.ts';
import { recordEvent } from '../compliance/audit.ts';
import { isUniqueViolation } from '../routes/auth.ts';

/** One line of Accounts' answer. */
export interface AccountLink { health_user_id: string; sub: string }

export interface LinkReport {
  linked: number;
  /** Already linked to the same subject. */
  unchanged: number;
  /** Linked to another subject already, or the subject belongs to another account: left as they are. */
  conflicts: { health_user_id: string; reason: string }[];
  /** Not held by this server's cells (another regional host holds it, or it was deleted). */
  missing: string[];
  /** Lines that are not { health_user_id, sub }. */
  invalid: number;
}

export async function linkAccounts(cells: Cell[], links: Iterable<unknown>): Promise<LinkReport> {
  const report: LinkReport = { linked: 0, unchanged: 0, conflicts: [], missing: [], invalid: 0 };
  for (const raw of links) {
    const link = raw as Partial<AccountLink> | null;
    if (!link || typeof link.health_user_id !== 'string' || typeof link.sub !== 'string' || !link.sub || link.sub.length > 255) {
      report.invalid++;
      continue;
    }
    let done = false;
    for (const cell of cells) {
      const [user] = await cell.db.select({ id: users.id, accountsSubject: users.accountsSubject }).from(users)
        .where(eq(users.id, link.health_user_id)).limit(1).catch(() => []); // a malformed id is simply not found
      if (!user) continue;
      done = true;
      if (user.accountsSubject === link.sub) { report.unchanged++; break; }
      if (user.accountsSubject) { report.conflicts.push({ health_user_id: user.id, reason: 'already linked to another LotusPond account' }); break; }
      try {
        await cell.db.update(users).set({ accountsSubject: link.sub, updatedAt: new Date() }).where(eq(users.id, user.id));
        await recordEvent(cell.db, null, user.id, 'accounts_linked');
        report.linked++;
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        report.conflicts.push({ health_user_id: user.id, reason: 'that LotusPond account is already linked to another Health account' });
      }
      break;
    }
    if (!done) report.missing.push(link.health_user_id);
  }
  return report;
}

/** Parse JSON Lines; a line that is not JSON counts as invalid (undefined). */
export function* readJsonLines(text: string): Generator<unknown> {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { yield undefined; }
  }
}

/**
 * Readiness to turn Health passwords off (PASSWORD_SIGN_IN=off, build plan M8): who is active, how they sign in, and
 * who would have to sign in with LotusPond Accounts for the first time. Counts only, read from Health's own database.
 * Health does not record app versions, so this measures sign-in methods, not app installs.
 */
export interface Readiness {
  days: number;
  /** Accounts with a session seen in the period. */
  active: number;
  /** Of those, seen with a password session, and with an Accounts session (a person can be both). */
  activeWithPassword: number;
  activeWithAccounts: number;
  /** Active, and never signed in with Accounts: they would have to, at their next sign-in, once passwords are off. */
  activeNotMoved: number;
  /** All accounts: linked by the import but never signed in with Accounts; not linked at all; moved. */
  linkedNotMoved: number;
  notLinked: number;
  moved: number;
}

export async function readiness(cells: Cell[], days: number, now = new Date()): Promise<Readiness> {
  const since = new Date(now.getTime() - days * 86_400_000);
  const r: Readiness = { days, active: 0, activeWithPassword: 0, activeWithAccounts: 0, activeNotMoved: 0, linkedNotMoved: 0, notLinked: 0, moved: 0 };
  for (const cell of cells) {
    const recent = await cell.db.select({ userId: sessions.userId, viaAccounts: sessions.viaAccounts }).from(sessions).where(gte(sessions.lastSeenAt, since));
    const people = await cell.db.select({ id: users.id, subject: users.accountsSubject, movedAt: users.accountsSignedInAt }).from(users);
    const byId = new Map(people.map(p => [p.id, p]));
    const active = new Set(recent.map(s => s.userId));
    r.active += active.size;
    r.activeWithPassword += new Set(recent.filter(s => !s.viaAccounts).map(s => s.userId)).size;
    r.activeWithAccounts += new Set(recent.filter(s => s.viaAccounts).map(s => s.userId)).size;
    r.activeNotMoved += [...active].filter(id => byId.get(id) && !byId.get(id)!.movedAt).length;
    for (const p of people) {
      if (p.movedAt) r.moved++;
      else if (p.subject) r.linkedNotMoved++;
      else r.notLinked++;
    }
  }
  return r;
}

export function formatReadiness(r: Readiness): string {
  const pct = (n: number) => (r.active ? `${Math.round((n / r.active) * 100)}%` : '-');
  return [
    `Last ${r.days} days: ${r.active} active accounts.`,
    `  signed in with a Health password: ${r.activeWithPassword} (${pct(r.activeWithPassword)})`,
    `  signed in with LotusPond Accounts: ${r.activeWithAccounts} (${pct(r.activeWithAccounts)})`,
    `  never signed in with Accounts yet: ${r.activeNotMoved} (${pct(r.activeNotMoved)}). With passwords off, they sign in with Accounts at their next sign-in.`,
    `All accounts: moved ${r.moved}; linked by the import but not moved ${r.linkedNotMoved}; not linked ${r.notLinked}.`,
    'Health does not record app versions: an older app cannot sign in once passwords are off, whatever these counts.',
  ].join('\n');
}

