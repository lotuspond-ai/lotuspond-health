// Adapter for Orange Health Labs' Partner API ("Partner API Public Order Flow" on Apiary, by Orange Health Engineering,
// last updated 2024-12-16; read 2026-11-10). Bengaluru, Delhi NCR, Mumbai and Hyderabad.
//
//   GET   /v1/partner/serviceability?pincode=&request_date=     serviceable or not, and slots for that date
//   POST  /v1/partner/order                                      home collection; returns request_id and a token
//   GET   /v1/partner/order-details/{request_id}?token=          status, per-test report readiness, report link
//   GET   /v1/partner/test-results?request_id=                    structured results per investigation
//   PATCH /v1/partner/{request_id}/cancel?token=                  cancel
//   PATCH /v1/partner/{request_id}/reschedule?token=              move the visit
//   webhooks                                                      order.*, task.*, test.* events, HMAC-SHA256 signed
//
// What the public docs leave open, and how this adapter handles it until Orange Health confirms (see the Notion
// "lab partner pipeline" page):
// - No catalogue endpoint: tests and packages, with prices, come from the catalogue we are given at onboarding
//   (OrangeCatalogItem[], loaded from ORANGE_CATALOG_FILE).
// - No lookup by our own reference: findOrderByClientRef searches recent test-results for our partner_reference_id.
//   That finds the booking but not its token, so status() falls back to test-results for such an order.
// - Slot length: not stated. Slots are taken as one hour from slot_datetime, which is read as India time.
// - Coordinates: an order is sent without latitude and longitude; the docs say Orange Health then confirms the
//   location with the patient before collection.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { OrderStatus } from '../../../../shared/lab-bundle.ts';
import {
  PartnerError,
  type CatalogItem, type InboundRequest, type LabPartner, type PartnerBooking, type PartnerOrderInput, type PartnerReport,
  type PartnerStatus, type Slot, type WebhookInfo,
} from './types.ts';

export const ORANGE_SANDBOX_URL = 'https://sandbox-partner-api.orangehealth.dev';
export const ORANGE_PRODUCTION_URL = 'https://partner-api.orangehealth.in';
export const ORANGE_SIGNATURE_HEADER = 'x-oh-signature';

const IST_MS = 330 * 60_000;
const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** One bookable item from the catalogue Orange Health gives us. `code` is what our orders list. */
export interface OrangeCatalogItem {
  /** Our code for it, e.g. "OH-T-154" or "OH-P-3". */
  code: string;
  kind: 'test' | 'package';
  /** Orange Health's test_id or package_id. */
  id: string;
  name: string;
  /** What it measures, for display. */
  tests: string[];
  pricePaise: number;
  mrpPaise?: number;
  fasting: boolean;
  reportHours: number;
}

export interface OrangeOptions {
  apiKey: string;
  /** The secret we set with Orange Health for signing webhooks. */
  webhookSecret: string;
  catalog: OrangeCatalogItem[];
  baseUrl?: string;
  /**
   * Who collects payment, as Orange Health names it on the order ("paid_by_group" in its examples). Decided with
   * Orange Health when the partner account is created.
   */
  paymentType?: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  /** Collection window length. Default 60 minutes. */
  slotMinutes?: number;
}

/* ---------------- shapes from the docs (only the fields we read) ---------------- */

interface ServiceabilityResponse {
  status?: string;
  slots?: Record<string, { slot_datetime: string }>;
}
interface CreateOrderResponse {
  request_id?: string;
  token?: string;
  status?: string;
  orders?: { id: number; partnerReferenceId: string }[];
}
interface OrderDetailsTest { name?: string; is_report_ready?: boolean }
interface OrderDetailsResponse {
  data?: {
    id?: string;
    status?: string;
    emedicDetails?: Record<string, unknown>;
    collection_time?: { confirmed_collection_time?: string; preferred_collection_time?: string }[];
    patient_information?: { reportURL?: string; tests?: { tests?: OrderDetailsTest[] } }[];
  };
}
interface ResultTest {
  investigation_code?: string;
  investigation_is_abnormal?: string;
  investigation_name?: string;
  investigation_range?: string;
  investigation_value?: string | number;
  investigation_value_unit?: string;
  test_code?: string;
  test_name?: string;
}
interface ResultOrder {
  order_completed_at?: string | null;
  order_created_at?: string;
  partner_reference_id?: string;
  request_id?: string;
  tests?: ResultTest[];
}
interface TestResultsResponse { data?: { orders?: ResultOrder[] } }
interface WebhookBody {
  event?: string;
  payload?: { order?: { city_request_id?: string; partner_reference_id?: string; id?: number; status_string?: string } };
}

