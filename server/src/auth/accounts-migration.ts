// Moving account identity into LotusPond Accounts (docs/identity.md, "Moving the directory into Accounts").
//
//   exportAccounts  Health's accounts for Accounts to import: id, email, the Argon2id hash as it is (Accounts keeps
//                   them unchanged), region and country. Personal data and password hashes: the file is written
//                   only by the accounts:export command, readable by its owner only, and is to be deleted once
//                   imported.
//   linkAccounts    Accounts' answer, which Accounts subject (`sub`) each Health account became: linked in one go, so
//                   no one depends on Health's email directory to be found at their first sign-in.
import { eq } from 'drizzle-orm';
import { users } from '../db/schema.ts';
import type { Cell } from '../cells.ts';
import { recordEvent } from '../compliance/audit.ts';
import { isUniqueViolation } from '../routes/auth.ts';

/** One line of the export (JSON Lines). Field names in snake_case, as a file for another service. */
export interface ExportedAccount {
  health_user_id: string;
  email: string;
  /** PHC string ($argon2id$v=19$m=19456,t=2,p=1$…), or null for an account that already signs in only with Accounts. */
  password_hash: string | null;
  region: string;
  country: string | null;
  created_at: string;
  /** Already linked to this Accounts subject (it signed in with Accounts before the import). */
  accounts_subject: string | null;
}

/** One line of Accounts' answer. */
export interface AccountLink { health_user_id: string; sub: string }

export async function exportAccounts(cells: Cell[], write: (line: string) => void): Promise<number> {
  let n = 0;
  for (const cell of cells) {
    const rows = await cell.db.select().from(users);
    for (const u of rows) {
      const line: ExportedAccount = {
        health_user_id: u.id, email: u.email, password_hash: u.passwordHash, region: u.region, country: u.country,
        created_at: u.createdAt.toISOString(), accounts_subject: u.accountsSubject,
      };
      write(JSON.stringify(line));
      n++;
    }
  }
  return n;
}

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
