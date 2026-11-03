// Adapter for the simulated lab (fake-lab.ts). It does what a real adapter does: maps the lab's statuses,
// payloads and errors into ours, sends our order id as the client reference, and verifies signed webhooks.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { OrderStatus } from '../../../shared/lab-bundle.ts';
import {
  FAKE_SIGNATURE_HEADER, FakeLabApiError, istDate,
  type FakeCreateOrderRequest, type FakeLabApi, type FakeResult, type FakeStatus,
} from './fake-lab.ts';
import {
  PartnerError,
  type CatalogItem, type InboundRequest, type LabPartner, type PartnerOrderInput, type PartnerReport, type PartnerStatus, type Slot, type WebhookInfo,
} from './types.ts';

const STATUS_MAP: Record<FakeStatus, OrderStatus> = {
  ORDER_PLACED: 'booked',
  PHLEBO_ASSIGNED: 'collector_assigned',
  SAMPLE_COLLECTED: 'sample_collected',
  RECOLLECTION_REQUIRED: 'recollection_needed',
  IN_LAB: 'processing',
  PARTIAL_REPORT: 'partial_report',
  REPORT_READY: 'report_ready',
  REPORT_AMENDED: 'report_ready',
  CANCELLED: 'cancelled',
};

const GENDER = { female: 'F', male: 'M', other: 'O' } as const;

export interface FakeLabAdapterOptions {
  lab: FakeLabApi;
  webhookSecret: string;
  now?: () => number;
  /** How far a webhook's signed timestamp may be from our clock. Default 5 minutes. */
  signatureToleranceMs?: number;
}

/** Translate the lab's HTTP-style errors into ours. Anything else is a bug and is rethrown as is. */
function mapError(e: unknown): never {
  if (!(e instanceof FakeLabApiError)) throw e;
  switch (e.status) {
    case 400: throw new PartnerError('invalid_request', e.message);
    case 404: throw new PartnerError('not_found', e.message);
    case 409:
      if (e.code === 'SLOT_FULL') throw new PartnerError('slot_unavailable', e.message);
      if (e.code === 'NOT_CANCELLABLE' || e.code === 'NOT_RESCHEDULABLE') throw new PartnerError('not_allowed', e.message);
      throw new PartnerError('invalid_request', e.message);
    case 422: throw new PartnerError('not_serviceable', e.message);
    case 504: throw new PartnerError('timeout', e.message);
    default: throw new PartnerError('unavailable', e.message);
  }
}

/** Our slot (ISO times) → the lab's date and slot id. Its slots are whole hours, id "S" + start hour (IST). */
function labSlot(slot: Slot): { date: string; slotId: string } {
  const start = Date.parse(slot.start), end = Date.parse(slot.end);
  if (Number.isNaN(start) || Number.isNaN(end) || end - start !== 3600_000) {
    throw new PartnerError('invalid_request', `Not a slot this lab offers: ${slot.start} to ${slot.end}`);
  }
  const ist = new Date(start + 330 * 60_000);
  if (ist.getUTCMinutes() !== 0) throw new PartnerError('invalid_request', `Slots start on the hour: ${slot.start}`);
  return { date: istDate(start), slotId: `S${String(ist.getUTCHours()).padStart(2, '0')}` };
}

/** E.164 Indian mobile → the ten digits the lab wants. */
function labMobile(phone: string): string {
  const m = /^\+91([6-9]\d{9})$/.exec(phone);
  if (!m) throw new PartnerError('invalid_request', 'Phone must be an Indian mobile number in E.164 form (+91XXXXXXXXXX)');
  return m[1];
}

function toRow(r: FakeResult) {
  return {
    name: r.test_name,
    value: r.result,
    ...(r.unit ? { unit: r.unit } : {}),
    ...(r.bio_ref_interval ? { range: r.bio_ref_interval } : {}),
    ...(r.flag ? { flag: r.flag } : {}),
    partnerCode: r.test_code,
  };
}

export class FakeLabAdapter implements LabPartner {
  readonly id = 'fake' as const;
  private readonly lab: FakeLabApi;
  private readonly secret: string;
  private readonly now: () => number;
  private readonly toleranceMs: number;

  constructor(opts: FakeLabAdapterOptions) {
    this.lab = opts.lab;
    this.secret = opts.webhookSecret;
    this.now = opts.now ?? Date.now;
    this.toleranceMs = opts.signatureToleranceMs ?? 5 * 60_000;
  }

  async catalog(pincode: string): Promise<CatalogItem[]> {
    try {
      const res = await this.lab.getPackages(pincode);
      return res.packages.map(p => ({
        partner: this.id,
        code: p.package_code,
        name: p.display_name,
        tests: p.parameters,
        pricePaise: p.offer_price_inr * 100,
        mrpPaise: p.mrp_inr * 100,
        fasting: p.fasting_required,
        reportHours: p.tat_hours,
      }));
    } catch (e) {
      if (e instanceof FakeLabApiError && e.code === 'NOT_SERVICEABLE') return [];
      return mapError(e);
    }
  }

