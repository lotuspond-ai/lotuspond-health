# LotusPond Health

A personal health record. Create an account, keep a profile for yourself and each family member, upload lab reports and scans, and see every result on a 3D model of a female or male body built from real anatomical data, organ by organ. Results, scans and the original files are stored in your account.

## What it does

- **Accounts and profiles.** Sign up with email, password and the country you live in, which decides where your records are stored and which rules apply (see [Data residency](#data-residency)). One account holds your own profile plus any family members you add (children, partner, parents). Each profile keeps date of birth, sex, height, weight (with BMI), blood type, conditions, medications, allergies and notes. Switch between people from the menu at the top.
- **Upload** lab report PDFs (text-based), CSV/JSON exports, DICOM files (`.dcm`) and scan photos. Files are read in the browser and every value is shown for review before it is saved. The original file is kept with the values read from it.
- **Body map**: the Visible Human female or male body (from the profile's sex; a profile can be shown with the other body on Profile), modelled structure by structure (see [Anatomy models](#anatomy-models)), including:
  - a heart with its four chambers, valves, papillary muscles, coronary arteries and cardiac veins
  - lungs in five lobes, with the bronchial tree
  - kidneys with cortex, medullary pyramids, calyces, pelvis and ureters
  - a brain in atlas regions, with ventricles, pituitary, spinal cord and eyes
  - the liver with its ligaments, hepatic and portal veins, gallbladder and bile ducts
  - a full skeleton with discs, cartilage and joints, the diaphragm, glands and reproductive organs

  Organs with results get a status dot. Open an organ to fly in, read labelled landmarks, switch to x-ray, or cut a cross-section (front, side or top).
- **Biomarkers**: latest value of each marker grouped by body system, with its position in the reference range and its trend over time.
- **Scans**: assign scans to body areas; view with zoom, and brightness/contrast for DICOM.
- **Files**: every original report and scan, with links to open, download or delete it.
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
git checkout claude/friendly-brahmagupta-vul203    # until the pull request is merged
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
| `/credits/` | `credits/index.html` | Credits and licences: the sources of the anatomy models, what we changed, how to reuse them (CC BY-SA 4.0), map data and fonts |
| `/app`, `/login`, `/signup` | `app.html` (entry `src/main.tsx`) | The app. `/signup` and `/login` open the auth screen in that mode; after sign-in the address becomes `/app` (views stay in the hash, e.g. `/app#markers`); signing out goes to `/login` |
| anything else | `404.html` | Not-found page, sent with a 404 status |

- **Shared pieces** live in `src/site/`: `site.css` (styles, using the app's colour tokens), `fonts.css` with self-hosted Newsreader and Hanken Grotesk (SIL OFL; no third-party requests), and HTML partials in `src/site/partials/` included with `<!-- @include header -->`.
- **Region tables** on the landing, Privacy and Trust pages are rendered at build time from `shared/regions.ts` with markers such as `<!-- @regions storage-table -->` (see `tools/site/regions.ts`), so the pages always match sign-up.
- **`SITE_URL`** (build-time, default `https://health.lotuspond.ai`) sets canonical and social URLs (`%SITE_URL%` in HTML), and the generated `robots.txt` and `sitemap.xml`. Build for another host with `SITE_URL=https://staging.example.com npm run build`.
- **Imagery**: `public/site/*.webp` are real screenshots of the app, and `public/site/og.png` (1200×630) is the social preview, rendered from `tools/site/og.html`. Regenerate both after visible app changes, with the dev stack running: `node tools/site/shots.mjs http://localhost:5173/`. Its demo profile is female, so the pictures show the female body; the body in them is CC BY-SA 4.0, credited in the footer of every page. The tool records the model it captured in `public/site/shots.json`, and `npm run test:anatomy` fails when the female model changes until the pictures are taken again.
- **Legal text** has placeholders in the form `[Legal entity name — to be completed by LotusPond]` for details only LotusPond can supply (entity, address, officers, contacts, periods). Search for `to be completed` before launch, and have each market's text reviewed.
- **Serving** (`server/src/app.ts`): pages get their own Content Security Policy (the website allows no WebAssembly and no inline styles; the app shell adds `'wasm-unsafe-eval'` for the model decoder), hashed files in `/assets/` are cached for a year as immutable, and the build writes `.br` and `.gz` copies of text files that the server sends when the browser accepts them. `vite` and `vite preview` follow the same routes (`tools/site/vite-plugin.ts`).

## Project layout

| Path | What it holds |
| --- | --- |
| `src/three/` | React Three Fiber stage: tissue materials, pond floor, camera, x-ray and cross-sections, adaptive quality |
| `src/components/bodymap2d/`, `public/bodymap/` | Pre-rendered body map (default view) and its images |
| `src/anatomy/` | `organs.ts`: organ text (names, summaries, facts, landmark notes), tissues and linked body systems; `bodies.ts` and `bodies/<body>.json`: each model's parts, landmarks and pins, written by the model build |
| `src/lib/` | Biomarker catalog, file parsers, the records store |
| `src/api/` | Data access: `http.ts` talks to the API, `browser.ts` keeps everything in IndexedDB for server-less previews |
| `src/state/` | Session (account, profiles, open profile), interface state, toasts |
| `src/pages/`, `src/components/` | Interface |
| `index.html`, `privacy/`, `terms/`, `trust/`, `credits/`, `404.html`, `src/site/` | Public website (see above); `app.html` is the app shell |
| `tools/site/` | Build plugin for the website, region tables, screenshot and social-image tool |
| `server/src/` | API: routes, auth, database schema, file storage, cells (`cells.ts`) and compliance records (`compliance/`: directory, consents, audit log, secrets) |
| `server/drizzle/` | SQL migrations (generate with `npm run db:generate` after changing `server/src/db/schema.ts`) |
| `shared/` | Types and limits used by both sides |
| `tools/anatomy/` | Builds `public/models/anatomy-female.glb` and `anatomy-male.glb` from pinned real-anatomy sources (see [Anatomy models](#anatomy-models)) |

## Anatomy models

There are two bodies, female and male. Each is the Visible Human body of the U.S. National Library of Medicine as modelled by the [HuBMAP Human Reference Atlas](https://humanatlas.io/3d-reference-library) (3D Reference Object Library v2.0, CC BY 4.0), with the structures the atlas lacks taken from [Z-Anatomy](https://github.com/LluisV/Z-Anatomy) (CC BY-SA 4.0, based on BodyParts3D) and fitted into that body: the skull and teeth, the ribs, sternum and discs, the bones of the arms, hands and feet, the stomach, oesophagus and diaphragm, the thyroid, parathyroid, pituitary and adrenal glands, the testes, the muscles of the female larynx, and the vessels of the head, neck and limbs. The models, and the body maps rendered from them, are shared under CC BY-SA 4.0: see `/credits/` and `public/models/LICENSE.txt`. The app shows the credit in the stage and on Account, because the iOS, Android and preview builds ship the models without the website.

The app picks the body from the profile's sex (`src/lib/body.ts`: female for Intersex or Not set), unless a body was chosen for that profile on Profile, which is kept on the device (`lotuspond.stage` in local storage).

### Rebuilding them

Requires git, Python 3 with NumPy, SciPy and py7zr, and Node. Everything downloaded or computed goes to `tools/anatomy/.cache/` (about 1 GB, not committed).

```bash
cd tools/anatomy
python3 fetch.py            # the sources pinned in sources.json (commits and SHA-256), about 170 MB each
node extract.mjs            # their meshes, in metres, into .cache/raw/
python3 fit/arms.py && python3 fit/skull.py && python3 fit/foot.py && python3 fit/ribcage.py && python3 fit/organs.py && python3 fit/repro.py && python3 fit/larynx.py
python3 fit/vessels.py      # last: it follows the arm, leg and head fits and clears the placed bones and organs
python3 assemble.py         # parts, landmarks and pins per body
node build.mjs              # public/models/anatomy-<body>.glb and src/anatomy/bodies/<body>.json
cd ../..
node tools/render-bodymap.mjs && npm run test:anatomy
```

- The fits take about two hours on a 4-core machine (the arms, skull, feet and organs about 20-30 minutes each).
- `catalog.py` lists the parts of each model (organ, tissue, triangle budget) and the structures used to register the two sources; `fit/CONTRACT.md` describes the fitting modules. Each fit writes `report.json` with its acceptance measurements (joint gaps, clearances, contacts, levels) and QA renders to `.cache/fit/<body>/<group>/`.
- `assemble.py` takes the atlas parts, rebuilds some organs as closed surfaces, adds the fitted structures and places the landmarks and pins; `build.mjs` simplifies each structure to its share of the part's budget and writes one glTF node per part, meshopt-compressed, with the credit in the file's metadata.
- The female Visible Human has six lumbar vertebrae (L1–L6), a normal variant, and the model keeps them.
- `npm run test:anatomy` checks that each model, its rig, the organ text and its body map agree, and fails when a body map is older than its model.

Model coordinates are metres with `+x` toward the person's left, `+y` up and `+z` toward the front, the soles at `y = 0`.

### Pre-rendered body map

The body map opens as images rendered ahead of time, so it needs no WebGL; "Explore in 3D" loads the interactive model on request. After changing a model or the look of the stage, render the images again (headless Chromium, several minutes per body) and commit `public/bodymap/` and `src/components/bodymap2d/manifest.<body>.json`. Each body has its own set, named with its letter (`f-…`, `m-…`) in one folder, and its own manifest, which records the model file and hash it was rendered from:

```bash
node tools/render-bodymap.mjs              # both bodies: 16 angles + a close-up per organ, two sizes, ID maps, manifests
node tools/render-bodymap.mjs --body=male  # one body
node tools/measure-bodymap.mjs http://localhost:8787/ --3d   # first-view downloads and 3D frame cost
```

## Server-less preview

`npm run build:artifact` writes `dist-artifact/`: the app alone (`vite build --mode artifact`, relative paths) built with `VITE_BACKEND=browser`, which keeps accounts, profiles, records and files in the visitor's browser (IndexedDB) instead of on a server. It is meant for static hosts such as a Claude artifact. Such hosts have no server routes and only pass a `#hash` into the page, so the preview's `index.html` is the app: it opens sign-in, or sign-up with `#signup`, and its links to the website (home, Privacy, Terms, Trust, Credits) open the live site in a new tab. The 3D models ship as base64 text (`models/anatomy-<body>.b64.txt`, each under the 16 MB text-file limit) for hosts that don't serve `.glb` files, and `index.html` is body-only. Check it locally with `npx vite preview --outDir dist-artifact` and the browser walk-through.
