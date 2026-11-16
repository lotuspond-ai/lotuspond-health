// The organisation API of the connector core, part of LotusPond Health (LotusPond Works never hosts or calls it). Every request carries an organisation's API key:
//   GET  /v1/organisation              who the key belongs to, and which operations it may call
//   POST /v1/operations/:operation     run an operation on the organisation's authority
// An operation that runs only on a person's authority (records.fetch) is refused, as is one outside the key's list;
// a planned operation answers 501 until its first adapter is live. Every call is recorded (organisation_calls).
// No cookies or browsers are involved: these are server-to-server calls.
import { Hono } from 'hono';
import type { Db } from '../db/client.ts';
import { HttpError } from '../lib/errors.ts';
import { authenticateOrganisation, recordCall, type OrganisationKeyRow, type OrganisationRow } from './organisations.ts';
import { OPERATIONS, type OperationId } from './types.ts';

type Env = { Variables: { org: OrganisationRow; orgKey: OrganisationKeyRow } };

export function organisationRoutes(db: Db) {
  const app = new Hono<Env>();

  app.use('*', async (c, next) => {
    const auth = c.req.header('authorization') ?? '';
    const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const found = key ? await authenticateOrganisation(db, key) : null;
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
    return c.json({ id: org.id, name: org.name, region: org.region, key: { id: orgKey.id, name: orgKey.name, prefix: orgKey.prefix, operations: orgKey.operations } });
  });

  app.post('/operations/:operation', async c => {
    const { org, orgKey } = c.var;
    const id = c.req.param('operation');
    const op = (Object.hasOwn(OPERATIONS, id) ? OPERATIONS[id as OperationId] : undefined);
    if (!op) throw new HttpError(404, 'unknown_operation', `There is no operation "${id}". See GET /v1/connectors for the list.`);
    const refuse = async (status: 403 | 501, code: string, message: string, outcome: 'refused' | 'not_offered'): Promise<never> => {
      await recordCall(db, { organisationId: org.id, keyId: orgKey.id, operation: op.id, outcome });
      throw new HttpError(status, code, message, { operation: op.id });
    };
    if (!op.authority.includes('organisation')) {
      return refuse(403, 'wrong_authority', `${op.id} runs only on a person's own authority (LotusPond Health); an organisation cannot call it.`, 'refused');
    }
    if (!orgKey.operations.includes(op.id)) return refuse(403, 'not_in_key', `This key may not call ${op.id}. Ask for a key that includes it.`, 'refused');
    // No adapter is live for any organisation operation yet: the contract is published, the call is recorded.
    return refuse(501, 'operation_not_offered', `${op.id} is planned and not offered yet. Its contract is in GET /v1/connectors.`, 'not_offered');
  });

  return app;
}
