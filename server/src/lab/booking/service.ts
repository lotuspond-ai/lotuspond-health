// The booking service (design doc §5.1): catalogue and slots across partners, and our side of an order's life:
// create it for a family profile (with the booking consent), place it with the partner, cancel, reschedule, list.
// Orders live in the cell that holds the account; a partner only takes bookings from accounts in its region.
//
// Placing (§5.1 step 7). The partner call gets placeTimeoutMs.
// - Success: the order is booked.
// - The partner says no (slot taken, area not served): the order fails, with the reason.
// - Timeout or partner outage: the order stays `placing` and retryPlacements() takes over. It first looks the
//   booking up by our order id (the partner may have made it), then places again. A webhook may resolve it
//   sooner (webhooks/processor.ts), and a late reply to the timed-out call is still applied.
// - A partner booking that turns up after we gave up is cancelled at the partner and raised as an alert, so
//   no collector visits for an order we told the user had failed.
import { createHash, randomUUID } from 'node:crypto';
import type { OrderStatus, PartnerId } from '../../../../shared/lab-bundle.ts';
import type { DataRegion } from '../../../../shared/regions.ts';
import { HttpError } from '../../lib/errors.ts';
import type { Sealer } from '../sealer.ts';
import type { Logger } from '../log.ts';
import { canCancel, canReschedule, checkMove } from '../orders/state.ts';
import { syncOrder, type OrderHooks } from '../orders/sync.ts';
import {
  PartnerError, type PartnerBooking,
  type Address, type CatalogItem, type PartnerConfig, type PartnerOrderInput, type PartnerRegistry, type Patient, type Slot,
} from '../partners/types.ts';
import {
  DuplicateIdempotencyKey, newOrderRecord,
  type EventSource, type NewOrderEvent, type OrderChange, type OrderRecord, type OrderStore,
} from '../store/types.ts';
import { istIso } from '../time.ts';
import { PINCODE_RE, type BookingInput } from './validate.ts';

export type BookingErrorCode =
  | 'invalid_request' | 'unknown_partner' | 'unknown_item' | 'not_serviceable' | 'slot_unavailable' | 'slot_in_past'
  | 'adults_only' | 'consent_required' | 'consent_outdated' | 'idempotency_key_reused' | 'not_found'
  | 'not_cancellable' | 'not_reschedulable' | 'partner_unavailable' | 'not_in_region';

const HTTP_STATUS: Record<BookingErrorCode, HttpError['status']> = {
  invalid_request: 400, unknown_partner: 400, unknown_item: 422, not_serviceable: 422, slot_unavailable: 409, slot_in_past: 422,
  adults_only: 422, consent_required: 422, consent_outdated: 409, idempotency_key_reused: 422, not_found: 404,
  not_cancellable: 409, not_reschedulable: 409, partner_unavailable: 503, not_in_region: 422,
};

/** An HttpError, so main's error handler sends it as { error: { code, message } } with its status. */
export class BookingError extends HttpError {
  declare readonly code: BookingErrorCode;

  constructor(code: BookingErrorCode, message: string) {
    super(HTTP_STATUS[code], code, message);
    this.name = 'BookingError';
  }
}

export interface BookingDeps {
  orders: OrderStore;
  partners: PartnerRegistry;
  /** Seals patient, phone and address at rest. */
  sealer: Sealer;
  now: () => number;
  log: Logger;
  hooks?: OrderHooks;
}

export interface BookingOptions {
  /** The consent notice the app must have shown; bookings that accepted an older one are refused. */
  noticeVersion: string;
  /** Default 10 s. */
  placeTimeoutMs?: number;
  /** Default 24 hours (design doc §5.1). */
  catalogTtlMs?: number;
  /** Delays between placement retries. Default 30 s, 1, 2, 5, 10 and 20 minutes; then the order fails. */
  placementRetryDelaysMs?: number[];
}

interface Contact { patient: Patient; phone: string; address: Address }

/** Who is asking: the signed-in account, its data region, and the profile the test is for. */
export interface Owner { userId: string; region: DataRegion; profileId: string }

const contactContext = (orderId: string) => `contact:${orderId}`;

