// Consent records: append-only, one row per decision, each with the text version and the country at the time.
import { desc, eq } from 'drizzle-orm';
import { CONSENT_VERSION } from '../../../shared/regions.ts';
import type { ConsentKind, ConsentRecord } from '../../../shared/types.ts';
import type { Db } from '../db/client.ts';
import { consents, type ConsentRow } from '../db/schema.ts';

/** Consents the account cannot exist without. Withdrawing one means deleting the account. */
export const REQUIRED_CONSENTS: readonly ConsentKind[] = ['terms', 'privacy', 'health_data', 'cross_border'];

export const toConsent = (r: ConsentRow): ConsentRecord => ({
  kind: r.kind, version: r.version, granted: r.granted, createdAt: r.createdAt.toISOString(), country: r.country,
});

/** Every decision, newest first. */
export async function listConsents(db: Db, userId: string): Promise<ConsentRecord[]> {
  const rows = await db.select().from(consents).where(eq(consents.userId, userId)).orderBy(desc(consents.createdAt), desc(consents.id));
  return rows.map(toConsent);
}

/** The latest decision for each kind. */
export function currentConsents(records: ConsentRecord[]): Partial<Record<ConsentKind, ConsentRecord>> {
  const out: Partial<Record<ConsentKind, ConsentRecord>> = {};
  for (const r of records) out[r.kind] ??= r; // records are newest first
  return out;
}

export async function recordConsents(db: Db, userId: string, country: string | null, decisions: { kind: ConsentKind; granted: boolean }[]): Promise<void> {
  if (!decisions.length) return;
  await db.insert(consents).values(decisions.map(d => ({ userId, kind: d.kind, granted: d.granted, version: CONSENT_VERSION, country })));
}
