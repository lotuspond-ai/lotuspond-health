# The connector core

One description of every outside system LotusPond Health reaches: what it can do there, and on whose authority. LotusPond Health has two sides, and both are built on it, in this repository:

- **People and families.** A person connects their own sources (lab portals, ABHA, DigiLocker, wearables, email) and chooses which AI agents see what. Every connection runs on the **person's** authority.
- **Organisations** (healthcare startups, hospitals, clinics, insurers and other health-tech builders). An organisation reaches any portal or record system through one API and MCP server, instead of integrating with each one: hospital information systems and EMRs, and insurer and TPA portals. Every connection runs on the **organisation's** contracted or delegated access.

The code is in `server/src/connectors/`. It depends on nothing in the consumer app, so the organisation API can be served from it without touching people's records.

LotusPond Works is a separate product: automation of an organisation's administrative processes, not an API. A hospital may use Works to automate its administration; API access to health record systems is LotusPond Health. Works never hosts, proxies or calls this API, and this code is not shared with Works ([ADR-0001, decision 11](https://github.com/lotuspond-ai/lotuspond/blob/main/docs/architecture/0001-one-lotuspond-account.md)).

## Model

| | |
| --- | --- |
| **Connector** | One outside system (`apollo`, `abha`, `withings`; later a specific HIS or TPA). Has a category, data regions, how it is reached (`browser`, `api`, `abdm`), how people sign in, its operations, and whether this server can run it now. |
| **Authority** | `person` or `organisation`. Never mixed: an organisation's credential never reaches a person's own records, and a person's consent never lets an organisation act in their name. |
| **Operation** | A typed contract with FHIR R4 output, defined once for every connector that offers it. Writes carry an approval rule: none for reads, the person, or a clinician for clinical writes. |
| **Connection** | One person's or one organisation's link to a connector, with its sealed sign-in. Today these are the record agent's connections (`record_connections`). |

## Operations

| Operation | Authority | Writes | Approval | Stage |
| --- | --- | --- | --- | --- |
| `records.fetch` | person | no | none | live: every record agent source |
| `patients.search` | organisation | no | none | live: sandbox, FHIR R4 |
| `encounters.list` | organisation | no | none | live: sandbox, FHIR R4 |
| `documents.upload` | organisation | yes | clinician | live: sandbox, FHIR R4 |
| `claims.status` | organisation | no | none | live: sandbox only |
| `preauth.submit` | organisation | yes | clinician | planned |

Each operation is defined before its first adapter, so the docs, the API and the adapters agree on one contract. An adapter is built for a specific system only with written access authority and a pilot customer: no bypassing MFA, anti-bot controls or a vendor's terms.

## How records.fetch runs today

`connectorRegistry()` (in `registry.ts`) turns each source in `shared/sources.ts` into a connector and records how it runs on this server:

1. **The source's own API**, when it is set up here: ABHA through Eka, DigiLocker, Withings, Oura, Ultrahuman, Gmail, Outlook.
2. Otherwise, for a portal, **its recipe**: Apollo 24|7, Dr Lal, Thyrocare, Metropolis, or the demo lab.
3. Otherwise **Claude's navigator**, when it is on.

A portal the person names by address is offered only where `typedPortals` allows it (`docs/record-agent.md`, section 3). The record agent (`server/src/records/service.ts`) asks the registry instead of keeping its own lists.

## The public catalogue

`GET /v1/connectors` lists the operations and every connector, with whether this server runs it now. `?region=in` narrows the list to one data region. No sign-in is needed: it describes connectors, never connections, people or credentials. It answers with `Access-Control-Allow-Origin: *`, so documentation sites can read it. It is served even when the record agent is off, with every connector unavailable.

## The organisation API

Organisations reach hospital systems on their own authority, through `/v1` (REST) and `/v1/mcp` (MCP). The developer guide for outsiders is the site page `/developers/`; the console is `/developers/console/`.

- **Self-serve, sandbox first.** Anyone with a LotusPond account can make an organisation in the developer console (`/api/console`, `server/src/connectors/console-routes.ts`) and make API keys at once. A new organisation has `access = sandbox`: it reaches only LotusPond's sandbox hospital (`his/sandbox.ts`), with synthetic patients, visits, documents and claims.
- **Live access is given by LotusPond, not taken.** An organisation asks in the console (which hospital, which system). LotusPond checks the hospital's written authority and the data-processing agreement, then, on the server:

  ```bash
  npx tsx src/index.ts org:requests                       # who asked, for what
  npx tsx src/index.ts org:live <organisation id>
  ORG_CONNECTION_TOKEN=… npx tsx src/index.ts org:connect <organisation id> trakcare "City Hospital TrakCare" https://his.example.org/fhir/r4
  ORG_CONNECTION_CLIENT_ID=… ORG_CONNECTION_CLIENT_SECRET=… ORG_CONNECTION_SHARING_KEY=… npx tsx src/index.ts org:connect <organisation id> eka "Sunrise Clinic on Eka"
  ```

  Credentials come from the environment, never the command line: `ORG_CONNECTION_TOKEN`, or `ORG_CONNECTION_USER` and `ORG_CONNECTION_PASSWORD`, or for Eka Care an API client's `ORG_CONNECTION_CLIENT_ID` and `ORG_CONNECTION_CLIENT_SECRET` with the clinic's `ORG_CONNECTION_SHARING_KEY`. They are sealed with the region's file keys. An Eka connection reaches `https://api.eka.care` unless a base url is given (Eka's sandbox is `https://api.dev.eka.care`). Self-serve organisations can never point the server at an address of their choosing.
