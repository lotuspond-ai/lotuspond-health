# Lab booking and results: backend design

Status: November 2026. The booking side is built on the API server (`server/src/lab/`), against a simulated lab; fetching results into the profile is next. No lab partner has signed yet, so everything partner-specific (endpoints, status names, webhook format) is a placeholder until we have their API docs.

## 1. Context

LotusPond keeps each person's health records in their account: a profile for themselves and each family member, with results, scans and original files stored on the server (encrypted) in the data region where they live. Today records come from files people upload. We want them to book a home sample collection with a lab partner (Tata 1mg Labs, Thyrocare, or an aggregator such as LabsAdvisor) from inside the app, follow the order, and get the results into the profile without uploading anything.

This sits on the existing API server: its email and password accounts, sessions, family profiles, data-residency cells, consent records and audit log. What lab booking adds:

1. Partner API credentials, kept on the server.
2. An always-on endpoint for partner webhooks.
3. Orders, which carry the patient's name, mobile number and address to the partner.

## 2. Requirements

**Functional**

- Show tests and packages, with prices, from the partners that serve the user's pincode and region.
- Show collection slots; book, reschedule and cancel, for any profile on the account.
- Track each order from booking to report, with status updates.
- Save results into the profile through the same review step as an upload. Nothing is added to the records without the user confirming it.
- Handle partial reports (some tests come back later) and amended reports.

**Non-functional**

- Scale: pilot of up to about 1,000 orders a month, which is around 35 orders and 200 webhooks a day. A single small instance is plenty.
- Webhooks must never be lost. The partner or our poller will retry, so 99.5% uptime is enough.
- Booking screens should respond within 2 seconds. Nothing else is latency-sensitive.
- Privacy: an order's data stays in the account's cell; contact details are encrypted at rest; personal details are kept only as long as the order or the law needs them.
- Team: one or two developers, all TypeScript.

**Constraints**

- Partner APIs are unknown. Some may provide only a PDF report, some may not sign their webhooks, and some may have no webhooks at all.
- India first: DPDP Act obligations, Indian mobile numbers, payments in rupees via UPI or cards.

**Out of scope for now:** payments (orders are pay-at-collection), ABDM, sharing with doctors, and alerts about out-of-range results.

## 3. Architecture

```
 App (browser / iOS / Android)                LotusPond API server                                    Partners
┌──────────────────────────┐   /api (JSON,  ┌────────────────────────────────────────────┐  HTTPS   ┌──────────────┐
│ Book / Orders screens    │   session)     │ /api/lab, /api/profiles/:pid/lab-orders     │ ───────▶ │ Tata 1mg     │
│ review results, then     │ ─────────────▶ │   main's sessions, profiles, Zod, audit     │          │ Thyrocare    │
│ save to the profile      │ ◀───────────── │ /hooks/:partner/:secret (webhook receiver)  │ ◀─────── │ LabsAdvisor  │
└──────────────────────────┘                │ lab runtime per cell: booking service,      │ webhooks │ simulated lab│
                                            │   webhook processor, poller, placements    │          └──────────────┘
                                            └───────────────┬────────────────────────────┘
                                                            │ the account's cell
                                         ┌──────────────────▼───────────────────────────┐
                                         │ Cell database (Postgres / PGlite): lab_orders,│
                                         │ lab_order_events, lab_webhook_inbox, records  │
                                         │ Cell file store (encrypted): report PDFs      │
                                         └───────────────────────────────────────────────┘
```

| Component | Choice | Why |
| --- | --- | --- |
| API | The existing Hono server (`server/`), lab code in `server/src/lab/` | One server, one sign-in, one set of security rules |
| Storage | Drizzle tables in each cell's database (`db/schema.ts`, migration `0003_lab_orders.sql`) | Orders are personal data, so they live in the account's cell |
| Background work | Timers in the server process (`lab/runtime.ts`): webhooks every 5 s, placement retries every 15 s, polling every 5 min, purge every 6 h | No extra infrastructure at this scale; the database is the queue |
| Encryption at rest | The cell's file keyring, in main's file format (`lab/sealer.ts`) | Same keys and rotation as stored files |
| Payments | Not built; Razorpay when needed (see §16) | Standard for UPI and cards in India |

## 4. Key decisions

### 4.1 Results go into the profile, after review

