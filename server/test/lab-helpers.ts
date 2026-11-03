// Shared test fixtures.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import type { BookingInput } from '../src/booking/validate.ts';
import type { DevicePublicJwk } from '../src/crypto/keys.ts';
import type { Hono } from 'hono';
import { AuthService } from '../src/auth/service.ts';
import { BookingService, type BookingOptions } from '../src/booking/service.ts';
import { aesGcmSealer } from '../src/crypto/sealer.ts';
import { createApp } from '../src/http/app.ts';
import { fixedWindowLimiter } from '../src/http/ratelimit.ts';
import { memoryLogger } from '../src/log.ts';
import type { OrderHooks } from '../src/orders/sync.ts';
import { FakeLab, type FakeTag } from '../src/partners/fake-lab.ts';
import { FakeLabAdapter } from '../src/partners/fake.ts';
import type { LabPartner, PartnerRegistry, Slot } from '../src/partners/types.ts';
import { MemoryAccountStore, MemoryOrderStore, MemoryWebhookInbox } from '../src/store/memory.ts';
import { WebhookProcessor } from '../src/webhooks/processor.ts';

export const NOTICE_VERSION = '2026-11-01';

/** A fresh P-256 public key, as the browser would send it. */
export function deviceKey(): DevicePublicJwk {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  return { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! };
}

/** A complete booking request as the app would send it (JSON body of POST /v1/orders). */
export function bookingBody(slot: Slot, over: Partial<Record<keyof BookingInput, unknown>> = {}): Record<string, unknown> {
  return {
    partner: 'fake',
    items: ['FL_ESSENTIAL'],
    slot,
    patient: { name: 'Asha Rao', age: 34, sex: 'female' },
    address: { line1: '12 Lake Road', line2: 'Koramangala', city: 'Bengaluru', pincode: '560034' },
    devicePublicKey: deviceKey(),
    consent: { noticeVersion: NOTICE_VERSION, accepted: true },
    ...over,
  };
}

/* ---------------- a full API app over the simulated lab ---------------- */

export const T0 = Date.parse('2026-11-03T07:30:00+05:30');
export const HOUR = 3600_000;
export const ORIGIN = 'https://app.lotuspond.example';
const HOOK = 'test-hook-secret';
const LAB_SECRET = 'test-lab-secret';

export interface ApiEnvOptions {
  tags?: FakeTag[];
  /** Wrap the real adapter, e.g. to slow it down or make it fail. */
  wrap?: (real: FakeLabAdapter) => LabPartner;
  booking?: Partial<BookingOptions>;
  otpPerIp?: number;
}

export interface Reply { status: number; body: Record<string, any>; headers: Headers }

export function apiEnv(opts: ApiEnvOptions = {}) {
  let t = T0;
  const now = () => t;
  const log = memoryLogger();
  const orders = new MemoryOrderStore();
  const inbox = new MemoryWebhookInbox();
  const accounts = new MemoryAccountStore();
  const inboxSealer = aesGcmSealer(randomBytes(32));
  const piiSealer = aesGcmSealer(randomBytes(32));
  let app!: Hono;

  const lab = new FakeLab({
    now, stepMs: 1000, webhookSecret: LAB_SECRET, defaultTags: opts.tags,
    onWebhook: async req => {
      const res = await app.request(`/hooks/fake/${HOOK}`, { method: 'POST', headers: req.headers, body: req.rawBody });
      if (!res.ok) throw new Error(`receiver replied ${res.status}`);
    },
  });
  const real = new FakeLabAdapter({ lab, webhookSecret: LAB_SECRET, now });
  const adapter = opts.wrap ? opts.wrap(real) : real;
  const partners: PartnerRegistry = new Map([['fake', { adapter, hookSecret: HOOK }]]);

  const codes = new Map<string, string>();
  const transitions: string[] = [];
  const hooks: OrderHooks = { onTransition: (o, from) => { transitions.push(`${o.id}:${from}>${o.status}`); } };
  const auth = new AuthService({ accounts, sender: { async send(phone, code) { codes.set(phone, code); } }, now, log }, { otpPepper: randomBytes(32) });
  const booking = new BookingService({ orders, accounts, partners, sealer: piiSealer, now, log, hooks }, {
    noticeVersion: NOTICE_VERSION, placeTimeoutMs: 2000, placementRetryDelaysMs: [1000, 2000, 4000], ...opts.booking,
  });
  const processor = new WebhookProcessor({ orders, partners, now, log, hooks, inbox, sealer: inboxSealer }, { baseDelayMs: 1000 });
  app = createApp({
    receiver: { partners, inbox, sealer: inboxSealer, now, log },
    api: {
      auth, booking, log, now, clientIp: c => c.req.header('x-test-ip') ?? '127.0.0.1',
      otpLimiter: fixedWindowLimiter(opts.otpPerIp ?? 20, HOUR), verifyLimiter: fixedWindowLimiter(30, HOUR),
    },
    allowedOrigins: [ORIGIN],
    log,
  });

  async function call(method: string, path: string, o: { token?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
    const headers: Record<string, string> = { ...o.headers };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    if (o.body !== undefined) headers['content-type'] = 'application/json';
    const res = await app.request(path, { method, headers, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : {}, headers: res.headers };
  }

  async function signIn(phone = '+919812345678'): Promise<string> {
    const sent = await call('POST', '/v1/auth/otp', { body: { phone } });
    if (sent.status !== 202) throw new Error(`otp: ${sent.status} ${JSON.stringify(sent.body)}`);
    const v = await call('POST', '/v1/auth/verify', { body: { phone, code: codes.get(phone) } });
    if (v.status !== 200) throw new Error(`verify: ${v.status} ${JSON.stringify(v.body)}`);
    return v.body.token as string;
  }

  /** First available slot tomorrow. */
  async function slot(date = '2026-11-04'): Promise<Slot> {
    return (await call('GET', `/v1/slots?partner=fake&pincode=560034&date=${date}&items=FL_ESSENTIAL`)).body.slots[0];
  }

  let keySeq = 0;
  async function book(token: string, body?: Record<string, unknown>, key = `key-${++keySeq}-abcdefgh`): Promise<Reply> {
    return call('POST', '/v1/orders', { token, body: body ?? bookingBody(await slot()), headers: { 'idempotency-key': key } });
  }

  const advance = async (ms: number) => { t += ms; await lab.tick(); await processor.runOnce(); };
  return { app, lab, adapter, real, orders, accounts, inbox, booking, processor, log, codes, transitions, now, call, signIn, slot, book, advance, setClock: (ms: number) => { t = ms; } };
}
export type ApiEnv = ReturnType<typeof apiEnv>;
