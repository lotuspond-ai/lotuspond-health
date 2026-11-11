# ABDM (Ayushman Bharat Digital Mission)

ABDM is India's health records network. A person's ABHA (health ID) links their records at hospitals and labs. With the person's consent, an app can fetch those records as FHIR R4 bundles in the national profiles published by NRCES. For LotusPond, this means records arrive without the person uploading anything, and agents get them through the same tools.

Status: **built through Eka Care, waiting on onboarding.** LotusPond reaches ABDM through [Eka Care's ABDM Connect](https://developer.eka.care/docs/hie-cm/about), which holds the gateway connection, its callbacks and the encryption, so LotusPond does not need its own gateway client. The ABHA source in the record agent (`server/src/records/abdm/`) signs the person in, asks for their consent, and saves the records as FHIR files for review. It is tested against a copy of Eka's API. The Eka client login was checked live on 11 November 2026; the ABHA steps were not, because they need LotusPond's ABDM Connect onboarding (below) and a real ABHA.

## Built: reading ABDM-format records

`src/lib/parse/fhir.ts` reads FHIR R4 lab content: a Bundle (document, collection, searchset), a DiagnosticReport or a single Observation. It is the format of ABDM's DiagnosticReportRecord: a document Bundle with a Composition, the Patient, DiagnosticReports and Observations. The same reader will handle records fetched over ABDM. Today it already reads files exported from ABHA apps and hospital portals, through the normal upload and review.

- **Matching.** A LOINC code picks the catalogue marker (102 of 104 markers have one). Otherwise the name is matched, as for any report.
- **Values.**
  - `valueQuantity`, keeping a comparator such as `<8`;
  - `valueString`, `valueInteger`, `valueBoolean`;
  - `valueCodeableConcept`, such as "Negative".
- **Units.** When `unit` is missing, the UCUM code is used and shown as a person writes it: `10*3/uL` becomes 10^3/µL, `u[IU]/mL` becomes µIU/mL, `mm[Hg]` becomes mmHg. Unit conversion then works as for a PDF.
- **Ranges and flags.**
  - `referenceRange` low, high and text, kept as the report's own range;
  - `interpretation` H, HH, L and LL, used as flags.
- **Panels.** Components become results, so a blood pressure panel (85354-9) gives systolic and diastolic. A panel with no value of its own adds no row.
- **Status.**
  - `entered-in-error` and `cancelled` are left out, with a note.
  - `preliminary` and `registered` results are marked *Check*.
- **Reports as PDFs.** Many ABDM records carry the report only as a PDF, in `DiagnosticReport.presentedForm` or a `DocumentReference`. Up to 10 such PDFs per file are decoded and read with the PDF reader. The bundle is kept as the original file.
- **Whose record.** The review names the patient in the record ("These results are for Asha Rao"), so it goes on the right family profile.
- **Tests.**
  - `tools/test-parsers.mjs`, section *fhir*, with two synthetic fixtures in `tools/fixtures/fhir/`: a coded bundle modelled on DiagnosticReportRecord, and a bundle with only a PDF.
  - Checked in a browser: 11 results from the first fixture, and 26 from the PDF inside the second.

## Built: ABHA through Eka Care

The ABHA source runs in the record agent (docs/record-agent.md), with an API client instead of a browser. It uses the agent's questions, sealed sign-in, schedule and review. Code: `server/src/records/abdm/` (`eka.ts` is the client, `abha.ts` the steps, `webhook.ts` the webhook). Tests: `server/test/abha.test.ts`.

1. **Sign in.** The person types an ABHA address (`name@abdm`), a 14-digit ABHA number or a mobile number. Aadhaar numbers are not used. Then:
   - `POST /abdm/na/v1/profile/login/init`, then the OTP to `login/verify` (a wrong code is asked once more);
   - when a mobile number has several ABHA addresses, the person picks one and LotusPond calls `login/phr`.
   - The result is Eka's id for the person (`oid`) and their ABHA address. Both are sealed on the connection. A hash of the `oid` is kept so webhooks can find the connection.
2. **Gateway session.** Eka holds the person's ABHA session with ABDM. LotusPond checks it (`GET /abdm/v1/session/status`) and, when it has ended or a call answers 491, renews it with an OTP (`session/init`, then `verify`). A scheduled run never asks: the connection waits for the person ("sign in again").
3. **Records.** LotusPond lists the facilities that linked records to the ABHA (`care-contexts/providers`), and each one's records (`care-contexts/linked`).
4. **Consent.** Records with no consent get one request from LotusPond (`POST /abdm/v1/consents/create`): purpose *Self Requested*, every record type, from 1990 to today, valid for a year. The request lands in the person's own consent inbox. LotusPond finds it, asks for the person's **ABHA consent PIN** (`consents/pin/verify`; never stored), and approves it with one artefact per facility (`consents/approve`, access mode *view*). If there is no PIN, or the request is not in the inbox, the person approves it in their ABHA app and the next check picks the records up.
5. **Fetch.** Eka fetches the data from the facilities. The run waits up to two minutes, then reads each record Eka holds (`DataReceived` or `DataProcessed`) with `GET /health/api/v1/fhir/retrieve?identifier=<care context>`. Each record is saved once as a FHIR JSON file (`<facility> <record>.json`), and reviewed with the reader above. Records still on their way leave a note on the run.
6. **Webhooks** at `POST /hooks/eka`, served when `EKA_WEBHOOK_SIGNING_KEY` is set.
   - The signature (`Eka-Webhook-Signature: t=…,v1=…`, HMAC-SHA256 over `t.rawBody`) is checked within 180 seconds, and repeats are ignored.
   - `abha.subscription_notify`, `abha.hiu_data_push`, `abha.subscription_modified`, and `abha.consent_update` when granted, start a scheduled check of that person's connection.
   - Eka's sample `abha.consent_update` carries no `oid`, so a grant made in the ABHA app may only be picked up on the next scheduled check.

Configuration (`server/.env.example`): `EKA_CLIENT_ID`, `EKA_CLIENT_SECRET`, `EKA_API_URL` (`https://api.dev.eka.care` for the sandbox; the default is production), `EKA_HIU_CLINIC_ID` and `EKA_HIU_DOCTOR_OID` (without them no consent is raised, and only records already with Eka are read), and `EKA_WEBHOOK_SIGNING_KEY`. Keep the secret and the signing key in the secret store.

### Account and onboarding (11 November 2026)

- **Done:** an Eka developer workspace, *LotusPond Health* (data in India), and an API credential, *LotusPond Health development*. Its id and secret are kept outside the repo. Production login (`api.eka.care`) returns a token.
- **Next: ABDM Connect onboarding** (console.eka.care → ABDM Connect → Onboard new client). This registers LotusPond with NHA, in the **sandbox** or **production**. It asks for:
  - company details: organisation name, website and type (HMIS, LIMS, EMR, diagnostic lab, pharmacy chain, hospital chain, hospital or clinic, telemedicine; there is no PHR type);
  - a primary contact;
  - then an integration method, credential setup, linked facilities, and a review.
  
  This is a decision for LotusPond's account holder. Start in the sandbox.
- **Then ask Eka (ekaconnect@eka.care):**
  - which `clinic_id` and `d_oid` a PHR app with no clinic uses for its consent requests;
  - whether LotusPond needs its own ABDM PHR certification;
  - whether data is "Eka stores" (assumed here) or "you store" (encrypted pushes);
  - the webhook registration for `abha.*` events, and the signing key;
  - pricing.

### Open questions to check on the sandbox

- Whether `login/verify` opens the gateway session, or the extra session OTP is always needed. Today LotusPond checks the status first and asks only when the session has ended.
- The wrong-OTP and wrong-PIN error codes. Today any refusal below 500 is asked once more; ABDM-1100 (too many OTPs) and ABDM-1027 (blocked) are not.
- Whether a consent LotusPond raises lands in the person's own inbox so it can be approved here, and what `hiu` it shows.
- How the care context status reads before any consent (assumed empty).

## Which ABDM role

| Role | Milestones | What it lets LotusPond do |
| --- | --- | --- |
| **PHR app** | M1 (ABHA) + PHR services | The person creates or signs in with their ABHA, discovers and links records at providers, and approves consent requests. This is the role of a personal record app |
| HIU (Health Information User) | M1 + M3 | Request consent and fetch records from providers. Usually paired with PHR for a consumer app |
| HIP (Health Information Provider) | M1 + M2 | Share records LotusPond holds. Not needed: LotusPond doesn't create clinical records |

Recommended: register on the **PHR track**, and add HIU (M3) if the sandbox asks for it to fetch records. This is to be confirmed during registration.

## Registering directly with ABDM (the alternative to Eka)

Only if LotusPond later connects to the gateway itself instead of through Eka. These steps come from secondary sources, so check each one on the portal.

1. **Register** the organisation on the ABDM sandbox (sandbox.abdm.gov.in). Choose the PHR track; you get a sandbox client ID and secret. Store them only as server secrets (`ABDM_CLIENT_ID`, `ABDM_CLIENT_SECRET`), never in the repo.
2. **Register callback URLs.** The gateway calls the app back, so it needs a public HTTPS address on the India cell (`https://in.<server>/api/abdm/...`).
3. **Build M1:**
   - ABHA creation and verification (Aadhaar OTP, mobile OTP, ABHA address);
   - linking the ABHA to a LotusPond profile, one ABHA per profile, which suits family profiles.
4. **Build the PHR and M3 flows:**
   - discover and link care contexts;
   - consent requests and the person's approval;
   - the encrypted data push to LotusPond's endpoint, which arrives as FHIR bundles read by `fhir.ts`.
5. **Pass NHA's functional test cases** for each milestone in the sandbox.
6. **Security audit (WASA)** by a CERT-In empanelled auditor. Some sources say the website and each app are audited separately. Then a Safe-to-Host certificate.
7. **Sandbox exit** application and demo, then production credentials.

Vendor estimates for effort are 2–4 weeks for M1 and 6–12 weeks for M3, but these are unofficial.

## To build if registering directly

- **Gateway client** (`server/src/abdm/`):
  - a session token (client credentials) cached until it expires;
  - the request headers the gateway requires (request id, timestamp, CM id);
  - the callback routes, checked against the gateway's signature.
- **ABHA in the app:** link an ABHA to a profile, show it, unlink it; one consent record per link (a new `abdm_link` consent kind).
- **Consent:** show each consent request (who, what types, date range, expiry), approve or deny in the app, and let the person revoke it. Every request and fetch goes in Recent activity.
- **Data push:**
  - decrypt the HIP's push (ABDM's "Fidelius" scheme: an X25519 key exchange with AES-GCM keyed from both nonces, to be checked against the official spec);
  - read each bundle with `fhir.ts`;
  - put the results into the review, as for an upload;
  - store the bundle as the original file.
- **Data residency:** all of this runs in the India cell, and records never leave it.
- **Privacy policy and the legal brief:** ABDM's own rules (Health Data Management Policy), consent artefacts, and retention of fetched records.

## Sources

Secondary, because the official portal could not be reached from the build environment:

- Milestones and the PHR track: [nirmitee.io guide](https://nirmitee.io/blog/abdm-integration-milestones-m1-m2-m3-m4-multi-software-guide/), [verticomply](https://verticomply.com/blog/abdm-m1-m2-m3-integration-guide).
- v3 endpoints: [nirmitee.io v3 migration](https://nirmitee.io/blog/abdm-v3-api-migration-guide-everything-that-changed/), [AIAnytime/abha-bridge-console](https://github.com/AIAnytime/abha-bridge-console).
- Certification: [nirmitee.io certification](https://nirmitee.io/blog/abdm-certification-process-sandbox-to-production-guide/), [isecurion WASA guide](https://isecurion.com/abdm-wasa-testing-complete-guide.html).
- Official M3 document (v2.5, March 2025): sandboxcms.abdm.gov.in, not reachable from here.
