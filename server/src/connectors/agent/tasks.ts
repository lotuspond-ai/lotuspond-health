// Tasks for the computer-use agent (tasks.run): made when a clinician approves one, run in the background, at most
// `concurrency` at a time, each in a new browser from the configured provider (local Chromium, a CDP service or
// Browserbase: records/browsers.ts), reaching only the web app's hosts. A real system's saved sign-in is loaded into
// the browser and saved back after the task (cookies renew); nothing else carries over between tasks.
//
// Queued and running tasks live in this process: a restart marks them failed (recover()), so the caller runs them again.
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { organisationAgentActions, organisationConnections, organisationTasks } from '../../db/schema.ts';
import type { BrowserProvider, StorageState } from '../../records/browsers.ts';
import { HIS_ADAPTERS, HisError, type HisSecret } from '../his/index.ts';
import type { AgentTarget } from '../his/types.ts';
import type { ComputerModel } from './model.ts';
import { runAgentTask, type ActionLog } from './run.ts';

type TaskRow = typeof organisationTasks.$inferSelect;
type ActionRow = typeof organisationAgentActions.$inferSelect;
type ConnectionRow = typeof organisationConnections.$inferSelect;

export interface TaskView {
  id: string;
  connection: string;
  status: TaskRow['status'];
  summary: string;
  model: string;
  /** Where its browser ran. */
  sandbox: string | null;
  steps: number;
  maxSteps: number;
  /** The agent's account of what it did (when it finished). */
  result: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ActionView {
  seq: number;
  step: number;
  kind: string;
  outcome: ActionRow['outcome'];
  detail: Record<string, unknown>;
  /** Typed text or the model's words, unsealed for the organisation. */
  text: string | null;
  url: string | null;
  screenshotSha256: string | null;
  at: string;
}

export interface TaskSealing {
  seal(plain: string, context: string): string;
  open(sealed: string, context: string): string;
}

export interface AgentTasksOptions {
  db: Db;
  model: ComputerModel;
  browsers: BrowserProvider;
  /** This server's own address, as the agent's browser reaches it (the sandbox EMR). */
  selfUrl: string;
  concurrency: number;
  /** Seal and open with the organisation's region's keys. */
  sealing: (region: string) => TaskSealing;
  now?: () => Date;
  deadlineMs?: number;
}

export function agentTasks(o: AgentTasksOptions) {
  const { db } = o;
  const now = o.now ?? (() => new Date());
  const queue: (() => Promise<void>)[] = [];
  const running = new Set<Promise<void>>();
  let active = 0;
  let stopping = false;

  const view = (t: TaskRow, region: string): TaskView => {
    let result: string | null = null;
    if (t.resultCt) { try { result = o.sealing(region).open(t.resultCt, `task:${t.id}:result`); } catch { result = null; } }
    return {
      id: t.id, connection: t.connectionId, status: t.status, summary: t.summary, model: t.model, sandbox: t.sandbox,
      steps: t.steps, maxSteps: t.maxSteps, result, error: t.error,
      createdAt: t.createdAt.toISOString(), startedAt: t.startedAt?.toISOString() ?? null, finishedAt: t.finishedAt?.toISOString() ?? null,
    };
  };

  /** The action log for one task: each entry is inserted before its action and updated after. */
  function actionLog(task: TaskRow, region: string): ActionLog {
    let seq = 0;
    const seal = o.sealing(region);
    return {
      async begin(e) {
        const n = ++seq;
        const [row] = await db.insert(organisationAgentActions).values({
          taskId: task.id, organisationId: task.organisationId, seq: n, step: e.step, kind: e.kind, detail: e.detail ?? {},
          textCt: e.text ? seal.seal(e.text, `task:${task.id}:action:${n}`) : null,
          url: e.url ?? null, screenshotSha256: e.screenshotSha256 ?? null, at: now(),
        }).returning({ id: organisationAgentActions.id });
        return async (outcome, extra) => {
          await db.update(organisationAgentActions).set({
            outcome,
            ...(extra?.detail ? { detail: extra.detail } : {}),
            ...(extra?.screenshotSha256 ? { screenshotSha256: extra.screenshotSha256 } : {}),
            ...(extra?.url ? { url: extra.url } : {}),
          }).where(eq(organisationAgentActions.id, row.id));
        };
      },
    };
  }

  async function finish(id: string, set: Partial<typeof organisationTasks.$inferInsert>) {
    await db.update(organisationTasks).set({ ...set, finishedAt: now() }).where(eq(organisationTasks.id, id));
  }

  async function execute(task: TaskRow, c: ConnectionRow, region: string, organisation: string, secret: HisSecret | null, saveSecret: (s: HisSecret) => Promise<void>) {
    const seal = o.sealing(region);
    const log = actionLog(task, region);
    const adapter = HIS_ADAPTERS.get(c.connectorId);
    let target: AgentTarget;
    try {
      if (!adapter?.agentTarget) throw new HisError(422, 'not_supported', 'This connection has no web app for the agent.');
      target = adapter.agentTarget({ connectionId: c.id, settings: c.settings, selfUrl: o.selfUrl });
    } catch (e) {
      await (await log.begin({ step: 0, kind: 'error', detail: { reason: 'target' } }))('failed');
      return finish(task.id, { status: 'failed', error: e instanceof HisError ? e.message : 'The web app could not be set up.' });
    }
    if (target.needsSignIn && !secret?.webSession) {
      await (await log.begin({ step: 0, kind: 'error', detail: { reason: 'no saved sign-in' } }))('refused');
      return finish(task.id, { status: 'needs_sign_in', error: 'Nobody has signed the agent in to this web app yet. LotusPond sets that up with the clinic (org:web-signin).' });
    }
    const instruction = seal.open(task.instructionCt, `task:${task.id}:instruction`);
    let held: { instruction: string; patient?: string };
    try { held = JSON.parse(instruction) as typeof held; } catch { held = { instruction }; }
    let session;
    const open = await log.begin({ step: 0, kind: 'sandbox', detail: { provider: o.browsers.label, allowHosts: target.allowHosts } });
    try {
      session = await o.browsers.open({ allowHosts: target.allowHosts, storageState: secret?.webSession as StorageState | undefined, acceptDownloads: false });
      await open('done');
    } catch (e) {
      console.error(`[org-agent] could not open a browser for task ${task.id}`, e);
      await open('failed');
      return finish(task.id, { status: 'failed', error: 'A browser for the agent could not be started. Try again.' });
    }
    await db.update(organisationTasks).set({ sandbox: session.where }).where(eq(organisationTasks.id, task.id));
    let end;
    try {
      const page = await session.context.newPage();
      end = await runAgentTask({
        page, model: o.model, target, instruction: held.instruction, patient: held.patient, organisation,
        maxSteps: task.maxSteps, log, deadlineMs: o.deadlineMs, stopped: () => stopping,
      });
    } catch (e) {
      console.error(`[org-agent] task ${task.id} failed`, e);
      end = { status: 'failed' as const, error: 'The agent failed unexpectedly. Its actions so far are in the log.', summary: null, steps: 0 };
    } finally {
      const state = await session.close();
      // Keep a real system's renewed sign-in; the sandbox has none.
      if (state && target.needsSignIn && secret) await saveSecret({ ...secret, webSession: state as HisSecret['webSession'] }).catch(err => console.error('[org-agent] could not save the renewed sign-in', err));
    }
    const summary = end.summary;
    await finish(task.id, {
      status: end.status, steps: end.steps,
      resultCt: summary ? seal.seal(summary, `task:${task.id}:result`) : null,
      error: 'error' in end ? end.error : null,
    });
  }

  function pump() {
    while (active < o.concurrency && queue.length) {
      const job = queue.shift()!;
      active++;
      const p = job().catch(e => console.error('[org-agent] task crashed', e)).finally(() => { active--; running.delete(p); pump(); });
      running.add(p);
    }
  }

  return {
    model: o.model.name,
    /**
     * Make a task for an approved tasks.run and queue it. `secret` is the connection's unsealed credentials;
     * `saveSecret` seals and stores them again (the renewed web sign-in).
     */
    async start(a: {
      organisationId: string; region: string; organisation: string; connection: ConnectionRow; approvalId: string | null; keyId: string | null;
      summary: string; input: { instruction: string; patient?: string; maxSteps: number }; secret: HisSecret | null; saveSecret: (s: HisSecret) => Promise<void>;
    }): Promise<TaskView> {
      const [row] = await db.insert(organisationTasks).values({
        organisationId: a.organisationId, connectionId: a.connection.id, approvalId: a.approvalId, keyId: a.keyId, summary: a.summary,
        instructionCt: 'pending', model: o.model.name, maxSteps: a.input.maxSteps,
      }).returning();
      const instructionCt = o.sealing(a.region).seal(JSON.stringify({ instruction: a.input.instruction, patient: a.input.patient }), `task:${row.id}:instruction`);
      await db.update(organisationTasks).set({ instructionCt }).where(eq(organisationTasks.id, row.id));
      const task = { ...row, instructionCt };
      queue.push(async () => {
        await db.update(organisationTasks).set({ status: 'running', startedAt: now() }).where(eq(organisationTasks.id, task.id));
        await execute(task, a.connection, a.region, a.organisation, a.secret, a.saveSecret);
      });
      pump();
      return view(task, a.region);
    },

    async get(organisationId: string, region: string, id: string): Promise<TaskView | null> {
      const [t] = await db.select().from(organisationTasks).where(and(eq(organisationTasks.id, id), eq(organisationTasks.organisationId, organisationId))).limit(1);
      return t ? view(t, region) : null;
    },

    async list(organisationId: string, region: string, limit = 50): Promise<TaskView[]> {
      const rows = await db.select().from(organisationTasks).where(eq(organisationTasks.organisationId, organisationId)).orderBy(desc(organisationTasks.createdAt)).limit(limit);
      return rows.map(t => view(t, region));
    },

    async actions(organisationId: string, region: string, id: string): Promise<ActionView[] | null> {
      const [t] = await db.select({ id: organisationTasks.id }).from(organisationTasks).where(and(eq(organisationTasks.id, id), eq(organisationTasks.organisationId, organisationId))).limit(1);
      if (!t) return null;
      const rows = await db.select().from(organisationAgentActions).where(eq(organisationAgentActions.taskId, id)).orderBy(asc(organisationAgentActions.seq));
      const seal = o.sealing(region);
      return rows.map(r => {
        let text: string | null = null;
        if (r.textCt) { try { text = seal.open(r.textCt, `task:${id}:action:${r.seq}`); } catch { text = null; } }
        return { seq: r.seq, step: r.step, kind: r.kind, outcome: r.outcome, detail: r.detail, text, url: r.url, screenshotSha256: r.screenshotSha256, at: r.at.toISOString() };
      });
    },

    /** On start-up: tasks left queued or running by a previous process cannot continue. */
    async recover(): Promise<number> {
      const rows = await db.update(organisationTasks).set({ status: 'failed', error: 'The server restarted during this task. Its actions so far are in the log; run it again if it did not finish.', finishedAt: now() })
        .where(inArray(organisationTasks.status, ['queued', 'running'])).returning({ id: organisationTasks.id });
      return rows.length;
    },

    /** Wait for the tasks in flight (tests, shutdown). New steps stop when `stop` is true. */
    async idle(stop = false): Promise<void> {
      stopping = stop;
      while (running.size || queue.length) await Promise.race([...running, new Promise(r => setTimeout(r, 20))]);
    },
  };
}

export type AgentTasks = ReturnType<typeof agentTasks>;
