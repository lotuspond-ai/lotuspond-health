// Running organisation operations: the one place the REST API (/v1), the organisation MCP server (/v1/mcp) and the
// developer console go through. It checks the connection belongs to the organisation and is active, that a live
// system is reached only by an organisation LotusPond has given live access, holds writes that need a clinician until
// someone on the organisation's side approves them, runs the adapter and records every call.
import { and, desc, eq } from 'drizzle-orm';
import { integrationById } from '../../../shared/integrations.ts';
import type { FileKeyring } from '../compliance/secrets.ts';
import type { Db } from '../db/client.ts';
import { organisationApprovals, organisationCalls, organisationConnections, organisations } from '../db/schema.ts';
import { HttpError } from '../lib/errors.ts';
import { keyringSealer } from '../lab/sealer.ts';
import { HIS_ADAPTERS, HisError, type HisSecret } from './his/index.ts';
import { OPERATION_INPUT, isRunnable, type RunnableOperation } from './his/operations.ts';
import { OPERATIONS, type OperationId } from './types.ts';
import type { BrowserProvider } from '../records/browsers.ts';
import type { ComputerModel } from './agent/model.ts';
import { agentTasks, type ActionView, type TaskView } from './agent/tasks.ts';

export type ConnectionRow = typeof organisationConnections.$inferSelect;
export type ApprovalRow = typeof organisationApprovals.$inferSelect;
type OrgRow = typeof organisations.$inferSelect;

export type CallOutcome = 'done' | 'pending' | 'refused' | 'not_offered' | 'failed';

/** What a caller may see about a connection: never its credentials. */
export interface ConnectionView {
  id: string;
  connector: string;
  name: string;
  sandbox: boolean;
  status: 'active' | 'disabled';
  operations: RunnableOperation[];
  lastOkAt: string | null;
  lastError: string | null;
}

