// The record agent (docs/record-agent.md): for each source a person connects, an agent that opens the portal in a
// browser of its own, signs in with the person, downloads their reports and saves the new ones to the profile's
// files for review, then checks again on the schedule they chose.
//
// A run: queued → running ⇄ waiting (a question for the person: mobile number, OTP, password) → succeeded, failed or
// cancelled. Answers go straight to the browser and are never stored. Runs execute in this process, at most
// `concurrency` at a time; questions wait in memory, so a restart fails the runs that were in flight (tick() marks
// them) and the person starts again. Scheduled runs never ask: if the portal wants the person, the connection is
// marked needs_sign_in and waits for them.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { and, desc, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import {
  DEMO_SOURCE, DEMO_SOURCE_ID, maskIdentifier, RECORD_AGENT_NOTICE_VERSION, SOURCES, sourceById,
  type RecordConnectionView, type RecordQuestion, type RecordRunView, type SourceAvailability, type SourceInfo, type SourceView,
} from '../../../shared/sources.ts';
import type { DataRegion } from '../../../shared/regions.ts';
import type { Cell, CellRegistry } from '../cells.ts';
import type { RecordAgentConfig } from '../config.ts';
import type { Secrets } from '../compliance/secrets.ts';
import { recordConsents } from '../compliance/consents.ts';
import { recordEvent } from '../compliance/audit.ts';
import { isPrivateAddress } from '../agents/oauth.ts';
import { documents, profiles, recordConnections, recordItems, recordRuns, type RecordConnectionRow, type RecordRunRow, type UserRow } from '../db/schema.ts';
import { decryptFile, encryptFile, isEncrypted } from '../lib/files-encrypted.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { notifyAgentWrite } from '../notifications.ts';
import { downloadFile, type BrowserProvider, type StorageState } from './browsers.ts';
import { DEMO_PORTAL_PATH } from './demo-portal.ts';
import { navigatorRecipe, type NavigatorOptions } from './navigator.ts';
import { demoRecipe } from './recipes/demo.ts';
import { drlalRecipe } from './recipes/drlal.ts';
import { thyrocareRecipe } from './recipes/thyrocare.ts';
import { metropolisRecipe } from './recipes/metropolis.ts';
import { apollo247Recipe } from './recipes/apollo247.ts';
import { RecipeDriftError } from './recipes/kit.ts';
import { NeedsPersonError, PortalError, REPORT_TYPES, RunStoppedError, sniffType, type Ask, type PortalReport, type Recipe, type RecipeContext } from './recipes/types.ts';

const MIN = 60_000, DAY = 24 * 60 * MIN;
/** How long the agent waits for the person to answer a question. */
const QUESTION_MS = 5 * MIN;
/** The longest a run may take, questions included. */
const RUN_MS = 15 * MIN;
/** Reports saved per run, at most. */
const MAX_REPORTS = 50;

export interface RecordAgentOptions {
  cells: CellRegistry;
  secrets: Secrets;
  config: RecordAgentConfig;
  browsers: BrowserProvider;
  /** This server's own address as its browsers reach it (the demo portal), e.g. http://127.0.0.1:8787. */
  selfUrl: string;
  /** Claude for portals without a recipe; leave out to offer only sources with recipes. */
  navigator?: NavigatorOptions;
  /** Extra recipes (tests); the demo recipe is always included. */
  recipes?: Recipe[];
  maxBytes: number;
  now?: () => number;
  questionMs?: number;
  /** Resolve a portal's host (tests). */
  resolve?: (host: string) => Promise<string[]>;
}

export interface ConnectInput {
  sourceId: string;
  profileId: string;
  portalUrl?: string;
  refreshDays: number | null;
  noticeVersion: string;
}

