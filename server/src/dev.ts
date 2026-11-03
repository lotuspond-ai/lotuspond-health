// Development server: the client API and webhook receiver over real HTTP, the simulated lab posting signed
// webhooks to it, and the inbox processor, poller and placement retries on timers. Everything is in memory.
//
// On start it signs in a demo user through the API (the OTP is printed here instead of sent by SMS) and
// books four demo orders with POST /v1/orders, then prints each order's progress. Run: npm run dev:server
// Options: PORT (default 8787), FAKE_LAB_STEP_MS (default 3000), APP_ORIGIN (allowed CORS origin,
// default http://localhost:5173), --once (exit when the demo orders finish).
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import { AuthService } from './auth/service.ts';
import { BookingService } from './booking/service.ts';
import { aesGcmSealer } from './crypto/sealer.ts';
import { createApp } from './http/app.ts';
import { fixedWindowLimiter } from './http/ratelimit.ts';
import type { Logger } from './log.ts';
import { reconcile } from './orders/reconcile.ts';
import { isFinal } from './orders/state.ts';
import type { OrderHooks, SyncDeps } from './orders/sync.ts';
import { FakeLab } from './partners/fake-lab.ts';
import { FakeLabAdapter } from './partners/fake.ts';
import type { PartnerRegistry } from './partners/types.ts';
import { MemoryAccountStore, MemoryOrderStore, MemoryWebhookInbox } from './store/memory.ts';
import { istDate } from './time.ts';
import { WebhookProcessor } from './webhooks/processor.ts';

const PORT = Number(process.env.PORT ?? 8787);
const STEP_MS = Number(process.env.FAKE_LAB_STEP_MS ?? 3000);
const APP_ORIGIN = process.env.APP_ORIGIN ?? 'http://localhost:5173';
const ONCE = process.argv.includes('--once');
const BASE = `http://127.0.0.1:${PORT}`;
const HOOK_SECRET = randomBytes(16).toString('hex');
const LAB_SECRET = randomBytes(16).toString('hex');
const NOTICE_VERSION = 'dev-2026-11-01';
const started = Date.now();

const elapsed = () => `+${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s`;
const print = (line: string) => console.log(`${elapsed()}  ${line}`);

/** Readable log lines for the terminal; alerts stand out. Fields are ids only, as in production. */
const QUIET = new Set(['webhook stored', 'order status changed', 'order created', 'order booked', 'otp sent', 'signed in']);
const log: Logger = {
  info: (msg, f = {}) => { if (!QUIET.has(msg)) print(`  · ${msg} ${JSON.stringify(f)}`); },
  warn: (msg, f = {}) => print(`${f.alert ? '! ALERT' : '  warn'} ${msg} ${JSON.stringify(f)}`),
  error: (msg, f = {}) => print(`! ${f.alert ? 'ALERT' : 'error'} ${msg} ${JSON.stringify(f)}`),
};

const orders = new MemoryOrderStore();
const inbox = new MemoryWebhookInbox();
const accounts = new MemoryAccountStore();
const inboxSealer = aesGcmSealer(randomBytes(32));
const piiSealer = aesGcmSealer(randomBytes(32));

const lab = new FakeLab({
  stepMs: STEP_MS,
  webhookSecret: LAB_SECRET,
  onWebhook: async req => {
    const res = await fetch(`${BASE}/hooks/fake/${HOOK_SECRET}`, { method: 'POST', headers: req.headers, body: req.rawBody });
    if (!res.ok) throw new Error(`receiver replied ${res.status}`);
  },
});
const adapter = new FakeLabAdapter({ lab, webhookSecret: LAB_SECRET });
const partners: PartnerRegistry = new Map([['fake', { adapter, hookSecret: HOOK_SECRET, allowIps: ['127.0.0.1', '::1', '::ffff:127.0.0.1'] }]]);

const labels = new Map<string, string>();
const label = (id: string) => labels.get(id) ?? id;
const hooks: OrderHooks = {
  onTransition: (o, from) => print(`${label(o.id).padEnd(7)} ${from} → ${o.status}${o.partnerStatus ? `   (lab: ${o.partnerStatus})` : ''}`),
  onReportUpdate: o => print(`${label(o.id).padEnd(7)} report to fetch   (lab: ${o.partnerStatus}; the results pipeline isn't built yet)`),
};
const deps: SyncDeps = { orders, partners, now: Date.now, log, hooks };
const processor = new WebhookProcessor({ ...deps, inbox, sealer: inboxSealer }, { baseDelayMs: 2000, maxDelayMs: 10_000 });

