// The developer console's API (/api/console). It opens with the person's LotusPond Health sign-in: the app's session
// cookie, or the apps' bearer token (settled by the owner, 2026-11-18). Each Health account has one organisation
// account (console-accounts.ts), made on first use; the person makes organisations (or is added to them) and works in
// each with a role, the way LotusPond Works does. Sign-in, sign-out and passwords are Health's (/api/auth).
//   GET    /api/console                                   the account and its organisations
//   POST   /api/console/link                              { password } joins an earlier console account with this email
//   POST   /api/console/organisations                     { name, region } → a new organisation, with them as owner
//   GET    /api/console/organisations/:id                 members, keys, connections, approvals, recent calls
//   POST   /api/console/organisations/:id/members         { email, role, approves }   owner or admin
//   PATCH  /api/console/organisations/:id/members/:mid    { role?, approves? }        owner or admin
//   DELETE /api/console/organisations/:id/members/:mid    owner or admin, or the member leaving
//   POST   /api/console/organisations/:id/keys            { name, operations } → the key, shown once   editor and up
//   DELETE /api/console/organisations/:id/keys/:keyId     revoke                                         editor and up
//   POST   /api/console/organisations/:id/approvals/:aid  { decision: approve | reject }                 members who approve
//   GET    /api/console/organisations/:id/tasks/:tid      an agent task and its full action log             any member
//   POST   /api/console/organisations/:id/live-request    { systems, hospital, note }                    owner or admin
// Membership is checked on every call: an organisation is reachable only by its members, and only within their role.
import { and, asc, count, desc, eq, isNull } from 'drizzle-orm';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { INTEGRATIONS, INTEGRATION_STATUS_TEXT } from '../../../shared/integrations.ts';
import { REGIONS, type DataRegion } from '../../../shared/regions.ts';
import {
  organisationAccounts, organisationCalls, organisationKeys, organisationMembers, organisations, type OrganisationRole,
} from '../db/schema.ts';
import { verifyAgainstDummy, verifyPassword } from '../auth/password.ts';
import { findSession, readSessionToken } from '../auth/sessions.ts';
import { clientIp, readJson, UUID, type Deps } from '../http.ts';
import { HttpError, unauthorized } from '../lib/errors.ts';
import { RateLimiter } from '../lib/rate-limit.ts';
import { Email } from '../schemas.ts';
import { consoleAccountFor, isUniqueViolation, linkConsoleAccount, unlinkedByEmail, type OrganisationAccountRow } from './console-accounts.ts';
import { createOrganisation, createOrganisationKey, ORGANISATION_OPERATIONS, revokeOrganisationKey } from './organisations.ts';
import type { OrganisationRuntime } from './runtime.ts';
import { OPERATIONS, type OperationId } from './types.ts';

const MINUTE = 60_000;
const MAX_ORGS_PER_ACCOUNT = 5;
const MAX_ACTIVE_KEYS = 20;
const MAX_MEMBERS = 50;
const ROLES = ['owner', 'admin', 'editor', 'viewer'] as const satisfies readonly OrganisationRole[];
const RANK: Record<OrganisationRole, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

type ConsoleEnv = { Variables: { account: OrganisationAccountRow } };
type C = Context<ConsoleEnv>;
type MemberRow = typeof organisationMembers.$inferSelect;
type OrgRow = typeof organisations.$inferSelect;

const OrgName = z.string().trim().min(2, 'Give the organisation a name.').max(120);
const accountView = (a: OrganisationAccountRow) => ({ id: a.id, email: a.email, name: a.name });