When a report arrives, the server turns it into a result bundle (§9) and keeps it with the report PDF, waiting in the account. The app shows it on the same review screen as an upload; when the user confirms, the values and the PDF are saved to the profile's records like any upload (measurements and documents). The server stores everything in the account's cell, encrypted at rest as files already are.

This replaces the first design's device mailbox (results encrypted to one device and deleted after pickup). That fitted an app that kept records only in the browser. Now that records live in the account, the mailbox would add a second storage model and lose results when a phone is lost, for little gain.

### 4.2 Matching results to the biomarker catalog stays in the app

The server doesn't need to know the catalog. It converts each partner's format into a neutral bundle whose field names are the ones `src/lib/parse/json.ts` already reads (`date`, `results[]`, `name`, `value`, `unit`, `range`/`low`/`high`, `flag`). The app passes the bundle to `parseJsonText`, or the PDF to the PDF parser when there is no structured data. The result then goes through the existing review step and is saved.

Checked with the simulated lab: a complete-package report goes through `parseJsonText` and through the PDF parser; all 57 rows match the expected biomarker with high confidence, and both routes give the same values and statuses (`server/test/fake-lab.test.ts`).

Benefits:

- One matching implementation, already tuned for Indian lab naming.
- The review step is preserved.
- The server never computes "your LDL is high", which keeps it out of anything resembling diagnosis.

**Gotcha to fix before sending marker hints:** if a row carries a `markerId` that the catalog doesn't know, `buildMeasurement` (`src/lib/parse/rows.ts`) skips name matching and the row comes back unmatched. The server doesn't send `markerId`. If partner code maps are added later, change `buildMeasurement` to fall back to name matching when the hint is unknown.

**Without structured data:** if a partner gives us only a PDF, the app runs the existing PDF parser. That works for text-based PDFs, which large Indian labs generally produce. So a PDF-only partner is still usable, and structured results are an improvement rather than a blocker.

### 4.3 Webhooks are hints; the partner API is the source of truth

Partner webhooks may be unsigned, duplicated, out of order or missing. For each webhook, we store the raw request, reply `200` straight away, and have the worker call `adapter.status()` / `adapter.report()` to learn what actually changed. A reconciliation job polls every unfinished order on a schedule that depends on its status (§12), so a missed webhook only delays an update. If a partner has no webhooks, polling covers it.

### 4.4 One adapter per partner, starting with a simulated lab

Every partner sits behind one `LabPartner` interface (§8). The first adapter is a **simulated lab** (`server/src/lab/partners/fake-lab.ts`): it serves catalogues and slots, moves orders through every status on a timer, sends signed webhooks, and serves reports, including partial and amended ones, as structured rows and a PDF. That lets us build and test the whole flow before any partner replies. Real adapters then only translate formats. `LAB_PARTNERS=fake` turns it on (the default in development; refused in production).

### 4.5 Each partner serves one region

A partner is configured with the data region it serves (Indian labs: `in`). Its orders and its webhook inbox live in the cell that holds that region, and only accounts held in that region can book with it; others see an empty catalogue. This keeps an Indian lab's orders, and the personal details they carry, in the India cell.

## 5. Flows

### 5.1 Booking

1. The user enters a pincode. `GET /api/lab/catalog?pincode=` asks the partners serving the account's region for serviceability and catalogue. Results are cached per partner and pincode for 24 hours.
2. The user picks a package and a date. `GET /api/lab/slots` is not cached, because slots change.
3. A consent screen names the partner, lists what will be shared (name, age, sex, mobile number, address, tests) and why. Its version is `LAB_BOOKING_NOTICE_VERSION` (`shared/lab-bundle.ts`); the order records the version accepted and when, and the booking goes in the account's activity log.
4. `POST /api/profiles/:pid/lab-orders` sends the package, slot, patient details, mobile number (accounts are email-based, so it is asked here), address and consent, with an `Idempotency-Key` header.
5. The server creates the order (status `created`) in the account's cell, with the contact details sealed. With no payment step yet (`payer: 'partner'`, pay at collection), it moves straight to `placing`.
6. The server calls `adapter.createOrder` with our order id as the partner's client reference, with a 10-second timeout:
   - On success, the order becomes `booked` and stores the partner's reference.
   - On timeout, the order stays `placing` and the worker retries. Each retry first calls `findOrderByClientRef`, so a slow request never becomes a double booking.
   - If the partner rejects the order (e.g. the slot was taken), it becomes `failed`.
   - Retries follow 30 seconds, then 1, 2, 5, 10 and 20 minutes. After the last one, or once the slot has started, the order fails with an alert. A reply to a timed-out call that arrives later is still applied. A partner booking that turns up after we gave up is cancelled at the partner, so no collector visits an order the user was told had failed.

