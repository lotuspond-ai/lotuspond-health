# LotusPond Health

A personal health record. Create an account, keep a profile for yourself and each family member, upload lab reports and scans, and see every result on a detailed 3D model of the body, organ by organ. Results, scans and the original files are stored in your account.

## What it does

- **Accounts and profiles.** Sign up with email and password. One account holds your own profile plus any family members you add (children, partner, parents). Each profile keeps date of birth, sex, height, weight (with BMI), blood type, conditions, medications, allergies and notes. Switch between people from the menu at the top.
- **Upload** lab report PDFs (text-based), CSV/JSON exports, DICOM files (`.dcm`) and scan photos. Files are read in the browser and every value is shown for review before it is saved. The original file is kept with the values read from it.
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
- **Account**: change password, sign out other devices, export a profile as JSON, delete a profile or the whole account.

Reference ranges come from your report when it prints one; otherwise a typical adult range is used and labelled. LotusPond explains results; it does not diagnose.

## Stack

| Layer | Choice |
| --- | --- |
| Frontend | React 19, Vite, TypeScript, React Three Fiber, zustand |
| API | Node.js 22, [Hono](https://hono.dev), Zod validation (`server/`, an npm workspace) |
| Database | PostgreSQL via Drizzle ORM. Without `DATABASE_URL` the server uses embedded [PGlite](https://pglite.dev) (Postgres in WebAssembly), so development needs no database install |
| Sign-in | Email and password hashed with Argon2id; server-side sessions in an HttpOnly, SameSite=Lax cookie |
| Files | Disk storage behind a small `FileStore` interface (`server/src/lib/files.ts`); swap in object storage for multi-server deployments |

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
| `POSTGRES_PASSWORD=pick-one docker compose up --build` | Production image with a real PostgreSQL, on http://localhost:8787 | Docker volumes |

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

## Production

```bash
npm run build      # frontend to dist/, server bundle to server/dist/
npm start          # serves the API and the app on :8787
```

Or with Docker (PostgreSQL included):

```bash
POSTGRES_PASSWORD=choose-a-password docker compose up --build
```

Run it behind HTTPS (a reverse proxy or your platform's load balancer) and set:

- `COOKIE_SECURE=true` (the default when `NODE_ENV=production`; set `false` only for plain http on localhost)
- `TRUST_PROXY=true` so rate limits see real client addresses
- `DATA_DIR` on persistent storage; uploaded originals are kept there

All settings are listed in `server/.env.example`. Any host that runs a Node.js container works (Render, Fly.io, Railway, a VM); pair it with managed PostgreSQL.

### Security notes

- Every request for a profile's data checks that the profile belongs to the signed-in account.
- Session tokens are random 256-bit values; the database stores only their SHA-256.
- Sign-in and sign-up are rate-limited per address and per email (in memory, so per server process).
- Changes must come from the app's own origin (checked with `Sec-Fetch-Site` / `Origin`).
- Uploaded files are served with `X-Content-Type-Options: nosniff` and a sandboxing CSP; types a browser could run (HTML, SVG) are only ever sent as downloads.
- The app is served with a strict Content Security Policy.
- Health data deserves encrypted storage: use a database and disk with encryption at rest, and HTTPS everywhere.

## API

All routes are under `/api` and use JSON unless noted.

| Method and path | What it does |
| --- | --- |
| `POST /auth/register`, `POST /auth/login`, `POST /auth/logout` | Create an account (with its own profile), sign in, sign out |
| `GET /auth/me` | The signed-in account and its profiles, or `null` |
| `POST /auth/password`, `DELETE /auth/sessions`, `DELETE /auth/account` | Change password, sign out other devices, delete the account |
| `GET`, `POST /profiles` | List or add profiles |
| `GET`, `PATCH`, `DELETE /profiles/:id` | Read, update or remove a profile |
| `GET`, `DELETE /profiles/:id/records` | Everything stored for a profile, or delete it all |
| `GET /profiles/:id/export` | JSON export (re-importable through the upload dialog) |
| `POST /profiles/:id/measurements`, `PATCH`/`DELETE …/measurements/:mid` | Save, edit or delete results |
| `POST /profiles/:id/documents` (multipart), `GET …/documents/:did/file`, `DELETE …/documents/:did` | Store, fetch or delete original files |
| `POST /profiles/:id/scans`, `PATCH`/`DELETE …/scans/:sid` | Save, edit or delete scans |

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
| `src/three/` | React Three Fiber stage: tissue materials, pond floor, camera, x-ray and cross-sections |
| `src/anatomy/organs.ts` | Organ metadata: meshes, tissues, landmarks, linked body systems |
| `src/lib/` | Biomarker catalog, file parsers, the records store |
| `src/api/` | Data access: `http.ts` talks to the API, `browser.ts` keeps everything in IndexedDB for server-less previews |
| `src/state/` | Session (account, profiles, open profile), interface state, toasts |
| `src/pages/`, `src/components/` | Interface |
| `index.html`, `privacy/`, `terms/`, `trust/`, `404.html`, `src/site/` | Public website (see above); `app.html` is the app shell |
| `tools/site/` | Build plugin for the website, region tables, screenshot and social-image tool |
| `server/src/` | API: routes, auth, database schema, file storage |
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

## Server-less preview

`npm run build:artifact` writes `dist-artifact/`: the app alone (`vite build --mode artifact`, relative paths) built with `VITE_BACKEND=browser`, which keeps accounts, profiles, records and files in the visitor's browser (IndexedDB) instead of on a server. It is meant for static hosts such as a Claude artifact. Such hosts have no server routes and only pass a `#hash` into the page, so the preview's `index.html` is the app: it opens sign-in, or sign-up with `#signup`, and its links to the website (home, Privacy, Terms, Trust) open the live site in a new tab. The 3D model ships as base64 text (`models/anatomy.b64.txt`) for hosts that don't serve `.glb` files, and `index.html` is body-only. Check it locally with `npx vite preview --outDir dist-artifact` and the browser walk-through.