export function consoleRoutes(deps: Deps, runtime: OrganisationRuntime) {
  const { db, config, cells } = deps;
  const app = new Hono<ConsoleEnv>();
  const keysByAccount = new RateLimiter(30, 60 * MINUTE);
  const linkByIp = new RateLimiter(20, 15 * MINUTE);
  const linkByUser = new RateLimiter(8, 15 * MINUTE);

  const served = () => cells.servedRegions.filter(r => r !== 'global').length ? cells.servedRegions.filter(r => r !== 'global') : cells.servedRegions;
  const Region = z.string().refine((r): r is DataRegion => served().includes(r as DataRegion), 'Choose a region this service holds data in.');

  async function makeOrganisation(account: OrganisationAccountRow, name: string, region: DataRegion) {
    const [{ n }] = await db.select({ n: count() }).from(organisationMembers).where(eq(organisationMembers.accountId, account.id));
    if (n >= MAX_ORGS_PER_ACCOUNT) throw new HttpError(409, 'too_many', `You can be in up to ${MAX_ORGS_PER_ACCOUNT} organisations.`);
    const org = await createOrganisation(db, name, region);
    // The person who makes it owns it, and may approve writes until they hand that to a clinician.
    await db.insert(organisationMembers).values({ organisationId: org.id, accountId: account.id, role: 'owner', approves: true });
    await runtime.ensureSandbox(org.id);
    return { id: org.id, name: org.name, region: org.region, access: org.access, role: 'owner' as const, approves: true };
  }

  /* ---------- the Health session opens the console ---------- */

  /** The signed-in Health session, or 401: the console uses the app's sign-in, not one of its own. */
  async function healthSession(c: Context) {
    const presented = readSessionToken(c);
    const session = presented ? await findSession(cells, presented.token, config.sessionTtlMs) : null;
    if (!session) throw unauthorized();
    return session;
  }

  const requireAccount: MiddlewareHandler<ConsoleEnv> = async (c, next) => {
    c.set('account', await consoleAccountFor(db, await healthSession(c)));
    await next();
  };

  // An earlier console account with this email, from when the console had its own sign-up: its console password,
  // once, joins it (and its organisations) to the signed-in Health account.
  app.post('/link', async c => {
    const session = await healthSession(c);
    const body = await readJson(c, z.object({ password: z.string().max(256) }));
    const wait = Math.max(linkByIp.hit(clientIp(c, config.trustProxy)), linkByUser.hit(session.user.id));
    if (wait) throw new HttpError(429, 'rate_limited', `Too many attempts. Try again in ${Math.ceil(wait / 60)} minutes.`);
    const earlier = await unlinkedByEmail(db, session.user.email);
    const ok = earlier?.passwordHash ? await verifyPassword(earlier.passwordHash, body.password) : await verifyAgainstDummy(body.password);
    if (!earlier || !ok) throw new HttpError(400, 'wrong_password', 'That is not the console password for this email.');
    linkByUser.reset(session.user.id);
    return c.json({ account: accountView(await linkConsoleAccount(db, earlier, session.user)) });
  });

  app.use('/', requireAccount);
  app.use('/organisations', requireAccount);
  app.use('/organisations/*', requireAccount);

  /** The caller's membership of an organisation, refusing anyone below `least`. Outsiders get a 404, never a 403. */
  async function membership(c: C, orgId: string, least: OrganisationRole = 'viewer'): Promise<{ member: MemberRow; org: OrgRow }> {
    if (!UUID.test(orgId)) throw new HttpError(404, 'not_found', 'No such organisation.');
    const [row] = await db.select({ member: organisationMembers, org: organisations }).from(organisationMembers)
      .innerJoin(organisations, eq(organisations.id, organisationMembers.organisationId))
      .where(and(eq(organisationMembers.organisationId, orgId), eq(organisationMembers.accountId, c.var.account.id))).limit(1);
    if (!row) throw new HttpError(404, 'not_found', 'No such organisation.');
    if (RANK[row.member.role] < RANK[least]) throw new HttpError(403, 'forbidden', `This needs the ${least} role or higher in ${row.org.name}.`);
    return row;
  }

  async function owners(orgId: string): Promise<number> {
    const [{ n }] = await db.select({ n: count() }).from(organisationMembers).where(and(eq(organisationMembers.organisationId, orgId), eq(organisationMembers.role, 'owner')));
    return n;
  }

  app.get('/', async c => {
    const a = c.var.account;
    const rows = await db.select({ org: organisations, role: organisationMembers.role, approves: organisationMembers.approves }).from(organisationMembers)
      .innerJoin(organisations, eq(organisations.id, organisationMembers.organisationId))
      .where(eq(organisationMembers.accountId, a.id)).orderBy(organisations.createdAt);
    return c.json({
      account: accountView(a),
      organisations: rows.map(r => ({ id: r.org.id, name: r.org.name, region: r.org.region, access: r.org.access, role: r.role, approves: r.approves })),
      regions: served().map(id => ({ id, name: REGIONS[id].name })),
      operations: ORGANISATION_OPERATIONS.map(id => OPERATIONS[id]),
      integrations: INTEGRATIONS.map(i => ({ ...i, statusText: INTEGRATION_STATUS_TEXT[i.status] })),
    });
  });

  app.post('/organisations', async c => {
    const body = await readJson(c, z.object({ name: OrgName, region: Region }));
    return c.json(await makeOrganisation(c.var.account, body.name, body.region as DataRegion), 201);
  });

  app.get('/organisations/:id', async c => {
    const { org, member } = await membership(c, c.req.param('id'));
    const [members, keys, connections, approvals, calls, tasks] = await Promise.all([
      db.select({ m: organisationMembers, email: organisationAccounts.email, name: organisationAccounts.name }).from(organisationMembers)
        .innerJoin(organisationAccounts, eq(organisationAccounts.id, organisationMembers.accountId))
        .where(eq(organisationMembers.organisationId, org.id)).orderBy(asc(organisationMembers.createdAt)),
      db.select().from(organisationKeys).where(eq(organisationKeys.organisationId, org.id)).orderBy(desc(organisationKeys.createdAt)),
      runtime.listConnections(org.id),
      runtime.listApprovals(org.id, 50),
      db.select().from(organisationCalls).where(eq(organisationCalls.organisationId, org.id)).orderBy(desc(organisationCalls.at)).limit(50),
      runtime.listTasks(org.id, 50),
    ]);
    return c.json({
      organisation: {
        id: org.id, name: org.name, region: org.region, access: org.access, liveRequestedAt: org.liveRequestedAt?.toISOString() ?? null,
        role: member.role, approves: member.approves,
      },
      members: members.map(r => ({ id: r.m.id, name: r.name, email: r.email, role: r.m.role, approves: r.m.approves, you: r.m.accountId === c.var.account.id, since: r.m.createdAt.toISOString() })),
      keys: keys.map(k => ({ id: k.id, name: k.name, prefix: k.prefix, operations: k.operations, createdAt: k.createdAt.toISOString(), lastUsedAt: k.lastUsedAt?.toISOString() ?? null, revokedAt: k.revokedAt?.toISOString() ?? null })),
      connections,
      approvals,
      tasks,
      agent: runtime.agentModel ? { model: runtime.agentModel } : null,
      calls: calls.map(x => ({ id: x.id, operation: x.operation, outcome: x.outcome, keyId: x.keyId, connectionId: x.connectionId, at: x.at.toISOString() })),
    });
  });

  /* ---------- members ---------- */

  app.post('/organisations/:id/members', async c => {
    const { org, member } = await membership(c, c.req.param('id'), 'admin');
    const body = await readJson(c, z.object({ email: Email, role: z.enum(ROLES), approves: z.boolean().default(false) }));
    if (body.role === 'owner' && member.role !== 'owner') throw new HttpError(403, 'forbidden', 'Only an owner can add another owner.');
    const [{ n }] = await db.select({ n: count() }).from(organisationMembers).where(eq(organisationMembers.organisationId, org.id));
    if (n >= MAX_MEMBERS) throw new HttpError(409, 'too_many', `An organisation can have up to ${MAX_MEMBERS} members.`);
    const [account] = await db.select().from(organisationAccounts).where(eq(organisationAccounts.email, body.email)).limit(1);
    if (!account) {
      throw new HttpError(400, 'account_required', 'This person has not opened the developer console yet. Ask them to sign in to LotusPond Health and open Developer console once, then add them again.');
    }
    try {
      const [row] = await db.insert(organisationMembers).values({ organisationId: org.id, accountId: account.id, role: body.role, approves: body.approves }).returning();
      return c.json({ id: row.id, name: account.name, email: account.email, role: row.role, approves: row.approves }, 201);
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(409, 'already_member', `${account.email} is already in ${org.name}.`);
      throw e;
    }
  });

  async function target(orgId: string, mid: string): Promise<MemberRow> {
    if (!UUID.test(mid)) throw new HttpError(404, 'not_found', 'No such member.');
    const [row] = await db.select().from(organisationMembers).where(and(eq(organisationMembers.id, mid), eq(organisationMembers.organisationId, orgId))).limit(1);
    if (!row) throw new HttpError(404, 'not_found', 'No such member.');
    return row;
  }

  app.patch('/organisations/:id/members/:mid', async c => {
    const { org, member } = await membership(c, c.req.param('id'), 'admin');
    const them = await target(org.id, c.req.param('mid'));
    const body = await readJson(c, z.object({ role: z.enum(ROLES).optional(), approves: z.boolean().optional() }));
    const touchesOwner = them.role === 'owner' || body.role === 'owner';
    if (touchesOwner && member.role !== 'owner') throw new HttpError(403, 'forbidden', 'Only an owner can change an owner, or make someone an owner.');
    if (them.role === 'owner' && body.role && body.role !== 'owner' && (await owners(org.id)) <= 1) {
      throw new HttpError(409, 'last_owner', 'An organisation needs at least one owner. Make someone else an owner first.');
    }
    const [row] = await db.update(organisationMembers).set({ ...(body.role ? { role: body.role } : {}), ...(body.approves === undefined ? {} : { approves: body.approves }) })
      .where(eq(organisationMembers.id, them.id)).returning();
    return c.json({ id: row.id, role: row.role, approves: row.approves });
  });

  app.delete('/organisations/:id/members/:mid', async c => {
    const { org, member } = await membership(c, c.req.param('id'));
    const them = await target(org.id, c.req.param('mid'));
    const leaving = them.id === member.id;
    if (!leaving && RANK[member.role] < RANK.admin) throw new HttpError(403, 'forbidden', `This needs the admin role or higher in ${org.name}.`);
    if (!leaving && them.role === 'owner' && member.role !== 'owner') throw new HttpError(403, 'forbidden', 'Only an owner can remove an owner.');
    if (them.role === 'owner' && (await owners(org.id)) <= 1) {
      throw new HttpError(409, 'last_owner', 'An organisation needs at least one owner. Make someone else an owner first.');
    }
    await db.delete(organisationMembers).where(eq(organisationMembers.id, them.id));
    return c.json({ ok: true });
  });

  /* ---------- keys, approvals, live access ---------- */

  app.post('/organisations/:id/keys', async c => {
    const { org } = await membership(c, c.req.param('id'), 'editor');
    const body = await readJson(c, z.object({
      name: z.string().trim().min(1).max(60),
      operations: z.array(z.enum(ORGANISATION_OPERATIONS as [OperationId, ...OperationId[]])).min(1).max(ORGANISATION_OPERATIONS.length),
    }));
    const wait = keysByAccount.hit(c.var.account.id);
    if (wait) throw new HttpError(429, 'rate_limited', `Too many new keys. Try again in ${Math.ceil(wait / 60)} minutes.`);
    const active = await db.select({ id: organisationKeys.id }).from(organisationKeys).where(and(eq(organisationKeys.organisationId, org.id), isNull(organisationKeys.revokedAt)));
    if (active.length >= MAX_ACTIVE_KEYS) throw new HttpError(409, 'too_many', `An organisation can have up to ${MAX_ACTIVE_KEYS} active keys. Revoke one first.`);
    const { key, row } = await createOrganisationKey(db, org.id, body.name, body.operations);
    return c.json({ key, id: row.id, name: row.name, prefix: row.prefix, operations: row.operations }, 201);
  });

  app.delete('/organisations/:id/keys/:keyId', async c => {
    const { org } = await membership(c, c.req.param('id'), 'editor');
    const keyId = c.req.param('keyId');
    if (!UUID.test(keyId)) throw new HttpError(404, 'not_found', 'No such key.');
    const [k] = await db.select({ id: organisationKeys.id }).from(organisationKeys).where(and(eq(organisationKeys.id, keyId), eq(organisationKeys.organisationId, org.id))).limit(1);
    if (!k) throw new HttpError(404, 'not_found', 'No such key.');
    await revokeOrganisationKey(db, keyId);
    return c.json({ ok: true });
  });

  app.post('/organisations/:id/approvals/:aid', async c => {
    const { org, member } = await membership(c, c.req.param('id'));
    if (!member.approves) throw new HttpError(403, 'forbidden', 'Only members marked as approvers (clinicians) can decide on writes. An owner or admin can mark you on Members.');
    const aid = c.req.param('aid');
    if (!UUID.test(aid)) throw new HttpError(404, 'not_found', 'No such approval.');
    const body = await readJson(c, z.object({ decision: z.enum(['approve', 'reject']) }));
    return c.json(await runtime.decide(org.id, aid, body.decision, `${c.var.account.email} (${member.role})`));
  });

  app.get('/organisations/:id/tasks/:tid', async c => {
    const { org } = await membership(c, c.req.param('id'));
    const tid = c.req.param('tid');
    const task = UUID.test(tid) ? await runtime.getTask(org.id, tid) : null;
    if (!task) throw new HttpError(404, 'not_found', 'No such task.');
    return c.json({ task, actions: await runtime.taskActions(org.id, tid) ?? [] });
  });

  app.post('/organisations/:id/live-request', async c => {
    const { org } = await membership(c, c.req.param('id'), 'admin');
    const body = await readJson(c, z.object({
      systems: z.string().trim().min(2).max(300),
      hospital: z.string().trim().min(2).max(300),
      note: z.string().trim().max(2000).default(''),
    }));
    await db.update(organisations).set({ liveRequestedAt: new Date(), liveRequest: { ...body, by: c.var.account.email } }).where(eq(organisations.id, org.id));
    console.log(`[console] live access requested for organisation ${org.id}`);
    return c.json({ ok: true });
  });

  return app;
}