- **Keys.** Kept only as SHA-256 (`lpk_…`), each listing the operations it may call. Made with the console or `org:key`; revoked with the console or `org:revoke`.
- **Calls.**
  - `GET /v1/organisation`: who the key belongs to, its access and its operations.
  - `GET /v1/connections`: the sandbox and any real systems LotusPond added.
  - `POST /v1/operations/{id}` with `{ "connection": "…", …input }`: inputs are checked by `his/operations.ts` (the same schemas the MCP tools use). Reads answer `200 { status: "done", result }` with FHIR R4.
  - Writes that need a clinician (`documents.upload`) answer `202 { status: "pending_approval", approval }`. The input is sealed until someone in the organisation approves it in the console; then it is sent and the held copy is deleted. `GET /v1/approvals/{id}` reads the outcome.
- **Refusals.** `403 wrong_authority` (a person-only operation), `403 not_in_key`, `422 not_supported` (the connection's system does not run that operation; refused before anything is held), `403 not_live` (a live connection from a sandbox organisation), `400 invalid_input`, `404 connection_not_found`, `501 operation_not_offered` (`preauth.submit`). A hospital system's own failure is `502`, or `504` on a timeout, with a message that carries no patient data.
- **Audit.** Every call, allowed or refused, is recorded in `organisation_calls` with the key, the connection and the outcome, and shown in the console.

### Adapters

| Connector | Adapter | Status |
| --- | --- | --- |
| `sandbox` | `his/sandbox.ts`: synthetic data, uploads kept in memory per connection | Available |
| `fhir`, `bahmni`, `trakcare` | `his/fhir.ts`: FHIR R4 REST (Patient, Encounter, DocumentReference), bearer or Basic credentials, https only | Available on request |
| `eka` | `his/eka.ts`: Eka Care's published EMR APIs (patients by mobile, clinic patient id or Eka id; visits from appointments, with prescription PDFs), signed in with an Eka API client and the clinic's sharing key | Available on request (reads only) |
| Everything else in `shared/integrations.ts` | none: listed with an honest status and refused if called | In build or planned |

`shared/integrations.ts` is the single list of systems and their status. It feeds `GET /v1/connectors` (`systems`), the console, and the developers page (a test checks the page matches it). Add an adapter in `his/index.ts` only together with changing that system's status to available or on request.

## Which hospital systems to build for

India has no dominant HIS vendor. What the hospitals run decides where adapters pay off. This summary is from research done in November 2026: public sources, job postings, staff profiles and IPO filings. The evidence and sources are on the Notion page "EHR and HIS systems used by Indian hospitals".

**Read first through ABDM.** An ABDM health-information-user connection (milestone M3) reads consented records from any ABDM-certified system through one FHIR R4 contract. Medical colleges must integrate with ABDM (NMC, March 2026), and C-DAC e-Sushrut and NIC NextGen eHospital, the largest public installed base, are integrated. Neither the Manipal nor the Paras 2026 DRHP claims ABDM integration, so this path cannot be assumed to reach the large private chains. Writes and operations (`documents.upload`, `preauth.submit`) need an adapter per system.

**HIS adapters, in order of reach among private chains.** One HIS usually runs a chain's whole network, so one adapter reaches every hospital in it.

| HIS | Chains running it | Confidence |
| --- | --- | --- |
| Akhil Systems Miracle | Aster (India), Paras, probably CARE, possibly Yashoda | High for Aster; medium for the rest |
| InterSystems TrakCare (on IRIS) | Manipal, with Columbia Asia, AMRI, Medica and Sahyadri moving onto it; Sir Ganga Ram | High |
| KareXpert | Artemis, plus many mid-size hospitals (vendor claims 500+) | High for Artemis |
| Suvarna HIMS | Probably KIMS; NHCX-certified | Medium |
| Insta by Practo | Apollo Health & Lifestyle clinics, Motherhood, Cloudnine | Medium |
| Single-chain vendors | Napier (Jaslok), TrioTree HISTree (AIG), SanHar Mappingtag (Wockhardt), MyHealthcare (Sakra, probably) | Medium |

Chains with their own systems need one agreement each: Apollo (MedMantra), Narayana (Athma, also sold as SaaS), Max (VistA-derived), Fortis, CMC Vellore, Amrita and Tata Memorial. Epic and Oracle Health are not the primary EHR at any Indian chain found.

Akhil Miracle and TrakCare are the strongest first private-sector adapters. Each still needs a pilot customer with written access authority (see Operations).

## Next

1. ~~Organisations and API keys~~: done (above).
2. ~~Connections, running operations, approvals, the organisation MCP server and the developer console~~: done (above). Still to come: idempotency keys, asynchronous runs with webhooks, and inviting more members (approvers) to an organisation.
3. **First adapters, with a pilot.** Either EHR write-back for one AI-scribe customer across two authorised HIS vendors (Akhil Miracle and TrakCare first; see "Which hospital systems to build for"), or claims status and pre-authorisation for one hospital, preferring NHCX where the payer is on it (`docs/abdm.md`; the plan in Notion).
4. **LotusPond Link.** An organisation using the organisation API can ask a person to share records from their LotusPond Health account. The person approves in their consent centre and can revoke it there.
