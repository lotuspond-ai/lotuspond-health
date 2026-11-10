// Agent grants and their secrets (schema.ts agentGrants, agentTokens), in the account's cell.
// Every secret starts with its kind and the account's region ("lpa_in.…"), so a request goes straight to the right
// cell, like session tokens. Only SHA-256 digests are stored.
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, inArray, lt } from 'drizzle-orm';
import { AGENT_SCOPES, type AgentConnection, type AgentScope } from '../../../shared/agents.ts';
import type { DataRegion } from '../../../shared/regions.ts';
import type { Cell, CellRegistry } from '../cells.ts';
import type { Db } from '../db/client.ts';
import { recordConsents } from '../compliance/consents.ts';
import { agentGrants, agentTokens, profiles, users, type AgentGrantRow, type UserRow } from '../db/schema.ts';

export type SecretType = 'code' | 'access' | 'refresh';
const PREFIX: Record<SecretType | 'personal', string> = { code: 'lpc', access: 'lpa', refresh: 'lpr', personal: 'lpt' };
const SECRET = /^(lpc|lpa|lpr|lpt)_(in|eu|us|global)\.([\w-]{40,60})$/;

export const CODE_TTL_MS = 5 * 60_000;
export const ACCESS_TTL_MS = 60 * 60_000;
export const REFRESH_TTL_MS = 90 * 24 * 60 * 60_000;

export const digest = (secret: string) => createHash('sha256').update(secret).digest('hex');

export function newSecret(kind: SecretType | 'personal', region: DataRegion): string {
  return `${PREFIX[kind]}_${region}.${randomBytes(32).toString('base64url')}`;
}

/** The cell a secret belongs to and what kind it claims to be, or null. */
export function parseSecret(cells: CellRegistry, secret: string): { cell: Cell; region: DataRegion; type: SecretType } | null {
  const m = SECRET.exec(secret);
  if (!m) return null;
  const region = m[2] as DataRegion;
  const cell = cells.forRegion(region);
  if (!cell) return null;
  const type: SecretType = m[1] === 'lpc' ? 'code' : m[1] === 'lpr' ? 'refresh' : 'access'; // personal tokens are access tokens
  return { cell, region, type };
}

export const cleanScopes = (s: readonly string[]): AgentScope[] =>
  AGENT_SCOPES.filter(x => s.includes(x));

export function toConnection(g: AgentGrantRow): AgentConnection {
  return {
    id: g.id,
    kind: g.kind,
    name: g.name,
    redirectHost: g.redirectHost,
    scopes: cleanScopes(g.scopes),
    profileIds: g.profileIds,
    createdAt: g.createdAt.toISOString(),
    lastUsedAt: g.lastUsedAt?.toISOString() ?? null,
    expiresAt: g.expiresAt?.toISOString() ?? null,
  };
}

/** Keep only profiles of this account; at least one must remain. */
export async function ownProfiles(db: Db, userId: string, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await db.select({ id: profiles.id }).from(profiles).where(and(eq(profiles.userId, userId), inArray(profiles.id, ids)));
  const own = new Set(rows.map(r => r.id));
  return ids.filter(id => own.has(id));
}

/**
 * Record the person's consent to share with a connection, as it now stands (or its withdrawal): an agent_sharing
 * consent with the text version, the agent's name, the profiles and the permissions.
 */
export async function recordSharingConsent(db: Db, user: Pick<UserRow, 'id' | 'country'>, grant: AgentGrantRow, granted = true): Promise<void> {
  await recordConsents(db, user.id, user.country, [{
    kind: 'agent_sharing', granted,
    detail: { connectionId: grant.id, agent: grant.name.slice(0, 80), profileIds: grant.profileIds, scopes: cleanScopes(grant.scopes) },
  }]);
}

export async function listGrants(db: Db, userId: string): Promise<AgentGrantRow[]> {
  const rows = await db.select().from(agentGrants).where(eq(agentGrants.userId, userId));
  return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

export async function deleteGrant(db: Db, userId: string, id: string): Promise<AgentGrantRow | null> {
  const [row] = await db.delete(agentGrants).where(and(eq(agentGrants.id, id), eq(agentGrants.userId, userId))).returning();
  return row ?? null;
}

/** Store a secret for a grant; returns the secret. */
export async function issueSecret(db: Db, region: DataRegion, grantId: string, type: SecretType | 'personal', extra: {
  ttlMs?: number | null; codeChallenge?: string; redirectUri?: string; resource?: string | null;
} = {}): Promise<string> {
  const secret = newSecret(type, region);
  await db.insert(agentTokens).values({
    id: digest(secret),
    grantId,
    type: type === 'personal' ? 'access' : type,
    expiresAt: extra.ttlMs ? new Date(Date.now() + extra.ttlMs) : null,
    codeChallenge: extra.codeChallenge ?? null,
    redirectUri: extra.redirectUri ?? null,
    resource: extra.resource ?? null,
  });
  return secret;
}

export interface ResolvedSecret {
  cell: Cell;
  user: UserRow;
  grant: AgentGrantRow;
  token: typeof agentTokens.$inferSelect;
}

/**
 * Look a secret up. Expired secrets and secrets of expired grants are deleted and give null. `consume` deletes the
 * secret as it is read (codes and refresh tokens are single use), so two concurrent uses cannot both succeed.
 */
export async function resolveSecret(cells: CellRegistry, secret: string, want: SecretType, consume = false): Promise<ResolvedSecret | null> {
  const parsed = parseSecret(cells, secret);
  if (!parsed || parsed.type !== want) return null;
  const { db } = parsed.cell;
  const id = digest(secret);
  let token: typeof agentTokens.$inferSelect | undefined;
  if (consume) [token] = await db.delete(agentTokens).where(and(eq(agentTokens.id, id), eq(agentTokens.type, want))).returning();
  else [token] = await db.select().from(agentTokens).where(and(eq(agentTokens.id, id), eq(agentTokens.type, want))).limit(1);
  if (!token) return null;
  const now = Date.now();
  if (token.expiresAt && token.expiresAt.getTime() <= now) {
    if (!consume) await db.delete(agentTokens).where(eq(agentTokens.id, id));
    return null;
  }
  const [row] = await db.select({ grant: agentGrants, user: users }).from(agentGrants)
    .innerJoin(users, eq(users.id, agentGrants.userId)).where(eq(agentGrants.id, token.grantId)).limit(1);
  if (!row || row.user.region !== parsed.region) return null;
  if (row.grant.expiresAt && row.grant.expiresAt.getTime() <= now) {
    await db.delete(agentGrants).where(eq(agentGrants.id, row.grant.id));
    return null;
  }
  return { cell: parsed.cell, user: row.user, grant: row.grant, token };
}

export async function purgeExpiredAgentSecrets(db: Db): Promise<void> {
  const now = new Date();
  await db.delete(agentTokens).where(lt(agentTokens.expiresAt, now));
  await db.delete(agentGrants).where(lt(agentGrants.expiresAt, now));
}
