// The app's view of agent connections (Account, Connected agents):
//   GET    /api/agents          connections and the MCP address
//   POST   /api/agents/tokens   create an access token for an agent that takes one (Claude Desktop, Claude Code, scripts)
//   PATCH  /api/agents/:id      change the profiles or permissions of a connection
//   DELETE /api/agents/:id      disconnect: the agent's tokens stop working at once
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { AGENT_SCOPES, MCP_PATH, type AgentConnectionsInfo, type CreatedAgentToken } from '../../../shared/agents.ts';
import { eventContext, recordEvent } from '../compliance/audit.ts';
import { agentGrants } from '../db/schema.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { readJson, requireAuth, UUID, type AppEnv, type Deps } from '../http.ts';
import { cleanScopes, deleteGrant, issueSecret, listGrants, ownProfiles, toConnection } from './grants.ts';
import { publicOrigin } from './oauth.ts';

const MAX_CONNECTIONS = 25;
const Scopes = z.array(z.enum(AGENT_SCOPES as [string, ...string[]])).min(1).max(AGENT_SCOPES.length);
const ProfileIds = z.array(z.string().regex(UUID)).min(1, 'Choose at least one profile.').max(50);

const CreateBody = z.object({
  name: z.string().trim().min(1, 'Name the agent.').max(60),
  scopes: Scopes,
  profileIds: ProfileIds,
  expiresInDays: z.number().int().min(1).max(365).nullable(),
});
const PatchBody = z.object({ scopes: Scopes.optional(), profileIds: ProfileIds.optional() });

export function agentRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth(deps));

  app.get('/', async c => {
    const rows = await listGrants(c.var.cell.db, c.var.user.id);
    const body: AgentConnectionsInfo = { mcpUrl: `${publicOrigin(c, deps.config)}${MCP_PATH}`, connections: rows.map(toConnection) };
    return c.json(body);
  });

  app.post('/tokens', async c => {
    const { db } = c.var.cell;
    const body = await readJson(c, CreateBody);
    const existing = await listGrants(db, c.var.user.id);
    if (existing.length >= MAX_CONNECTIONS) throw conflict(`An account can have up to ${MAX_CONNECTIONS} connected agents. Disconnect one first.`);
    const profileIds = await ownProfiles(db, c.var.user.id, [...new Set(body.profileIds)]);
    if (profileIds.length !== new Set(body.profileIds).size) throw badRequest('A chosen profile is not in this account.');
    const scopes = cleanScopes(['health:read', ...body.scopes]);
    const [grant] = await db.insert(agentGrants).values({
      userId: c.var.user.id, kind: 'token', clientId: null, name: body.name, redirectHost: null, scopes, profileIds,
      expiresAt: body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 24 * 60 * 60_000) : null,
    }).returning();
    const token = await issueSecret(db, c.var.user.region, grant.id, 'personal');
    await recordEvent(db, eventContext(c, deps), c.var.user.id, 'agent_connected', { connectionId: grant.id });
    const out: CreatedAgentToken = { connection: toConnection(grant), token, mcpUrl: `${publicOrigin(c, deps.config)}${MCP_PATH}` };
    return c.json(out, 201);
  });

  app.patch('/:id', async c => {
    const id = c.req.param('id');
    if (!UUID.test(id)) throw notFound('That connection');
    const { db } = c.var.cell;
    const body = await readJson(c, PatchBody);
    const set: Partial<typeof agentGrants.$inferInsert> = {};
    if (body.scopes) set.scopes = cleanScopes(['health:read', ...body.scopes]);
    if (body.profileIds) {
      const own = await ownProfiles(db, c.var.user.id, [...new Set(body.profileIds)]);
      if (own.length !== new Set(body.profileIds).size) throw badRequest('A chosen profile is not in this account.');
      set.profileIds = own;
    }
    if (!Object.keys(set).length) throw badRequest('Nothing to change.');
    const [row] = await db.update(agentGrants).set(set).where(and(eq(agentGrants.id, id), eq(agentGrants.userId, c.var.user.id))).returning();
    if (!row) throw notFound('That connection');
    return c.json(toConnection(row));
  });

  app.delete('/:id', async c => {
    const id = c.req.param('id');
    if (!UUID.test(id)) throw notFound('That connection');
    const gone = await deleteGrant(c.var.cell.db, c.var.user.id, id);
    if (!gone) throw notFound('That connection');
    await recordEvent(c.var.cell.db, eventContext(c, deps), c.var.user.id, 'agent_disconnected', { connectionId: id });
    return c.body(null, 204);
  });

  return app;
}
