# Partner labs and recorded facility data

## Importing partner labs

Partner labs are labs LotusPond works with. They appear on the **Find a lab** page above public listings, with a
**Book a test** action, for people whose country policy offers partner labs (`partnerLabs` in
`shared/regions.ts`; India today). Nothing appears until someone imports a file.

```bash
npm run partners:import -w server -- data/partners.example.json           # upsert by slug
npm run partners:import -w server -- path/to/labs.json --check            # validate only
```

The command uses the same settings as the server (`server/.env`, `DATABASE_URL`, `DATA_DIR`) and applies
migrations first. With the embedded database (no `DATABASE_URL`), stop the API server before importing:
PGlite allows one process at a time. Importing again updates labs with the same `slug`; set
`"active": false` to hide a lab without deleting it.

`partners.example.json` holds three fictional demo labs ("Demo Diagnostics, Indiranagar (example)" and two more),
with `example.com` links and placeholder phone numbers. Use it in development only.

### File format

A JSON list of labs, or `{ "labs": [ ... ] }`. Unknown fields are rejected, and one invalid entry stops the
whole import (every problem is listed).

| Field | Required | Notes |
| --- | --- | --- |
| `slug` | yes | Unique id: lower-case letters, digits and hyphens, e.g. `acme-labs-indiranagar` |
| `brand` | yes | Company name, e.g. `Acme Labs` |
| `name` | yes | This branch, e.g. `Acme Labs, Indiranagar` |
| `address` | yes | Street address as it should be shown |
| `locality`, `region`, `postalCode` | no | City, state, PIN code |
| `country` | yes | ISO 3166-1 alpha-2, e.g. `IN` |
| `latitude`, `longitude` | yes | Decimal degrees (WGS 84) of the entrance |
| `phone` | no | As dialled from abroad, e.g. `+91 80 1234 5678` |
| `website`, `bookingUrl` | no | Full `https://` addresses; `bookingUrl` powers **Book a test** |
| `services` | no | Any of `blood`, `urine`, `imaging`, `home_collection`, `ecg`, `health_checkup` |
| `openingHours` | no | OpenStreetMap syntax, e.g. `Mo-Sa 07:00-20:00; Su 07:00-12:00` (simple values show **Open now**) |
| `accreditation` | no | e.g. `NABL` |
| `active` | no | Defaults to `true` |

## Recorded responses (`fixtures/`)

Overpass and Nominatim answers for Indiranagar, Bengaluru, written in the services' JSON formats with made-up
facility names, `.example` websites and placeholder phone numbers. They back the API tests and the development
mode `FACILITY_PROVIDER=fixture`, which answers every search from these files (refused when
`NODE_ENV=production`). Area search in that mode knows Indiranagar, Koramangala, Bengaluru, the 560038
postcode, Indira Nagar in Chennai and London.
