// WhatsApp (docs/whatsapp.md).
//   GET    /api/whatsapp        whether it is set up, the linked number (partly hidden), a pending code
//   POST   /api/whatsapp/link   agree to the WhatsApp notice and get a code ({ noticeVersion }); the app opens WhatsApp with it
//   PATCH  /api/whatsapp/link   choose the profile WhatsApp works on ({ profileId })
//   DELETE /api/whatsapp/link   unlink the number (and cancel a pending code)
//   GET    /hooks/whatsapp      Meta's webhook verification (hub.challenge)
//   POST   /hooks/whatsapp      deliveries, signed with the app secret (X-Hub-Signature-256)
import { Hono } from 'hono';
import { z } from 'zod';
import { ASSISTANT_NOTICE_VERSION } from '../../../shared/assistant.ts';
import { linkMessage, maskPhone, WHATSAPP_NOTICE_VERSION, type WhatsAppInfo, type WhatsAppLink, type WhatsAppLinkStart } from '../../../shared/whatsapp.ts';
import { eventContext, recordEvent } from '../compliance/audit.ts';
import type { WhatsAppLinkRow } from '../db/schema.ts';
import { conflict, HttpError, notFound, tooMany } from '../lib/errors.ts';
import { RateLimiter } from '../lib/rate-limit.ts';
import { readJson, requireAuth, UUID, type AppEnv, type Deps } from '../http.ts';
import { accountProfiles, assistantConsent } from '../assistant/turn.ts';
import { validSignature } from './client.ts';
import type { WhatsAppService } from './service.ts';

const LinkBody = z.object({ noticeVersion: z.string() });
const ProfileBody = z.object({ profileId: z.string().regex(UUID) });

const toLink = (r: WhatsAppLinkRow): WhatsAppLink => ({
  phone: maskPhone(r.phone), profileId: r.profileId, linkedAt: r.createdAt.toISOString(), lastMessageAt: r.lastMessageAt?.toISOString() ?? null,
});

/** "+91 98765 43210" for an Indian number, "+44 7700900123" otherwise. */
const showNumber = (d: string) => (d.startsWith('91') && d.length === 12 ? `+91 ${d.slice(2, 7)} ${d.slice(7)}` : `+${d}`);

export function whatsappRoutes(deps: Deps, wa: WhatsAppService | undefined) {
  const app = new Hono<AppEnv>();
  const codes = new RateLimiter(10, 60 * 60_000);
  app.use('*', requireAuth(deps));

  app.get('/', async c => {
    const body: WhatsAppInfo = {
      enabled: !!wa, noticeVersion: WHATSAPP_NOTICE_VERSION,
      link: wa ? (await wa.linkOf(c.var.cell, c.var.user.id).then(r => r && toLink(r))) : null,
      pending: wa ? await wa.pendingCode(c.var.user.id).then(p => p && { expiresAt: p.expiresAt.toISOString() }) : null,
    };
    return c.json(body);
  });

  app.post('/link', async c => {
    if (!wa) throw new HttpError(503, 'whatsapp_unavailable', 'WhatsApp is not set up on this server.');
    const body = await readJson(c, LinkBody);
    if (body.noticeVersion !== WHATSAPP_NOTICE_VERSION) throw conflict('The WhatsApp notice has changed since this page was loaded. Reload the app and try again.', 'notice_outdated');
    const consent = await assistantConsent(c.var.cell.db, c.var.user.id);
    if (!consent?.granted || consent.version !== ASSISTANT_NOTICE_VERSION) throw conflict('Turn on the assistant first: WhatsApp messages are answered by it.', 'assistant_consent_required');
    const wait = codes.hit(c.var.user.id);
    if (wait) throw tooMany(`Too many codes in the last hour. Try again in ${Math.ceil(wait / 60)} minutes.`);
    const { code, expiresAt } = await wa.startLink(c.var.cell, c.var.user.region, c.var.user);
    await recordEvent(c.var.cell.db, eventContext(c, deps), c.var.user.id, 'consent_changed', { consent: 'whatsapp', granted: true });
    const out: WhatsAppLinkStart = {
      code, expiresAt: expiresAt.toISOString(), number: showNumber(wa.config.number),
      url: `https://wa.me/${wa.config.number}?text=${encodeURIComponent(linkMessage(code))}`,
    };
    return c.json(out, 201);
  });

  app.patch('/link', async c => {
    if (!wa) throw new HttpError(503, 'whatsapp_unavailable', 'WhatsApp is not set up on this server.');
    const body = await readJson(c, ProfileBody);
    const all = await accountProfiles(c.var.cell.db, c.var.user.id);
    if (!all.some(p => p.id === body.profileId)) throw notFound('That profile');
    const row = await wa.setProfile(c.var.cell, c.var.user.id, body.profileId);
    if (!row) throw notFound('A linked number');
    return c.json(toLink(row));
  });

  app.delete('/link', async c => {
    if (wa && await wa.unlink(c.var.cell, c.var.user, true)) {
      await recordEvent(c.var.cell.db, eventContext(c, deps), c.var.user.id, 'consent_changed', { consent: 'whatsapp', granted: false });
    }
    return c.body(null, 204);
  });

  return app;
}

/** Meta's webhook: server to server, outside /api. */
export function whatsappHookRoutes(wa: WhatsAppService) {
  const app = new Hono();
  app.get('/', c => {
    const q = c.req.query();
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === wa.config.verifyToken && q['hub.challenge']) return c.text(q['hub.challenge']);
    return c.text('Forbidden', 403);
  });
  app.post('/', async c => {
    const raw = new Uint8Array(await c.req.arrayBuffer());
    if (raw.byteLength > 1024 * 1024) return c.text('Too large', 413);
    if (!validSignature(wa.config.appSecret, raw, c.req.header('x-hub-signature-256'))) return c.text('Bad signature', 401);
    let body: unknown;
    try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { return c.text('Bad JSON', 400); }
    // Meta wants a quick 200; the messages are handled after it.
    wa.receive(body);
    return c.text('OK');
  });
  return app;
}
