# LotusPond backend (in progress)

The booking and results service described in [`docs/lab-booking-backend.md`](../docs/lab-booking-backend.md). So far it has the lab partner interface and a simulated lab to build against. There is no HTTP server, database or worker yet.

| Path | What it holds |
| --- | --- |
| `src/partners/types.ts` | `LabPartner`, the interface every lab adapter implements, and `PartnerError` |
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