const MIN = 60_000;

export class BookingService {
  private readonly deps: BookingDeps;
  private readonly noticeVersion: string;
  private readonly placeTimeoutMs: number;
  private readonly catalogTtlMs: number;
  private readonly retryDelays: number[];
  private readonly catalogCache = new Map<string, { items: CatalogItem[]; until: number }>();

  constructor(deps: BookingDeps, opts: BookingOptions) {
    this.deps = deps;
    this.noticeVersion = opts.noticeVersion;
    this.placeTimeoutMs = opts.placeTimeoutMs ?? 10_000;
    this.catalogTtlMs = opts.catalogTtlMs ?? 24 * 60 * MIN;
    this.retryDelays = opts.placementRetryDelaysMs ?? [30_000, MIN, 2 * MIN, 5 * MIN, 10 * MIN, 20 * MIN];
    if (!this.retryDelays.length) throw new Error('placementRetryDelaysMs must not be empty');
  }

  /* ---------------- catalogue and slots ---------------- */

  /** Packages from every partner serving the pincode. A partner that can't answer is listed in `unavailable`. */
  async catalog(region: DataRegion, pincode: string): Promise<{ items: CatalogItem[]; unavailable: PartnerId[] }> {
    if (!PINCODE_RE.test(pincode)) throw new BookingError('invalid_request', 'pincode must be a 6-digit pincode');
    const items: CatalogItem[] = [];
    const unavailable: PartnerId[] = [];
    await Promise.all([...this.deps.partners].filter(([, cfg]) => cfg.region === region).map(async ([id, cfg]) => {
      try {
        items.push(...await this.partnerCatalog(id, cfg, pincode));
      } catch (e) {
        unavailable.push(id);
        this.deps.log.warn('catalogue unavailable', { partner: id, error: e instanceof PartnerError ? e.code : 'error' });
      }
    }));
    items.sort((a, b) => a.partner.localeCompare(b.partner) || a.pricePaise - b.pricePaise || a.code.localeCompare(b.code));
    return { items, unavailable: unavailable.sort() };
  }

  async slots(region: DataRegion, partner: string, pincode: string, date: string, items: string[]): Promise<Slot[]> {
    const cfg = this.partner(partner, region);
    if (!PINCODE_RE.test(pincode)) throw new BookingError('invalid_request', 'pincode must be a 6-digit pincode');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BookingError('invalid_request', 'date must be yyyy-mm-dd');
    try {
      const now = this.deps.now();
      return (await cfg.adapter.slots({ pincode, date, items })).filter(s => Date.parse(s.start) > now);
    } catch (e) {
      throw this.fromPartner(e);
    }
  }

  /* ---------------- orders ---------------- */

