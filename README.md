# LotusPond Health

**Your family's health records, ready for any AI agent.** LotusPond keeps lab results, scans, conditions and medications for you and each family member, turns them into a summary an agent can use, and lets the agents you choose read it: Claude, ChatGPT, Gemini, Grok, Meta AI, or your own. You decide whose records each agent sees and whether it may add to them. You can disconnect any agent at any time.

It works with any agent that speaks the [Model Context Protocol](https://modelcontextprotocol.io): the server is a remote MCP server at `/mcp`, with OAuth 2.1 sign-in so agents connect like any other connector. The app around it is a full personal health record: upload reports, see results on a 3D body map, book a home sample collection.

See [docs/agents.md](docs/agents.md) for how agents connect, the tools they get, and the safety model.

## What it does

- **Connected agents.** Add LotusPond to Claude (Settings → Connectors → Add custom connector), ChatGPT (developer-mode connectors), Claude Code, Cursor or any MCP client with one address: `https://<your server>/mcp`. The agent opens a LotusPond sign-in, where you pick the profiles it may see and whether it may add readings. Agents that cannot sign in use an access token made on Account. Agents get:
  - a **health summary**: results outside their range, values moving toward or away from range, tests that may be due given the profile's conditions, BMI, conditions, medications and allergies;
  - each marker's **history and trend**, the profile details, and the list of scans and files (never the files themselves);
  - with permission, ways to **add what you tell them**: a reading (blood pressure, weight, glucose), or a condition, medication or allergy, each marked with the agent that added it;
  - **lab tests near you** and a **booking proposal** that you confirm in the app. Agents never book or pay by themselves.

  Every connection, read (hourly) and write shows in Recent activity.

- **Accounts and profiles.** Sign up with email, password and the country you live in, which decides where your records are stored and which rules apply (see [Data residency](#data-residency)). One account holds your own profile plus any family members you add (children, partner, parents). Each profile keeps date of birth, sex, height, weight (with BMI), blood type, conditions, medications, allergies and notes. Switch between people from the menu at the top.
- **Upload** lab report PDFs, photos and scans of reports, CSV/JSON exports, DICOM files (`.dcm`) and scan photos. Photos and scanned PDFs are read with text recognition on the device; when that read is poor, the person can choose to have Claude read that one file ([docs/report-reading.md](docs/report-reading.md)). Files are read in the browser and every value is shown for review before it is saved. The original file is kept with the values read from it.
- **Body map**: a 3D anatomy with 33 structures, including:
  - a four-chambered heart with valves and coronary vessels
  - lungs with their fissures and a bronchial tree
  - kidneys with cortex, medullary pyramids and calyces
  - a brain with gyri and ventricles
  - liver vessels and bile ducts
  - skeleton and diaphragm

  Organs with results get a status dot. Open an organ to fly in, read labelled landmarks, switch to x-ray, or cut a cross-section (front, side or top).
- **Biomarkers**: latest value of each marker grouped by body system, with its position in the reference range and its trend over time.
- **Scans**: assign scans to body areas; view with zoom, and brightness/contrast for DICOM.
- **Files**: every original report and scan, with links to open, download or delete it.
- **Find a lab**: labs, imaging centres and hospitals near you on a map. For accounts held in India, **Home collection** books a lab visit at home for any profile: pick a package for your pincode and a time, follow the order from booking to report, move or cancel the visit, then check the results on the same review screen as an upload before they are added. Only the simulated lab is connected so far (see [Lab booking](#lab-booking-in-progress)).
- **Account**: where your records are stored, the consents you gave (with date and version), recent sign-ins and changes, units for lab values (conventional or SI), contacts for data questions; change password, sign out other devices, export a profile as JSON, delete a profile or the whole account.

Reference ranges come from your report when it prints one; otherwise a typical adult range is used and labelled. LotusPond explains results; it does not diagnose.

## Stack

| Layer | Choice |
| --- | --- |
| Frontend | React 19, Vite, TypeScript, React Three Fiber, zustand |
| API | Node.js 22, [Hono](https://hono.dev), Zod validation (`server/`, an npm workspace) |
| Database | PostgreSQL via Drizzle ORM. Without `DATABASE_URL` the server uses embedded [PGlite](https://pglite.dev) (Postgres in WebAssembly), so development needs no database install |
| Sign-in | Email and password hashed with Argon2id; server-side sessions in an HttpOnly, SameSite=Lax cookie |
| Files | Disk storage behind a small `FileStore` interface (`server/src/lib/files.ts`), encrypted with AES-256-GCM (`files-encrypted.ts`); swap in object storage for multi-server deployments |
| Residency | One database and file store per data region ("cell"), chosen from the country of residence (`server/src/cells.ts`, `shared/regions.ts`) |

Types shared by the browser and the server live in `shared/`.

## Test it on your computer

You need [Node.js](https://nodejs.org) 22.12 or newer (check with `node -v`) and git. Nothing else: the server uses an embedded PostgreSQL-compatible database (PGlite), so there is no database to install.

```bash
git clone https://github.com/lotuspond-ai/lotuspond-health.git
cd lotuspond-health
npm install
npm run local
```

Then open **http://localhost:8787**: the public website, with **Create free account** and **Sign in** leading into the app (`/signup`, `/login`, then `/app`). `npm run local` builds the app and runs the production server exactly as a deployment would, over plain http on your computer only. Stop it with Ctrl+C; run it again to pick up new changes.

| Command | What runs | Data kept in |
| --- | --- | --- |
| `npm run local` | Production build on http://localhost:8787 | `server/.data-local/` |
| `npm run dev` | Development with live reload: app on http://localhost:5173, API on :8787 | `server/.data/` |
| `docker compose up --build` with `POSTGRES_PASSWORD`, `DIRECTORY_SECRET` and `FILE_ENCRYPTION_KEY` set (see [Production](#production)) | Production image with a real PostgreSQL, on http://localhost:8787 | Docker volumes |

Delete the data folder to start over with no accounts.

**Things to try**

1. Create an account, fill in the short setup step (or skip it).
2. Choose **Explore with sample data**, or **Upload** files from `tools/fixtures/`: `sample-lab-report.pdf`, `results-export.csv`, `chest-xray-synthetic.dcm`, `ct-abdomen-synthetic.dcm`. Check the values, then add them.
3. Open organs on the body map, then the **Biomarkers**, **Scans** and **Files** pages. Open and download an original from **Files**.
4. From the menu at the top right, **Add a family member**, upload something for them, and switch back: each person's records are separate.
5. **Profile details**: edit details, add allergies or medications, export the profile as JSON.
6. **Account and sign-in**: change the password, sign out, sign back in. Open the app in a second browser to see "Sign out other devices" work.
7. Reload the page at any point: you stay signed in on the same profile.

**If something gets in the way**

- *Port already in use*: `PORT=8788 npm run local` (Windows PowerShell: `$env:PORT=8788; npm run local`).
- *Try it from a phone on the same Wi-Fi*: `HOST=0.0.0.0 npm run local`, then open `http://<your computer's IP>:8787` on the phone.
- *`npm install` fails on an old Node*: install the current Node.js LTS and run it again.

To use your own PostgreSQL server instead of the embedded database, copy `server/.env.example` to `server/.env` and set `DATABASE_URL`. Migrations run automatically when the server starts.

## Tests

```bash
npm test                                   # parser tests and API integration tests
npm run typecheck                          # frontend and server
TEST_DATABASE_URL=postgres://… npm test -w server   # API tests against a real PostgreSQL
node tools/e2e-accounts.mjs http://localhost:5173/  # browser walk-through: website pages, then accounts (needs Playwright and a running stack)
```

The cell tests (`server/test/compliance.test.ts`) run three cells at once: the default database, an India cell and an EU cell, each in-memory PGlite. `TEST_DATABASE_URL` puts the default database on PostgreSQL; `TEST_CELL_IN_DATABASE_URL` and `TEST_CELL_EU_DATABASE_URL` do the same for the two cells (each must be a separate test database).

## Production

**To deploy on your own server at https://health.lotuspond.ai, follow [`deploy/README.md`](deploy/README.md):** PostgreSQL, the app and automatic HTTPS (Caddy) with one command, plus secrets, backups and partner-lab import. The notes below explain the pieces.


```bash
npm run build      # frontend to dist/, server bundle to server/dist/
npm start          # serves the API and the app on :8787
```

Or with Docker (PostgreSQL included):

```bash
# Put these in a .env file next to docker-compose.yml and keep it: the same secrets are needed on every start.
POSTGRES_PASSWORD=choose-a-password
DIRECTORY_SECRET=...      # openssl rand -base64 32
FILE_ENCRYPTION_KEY=...   # openssl rand -base64 32
docker compose up --build
```

Run it behind HTTPS (a reverse proxy or your platform's load balancer) and set:

- `DIRECTORY_SECRET` and `FILE_ENCRYPTION_KEY`: **required**; the server refuses to start without them. Generate each with `openssl rand -base64 32`, keep them in your secret store and back them up. Without the directory secret no account can be found at sign-in; without the file key no stored file can be read. (`FILE_ENCRYPTION=off` starts without a file key, storing files unencrypted, and says so in the log.)
- `COOKIE_SECURE=true` (the default when `NODE_ENV=production`; set `false` only for plain http on localhost)
- `TRUST_PROXY=true` so rate limits see real client addresses
- `DATA_DIR` on persistent storage; uploaded originals are kept there
- `GRIEVANCE_CONTACT` if you serve India (the DPDP Act requires a published grievance contact) and `DPO_CONTACT`; both are shown on the Account page
- `SERVED_REGIONS` and `CELL_*` settings to keep each region's records in its own database (next section)

To try the production server locally: `npm run build`, then `cd server && PORT=8841 COOKIE_SECURE=false DATA_DIR=.data-prod NODE_ENV=production DIRECTORY_SECRET=… FILE_ENCRYPTION_KEY=… node dist/index.js`. `npm run local` sets `LOCAL_SECRETS=true` instead, which lets the production build generate both secrets in its data folder; never set that on a server. In development (`npm run dev`) the secrets are generated in `server/.data/secrets/`, with a warning.

All settings are listed in `server/.env.example`. Any host that runs a Node.js container works (Render, Fly.io, Railway, a VM); pair it with managed PostgreSQL.

### Data residency

Each data region (`in`, `eu`, `us`, `global`) is a **cell**: its own database and file store ([research notes, section 2](docs/research.md)). The country chosen at sign-up decides the cell (`shared/regions.ts`): India in `in`; the EU and EEA, the UK and Switzerland in `eu`; the US and Canada in `us`; everyone else in `global`. Countries whose law requires in-country hosting we do not have yet (for example the UAE and Saudi Arabia) cannot sign up, and the form says why.

- **What lives in a cell:** accounts, sessions, profiles, results, scans, documents and their files, consent records, the audit log. Everything under `/api/profiles` and the account endpoints uses the request's cell (`c.var.cell`), never the default database.
- **What lives in the default database (`DATABASE_URL`):** the directory and non-personal data (partner labs, the facility cache). The directory maps an HMAC of the email (keyed with `DIRECTORY_SECRET`) to the region and user id, so sign-in finds the cell without any email stored outside it.
- **Routing:** session tokens start with their region (`in.…`), so each request goes straight to its cell. Tokens from before cells existed are looked up in the default cell. Migrations run on every cell at start-up (`npm run db:migrate -w server` does the same without starting the server).
- **Configuration:** with no `CELL_*` settings, every served region uses the default database and `DATA_DIR/files`, which is how a single server runs. Give a region its own storage with `CELL_<REGION>_DATABASE_URL` (PostgreSQL) and/or `CELL_<REGION>_DATA_DIR` (files, plus an embedded database when there is no URL), and optionally its own `CELL_<REGION>_FILE_ENCRYPTION_KEY`:

  ```bash
  SERVED_REGIONS=in,eu,global
  CELL_IN_DATABASE_URL=postgres://…@db-mumbai/lotuspond_in    CELL_IN_DATA_DIR=/mnt/in
  CELL_EU_DATABASE_URL=postgres://…@db-frankfurt/lotuspond_eu CELL_EU_DATA_DIR=/mnt/eu
  # global stays in DATABASE_URL and DATA_DIR/files
  ```

  The server refuses settings that would mix cells (two cells on one database or directory). Sign-up for a region the deployment does not serve is refused with a message saying where that country's records are kept.
- **Strict localisation:** to keep the India cell in India, run an API in each region behind regional hostnames, each with `SERVED_REGIONS` set to its own region and `DATABASE_URL` pointing at one shared default database, so all of them share the directory. Signing in on the wrong regional host gives a "kept on servers in …" message.
- Accounts created before cells existed have no country; they stay in the default cell. Move them before giving their region a cell of its own.

### Security notes

- Every request for a profile's data checks that the profile belongs to the signed-in account, in the account's own cell.
- Session tokens are random 256-bit values with a region prefix; the database stores only their SHA-256.
- Sign-up records explicit consent (Terms, Privacy, processing of health data, and storage abroad where that applies) with the text version (`CONSENT_VERSION`), time and country. Product emails are opt-in. Withdrawing a required consent means deleting the account; the Account page explains that rather than leaving a half state. Own accounts are for adults (18+); children are family profiles of a parent or guardian.
- An audit log per cell records sign-ins (and failed ones), sign-outs, password changes, exports, deletions, consent and preference changes, with an HMAC of the client address and a short device name ("Firefox on Windows"). It never holds health data, names or emails. Deleting an account removes its history and leaves one `account_deleted` record. Events are kept for `AUDIT_RETENTION_DAYS` (default 400).
- Sign-in and sign-up are rate-limited per address and per email (in memory, so per server process).
- Changes must come from the app's own origin (checked with `Sec-Fetch-Site` / `Origin`).
- Uploaded files are served with `X-Content-Type-Options: nosniff` and a sandboxing CSP; types a browser could run (HTML, SVG) are only ever sent as downloads.
- The app is served with a strict Content Security Policy.
- Uploaded files are encrypted at rest with AES-256-GCM and a random IV per file. Each file starts with a 37-byte header (magic `LPEF`, format version, key id, IV, tag); the header and the file's storage key are authenticated, so a changed, truncated or moved file fails to decrypt and is never served. Use a database and disks with encryption at rest too, and HTTPS everywhere.

### Rotating the file key

1. Generate a new key (`openssl rand -base64 32`). Set it as `FILE_ENCRYPTION_KEY` and move the old one to `FILE_ENCRYPTION_PREVIOUS_KEYS` (comma-separated if there are several). Do the same per cell for `CELL_<REGION>_FILE_ENCRYPTION_KEY` if you use those.
2. Restart. New files use the new key. Files under the old key stay readable, because each file's header names its key.
3. Re-encrypt the stored files: `node dist/index.js files:rekey` in production (in development, `npm run files:rekey -w server`). It reports what it changed in each cell, and it is safe to run while the server is up and to run again. It also encrypts files saved before encryption was turned on, so run it once when upgrading an existing deployment.
4. When it reports no failures, remove the old key from `FILE_ENCRYPTION_PREVIOUS_KEYS` and restart.

`DIRECTORY_SECRET` is not rotated this way: changing it orphans the directory. Accounts are still found by searching each cell at sign-in (and re-added to the directory), but keep the secret stable.

## API

All routes are under `/api` and use JSON unless noted.

| Method and path | What it does |
| --- | --- |
| `POST /auth/register`, `POST /auth/login`, `POST /auth/logout` | Create an account (with its own profile), sign in, sign out |
| `GET /auth/me` | The signed-in account (with country, storage region and unit system) and its profiles, or `null` |
| `GET /auth/config` | Regions this server holds records for, the consent version and published contacts (no sign-in needed) |
| `PATCH /auth/preferences` | Change the unit system: `{ "unitSystem": "si" }` or `"conventional"` |
| `GET`, `PATCH /auth/consents` | Every consent decision, newest first; grant or withdraw the optional ones (`{ kind, granted }`) |
| `GET /auth/activity` | Recent account events |
| `POST /auth/password`, `DELETE /auth/sessions`, `DELETE /auth/account` | Change password, sign out other devices, delete the account |
| `GET`, `POST /profiles` | List or add profiles |
| `GET`, `PATCH`, `DELETE /profiles/:id` | Read, update or remove a profile |
| `GET`, `DELETE /profiles/:id/records` | Everything stored for a profile, or delete it all |
| `GET /profiles/:id/export` | JSON export (re-importable through the upload dialog); the account holder's own profile also includes the account's consents and activity |
| `POST /profiles/:id/measurements`, `PATCH`/`DELETE …/measurements/:mid` | Save, edit or delete results |
| `POST /profiles/:id/documents` (multipart), `GET …/documents/:did/file`, `DELETE …/documents/:did` | Store, fetch or delete original files |
| `POST /profiles/:id/scans`, `PATCH`/`DELETE …/scans/:sid` | Save, edit or delete scans |
| `GET /lab/catalog?pincode=`, `GET /lab/slots?partner=&pincode=&date=&items=` | Lab booking: packages and home-collection slots from the partners serving the account's region |
| `GET`, `POST /profiles/:id/lab-orders` | A profile's lab bookings, or book one (needs an `Idempotency-Key` header) |
| `GET /profiles/:id/lab-orders/:oid`, `POST …/:oid/cancel`, `GET …/:oid/slots?date=`, `POST …/:oid/reschedule` | One booking with its status timeline; cancel it, or find a new time (same lab, address and tests) and move the visit |
| `GET /profiles/:id/lab-results`, `GET …/lab-results/:rid/report` | Lab results waiting for review (`?status=all` for every delivery), and the report PDF |
| `POST …/lab-results/:rid/save` `{ measurements }`, `POST …/:rid/dismiss` | Save the reviewed values and the PDF as the profile's records (replacing an earlier delivery of the same order), or drop the result |

| `GET /agents`, `POST /agents/tokens`, `PATCH`/`DELETE /agents/:id` | Connected agents: list them with the MCP address, create an access token (shown once), change profiles or permissions, disconnect |

Agents use `POST /mcp` (MCP, JSON-RPC over Streamable HTTP) and the OAuth endpoints `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/authorize`, `/oauth/token` and `/oauth/revoke`, all outside `/api` ([docs/agents.md](docs/agents.md)).

Lab partners call `POST /hooks/:partner/:secret` (outside `/api`; see [Lab booking](#lab-booking-in-progress)).

## Lab booking (in progress)

Book a home sample collection with a lab partner for any profile, and follow it from booking to report. The design is in [docs/lab-booking-backend.md](docs/lab-booking-backend.md); the code is in `server/src/lab/` ([its README](server/src/lab/README.md)).

- **Partners.** Orange Health Labs has an adapter (`LAB_PARTNERS=orange`), built from its public API docs and waiting for a partner key; setup and open questions are in [docs/lab-partners.md](docs/lab-partners.md). No real lab is live yet. `LAB_PARTNERS=fake` runs a simulated lab inside the server: it has packages, slots and an order timeline, sends signed webhooks, and writes reports as structured results plus a PDF. It is on by default in development and refused in production. Each partner serves one data region (the simulated lab: India), and only accounts held there can book with it.
- **Orders.** Orders are kept in the account's cell with the profile they are for, and carry the booking consent (notice version and time). The patient's contact details are encrypted with the cell's file key. Partner webhooks are only hints: the server asks the partner for the current status, and a poller catches missed webhooks.
- **Results.** When the lab's report is ready, the server fetches it and keeps it, with the PDF, waiting for review. The app reads it like an upload; saving makes the values measurements and the PDF a document in the profile, replacing whatever an earlier delivery of the same order saved (a partial report, or one later amended).
- **In the app.** Find a lab → Home collection (shown only for accounts in a region with a partner, and not in the server-less preview). Booking takes four steps: tests for a pincode, a visit time (India time), who is tested and where the collector comes, then a notice naming the lab and what it receives, which must be accepted. The booking is sent with an idempotency key tied to exactly those details, so retrying after a dropped connection never books twice. Orders show a progress tracker and can be moved or cancelled while the lab allows it. The screen checks the lab every few seconds while an order is moving, and every minute elsewhere in the app; results waiting to be checked show as a count on Find a lab. Code: `src/components/labs/` (`HomeTests`, `BookingDialog`, `SlotPicker`, `ResultReview`) and `src/state/lab.ts`.
- **Not built yet.** Payments (orders are pay-at-collection), notifications, and keeping the mobile number and address for the next booking.

To try it, run `npm run dev`, sign up with India as the country, open Find a lab and book with a Bengaluru, Mumbai or Delhi pincode (e.g. 560034). The order moves a step every 10 seconds (set `LAB_FAKE_STEP_MS` to change that). Add `#partial`, `#recollect`, `#slot-full` and the like to the patient's name to play other scenarios ([list](server/src/lab/README.md#the-simulated-lab)).

## Mobile apps (iOS and Android)

The iOS and Android apps (`android/`, `ios/`) are the app shell built with [Capacitor](https://capacitorjs.com), signed in to the same server. On phones they add bottom tabs, a draggable results sheet over the body map, camera capture, an optional Face ID / fingerprint lock and the system share sheet. [docs/mobile.md](docs/mobile.md) covers setup, testing against your computer's server, and releasing.

```bash
npm run android    # build the app shell, sync it into the projects, open Android Studio (needs JDK 21)
npm run ios        # same, then open Xcode (needs macOS with Xcode 26+)
```

How the apps sign in and which server they call:

The apps load the same build in a native shell, from `capacitor://localhost` (iOS) and `https://localhost` (Android). Every API call is therefore cross-site, and cookies are not sent, so the apps use **token sessions**:

1. **Sign in or sign up** with the header `X-LotusPond-Client: app` on `POST /api/auth/login` or `/api/auth/register`. The response is the usual session (account and profiles) plus `token` and `expiresAt`, and no cookie is set. The token is stored and expires like a browser session; the database holds only its SHA-256. Keep it in the platform's secure storage (Keychain or Keystore).
2. **Authenticate every request** with `Authorization: Bearer <token>`. This works wherever the session cookie works: profile and record routes, file downloads, exports, `GET /api/auth/me`, `POST /api/auth/logout` (revokes that token), `POST /api/auth/password` and `DELETE /api/auth/sessions` (both keep only the current session).
3. **Cross-site check and CORS.**
   - Requests with no session cookie and either a bearer token or `X-LotusPond-Client: app` pass the cross-site check; cookie requests are checked exactly as before.
   - CORS is answered only for `APP_CLIENT_ORIGINS` (default `capacitor://localhost,https://localhost`). It allows the `Authorization`, `Content-Type`, `X-LotusPond-Client` and `Range` (map tiles) headers, exposes `Content-Disposition` so downloads keep their names and `Content-Range` and `ETag` for tile range reads, and never sends `Access-Control-Allow-Credentials`.
4. **Which server to call.** With one deployment serving every region (the default), the app always calls `https://health.lotuspond.ai/api`; tokens carry their region (for example `in.…`), so requests reach the right cell. When regions run on separate hosts, set `REGION_API_ORIGINS`, for example `in=https://in.health.lotuspond.ai,eu=https://eu.health.lotuspond.ai`.
   - Before signing in, read `GET /api/auth/config`: `apiOrigins` lists each region's origin.
   - Sign-up: use the origin for the region of the chosen country (`countryPolicy(country).region` in `shared/regions.ts`).
   - Sign-in on a host that does not hold the account returns `403` with `error.code` `wrong_region`, plus `error.region` and `error.apiOrigin`. Retry there and keep using that origin for the session; `GET /api/auth/me` also returns `account.region`.

## Public website

The product's own site, **https://health.lotuspond.ai**, is built by the same Vite build as the app (a multi-page build):

| Address | File | What it is |
| --- | --- | --- |
| `/` | `index.html` | Landing page: static HTML and CSS, no JavaScript |
| `/privacy/`, `/terms/`, `/trust/` | `privacy/index.html`, `terms/index.html`, `trust/index.html` | Privacy Policy (with the Consumer Health Data Privacy Policy), Terms of Use, Trust and compliance |
| `/app`, `/login`, `/signup` | `app.html` (entry `src/main.tsx`) | The app. `/signup` and `/login` open the auth screen in that mode; after sign-in the address becomes `/app` (views stay in the hash, e.g. `/app#markers`); signing out goes to `/login` |
| anything else | `404.html` | Not-found page, sent with a 404 status |

- **Shared pieces** live in `src/site/`: `site.css` (styles, using the app's colour tokens), `fonts.css` with self-hosted Newsreader and Hanken Grotesk (SIL OFL; no third-party requests), and HTML partials in `src/site/partials/` included with `<!-- @include header -->`.
- **Region tables** on the landing, Privacy and Trust pages are rendered at build time from `shared/regions.ts` with markers such as `<!-- @regions storage-table -->` (see `tools/site/regions.ts`), so the pages always match sign-up.
- **`SITE_URL`** (build-time, default `https://health.lotuspond.ai`) sets canonical and social URLs (`%SITE_URL%` in HTML), and the generated `robots.txt` and `sitemap.xml`. Build for another host with `SITE_URL=https://staging.example.com npm run build`.
- **Imagery**: `public/site/*.webp` are real screenshots of the app, and `public/site/og.png` (1200×630) is the social preview, rendered from `tools/site/og.html`. Regenerate both after visible app changes, with the dev stack running: `node tools/site/shots.mjs http://localhost:5173/`.
- **Legal text** has placeholders in the form `[Legal entity name — to be completed by LotusPond]` for details only LotusPond can supply (entity, address, officers, contacts, periods). Search for `to be completed` before launch, and have each market's text reviewed.
- **Serving** (`server/src/app.ts`): pages get their own Content Security Policy (the website allows no WebAssembly and no inline styles; the app shell adds `'wasm-unsafe-eval'` for the model decoder), hashed files in `/assets/` are cached for a year as immutable, and the build writes `.br` and `.gz` copies of text files that the server sends when the browser accepts them. `vite` and `vite preview` follow the same routes (`tools/site/vite-plugin.ts`).

## Project layout

| Path | What it holds |
| --- | --- |
| `src/three/` | React Three Fiber stage: tissue materials, pond floor, camera, x-ray and cross-sections, adaptive quality |
| `src/components/bodymap2d/`, `public/bodymap/` | Pre-rendered body map (default view) and its images |
| `src/anatomy/organs.ts` | Organ metadata: meshes, tissues, landmarks, linked body systems |
| `src/lib/` | File parsers, the records store (the biomarker catalog is in `shared/catalog.ts`, used by the agent summaries too) |
| `src/api/` | Data access: `http.ts` talks to the API, `browser.ts` keeps everything in IndexedDB for server-less previews |
| `src/state/` | Session (account, profiles, open profile), interface state, toasts |
| `src/pages/`, `src/components/` | Interface (`src/components/labs/`: Find a lab, home collection booking and lab results review) |
| `index.html`, `privacy/`, `terms/`, `trust/`, `404.html`, `src/site/` | Public website (see above); `app.html` is the app shell |
| `tools/site/` | Build plugin for the website, region tables, screenshot and social-image tool |
| `server/src/` | API: routes, auth, database schema, file storage, cells (`cells.ts`) and compliance records (`compliance/`: directory, consents, audit log, secrets) |
| `server/src/agents/` | Agent connections: MCP endpoint (`mcp.ts`), tools (`tools.ts`), health summary (`synthesis.ts`), OAuth (`oauth.ts`), grants and tokens (`grants.ts`), the app's routes (`routes.ts`) |
| `server/src/lab/` | Lab booking: partner interface and simulated lab, order state machine, webhooks, booking service and routes ([README](server/src/lab/README.md)) |
| `server/drizzle/` | SQL migrations (generate with `npm run db:generate` after changing `server/src/db/schema.ts`) |
| `shared/` | Types and limits used by both sides |
| `tools/anatomy/` | Python generator for `public/models/anatomy.glb` (signed-distance modelling, surface nets, quadric decimation) |

## Rebuilding the anatomy model

Requires Python 3 with NumPy.

```bash
cd tools/anatomy
python3 gen_body.py && python3 gen_organs.py && python3 gen_gut.py && python3 gen_skel.py
python3 gen_organs.py kidneys && python3 gen_detail.py     # high-detail structures (overrides heart, brain, kidneys)
python3 build_glb.py decimate $(python3 -c "from build_glb import T; print(' '.join(T))")
python3 build_glb.py write anatomy_raw.glb
cd ../.. && npx gltf-transform meshopt tools/anatomy/anatomy_raw.glb public/models/anatomy.glb --level medium
```

Model coordinates are metres with `+x` toward the person's left, `+y` up and `+z` toward the front.

### Pre-rendered body map

The body map opens as images rendered ahead of time, so it needs no WebGL; "Explore in 3D" loads the interactive model on request. After changing the model or the look of the stage, render the images again (headless Chromium, a few minutes) and commit `public/bodymap/` and `src/components/bodymap2d/manifest.json`:

```bash
node tools/render-bodymap.mjs              # 16 angles + a close-up per organ, two sizes, ID maps, manifest
node tools/measure-bodymap.mjs http://localhost:8787/ --3d   # first-view downloads and 3D frame cost
```

## Server-less preview

`npm run build:artifact` writes `dist-artifact/`: the app alone (`vite build --mode artifact`, relative paths) built with `VITE_BACKEND=browser`, which keeps accounts, profiles, records and files in the visitor's browser (IndexedDB) instead of on a server. It is meant for static hosts such as a Claude artifact. Such hosts have no server routes and only pass a `#hash` into the page, so the preview's `index.html` is the app: it opens sign-in, or sign-up with `#signup`, and its links to the website (home, Privacy, Terms, Trust) open the live site in a new tab. The 3D model ships as base64 text (`models/anatomy.b64.txt`) for hosts that don't serve `.glb` files, and `index.html` is body-only. Check it locally with `npx vite preview --outDir dist-artifact` and the browser walk-through.
