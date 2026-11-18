// One-time tokens: each works once across every instance and regional host, because the record of using it is in the
// default database they share (db/schema.ts, spentTokens). Used for app sign-in codes and back-channel logout tokens.
import { createHash } from 'node:crypto';
import { lt } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { spentTokens } from '../db/schema.ts';

export type SpendKind = 'app-code' | 'logout-token';

/**
 * Mark a token used. True the first time; false when it was already used, here or on another instance. One insert,
 * so two instances racing on the same token cannot both win. `until` is when the token stops being accepted anyway.
 */
export async function spendOnce(db: Db, kind: SpendKind, tokenId: string, until: Date): Promise<boolean> {
  const id = createHash('sha256').update(`${kind}\0${tokenId}`).digest('hex');
  const rows = await db.insert(spentTokens).values({ id, expiresAt: until }).onConflictDoNothing().returning({ id: spentTokens.id });
  return rows.length === 1;
}

/** Forget tokens that could no longer be accepted anyway. */
export async function purgeSpentTokens(db: Db): Promise<void> {
  await db.delete(spentTokens).where(lt(spentTokens.expiresAt, new Date()));
}