export interface RecordAgent {
  /** Where the browsers run, for the person. */
  browserLabel: string;
  sources(region: DataRegion | null): SourceView[];
  connections(cell: Cell, userId: string): Promise<RecordConnectionView[]>;
  connect(cell: Cell, user: UserRow, input: ConnectInput): Promise<{ connection: RecordConnectionView; run: RecordRunView }>;
  update(cell: Cell, userId: string, id: string, patch: { refreshDays: number | null }): Promise<RecordConnectionView>;
  startRun(cell: Cell, user: UserRow, connectionId: string): Promise<RecordRunView>;
  run(cell: Cell, userId: string, runId: string): Promise<RecordRunView>;
  answer(cell: Cell, userId: string, runId: string, answer: string): Promise<RecordRunView>;
  cancel(cell: Cell, userId: string, runId: string): Promise<RecordRunView>;
  disconnect(cell: Cell, user: UserRow, id: string): Promise<void>;
  /** Start scheduled runs that are due, and fail runs a restart left behind. */
  tick(): Promise<void>;
  start(): () => void;
  /** Resolves when no run is queued or running (tests). */
  idle(): Promise<void>;
}

interface Live {
  abort: AbortController;
  waiter?: { resolve: (v: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
}

interface Job { cell: Cell; userId: string; runId: string; connectionId: string; trigger: 'person' | 'schedule' }

const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

export function runView(r: RecordRunRow, docs: { id: string; fileName: string }[] = []): RecordRunView {
  return {
    id: r.id, connectionId: r.connectionId, status: r.status, trigger: r.trigger, step: r.step, question: r.question ?? null,
    found: r.found, saved: r.saved, documents: docs, error: r.error, startedAt: r.startedAt.toISOString(), finishedAt: iso(r.finishedAt),
  };
}

/** https only, a host name (not an address), and only public addresses: a portal address must not reach our network. */
async function checkPortalUrl(raw: string, resolve: (h: string) => Promise<string[]>): Promise<URL> {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw badRequest('Give the portal’s full address, starting with https://', 'invalid_portal'); }
  if (u.protocol !== 'https:') throw badRequest('The portal’s address must start with https://', 'invalid_portal');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) || !host.includes('.') || /(^|\.)(localhost|local|internal|lan|home|corp)$/i.test(host)) throw badRequest('That address is not a public website.', 'invalid_portal');
  let addrs: string[];
  try { addrs = await resolve(host); } catch { throw badRequest('That address could not be found. Check it and try again.', 'invalid_portal'); }
  if (!addrs.length || addrs.some(isPrivateAddress)) throw badRequest('That address is not a public website.', 'invalid_portal');
  u.hash = '';
  return u;
}