### 5.2 Status updates

1. The partner calls `POST /hooks/:partner/:hookSecret` (outside `/api`: no browser checks, no CORS).
2. The receiver checks the secret path, the optional IP allowlist and the signature, stores the request sealed in the partner's region cell (`lab_webhook_inbox`) with a uniqueness key, and returns `200`.
3. The worker extracts the partner reference, calls `adapter.status()`, maps the partner status to ours, and applies it through the state machine (§6). Every change is written to `lab_order_events`.
   - If no order has that reference but the partner echoed our order id, the order's booking reply was probably lost (it is still `placing`). The worker confirms the reference with `findOrderByClientRef` before linking it.
   - An order it can't find is retried with backoff (from 1 minute up to 1 hour), then dead-lettered with an alert after 10 attempts. Partner timeouts and outages are retried the same way. An unreadable body goes straight to dead letter.
4. Changes the user cares about (collector assigned, sample collected, report ready) will trigger a push notification (not built). The partner already texts the user about the collection visit, so we don't duplicate that.

### 5.3 Results delivery (next to build)

1. On `report_ready` or `partial_report`, or when an amended report arrives, the worker calls `adapter.report()` to get the PDF and/or rows, builds a bundle with the next `sequence` number, and stores it with the PDF in the account's cell as a pending result for the profile.
2. A notification says "Your LotusPond results are ready". It never names the lab, the test or any value.
3. The app shows the pending result on the review screen, labelled with its source, e.g. "Thyrocare, order TC123".
4. When the user confirms, the values and the PDF are saved to the profile like an upload, replacing any measurements from an earlier delivery for the same order.

Replacing earlier deliveries matters because the app's merge only drops repeats with the same marker, date and value. A corrected value in an amended report would otherwise sit next to the old one. Measurements carry a `sourceFile`, which the app shows ("from …"), so set it to something readable that is still unique per order, e.g. `Thyrocare order TC123`, and replace by it.

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
   cancelled: a user may cancel before sample_collected; the lab may cancel at any unfinished stage
