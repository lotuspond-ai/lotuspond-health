# ABDM (Ayushman Bharat Digital Mission)

ABDM is India's health records network. A person's ABHA (health ID) links their records at hospitals and labs. With the person's consent, an app can fetch those records as FHIR R4 bundles in the national profiles published by NRCES. For LotusPond, this means records arrive without the person uploading anything, and agents get them through the same tools.

Status: **preparation.** The record format is supported now. The network connection waits on sandbox registration, which needs LotusPond's organisation details, and on the official sandbox documentation. ABDM's sites (sandbox.abdm.gov.in, sandboxcms.abdm.gov.in, the gateway) refuse connections from the cloud environment where this was built, so every endpoint detail below comes from secondary sources and has to be checked against the sandbox documentation before use.

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

## Which ABDM role

| Role | Milestones | What it lets LotusPond do |
| --- | --- | --- |
| **PHR app** | M1 (ABHA) + PHR services | The person creates or signs in with their ABHA, discovers and links records at providers, and approves consent requests. This is the role of a personal record app |
| HIU (Health Information User) | M1 + M3 | Request consent and fetch records from providers. Usually paired with PHR for a consumer app |
| HIP (Health Information Provider) | M1 + M2 | Share records LotusPond holds. Not needed: LotusPond doesn't create clinical records |

Recommended: register on the **PHR track**, and add HIU (M3) if the sandbox asks for it to fetch records. This is to be confirmed during registration.

## Registration (for the account holder)

These steps come from secondary sources, so check each one on the portal.

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

## To build once registered

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