/* ---------------- helpers ---------------- */

/** ms → "YYYY-MM-DD" and "YYYY-MM-DDTHH:mm:ss" in India time. */
function istParts(ms: number): { date: string; local: string } {
  const iso = new Date(ms + IST_MS).toISOString();
  return { date: iso.slice(0, 10), local: iso.slice(0, 19) };
}

/** Orange Health's naive "YYYY-MM-DDTHH:mm:ss" (India time) → ms. */
function fromIstLocal(local: string): number {
  return Date.parse(`${local.slice(0, 19)}+05:30`);
}

const isoIst = (ms: number) => `${istParts(ms).local}+05:30`;

const GENDER = { female: 'Female', male: 'Male', other: 'Other' } as const;

function mobile(phone: string): string {
  const m = /^\+91([6-9]\d{9})$/.exec(phone);
  if (!m) throw new PartnerError('invalid_request', 'Phone must be an Indian mobile number in E.164 form (+91XXXXXXXXXX)');
  return m[1];
}

/** Orange Health status names in order details and webhooks → ours. */
const STATUS_MAP: Record<string, OrderStatus> = {
  requested: 'booked',
  initiated: 'booked',
  scheduled: 'booked',
  confirmed: 'booked',
  reserved: 'booked',
  assigned: 'collector_assigned',
  accepted: 'collector_assigned',
  started: 'collector_assigned',
  in_progress: 'collector_assigned',
  collected: 'sample_collected',
  completed_not_sent: 'processing',
  completed_sent: 'partial_report',
  completed: 'report_ready',
  cancelled: 'cancelled',
};

const unserviceable = (text: string | undefined) => /unserviceable|not serviceable/i.test(text ?? '');

export class OrangeHealthAdapter implements LabPartner {
  readonly id = 'orange' as const;
  private readonly opts: Required<Omit<OrangeOptions, 'catalog'>> & { catalog: Map<string, OrangeCatalogItem> };

  constructor(o: OrangeOptions) {
    if (!o.apiKey) throw new Error('Orange Health: an API key is required');
    if (!o.webhookSecret) throw new Error('Orange Health: a webhook secret is required');
    this.opts = {
      apiKey: o.apiKey,
      webhookSecret: o.webhookSecret,
      catalog: new Map(o.catalog.map(c => [c.code, c])),
      baseUrl: (o.baseUrl ?? ORANGE_SANDBOX_URL).replace(/\/$/, ''),
      paymentType: o.paymentType ?? 'paid_by_group',
      fetch: o.fetch ?? fetch,
      now: o.now ?? Date.now,
      timeoutMs: o.timeoutMs ?? 15_000,
      slotMinutes: o.slotMinutes ?? 60,
    };
  }

