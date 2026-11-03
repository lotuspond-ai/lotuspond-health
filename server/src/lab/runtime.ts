// Lab booking wired into the deployment (docs/lab-booking-backend.md §3). Each partner serves one data region;
// its orders and webhooks live in the cell that holds that region. For each such cell this builds the stores on
// the cell's database, a sealer with the cell's file keys, the booking service, the webhook processor and the
// poller. Background work runs on timers in the server (start) or on demand in tests (tick).
import { randomBytes } from 'node:crypto';
import { LAB_BOOKING_NOTICE_VERSION, type OrderStatus, type PartnerId } from '../../../shared/lab-bundle.ts';
import type { Cell, CellRegistry } from '../cells.ts';
import type { Secrets } from '../compliance/secrets.ts';
import { BookingService, type BookingOptions } from './booking/service.ts';
import { consoleLogger, type Logger } from './log.ts';
import { reconcile } from './orders/reconcile.ts';
import type { OrderHooks, SyncDeps } from './orders/sync.ts';
import { ResultsService } from './results/service.ts';
import { FakeLab, type FakeWebhookRequest } from './partners/fake-lab.ts';
import { FakeLabAdapter } from './partners/fake.ts';
import type { PartnerConfig, PartnerRegistry } from './partners/types.ts';
import { keyringSealer, type Sealer } from './sealer.ts';
import { DrizzleOrderStore, DrizzleWebhookInbox } from './store/drizzle.ts';
import { WebhookProcessor, type ProcessorOptions } from './webhooks/processor.ts';
import type { WebhookTarget } from './webhooks/receiver.ts';

const MIN = 60_000, DAY = 24 * 60 * MIN;

export interface LabRuntime {
  cell: Cell;
  /** The partners whose region this cell holds. */
  partners: Map<PartnerId, PartnerConfig>;
  orders: DrizzleOrderStore;
  inbox: DrizzleWebhookInbox;
  sealer: Sealer;
  booking: BookingService;
  processor: WebhookProcessor;
  /** Fetches reports into pending results, and saves reviewed ones into the profile. */
  results: ResultsService;
  sync: SyncDeps;
}

export interface Labs {
  partners: PartnerRegistry;
  runtimes: LabRuntime[];
  /** The runtime for the cell holding an account, or null if no partner's region is in it. */
  forCell(cell: Cell): LabRuntime | null;
  /** Where a partner's webhooks are stored (lab/webhooks/receiver.ts). */
  target(partner: PartnerId): WebhookTarget | null;
  /** Run every background job once: process webhooks, retry placements, poll, fetch reports, purge old webhook bodies. */
  tick(): Promise<void>;
  /** Run the background jobs on timers; returns a function that stops them. */
  start(): () => void;
}

export interface LabsOptions {
  cells: CellRegistry;
  secrets: Secrets;
  partners: PartnerConfig[];
  now?: () => number;
  log?: Logger;
  hooks?: OrderHooks;
  booking?: Partial<BookingOptions>;
  processor?: ProcessorOptions;
  /** Poll schedule override (orders/reconcile.ts POLL_EVERY_MS). */
  poll?: Partial<Record<OrderStatus, number>>;
}

