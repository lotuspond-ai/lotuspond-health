# Lab booking and results: backend design

Status: draft, November 2026. No lab partner has signed yet, so everything partner-specific (endpoints, status names, webhook format) is a placeholder until we have their API docs.

## 1. Context

Today LotusPond runs entirely in the browser. Users upload reports they already have, the app reads the values, and everything is stored in IndexedDB. We want users to book a home sample collection with a lab partner (Tata 1mg Labs, Thyrocare, or an aggregator such as LabsAdvisor) from inside the app, follow the order, and get the results into the app without uploading anything.

That needs a server, for three reasons:

1. Partner API credentials can't ship in browser code.
2. Partners report progress by calling a webhook, which needs an always-on endpoint.
3. Booking means sending the user's name, phone number and address to the partner.

**Design principle: the server is a booking service and a mailbox, not a health record store.** It handles orders, holds each result only until the user's device collects it (encrypted so only that device can read it), and then deletes it. The user's health history stays where it is today: in their browser.

## 2. Requirements

**Functional**

- Show tests and packages, with prices, from the partners that serve the user's pincode.
- Show collection slots; book, reschedule and cancel.
- Track each order from booking to report, with status updates.
- Deliver results into the app through the same review step as an upload. Nothing is added to the user's history without them confirming it.
- Handle partial reports (some tests come back later) and amended reports.
- Phone number sign-in (the partner needs a phone number anyway).

**Non-functional**

- Scale: pilot of up to about 1,000 orders a month, which is around 35 orders and 200 webhooks a day. A single small instance is plenty.
- Webhooks must never be lost. The partner or our poller will retry, so 99.5% uptime is enough.
- Booking screens should respond within 2 seconds. Nothing else is latency-sensitive.
- Privacy: no stored plaintext results. Personal details are kept only as long as the order or the law needs them.
- Team: one or two developers, all TypeScript.

**Constraints**

- Partner APIs are unknown. Some may provide only a PDF report, some may not sign their webhooks, and some may have no webhooks at all.
- India: DPDP Act obligations, SMS sender registration (DLT) for OTPs, and payments in rupees via UPI or cards.

**Out of scope for v1:** booking for family members, sync across devices, ABDM, sharing with doctors, and alerts about out-of-range results.

## 3. Architecture

```
 Browser (existing SPA)                       LotusPond backend (one deployable)                 Partners
┌──────────────────────────┐   HTTPS/JSON   ┌───────────────────────────────────┐   HTTPS    ┌──────────────┐
│ Book / Orders pages      │ ─────────────▶ │ API: auth, catalog, slots, orders │ ─────────▶ │ Tata 1mg     │
│ device key pair (IDB)    │                │       results mailbox             │            │ Thyrocare    │
│ decrypt → parseJsonText  │ ◀───────────── │                                   │ ◀───────── │ LabsAdvisor  │
│   or parseFile(pdf)      │   ciphertext   │ Webhook receiver /hooks/:partner  │  webhooks  │ Fake lab     │
│ → upload review → store  │                │        │ (store raw, 200 fast)    │            └──────────────┘
└──────────▲───────────────┘                │        ▼                          │
           │ Web Push ("results ready")     │ Worker: place orders, process     │            ┌──────────────┐
           └─────────────────────────────── │   events, fetch + encrypt         │ ◀───────── │ Razorpay     │
                                            │   reports, reconcile, purge       │  webhooks  │ (if we take  │
                                            └───────┬───────────────┬───────────┘            │  payment)    │
                                                    │               │                        └──────────────┘
                                         ┌──────────▼───┐   ┌───────▼──────────────┐
                                         │ Postgres     │   │ Object storage       │
                                         │ orders, jobs │   │ encrypted PDFs (TTL) │
                                         └──────────────┘   └──────────────────────┘
```

