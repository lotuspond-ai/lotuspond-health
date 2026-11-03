# Lab booking (in progress)

Home sample collection with lab partners, as designed in [docs/lab-booking-backend.md](../../../docs/lab-booking-backend.md), on main's accounts, profiles, cells and audit log. So far:

- the partner interface and a simulated lab to build against;
- the order state machine, sync with partners, and the poller;
- the webhook receiver and inbox processor;
- the booking API: catalogue, slots, and booking, listing, cancelling and rescheduling a profile's orders;
- results into the profile: reports fetched into pending results, reviewed in the app, saved as the profile's records.

Not built yet: the app's booking and review screens, payments (orders are pay-at-collection), and notifications.

## How it fits the server

- **Routes** (`routes.ts`): `/api/lab/catalog` and `/api/lab/slots`, `/api/profiles/:pid/lab-orders` and `/api/profiles/:pid/lab-results`. They use main's `requireAuth`, `requireProfile`, `readJson` (Zod), `HttpError` and audit log, and are mounted by `app.ts` when `deps.labs` is set. Partner webhooks are served at `/hooks/:partner/:secret`, outside `/api`.
- **Regions and cells.** Each partner serves one data region (the simulated lab: `in`). Its orders and webhooks live in the cell that holds that region, and only accounts held there can book with it.
- **Runtime** (`runtime.ts`). For each such cell it builds the stores on the cell's database, a sealer with the cell's file keys, the booking service, the webhook processor and the poller. `index.ts` starts them on timers when `LAB_PARTNERS` is set.
- **Tables** (`db/schema.ts`): `lab_orders`, `lab_order_events`, `lab_webhook_inbox` and `lab_results` (migrations `0003_lab_orders.sql`, `0004_lab_results.sql`). Orders and results are deleted with their profile or account; deleting a profile's records also clears its results.
- **Results** (`results/service.ts`). The results job fetches a report when an order's partner status is newer than its last report check, and stores a new version as a pending result: the bundle, plus the PDF in the cell's file store at `<profile>/<result id>`. Saving a result, in one transaction, makes the PDF a document and the app-reviewed values measurements labelled with the order. It replaces what an earlier delivery of the order saved, and delivers the order when the result is final.

| Path | What it holds |
| --- | --- |
| `routes.ts`, `runtime.ts` | HTTP routes; per-cell wiring and background jobs |
| `booking/service.ts` | Catalogue (cached a day), slots, and orders: idempotent creation with the booking consent, placing with a timeout, retries for lost replies, cancel, reschedule |
| `booking/validate.ts`, `view.ts` | Zod request schemas; the API view of an order (no personal details) |
| `orders/state.ts` | The order state machine: which status moves are allowed, from the partner and from us |
| `orders/sync.ts` | `syncOrder`: asks the partner for an order's status, drops out-of-date reads, applies the state machine, records events, fires hooks |
| `orders/reconcile.ts` | The poller: syncs unfinished orders on a per-status schedule, so missed webhooks only delay updates |
| `webhooks/receiver.ts` | `POST /hooks/:partner/:secret`: checks the secret, allowlist and signature, stores the body sealed and deduplicated, replies 200 |
| `webhooks/processor.ts` | Works through the inbox: finds each order (linking lost-response bookings) and syncs it; retries with backoff, then dead-letters |
| `store/` | Storage contracts (`types.ts`), the Drizzle implementation (`drizzle.ts`) and an in-memory one for domain tests (`memory.ts`) |
| `sealer.ts` | Encryption at rest for contact details and webhook bodies, with the cell's file keyring (main's file format) |
| `partners/types.ts` | `LabPartner`, the interface every lab adapter implements, `PartnerError` and the partner registry |
| `partners/fake-lab.ts`, `fake-lab-data.ts`, `fake-pdf.ts` | `FakeLab`: the simulated lab (catalogue, slots, order timeline, signed webhooks, reports and their PDF) |
| `partners/fake.ts` | `FakeLabAdapter`: the adapter for the simulated lab |
| `results/bundle.ts` | Turns a report into the bundle the app reads (`shared/lab-bundle.ts`) |
| `results/service.ts` | The results job (fetch, store, supersede, retry), and listing, saving and dismissing results |
| `log.ts`, `time.ts` | `[lab]` log lines (ids only, `alert: true` to page on); IST helpers |

## Tests

`npm test -w server` runs them with the rest of the server's tests:

| File | What it covers |
| --- | --- |
| `test/fake-lab.test.ts` | The simulated lab and its adapter. Its reports are also passed through the app's own JSON and PDF parsers (`src/lib/parse/`), checking every row lands on the right biomarker with the same value and status either way |
| `test/state.test.ts` | The state machine and sync decisions |
| `test/webhooks.test.ts` | Receiver, processor and poller against the simulated lab, with in-memory stores: every scenario tag, retries and dead letters, outages, polling without webhooks, the receiver's refusals, sealing |
| `test/lab-store.test.ts` | The storage contracts, run against both the memory and the Drizzle stores |
| `test/lab-booking.test.ts` | The booking API through the real app on PGlite: sign-up, regions, profiles, validation, idempotency, lost and slow replies, cancel, reschedule, webhooks through to the report |
| `test/lab-results.test.ts` | Results into the profile through the real app, reviewed with the app's own parsers (bundle and PDF): final, partial then final, superseded, amended after delivery, PDF-only, dismiss, ownership, records deletion, retries and alert |

## The simulated lab

`FakeLab` uses its own status names, snake_case payloads, rupee prices and slot ids, so `FakeLabAdapter` does the same translation a real adapter does. Orders move one step every `stepMs` (default 10 seconds; `LAB_FAKE_STEP_MS` in the server) each time `tick()` runs; `start()` ticks on a timer. Webhooks are signed with HMAC-SHA256 over `<timestamp>.<body>` in the `x-fakelab-signature` header (`t=…,v1=…`), and failed deliveries are retried on later ticks.

Every report says it is simulated. No real samples or people are involved.

Add tags to the patient name to choose what happens to an order, e.g. `Asha Rao #partial #duplicate-webhooks`, or set `defaultTags` for all orders:

| Tag | What happens |
| --- | --- |
| `#partial` | The report arrives in two parts; HbA1c and vitamins come later |
| `#amended` | The final report is corrected afterwards: potassium from a haemolysed sample |
| `#recollect` | The first sample is rejected and a second visit follows |
| `#pdf-only` | The report has a PDF but no structured results |
| `#slot-full` | Booking is refused because the slot is full |
| `#lost-response` | Booking succeeds but the reply is lost (504); a retry must find it, not book again |
| `#no-webhooks` | No webhooks; only polling sees progress |
| `#duplicate-webhooks` | Every webhook is delivered twice |
| `#out-of-order` | Webhooks are delivered in swapped pairs |

It serves pincodes starting 110, 122, 201, 400, 411, 500, 560, 600 and 700. Slots are hourly from 06:00 to 12:00 and 16:00 to 18:00 IST, at least two hours ahead and up to seven days out, with two bookings per slot.
