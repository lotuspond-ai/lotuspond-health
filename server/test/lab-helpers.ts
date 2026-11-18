// Shared lab test fixtures, and a harness running the real app over a test database with the simulated lab.
import type { Hono } from 'hono';
import { LAB_BOOKING_NOTICE_VERSION, type LabOrderView } from '../../shared/lab-bundle.ts';
import { createApp } from '../src/app.ts';
import { singleCell } from '../src/cells.ts';
import { ephemeralSecrets } from '../src/compliance/secrets.ts';
import { loadConfig } from '../src/config.ts';
import type { Database } from '../src/db/client.ts';
import type { AppEnv } from '../src/http.ts';
import { DiskFileStore } from '../src/lib/files.ts';
import type { BookingOptions } from '../src/lab/booking/service.ts';
import { memoryLogger } from '../src/lab/log.ts';
import type { FakeTag } from '../src/lab/partners/fake-lab.ts';
import type { LabPartner, Slot } from '../src/lab/partners/types.ts';
import { createLabs, fakePartner } from '../src/lab/runtime.ts';
import { istDate } from '../src/lab/time.ts';
import { makeClient, registration, type TestClient } from './helpers.ts';

export const NOTICE_VERSION = LAB_BOOKING_NOTICE_VERSION;

/** A complete booking request as the app sends it (JSON body of POST /api/profiles/:pid/lab-orders). */
export function bookingBody(slot: Slot, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    partner: 'fake',
    items: ['FL_ESSENTIAL'],
    slot,
    patient: { name: 'Asha Rao', age: 34, sex: 'female' },
    phone: '+919812345678',
    address: { line1: '12 Lake Road', line2: 'Koramangala', city: 'Bengaluru', pincode: '560034' },
    consent: { noticeVersion: NOTICE_VERSION, accepted: true },
    ...over,
  };
}

/** The real adapter with some methods replaced. */
export function withOverrides(real: LabPartner, overrides: Partial<Record<keyof LabPartner, unknown>>): LabPartner {
  return Object.create(real, Object.fromEntries(Object.entries(overrides).map(([k, v]) => [k, { value: v }])));
}

let users = 0;

/** A fresh app over the shared database, with the simulated lab as the partner and a clock the test moves. */
export function labEnv(database: Database, filesDir: string, opts: { tags?: FakeTag[]; wrap?: (real: LabPartner) => LabPartner; booking?: Partial<BookingOptions> } = {}) {
  let t = Date.now();
  const now = () => t;
  const log = memoryLogger();
  // OPEN_COUNTRIES=all: accounts outside India test the lab's region rules.
  const config = loadConfig({ NODE_ENV: 'test', ACCOUNTS_ISSUER: 'fake', TRUST_PROXY: 'true', OPEN_COUNTRIES: 'all' });
  const files = new DiskFileStore(filesDir);
  const cells = singleCell(database.db, files, config.servedRegions);
  const secrets = ephemeralSecrets();
  let app!: Hono<AppEnv>;
  const fake = fakePartner({
    now, stepMs: 1000,
    deliver: async (hookPath, req) => {
      const res = await app.request(hookPath, { method: 'POST', headers: req.headers, body: req.rawBody });
      if (!res.ok) throw new Error(`receiver replied ${res.status}`);
    },
  });
  const partner = opts.wrap ? { ...fake.config, adapter: opts.wrap(fake.adapter) } : fake.config;
  const labs = createLabs({
    cells, secrets, partners: [partner], now, log,
    booking: { placeTimeoutMs: 2000, placementRetryDelaysMs: [1000, 2000, 4000], ...opts.booking },
    processor: { baseDelayMs: 1000 },
  });
  app = createApp({ db: database.db, files, config, cells, secrets, labs });
  const tagSuffix = opts.tags?.length ? ` ${opts.tags.map(x => `#${x}`).join(' ')}` : '';

  /** Sign up a new account (India unless given) and return its client and self profile id. */
  async function signUp(country = 'IN'): Promise<{ c: TestClient; profileId: string }> {
    const c = makeClient(app);
    const info = await c.signUp(registration(`lab-${Date.now()}-${++users}@example.com`, country));
    return { c, profileId: info.profiles[0].id };
  }
  const tomorrow = () => istDate(t + 86_400_000);
  async function slot(c: TestClient, date = tomorrow()) {
    const r = await c.json<{ slots: { start: string; end: string }[] }>('GET', `/api/lab/slots?partner=fake&pincode=560034&date=${date}&items=FL_ESSENTIAL`);
    return r.slots[0];
  }
  let keys = 0;
  async function book(c: TestClient, profileId: string, body?: Record<string, unknown>, key = `key-${Date.now()}-${++keys}`) {
    const b = body ?? bookingBody(await slot(c), { patient: { name: `Asha Rao${tagSuffix}`, age: 34, sex: 'female' } });
    const res = await c.call('POST', `/api/profiles/${profileId}/lab-orders`, b, { 'idempotency-key': key });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: (text ? JSON.parse(text) : {}) as { order?: LabOrderView; error?: { code: string; message: string; order?: LabOrderView } } };
  }
  async function getOrder(c: TestClient, profileId: string, id: string) {
    return (await c.json<{ order: LabOrderView }>('GET', `/api/profiles/${profileId}/lab-orders/${id}`)).order;
  }
  /** Move the clock, let the lab act and deliver its webhooks, then run the background jobs once. */
  async function advance(ms: number) {
    t += ms;
    await fake.lab.tick();
    await labs.tick();
  }
  return { app, labs, fake, log, now, signUp, slot, book, getOrder, advance, tomorrow };
}
export type LabEnv = ReturnType<typeof labEnv>;
