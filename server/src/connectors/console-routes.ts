// The developer console's API (/api/console), for people signed in to LotusPond with a session. Anyone with an
// account can make an organisation and get API keys at once; those keys reach only the sandbox hospital until
// LotusPond checks the organisation's written authority and gives it live access (the server's command line).
//   GET    /api/console                                   the person's organisations
//   POST   /api/console/organisations                     { name } → a new organisation, with them as owner
//   GET    /api/console/organisations/:id                 keys, connections, approvals, recent calls
//   POST   /api/console/organisations/:id/keys            { name, operations } → the key, shown once
//   DELETE /api/console/organisations/:id/keys/:keyId     revoke
//   POST   /api/console/organisations/:id/approvals/:aid  { decision: approve | reject }
//   POST   /api/console/organisations/:id/live-request    { systems, hospital, note }
// Membership is checked on every call: an organisation is reachable only by its members.
import { and, desc, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { INTEGRATIONS, INTEGRATION_STATUS_TEXT } from '../../../shared/integrations.ts';
import { organisationCalls, organisationKeys, organisationMembers, organisations } from '../db/schema.ts';
import { readJson, requireAuth, UUID, type AppEnv, type Ctx, type Deps } from '../http.ts';
import { HttpError } from '../lib/errors.ts';
import { RateLimiter } from '../lib/rate-limit.ts';
import { createOrganisation, createOrganisationKey, ORGANISATION_OPERATIONS, revokeOrganisationKey } from './organisations.ts';
import type { OrganisationRuntime } from './runtime.ts';
import { OPERATIONS, type OperationId } from './types.ts';

const MAX_ORGS_PER_PERSON = 5;
const MAX_ACTIVE_KEYS = 20;

type MemberRow = typeof organisationMembers.$inferSelect;

export function consoleRoutes(deps: Deps, runtime: OrganisationRuntime) {
  const { db } = deps;
  const app = new Hono<AppEnv>();
  const keysByUser = new RateLimiter(30, 60 * 60_000);
  app.use('*', requireAuth(deps));

  async function membership(c: Ctx, orgId: string): Promise<{ member: MemberRow; org: typeof organisations.$inferSelect }> {
    if (!UUID.test(orgId)) throw new HttpError(404, 'not_found', 'No such organisation.');
    const u = c.var.user;
    const [row] = await db.select({ member: organisationMembers, org: organisations }).from(organisationMembers)
      .innerJoin(organisations, eq(organisations.id, organisationMembers.organisationId))
      .where(and(eq(organisationMembers.organisationId, orgId), eq(organisationMembers.userRegion, u.region), eq(organisationMembers.userId, u.id))).limit(1);
    if (!row) throw new HttpError(404, 'not_found', 'No such organisation.');
    return row;
  }

  app.get('/', async c => {
    const u = c.var.user;
    const rows = await db.select({ org: organisations, role: organisationMembers.role }).from(organisationMembers)
      .innerJoin(organisations, eq(organisations.id, organisationMembers.organisationId))
      .where(and(eq(organisationMembers.userRegion, u.region), eq(organisationMembers.userId, u.id))).orderBy(organisations.createdAt);
    return c.json({
      account: { email: u.email },
      organisations: rows.map(r => ({ id: r.org.id, name: r.org.name, region: r.org.region, access: r.org.access, role: r.role })),
      operations: ORGANISATION_OPERATIONS.map(id => OPERATIONS[id]),
      integrations: INTEGRATIONS.map(i => ({ ...i, statusText: INTEGRATION_STATUS_TEXT[i.status] })),
    });
  });

  app.post('/organisations', async c => {
    const body = await readJson(c, z.object({ name: z.string().trim().min(2).max(120) }));
    const u = c.var.user;
    const mine = await db.select({ id: organisationMembers.id }).from(organisationMembers).where(and(eq(organisationMembers.userRegion, u.region), eq(organisationMembers.userId, u.id)));
    if (mine.length >= MAX_ORGS_PER_PERSON) throw new HttpError(409, 'too_many', `You can be in up to ${MAX_ORGS_PER_PERSON} organisations.`);
    const org = await createOrganisation(db, body.name, u.region);
    await db.insert(organisationMembers).values({ organisationId: org.id, userRegion: u.region, userId: u.id, email: u.email, role: 'owner' });
    await runtime.ensureSandbox(org.id);
    return c.json({ id: org.id, name: org.name, region: org.region, access: org.access, role: 'owner' }, 201);
  });

  app.get('/organisations/:id', async c => {
    const { org, member } = await membership(c, c.req.param('id'));
    const [keys, connections, approvals, calls] = await Promise.all([
      db.select().from(organisationKeys).where(eq(organisationKeys.organisationId, org.id)).orderBy(desc(organisationKeys.createdAt)),
      runtime.listConnections(org.id),
      runtime.listApprovals(org.id, 50),
      db.select().from(organisationCalls).where(eq(organisationCalls.organisationId, org.id)).orderBy(desc(organisationCalls.at)).limit(50),
    ]);
    return c.json({
      organisation: { id: org.id, name: org.name, region: org.region, access: org.access, liveRequestedAt: org.liveRequestedAt?.toISOString() ?? null, role: member.role },
      keys: keys.map(k => ({ id: k.id, name: k.name, prefix: k.prefix, operations: k.operations, createdAt: k.createdAt.toISOString(), lastUsedAt: k.lastUsedAt?.toISOString() ?? null, revokedAt: k.revokedAt?.toISOString() ?? null })),
      connections,
      approvals,
      calls: calls.map(x => ({ id: x.id, operation: x.operation, outcome: x.outcome, keyId: x.keyId, connectionId: x.connectionId, at: x.at.toISOString() })),
    });
  });

  app.post('/organisations/:id/keys', async c => {
    const { org } = await membership(c, c.req.param('id'));
    const body = await readJson(c, z.object({
      name: z.string().trim().min(1).max(60),
      operations: z.array(z.enum(ORGANISATION_OPERATIONS as [OperationId, ...OperationId[]])).min(1).max(ORGANISATION_OPERATIONS.length),
    }));
    const wait = keysByUser.hit(`${c.var.user.region}:${c.var.user.id}`);
    if (wait) throw new HttpError(429, 'rate_limited', `Too many new keys. Try again in ${Math.ceil(wait / 60)} minutes.`);
    const active = await db.select({ id: organisationKeys.id }).from(organisationKeys).where(and(eq(organisationKeys.organisationId, org.id), isNull(organisationKeys.revokedAt)));
    if (active.length >= MAX_ACTIVE_KEYS) throw new HttpError(409, 'too_many', `An organisation can have up to ${MAX_ACTIVE_KEYS} active keys. Revoke one first.`);
    const { key, row } = await createOrganisationKey(db, org.id, body.name, body.operations);
    return c.json({ key, id: row.id, name: row.name, prefix: row.prefix, operations: row.operations }, 201);
  });

  app.delete('/organisations/:id/keys/:keyId', async c => {
    const { org } = await membership(c, c.req.param('id'));
    const keyId = c.req.param('keyId');
    if (!UUID.test(keyId)) throw new HttpError(404, 'not_found', 'No such key.');
    const [k] = await db.select({ id: organisationKeys.id }).from(organisationKeys).where(and(eq(organisationKeys.id, keyId), eq(organisationKeys.organisationId, org.id))).limit(1);
    if (!k) throw new HttpError(404, 'not_found', 'No such key.');
    await revokeOrganisationKey(db, keyId);
    return c.json({ ok: true });
  });

  app.post('/organisations/:id/approvals/:aid', async c => {
    const { org, member } = await membership(c, c.req.param('id'));
    const aid = c.req.param('aid');
    if (!UUID.test(aid)) throw new HttpError(404, 'not_found', 'No such approval.');
    const body = await readJson(c, z.object({ decision: z.enum(['approve', 'reject']) }));
    return c.json(await runtime.decide(org.id, aid, body.decision, `${member.email} (${member.role})`));
  });

  app.post('/organisations/:id/live-request', async c => {
    const { org, member } = await membership(c, c.req.param('id'));
    const body = await readJson(c, z.object({
      systems: z.string().trim().min(2).max(300),
      hospital: z.string().trim().min(2).max(300),
      note: z.string().trim().max(2000).default(''),
    }));
    await db.update(organisations).set({ liveRequestedAt: new Date(), liveRequest: { ...body, by: member.email } }).where(eq(organisations.id, org.id));
    console.log(`[console] live access requested for organisation ${org.id}`);
    return c.json({ ok: true });
  });

  return app;
}