| Component | Choice | Why |
| --- | --- | --- |
| API and worker | TypeScript on Node 22+, Hono or Fastify; two processes from one codebase | Same language as the app, and the result bundle type can be shared |
| Database | Managed Postgres in an India region (e.g. AWS `ap-south-1`) | Orders are relational; one system to run |
| Job queue | pg-boss or graphile-worker, on the same Postgres | No extra infrastructure at this scale |
| File storage | S3 or equivalent, India region, lifecycle rule deleting objects after 35 days | Encrypted report PDFs |
| Encryption | HPKE (RFC 9180), e.g. `@hpke/core`, used on both server and client | Standard, works in Node and browsers |
| Notifications | Web Push (VAPID) | Works with the existing SPA; the content never includes health details |
| Sign-in | Phone OTP through an Indian SMS provider (needs a DLT-registered template) | Partners need a verified phone number |
| Payments | Razorpay, only if we collect payment (see §16) | Standard for UPI and cards in India |

## 4. Key decisions

### 4.1 Results are delivered encrypted to the device and deleted after pickup

- At booking, the browser creates a key pair (or reuses its existing one) and keeps the private key in IndexedDB. Only the public key goes to the server with the order.
- When a report arrives, the worker turns it into a result bundle (§9) and encrypts the bundle and the PDF separately with HPKE to that public key. The order id and delivery id are bound in as associated data, so a ciphertext can't be swapped into another order. Only ciphertext is stored.
- The app downloads and decrypts the results, the user reviews them, and the app confirms receipt. The server then deletes the ciphertext. Uncollected results are deleted after 30 days.
- If the user loses the key (browser data cleared, new phone), they sign in on the new device. The server fetches the report from the partner again and encrypts it to the new key. This works as long as the partner still holds the report, which needs to be confirmed per partner.

This is not end-to-end encryption from the lab: our server sees results in memory while converting them. What it gives us is no stored plaintext, so a database or backup leak doesn't expose anyone's results, and the app's local-first promise mostly holds. The privacy wording in the README and app still needs to change: uploads stay in the browser, but bookings go through our server.

### 4.2 Matching results to the biomarker catalog stays in the browser

The server doesn't need to know the catalog. It converts each partner's format into a neutral bundle whose field names are the ones `src/lib/parse/json.ts` already reads (`date`, `results[]`, `name`, `value`, `unit`, `range`/`low`/`high`, `flag`). The client passes the decrypted bundle to `parseJsonText`, or passes the PDF to `parseFile` when there is no structured data. The result then goes through the existing review step and `addResult`.

Checked with a Thyrocare-style sample bundle: total cholesterol, HDL, TSH, HbA1c, WBC (`X 10³ / µL`), vitamin B12 and urine glucose all matched with high confidence. Printed ranges and flags carried through and the collection date was picked up. An unknown test came back unmatched with the usual "pick the right one" warning.

Benefits:

- One matching implementation, already tuned for Indian lab naming.
- The review step is preserved.
- The server never computes "your LDL is high", which keeps it out of anything resembling diagnosis.

**Gotcha to fix before sending marker hints:** if a row carries a `markerId` that the catalog doesn't know, `buildMeasurement` (`src/lib/parse/rows.ts`) skips name matching and the row comes back unmatched. In v1 the server should not send `markerId`. If partner code maps are added later, change `buildMeasurement` to fall back to name matching when the hint is unknown.

**Without structured data:** if a partner gives us only a PDF, the client runs the existing PDF parser. That works for text-based PDFs, which large Indian labs generally produce. So a PDF-only partner is still usable in v1, and structured results are an improvement rather than a blocker.

### 4.3 Webhooks are hints; the partner API is the source of truth

Partner webhooks may be unsigned, duplicated, out of order or missing. For each webhook, we store the raw request, reply `200` straight away, and have the worker call `adapter.status()` / `adapter.report()` to learn what actually changed. A reconciliation job polls every unfinished order on a schedule that depends on its status (§12), so a missed webhook only delays an update. If a partner has no webhooks, polling covers it.

### 4.4 One adapter per partner, starting with a fake lab

Every partner sits behind one `LabPartner` interface (§8). The first adapter is a **fake lab**: it serves canned catalogs and slots, moves orders through every status on a timer, and serves fixture reports, including partial and amended ones. That lets us build and test the whole flow before any partner replies. Real adapters then only translate formats.

## 5. Flows

### 5.1 Booking