export function createRecordAgent(opts: RecordAgentOptions): RecordAgent {
  const now = opts.now ?? Date.now;
  const questionMs = opts.questionMs ?? QUESTION_MS;
  const resolve = opts.resolve ?? (async (h: string) => (await lookup(h, { all: true })).map(a => a.address));
  const recipes = new Map<string, Recipe>([demoRecipe, drlalRecipe(), thyrocareRecipe(), metropolisRecipe(), apollo247Recipe(), ...(opts.recipes ?? [])].map(r => [r.sourceId, r] as const));
  const live = new Map<string, Live>();
  const queue: Job[] = [];
  let running = 0;
  let idleWaiters: (() => void)[] = [];
  const selfHost = new URL(opts.selfUrl).hostname;

  const ringFor = (cell: Cell) => opts.secrets.fileKeys?.[cell.id] ?? opts.secrets.fileKeys?.default ?? null;
  const seal = (cell: Cell, plain: string, context: string): string => {
    const ring = ringFor(cell);
    const bytes = Buffer.from(plain, 'utf8');
    return Buffer.from(ring ? encryptFile(`records:${context}`, bytes, ring.current) : bytes).toString('base64');
  };
  const unseal = (cell: Cell, sealed: string | null, context: string): string | null => {
    if (!sealed) return null;
    const bytes = Buffer.from(sealed, 'base64');
    const ring = ringFor(cell);
    try {
      if (ring) return Buffer.from(decryptFile(`records:${context}`, bytes, ring)).toString('utf8');
      return isEncrypted(bytes) ? null : bytes.toString('utf8');
    } catch {
      return null; // a key that is gone: the person signs in again
    }
  };

  function availability(s: SourceInfo): SourceAvailability {
    if (s.access !== 'browser') return 'unavailable';
    if (recipes.has(s.id)) return 'recipe';
    return opts.navigator ? 'navigator' : 'unavailable';
  }
  const catalogue = (): SourceInfo[] => (opts.config.demoPortal ? [DEMO_SOURCE, ...SOURCES] : SOURCES);
  const findSource = (id: string) => (id === DEMO_SOURCE_ID ? (opts.config.demoPortal ? DEMO_SOURCE : undefined) : sourceById(id));

  /** Where the agent starts and which hosts it may reach. */
  function placeOf(source: SourceInfo, portalUrl: string): { startUrl: string; allowHosts: string[] } {
    if (source.id === DEMO_SOURCE_ID) return { startUrl: `${opts.selfUrl}${DEMO_PORTAL_PATH}`, allowHosts: [selfHost] };
    if (portalUrl) return { startUrl: portalUrl, allowHosts: [...new Set([new URL(portalUrl).hostname.replace(/^www\./, ''), ...(source.hosts ?? [])])] };
    return { startUrl: source.startUrl!, allowHosts: source.hosts ?? [] };
  }

  async function connectionRow(cell: Cell, userId: string, id: string): Promise<RecordConnectionRow> {
    const [row] = await cell.db.select().from(recordConnections).where(and(eq(recordConnections.id, id), eq(recordConnections.userId, userId))).limit(1);
    if (!row) throw notFound('That source');
    return row;
  }
  async function runRow(cell: Cell, userId: string, id: string): Promise<RecordRunRow> {
    const [row] = await cell.db.select().from(recordRuns).where(and(eq(recordRuns.id, id), eq(recordRuns.userId, userId))).limit(1);
    if (!row) throw notFound('That run');
    return row;
  }
  async function docsOf(cell: Cell, ids: string[]) {
    if (!ids.length) return [];
    const rows = await cell.db.select({ id: documents.id, fileName: documents.fileName }).from(documents).where(inArray(documents.id, ids));
    return ids.map(id => rows.find(r => r.id === id)).filter((r): r is { id: string; fileName: string } => !!r);
  }
  async function fullRunView(cell: Cell, r: RecordRunRow) {
    return runView(r, await docsOf(cell, r.documentIds));
  }

  async function connectionViews(cell: Cell, rows: RecordConnectionRow[]): Promise<RecordConnectionView[]> {
    if (!rows.length) return [];
    const ids = rows.map(r => r.id);
    const runs = await cell.db.select().from(recordRuns).where(inArray(recordRuns.connectionId, ids)).orderBy(desc(recordRuns.startedAt));
    const counts = await cell.db.select({ id: recordItems.connectionId, n: sql<number>`count(*)::int` }).from(recordItems)
      .where(and(inArray(recordItems.connectionId, ids), isNotNull(recordItems.documentId))).groupBy(recordItems.connectionId);
    const out: RecordConnectionView[] = [];
    for (const r of rows) {
      const last = runs.find(x => x.connectionId === r.id);
      const identifier = unseal(cell, r.identifierCt, `identifier:${r.id}`);
      out.push({
        id: r.id, sourceId: r.sourceId, sourceName: findSource(r.sourceId)?.name ?? r.sourceId, profileId: r.profileId, status: r.status,
        portalUrl: r.portalUrl || null, identifier: identifier ? maskIdentifier(identifier) : null, signedIn: !!r.sessionCt,
        refreshDays: r.refreshDays, lastSuccessAt: iso(r.lastSuccessAt), nextRunAt: iso(r.nextRunAt),
        reportsSaved: Number(counts.find(c => c.id === r.id)?.n ?? 0), createdAt: r.createdAt.toISOString(),
        lastRun: last ? await fullRunView(cell, last) : null,
      });
    }
    return out;
  }

  async function setRun(cell: Cell, id: string, patch: Partial<typeof recordRuns.$inferInsert>) {
    await cell.db.update(recordRuns).set(patch).where(eq(recordRuns.id, id));
  }

  /* ---------------- running ---------------- */

  function enqueue(job: Job) {
    live.set(job.runId, { abort: new AbortController() });
    queue.push(job);
    pump();
  }

  function pump() {
    while (running < opts.config.concurrency && queue.length) {
      const job = queue.shift()!;
      running++;
      void execute(job).finally(() => {
        running--;
        live.delete(job.runId);
        pump();
        if (!running && !queue.length) { const w = idleWaiters; idleWaiters = []; w.forEach(f => f()); }
      });
    }
  }

  async function execute(job: Job): Promise<void> {
    const { cell } = job;
    const l = live.get(job.runId);
    if (!l) return;
    const conn = await cell.db.select().from(recordConnections).where(eq(recordConnections.id, job.connectionId)).limit(1).then(r => r[0]);
    const source = conn && findSource(conn.sourceId);
    if (!conn || !source || l.abort.signal.aborted) {
      await setRun(cell, job.runId, { status: 'cancelled', step: null, question: null, finishedAt: new Date(now()) });
      return;
    }
    const recipe = recipes.get(source.id) ?? (opts.navigator && source.access === 'browser' ? navigatorRecipe(source.id, opts.navigator) : null);
    if (!recipe) {
      await setRun(cell, job.runId, { status: 'failed', error: 'The record agent cannot fetch from this source yet.', finishedAt: new Date(now()) });
      return;
    }
    const timeout = setTimeout(() => l.abort.abort(new RunStoppedError('The run took too long and was stopped.')), RUN_MS);
    timeout.unref();
    const { startUrl, allowHosts } = placeOf(source, conn.portalUrl);
    let identifier = unseal(cell, conn.identifierCt, `identifier:${conn.id}`);
    let identifierChanged = false;
    const storage = unseal(cell, conn.sessionCt, `session:${conn.id}`);
    await setRun(cell, job.runId, { status: 'running', step: 'Starting a browser' });

    let session: Awaited<ReturnType<BrowserProvider['open']>> | null = null;
    let failCapture: () => Promise<void> = async () => {};
    let state: StorageState | null = null;
    try {
      session = await opts.browsers.open({ allowHosts, ...(storage ? { storageState: JSON.parse(storage) as StorageState } : {}) });
      const page = await session.context.newPage();
      // Development: what the browser showed at each step (config.debugDir; refused in production).
      let shot = 0;
      const capture = async (label: string) => {
        if (!opts.config.debugDir) return;
        try {
          const base = path.join(opts.config.debugDir, `${job.runId.slice(0, 8)}-${String(++shot).padStart(2, '0')}-${label.replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}`);
          await mkdir(opts.config.debugDir, { recursive: true });
          await page.screenshot({ path: `${base}.png`, fullPage: true });
          await writeFile(`${base}.html`, await page.content());
        } catch { /* best effort */ }
      };
      failCapture = () => capture('failed');
      const ctx: RecipeContext = {
        page, context: session.context, source, startUrl, allowHosts, identifier, signal: l.abort.signal, maxBytes: opts.maxBytes,
        step: async text => { await capture(text); await setRun(cell, job.runId, { step: text.slice(0, 120) }); },
        remember: v => { const t = v.trim(); if (t && t !== identifier) { identifier = t; identifierChanged = true; } },
        ask: async q => { await capture(`ask ${q.kind}`); return ask(cell, job, l, q); },
        download: url => downloadFile(session!.context, url, allowHosts, opts.maxBytes),
      };
      // A recipe that finds the portal changed hands the run to the navigator (same page, same sign-in), if it is on.
      const work = recipe.run(ctx).catch(async e => {
        if (!(e instanceof RecipeDriftError)) throw e;
        console.warn(`[records] the ${source.id} recipe no longer matches the portal: ${e.message}`);
        if (!opts.navigator || l.abort.signal.aborted) throw new PortalError(`${source.name} has changed its website, and the record agent cannot follow it yet. Upload the reports, or try again in a few days.`);
        await ctx.step(`${source.name} looks different; Claude is finding the way`);
        return navigatorRecipe(source.id, opts.navigator).run(ctx);
      });
      // After a cancel the recipe may still fail on the closed browser; that is expected and ignored.
      work.catch(() => {});
      const reports = await Promise.race([
        work,
        new Promise<never>((_, reject) => l.abort.signal.addEventListener('abort', () => reject(l.abort.signal.reason ?? new RunStoppedError('Cancelled.')), { once: true })),
      ]);
      await setRun(cell, job.runId, { step: 'Saving new reports', found: reports.length });
      const saved = await saveReports(cell, job, conn, source, reports.slice(0, MAX_REPORTS));
      state = await session.close();
      session = null;
      const finished = new Date(now());
      await cell.db.update(recordConnections).set({
        status: 'active', lastSuccessAt: finished, updatedAt: finished,
        nextRunAt: conn.refreshDays ? new Date(now() + conn.refreshDays * DAY) : null,
        ...(state ? { sessionCt: seal(cell, JSON.stringify(state), `session:${conn.id}`) } : {}),
        ...(identifierChanged && identifier ? { identifierCt: seal(cell, identifier, `identifier:${conn.id}`) } : {}),
      }).where(eq(recordConnections.id, conn.id));
      await setRun(cell, job.runId, { status: 'succeeded', step: null, question: null, saved: saved.length, documentIds: saved, finishedAt: finished });
      if (saved.length) await recordEvent(cell.db, null, job.userId, 'records_fetched', { profileId: conn.profileId, connectionId: conn.id });
    } catch (e) {
      await failCapture();
      const finished = new Date(now());
      if (e instanceof NeedsPersonError) {
        // A scheduled run found the sign-in expired: wait for the person.
        await cell.db.update(recordConnections).set({ status: 'needs_sign_in', nextRunAt: null, updatedAt: finished }).where(eq(recordConnections.id, conn.id));
        await setRun(cell, job.runId, { status: 'failed', step: null, question: null, error: `${source.name} wants you to sign in again. Open Sources and choose Check now.`, finishedAt: finished });
      } else if (e instanceof RunStoppedError || l.abort.signal.aborted) {
        const reason = e instanceof RunStoppedError ? e.message : 'Cancelled.';
        await setRun(cell, job.runId, { status: reason === 'Cancelled.' ? 'cancelled' : 'failed', step: null, question: null, error: reason === 'Cancelled.' ? null : reason, finishedAt: finished });
      } else {
        if (!(e instanceof PortalError)) console.error(`[records] run failed (${source.id}): ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
        await setRun(cell, job.runId, {
          status: 'failed', step: null, question: null, finishedAt: finished,
          error: e instanceof PortalError ? e.message : `Something went wrong on ${source.name}. Try again later; if it keeps happening, the portal may have changed.`,
        });
      }
    } finally {
      clearTimeout(timeout);
      if (l.waiter) { clearTimeout(l.waiter.timer); l.waiter = undefined; }
      if (session) await session.close().catch(() => null);
    }
  }

  async function ask(cell: Cell, job: Job, l: Live, q: Ask): Promise<string> {
    if (job.trigger === 'schedule') throw new NeedsPersonError(q.label);
    if (l.abort.signal.aborted) throw new RunStoppedError('Cancelled.');
    const askedAt = now();
    const question: RecordQuestion = {
      kind: q.kind, label: q.label.slice(0, 160), secret: !!q.secret, askedAt: new Date(askedAt).toISOString(), expiresAt: new Date(askedAt + questionMs).toISOString(),
      ...(q.hint ? { hint: q.hint.slice(0, 160) } : {}),
    };
    await setRun(cell, job.runId, { status: 'waiting', question });
    const answer = await new Promise<string>((resolveAnswer, reject) => {
      const timer = setTimeout(() => reject(new RunStoppedError('No answer came in time, so the agent stopped. Start again when you have the code ready.')), questionMs);
      l.waiter = { resolve: resolveAnswer, reject, timer };
    });
    await setRun(cell, job.runId, { status: 'running', question: null, step: 'Carrying on' });
    return answer;
  }

  /** Save the reports this connection has not brought in before. Returns the new documents' ids. */
  async function saveReports(cell: Cell, job: Job, conn: RecordConnectionRow, source: SourceInfo, reports: PortalReport[]): Promise<string[]> {
    const saved: string[] = [];
    for (const r of reports) {
      const contentType = sniffType(r.bytes, r.contentType);
      const ext = REPORT_TYPES[contentType];
      if (!ext || !r.bytes.byteLength) continue;
      const itemKey = createHash('sha256').update(`${source.id}\u0000${r.key}`).digest('hex');
      const fresh = await cell.db.insert(recordItems).values({ connectionId: conn.id, itemKey }).onConflictDoNothing().returning();
      if (!fresh.length) continue;
      const sha256 = createHash('sha256').update(r.bytes).digest('hex');
      // The same file already in the profile (uploaded by hand, or from WhatsApp): link to it instead of a copy.
      const [same] = await cell.db.select({ id: documents.id }).from(documents).where(and(eq(documents.profileId, conn.profileId), eq(documents.sha256, sha256))).limit(1);
      if (same) {
        await cell.db.update(recordItems).set({ documentId: same.id }).where(and(eq(recordItems.connectionId, conn.id), eq(recordItems.itemKey, itemKey)));
        continue;
      }
      const id = randomUUID();
      const storageKey = `${conn.profileId}/${id}`;
      const base = r.fileName.replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[^\w .()&,-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 110) || `${source.name} report`;
      const fileName = `${base}.${ext}`;
      await cell.files.put(storageKey, r.bytes);
      try {
        await cell.db.insert(documents).values({ id, profileId: conn.profileId, storageKey, kind: 'report', fileName, contentType, sizeBytes: r.bytes.byteLength, sha256 });
      } catch (e) {
        await cell.files.delete(storageKey);
        await cell.db.delete(recordItems).where(and(eq(recordItems.connectionId, conn.id), eq(recordItems.itemKey, itemKey)));
        throw e;
      }
      await cell.db.update(recordItems).set({ documentId: id }).where(and(eq(recordItems.connectionId, conn.id), eq(recordItems.itemKey, itemKey)));
      await notifyAgentWrite(cell.db, { userId: job.userId, profileId: conn.profileId, connectionId: null, agentName: `Record agent · ${source.name}`, detail: { type: 'document', documentId: id, fileName } });
      saved.push(id);
    }
    return saved;
  }

  async function newRun(cell: Cell, userId: string, conn: RecordConnectionRow, trigger: 'person' | 'schedule'): Promise<RecordRunRow> {
    const [row] = await cell.db.insert(recordRuns).values({
      id: randomUUID(), connectionId: conn.id, userId, status: 'queued', trigger, step: 'Waiting for a free browser', startedAt: new Date(now()),
    }).returning();
    enqueue({ cell, userId, runId: row.id, connectionId: conn.id, trigger });
    return row;
  }

  const activeRunOf = async (cell: Cell, connectionId: string) => {
    const rows = await cell.db.select().from(recordRuns)
      .where(and(eq(recordRuns.connectionId, connectionId), inArray(recordRuns.status, ['queued', 'running', 'waiting']))).limit(5);
    return rows.find(r => live.has(r.id)) ?? null;
  };

  return {
    browserLabel: opts.browsers.label,

    sources(region) {
      return catalogue()
        .filter(s => !region || s.regions.includes(region))
        .map(s => ({ ...s, availability: availability(s), needsUrl: s.access === 'browser' && !s.startUrl && s.id !== DEMO_SOURCE_ID }));
    },

    async connections(cell, userId) {
      const rows = await cell.db.select().from(recordConnections).where(eq(recordConnections.userId, userId)).orderBy(desc(recordConnections.createdAt));
      return connectionViews(cell, rows);
    },

    async connect(cell, user, input) {
      if (input.noticeVersion !== RECORD_AGENT_NOTICE_VERSION) throw conflict('The record agent notice has changed since this page was loaded. Reload the app and try again.', 'notice_outdated');
      const source = findSource(input.sourceId);
      if (!source) throw notFound('That source');
      if (user.region && !source.regions.includes(user.region as DataRegion)) throw badRequest('That source is not offered where your records are kept.');
      if (availability(source) === 'unavailable') throw conflict('The record agent cannot fetch from this source yet.', 'source_unavailable');
      const [profile] = await cell.db.select({ id: profiles.id }).from(profiles).where(and(eq(profiles.id, input.profileId), eq(profiles.userId, user.id))).limit(1);
      if (!profile) throw notFound('That profile');
      const needsUrl = !source.startUrl && source.id !== DEMO_SOURCE_ID;
      let portalUrl = '';
      if (needsUrl) {
        if (!input.portalUrl) throw badRequest('Give the address of the portal.', 'portal_url_required');
        portalUrl = (await checkPortalUrl(input.portalUrl, resolve)).href;
      }
      const at = new Date(now());
      const [existing] = await cell.db.select().from(recordConnections).where(and(
        eq(recordConnections.userId, user.id), eq(recordConnections.profileId, input.profileId), eq(recordConnections.sourceId, source.id), eq(recordConnections.portalUrl, portalUrl),
      )).limit(1);
      const conn = existing
        ? (await cell.db.update(recordConnections).set({ refreshDays: input.refreshDays, consentVersion: RECORD_AGENT_NOTICE_VERSION, updatedAt: at }).where(eq(recordConnections.id, existing.id)).returning())[0]
        : (await cell.db.insert(recordConnections).values({
          id: randomUUID(), userId: user.id, profileId: input.profileId, sourceId: source.id, portalUrl, refreshDays: input.refreshDays, consentVersion: RECORD_AGENT_NOTICE_VERSION,
        }).returning())[0];
      if (!existing) {
        await recordConsents(cell.db, user.id, user.country, [{ kind: 'record_agent', granted: true, version: RECORD_AGENT_NOTICE_VERSION, detail: { source: source.id, profileId: input.profileId, connectionId: conn.id } }]);
        await recordEvent(cell.db, null, user.id, 'records_source_connected', { profileId: input.profileId, connectionId: conn.id });
      }
      const active = await activeRunOf(cell, conn.id);
      const run = active ?? await newRun(cell, user.id, conn, 'person');
      const [view] = await connectionViews(cell, [conn]);
      return { connection: view, run: await fullRunView(cell, run) };
    },

    async update(cell, userId, id, patch) {
      const conn = await connectionRow(cell, userId, id);
      const base = conn.lastSuccessAt?.getTime() ?? now();
      const [row] = await cell.db.update(recordConnections).set({
        refreshDays: patch.refreshDays, updatedAt: new Date(now()),
        nextRunAt: patch.refreshDays && conn.status === 'active' && conn.sessionCt ? new Date(Math.max(now() + MIN, base + patch.refreshDays * DAY)) : null,
      }).where(eq(recordConnections.id, conn.id)).returning();
      return (await connectionViews(cell, [row]))[0];
    },

    async startRun(cell, user, connectionId) {
      const conn = await connectionRow(cell, user.id, connectionId);
      const active = await activeRunOf(cell, conn.id);
      return fullRunView(cell, active ?? await newRun(cell, user.id, conn, 'person'));
    },

    async run(cell, userId, runId) {
      return fullRunView(cell, await runRow(cell, userId, runId));
    },

    async answer(cell, userId, runId, answer) {
      const r = await runRow(cell, userId, runId);
      const l = live.get(r.id);
      if (r.status !== 'waiting' || !l?.waiter) throw conflict('The agent is not waiting for an answer on this run.', 'not_waiting');
      const w = l.waiter;
      l.waiter = undefined;
      clearTimeout(w.timer);
      // Shown as running at once, so the app doesn't ask again while the browser types it.
      await setRun(cell, r.id, { status: 'running', question: null, step: 'Carrying on' });
      w.resolve(answer);
      return fullRunView(cell, await runRow(cell, userId, runId));
    },

    async cancel(cell, userId, runId) {
      const r = await runRow(cell, userId, runId);
      const l = live.get(r.id);
      if (l) {
        l.abort.abort(new RunStoppedError('Cancelled.'));
        if (l.waiter) { clearTimeout(l.waiter.timer); l.waiter.reject(new RunStoppedError('Cancelled.')); l.waiter = undefined; }
        const i = queue.findIndex(j => j.runId === r.id);
        if (i >= 0) { queue.splice(i, 1); live.delete(r.id); }
      }
      if (['queued', 'running', 'waiting'].includes(r.status)) await setRun(cell, r.id, { status: 'cancelled', step: null, question: null, finishedAt: new Date(now()) });
      return fullRunView(cell, await runRow(cell, userId, runId));
    },

    async disconnect(cell, user, id) {
      const conn = await connectionRow(cell, user.id, id);
      for (const r of await cell.db.select({ id: recordRuns.id }).from(recordRuns).where(and(eq(recordRuns.connectionId, conn.id), inArray(recordRuns.status, ['queued', 'running', 'waiting'])))) {
        await this.cancel(cell, user.id, r.id);
      }
      // The sign-in and the remembered number go with the connection; reports already saved stay in the files.
      await cell.db.delete(recordConnections).where(eq(recordConnections.id, conn.id));
      await recordConsents(cell.db, user.id, user.country, [{ kind: 'record_agent', granted: false, version: RECORD_AGENT_NOTICE_VERSION, detail: { source: conn.sourceId, profileId: conn.profileId, connectionId: conn.id } }]);
      await recordEvent(cell.db, null, user.id, 'records_source_disconnected', { profileId: conn.profileId, connectionId: conn.id });
    },

    async tick() {
      for (const cell of opts.cells.cells) {
        try {
          // Runs a restart (or a crash) left behind.
          const stale = await cell.db.select({ id: recordRuns.id }).from(recordRuns).where(inArray(recordRuns.status, ['queued', 'running', 'waiting']));
          const lost = stale.filter(r => !live.has(r.id)).map(r => r.id);
          if (lost.length) await cell.db.update(recordRuns).set({ status: 'failed', step: null, question: null, error: 'The run stopped when LotusPond restarted. Start it again.', finishedAt: new Date(now()) }).where(inArray(recordRuns.id, lost));
          const due = await cell.db.select().from(recordConnections).where(and(
            eq(recordConnections.status, 'active'), isNotNull(recordConnections.sessionCt), isNotNull(recordConnections.nextRunAt), lte(recordConnections.nextRunAt, new Date(now())),
          )).limit(20);
          for (const conn of due) {
            if (await activeRunOf(cell, conn.id)) continue;
            // Not again until this run sets the next time.
            await cell.db.update(recordConnections).set({ nextRunAt: null }).where(eq(recordConnections.id, conn.id));
            await newRun(cell, conn.userId, conn, 'schedule');
          }
        } catch (e) {
          console.error(`[records] scheduled check failed in the ${cell.id} cell`, e instanceof Error ? e.message : e);
        }
      }
    },

    start() {
      void this.tick();
      const t = setInterval(() => void this.tick(), 10 * MIN);
      t.unref();
      return () => clearInterval(t);
    },

    idle() {
      if (!running && !queue.length) return Promise.resolve();
      return new Promise(r => { idleWaiters.push(r); });
    },
  };
}