  /** One call to the Partner API. Maps transport and HTTP errors to PartnerError; 400s return their body to the caller. */
  private async call<T>(method: string, path: string, query: Record<string, string | undefined> = {}, body?: unknown): Promise<{ status: number; body: T }> {
    const url = new URL(`${this.opts.baseUrl}${path}`);
    for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await this.opts.fetch(url, {
        method,
        headers: { api_key: this.opts.apiKey, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (e) {
      const name = (e as { name?: string } | null)?.name;
      throw new PartnerError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unavailable', `Orange Health ${method} ${path}: ${name ?? 'network error'}`);
    }
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (res.status === 401 || res.status === 403) throw new PartnerError('unavailable', `Orange Health refused our API key (${res.status})`);
    if (res.status === 404) throw new PartnerError('not_found', `Orange Health ${method} ${path}: not found`);
    if (res.status >= 500) throw new PartnerError('unavailable', `Orange Health ${method} ${path}: ${res.status}`);
    return { status: res.status, body: parsed as T };
  }

  private statusText(b: unknown): string {
    return typeof (b as { status?: unknown } | null)?.status === 'string' ? (b as { status: string }).status : '';
  }

  private async serviceability(pincode: string, date: string): Promise<ServiceabilityResponse | null> {
    const r = await this.call<ServiceabilityResponse>('GET', '/v1/partner/serviceability', { pincode, request_date: date });
    if (unserviceable(this.statusText(r.body))) return null;
    if (r.status >= 400) throw new PartnerError('invalid_request', `Orange Health serviceability: ${this.statusText(r.body) || r.status}`);
    return r.body;
  }

  async catalog(pincode: string): Promise<CatalogItem[]> {
    const today = istParts(this.opts.now()).date;
    if (!(await this.serviceability(pincode, today))) return [];
    return [...this.opts.catalog.values()].map(c => ({
      partner: this.id, code: c.code, name: c.name, tests: c.tests, pricePaise: c.pricePaise,
      ...(c.mrpPaise ? { mrpPaise: c.mrpPaise } : {}), fasting: c.fasting, reportHours: c.reportHours,
    }));
  }

  async slots(q: { pincode: string; date: string; items: string[] }): Promise<Slot[]> {
    const s = await this.serviceability(q.pincode, q.date);
    if (!s?.slots) return [];
    const now = this.opts.now();
    return Object.values(s.slots)
      .map(x => fromIstLocal(x.slot_datetime))
      .filter(start => !Number.isNaN(start) && start > now && istParts(start).date === q.date)
      .sort((a, b) => a - b)
      .map(start => ({ start: isoIst(start), end: isoIst(start + this.opts.slotMinutes * 60_000) }));
  }

  async createOrder(o: PartnerOrderInput): Promise<PartnerBooking> {
    const start = Date.parse(o.slot.start);
    if (Number.isNaN(start)) throw new PartnerError('invalid_request', `Not a slot: ${o.slot.start}`);
    const tests: { test_id: string }[] = [], packages: { package_id: string }[] = [];
    for (const code of o.items) {
      const item = this.opts.catalog.get(code);
      if (!item) throw new PartnerError('invalid_request', `Orange Health does not offer ${code}`);
      if (item.kind === 'package') packages.push({ package_id: item.id });
      else tests.push({ test_id: item.id });
    }
    const phone = mobile(o.phone);
    const a = o.address;
    const body = {
      address: [a.line1, a.line2, a.landmark && `Landmark: ${a.landmark}`, a.city, a.pincode].filter(Boolean).join(', '),
      slot_datetime: istParts(start).local,
      payment_type: this.opts.paymentType,
      primary_patient_name: o.patient.name,
      primary_patient_number: phone,
      patient_details: [{
        // Our order id, so the booking can be found again (findOrderByClientRef) and webhooks link back to it.
        partner_reference_id: o.orderId,
        patient_name: o.patient.name,
        patient_phone: phone,
        age: String(o.patient.age),
        gender: GENDER[o.patient.sex],
        tests,
        packages,
      }],
    };
    const r = await this.call<CreateOrderResponse>('POST', '/v1/partner/order', {}, body);
    if (r.status === 425) {
      // "Request already accepted": this booking went through on an earlier attempt.
      const existing = await this.findOrderByClientRef(o.orderId);
      if (existing) return existing;
      throw new PartnerError('unavailable', 'Orange Health says the booking was already accepted, but it was not found yet');
    }
    if (r.status >= 400 || !r.body?.request_id) {
      const text = this.statusText(r.body);
      if (unserviceable(text)) throw new PartnerError('not_serviceable', text);
      if (/slot/i.test(text)) throw new PartnerError('slot_unavailable', text);
      throw new PartnerError('invalid_request', `Orange Health booking refused: ${text || r.status}`);
    }
    return { partnerRef: r.body.request_id, token: r.body.token ?? null };
  }

  /** Recent orders' results list our partner_reference_id: the best lookup the public API offers. */
  async findOrderByClientRef(orderId: string): Promise<PartnerBooking | null> {
    const now = this.opts.now();
    const r = await this.call<TestResultsResponse>('GET', '/v1/partner/test-results', {
      creation_start_date: istParts(now - 3 * DAY).date,
      creation_end_date: istParts(now + DAY).date,
    });
    if (r.status >= 400) throw new PartnerError('unavailable', `Orange Health test-results: ${this.statusText(r.body) || r.status}`);
    const hit = r.body?.data?.orders?.find(x => x.partner_reference_id === orderId && x.request_id);
    return hit ? { partnerRef: hit.request_id!, token: null } : null;
  }

  async cancel(partnerRef: string, reason: string, token?: string | null): Promise<void> {
    const r = await this.call<unknown>('PATCH', `/v1/partner/${encodeURIComponent(partnerRef)}/cancel`, { token: this.need(token) }, {
      cancellationReason: reason.slice(0, 200), cancellationExplanation: reason.slice(0, 500),
    });
    if (r.status >= 400) throw new PartnerError('not_allowed', `Orange Health cancel: ${this.statusText(r.body) || r.status}`);
  }

  async reschedule(partnerRef: string, slot: Slot, token?: string | null): Promise<void> {
    const start = Date.parse(slot.start);
    if (Number.isNaN(start)) throw new PartnerError('invalid_request', `Not a slot: ${slot.start}`);
    const r = await this.call<unknown>('PATCH', `/v1/partner/${encodeURIComponent(partnerRef)}/reschedule`, { token: this.need(token) }, {
      requested_slot_time: istParts(start).local, reschedule_reason: 'Requested by the customer', reschedule_explanation: 'Rescheduled in the LotusPond Health app',
    });
    if (r.status >= 400) {
      const text = this.statusText(r.body);
      throw new PartnerError(/slot/i.test(text) ? 'slot_unavailable' : 'not_allowed', `Orange Health reschedule: ${text || r.status}`);
    }
  }

  private need(token: string | null | undefined): string {
    if (!token) throw new PartnerError('not_allowed', 'This Orange Health booking has no token stored, so it can only be changed by Orange Health support');
    return token;
  }

  async status(partnerRef: string, token?: string | null): Promise<PartnerStatus> {
    const at = new Date(this.opts.now()).toISOString();
    if (!token) {
      // Found by our reference after a lost reply: only the results show progress.
      const o = await this.resultOrder(partnerRef);
      if (!o) return { status: 'unknown', partnerStatus: 'no_token', at };
      return o.order_completed_at
        ? { status: 'report_ready', partnerStatus: 'completed', at: o.order_completed_at }
        : { status: o.tests?.length ? 'partial_report' : 'unknown', partnerStatus: o.tests?.length ? 'results_partial' : 'no_token', at };
    }
    const r = await this.call<OrderDetailsResponse>('GET', `/v1/partner/order-details/${encodeURIComponent(partnerRef)}`, { token });
    if (r.status >= 400 || !r.body?.data) throw new PartnerError('not_found', `Orange Health order ${partnerRef}: ${this.statusText(r.body) || r.status}`);
    const d = r.body.data;
    const raw = (d.status ?? '').toLowerCase();
    const tests = (d.patient_information ?? []).flatMap(p => p.tests?.tests ?? []);
    const ready = tests.filter(t => t.is_report_ready).length;
    let status: OrderStatus | 'unknown' = STATUS_MAP[raw] ?? 'unknown';
    let partnerStatus = raw || 'unknown';
    // Order details give the request's coarse status; the tests and the collector say how far it has got.
    if (status !== 'cancelled' && status !== 'report_ready') {
      if (tests.length && ready === tests.length) { status = 'report_ready'; partnerStatus = `${raw}:all_reports_ready`; }
      else if (ready > 0) { status = 'partial_report'; partnerStatus = `${raw}:some_reports_ready`; }
      else if (status === 'booked' && d.emedicDetails && Object.keys(d.emedicDetails).length) { status = 'collector_assigned'; partnerStatus = `${raw}:emedic_assigned`; }
    }
    return { status, partnerStatus, at };
  }

  private async resultOrder(partnerRef: string): Promise<ResultOrder | null> {
    const r = await this.call<TestResultsResponse>('GET', '/v1/partner/test-results', { request_id: partnerRef });
    if (r.status >= 400) throw new PartnerError('unavailable', `Orange Health test-results: ${this.statusText(r.body) || r.status}`);
    return r.body?.data?.orders?.find(o => o.request_id === partnerRef) ?? r.body?.data?.orders?.[0] ?? null;
  }

  async report(partnerRef: string, token?: string | null): Promise<PartnerReport> {
    const o = await this.resultOrder(partnerRef);
    const rows = (o?.tests ?? []).filter(t => t.investigation_name && t.investigation_value != null && t.investigation_value !== '').map(t => ({
      name: t.investigation_name!,
      value: t.investigation_value!,
      ...(t.investigation_value_unit ? { unit: t.investigation_value_unit } : {}),
      ...(t.investigation_range ? { range: t.investigation_range } : {}),
      ...(t.investigation_is_abnormal === 'A' ? { flag: 'Abnormal' } : {}),
      ...(t.investigation_code ? { partnerCode: t.investigation_code } : {}),
    }));
    if (!o || !rows.length) return { pending: true, partial: false };
    const complete = !!o.order_completed_at;
    let pdf: Uint8Array | undefined;
    if (complete && token) pdf = await this.reportPdf(partnerRef, token);
    return {
      pending: false,
      partial: !complete,
      rows,
      ...(pdf ? { pdf } : {}),
      // A new value for each change: more rows, a completion, or an amended value.
      version: createHmac('sha256', 'orange-report').update(JSON.stringify([o.order_completed_at ?? null, rows])).digest('hex').slice(0, 16),
      ...(o.order_completed_at ? { reportedAt: o.order_completed_at } : {}),
      labName: 'Orange Health Labs',
    };
  }

  /** The merged report from order details' reportURL. Missing or failing PDFs leave the structured rows to stand alone. */
  private async reportPdf(partnerRef: string, token: string): Promise<Uint8Array | undefined> {
    const r = await this.call<OrderDetailsResponse>('GET', `/v1/partner/order-details/${encodeURIComponent(partnerRef)}`, { token });
    const url = r.body?.data?.patient_information?.find(p => p.reportURL)?.reportURL;
    if (!url || !/^https:\/\//.test(url)) return undefined;
    try {
      const res = await this.opts.fetch(url, { signal: AbortSignal.timeout(this.opts.timeoutMs) });
      if (!res.ok) return undefined;
      const bytes = new Uint8Array(await res.arrayBuffer());
      return bytes.length > 4 && Buffer.from(bytes.subarray(0, 4)).toString('latin1') === '%PDF' ? bytes : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * HMAC-SHA256 (hex) of the body with our webhook secret, in x-oh-signature. Orange Health signs the body serialised
   * with no whitespace, so a body that arrives pretty-printed is checked in that form too.
   */
  verifyWebhook(req: InboundRequest): boolean {
    const got = req.headers[ORANGE_SIGNATURE_HEADER] ?? req.headers[ORANGE_SIGNATURE_HEADER.toUpperCase()];
    if (!got || !/^[0-9a-f]{64}$/i.test(got)) return false;
    const sign = (bytes: Uint8Array | string) => createHmac('sha256', this.opts.webhookSecret).update(bytes).digest();
    const given = Buffer.from(got.toLowerCase(), 'hex');
    if (timingSafeEqual(sign(req.rawBody), given)) return true;
    try {
      return timingSafeEqual(sign(JSON.stringify(JSON.parse(Buffer.from(req.rawBody).toString('utf8')))), given);
    } catch {
      return false;
    }
  }

  parseWebhook(body: unknown): WebhookInfo {
    const order = (body as WebhookBody | null)?.payload?.order;
    const partnerRef = order?.city_request_id;
    if (!partnerRef) throw new PartnerError('invalid_request', 'Orange Health webhook without payload.order.city_request_id');
    return { partnerRef, eventId: null, ...(order?.partner_reference_id ? { clientRef: order.partner_reference_id } : {}) };
  }
}

/** Read and check a catalogue file (JSON array of OrangeCatalogItem). */
export function parseOrangeCatalog(json: string): OrangeCatalogItem[] {
  const list = JSON.parse(json) as unknown;
  if (!Array.isArray(list) || !list.length) throw new Error('Orange Health catalogue: expected a non-empty JSON array');
  const codes = new Set<string>();
  return list.map((x, i) => {
    const c = x as Partial<OrangeCatalogItem>;
    const where = `Orange Health catalogue item ${i + 1}`;
    if (typeof c.code !== 'string' || !/^[\w.-]{1,60}$/.test(c.code)) throw new Error(`${where}: code must be 1-60 letters, digits, ".", "-" or "_"`);
    if (codes.has(c.code)) throw new Error(`${where}: duplicate code ${c.code}`);
    codes.add(c.code);
    if (c.kind !== 'test' && c.kind !== 'package') throw new Error(`${where}: kind must be "test" or "package"`);
    if (typeof c.id !== 'string' || !c.id) throw new Error(`${where}: id (Orange Health's test_id or package_id) is required`);
    if (typeof c.name !== 'string' || !c.name) throw new Error(`${where}: name is required`);
    if (!Number.isInteger(c.pricePaise) || c.pricePaise! <= 0) throw new Error(`${where}: pricePaise must be a positive integer`);
    return {
      code: c.code, kind: c.kind, id: c.id, name: c.name, tests: Array.isArray(c.tests) ? c.tests.map(String) : [],
      pricePaise: c.pricePaise!, ...(Number.isInteger(c.mrpPaise) ? { mrpPaise: c.mrpPaise } : {}),
      fasting: c.fasting === true, reportHours: Number.isFinite(c.reportHours) ? Number(c.reportHours) : 24,
    };
  });
}
