// Lab booking API (docs/lab-booking-backend.md §7), on main's sessions, profiles, validation and audit log:
//   GET  /api/lab/catalog?pincode=                    packages from the partners serving the account's region
//   GET  /api/lab/slots?partner=&pincode=&date=&items=
//   POST /api/profiles/:pid/lab-orders                book for that profile (Idempotency-Key header)
//   GET  /api/profiles/:pid/lab-orders                the profile's orders, newest first
//   GET  /api/profiles/:pid/lab-orders/:oid           one order with its timeline
//   POST /api/profiles/:pid/lab-orders/:oid/cancel    { reason? }
//   POST /api/profiles/:pid/lab-orders/:oid/reschedule { slot }
//   GET  /api/profiles/:pid/lab-results               pending results (?status=all for every delivery)
//   GET  /api/profiles/:pid/lab-results/:rid/report   the report PDF
//   POST /api/profiles/:pid/lab-results/:rid/save     { measurements } as reviewed in the app: saved as records
//   POST /api/profiles/:pid/lab-results/:rid/dismiss  drop it without saving
// Partner webhooks are served at /hooks/:partner/:hookSecret (hookRoutes), outside /api and its browser checks.
import { Hono } from 'hono';
import { z } from 'zod';
import { LIMITS } from '../../../shared/constants.ts';
import { eventContext, recordEvent } from '../compliance/audit.ts';
import { badRequest, HttpError, notFound } from '../lib/errors.ts';
import { clientIp, readJson, requireAuth, type AppEnv, type Ctx, type Deps } from '../http.ts';
import { contentDisposition, requireProfile } from '../routes/profiles.ts';
import { MeasurementInput } from '../schemas.ts';
import { BookingError, type Owner } from './booking/service.ts';
import { LabCancelBody, LabOrderCreateBody, LabRescheduleBody, type BookingInput } from './booking/validate.ts';
import { orderView } from './booking/view.ts';
import { consoleLogger } from './log.ts';
import type { Labs, LabRuntime } from './runtime.ts';
import { webhookRoutes } from './webhooks/receiver.ts';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;

function runtime(labs: Labs, c: Ctx): LabRuntime {
  const rt = labs.forCell(c.var.cell);
  if (!rt) throw new BookingError('not_in_region', 'Lab booking is not available for accounts in your region yet.');
  return rt;
}

export function labRoutes(deps: Deps, labs: Labs) {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth(deps));

  app.get('/catalog', async c => {
    const pincode = c.req.query('pincode') ?? '';
    const rt = labs.forCell(c.var.cell);
    const r = rt ? await rt.booking.catalog(c.var.user.region, pincode) : { items: [], unavailable: [] };
    return c.json({ pincode, ...r });
  });

  app.get('/slots', async c => {
    const items = (c.req.query('items') ?? '').split(',').map(s => s.trim()).filter(Boolean);
    const slots = await runtime(labs, c).booking.slots(c.var.user.region, c.req.query('partner') ?? '', c.req.query('pincode') ?? '', c.req.query('date') ?? '', items);
    return c.json({ slots });
  });

  return app;
}

export function labOrderRoutes(deps: Deps, labs: Labs) {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth(deps));
  app.use('*', requireProfile());
  const owner = (c: Ctx): Owner => ({ userId: c.var.user.id, region: c.var.user.region, profileId: c.var.profile.id });

  app.post('/', async c => {
    const key = c.req.header('idempotency-key') ?? '';
    if (!IDEMPOTENCY_KEY.test(key)) {
      throw badRequest('Send an Idempotency-Key header (8 to 100 letters, digits, - or _), new for each booking.', 'idempotency_key_required');
    }
    const input = await readJson(c, LabOrderCreateBody) as BookingInput;
    const rt = runtime(labs, c);
    const { order, replayed } = await rt.booking.createOrder(owner(c), input, key);
    const body = { order: orderView(order) };
    if (replayed) {
      c.header('Idempotent-Replayed', 'true');
      return c.json(body, 200);
    }
    await recordEvent(c.var.cell.db, eventContext(c, deps), c.var.user.id, 'lab_order_created', { profileId: order.profileId });
    if (order.status === 'failed') {
      const reason = order.failureReason ?? 'failed';
      throw new HttpError(reason === 'slot_unavailable' ? 409 : 422, reason,
        reason === 'slot_unavailable' ? 'That slot was just taken. Pick another.' : 'The lab could not take this booking.', body);
    }
    // 202 while the lab hasn't confirmed yet: the app shows "confirming" and reads the order again.
    return c.json(body, order.status === 'placing' ? 202 : 201);
  });

  app.get('/', async c => {
    const orders = await runtime(labs, c).booking.list(owner(c));
    return c.json({ orders: orders.map(o => orderView(o)) });
  });

  app.get('/:oid', async c => {
    const { order, events } = await runtime(labs, c).booking.get(owner(c), c.req.param('oid'));
    return c.json({ order: orderView(order, events) });
  });

  app.post('/:oid/cancel', async c => {
    const body = await readJson(c, LabCancelBody);
    const before = await runtime(labs, c).booking.get(owner(c), c.req.param('oid'));
    const order = await runtime(labs, c).booking.cancel(owner(c), c.req.param('oid'), body.reason || 'Cancelled by the customer');
    if (before.order.status !== 'cancelled' && order.status === 'cancelled') {
      await recordEvent(c.var.cell.db, eventContext(c, deps), c.var.user.id, 'lab_order_cancelled', { profileId: order.profileId });
    }
    return c.json({ order: orderView(order) });
  });

  app.post('/:oid/reschedule', async c => {
    const { slot } = await readJson(c, LabRescheduleBody);
    const order = await runtime(labs, c).booking.reschedule(owner(c), c.req.param('oid'), slot);
    return c.json({ order: orderView(order) });
  });

  return app;
}

/** The reviewed values to save; sourceFile and documentId are set by the server. */
const LabResultSaveBody = z.object({
  measurements: z.array(MeasurementInput).max(LIMITS.measurementsPerRequest),
});

export function labResultRoutes(deps: Deps, labs: Labs) {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth(deps));
  app.use('*', requireProfile());

  app.get('/', async c => {
    const rt = labs.forCell(c.var.cell);
    return c.json({ results: rt ? await rt.results.list(c.var.profile.id, c.req.query('status') === 'all') : [] });
  });

  app.get('/:rid/report', async c => {
    const file = await runtime(labs, c).results.pdf(c.var.profile.id, c.req.param('rid'));
    if (!file) throw notFound('That report');
    return new Response(file.stream, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': contentDisposition('inline', file.fileName),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      },
    });
  });

  app.post('/:rid/save', async c => {
    const { measurements } = await readJson(c, LabResultSaveBody);
    const r = await runtime(labs, c).results.save(c.var.profile.id, c.req.param('rid'), measurements);
    await recordEvent(c.var.cell.db, eventContext(c, deps), c.var.user.id, 'lab_results_saved', { profileId: c.var.profile.id });
    return c.json(r);
  });

  app.post('/:rid/dismiss', async c => {
    const result = await runtime(labs, c).results.dismiss(c.var.profile.id, c.req.param('rid'));
    return c.json({ result });
  });

  return app;
}

/** Partner webhooks: stored in the partner's region cell, processed in the background. */
export function hookRoutes(deps: Deps, labs: Labs) {
  return webhookRoutes({
    partners: labs.partners, target: labs.target, now: Date.now, log: consoleLogger,
    clientIp: c => clientIp(c as Ctx, deps.config.trustProxy),
  });
}