  /**
   * Book. A repeat with the same idempotency key and the same request returns the existing order
   * (`replayed: true`); the same key with a different request is refused.
   */
  async createOrder(owner: Owner, input: BookingInput, idempotencyKey: string): Promise<{ order: OrderRecord; replayed: boolean }> {
    const { orders, sealer, log } = this.deps;
    const { userId, profileId } = owner;
    const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const replay = async (existing: OrderRecord) => {
      if (existing.requestHash !== requestHash || existing.profileId !== profileId) throw new BookingError('idempotency_key_reused', 'This Idempotency-Key was used for a different booking');
      return { order: existing, replayed: true };
    };
    const existing = await orders.findByIdempotencyKey(userId, idempotencyKey);
    if (existing) return replay(existing);

    const cfg = this.partner(input.partner, owner.region);
    if (!input.consent.accepted) throw new BookingError('consent_required', 'The booking needs consent to share these details with the lab');
    if (input.consent.noticeVersion !== this.noticeVersion) throw new BookingError('consent_outdated', 'The consent notice has changed; show the current one and ask again');
    // Under-18s need verifiable parental consent under the DPDP Act; not supported in v1 (design doc §13).
    if (input.patient.age < 18) throw new BookingError('adults_only', 'Bookings are for adults only for now');
    const now = this.deps.now();
    const slotStart = Date.parse(input.slot.start), slotEnd = Date.parse(input.slot.end);
    if (slotStart <= now) throw new BookingError('slot_in_past', 'That slot has already started');

    let catalog: CatalogItem[];
    try {
      catalog = await this.partnerCatalog(input.partner, cfg, input.address.pincode);
    } catch (e) {
      throw this.fromPartner(e);
    }
    if (!catalog.length) throw new BookingError('not_serviceable', 'This lab does not collect at that pincode');
    const items = input.items.map(code => catalog.find(c => c.code === code));
    const missing = input.items.filter((_, i) => !items[i]);
    if (missing.length) throw new BookingError('unknown_item', `Not offered at this pincode: ${missing.join(', ')}`);

    const contact: Contact = { patient: input.patient, phone: input.phone, address: input.address };
    const id = randomUUID();
    const order = newOrderRecord({
      id, userId, profileId, partner: input.partner, status: 'created', createdAt: now,
      items: items.map(c => ({ code: c!.code, name: c!.name, pricePaise: c!.pricePaise })),
      slotStart, slotEnd, pricePaise: items.reduce((sum, c) => sum + c!.pricePaise, 0), payer: 'partner',
      contactCt: sealer.seal(new Uint8Array(Buffer.from(JSON.stringify(contact), 'utf8')), contactContext(id)),
      consentVersion: input.consent.noticeVersion, consentedAt: now, idempotencyKey, requestHash,
    });
    try {
      await orders.insert(order);
    } catch (e) {
      if (e instanceof DuplicateIdempotencyKey) {
        const raced = await orders.get(e.existingId);
        if (raced) return replay(raced);
      }
      throw e;
    }
    log.info('order created', { orderId: order.id, userId, partner: input.partner });

    // No payment step yet (payer: partner, design doc §16), so straight to placing.
    await this.localMove(order.id, 'placing', 'api', null, [{ orderId: order.id, status: 'created', partnerStatus: null, source: 'api', occurredAt: now, receivedAt: now }]);
    const placed = await this.place(order.id, cfg, {
      orderId: order.id, items: input.items, slot: input.slot, patient: input.patient, phone: input.phone, address: input.address,
    });
    return { order: placed, replayed: false };
  }

  /** Retry bookings stuck in placing. Run on a timer (every 15-30 s). */
  async retryPlacements(limit = 20): Promise<{ attempted: number; booked: number; failed: number }> {
    const { orders, partners, log } = this.deps;
    const result = { attempted: 0, booked: 0, failed: 0 };
    const now = this.deps.now();
    for (const o of await orders.dueForPlacement(now, limit)) {
      const cfg = partners.get(o.partner);
      if (!cfg) continue;
      if (o.placementAttempts >= this.retryDelays.length || (o.slotStart != null && o.slotStart <= now) || !o.contactCt) {
        if (await this.markFailed(o.id, 'placement_gave_up')) {
          log.error('booking could not be confirmed with the partner', { orderId: o.id, partner: o.partner, attempts: o.placementAttempts, alert: true });
          result.failed++;
        }
        continue;
      }
      // Claim the attempt and schedule the next one before calling out, so a crash mid-call still leaves a retry.
      const claim: { ok?: boolean } = {};
      await orders.apply(o.id, cur => {
        if (cur.status !== 'placing' || cur.nextPlacementAt !== o.nextPlacementAt) return null;
        claim.ok = true;
        const n = cur.placementAttempts + 1;
        return { next: { ...cur, placementAttempts: n, nextPlacementAt: now + this.retryDelays[Math.min(n, this.retryDelays.length - 1)], updatedAt: now }, events: [] };
      });
      if (!claim.ok) continue;
      result.attempted++;
      try {
        const booking = (await cfg.adapter.findOrderByClientRef(o.id)) ?? (await cfg.adapter.createOrder(this.partnerInput(o)));
        if (await this.markBooked(o.id, booking, 'system')) result.booked++;
      } catch (e) {
        if (e instanceof PartnerError && !e.retryable) {
          if (await this.markFailed(o.id, e.code)) result.failed++;
        } else {
          log.warn('booking retry failed; will try again', { orderId: o.id, partner: o.partner, error: e instanceof PartnerError ? e.code : 'error' });
        }
      }
    }
    return result;
  }

