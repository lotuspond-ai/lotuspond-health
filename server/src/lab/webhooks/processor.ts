// Works through the webhook inbox (design doc §5.2): opens each stored request, finds its order and
// syncs it with the partner. A webhook only says "look at this order"; the status comes from the partner API.
//
// Failures are retried with backoff and dead-lettered after maxAttempts:
// - an order we can't find yet (its booking reply may still be on the way) is retried;
// - a partner timeout or outage is retried;
// - a body we can't read or a partner error that won't change on retry goes straight to dead letter.
import type { PartnerId } from '../../../../shared/lab-bundle.ts';
import type { Sealer } from '../sealer.ts';
import { inboxContext } from './receiver.ts';
import { syncOrder, type SyncDeps } from '../orders/sync.ts';
import { PartnerError, type PartnerConfig, type WebhookInfo } from '../partners/types.ts';
import type { InboxItem, OrderRecord, WebhookInbox } from '../store/types.ts';

export interface ProcessorDeps extends SyncDeps {
  inbox: WebhookInbox;
  sealer: Sealer;
}

export interface ProcessorOptions {
  /** Default 10. */
  maxAttempts?: number;
  /** First retry delay; doubles each attempt. Default 1 minute. */
  baseDelayMs?: number;
  /** Default 1 hour. */
  maxDelayMs?: number;
  /** Items per run. Default 50. */
  batchSize?: number;
}

export interface ProcessResult { processed: number; retrying: number; dead: number }

class Retry extends Error {}
class Dead extends Error {}

export class WebhookProcessor {
  private readonly deps: ProcessorDeps;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly batchSize: number;
  private running: Promise<ProcessResult> | null = null;

  constructor(deps: ProcessorDeps, opts: ProcessorOptions = {}) {
    this.deps = deps;
    this.maxAttempts = opts.maxAttempts ?? 10;
    this.baseDelayMs = opts.baseDelayMs ?? 60_000;
    this.maxDelayMs = opts.maxDelayMs ?? 3600_000;
    this.batchSize = opts.batchSize ?? 50;
  }

  /** Process everything that is due. Overlapping calls share one run. */
  runOnce(): Promise<ProcessResult> {
    this.running ??= this.run().finally(() => { this.running = null; });
    return this.running;
  }

  private async run(): Promise<ProcessResult> {
    const { inbox, log } = this.deps;
    const result: ProcessResult = { processed: 0, retrying: 0, dead: 0 };
    for (const item of await inbox.due(this.deps.now(), this.batchSize)) {
      const fields = { inboxId: item.id, partner: item.partner, attempt: item.attempts + 1 };
      try {
        await this.handle(item);
        await inbox.markProcessed(item.id, this.deps.now());
        result.processed++;
      } catch (e) {
        const reason = e instanceof Error ? e.message : 'unknown';
        const giveUp = e instanceof Dead || item.attempts + 1 >= this.maxAttempts;
        const now = this.deps.now();
        if (giveUp) {
          await inbox.markFailed(item.id, reason, null, now);
          log.error('webhook dead-lettered', { ...fields, reason, alert: true });
          result.dead++;
        } else {
          const delay = Math.min(this.baseDelayMs * 2 ** item.attempts, this.maxDelayMs);
          await inbox.markFailed(item.id, reason, now + delay, now);
          log.warn('webhook will be retried', { ...fields, reason, retryInMs: delay });
          result.retrying++;
        }
      }
    }
    return result;
  }

  private async handle(item: InboxItem): Promise<void> {
    const cfg = this.deps.partners.get(item.partner);
    if (!cfg) throw new Dead('unknown_partner');

    let info: WebhookInfo;
    try {
      info = cfg.adapter.parseWebhook(JSON.parse(Buffer.from(this.deps.sealer.open(item.body, inboxContext(item.partner, item.dedupeKey))).toString('utf8')));
    } catch {
      throw new Dead('unreadable_body');
    }

    const order = await this.resolveOrder(cfg, item.partner, info);
    if (!order) throw new Retry('unknown_order');
    try {
      await syncOrder(this.deps, order.id, 'webhook');
    } catch (e) {
      if (e instanceof PartnerError) throw e.retryable ? new Retry(`partner_${e.code}`) : new Dead(`partner_${e.code}`);
      throw new Retry(e instanceof Error ? e.name : 'error');
    }
  }

  /**
   * By partner reference; failing that, by our order id if the partner echoed it. The second case is an order
   * whose booking reply was lost: we link it only after the partner confirms the reference for that order id.
   */
  private async resolveOrder(cfg: PartnerConfig, partner: PartnerId, info: WebhookInfo): Promise<OrderRecord | null> {
    const { orders, log, now } = this.deps;
    const known = await orders.findByPartnerRef(partner, info.partnerRef);
    if (known) return known;
    if (!info.clientRef) return null;
    const byId = await orders.get(info.clientRef);
    if (!byId || byId.partner !== partner || byId.partnerRef) return null;

    let confirmed: { partnerRef: string } | null;
    try {
      confirmed = await cfg.adapter.findOrderByClientRef(byId.id);
    } catch (e) {
      if (e instanceof PartnerError) throw e.retryable ? new Retry(`partner_${e.code}`) : new Dead(`partner_${e.code}`);
      throw e;
    }
    if (confirmed?.partnerRef !== info.partnerRef) return null;

    const linked = await orders.apply(byId.id, cur => cur.partnerRef ? null : {
      next: { ...cur, partnerRef: info.partnerRef, updatedAt: now() },
      events: [{
        orderId: cur.id, status: cur.status, partnerStatus: null, source: 'webhook', occurredAt: null, receivedAt: now(),
        note: `linked to partner order ${info.partnerRef}`,
      }],
    });
    if (linked?.partnerRef !== info.partnerRef) return null;
    log.info('order linked to partner booking from webhook', { orderId: linked.id, partner, partnerRef: info.partnerRef });
    return linked;
  }
}
