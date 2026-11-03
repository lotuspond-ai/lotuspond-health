// The client API, /v1 (design doc §7): sign-in, catalogue, slots and orders. Results, push subscriptions and
// account deletion come with the results pipeline. Errors are { error: code, message } with a fitting status.
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { AuthError, type AuthService } from '../auth/service.ts';
import { BookingError, type BookingService } from '../booking/service.ts';
import { parseBookingInput, parseSlot } from '../booking/validate.ts';
import { orderView } from '../booking/view.ts';
import type { Logger } from '../log.ts';
import { istIso } from '../time.ts';
import type { RateLimiter } from './ratelimit.ts';

export interface ApiDeps {
  auth: AuthService;
  booking: BookingService;
  log: Logger;
  now: () => number;
  /** The client's address as this deployment sees it (behind a proxy, from its trusted header). */
  clientIp: (c: Context) => string;
  /** Per-address limits for code requests and code checks. */
  otpLimiter: RateLimiter;
  verifyLimiter: RateLimiter;
}

type Env = { Variables: { userId: string } };

const AUTH_STATUS: Record<AuthError['code'], 400 | 401 | 429> = {
  invalid_phone: 400, too_soon: 429, too_many_codes: 429, invalid_code: 401, code_expired: 401, too_many_attempts: 429,
};
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;

function fail(c: Context, status: number, error: string, message: string, extra: Record<string, unknown> = {}) {
  return c.json({ error, message, ...extra }, status as 400);
}

async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

export function apiRoutes(deps: ApiDeps): Hono<Env> {
  const app = new Hono<Env>();
  const { auth, booking, log } = deps;

  // Responses can carry personal data: never cache them anywhere.
  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });
  app.use('*', bodyLimit({ maxSize: 32 * 1024, onError: c => fail(c, 413, 'too_large', 'Request body too large') }));

  app.onError((err, c) => {
    if (err instanceof BookingError) return fail(c, err.status, err.code, err.message);
    if (err instanceof AuthError) {
      if (err.retryAfterMs != null) c.header('Retry-After', String(Math.ceil(err.retryAfterMs / 1000)));
      return fail(c, AUTH_STATUS[err.code], err.code, err.message);
    }
    log.error('api request failed', { route: c.req.routePath, error: err.name, alert: true });
    return fail(c, 500, 'internal', 'Something went wrong');
  });

  const limited = (c: Context, limiter: RateLimiter) => {
    const wait = limiter.hit(deps.clientIp(c) || 'unknown', deps.now());
    if (!wait) return null;
    c.header('Retry-After', String(Math.ceil(wait / 1000)));
    return fail(c, 429, 'rate_limited', 'Too many requests; try again later');
  };

  /* ---------------- sign-in ---------------- */

  app.post('/auth/otp', async c => {
    const stop = limited(c, deps.otpLimiter);
    if (stop) return stop;
    const body = await jsonBody(c) as { phone?: unknown } | undefined;
    if (typeof body?.phone !== 'string') return fail(c, 400, 'invalid_request', 'phone is required');
    const r = await auth.requestOtp(body.phone);
    return c.json({ sent: true, expiresAt: istIso(r.expiresAt), resendAt: istIso(r.resendAt) }, 202);
  });

  app.post('/auth/verify', async c => {
    const stop = limited(c, deps.verifyLimiter);
    if (stop) return stop;
    const body = await jsonBody(c) as { phone?: unknown; code?: unknown } | undefined;
    if (typeof body?.phone !== 'string' || typeof body.code !== 'string') return fail(c, 400, 'invalid_request', 'phone and code are required');
    const r = await auth.verifyOtp(body.phone, body.code);
    return c.json({ token: r.token, expiresAt: istIso(r.expiresAt), userId: r.userId, newUser: r.newUser });
  });

  const requireUser = async (c: Context<Env>, next: () => Promise<void>) => {
    const header = c.req.header('authorization') ?? '';
    const m = /^Bearer (\S+)$/.exec(header);
    const session = m ? await auth.authenticate(m[1]) : null;
    if (!session) {
      c.header('WWW-Authenticate', 'Bearer');
      return fail(c, 401, 'unauthorized', 'Sign in first');
    }
    c.set('userId', session.userId);
    await next();
  };

  app.post('/auth/logout', requireUser, async c => {
    const token = /^Bearer (\S+)$/.exec(c.req.header('authorization') ?? '')![1];
    await auth.logout(token);
    return c.body(null, 204);
  });

  /* ---------------- catalogue and slots (no sign-in needed) ---------------- */

  app.get('/catalog', async c => {
    const pincode = c.req.query('pincode') ?? '';
    const r = await booking.catalog(pincode);
    return c.json({ pincode, items: r.items, unavailable: r.unavailable });
  });

  app.get('/slots', async c => {
    const items = (c.req.query('items') ?? '').split(',').map(s => s.trim()).filter(Boolean);
    const slots = await booking.slots(c.req.query('partner') ?? '', c.req.query('pincode') ?? '', c.req.query('date') ?? '', items);
    return c.json({ slots });
  });

  /* ---------------- orders ---------------- */

  app.post('/orders', requireUser, async c => {
    const key = c.req.header('idempotency-key') ?? '';
    if (!IDEMPOTENCY_KEY.test(key)) return fail(c, 400, 'idempotency_key_required', 'Send an Idempotency-Key header (8 to 100 letters, digits, - or _), new for each booking');
    const parsed = parseBookingInput(await jsonBody(c));
    if (!parsed.ok) return fail(c, 400, 'invalid_request', 'The booking is incomplete or malformed', { details: parsed.errors });
    const { order, replayed } = await booking.createOrder(c.get('userId'), parsed.value, key);
    const body = { order: orderView(order) };
    if (replayed) {
      c.header('Idempotent-Replayed', 'true');
      return c.json(body, 200);
    }
    if (order.status === 'failed') {
      const reason = order.failureReason ?? 'failed';
      const status = reason === 'slot_unavailable' ? 409 : 422;
      return fail(c, status, reason, reason === 'slot_unavailable' ? 'That slot was just taken; pick another' : 'The lab could not take this booking', body);
    }
    // 202 while the lab hasn't confirmed yet: the app shows "confirming" and polls GET /v1/orders/:id.
    return c.json(body, order.status === 'placing' ? 202 : 201);
  });

  app.get('/orders', requireUser, async c => {
    const orders = await booking.list(c.get('userId'));
    return c.json({ orders: orders.map(o => orderView(o)) });
  });

  app.get('/orders/:id', requireUser, async c => {
    const { order, events } = await booking.get(c.get('userId'), c.req.param('id') ?? '');
    return c.json({ order: orderView(order, events) });
  });

  app.post('/orders/:id/cancel', requireUser, async c => {
    const body = await jsonBody(c) as { reason?: unknown } | undefined;
    const reason = typeof body?.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 200) : 'Cancelled by the customer';
    const order = await booking.cancel(c.get('userId'), c.req.param('id') ?? '', reason);
    return c.json({ order: orderView(order) });
  });

  app.post('/orders/:id/reschedule', requireUser, async c => {
    const body = await jsonBody(c) as { slot?: unknown } | undefined;
    const errors: string[] = [];
    const slot = parseSlot(body?.slot, errors);
    if (!slot) return fail(c, 400, 'invalid_request', 'A new slot is required', { details: errors });
    const order = await booking.reschedule(c.get('userId'), c.req.param('id') ?? '', slot);
    return c.json({ order: orderView(order) });
  });

  return app;
}