export interface ApprovalView {
  id: string;
  operation: string;
  connection: string;
  summary: string;
  status: ApprovalRow['status'];
  result: unknown;
  error: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export type RunResult =
  | { status: 'done'; operation: RunnableOperation; connection: string; result: unknown }
  | { status: 'pending_approval'; operation: RunnableOperation; connection: string; approval: ApprovalView };

export interface OrganisationRuntimeOptions {
  db: Db;
  /** File keyrings by region (secrets.fileKeys); credentials and held inputs are sealed with the organisation's region's keys. */
  keyrings: Partial<Record<string, FileKeyring>> | null;
  fetch?: typeof fetch;
  now?: () => Date;
  /** The computer-use agent for tasks.run; without it, tasks.run is refused (503 agent_off). */
  agent?: { model: ComputerModel; browsers: BrowserProvider; selfUrl: string; concurrency: number; deadlineMs?: number } | null;
}

const toView = (c: ConnectionRow): ConnectionView => ({
  id: c.id, connector: c.connectorId, name: c.name, sandbox: c.connectorId === 'sandbox', status: c.status,
  operations: HIS_ADAPTERS.get(c.connectorId)?.operations ?? [],
  lastOkAt: c.lastOkAt?.toISOString() ?? null, lastError: c.lastError,
});

export const approvalView = (a: ApprovalRow): ApprovalView => ({
  id: a.id, operation: a.operation, connection: a.connectionId, summary: a.summary, status: a.status,
  result: a.result ?? null, error: a.error, decidedBy: a.decidedBy, decidedAt: a.decidedAt?.toISOString() ?? null, createdAt: a.createdAt.toISOString(),
});

export function organisationRuntime(o: OrganisationRuntimeOptions) {
  const { db } = o;
  const now = o.now ?? (() => new Date());
  const doFetch = o.fetch ?? fetch;
  const sealerFor = (region: string) => keyringSealer(o.keyrings?.[region] ?? o.keyrings?.default ?? null);
  const seal = (region: string, plain: string, context: string) => Buffer.from(sealerFor(region).seal(Buffer.from(plain, 'utf8'), `org:${context}`)).toString('base64');
  const open = (region: string, sealed: string, context: string) => Buffer.from(sealerFor(region).open(Buffer.from(sealed, 'base64'), `org:${context}`)).toString('utf8');
  const tasks = o.agent ? agentTasks({
    db, model: o.agent.model, browsers: o.agent.browsers, selfUrl: o.agent.selfUrl, concurrency: o.agent.concurrency, deadlineMs: o.agent.deadlineMs, now,
    sealing: region => ({ seal: (plain, context) => seal(region, plain, context), open: (sealed, context) => open(region, sealed, context) }),
  }) : null;

  async function org(id: string): Promise<OrgRow> {
    const [row] = await db.select().from(organisations).where(eq(organisations.id, id)).limit(1);
    if (!row) throw new HttpError(404, 'not_found', 'No such organisation.');
    return row;
  }

  async function record(c: { organisationId: string; keyId: string | null; operation: string; outcome: CallOutcome; connectionId?: string | null }) {
    await db.insert(organisationCalls).values({ organisationId: c.organisationId, keyId: c.keyId, operation: c.operation, outcome: c.outcome, connectionId: c.connectionId ?? null });
  }

  /** Every organisation has one sandbox connection, made on first use. */
  async function ensureSandbox(organisationId: string): Promise<ConnectionRow> {
    const [found] = await db.select().from(organisationConnections)
      .where(and(eq(organisationConnections.organisationId, organisationId), eq(organisationConnections.connectorId, 'sandbox'))).limit(1);
    if (found) return found;
    const [row] = await db.insert(organisationConnections).values({ organisationId, connectorId: 'sandbox', name: 'Sandbox hospital' }).returning();
    return row;
  }

  async function listConnections(organisationId: string): Promise<ConnectionView[]> {
    await ensureSandbox(organisationId);
    const rows = await db.select().from(organisationConnections).where(eq(organisationConnections.organisationId, organisationId)).orderBy(organisationConnections.createdAt);
    return rows.map(toView);
  }

  /**
   * Add a connection to a real system. Only LotusPond does this (the server's command line), after checking the
   * organisation's written authority, so self-serve organisations cannot point the server at an address of their choosing.
   */
  async function addConnection(organisationId: string, c: { connectorId: string; name: string; settings: Record<string, string>; secret: HisSecret | null }): Promise<ConnectionView> {
    const o2 = await org(organisationId);
    const adapter = HIS_ADAPTERS.get(c.connectorId);
    if (!adapter || c.connectorId === 'sandbox') throw new HttpError(400, 'unknown_connector', `There is no connector "${c.connectorId}" that can be added. Runnable: ${[...HIS_ADAPTERS.keys()].filter(k => k !== 'sandbox').join(', ')}.`);
    if (o2.access !== 'live') throw new HttpError(409, 'not_live', 'Give the organisation live access first, once its written authority is checked.');
    const missing = adapter.requiredSettings.filter(k => !c.settings[k]);
    if (missing.length) throw new HttpError(400, 'missing_settings', `This connector needs: ${missing.join(', ')}.`);
    const [row] = await db.insert(organisationConnections).values({ organisationId, connectorId: c.connectorId, name: c.name.trim() || integrationById(c.connectorId)?.name || c.connectorId, settings: c.settings }).returning();
    if (c.secret) {
      await db.update(organisationConnections).set({ secretCt: seal(o2.region, JSON.stringify(c.secret), `connection:${row.id}`) }).where(eq(organisationConnections.id, row.id));
    }
    return toView(row);
  }

  async function setConnectionStatus(organisationId: string, connectionId: string, status: 'active' | 'disabled'): Promise<boolean> {
    const rows = await db.update(organisationConnections).set({ status })
      .where(and(eq(organisationConnections.id, connectionId), eq(organisationConnections.organisationId, organisationId))).returning({ id: organisationConnections.id });
    return rows.length > 0;
  }

  async function connectionFor(o2: OrgRow, connectionId: string): Promise<ConnectionRow> {
    const [c] = await db.select().from(organisationConnections)
      .where(and(eq(organisationConnections.id, connectionId), eq(organisationConnections.organisationId, o2.id))).limit(1);
    if (!c) throw new HttpError(404, 'connection_not_found', 'This organisation has no such connection. See GET /v1/connections.');
    if (c.status !== 'active') throw new HttpError(409, 'connection_disabled', 'This connection is switched off.');
    if (c.connectorId !== 'sandbox' && o2.access !== 'live') throw new HttpError(403, 'not_live', 'This organisation has sandbox access only. Ask for live access in the developer console.');
    return c;
  }

  function secretOf(o2: OrgRow, c: ConnectionRow): HisSecret | null {
    if (!c.secretCt) return null;
    try { return JSON.parse(open(o2.region, c.secretCt, `connection:${c.id}`)) as HisSecret; } catch (e) {
      console.error(`[org] cannot open the credentials of connection ${c.id}`, e);
      throw new HttpError(502, 'connection_credentials', "LotusPond cannot read this connection's credentials. LotusPond needs to set them again.");
    }
  }

  async function saveSecret(o2: OrgRow, connectionId: string, secret: HisSecret): Promise<void> {
    await db.update(organisationConnections).set({ secretCt: seal(o2.region, JSON.stringify(secret), `connection:${connectionId}`) }).where(eq(organisationConnections.id, connectionId));
  }

  /** Run the adapter for a connection and note the outcome on it. HisErrors become HttpErrors with the same status. */
  async function execute(o2: OrgRow, c: ConnectionRow, op: RunnableOperation, input: unknown): Promise<unknown> {
    const adapter = HIS_ADAPTERS.get(c.connectorId);
    if (!adapter || !adapter.operations.includes(op)) throw new HttpError(422, 'not_supported', `${integrationById(c.connectorId)?.name ?? c.connectorId} does not run ${op}.`);
    const secret = secretOf(o2, c);
    try {
      const out = await adapter.run(op, input as never, { connectionId: c.id, settings: c.settings, secret, fetch: doFetch, now: now() });
      await db.update(organisationConnections).set({ lastOkAt: now(), lastError: null }).where(eq(organisationConnections.id, c.id));
      return out;
    } catch (e) {
      if (e instanceof HisError) {
        if (e.status >= 500) await db.update(organisationConnections).set({ lastError: e.message }).where(eq(organisationConnections.id, c.id));
        throw new HttpError(e.status, e.code, e.message);
      }
      await db.update(organisationConnections).set({ lastError: 'Unexpected error' }).where(eq(organisationConnections.id, c.id));
      throw e;
    }
  }

  /**
   * One call from a key. `allowed` is the key's operation list. Reads run at once; writes that need a clinician are
   * held as an approval with the input sealed, and run when someone on the organisation's side approves them.
   */
  async function run(organisationId: string, keyId: string | null, allowed: string[], operationId: string, raw: unknown): Promise<RunResult> {
    const o2 = await org(organisationId);
    const spec = Object.hasOwn(OPERATIONS, operationId) ? OPERATIONS[operationId as OperationId] : undefined;
    if (!spec) throw new HttpError(404, 'unknown_operation', `There is no operation "${operationId}". See GET /v1/connectors for the list.`);
    const refuse = async (status: 403 | 501, code: string, message: string, outcome: CallOutcome): Promise<never> => {
      await record({ organisationId, keyId, operation: spec.id, outcome });
      throw new HttpError(status, code, message, { operation: spec.id });
    };
    if (!spec.authority.includes('organisation')) return refuse(403, 'wrong_authority', `${spec.id} runs only on a person's own authority (LotusPond Health); an organisation cannot call it.`, 'refused');
    if (!allowed.includes(spec.id)) return refuse(403, 'not_in_key', `This key may not call ${spec.id}. Make a key that includes it in the developer console.`, 'refused');
    if (!isRunnable(spec.id) || spec.stage !== 'live') return refuse(501, 'operation_not_offered', `${spec.id} is planned and not offered yet. Its contract is in GET /v1/connectors.`, 'not_offered');
    const op: RunnableOperation = spec.id;
    const parsed = OPERATION_INPUT[op].safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      await record({ organisationId, keyId, operation: op, outcome: 'refused' });
      throw new HttpError(400, 'invalid_input', `${issue?.path.length ? `${issue.path.join('.')}: ` : ''}${issue?.message ?? 'The input was not valid.'}`, { operation: op });
    }
    const input = parsed.data;
    let c: ConnectionRow;
    try { c = await connectionFor(o2, input.connection); } catch (e) {
      await record({ organisationId, keyId, operation: op, outcome: 'refused' });
      throw e;
    }
    // A connection that cannot run this operation is refused now, not after a person has approved the write.
    const adapter = HIS_ADAPTERS.get(c.connectorId);
    if (!adapter || !adapter.operations.includes(op)) {
      await record({ organisationId, keyId, operation: op, outcome: 'refused', connectionId: c.id });
      throw new HttpError(422, 'not_supported', `${integrationById(c.connectorId)?.name ?? c.connectorId} does not run ${op}.`, { operation: op });
    }
    if (op === 'tasks.run' && !tasks) {
      await record({ organisationId, keyId, operation: op, outcome: 'refused', connectionId: c.id });
      throw new HttpError(503, 'agent_off', 'The computer-use agent is not switched on on this server.', { operation: op });
    }
    if (spec.writes && spec.approval !== 'none') {
      const summary = summarise(op, input as Record<string, unknown>);
      const [a] = await db.insert(organisationApprovals).values({
        organisationId, connectionId: c.id, keyId, operation: op, summary, inputCt: 'pending',
      }).returning();
      await db.update(organisationApprovals).set({ inputCt: seal(o2.region, JSON.stringify(input), `approval:${a.id}`) }).where(eq(organisationApprovals.id, a.id));
      await record({ organisationId, keyId, operation: op, outcome: 'pending', connectionId: c.id });
      return { status: 'pending_approval', operation: op, connection: c.id, approval: approvalView({ ...a, inputCt: '' }) };
    }
    try {
      const result = await execute(o2, c, op, input);
      await record({ organisationId, keyId, operation: op, outcome: 'done', connectionId: c.id });
      return { status: 'done', operation: op, connection: c.id, result };
    } catch (e) {
      await record({ organisationId, keyId, operation: op, outcome: 'failed', connectionId: c.id });
      throw e;
    }
  }

