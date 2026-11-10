# Lab partners

Home sample collection is booked through one adapter per partner (`server/src/lab/partners/`), behind the interface in `partners/types.ts`. The booking service, webhooks, status sync and results review are the same for every partner ([lab-booking-backend.md](lab-booking-backend.md)).

| Partner | `LAB_PARTNERS` | State |
| --- | --- | --- |
| Simulated lab | `fake` | Development and tests only; refused in production |
| Orange Health Labs | `orange` | Adapter built from the public API docs and tested against their examples; waiting for a partner API key |

## Orange Health Labs

Bengaluru, Delhi NCR, Mumbai and Hyderabad. The adapter (`partners/orange.ts`) follows Orange Health's "Partner API Public Order Flow" on Apiary (orangehealth.docs.apiary.io, by Orange Health Engineering, last updated 2024-12-16).

### Turning it on

1. **Get a partner account.** Ask integrations@orangehealth.in, which the docs name for API keys. Orange Health sets up a partner account with one of three payment models: we collect and settle weekly or monthly, Orange Health collects and credits our earnings, or we choose per order. The three public sandbox keys in the docs were refused (401) on 2026-11-10.
2. **Write the catalogue.** The API has no catalogue or price endpoint: orders name Orange Health's `test_id` and `package_id` values. Put the tests and packages we sell in a JSON file in the shape of `server/data/orange-catalog.example.json`:
   - `code` is what our orders and the app use;
   - `kind` and `id` are Orange Health's;
   - prices are in paise.

   The server checks the file at start-up.
3. **Set the variables** (`server/.env.example`):

   | Variable | What |
   | --- | --- |
   | `LAB_PARTNERS=orange` | Switch the partner on (it can run next to `fake` in development) |
   | `ORANGE_API_KEY` | The partner key |
   | `ORANGE_WEBHOOK_SECRET` | The secret we set with Orange Health for webhook signatures |
   | `ORANGE_HOOK_SECRET` | Our path secret |
   | `ORANGE_CATALOG_FILE` | Path to the catalogue file |
   | `ORANGE_API_URL` | Defaults to the sandbox; production is `https://partner-api.orangehealth.in` |
   | `ORANGE_PAYMENT_TYPE` | Who collects payment, as Orange Health names it (`paid_by_group` in their examples) |
   | `ORANGE_WEBHOOK_IPS` | Optional allow-list for webhooks |

   `PUBLIC_URL` must be set so the webhook address is right.
4. **Register the webhook.** Give Orange Health `PUBLIC_URL/hooks/orange/<ORANGE_HOOK_SECRET>` and the signing secret.
5. **Allow the network.** In the server's environment, allow the API host. Also allow the host of report links: in the sandbox examples that is `stag1-files.orangehealth.dev`, and in production it isn't known yet.

### How it maps

- **Availability and slots.** `GET /v1/partner/serviceability?pincode=&request_date=` answers both. Slots come back as `slot_datetime` values, read as India time and taken to be one hour long.
- **Booking.** `POST /v1/partner/order` sends:
  - one patient per order, with our order id as `partner_reference_id`;
  - the address as one line;
  - no coordinates: Orange Health's docs say their team then confirms the location with the patient.

  The reply's `request_id` becomes our partner reference, and its `token` is stored as `lab_orders.partner_token`. Status, cancel and reschedule need it.
- **Status.** `GET /v1/partner/order-details/{request_id}?token=` gives a coarse status: scheduled, confirmed, completed or cancelled. The adapter refines it from collector details and per-test report readiness: collector assigned, partial report, report ready.
- **Results.** `GET /v1/partner/test-results?request_id=` returns one row per investigation: name, value, unit, range and an abnormal flag (shown as "Abnormal"). When the order is complete, the merged PDF is downloaded from the order's `reportURL`.
- **Webhooks.** Orange Health signs the JSON body, serialised without whitespace, with HMAC-SHA256 hex in `x-oh-signature`. The test checks this against one of Orange Health's own signed examples (`server/test/fixtures/orange-webhook-order-created.json`). A webhook names `payload.order.city_request_id` (their request) and `partner_reference_id` (our order). As with every partner, it only prompts a status check.

### Questions for Orange Health

These questions decide details the docs leave open:

1. The test and package list with our prices (`test_id`, `package_id`), and how it changes.
2. A lookup by `partner_reference_id`. Today, a booking whose reply was lost is found by searching recent test results. That finds it without its token, so it can be followed but not cancelled or moved from our side.
3. Slot length, and whether `slot_datetime` is India time. The order details example uses UTC (`Z`).
4. The full list of order status names (the docs show `scheduled`, `confirmed`, `completed`, `cancelled`, plus webhook `status_string` values).
5. Whether to send latitude and longitude. The booking flow would need a geocoding step.
6. Webhook retries and replay, and the addresses they come from.
7. How long report links stay valid, and the production file host.

## Adding another partner

Implement `LabPartner` in a new file under `partners/`, add its id to `PartnerId` and `PARTNER_LABELS` in `shared/lab-bundle.ts`, read its settings in `config.ts`, and wire it in `lab/runtime.ts` and `index.ts`. Test it with a stand-in for its API, as `server/test/orange.test.ts` does, and through the app, as `server/test/orange-app.test.ts` does.
