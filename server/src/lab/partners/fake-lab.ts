// A simulated lab partner for development and tests (design doc §4.4). It plays the lab's side: catalogue,
// slots, orders that move through a timeline, signed webhooks and reports (structured rows plus a PDF).
// It speaks its own vocabulary (status names, snake_case payloads, rupee prices, local slot ids), so
// FakeLabAdapter does the same translation work a real adapter does.
//
// Every report is marked as simulated. Nothing here is a real person's data.
//
// Choose behaviour per order with tags in the patient name, e.g. "Asha Rao #partial #duplicate-webhooks",
// or for every order with `defaultTags`:
//   #partial             report arrives in two parts; slow tests (HbA1c, vitamins) come later
//   #amended             the final report is corrected afterwards (version goes up, one value changes)
//   #recollect           the first sample is rejected and a second visit is needed
//   #pdf-only            the report has a PDF but no structured results
//   #slot-full           booking is refused because the slot is full
//   #lost-response       booking succeeds but the response is lost (504), to exercise safe retries
//   #no-webhooks         no webhooks at all; only polling sees progress
//   #duplicate-webhooks  every webhook is delivered twice
//   #out-of-order        webhooks are delivered in swapped pairs
import { createHmac } from 'node:crypto';
import { PACKAGES, PANELS, SERVED_PIN_PREFIXES, SLOT_HOURS, type FixtureRow, type Panel } from './fake-lab-data.ts';
import { buildReportPdf, type PdfPanel } from './fake-pdf.ts';
import { istDate, istIso } from '../time.ts';

export const FAKE_TAGS = [
  'partial', 'amended', 'recollect', 'pdf-only', 'slot-full', 'lost-response', 'no-webhooks', 'duplicate-webhooks', 'out-of-order',
] as const;
export type FakeTag = typeof FAKE_TAGS[number];

export type FakeStatus =
  | 'ORDER_PLACED' | 'PHLEBO_ASSIGNED' | 'SAMPLE_COLLECTED' | 'RECOLLECTION_REQUIRED' | 'IN_LAB'
  | 'PARTIAL_REPORT' | 'REPORT_READY' | 'REPORT_AMENDED' | 'CANCELLED';

export const FAKE_LAB_NAME = 'LotusPond Test Lab (simulated)';
export const FAKE_SIGNATURE_HEADER = 'x-fakelab-signature';

/** Errors as the lab's HTTP API would return them. */
export class FakeLabApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'FakeLabApiError';
    this.status = status;
    this.code = code;
  }
}

export interface FakePackage {
  package_code: string;
  display_name: string;
  parameters: string[];
  mrp_inr: number;
  offer_price_inr: number;
  fasting_required: boolean;
  tat_hours: number;
}

export interface FakeSlot { slot_id: string; start_time: string; end_time: string; available: boolean }

export interface FakeCreateOrderRequest {
  client_ref: string;
  package_codes: string[];
  /** yyyy-mm-dd, IST. */
  collection_date: string;
  slot_id: string;
  patient: { name: string; age: number; gender: 'M' | 'F' | 'O' };
  /** Ten-digit Indian mobile number. */
  mobile: string;
  address: { line1: string; line2?: string; landmark?: string; city: string; pincode: string };
}

export interface FakeOrderView {
  order_ref: string;
  client_ref: string;
  status: FakeStatus;
  status_updated_at: string;
  collection_date: string;
  slot_id: string;
  history: { status: FakeStatus; at: string }[];
}

export interface FakeResult {
  test_code: string;
  test_name: string;
  result: string;
  unit: string;
  bio_ref_interval: string;
  flag: '' | 'H' | 'L';
  remarks?: string;
}

export interface FakeReport {
  order_ref: string;
  report_status: 'PENDING' | 'PARTIAL' | 'FINAL';
  /** 0 while pending; goes up with every partial, final or amended issue. */
  version: number;
  lab_name: string;
  collected_at: string | null;
  reported_at: string | null;
  results?: FakeResult[];
  pdf_base64?: string;
}

export interface FakeWebhookBody {
  event_id: string;
  type: 'order.status_changed';
  order_ref: string;
  client_ref: string;
  status: FakeStatus;
  occurred_at: string;
}

export interface FakeWebhookRequest { headers: Record<string, string>; rawBody: Uint8Array }

