// Eka Care's webhooks for ABDM events, at POST /hooks/eka (outside /api: Eka calls it, not a browser).
//
// Signature: Eka-Webhook-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(signing key, `${t}.${raw body}`)>, checked
// against the raw body before parsing, within 180 seconds. Eka wants a 200 within 5 seconds and retries otherwise,
// so the work (a check of the person's ABHA records) is started in the background and the answer goes back at once.
// Events arrive more than once: the top-level transaction_id is remembered for a while and repeats are ignored.
//
// What starts a check: abha.consent_update (a consent was granted), abha.subscription_notify (a facility linked a
// new record) and abha.hiu_data_push (records arrived). The person is found by their Eka id (data.oid).
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';

const TOLERANCE_S = 180;
const WAKE_EVENTS = new Set(['abha.consent_update', 'abha.subscription_notify', 'abha.hiu_data_push', 'abha.subscription_modified']);

/** Whether a signature header matches the raw body, within the time window. */
export function verifyEkaSignature(header: string | undefined, rawBody: string, key: string, nowMs = Date.now()): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map(p => { const i = p.indexOf('='); return [p.slice(0, i).trim(), p.slice(i + 1).trim()]; }));
  const t = Number(parts.t);
  const v1 = parts.v1 ?? '';
  if (!Number.isFinite(t) || !/^[0-9a-f]{64}$/i.test(v1)) return false;
  if (Math.abs(nowMs / 1000 - t) > TOLERANCE_S) return false;
  const want = createHmac('sha256', key).update(`${parts.t}.${rawBody}`).digest();
  return timingSafeEqual(want, Buffer.from(v1, 'hex'));
}

/** A stable reference for a person's Eka id, kept on the connection so a webhook can find it (the id is not kept). */
export const ekaRef = (oid: string) => createHash('sha256').update(`eka-oid\u0000${oid}`).digest('hex');

export interface EkaWebhookOptions {
  signingKey: string;
  /** Start a check for the connections of this person; returns how many were started. */
  wake(ref: string): Promise<number>;
  now?: () => number;
}

export function ekaWebhookRoutes(o: EkaWebhookOptions) {
  const app = new Hono();
  const seen = new Map<string, number>();
  const now = o.now ?? Date.now;

  app.post('/', async c => {
    const raw = await c.req.text();
    if (raw.length > 1_000_000) return c.json({ error: 'too large' }, 413);
    if (!verifyEkaSignature(c.req.header('eka-webhook-signature'), raw, o.signingKey, now())) return c.json({ error: 'bad signature' }, 401);
    let body: { event?: string; transaction_id?: string; data?: { oid?: string; status?: string; notification?: { status?: string } } };
    try { body = JSON.parse(raw); } catch { return c.json({ error: 'bad json' }, 400); }
    const id = body.transaction_id ? `${body.event}:${body.transaction_id}` : null;
    const at = now();
    for (const [k, t] of seen) if (at - t > 24 * 60 * 60_000) seen.delete(k);
    if (id && seen.has(id)) return c.json({ ok: true, duplicate: true });
    if (id) seen.set(id, at);
    const oid = body.data?.oid;
    const status = String(body.data?.notification?.status ?? body.data?.status ?? '').toUpperCase();
    const wanted = body.event && WAKE_EVENTS.has(body.event) && (body.event !== 'abha.consent_update' || status === 'GRANTED');
    if (oid && wanted) void o.wake(ekaRef(oid)).catch(e => console.error(`[records] Eka webhook: ${e instanceof Error ? e.message : String(e)}`));
    return c.json({ ok: true });
  });

  return app;
}