  async function getApproval(organisationId: string, approvalId: string): Promise<ApprovalView | null> {
    const [a] = await db.select().from(organisationApprovals)
      .where(and(eq(organisationApprovals.id, approvalId), eq(organisationApprovals.organisationId, organisationId))).limit(1);
    return a ? approvalView(a) : null;
  }

  async function listApprovals(organisationId: string, limit = 50): Promise<ApprovalView[]> {
    const rows = await db.select().from(organisationApprovals).where(eq(organisationApprovals.organisationId, organisationId))
      .orderBy(desc(organisationApprovals.createdAt)).limit(limit);
    return rows.map(approvalView);
  }

  /** Approve (and send) or reject a held write. `by` names the approver for the record. */
  async function decide(organisationId: string, approvalId: string, decision: 'approve' | 'reject', by: string): Promise<ApprovalView> {
    const o2 = await org(organisationId);
    // Claim it first, so two approvers clicking at once cannot send it twice.
    const claimed = await db.update(organisationApprovals).set({ status: decision === 'approve' ? 'done' : 'rejected', decidedBy: by, decidedAt: now() })
      .where(and(eq(organisationApprovals.id, approvalId), eq(organisationApprovals.organisationId, organisationId), eq(organisationApprovals.status, 'pending'))).returning();
    const a = claimed[0];
    if (!a) {
      const existing = await getApproval(organisationId, approvalId);
      if (!existing) throw new HttpError(404, 'not_found', 'No such approval.');
      throw new HttpError(409, 'already_decided', `This was already ${existing.status === 'rejected' ? 'rejected' : 'decided'}.`);
    }
    if (decision === 'reject') {
      await db.update(organisationApprovals).set({ inputCt: '' }).where(eq(organisationApprovals.id, a.id));
      return approvalView({ ...a, inputCt: '' });
    }
    let result: unknown = null;
    let error: string | null = null;
    try {
      const c = await connectionFor(o2, a.connectionId);
      const input = JSON.parse(open(o2.region, a.inputCt, `approval:${a.id}`)) as unknown;
      if (a.operation === 'tasks.run') {
        // Approving an agent task starts it; the approval's result names the task to follow.
        if (!tasks) throw new HttpError(503, 'agent_off', 'The computer-use agent is not switched on on this server.');
        const t = OPERATION_INPUT['tasks.run'].parse(input);
        const task = await tasks.start({
          organisationId, region: o2.region, organisation: o2.name, connection: c, approvalId: a.id, keyId: a.keyId, summary: a.summary,
          input: t, secret: secretOf(o2, c), saveSecret: s => saveSecret(o2, c.id, s),
        });
        result = { task: task.id, status: task.status };
      } else {
        result = await execute(o2, c, a.operation as RunnableOperation, input);
      }
    } catch (e) {
      error = e instanceof HttpError ? e.message : 'The write could not be sent. Try again from the console.';
      if (!(e instanceof HttpError)) console.error('[org] approved write failed', e);
    }
    // The held input is dropped once sent (or failed): the document lives in the hospital's system, not here.
    const [done] = await db.update(organisationApprovals).set({ status: error ? 'failed' : 'done', result: result ?? null, error, inputCt: '' })
      .where(eq(organisationApprovals.id, a.id)).returning();
    await record({ organisationId, keyId: null, operation: a.operation, outcome: error ? 'failed' : 'done', connectionId: a.connectionId });
    return approvalView(done);
  }