export interface FakeLabOptions {
  /** Clock in ms; tests pass a manual one. */
  now?: () => number;
  /** Time between timeline steps. Default 10 s, so a whole order plays out in about a minute. */
  stepMs?: number;
  webhookSecret?: string;
  /** Receives each webhook. A throw or rejection counts as a failed delivery and is retried on later ticks. */
  onWebhook?: (req: FakeWebhookRequest) => void | Promise<void>;
  defaultTags?: FakeTag[];
  /** Bookings allowed per pincode, date and slot. Default 2. */
  slotCapacity?: number;
  /** Start of every order number (default "FL"). Give each lab instance its own when they share a database. */
  refPrefix?: string;
}

/** The lab's API surface, as an adapter sees it. */
export type FakeLabApi = Pick<FakeLab,
  'getPackages' | 'getSlots' | 'createOrder' | 'getOrder' | 'findByClientRef' | 'cancelOrder' | 'rescheduleOrder' | 'getReport'>;

interface Step { status: FakeStatus; step: number }

interface Order {
  ref: string;
  clientRef: string;
  packages: string[];
  pincode: string;
  date: string;
  slotId: string;
  patient: { name: string; age: number; gender: 'M' | 'F' | 'O' };
  tags: Set<FakeTag>;
  /** Timeline start; steps are counted from here. */
  anchor: number;
  timeline: Step[];
  applied: number;
  status: FakeStatus;
  history: { status: FakeStatus; at: number }[];
  collectedAt: number | null;
  reportVersion: number;
  reportedAt: number | null;
  /** Webhooks held back to be delivered in swapped pairs (#out-of-order). */
  held: FakeWebhookBody[];
  eventSeq: number;
}

interface Delivery { body: FakeWebhookBody; attempts: number }

const IST_OFFSET_MS = 330 * 60_000;
const MAX_DELIVERY_ATTEMPTS = 5;
const MIN_LEAD_MS = 2 * 3600_000;
const BOOKING_WINDOW_DAYS = 7;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export { istDate, istIso };

function istPrintable(ms: number): string {
  const d = new Date(ms + IST_OFFSET_MS);
  const h = d.getUTCHours(), m = d.getUTCMinutes();
  const hh = String(h % 12 || 12).padStart(2, '0'), mm = String(m).padStart(2, '0');
  return `${String(d.getUTCDate()).padStart(2, '0')}/${MONTHS[d.getUTCMonth()]}/${d.getUTCFullYear()} ${hh}:${mm} ${h < 12 ? 'AM' : 'PM'}`;
}