  async cancel(owner: Owner, orderId: string, reason: string): Promise<OrderRecord> {
    const o = await this.owned(owner, orderId);
    if (o.status === 'cancelled') return o;
    if (o.status === 'placing') throw new BookingError('not_cancellable', 'The booking is still being confirmed with the lab; try again in a minute');
    if (!canCancel(o.status)) throw new BookingError('not_cancellable', `This order can no longer be cancelled (${o.status})`);
    if (o.partnerRef) {
      try {
        await this.partner(o.partner).adapter.cancel(o.partnerRef, reason, o.partnerToken);
      } catch (e) {
        if (e instanceof PartnerError && e.code === 'not_allowed') {
          await this.refresh(o.id);
          throw new BookingError('not_cancellable', 'The lab says this order can no longer be cancelled');
        }
        throw this.fromPartner(e);
      }
    }
    return this.localMove(o.id, 'cancelled', 'user', 'cancelled by the user');
  }

  /** Slots for moving an order's visit: same lab, address and tests, without the app needing the address. */
  async slotsForOrder(owner: Owner, orderId: string, date: string): Promise<Slot[]> {
    const o = await this.owned(owner, orderId);
    if (!canReschedule(o.status) || !o.contactCt) throw new BookingError('not_reschedulable', `This visit can no longer be moved (${o.status})`);
    const { address } = this.partnerInput(o);
    return this.slots(owner.region, o.partner, address.pincode, date, o.items.map(i => i.code));
  }

  async reschedule(owner: Owner, orderId: string, slot: Slot): Promise<OrderRecord> {
    const o = await this.owned(owner, orderId);
    if (!canReschedule(o.status) || !o.partnerRef) throw new BookingError('not_reschedulable', `This visit can no longer be moved (${o.status})`);
    const now = this.deps.now();
    const start = Date.parse(slot.start), end = Date.parse(slot.end);
    if (start <= now) throw new BookingError('slot_in_past', 'That slot has already started');
    try {
      await this.partner(o.partner).adapter.reschedule(o.partnerRef, slot, o.partnerToken);
    } catch (e) {
      if (e instanceof PartnerError && e.code === 'not_allowed') {
        await this.refresh(o.id);
        throw new BookingError('not_reschedulable', 'The lab says this visit can no longer be moved');
      }
      throw this.fromPartner(e);
    }
    const holder: { from?: OrderStatus } = {};
    const after = await this.deps.orders.apply(o.id, cur => {
      const to: OrderStatus = checkMove(cur.status, 'booked', 'local').ok ? 'booked' : cur.status;
      if (to !== cur.status) holder.from = cur.status;
      return {
        next: { ...cur, slotStart: start, slotEnd: end, status: to, updatedAt: now },
        events: [{ orderId: cur.id, status: to, partnerStatus: null, source: 'user', occurredAt: now, receivedAt: now, note: `rescheduled to ${istIso(start)}` }],
      };
    });
    if (holder.from && after) await this.notify(after, holder.from);
    return after!;
  }

  async list(owner: Owner): Promise<OrderRecord[]> {
    return (await this.deps.orders.listByProfile(owner.profileId, 50)).filter(o => o.userId === owner.userId);
  }

  async get(owner: Owner, orderId: string) {
    const order = await this.owned(owner, orderId);
    return { order, events: await this.deps.orders.events(order.id) };
  }

  /* ---------------- internals ---------------- */

  private partner(id: string, region?: DataRegion): PartnerConfig {
    const cfg = this.deps.partners.get(id as PartnerId);
    if (!cfg) throw new BookingError('unknown_partner', `Unknown partner: ${id}`);
    if (region && cfg.region !== region) throw new BookingError('not_in_region', 'This lab only takes bookings from accounts held in its region');
    return cfg;
  }

  private async owned(owner: Owner, orderId: string): Promise<OrderRecord> {
    const o = /^[0-9a-f-]{36}$/i.test(orderId) ? await this.deps.orders.get(orderId) : null;
    // Someone else's order (or another profile's) looks exactly like a missing one.
    if (!o || o.userId !== owner.userId || o.profileId !== owner.profileId) throw new BookingError('not_found', 'No such order');
    return o;
  }