  async slots(q: { pincode: string; date: string; items: string[] }): Promise<Slot[]> {
    try {
      const res = await this.lab.getSlots(q.pincode, q.date);
      return res.slots.filter(s => s.available).map(s => ({
        start: `${res.date}T${s.start_time}:00+05:30`,
        end: `${res.date}T${s.end_time}:00+05:30`,
      }));
    } catch (e) {
      if (e instanceof FakeLabApiError && e.code === 'NOT_SERVICEABLE') return [];
      return mapError(e);
    }
  }

  async createOrder(o: PartnerOrderInput): Promise<{ partnerRef: string }> {
    const { date, slotId } = labSlot(o.slot);
    const req: FakeCreateOrderRequest = {
      client_ref: o.orderId,
      package_codes: o.items,
      collection_date: date,
      slot_id: slotId,
      patient: { name: o.patient.name, age: o.patient.age, gender: GENDER[o.patient.sex] },
      mobile: labMobile(o.phone),
      address: { ...o.address },
    };
    try {
      const res = await this.lab.createOrder(req);
      return { partnerRef: res.order_ref };
    } catch (e) {
      // Our order id is the client reference, so a repeat of an earlier attempt resolves to that booking.
      if (e instanceof FakeLabApiError && e.code === 'DUPLICATE_CLIENT_REF') {
        const existing = await this.findOrderByClientRef(o.orderId);
        if (existing) return existing;
      }
      return mapError(e);
    }
  }

  async findOrderByClientRef(orderId: string): Promise<{ partnerRef: string } | null> {
    try {
      const v = await this.lab.findByClientRef(orderId);
      return { partnerRef: v.order_ref };
    } catch (e) {
      if (e instanceof FakeLabApiError && e.status === 404) return null;
      return mapError(e);
    }
  }

  async cancel(partnerRef: string, reason: string): Promise<void> {
    try {
      await this.lab.cancelOrder(partnerRef, reason);
    } catch (e) {
      mapError(e);
    }
  }

  async reschedule(partnerRef: string, slot: Slot): Promise<void> {
    const { date, slotId } = labSlot(slot);
    try {
      await this.lab.rescheduleOrder(partnerRef, date, slotId);
    } catch (e) {
      mapError(e);
    }
  }

  async status(partnerRef: string): Promise<PartnerStatus> {
    try {
      const v = await this.lab.getOrder(partnerRef);
      return { status: STATUS_MAP[v.status] ?? 'unknown', partnerStatus: v.status, at: v.status_updated_at };
    } catch (e) {
      return mapError(e);
    }
  }

  async report(partnerRef: string): Promise<PartnerReport> {
    try {
      const r = await this.lab.getReport(partnerRef);
      return {
        pending: r.report_status === 'PENDING',
        partial: r.report_status === 'PARTIAL',
        ...(r.results ? { rows: r.results.map(toRow) } : {}),
        ...(r.pdf_base64 ? { pdf: new Uint8Array(Buffer.from(r.pdf_base64, 'base64')) } : {}),
        ...(r.version > 0 ? { version: String(r.version) } : {}),
        ...(r.collected_at ? { collectedAt: r.collected_at } : {}),
        ...(r.reported_at ? { reportedAt: r.reported_at } : {}),
        labName: r.lab_name,
      };
    } catch (e) {
      return mapError(e);
    }
  }

  verifyWebhook(req: InboundRequest): boolean {
    const header = Object.entries(req.headers).find(([k]) => k.toLowerCase() === FAKE_SIGNATURE_HEADER)?.[1];
    if (!header) return false;
    const parts = new Map(header.split(',').map(p => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()] as const;
    }));
    const t = Number(parts.get('t'));
    const v1 = parts.get('v1') ?? '';
    if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(v1)) return false;
    if (Math.abs(this.now() - t * 1000) > this.toleranceMs) return false;
    const expected = createHmac('sha256', this.secret).update(`${t}.`).update(req.rawBody).digest();
    return timingSafeEqual(expected, Buffer.from(v1, 'hex'));
  }

  parseWebhook(body: unknown): WebhookInfo {
    const o = body as Record<string, unknown> | null;
    if (!o || typeof o !== 'object' || typeof o.order_ref !== 'string' || !o.order_ref) {
      throw new PartnerError('invalid_request', 'Webhook body has no order_ref');
    }
    return { partnerRef: o.order_ref, eventId: typeof o.event_id === 'string' ? o.event_id : null };
  }
}