const otpCodes = new Map<string, string>();
const auth = new AuthService({
  accounts, now: Date.now, log,
  // Development only: keep the code for the demo sign-in and print it. Production sends an SMS.
  sender: { async send(phone, code) { otpCodes.set(phone, code); print(`OTP for ${phone}: ${code}   (printed here in development only)`); } },
}, { otpPepper: randomBytes(32) });
const booking = new BookingService({ orders, accounts, partners, sealer: piiSealer, now: Date.now, log, hooks }, {
  noticeVersion: NOTICE_VERSION, placementRetryDelaysMs: [5000, 10_000, 20_000],
});

const clientIp = (c: Context) => getConnInfo(c).remote.address ?? '';
const app = createApp({
  receiver: { partners, inbox, sealer: inboxSealer, now: Date.now, log, clientIp, onStored: () => { void processor.runOnce(); } },
  api: { auth, booking, log, now: Date.now, clientIp, otpLimiter: fixedWindowLimiter(20, 3600_000), verifyLimiter: fixedWindowLimiter(30, 3600_000) },
  allowedOrigins: [APP_ORIGIN],
  log,
});

await new Promise<void>(resolve => serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, () => {
  print(`API on ${BASE}/v1, webhooks on ${BASE}/hooks/fake/<secret>; CORS for ${APP_ORIGIN}; lab steps every ${STEP_MS} ms`);
  resolve();
}));

const stopLab = lab.start(1000);
const timers = [
  setInterval(() => { void processor.runOnce(); }, 2000),
  setInterval(() => { void booking.retryPlacements(); }, 2000),
  // Poll every 15 s here, instead of hours, so the no-webhooks order visibly catches up.
  setInterval(() => {
    const every = { booked: 15_000, collector_assigned: 15_000, sample_collected: 15_000, recollection_needed: 15_000, processing: 15_000, partial_report: 15_000 };
    void reconcile(deps, { every });
  }, 5000),
];

/* ---------------- demo: a user signs in and books, through the API ---------------- */

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() as Record<string, any> };
}

const phone = '+919812345678';
await api('POST', '/v1/auth/otp', { phone });
const { body: session } = await api('POST', '/v1/auth/verify', { phone, code: otpCodes.get(phone) });
const authz = { authorization: `Bearer ${session.token}` };
print(`signed in as ${session.userId}`);

const tomorrow = istDate(Date.now() + 86_400_000);
const { body: { slots } } = await api('GET', `/v1/slots?partner=fake&pincode=560034&date=${tomorrow}&items=FL_ESSENTIAL`);
const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = publicKey.export({ format: 'jwk' });
const devicePublicKey = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };

const demo: [string, string][] = [
  ['plain', 'Asha Rao'],
  ['messy', 'Ravi Kumar #out-of-order #duplicate-webhooks #amended'],
  ['lost', 'Meera Iyer #lost-response #partial'],
  ['quiet', 'Kiran Shah #no-webhooks'],
];
const ids: string[] = [];
for (const [i, [name, patient]] of demo.entries()) {
  const r = await api('POST', '/v1/orders', {
    partner: 'fake', items: ['FL_ESSENTIAL'], slot: slots[i % slots.length],
    patient: { name: patient, age: 34, sex: 'female' },
    address: { line1: '12 Lake Road', city: 'Bengaluru', pincode: '560034' },
    devicePublicKey, consent: { noticeVersion: NOTICE_VERSION, accepted: true },
  }, { ...authz, 'idempotency-key': `demo-${name}-${started}` });
  ids.push(r.body.order.id);
  labels.set(r.body.order.id, name);
  print(`${name.padEnd(7)} POST /v1/orders → ${r.status} ${r.body.order.status}${r.body.order.partnerRef ? ` (lab order ${r.body.order.partnerRef})` : ''}   "${patient}"`);
}

if (ONCE) {
  const done = setInterval(async () => {
    const all = (await api('GET', '/v1/orders', undefined, authz)).body.orders as { id: string; status: Parameters<typeof isFinal>[0] }[];
    const messy = await orders.get(ids[1]);
    if (all.every(o => o.status === 'report_ready' || isFinal(o.status)) && messy?.partnerStatus === 'REPORT_AMENDED') {
      clearInterval(done);
      for (const id of ids) {
        const { body } = await api('GET', `/v1/orders/${id}`, undefined, authz);
        print(`${label(id).padEnd(7)} GET /v1/orders/:id → ${body.order.status}; timeline ${body.order.timeline.map((e: { status: string }) => e.status).join(' → ')}`);
      }
      const items = inbox.all();
      print(`inbox: ${items.length} webhooks stored, ${items.filter(i => i.processedAt).length} processed, ${items.filter(i => i.deadAt).length} dead`);
      stopLab();
      timers.forEach(clearInterval);
      process.exit(0);
    }
  }, 1000);
}