/** FNV-1a, for deterministic "random" choices. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function boundsOf(range: string): { low?: number; high?: number } {
  const span = /^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/.exec(range);
  if (span) return { low: +span[1], high: +span[2] };
  const lt = /^<\s*(\d+(?:\.\d+)?)$/.exec(range);
  if (lt) return { high: +lt[1] };
  const gt = /^>\s*(\d+(?:\.\d+)?)$/.exec(range);
  if (gt) return { low: +gt[1] };
  return {};
}

function timelineFor(tags: Set<FakeTag>): Step[] {
  const t: Step[] = [{ status: 'PHLEBO_ASSIGNED', step: 1 }, { status: 'SAMPLE_COLLECTED', step: 2 }];
  let n = 2;
  if (tags.has('recollect')) {
    t.push({ status: 'RECOLLECTION_REQUIRED', step: 3 }, { status: 'PHLEBO_ASSIGNED', step: 4 }, { status: 'SAMPLE_COLLECTED', step: 5 });
    n = 5;
  }
  t.push({ status: 'IN_LAB', step: ++n });
  if (tags.has('partial')) t.push({ status: 'PARTIAL_REPORT', step: ++n });
  t.push({ status: 'REPORT_READY', step: ++n });
  if (tags.has('amended')) t.push({ status: 'REPORT_AMENDED', step: ++n });
  return t;
}

const CANCELLABLE = new Set<FakeStatus>(['ORDER_PLACED', 'PHLEBO_ASSIGNED', 'RECOLLECTION_REQUIRED']);
const RESCHEDULABLE = new Set<FakeStatus>(['ORDER_PLACED', 'PHLEBO_ASSIGNED', 'RECOLLECTION_REQUIRED']);

export class FakeLab {
  private readonly now: () => number;
  private readonly stepMs: number;
  private readonly secret: string;
  private readonly onWebhook: FakeLabOptions['onWebhook'];
  private readonly defaultTags: FakeTag[];
  private readonly slotCapacity: number;
  private readonly refPrefix: string;
  private readonly orders = new Map<string, Order>();
  private readonly byClientRef = new Map<string, string>();
  private readonly lostResponseSent = new Set<string>();
  private outbox: Delivery[] = [];
  private seq = 0;
  private ticking = false;

  constructor(opts: FakeLabOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.stepMs = opts.stepMs ?? 10_000;
    this.secret = opts.webhookSecret ?? 'fake-lab-dev-secret';
    this.onWebhook = opts.onWebhook;
    this.defaultTags = opts.defaultTags ?? [];
    this.slotCapacity = opts.slotCapacity ?? 2;
    this.refPrefix = opts.refPrefix ?? 'FL';
  }

  /* ---------------- API ---------------- */

  async getPackages(pincode: string): Promise<{ pincode: string; packages: FakePackage[] }> {
    this.checkPincode(pincode);
    return {
      pincode,
      packages: PACKAGES.map(p => ({
        package_code: p.code,
        display_name: p.name,
        parameters: p.panels.map(c => this.panel(c).title),
        mrp_inr: p.mrpInr,
        offer_price_inr: p.offerInr,
        fasting_required: p.fasting,
        tat_hours: p.tatHours,
      })),
    };
  }

  async getSlots(pincode: string, date: string): Promise<{ date: string; slots: FakeSlot[] }> {
    this.checkPincode(pincode);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw new FakeLabApiError(400, 'INVALID_DATE', `Invalid date: ${date}`);
    const today = istDate(this.now());
    const last = istDate(this.now() + (BOOKING_WINDOW_DAYS - 1) * 86_400_000);
    if (date < today || date > last) return { date, slots: [] };
    return {
      date,
      slots: SLOT_HOURS.map(h => {
        const id = `S${String(h).padStart(2, '0')}`;
        const start = Date.parse(`${date}T${String(h).padStart(2, '0')}:00:00+05:30`);
        const available = start >= this.now() + MIN_LEAD_MS
          && hash(`${pincode}|${date}|${id}`) % 5 !== 0
          && this.bookedCount(pincode, date, id) < this.slotCapacity;
        return { slot_id: id, start_time: `${String(h).padStart(2, '0')}:00`, end_time: `${String(h + 1).padStart(2, '0')}:00`, available };
      }),
    };
  }

  async createOrder(req: FakeCreateOrderRequest): Promise<{ order_ref: string; status: FakeStatus }> {
    if (!req.client_ref) throw new FakeLabApiError(400, 'MISSING_CLIENT_REF', 'client_ref is required');
    if (this.byClientRef.has(req.client_ref)) throw new FakeLabApiError(409, 'DUPLICATE_CLIENT_REF', `An order already exists for client_ref ${req.client_ref}`);
    if (!req.package_codes.length) throw new FakeLabApiError(400, 'NO_PACKAGES', 'package_codes is empty');
    for (const code of req.package_codes) {
      if (!PACKAGES.some(p => p.code === code)) throw new FakeLabApiError(400, 'UNKNOWN_PACKAGE', `Unknown package: ${code}`);
    }
    if (!/^[6-9]\d{9}$/.test(req.mobile)) throw new FakeLabApiError(400, 'INVALID_MOBILE', 'mobile must be a 10-digit Indian mobile number');
    const { patient } = req;
    if (!patient.name.trim() || !Number.isInteger(patient.age) || patient.age < 1 || patient.age > 120 || !['M', 'F', 'O'].includes(patient.gender)) {
      throw new FakeLabApiError(400, 'INVALID_PATIENT', 'patient needs a name, an age from 1 to 120 and gender M, F or O');
    }
    const pincode = req.address.pincode;
    const tags = this.tagsOf(patient.name);
    const { slots } = await this.getSlots(pincode, req.collection_date);
    const slot = slots.find(s => s.slot_id === req.slot_id);
    if (!slot) throw new FakeLabApiError(400, 'INVALID_SLOT', `No slot ${req.slot_id} on ${req.collection_date}`);
    if (!slot.available || tags.has('slot-full')) throw new FakeLabApiError(409, 'SLOT_FULL', 'This slot is no longer available');

    const now = this.now();
    const ref = `${this.refPrefix}${String(++this.seq).padStart(6, '0')}`;
    const order: Order = {
      ref, clientRef: req.client_ref, packages: [...req.package_codes], pincode, date: req.collection_date, slotId: req.slot_id,
      patient: { ...patient, name: patient.name.replace(/#[a-z-]+/g, '').replace(/\s+/g, ' ').trim() }, tags,
      anchor: now, timeline: timelineFor(tags), applied: 0, status: 'ORDER_PLACED', history: [],
      collectedAt: null, reportVersion: 0, reportedAt: null, held: [], eventSeq: 0,
    };
    this.orders.set(ref, order);
    this.byClientRef.set(req.client_ref, ref);
    this.setStatus(order, 'ORDER_PLACED', now);

    if (tags.has('lost-response') && !this.lostResponseSent.has(req.client_ref)) {
      this.lostResponseSent.add(req.client_ref);
      throw new FakeLabApiError(504, 'GATEWAY_TIMEOUT', 'Upstream timed out');
    }
    return { order_ref: ref, status: order.status };
  }

  async getOrder(orderRef: string): Promise<FakeOrderView> {
    return this.view(this.order(orderRef));
  }

  async findByClientRef(clientRef: string): Promise<FakeOrderView> {
    const ref = this.byClientRef.get(clientRef);
    if (!ref) throw new FakeLabApiError(404, 'NOT_FOUND', `No order for client_ref ${clientRef}`);
    return this.getOrder(ref);
  }

  async cancelOrder(orderRef: string, reason: string): Promise<FakeOrderView> {
    const o = this.order(orderRef);
    if (o.status === 'CANCELLED') return this.view(o);
    if (!CANCELLABLE.has(o.status)) throw new FakeLabApiError(409, 'NOT_CANCELLABLE', `Order ${orderRef} is ${o.status} and can no longer be cancelled`);
    if (!reason.trim()) throw new FakeLabApiError(400, 'MISSING_REASON', 'A cancellation reason is required');
    this.setStatus(o, 'CANCELLED', this.now());
    this.flushHeld(o);
    return this.view(o);
  }

  async rescheduleOrder(orderRef: string, date: string, slotId: string): Promise<FakeOrderView> {
    const o = this.order(orderRef);
    if (!RESCHEDULABLE.has(o.status)) throw new FakeLabApiError(409, 'NOT_RESCHEDULABLE', `Order ${orderRef} is ${o.status} and can no longer be rescheduled`);
    const { slots } = await this.getSlots(o.pincode, date);
    const slot = slots.find(s => s.slot_id === slotId);
    if (!slot) throw new FakeLabApiError(400, 'INVALID_SLOT', `No slot ${slotId} on ${date}`);
    const same = o.date === date && o.slotId === slotId;
    if (!same && !slot.available) throw new FakeLabApiError(409, 'SLOT_FULL', 'This slot is no longer available');
    // A new visit: the timeline starts again from now. A sample that was already rejected isn't rejected again.
    const now = this.now();
    const recollected = o.history.some(h => h.status === 'RECOLLECTION_REQUIRED');
    o.date = date;
    o.slotId = slotId;
    o.anchor = now;
    o.timeline = timelineFor(recollected ? new Set([...o.tags].filter(t => t !== 'recollect')) : o.tags);
    o.applied = 0;
    this.setStatus(o, 'ORDER_PLACED', now);
    return this.view(o);
  }

  async getReport(orderRef: string): Promise<FakeReport> {
    const o = this.order(orderRef);
    const base = {
      order_ref: o.ref, lab_name: FAKE_LAB_NAME,
      collected_at: o.collectedAt == null ? null : istIso(o.collectedAt),
      reported_at: o.reportedAt == null ? null : istIso(o.reportedAt),
    };
    if (o.reportVersion === 0) return { ...base, report_status: 'PENDING', version: 0 };
    const partial = o.status === 'PARTIAL_REPORT';
    const { panels, amendedNote } = this.resultsFor(o, partial);
    const results = panels.flatMap(p => p.results);
    const pdf = buildReportPdf({
      labName: FAKE_LAB_NAME.toUpperCase(),
      subtitle: 'Simulated laboratory for software testing | No real samples are processed',
      header: [
        ['Patient Name', o.patient.name.toUpperCase()],
        ['Lab No.', o.ref],
        ['Age / Sex', `${o.patient.age} Y / ${({ M: 'Male', F: 'Female', O: 'Other' } as const)[o.patient.gender]}`],
        ['Collected On', o.collectedAt == null ? '-' : istPrintable(o.collectedAt)],
        ['Report Status', partial ? 'Partial' : o.status === 'REPORT_AMENDED' ? 'Final (amended)' : 'Final'],
        ['Reported On', o.reportedAt == null ? '-' : istPrintable(o.reportedAt)],
      ],
      panels: panels.map((p): PdfPanel => ({
        title: p.title,
        rows: p.results.map(r => ({ name: r.test_name, value: r.result, flag: r.flag, unit: r.unit, range: r.bio_ref_interval })),
      })),
      notes: [
        ...(partial ? ['Some tests are still in progress and will follow in a later report.'] : []),
        ...(amendedNote ? [amendedNote] : []),
      ],
      footer: 'SIMULATED REPORT FOR SOFTWARE TESTING. NOT A MEDICAL DOCUMENT.',
    });
    return {
      ...base,
      report_status: partial ? 'PARTIAL' : 'FINAL',
      version: o.reportVersion,
      ...(o.tags.has('pdf-only') ? {} : { results }),
      pdf_base64: Buffer.from(pdf).toString('base64'),
    };
  }

  /* ---------------- clock ---------------- */

  /** Apply every timeline step that is due, then deliver pending webhooks. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      for (const o of this.orders.values()) {
        if (o.status === 'CANCELLED') continue;
        while (o.applied < o.timeline.length) {
          const step = o.timeline[o.applied];
          const at = o.anchor + step.step * this.stepMs;
          if (at > now) break;
          o.applied++;
          this.setStatus(o, step.status, at);
        }
        if (o.applied === o.timeline.length) this.flushHeld(o);
      }
      await this.deliver();
    } finally {
      this.ticking = false;
    }
  }

  /** Tick on a timer (for a dev server). Returns a function that stops it. */
  start(intervalMs = 1000): () => void {
    const timer = setInterval(() => { this.tick().catch(err => console.warn('[fake-lab] tick failed', err)); }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /** Webhooks waiting to be (re)delivered. */
  pendingWebhooks(): number {
    return this.outbox.length;
  }

  /* ---------------- internals ---------------- */

  private checkPincode(pincode: string): void {
    if (!/^[1-9]\d{5}$/.test(pincode)) throw new FakeLabApiError(400, 'INVALID_PINCODE', `Invalid pincode: ${pincode}`);
    if (!SERVED_PIN_PREFIXES.includes(pincode.slice(0, 3))) throw new FakeLabApiError(422, 'NOT_SERVICEABLE', `Home collection is not available at ${pincode}`);
  }

  private tagsOf(name: string): Set<FakeTag> {
    const tags = new Set<FakeTag>(this.defaultTags);
    for (const m of name.matchAll(/#([a-z-]+)/g)) {
      if ((FAKE_TAGS as readonly string[]).includes(m[1])) tags.add(m[1] as FakeTag);
    }
    return tags;
  }

  private panel(code: string): Panel {
    const p = PANELS.find(x => x.code === code);
    if (!p) throw new Error(`Unknown panel ${code}`);
    return p;
  }

  private order(ref: string): Order {
    const o = this.orders.get(ref);
    if (!o) throw new FakeLabApiError(404, 'NOT_FOUND', `No order ${ref}`);
    return o;
  }

  private bookedCount(pincode: string, date: string, slotId: string): number {
    let n = 0;
    for (const o of this.orders.values()) {
      if (o.pincode === pincode && o.date === date && o.slotId === slotId && o.status !== 'CANCELLED') n++;
    }
    return n;
  }

  private view(o: Order): FakeOrderView {
    const last = o.history[o.history.length - 1];
    return {
      order_ref: o.ref, client_ref: o.clientRef, status: o.status, status_updated_at: istIso(last.at),
      collection_date: o.date, slot_id: o.slotId,
      history: o.history.map(h => ({ status: h.status, at: istIso(h.at) })),
    };
  }

  private setStatus(o: Order, status: FakeStatus, at: number): void {
    o.status = status;
    o.history.push({ status, at });
    if (status === 'SAMPLE_COLLECTED') o.collectedAt = at;
    if (status === 'RECOLLECTION_REQUIRED') o.collectedAt = null;
    if (status === 'PARTIAL_REPORT' || status === 'REPORT_READY' || status === 'REPORT_AMENDED') {
      o.reportVersion++;
      o.reportedAt = at;
    }
    this.emit(o, status, at);
  }

  private emit(o: Order, status: FakeStatus, at: number): void {
    if (o.tags.has('no-webhooks')) return;
    const body: FakeWebhookBody = {
      event_id: `evt_${o.ref}_${++o.eventSeq}`, type: 'order.status_changed',
      order_ref: o.ref, client_ref: o.clientRef, status, occurred_at: istIso(at),
    };
    if (o.tags.has('out-of-order')) {
      o.held.push(body);
      if (o.held.length === 2) this.flushHeld(o);
      return;
    }
    this.enqueue(o, body);
  }

  /** Release held webhooks, newest first. */
  private flushHeld(o: Order): void {
    const held = o.held.reverse();
    o.held = [];
    for (const b of held) this.enqueue(o, b);
  }

  private enqueue(o: Order, body: FakeWebhookBody): void {
    this.outbox.push({ body, attempts: 0 });
    if (o.tags.has('duplicate-webhooks')) this.outbox.push({ body, attempts: 0 });
  }

  private async deliver(): Promise<void> {
    if (!this.onWebhook) {
      this.outbox = [];
      return;
    }
    const queue = this.outbox;
    this.outbox = [];
    for (const d of queue) {
      try {
        await this.onWebhook(this.sign(d.body));
      } catch {
        if (++d.attempts < MAX_DELIVERY_ATTEMPTS) this.outbox.push(d);
      }
    }
  }

  private sign(body: FakeWebhookBody): FakeWebhookRequest {
    const raw = JSON.stringify(body);
    const t = Math.floor(this.now() / 1000);
    const v1 = createHmac('sha256', this.secret).update(`${t}.${raw}`).digest('hex');
    return {
      headers: { 'content-type': 'application/json', [FAKE_SIGNATURE_HEADER]: `t=${t},v1=${v1}` },
      rawBody: new Uint8Array(Buffer.from(raw, 'utf8')),
    };
  }

  /** Result rows for an order: fixture values nudged per order, flagged against the printed range. */
  private resultsFor(o: Order, partial: boolean): { panels: { title: string; results: FakeResult[] }[]; amendedNote: string | null } {
    const codes = [...new Set(o.packages.flatMap(p => PACKAGES.find(x => x.code === p)?.panels ?? []))];
    let panels = codes.map(c => this.panel(c));
    if (partial) {
      const fast = panels.filter(p => !p.slow);
      panels = fast.length === panels.length ? panels.slice(0, -1) : fast;
      if (!panels.length) panels = codes.slice(0, 1).map(c => this.panel(c));
    }
    const female = o.patient.gender === 'F';
    const out = panels.map(p => ({
      title: p.title,
      results: p.rows.map(r => this.result(o, p, r, female)),
    }));

    // #amended: the first final report had a wrong value (haemolysed sample); the amended one corrects it.
    let amendedNote: string | null = null;
    if (o.tags.has('amended') && !partial) {
      const all = out.flatMap(p => p.results);
      const target = all.find(r => r.test_code === 'KFT' && r.test_name === 'Potassium') ?? all.find(r => /^\d/.test(r.result));
      if (target) {
        const fixture = PANELS.flatMap(p => p.rows).find(r => r.name === target.test_name)!;
        if (o.status === 'REPORT_AMENDED') {
          target.remarks = 'Corrected after repeat analysis';
          amendedNote = `AMENDED REPORT: ${target.test_name} corrected after repeat analysis. This report replaces the earlier one.`;
        } else {
          const wrong = Number(target.result) * 1.45;
          target.result = wrong.toFixed(fixture.dp ?? 1);
          target.flag = this.flagFor(wrong, target.bio_ref_interval);
          target.remarks = 'Sample haemolysed; repeat analysis in progress';
        }
      }
    }
    return { panels: out, amendedNote };
  }

  private result(o: Order, p: Panel, r: FixtureRow, female: boolean): FakeResult {
    const range = (female ? r.rangeF : undefined) ?? r.range;
    if (typeof r.base === 'string') {
      return { test_code: p.code, test_name: r.name, result: r.base, unit: r.unit, bio_ref_interval: range, flag: '' };
    }
    const base = (female ? r.baseF : undefined) ?? r.base;
    // Varies a little per order (fixed for a given order and test), so repeat orders trend.
    const jitter = (hash(`${o.ref}|${r.name}`) / 0xffffffff - 0.5) * 2 * (r.jitter ?? 0.04);
    const value = Number((base * (1 + jitter)).toFixed(r.dp ?? 1));
    return {
      test_code: p.code, test_name: r.name, result: value.toFixed(r.dp ?? 1), unit: r.unit,
      bio_ref_interval: range, flag: this.flagFor(value, range),
    };
  }

  private flagFor(value: number, range: string): '' | 'H' | 'L' {
    const { low, high } = boundsOf(range);
    if (low != null && value < low) return 'L';
    if (high != null && value > high) return 'H';
    return '';
  }
}
