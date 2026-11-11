// The directory: which cell holds the account for an email. It lives in the default database and stores an HMAC
// of the email (keyed with DIRECTORY_SECRET), the region and the user id, so sign-in can find the right cell
// without any email address being stored in plain text outside its own cell.
// Deployments that run one API per region point DATABASE_URL at one shared database, so they share the directory.
import { createHmac } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { DataRegion } from '../../../shared/regions.ts';
import { directory, users, whatsappDirectory, whatsappLinkCodes, type UserRow } from '../db/schema.ts';
import type { Cell } from '../cells.ts';
import type { Deps } from '../http.ts';

export function emailHash(key: Buffer, email: string): string {
  return createHmac('sha256', key).update(email.trim().toLowerCase()).digest('hex');
}

export type Located =
  /** The account is in a cell this server holds. */
  | { region: DataRegion; cell: Cell; user: UserRow }
  /** The account exists, in a region another deployment serves. */
  | { region: DataRegion; cell: null; user: null };

type DirDeps = Pick<Deps, 'db' | 'cells' | 'secrets'>;

/**
 * Find the account for an email. The directory answers first. Accounts it does not know (created before the
 * directory existed) are looked for in each cell this server holds, and added to it when found.
 */
export async function locate(deps: DirDeps, email: string): Promise<Located | null> {
  const hash = emailHash(deps.secrets.directoryKey, email);
  const [entry] = await deps.db.select().from(directory).where(eq(directory.emailHash, hash)).limit(1);
  if (entry) {
    const cell = deps.cells.forRegion(entry.region);
    if (!cell) return { region: entry.region, cell: null, user: null };
    const [user] = await cell.db.select().from(users).where(and(eq(users.id, entry.userId), eq(users.email, email))).limit(1);
    if (user) return { region: entry.region, cell, user };
    // The account is gone (deleted while the directory was unreachable): the entry is stale.
    await deps.db.delete(directory).where(eq(directory.emailHash, hash));
  }
  for (const cell of deps.cells.cells) {
    const [user] = await cell.db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) continue;
    let region = user.region;
    if (deps.cells.forRegion(region) !== cell) {
      region = deps.cells.regionsOf(cell)[0];
      await cell.db.update(users).set({ region }).where(eq(users.id, user.id));
    }
    await deps.db.insert(directory).values({ emailHash: hash, region, userId: user.id }).onConflictDoNothing();
    return { region, cell, user: { ...user, region } };
  }
  return null;
}

/** Reserve an email for a new account. False when another account already holds it. */
export async function claim(deps: DirDeps, email: string, region: DataRegion, userId: string): Promise<boolean> {
  const rows = await deps.db.insert(directory)
    .values({ emailHash: emailHash(deps.secrets.directoryKey, email), region, userId })
    .onConflictDoNothing().returning({ userId: directory.userId });
  return rows.length === 1;
}

export async function release(deps: Pick<Deps, 'db'>, userId: string): Promise<void> {
  await deps.db.delete(directory).where(eq(directory.userId, userId));
  // A linked WhatsApp number, or a code waiting to link one.
  await deps.db.delete(whatsappDirectory).where(eq(whatsappDirectory.userId, userId));
  await deps.db.delete(whatsappLinkCodes).where(eq(whatsappLinkCodes.userId, userId));
}