1. The user enters a pincode. `GET /v1/catalog?pincode=` asks each adapter for serviceability and catalog. Results are cached per partner and pincode for 24 hours.
2. The user picks a package and a date. `GET /v1/slots` is not cached, because slots change.
3. The user signs in with a phone OTP, if they haven't already.
4. A consent screen names the partner, lists what will be shared (name, age, sex, phone, address, tests) and why. The notice version and time are recorded.
5. The browser ensures a device key pair exists. `POST /v1/orders` sends the package, slot, patient details, address and device public key, with an `Idempotency-Key` header.
6. The server creates the order (status `created`). If we take payment, it opens a Razorpay order, and the payment webhook moves the order to `paid`.
7. The server calls `adapter.createOrder` with our order id as the partner's client reference, with a 10-second timeout:
   - On success, the order becomes `booked` and stores the partner's reference.
   - On timeout, the order becomes `placing` and the worker retries. Each retry first calls `findOrderByClientRef`, so a slow request never becomes a double booking.
   - If the partner rejects the order (e.g. the slot was taken), it becomes `failed` and any payment is refunded automatically.

### 5.2 Status updates

1. The partner calls `POST /hooks/:partner/:hookSecret`.
2. The receiver checks the signature (or the secret path and IP allowlist), stores the request in `webhook_inbox` with a uniqueness key, and returns `200`.
3. The worker extracts the partner reference, calls `adapter.status()`, maps the partner status to ours, and applies it through the state machine (§6). Every change is written to `order_events`.
4. Changes the user cares about (collector assigned, sample collected, report ready) trigger a Web Push. The partner already texts the user about the collection visit, so we don't duplicate that.

### 5.3 Results delivery

1. On `report_ready` or `partial_report`, the worker calls `adapter.report()` to get the PDF and/or rows, builds a bundle with the next `sequence` number, encrypts it (§4.1), and stores it in `result_deliveries` and object storage. Plaintext lives only in memory.
2. A Web Push says "Your LotusPond results are ready". It never names the lab, the test or any value.
3. The app calls `GET /v1/orders/:id/results`, decrypts, parses (§4.2) and shows the review screen with the source labelled, e.g. "Thyrocare, order TC123".
4. When the user confirms, the app first removes any measurements from an earlier delivery for the same order, then runs `addResult`, then calls `POST /v1/results/:id/ack`. The server deletes the ciphertext.

Replacing earlier deliveries matters because `mergeMeasurements` (`src/lib/store.ts`) only drops repeats with the same marker, date and value. A corrected value in an amended report would otherwise sit next to the old one. The client needs a small `removeBySource(sourceFile)` store action. The app shows `sourceFile` to users ("from …" in the marker history), so set it to something readable that is still unique per order, e.g. `Thyrocare order TC123`.

## 6. Order states

```
created ─▶ payment_pending ─▶ paid ─┐            (payment steps only if we collect)
   └────────────────────────────────┴─▶ placing ─▶ booked ─▶ collector_assigned ─▶ sample_collected
                                          │          ▲                                  │
                                          ▼          └──── recollection_needed ◀────────┤
                                        failed                                          ▼
                                                     delivered ◀── report_ready ◀── processing
                                                         ▲              ▲               │
                                                         └── expired    └─ partial_report
   cancelled: allowed from any state before sample_collected
```

- Each state has a rank, and transitions only move forward, so out-of-order webhooks are harmless. The one allowed step back is `recollection_needed → booked` (sample rejected, new visit). Rescheduling stays in `booked` and records an event.
- Each adapter maps the partner's own status names to these. An unknown partner status is logged, raises an alert and leaves the order unchanged.
- `delivered` means the device confirmed the final (non-partial) delivery. `expired` means 30 days passed without pickup.
- Final states: `delivered`, `expired`, `cancelled`, `failed`.

## 7. API

Client to server. All endpoints require a bearer token except the OTP pair. CORS is limited to the app's origins.

| Method and path | Purpose |
| --- | --- |
| `POST /v1/auth/otp` `{phone}` | Send OTP (rate-limited per phone and per IP) |
| `POST /v1/auth/verify` `{phone, code}` → `{token}` | Sign in |
| `GET /v1/catalog?pincode=` | Packages across partners: `{partner, code, name, tests[], pricePaise, fasting, reportHours}` |
| `GET /v1/slots?partner=&pincode=&date=&items=` | Available slots |
| `POST /v1/orders` | Book (example below); needs an `Idempotency-Key` header |
| `GET /v1/orders`, `GET /v1/orders/:id` | List orders, or one order with its status timeline |
| `POST /v1/orders/:id/cancel`, `POST /v1/orders/:id/reschedule` | Change an order |
| `GET /v1/orders/:id/results` | Pending deliveries: `{id, sequence, partial, bundle?: {enc, ct}, pdfUrl?, pdfEnc?}` |
| `POST /v1/results/:id/ack` | Confirm pickup; the server deletes the ciphertext |
| `POST /v1/orders/:id/results/refetch` `{devicePublicKey}` | Recovery on a new device (§4.1) |
| `POST /v1/push-subscriptions` | Register for Web Push |
| `DELETE /v1/account` | Erase account (§11) |