  async function getTask(organisationId: string, id: string): Promise<TaskView | null> {
    if (!tasks) return null;
    return tasks.get(organisationId, (await org(organisationId)).region, id);
  }
  async function listTasks(organisationId: string, limit = 50): Promise<TaskView[]> {
    if (!tasks) return [];
    return tasks.list(organisationId, (await org(organisationId)).region, limit);
  }
  async function taskActions(organisationId: string, id: string): Promise<ActionView[] | null> {
    if (!tasks) return null;
    return tasks.actions(organisationId, (await org(organisationId)).region, id);
  }

  /** Save the web app's sign-in for the agent on a connection (org:web-signin), keeping its other credentials. */
  async function setWebSession(organisationId: string, connectionId: string, webSession: NonNullable<HisSecret['webSession']>): Promise<void> {
    const o2 = await org(organisationId);
    const [c] = await db.select().from(organisationConnections).where(and(eq(organisationConnections.id, connectionId), eq(organisationConnections.organisationId, organisationId))).limit(1);
    if (!c) throw new HttpError(404, 'connection_not_found', 'This organisation has no such connection.');
    await saveSecret(o2, c.id, { ...(secretOf(o2, c) ?? {}), webSession });
  }

  return {
    ensureSandbox, listConnections, addConnection, setConnectionStatus, run, getApproval, listApprovals, decide,
    getTask, listTasks, taskActions, setWebSession,
    agentModel: tasks?.model ?? null,
    recoverTasks: () => tasks?.recover() ?? Promise.resolve(0),
    tasksIdle: (stop = false) => tasks?.idle(stop) ?? Promise.resolve(),
  };
}

export type OrganisationRuntime = ReturnType<typeof organisationRuntime>;

/** A short line for the approver: what, for which patient id, titled what. No document contents. */
function summarise(op: RunnableOperation, input: Record<string, unknown>): string {
  if (op === 'documents.upload') {
    return `Upload "${String(input.title).slice(0, 80)}" (${String(input.contentType)}) to patient ${String(input.patient)}${input.encounter ? `, encounter ${String(input.encounter)}` : ''}${input.author ? `, by ${String(input.author).slice(0, 60)}` : ''}`;
  }
  if (op === 'tasks.run') {
    // The approver must read what the agent will do, so the instruction is shown in full (up to 600 characters).
    return `Agent task${input.patient ? ` for patient ${String(input.patient)}` : ''}: "${String(input.instruction).slice(0, 600)}"`;
  }
  return `${op} for ${String(input.patient ?? input.claim ?? '')}`;
}
