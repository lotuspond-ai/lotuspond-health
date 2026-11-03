// Development server: the webhook receiver over real HTTP, the simulated lab posting signed webhooks to it,
// and the inbox processor and poller on timers. Everything is in memory.
//
// There's no booking API yet, so on start it places a few demo orders straight through the adapter (the
// way the booking service will) and prints each order's progress. Run: npm run dev:server
// Options: PORT (default 8787), FAKE_LAB_STEP_MS (default 3000), --once (exit when the demo orders finish).
import { randomBytes } from 'node:crypto';
import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { aesGcmSealer } from './crypto/sealer.ts';
import { createApp } from './http/app.ts';
import type { Logger } from './log.ts';
import { reconcile } from './orders/reconcile.ts';
import { checkMove, isFinal } from './orders/state.ts';
import type { OrderHooks, SyncDeps } from './orders/sync.ts';
import { FakeLab, istDate } from './partners/fake-lab.ts';
import { FakeLabAdapter } from './partners/fake.ts';
import { PartnerError, type PartnerRegistry } from './partners/types.ts';
import { MemoryOrderStore, MemoryWebhookInbox } from './store/memory.ts';
import { WebhookProcessor } from './webhooks/processor.ts';

const PORT = Number(process.env.PORT ?? 8787);
const STEP_MS = Number(process.env.FAKE_LAB_STEP_MS ?? 3000);
const ONCE = process.argv.includes('--once');
const HOOK_SECRET = randomBytes(16).toString('hex');
const LAB_SECRET = randomBytes(16).toString('hex');
const started = Date.now();

const elapsed = () => `+${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s`;
const print = (line: string) => console.log(`${elapsed()}  ${line}`);

/** Readable log lines for the terminal; alerts stand out. Fields are ids only, as in production. */
const log: Logger = {
  info: (msg, f = {}) => { if (msg !== 'webhook stored' && msg !== 'order status changed') print(`  · ${msg} ${JSON.stringify(f)}`); },
  warn: (msg, f = {}) => print(`${f.alert ? '! ALERT' : '  warn'} ${msg} ${JSON.stringify(f)}`),
  error: (msg, f = {}) => print(`! ${f.alert ? 'ALERT' : 'error'} ${msg} ${JSON.stringify(f)}`),
};

const orders = new MemoryOrderStore();
const inbox = new MemoryWebhookInbox();
const sealer = aesGcmSealer(randomBytes(32));

const lab = new FakeLab({
  stepMs: STEP_MS,
  webhookSecret: LAB_SECRET,
  onWebhook: async req => {
    const res = await fetch(`http://127.0.0.1:${PORT}/hooks/fake/${HOOK_SECRET}`, { method: 'POST', headers: req.headers, body: req.rawBody });
    if (!res.ok) throw new Error(`receiver replied ${res.status}`);
  },
});
const adapter = new FakeLabAdapter({ lab, webhookSecret: LAB_SECRET });
const partners: PartnerRegistry = new Map([['fake', { adapter, hookSecret: HOOK_SECRET, allowIps: ['127.0.0.1', '::1', '::ffff:127.0.0.1'] }]]);

const hooks: OrderHooks = {
  onTransition: (o, from) => print(`${o.id}  ${from} → ${o.status}   (lab: ${o.partnerStatus})`),
  onReportUpdate: o => print(`${o.id}  report to fetch   (lab: ${o.partnerStatus}; the results pipeline isn't built yet)`),
};
const deps: SyncDeps = { orders, partners, now: Date.now, log, hooks };
const processor = new WebhookProcessor({ ...deps, inbox, sealer }, { baseDelayMs: 2000, maxDelayMs: 10_000 });
const wake = () => { void processor.runOnce(); };

const app = createApp({
  receiver: { partners, inbox, sealer, now: Date.now, log, clientIp: c => getConnInfo(c).remote.address ?? '', onStored: wake },
});

/** What the booking service will do: record the order, place it, mark it booked, or leave it placing if the reply was lost. */
async function book(id: string, name: string, items: string[]): Promise<void> {
  const now = Date.now();
  await orders.insert({ id, userId: 'demo', partner: 'fake', partnerRef: null, status: 'placing', partnerStatus: null, partnerStatusAt: null, lastSyncedAt: null, createdAt: now, updatedAt: now });
  const date = istDate(now + 86_400_000);
  const slot = (await adapter.slots({ pincode: '560034', date, items }))[0];
  try {
    const { partnerRef } = await adapter.createOrder({
      orderId: id, items, slot, patient: { name, age: 34, sex: 'female' }, phone: '+919812345678',
      address: { line1: '12 Lake Road', city: 'Bengaluru', pincode: '560034' },
    });
    await orders.apply(id, cur => checkMove(cur.status, 'booked', 'local').ok ? {
      next: { ...cur, partnerRef, status: 'booked', lastSyncedAt: now, updatedAt: now },
      events: [{ orderId: id, status: 'booked', partnerStatus: null, source: 'api', occurredAt: now, receivedAt: now }],
    } : null);
    print(`${id}  placing → booked   (lab order ${partnerRef}; "${name}")`);
  } catch (e) {
    if (!(e instanceof PartnerError && e.retryable)) throw e;
    print(`${id}  booking reply lost (${e.code}); left in placing for a webhook or retry to resolve   ("${name}")`);
  }
}

serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, info => {
  print(`webhook receiver on http://127.0.0.1:${info.port}/hooks/fake/<secret>; lab steps every ${STEP_MS} ms`);
});

const stopLab = lab.start(1000);
const processTimer = setInterval(wake, 2000);
// Poll every 15 s here, instead of hours, so the no-webhooks order visibly catches up.
const pollEvery = { booked: 15_000, collector_assigned: 15_000, sample_collected: 15_000, recollection_needed: 15_000, processing: 15_000, partial_report: 15_000 };
const pollTimer = setInterval(() => { void reconcile(deps, { every: pollEvery }); }, 5000);

const demo: [string, string][] = [
  ['ord_plain', 'Asha Rao'],
  ['ord_messy', 'Ravi Kumar #out-of-order #duplicate-webhooks #amended'],
  ['ord_lost', 'Meera Iyer #lost-response #partial'],
  ['ord_quiet', 'Kiran Shah #no-webhooks'],
];
for (const [id, name] of demo) await book(id, name, ['FL_ESSENTIAL']);

if (ONCE) {
  const done = setInterval(async () => {
    const all = await Promise.all(demo.map(([id]) => orders.get(id)));
    const finished = all.every(o => o && (o.status === 'report_ready' || isFinal(o.status)));
    const amended = all.find(o => o?.id === 'ord_messy')?.partnerStatus === 'REPORT_AMENDED';
    if (finished && amended) {
      clearInterval(done);
      for (const o of all) print(`${o!.id}  final: ${o!.status} (lab: ${o!.partnerStatus}); ${(await orders.events(o!.id)).length} events`);
      const items = inbox.all();
      print(`inbox: ${items.length} webhooks stored, ${items.filter(i => i.processedAt).length} processed, ${items.filter(i => i.deadAt).length} dead`);
      stopLab();
      clearInterval(processTimer);
      clearInterval(pollTimer);
      process.exit(0);
    }
  }, 1000);
}
