// Organisations and their API keys: the organisation side of the connector core (docs/connectors.md). An
// organisation (a healthcare startup, a hospital, a TPA, a health-tech builder) calls operations with a key that names
// which operations it may call. Keys are kept only as SHA-256; every call, allowed or refused, is recorded.
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { DataRegion } from '../../../shared/regions.ts';
import type { Db } from '../db/client.ts';
import { organisationKeys, organisations } from '../db/schema.ts';
import { OPERATIONS, type OperationId } from './types.ts';

export type OrganisationRow = typeof organisations.$inferSelect;
export type OrganisationKeyRow = typeof organisationKeys.$inferSelect;

/** `lpk_` and 43 characters of base64url (32 random bytes). */
const KEY_PATTERN = /^lpk_[A-Za-z0-9_-]{43}$/;
const hash = (key: string) => createHash('sha256').update(key).digest('hex');

/** Operations an organisation may be given: those whose authority includes organisations. */
export const ORGANISATION_OPERATIONS = (Object.keys(OPERATIONS) as OperationId[]).filter(id => OPERATIONS[id].authority.includes('organisation'));

export async function createOrganisation(db: Db, name: string, region: DataRegion): Promise<OrganisationRow> {
  const n = name.trim();
  if (!n || n.length > 120) throw new Error('Give the organisation a name (up to 120 characters).');
  const [row] = await db.insert(organisations).values({ name: n, region }).returning();
  return row;
}

/** Make a key. The key itself is returned once and never stored. */
export async function createOrganisationKey(db: Db, organisationId: string, name: string, operations: OperationId[]): Promise<{ key: string; row: OrganisationKeyRow }> {
  const wrong = operations.filter(op => !ORGANISATION_OPERATIONS.includes(op));
  if (wrong.length) throw new Error(`Not organisation operations: ${wrong.join(', ')}. Use: ${ORGANISATION_OPERATIONS.join(', ')}.`);
  if (!operations.length) throw new Error('A key needs at least one operation.');
  const [org] = await db.select({ id: organisations.id }).from(organisations).where(eq(organisations.id, organisationId)).limit(1);
  if (!org) throw new Error('No such organisation.');
  const key = `lpk_${randomBytes(32).toString('base64url')}`;
  const [row] = await db.insert(organisationKeys).values({
    organisationId, name: name.trim() || 'API key', prefix: key.slice(0, 12), keyHash: hash(key), operations: [...new Set(operations)],
  }).returning();
  return { key, row };
}

export async function revokeOrganisationKey(db: Db, keyId: string, now = new Date()): Promise<boolean> {
  const rows = await db.update(organisationKeys).set({ revokedAt: now }).where(and(eq(organisationKeys.id, keyId), isNull(organisationKeys.revokedAt))).returning({ id: organisationKeys.id });
  return rows.length > 0;
}

/** The organisation and key behind a bearer key, or null (unknown, malformed or revoked). */
export async function authenticateOrganisation(db: Db, key: string, now = new Date()): Promise<{ org: OrganisationRow; key: OrganisationKeyRow } | null> {
  if (!KEY_PATTERN.test(key)) return null;
  const [k] = await db.select().from(organisationKeys).where(eq(organisationKeys.keyHash, hash(key))).limit(1);
  if (!k || k.revokedAt) return null;
  const [org] = await db.select().from(organisations).where(eq(organisations.id, k.organisationId)).limit(1);
  if (!org) return null;
  await db.update(organisationKeys).set({ lastUsedAt: now }).where(eq(organisationKeys.id, k.id));
  return { org, key: k };
}