```

The rules live in `server/src/lab/orders/state.ts`. Moves come from two sources: the partner (what the lab reports) and us (payment, placing, a user's cancel or reschedule, pickup, expiry).

- **Forward only.** Each state has a rank, and partner moves only go forward. Skipping ahead is fine: after a missed webhook an order can jump from `booked` to `report_ready`. The exceptions:
  - `collector_assigned → booked`: the lab rescheduled the visit or reassigned the collector.
  - `recollection_needed`: can be reported any time from `booked` up to `partial_report`. From there the visit starts again at `booked` or later.
- **Out-of-date reads are dropped.** Each order stores the partner's last status and the time the partner gave for it. A read with an older time is ignored, so a slow status call that finishes late can't undo a newer one.
- **A new partner status that doesn't change ours is still recorded**, as an event. Examples: `REPORT_AMENDED` while we're at `report_ready` or `delivered`, which also fires the report hook so the results pipeline checks the version. A newer status that would move backwards is recorded too, with an alert.
- Each adapter maps the partner's own status names to these. An unknown partner status is recorded, raises an alert and leaves the order unchanged.
- `delivered` means the final (non-partial) results were saved to the profile. `expired` is kept for results left unreviewed past a limit, which isn't set yet (§11).
- Final states: `delivered`, `expired`, `cancelled`, `failed`.

## 7. API

All under `/api`, signed in with main's session (cookie in the browser, bearer token in the mobile apps), with main's error format `{ "error": { "code", "message" } }` and browser checks for changes.

| Method and path | Purpose |
| --- | --- |
| `GET /api/lab/catalog?pincode=` | Packages across the partners serving the account's region: `{partner, code, name, tests[], pricePaise, mrpPaise, fasting, reportHours}` |
| `GET /api/lab/slots?partner=&pincode=&date=&items=` | Available slots |
| `POST /api/profiles/:pid/lab-orders` | Book for that profile (example below); needs an `Idempotency-Key` header |
| `GET /api/profiles/:pid/lab-orders`, `GET …/:oid` | The profile's orders, or one order with its status timeline |
| `POST …/:oid/cancel` `{reason?}`, `POST …/:oid/reschedule` `{slot}` | Change an order |

Inbound: `POST /hooks/:partner/:hookSecret` (partners), and later `POST /hooks/razorpay`.

```json
POST /api/profiles/:pid/lab-orders
{
  "partner": "fake",
  "items": ["FL_ESSENTIAL"],
  "slot": { "start": "2026-11-08T07:00:00+05:30", "end": "2026-11-08T08:00:00+05:30" },
  "patient": { "name": "…", "age": 34, "sex": "female" },
  "phone": "+91…",
  "address": { "line1": "…", "line2": "…", "city": "Bengaluru", "pincode": "560034", "landmark": "…" },
  "consent": { "noticeVersion": "2026-11-03", "accepted": true }
}
```

How the endpoints behave:

- **`POST …/lab-orders`** replies:
  - `201` when the partner confirmed the booking;
  - `202` while it is still `placing` (the app shows "confirming" and reads the order again);
  - `409` if the slot was just taken, or `422` if the partner refused for another reason, with the order recorded as `failed` (in `error.order`).

  A repeat of the same request with the same `Idempotency-Key` returns the same order with `Idempotent-Replayed: true`; the same key with a different request gets `422`.
- **Refused before any order is created:**
  - malformed requests (`400`, field named in the message), including unknown fields;
  - accounts outside the partner's region (`not_in_region`);
  - under-18 patients (DPDP parental consent isn't supported yet);
  - consent to an older notice version (`409`, so the app shows the current notice) or no consent;
  - packages not offered at the pincode, unserved pincodes, and slots that have started.
- **Responses.** Order views (`LabOrderView` in `shared/lab-bundle.ts`) carry no personal details. Another account's order, or another profile's, looks exactly like a missing one (`404`).

## 8. Partner adapter interface

In `server/src/lab/partners/types.ts`. Each configured partner also has a data region (`PartnerConfig.region`) and a webhook path secret.

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

In `server/src/db/schema.ts`, in every cell's database (migration `0003_lab_orders.sql`):

| Table | Holds |
| --- | --- |
| `lab_orders` | The order: account, profile, partner and its reference, our status and the partner's last status with its time, items, slot, price, payer, sealed contact details, consent version and time, idempotency key and request hash, placement retries, failure reason. Unique partner reference per partner; unique idempotency key per account. Deleted with the profile or account |
| `lab_order_events` | Every status change and partner update: the timeline, and the audit trail for support |
| `lab_webhook_inbox` | Partner webhooks as received: sealed body, credential-free headers, attempts, next attempt, processed or dead-lettered. Unique per partner and event key |

The lab code reads them through `server/src/lab/store/drizzle.ts`; `store/memory.ts` implements the same contracts for fast tests, and `server/test/lab-store.test.ts` runs both against the same expectations.

## 11. What the server holds, and for how long

| Data | Why | Kept |
| --- | --- | --- |
| Patient name, age, sex, mobile number, address (sealed) | The partner needs them to collect | Until the order reaches a final state, plus 30 days for disputes; then wiped (not built yet) |
| Tests, price, payment reference | Invoices, refunds, tax | As long as tax law requires (GST records: about six years). Ask a lawyer whether test names can be reduced to a package code |
| Order status history | Support, reconciliation | Same as the order |
| Pending results (bundle and PDF) | Waiting for the user's review | Until saved or dismissed; then they are records like any upload |
| Raw webhook bodies (sealed) | Debugging and replay | 7 days after processing |
| Booking consent | Proof of consent | With the order; the activity log keeps the booking event as long as it keeps events |

Deleting a profile or the account deletes its orders with it. An order still open at the partner should be cancelled there first (not built yet).

## 12. Failure handling

| Failure | Handling |
| --- | --- |
| Missed webhook | Reconciliation job (`server/src/lab/orders/reconcile.ts`) polls unfinished orders: every 3 hours while `booked` (to follow the slot time once orders carry it), every 30 minutes once a collector is assigned, hourly after `sample_collected`, every 6 hours while `processing`, every 3 hours after a partial report |
| Duplicate webhook | The unique `dedupe_key` drops it; the state machine ignores repeated statuses |
| Out-of-order webhooks | Forward-only state ranks (§6) |
| Partner down while the user is booking | That partner's packages are marked unavailable and the others are still shown; no order is created |
| `createOrder` times out | Order moves to `placing`; the worker retries with a client-reference lookup first (§5.1) |
| Payment taken but booking failed | Automatic refund job, plus an alert |
| Report fetch fails | Retries with backoff from 1 minute to 1 hour for up to 24 hours, then an alert |
| Scanned (image-only) PDF with no rows | The client shows the parser warning; we push the partner for structured results |
| Password-protected PDF (some Indian labs lock emailed reports) | The client parser can't open these. Ask partners for unlocked copies through the API; if a partner only provides locked ones, the adapter unlocks the PDF server-side before storing it |
| User never reviews the results | They wait in the account (§5.3); reminders on days 3 and 14. Nothing is lost by waiting |
| Amended report | New delivery with a higher `sequence`; saving it replaces that order's earlier measurements |

**Monitoring and alerts**

- Webhook verification failures
- Unknown partner statuses
- Partner API error rate or response time per adapter
- Orders stuck in one state beyond what the partner promises (e.g. `sample_collected` for more than 72 hours)
- Results not reviewed after 7 days
- Refund job failures

Logs carry order ids only, never request bodies, names or values. The error tracker scrubs request data.

## 13. Security and compliance

- **Webhooks:** HMAC signatures where the partner offers them, plus a secret in the URL path (rotatable) and an optional IP allowlist. In every case the payload is treated as a hint (§4.3). Webhooks are served outside `/api`, so browser rules don't apply and browser checks can't be used against them.
- **Secrets:** partner credentials live in the secrets manager. They are never in the repo, and partner calls are never made from the app.
- **Encryption at rest:** contact details and webhook bodies are sealed with the cell's file keyring, bound to their order or webhook, so a sealed value can't be moved to another row.
- **Residency:** a partner's orders and webhooks stay in the cell of the region it serves (§4.5).
- **DPDP Act:**
  - A clear, itemised consent notice per booking that names the partner, with its version and time recorded.
  - Bookings and cancellations in the account's activity log.
  - Erasure: deleting the profile or account deletes its orders.
  - A data processing agreement with each partner.
  - Adults only for now, because under-18s need verifiable parental consent.

  Have a lawyer check the notice and retention periods before launch.

## 14. Repository layout

```
shared/lab-bundle.ts          order statuses, result bundle, order view, booking notice version
server/src/lab/
  routes.ts, runtime.ts       HTTP routes; per-cell wiring and background jobs
  booking/                    booking service, Zod schemas, order view
  orders/                     state machine, sync, poller
  webhooks/                   receiver, processor
  partners/                   adapter interface, simulated lab and its adapter
  store/                      contracts, Drizzle and memory implementations
  results/bundle.ts           report to bundle
  sealer.ts, log.ts, time.ts