  private async partnerCatalog(id: PartnerId, cfg: PartnerConfig, pincode: string): Promise<CatalogItem[]> {
    const key = `${id}|${pincode}`;
    const now = this.deps.now();
    const hit = this.catalogCache.get(key);
    if (hit && hit.until > now) return hit.items;
    const items = await cfg.adapter.catalog(pincode);
    if (this.catalogCache.size > 20_000) this.catalogCache.clear();
    this.catalogCache.set(key, { items, until: now + this.catalogTtlMs });
    return items;
  }

  private fromPartner(e: unknown): BookingError {
    if (!(e instanceof PartnerError)) throw e;
    if (e.retryable) return new BookingError('partner_unavailable', 'The lab is not responding; try again shortly');
    switch (e.code) {
      case 'not_serviceable': return new BookingError('not_serviceable', 'This lab does not collect at that pincode');
      case 'slot_unavailable': return new BookingError('slot_unavailable', 'That slot is no longer available');
      case 'not_found': return new BookingError('not_found', 'The lab has no record of this order');
      default: return new BookingError('invalid_request', e.message);
    }
  }

  private partnerInput(o: OrderRecord): PartnerOrderInput {
    const contact = JSON.parse(Buffer.from(this.deps.sealer.open(o.contactCt!, contactContext(o.id))).toString('utf8')) as Contact;
    return {
      orderId: o.id, items: o.items.map(i => i.code), slot: { start: istIso(o.slotStart!), end: istIso(o.slotEnd!) },
      patient: contact.patient, phone: contact.phone, address: contact.address,
    };
  }

