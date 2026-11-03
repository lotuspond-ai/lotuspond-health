// Webhook receiver (design doc §5.2): POST /hooks/:partner/:hookSecret.
// It checks the secret path, the address allowlist and the signature, stores the request in the inbox
// (sealed, deduplicated) and replies 200 at once. It doesn't touch orders: the processor does that later,
// asking the partner for the truth (§4.3). Replies say nothing about why a request was refused beyond the status.
import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { PartnerId } from '../../../../shared/lab-bundle.ts';
import type { Sealer } from '../sealer.ts';
import type { Logger } from '../log.ts';
import type { PartnerRegistry, WebhookInfo } from '../partners/types.ts';
import type { WebhookInbox } from '../store/types.ts';

/** Where a partner's webhooks go: its region cell's inbox and sealer. */
export interface WebhookTarget {
  inbox: WebhookInbox;
  sealer: Sealer;
  /** Called after a new webhook is stored, to wake the processor. */
  onStored?: () => void;
}

export interface ReceiverDeps {
  partners: PartnerRegistry;
  /** The inbox for a partner, or null if it has none (not enabled here). */
  target: (partner: PartnerId) => WebhookTarget | null;
  now: () => number;
  log: Logger;
  /** The client's address as this deployment sees it (behind a proxy, from its trusted header). */
  clientIp?: (c: Context) => string;
  /** Default 256 KiB. */
  maxBodyBytes?: number;
}

/** Never stored: credentials some partners send alongside (or instead of) a signature. */
const DROP_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'x-api-key']);

/** What a sealed inbox body is bound to. */
export const inboxContext = (partner: string, dedupeKey: string) => `webhook:${partner}:${dedupeKey}`;

const digest = (s: string) => createHash('sha256').update(s).digest();
const sameSecret = (expected: string, given: string) => timingSafeEqual(digest(expected), digest(given));

export function webhookRoutes(deps: ReceiverDeps): Hono {
  const app = new Hono();
  const tooLarge = (c: Context) => c.json({ error: 'too_large' }, 413);

  app.post('/:partner/:hookSecret', bodyLimit({ maxSize: deps.maxBodyBytes ?? 256 * 1024, onError: tooLarge }), async c => {
    const partner = c.req.param('partner') as PartnerId;
    const cfg = deps.partners.get(partner);
    const target = cfg ? deps.target(partner) : null;
    // Same reply for an unknown partner and a wrong secret, so neither can be probed.
    if (!cfg || !target || !sameSecret(cfg.hookSecret, c.req.param('hookSecret') ?? '')) return c.json({ error: 'not_found' }, 404);

    const ip = deps.clientIp?.(c) ?? '';
    if (cfg.allowIps && !cfg.allowIps.includes(ip)) {
      deps.log.warn('webhook from an address not on the allowlist', { partner, ip, alert: true });
      return c.json({ error: 'forbidden' }, 403);
    }

    const rawBody = new Uint8Array(await c.req.arrayBuffer());
    const allHeaders: Record<string, string> = {};
    c.req.raw.headers.forEach((v, k) => { allHeaders[k.toLowerCase()] = v; });
    if (!cfg.adapter.verifyWebhook({ headers: allHeaders, rawBody, ip })) {
      deps.log.warn('webhook signature rejected', { partner, ip, alert: true });
      return c.json({ error: 'bad_signature' }, 401);
    }

    let info: WebhookInfo;
    try {
      info = cfg.adapter.parseWebhook(JSON.parse(Buffer.from(rawBody).toString('utf8')));
    } catch {
      // Signed by the partner but not something we understand: their bug or a format change. Worth a look.
      deps.log.warn('webhook body not understood', { partner, alert: true });
      return c.json({ error: 'bad_request' }, 400);
    }

    const headers = Object.fromEntries(Object.entries(allHeaders).filter(([k]) => !DROP_HEADERS.has(k)));
    const dedupeKey = info.eventId ?? `sha256:${createHash('sha256').update(rawBody).digest('hex')}`;
    const { id, duplicate } = await target.inbox.add({ partner, dedupeKey, headers, body: target.sealer.seal(rawBody, inboxContext(partner, dedupeKey)), receivedAt: deps.now() });
    deps.log.info('webhook stored', { partner, inboxId: id, duplicate });
    if (!duplicate) target.onStored?.();
    // A duplicate still gets 200, so the partner stops retrying.
    return c.json({ received: true }, 200);
  });

  return app;
}
