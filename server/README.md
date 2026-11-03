# LotusPond backend (in progress)

The booking and results service described in [`docs/lab-booking-backend.md`](../docs/lab-booking-backend.md). So far it has:

- the lab partner interface and a simulated lab to build against;
- the order state machine;
- the webhook receiver, inbox processor and reconciliation poller.

Storage is in memory for now, behind interfaces a Postgres implementation will follow. There is no booking API, database or results pipeline yet.

| Path | What it holds |
| --- | --- |
| `src/orders/state.ts` | The order state machine: which status moves are allowed, from the partner and from us |
| `src/orders/sync.ts` | `syncOrder`: asks the partner for an order's status, drops out-of-date reads, applies the state machine, records events, fires hooks |
| `src/orders/reconcile.ts` | The poller: syncs unfinished orders on a per-status schedule, so missed webhooks only delay updates |
| `src/webhooks/receiver.ts` | `POST /hooks/:partner/:hookSecret`: checks the secret, allowlist and signature, stores the body sealed and deduplicated, replies 200 |
| `src/webhooks/processor.ts` | Works through the inbox: finds each order (linking lost-response bookings) and syncs it; retries with backoff, then dead-letters |
| `src/http/app.ts` | The Hono app: webhook routes and `/healthz` |
| `src/store/` | Storage interfaces (`types.ts`) and in-memory implementations (`memory.ts`) |
| `src/crypto/sealer.ts` | AES-256-GCM for data at rest (raw webhook bodies) |
| `src/log.ts` | Structured logging; `alert: true` marks lines to page on |
| `src/dev.ts` | Development server (below) |
| `src/partners/types.ts` | `LabPartner`, the interface every lab adapter implements, `PartnerError` and the partner registry |
| `src/partners/fake-lab.ts` | `FakeLab`: a simulated lab (catalogue, slots, order timeline, signed webhooks, reports) |
| `src/partners/fake-lab-data.ts` | Its packages and result rows, in Indian lab report style |
| `src/partners/fake-pdf.ts` | Writes its text-based PDF reports |
| `src/partners/fake.ts` | `FakeLabAdapter`: the adapter for the simulated lab |
| `src/results/bundle.ts` | Turns a report into the bundle the browser receives |
| `../shared/lab-bundle.ts` | Types shared with the browser app: order statuses, result bundle |

The code runs directly on Node 22.18+ (TypeScript type stripping), so it uses erasable syntax only and `.ts` import paths. `npm run build` type-checks it along with the app.

## Tests

```bash
npm run test:server
```

These tests also pass simulated reports through the app's own JSON and PDF parsers (`src/lib/parse/`). This checks that every row lands on the right biomarker with the same value and status either way.

The webhook tests post the simulated lab's signed webhooks into the real Hono app (`app.request`, no network). They cover every scenario tag, retries and dead letters, a storage outage, polling without webhooks, and the receiver's refusals.

## Dev server

```bash
npm run dev:server
```

This runs the webhook receiver on `http://127.0.0.1:8787`, with the simulated lab posting to it over HTTP and the processor and poller on timers. There's no booking API yet, so it places four demo orders through the adapter and prints each one's progress:

- a plain order;
- one with duplicate, out-of-order webhooks and an amended report;
- one whose booking reply is lost, linked by its first webhook;
- one with no webhooks, caught up by the poller.

Set `FAKE_LAB_STEP_MS` to change the pace (default 3000). Add `-- --once` to exit when all four reach `report_ready`.

## The simulated lab

`FakeLab` uses its own status names, snake_case payloads, rupee prices and slot ids, so `FakeLabAdapter` does the same translation a real adapter does. Orders move one step every `stepMs` (default 10 seconds) each time `tick()` runs; `start()` ticks on a timer. Webhooks are signed with HMAC-SHA256 over `<timestamp>.<body>` in the `x-fakelab-signature` header (`t=…,v1=…`), and failed deliveries are retried on later ticks.

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