Inbound: `POST /hooks/:partner/:hookSecret` (partners) and `POST /hooks/razorpay`.

```json
POST /v1/orders
{
  "partner": "thyrocare",
  "items": ["AAROGYAM_C"],
  "slot": { "start": "2026-11-08T07:00:00+05:30", "end": "2026-11-08T08:00:00+05:30" },
  "patient": { "name": "…", "age": 34, "sex": "female" },
  "address": { "line1": "…", "line2": "…", "city": "Bengaluru", "pincode": "560034", "landmark": "…" },
  "devicePublicKey": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…" },
  "consent": { "noticeVersion": "2026-11-01", "accepted": true }
}
```

## 8. Partner adapter interface

```ts
export type PartnerId = 'fake' | 'tata1mg' | 'thyrocare' | 'labsadvisor';

export interface LabPartner {
  id: PartnerId;
  catalog(pincode: string): Promise<CatalogItem[]>;
  slots(q: { pincode: string; date: string; items: string[] }): Promise<Slot[]>;
  /** Must send our order id as the partner's client reference. */
  createOrder(o: PartnerOrderInput): Promise<{ partnerRef: string }>;
  /** Lets a retry after a timeout check whether the booking already went through. */
  findOrderByClientRef(orderId: string): Promise<{ partnerRef: string } | null>;
  cancel(partnerRef: string, reason: string): Promise<void>;
  reschedule(partnerRef: string, slot: Slot): Promise<void>;
  status(partnerRef: string): Promise<{ status: OrderStatus | 'unknown'; partnerStatus: string; at: string }>;
  report(partnerRef: string): Promise<{
    pdf?: Uint8Array;
    rows?: ResultRow[];
    partial: boolean;
    collectedAt?: string;
    reportedAt?: string;
    labName?: string;
  }>;
  verifyWebhook(req: { headers: Record<string, string>; rawBody: Uint8Array; ip: string }): boolean;
  parseWebhook(body: unknown): { partnerRef: string; eventId: string | null };
}
```

## 9. Result bundle

The shared type lives in `shared/lab-bundle.ts`, imported by both server and client. Field names are deliberately the ones `parseJsonText` already reads.

```ts
export interface LabResultBundle {
  version: 1;
  kind: 'lab-result-bundle';
  source: { partner: PartnerId; orderId: string; partnerRef: string; labName?: string };
  date: string | null;          // sample collection date, yyyy-mm-dd
  reportedAt: string | null;
  partial: boolean;
  sequence: number;             // goes up with each delivery for the order
  results: ResultRow[];
}

export interface ResultRow {
  name: string;                 // as the lab prints it
  value: string | number;       // keep text such as "<0.5" or "Negative"
  unit?: string;
  range?: string;               // printed reference range, e.g. "0.54 - 5.30"
  low?: number;
  high?: number;
  flag?: string;                // "H", "L", "Abnormal"
  partnerCode?: string;         // kept for future code-based matching
  loinc?: string;
}
```

## 10. Data model