server/src/db/schema.ts       lab_* tables (migration 0003_lab_orders.sql)
server/test/                  fake-lab, state, webhooks, lab-store and lab-booking tests
```

## 15. Build order

1. **Done: simulated lab, end to end.** The partner interface and simulated lab, the state machine, the webhook receiver, processor and poller, and the booking API, on the API server's accounts, profiles, cells and audit log.
2. **Next: results into the profile (§5.3),** and the app's booking and review screens.
3. **First real partner, PDF results.** Whichever partner signs first. Adapter, webhook verification, and a pilot in one city.
4. **Then:** purging contact details after an order closes, cancelling open orders before a profile is deleted, notifications, payments (if we collect), a second partner, and a small internal view of stuck orders.

## 16. Trade-offs

| Decision | Chosen | Alternative | Why |
| --- | --- | --- | --- |
| Where results live | In the profile's records, after review | Device mailbox (first design) | Matches how the app now stores everything; nothing lost with a phone. Cost: results sit on the server, encrypted at rest, like every other record |
| Catalog matching | App | Server | One implementation and the review step is kept |
| Queue | The database (inbox table, order columns) and in-process timers | SQS or Redis | One system to run; fine far beyond pilot load. With several server instances, give each job a lease or run the jobs in one instance |
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

- Children: profiles can be children, but bookings are adults-only for now. Is the account holder's consent enough as a parent's, or does DPDP need more?
- Should the app ask for the mobile number once and keep it on the profile, or each time?
- Which pilot city?

## 18. Revisit as it grows

- **ABDM:** add personal health record integration, so records from any ABDM-linked lab can come in through the same review step.
- **LOINC codes** in the biomarker catalog, plus code-based matching (fix the `markerId` fallback first, §4.2).
- **Background jobs:** move them to a job queue or give them leases once the server runs as several instances.
