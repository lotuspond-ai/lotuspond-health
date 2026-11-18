// The organisation API of the connector core, part of LotusPond Health (LotusPond Works never hosts or calls it). Every request carries an organisation's API key:
//   GET  /v1/organisation              who the key belongs to, its access (sandbox or live) and which operations it may call
//   GET  /v1/connections               the organisation's connections: its sandbox hospital, and real systems LotusPond set up
//   POST /v1/operations/:operation     run an operation on one connection: { "connection": "…", …input }
//   GET  /v1/approvals/:id             a held write: pending until someone on the organisation's side approves it
//   GET  /v1/tasks                     the computer-use agent's tasks (tasks.run), newest first
//   GET  /v1/tasks/:id                 one task: queued, running, succeeded, failed, cannot, needs_sign_in or needs_review
//   GET  /v1/tasks/:id/actions         every action the agent took in the system, in order: the audit log
// An operation that runs only on a person's authority (records.fetch) is refused, as is one outside the key's list;
// a planned operation answers 501. Every call is recorded (organisation_calls). No cookies or browsers are involved.
import { Hono } from 'hono';
import type { Db } from '../db/client.ts';
import { HttpError } from '../lib/errors.ts';
import { authenticateOrganisation, type OrganisationKeyRow, type OrganisationRow } from './organisations.ts';
import type { OrganisationRuntime } from './runtime.ts';

type Env = { Variables: { org: OrganisationRow; orgKey: OrganisationKeyRow } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Check the bearer key on a request; sets org and orgKey. Shared with the organisation MCP endpoint. */
export async function organisationFromRequest(db: Db, authorization: string | undefined) {
  const key = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  return key ? authenticateOrganisation(db, key) : null;
}

export function organisationRoutes(db: Db, runtime: OrganisationRuntime) {
  const app = new Hono<Env>();

  app.use('*', async (c, next) => {
    const found = await organisationFromRequest(db, c.req.header('authorization'));
    if (!found) {
      c.header('WWW-Authenticate', 'Bearer realm="LotusPond", error="invalid_token"');
      throw new HttpError(401, 'invalid_key', 'Send an organisation API key: Authorization: Bearer lpk_…');
    }
    c.set('org', found.org);
    c.set('orgKey', found.key);
    c.header('Cache-Control', 'no-store');
    await next();
  });

  app.get('/organisation', c => {
    const { org, orgKey } = c.var;
    return c.json({ id: org.id, name: org.name, region: org.region, access: org.access, key: { id: orgKey.id, name: orgKey.name, prefix: orgKey.prefix, operations: orgKey.operations } });
  });

  app.get('/connections', async c => c.json({ connections: await runtime.listConnections(c.var.org.id) }));

  app.post('/operations/:operation', async c => {
    const { org, orgKey } = c.var;
    let body: unknown = {};
    const text = await c.req.text();
    if (text.trim()) {
      try { body = JSON.parse(text); } catch { throw new HttpError(400, 'invalid_json', 'Send the input as a JSON object.'); }
    }
    const out = await runtime.run(org.id, orgKey.id, orgKey.operations, c.req.param('operation'), body);
    return c.json(out, out.status === 'pending_approval' ? 202 : 200);
  });

  app.get('/approvals/:id', async c => {
    const id = c.req.param('id');
    const a = UUID.test(id) ? await runtime.getApproval(c.var.org.id, id) : null;
    if (!a) throw new HttpError(404, 'not_found', 'No such approval for this organisation.');
    return c.json(a);
  });

  app.get('/tasks', async c => c.json({ tasks: await runtime.listTasks(c.var.org.id, 50) }));

  app.get('/tasks/:id', async c => {
    const id = c.req.param('id');
    const t = UUID.test(id) ? await runtime.getTask(c.var.org.id, id) : null;
    if (!t) throw new HttpError(404, 'not_found', 'No such task for this organisation.');
    return c.json(t);
  });

  app.get('/tasks/:id/actions', async c => {
    const id = c.req.param('id');
    const actions = UUID.test(id) ? await runtime.taskActions(c.var.org.id, id) : null;
    if (!actions) throw new HttpError(404, 'not_found', 'No such task for this organisation.');
    return c.json({ task: id, actions });
  });

  return app;
}