export function createLabs(opts: LabsOptions): Labs {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? consoleLogger;
  const partners: Map<PartnerId, PartnerConfig> = new Map(opts.partners.map(p => [p.adapter.id, p]));
  const byCell = new Map<Cell, LabRuntime>();
  // A report may have changed (sync saw partial_report, report_ready or an amendment): fetch it soon.
  let wakeResults = () => {};
  const hooks: OrderHooks = {
    onTransition: (o, from) => opts.hooks?.onTransition?.(o, from),
    onReportUpdate: async o => {
      await opts.hooks?.onReportUpdate?.(o);
      wakeResults();
    },
  };

  for (const p of opts.partners) {
    const cell = opts.cells.forRegion(p.region);
    if (!cell) throw new Error(`Lab partner ${p.adapter.id} serves the "${p.region}" region, which this deployment does not serve (SERVED_REGIONS).`);
    let rt = byCell.get(cell);
    if (!rt) {
      const orders = new DrizzleOrderStore(cell.db);
      const inbox = new DrizzleWebhookInbox(cell.db);
      const sealer = keyringSealer(opts.secrets.fileKeys?.[cell.id] ?? opts.secrets.fileKeys?.default ?? null);
      const cellPartners = new Map<PartnerId, PartnerConfig>();
      const sync: SyncDeps = { orders, partners: cellPartners, now, log, hooks };
      rt = {
        cell, partners: cellPartners, orders, inbox, sealer, sync,
        booking: new BookingService({ ...sync, sealer }, { noticeVersion: LAB_BOOKING_NOTICE_VERSION, ...opts.booking }),
        processor: new WebhookProcessor({ ...sync, inbox, sealer }, opts.processor),
        results: new ResultsService({ db: cell.db, files: cell.files, orders, partners: cellPartners, now, log }),
      };
      byCell.set(cell, rt);
    }
    rt.partners.set(p.adapter.id, p);
  }
  const runtimes = [...byCell.values()];
  const forPartner = (id: PartnerId) => runtimes.find(rt => rt.partners.has(id)) ?? null;

  const each = async (job: string, fn: (rt: LabRuntime) => Promise<unknown>) => {
    for (const rt of runtimes) {
      try {
        await fn(rt);
      } catch (e) {
        log.error('lab background job failed', { job, cell: rt.cell.id, error: e instanceof Error ? e.name : 'error', alert: true });
      }
    }
  };
  const jobs = {
    webhooks: () => each('webhooks', rt => rt.processor.runOnce()),
    placements: () => each('placements', rt => rt.booking.retryPlacements()),
    poll: () => each('poll', rt => reconcile(rt.sync, opts.poll ? { every: opts.poll } : {})),
    results: () => each('results', rt => rt.results.fetchDue()),
    purge: () => each('purge', rt => rt.inbox.purge(now() - 7 * DAY)),
  };

  wakeResults = () => { void jobs.results(); };

  return {
    partners,
    runtimes,
    forCell: cell => byCell.get(cell) ?? null,
    target(partner) {
      const rt = forPartner(partner);
      return rt ? { inbox: rt.inbox, sealer: rt.sealer, onStored: () => { void jobs.webhooks(); } } : null;
    },
    async tick() {
      await jobs.webhooks();
      await jobs.placements();
      await jobs.poll();
      await jobs.results();
      await jobs.purge();
    },
    start() {
      const timers = [
        setInterval(() => void jobs.webhooks(), 5000),
        setInterval(() => void jobs.placements(), 15_000),
        setInterval(() => void jobs.poll(), 5 * MIN),
        setInterval(() => void jobs.results(), 10_000),
        setInterval(() => void jobs.purge(), 6 * 60 * MIN),
      ];
      for (const t of timers) t.unref();
      return () => timers.forEach(clearInterval);
    },
  };
}

/**
 * The simulated lab as a partner (development and tests). It runs in this process and posts its signed webhooks
 * through `deliver` to /hooks/fake/<secret>: over HTTP to this server in development, or app.request in tests.
 */
export function fakePartner(opts: { deliver: (path: string, req: FakeWebhookRequest) => Promise<void>; now?: () => number; stepMs?: number }) {
  const hookSecret = randomBytes(16).toString('hex');
  const labSecret = randomBytes(16).toString('hex');
  const lab = new FakeLab({
    now: opts.now, stepMs: opts.stepMs, webhookSecret: labSecret,
    // Order numbers unique to this instance: the lab forgets its orders on restart, the database doesn't.
    refPrefix: `FL${randomBytes(2).toString('hex').toUpperCase()}`,
    onWebhook: req => opts.deliver(`/hooks/fake/${hookSecret}`, req),
  });
  const adapter = new FakeLabAdapter({ lab, webhookSecret: labSecret, now: opts.now });
  const config: PartnerConfig = { adapter, region: 'in', hookSecret };
  return { config, lab, adapter };
}