```sql
create table users (
  id uuid primary key, phone_e164 text unique not null,
  created_at timestamptz not null default now(), deleted_at timestamptz
);
create table sessions (
  id uuid primary key, user_id uuid not null references users,
  token_hash bytea not null unique, expires_at timestamptz not null
);
create table devices (
  id uuid primary key, user_id uuid not null references users,
  public_key jsonb not null, created_at timestamptz not null default now(), revoked_at timestamptz
);
create table consents (
  id uuid primary key, user_id uuid not null references users, order_id uuid,
  partner text not null, purpose text not null, notice_version text not null,
  accepted_at timestamptz not null, withdrawn_at timestamptz
);
create table orders (
  id uuid primary key, user_id uuid not null references users, device_id uuid not null references devices,
  partner text not null, partner_ref text, status text not null,
  items jsonb not null, slot_start timestamptz, slot_end timestamptz,
  patient_ct bytea, address_ct bytea, pincode text not null,   -- personal details encrypted with a KMS key
  price_paise integer not null, payer text not null check (payer in ('partner', 'lotuspond')),
  payment_ref text, pii_purged_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (partner, partner_ref)
);
create table order_events (
  id bigserial primary key, order_id uuid not null references orders,
  status text not null, partner_status text, source text not null,   -- webhook | poll | api | user
  occurred_at timestamptz, received_at timestamptz not null default now()
);
create table webhook_inbox (
  id bigserial primary key, partner text not null, dedupe_key text not null,
  headers jsonb not null, body_ct bytea not null,                      -- may contain results, so encrypted
  received_at timestamptz not null default now(), processed_at timestamptz, error text,
  unique (partner, dedupe_key)
);
create table result_deliveries (
  id uuid primary key, order_id uuid not null references orders, sequence integer not null,
  partial boolean not null, bundle_enc bytea, bundle_ct bytea, pdf_key text, pdf_enc bytea,
  created_at timestamptz not null default now(), acked_at timestamptz, expires_at timestamptz not null,
  unique (order_id, sequence)
);
create table push_subscriptions (
  id uuid primary key, user_id uuid not null references users,
  endpoint text unique not null, keys jsonb not null
);
```

`dedupe_key` is the partner's event id when they send one, otherwise a hash of the raw body.

## 11. What the server holds, and for how long

| Data | Why | Kept |
| --- | --- | --- |
| Phone number | Sign-in; the partner needs it | Until the account is deleted |
| Patient name, age, sex, address | The partner needs them to collect | Until the order reaches a final state, plus 30 days for disputes; then `patient_ct`/`address_ct` are wiped |
| Tests, price, payment reference | Invoices, refunds, tax | As long as tax law requires (GST records: about six years). Ask a lawyer whether test names can be reduced to a package code |
| Order status history | Support, reconciliation | Same as the order |
| Results (plaintext) | Conversion only | Never stored; in memory while the worker runs |
| Results (ciphertext), PDF (ciphertext) | Mailbox | Until pickup is confirmed; at most 30 days |
| Raw webhook bodies | Debugging and replay | 7 days, encrypted |
| Consent records | Proof of consent | Account lifetime plus the legally required period |

Deleting an account wipes personal details and pending deliveries straight away. Only invoice data the law requires us to keep stays.

## 12. Failure handling

| Failure | Handling |
| --- | --- |
| Missed webhook | Reconciliation job polls unfinished orders: around the slot time for `booked`, hourly after `sample_collected`, every 6 hours while `processing` |
| Duplicate webhook | The unique `dedupe_key` drops it; the state machine ignores repeated statuses |
| Out-of-order webhooks | Forward-only state ranks (§6) |
| Partner down while the user is booking | That partner's packages are marked unavailable and the others are still shown; no order is created |
| `createOrder` times out | Order moves to `placing`; the worker retries with a client-reference lookup first (§5.1) |
| Payment taken but booking failed | Automatic refund job, plus an alert |
| Report fetch fails | Retries with backoff from 1 minute to 1 hour for up to 24 hours, then an alert |
| Scanned (image-only) PDF with no rows | The client shows the parser warning; we push the partner for structured results |
| Password-protected PDF (some Indian labs lock emailed reports) | The client parser can't open these. Ask partners for unlocked copies through the API; if a partner only provides locked ones, the adapter unlocks the PDF server-side before encrypting |
| User never opens the app | Push and SMS reminders on days 3 and 14; deleted on day 30 (`expired`); recovery by refetch |
| New device or cleared browser | Refetch from the partner, encrypted to the new device key |
| Amended report | New delivery with a higher `sequence`; the client replaces that order's earlier measurements |

**Monitoring and alerts**

- Webhook verification failures
- Unknown partner statuses
- Partner API error rate or response time per adapter
- Orders stuck in one state beyond what the partner promises (e.g. `sample_collected` for more than 72 hours)
- Deliveries not picked up after 7 days
- Refund job failures

Logs carry order ids only, never request bodies, names or values. The error tracker scrubs request data.

