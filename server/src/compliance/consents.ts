// Consent records: append-only, one row per decision, each with the text version and the country at the time.
import { desc, eq } from 'drizzle-orm';
import { CONSENT_VERSION } from '../../../shared/regions.ts';
import type { ConsentDetail, ConsentKind, ConsentRecord } from '../../../shared/types.ts';
import type { Db } from '../db/client.ts';
import { consents, type ConsentRow } from '../db/schema.ts';

/** Consents the account cannot exist without. Withdrawing one means deleting the account. */
export const REQUIRED_CONSENTS: readonly ConsentKind[] = ['terms', 'privacy', 'health_data', 'cross_border'];

export const toConsent = (r: ConsentRow): ConsentRecord => ({
  kind: r.kind, version: r.version, granted: r.granted, createdAt: r.createdAt.toISOString(), country: r.country, detail: r.detail ?? null,
});

/** Every decision, newest first. */
export async function listConsents(db: Db, userId: string): Promise<ConsentRecord[]> {
  const rows = await db.select().from(consents).where(eq(consents.userId, userId)).orderBy(desc(consents.createdAt), desc(consents.id));
  return rows.map(toConsent);
}

/** Consents given per profile or per connection rather than once for the account. */
export const PER_ITEM_CONSENTS: readonly ConsentKind[] = ['family_profile', 'agent_sharing', 'ai_extraction', 'assistant', 'whatsapp', 'record_agent'];

/** The latest decision for each account-wide kind (per-item kinds are left out: each has many). */
export function currentConsents(records: ConsentRecord[]): Partial<Record<ConsentKind, ConsentRecord>> {
  const out: Partial<Record<ConsentKind, ConsentRecord>> = {};
  for (const r of records) if (!PER_ITEM_CONSENTS.includes(r.kind)) out[r.kind] ??= r; // records are newest first
  return out;
}

/** Required consents whose latest grant is for older texts: the person is asked to accept the current ones. */
export function outdatedConsents(records: ConsentRecord[]): ConsentKind[] {
  const current = currentConsents(records);
  return (['terms', 'privacy'] as const).filter(k => current[k]?.granted && current[k]!.version !== CONSENT_VERSION);
}

export async function recordConsents(db: Db, userId: string, country: string | null, decisions: { kind: ConsentKind; granted: boolean; detail?: ConsentDetail; version?: string }[]): Promise<void> {
  if (!decisions.length) return;
  await db.insert(consents).values(decisions.map(d => ({ userId, kind: d.kind, granted: d.granted, version: d.version ?? CONSENT_VERSION, country, detail: d.detail ?? null })));
}
