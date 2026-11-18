// Finding a Health account by email, and forgetting an account in the default database. LotusPond Accounts says
// which region holds an account (its `region` claim), so Health keeps no email directory of its own: it was dropped in
// M9 (docs/identity.md). The WhatsApp directory, keyed by phone number, stays (whatsapp/service.ts).
import { eq } from 'drizzle-orm';
import type { DataRegion } from '../../../shared/regions.ts';
import { users, whatsappDirectory, whatsappLinkCodes, type UserRow } from '../db/schema.ts';
import type { Cell } from '../cells.ts';
import type { Deps } from '../http.ts';

export interface Located { region: DataRegion; cell: Cell; user: UserRow }

/** The account with this email in this server's own cells, if any. */
export async function findInCells(deps: Pick<Deps, 'cells'>, email: string): Promise<Located | null> {
  for (const cell of deps.cells.cells) {
    const [user] = await cell.db.select().from(users).where(eq(users.email, email)).limit(1);
    if (user) return { region: user.region, cell, user };
  }
  return null;
}

/** Forget a deleted account in the default database: a linked WhatsApp number, or a code waiting to link one. */
export async function release(deps: Pick<Deps, 'db'>, userId: string): Promise<void> {
  await deps.db.delete(whatsappDirectory).where(eq(whatsappDirectory.userId, userId));
  await deps.db.delete(whatsappLinkCodes).where(eq(whatsappLinkCodes.userId, userId));
}