## 13. Security and compliance

- **Webhooks:** use HMAC signatures if the partner offers them. Otherwise use a secret in the URL path (rotatable) plus an IP allowlist. In every case the payload is treated as a hint (§4.3).
- **Secrets:** partner credentials and the KMS key for personal-detail columns live in a secrets manager. Secrets are never in the repo, and partner calls are never made from the browser.
- **DPDP Act:**
  - A clear, itemised consent notice per order that names the partner.
  - Consent records.
  - A grievance contact.
  - Account erasure.
  - A breach-notification runbook.
  - A data processing agreement with each partner.
  - Adults only in v1, because under-18s need verifiable parental consent.

  Have a lawyer check the notice and retention periods before launch.
- **Hosting:** use an India region. DPDP doesn't require it today, but partners and users will expect it.

## 14. Repository layout

```
shared/lab-bundle.ts        result bundle and order status types (used by server and client)
server/
  src/api/                  routes, auth, idempotency middleware
  src/partners/             types.ts, fake.ts, tata1mg.ts, thyrocare.ts, labsadvisor.ts
  src/orders/               state machine, booking service
  src/results/              bundle building, HPKE encryption, mailbox
  src/jobs/                 worker, reconcile, purge, reminders
  migrations/
src/lib/lab/                client: API client, device keys, decryption
src/pages/Book.tsx          booking flow
src/pages/Orders.tsx        orders and status timeline
src/lib/store.ts            add removeBySource(sourceFile)
```

## 15. Build order

1. **Fake lab, end to end.** Server with the fake adapter, booking UI, the simulated status timeline, encrypted delivery, and the client review and pickup confirmation. Partner replies aren't needed for this stage.
2. **First real partner, PDF results.** Whichever partner signs first. Adapter, webhook verification, reconciliation, and a pilot in one city.
3. **Structured results and edge cases.** Structured rows, partial and amended reports, refetch on a new device, and reminders.
4. **Payments and a second partner.** Razorpay (if we collect payment), a second adapter, and a small internal ops view of stuck orders.

## 16. Trade-offs

| Decision | Chosen | Alternative | Why |
| --- | --- | --- | --- |
| Where results live | Encrypted mailbox, deleted after pickup | Server-side health records | Keeps the local-first promise and makes a breach much less damaging. Cost: no multi-device history, and recovery depends on the partner keeping reports |
| Catalog matching | Client | Server | One implementation and the review step is kept. Cost: no server-side analytics on values, which we don't want anyway |
| Queue | Postgres (pg-boss) | SQS or Redis | One system to run; fine far beyond pilot load |
| Webhook trust | Hint, then fetch from the partner API | Trust the payload | Partners may not sign webhooks; costs one extra API call per event |
| Partner coverage | Direct adapters | Aggregator only (LabsAdvisor) | Direct gives better pricing and control; an aggregator is one adapter for many labs. The adapter interface keeps both open |
| Who takes payment | Open (`payer` column) | | Partner-collects means no payments integration and no refunds on our side; us-collects gives one checkout and margin control. Decide once commercial terms are known |

## 17. Open questions

**For partners** (these match the outreach emails):

- Can we pass our own order reference and look orders up by it? This is needed for safe retries.
- Are webhooks signed, and can they be retried or replayed?
- Do you provide structured results, partial reports, and notices of amended reports?
- How long do you keep reports available through the API?
- Are PDFs from the API password-protected?
- Do you have a sandbox?
- Who collects payment?

**For us:**

- Should we allow booking for family members in v2? It is very common in India, and it changes the consent and patient-detail handling.
- Should the app keep the original PDF so the user can view the report itself? The app doesn't store report PDFs today.
- Which pilot city?

## 18. Revisit as it grows

- **Multiple devices:** encrypt each delivery to every active device key the user has.
- **Optional encrypted cloud backup** of the IndexedDB data, with a key the user holds, so history survives a lost phone.
- **ABDM:** add personal health record integration feeding the same mailbox. ABDM's data transfer already encrypts records to a public key the requester supplies, which fits this design.
- **LOINC codes** in `BiomarkerDef`, plus code-based matching (fix the `markerId` fallback first, §4.2).
- **Queue:** move it off Postgres only if job volume grows by orders of magnitude.