  /** Place with a timeout; the call carries on in the background and its outcome is applied whenever it arrives. */
  private async place(orderId: string, cfg: PartnerConfig, input: PartnerOrderInput): Promise<OrderRecord> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = this.attemptPlacement(orderId, cfg, input);
    const timedOut = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), this.placeTimeoutMs); });
    const first = await Promise.race([attempt, timedOut]);
    clearTimeout(timer);
    if (first === 'timeout') {
      this.deps.log.warn('booking reply timed out; will confirm later', { orderId, partner: cfg.adapter.id });
      await this.scheduleRetry(orderId, 'timeout');
    }
    return (await this.deps.orders.get(orderId))!;
  }

  /** Never rejects: every outcome is recorded on the order. */
  private async attemptPlacement(orderId: string, cfg: PartnerConfig, input: PartnerOrderInput): Promise<'done'> {
    try {
      let booking: PartnerBooking;
      try {
        booking = await cfg.adapter.createOrder(input);
      } catch (e) {
        if (e instanceof PartnerError && !e.retryable) await this.markFailed(orderId, e.code === 'invalid_request' ? 'rejected_by_partner' : e.code);
        else await this.scheduleRetry(orderId, e instanceof PartnerError ? e.code : 'error');
        return 'done';
      }
      await this.markBooked(orderId, booking, 'api');
    } catch {
      this.deps.log.error('could not record the booking outcome', { orderId, alert: true });
    }
    return 'done';
  }

  private async scheduleRetry(orderId: string, reason: string): Promise<void> {
    const now = this.deps.now();
    await this.deps.orders.apply(orderId, cur => cur.status !== 'placing' || cur.nextPlacementAt != null ? null : {
      next: { ...cur, nextPlacementAt: now + this.retryDelays[0], updatedAt: now },
      events: [{ orderId, status: 'placing', partnerStatus: null, source: 'system', occurredAt: now, receivedAt: now, note: `confirming with the lab (${reason})` }],
    });
  }

  /** Returns true if this call moved the order to booked. */
  private async markBooked(orderId: string, booking: PartnerBooking, source: EventSource): Promise<boolean> {
    const { partnerRef } = booking;
    const partnerToken = booking.token ?? null;
    const now = this.deps.now();
    const out: { booked?: boolean; conflict?: 'after_failure' | 'different_ref' } = {};
    const after = await this.deps.orders.apply(orderId, (cur): OrderChange => {
      if (cur.partnerRef && cur.partnerRef !== partnerRef) {
        out.conflict = 'different_ref';
        return null;
      }
      if (cur.status === 'placing') {
        out.booked = true;
        return {
          next: { ...cur, partnerRef, partnerToken, status: 'booked', lastSyncedAt: now, nextPlacementAt: null, updatedAt: now },
          events: [{ orderId, status: 'booked', partnerStatus: null, source, occurredAt: now, receivedAt: now, note: `lab order ${partnerRef}` }],
        };
      }
      if (cur.status === 'failed' || cur.status === 'cancelled') {
        out.conflict = 'after_failure';
        return { next: { ...cur, partnerRef, partnerToken, updatedAt: now }, events: [] };
      }
      // Already moved on (a webhook linked it first): just make sure the reference is stored.
      if (cur.partnerRef) return partnerToken && !cur.partnerToken ? { next: { ...cur, partnerToken, updatedAt: now }, events: [] } : null;
      return { next: { ...cur, partnerRef, partnerToken, nextPlacementAt: null, updatedAt: now }, events: [] };
    });
    if (!after) return false;
    if (out.conflict) {
      // A partner booking we don't want: cancel it, so no collector turns up.
      this.deps.log.error('unwanted partner booking; cancelling it at the lab', { orderId, partner: after.partner, partnerRef, reason: out.conflict, alert: true });
      const cfg = this.deps.partners.get(after.partner);
      await cfg?.adapter.cancel(partnerRef, 'Duplicate or abandoned booking', partnerToken).catch(() => {
        this.deps.log.error('could not cancel unwanted partner booking', { orderId, partnerRef, alert: true });
      });
      return false;
    }
    if (out.booked) {
      this.deps.log.info('order booked', { orderId, partner: after.partner, partnerRef, source });
      await this.notify(after, 'placing');
    }
    return !!out.booked;
  }

  /** Returns true if this call moved the order to failed. */
  private async markFailed(orderId: string, reason: string): Promise<boolean> {
    const now = this.deps.now();
    const out: { failed?: boolean } = {};
    const after = await this.deps.orders.apply(orderId, cur => {
      if (cur.status !== 'placing') return null;
      out.failed = true;
      return {
        next: { ...cur, status: 'failed', failureReason: reason, nextPlacementAt: null, updatedAt: now },
        events: [{ orderId, status: 'failed', partnerStatus: null, source: 'system', occurredAt: now, receivedAt: now, note: reason }],
      };
    });
    if (out.failed && after) {
      this.deps.log.info('order failed', { orderId, partner: after.partner, reason });
      await this.notify(after, 'placing');
    }
    return !!out.failed;
  }

  /** One of our own moves (state.ts LOCAL_MOVES). A move that's no longer allowed leaves the order as it is. */
  private async localMove(orderId: string, to: OrderStatus, source: EventSource, note: string | null, before: NewOrderEvent[] = []): Promise<OrderRecord> {
    const now = this.deps.now();
    const holder: { from?: OrderStatus } = {};
    const after = await this.deps.orders.apply(orderId, cur => {
      if (!checkMove(cur.status, to, 'local').ok) return null;
      holder.from = cur.status;
      return {
        next: { ...cur, status: to, updatedAt: now },
        events: [...before, { orderId, status: to, partnerStatus: null, source, occurredAt: now, receivedAt: now, ...(note ? { note } : {}) }],
      };
    });
    if (holder.from && after) await this.notify(after, holder.from);
    return after!;
  }

  /** Hooks enqueue follow-up work (push notifications); a failing hook is logged and doesn't fail the request. */
  private async notify(order: OrderRecord, from: OrderStatus): Promise<void> {
    try {
      await this.deps.hooks?.onTransition?.(order, from);
    } catch (e) {
      this.deps.log.error('order hook failed', { hook: 'onTransition', orderId: order.id, error: e instanceof Error ? e.name : 'unknown', alert: true });
    }
  }

  private async refresh(orderId: string): Promise<void> {
    try {
      await syncOrder(this.deps, orderId, 'poll');
    } catch {
      // Best effort: the poller will catch up.
    }
  }
}
