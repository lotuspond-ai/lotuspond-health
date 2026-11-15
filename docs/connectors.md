# The connector core

One description of every outside system LotusPond Health reaches: what it can do there, and on whose authority. LotusPond Health has two sides, and both are built on it, in this repository:

- **People and families.** A person connects their own sources (lab portals, ABHA, DigiLocker, wearables, email) and chooses which AI agents see what. Every connection runs on the **person's** authority.
- **Organisations** (healthcare startups, hospitals, clinics, insurers and other health-tech builders). An organisation reaches any portal or record system through one API and MCP server, instead of integrating with each one: hospital information systems and EMRs, and insurer and TPA portals. Every connection runs on the **organisation's** contracted or delegated access.

The code is in `server/src/connectors/`. It depends on nothing in the consumer app, so the organisation API can be served from it without touching people's records.

LotusPond Works is a separate product: automation of an organisation's administrative processes, not an API. A hospital may use Works to automate its administration; API access to health record systems is LotusPond Health. Works never hosts, proxies or calls this API, and this code is not shared with Works ([ADR-0018, decision 11](https://github.com/lotuspond-ai/lotuspond/blob/main/docs/architecture/0018-one-lotuspond-account.md)).

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
| `patients.search` | organisation | no | none | planned |
| `encounters.list` | organisation | no | none | planned |
| `documents.upload` | organisation | yes | clinician | planned |
| `claims.status` | organisation | no | none | planned |
| `preauth.submit` | organisation | yes | clinician | planned |

The planned operations are defined before their first adapter, so the docs, the API and the adapters agree on one contract. An adapter is built for a specific system only with written access authority and a pilot customer: no bypassing MFA, anti-bot controls or a vendor's terms.

## How records.fetch runs today

`connectorRegistry()` (in `registry.ts`) turns each source in `shared/sources.ts` into a connector and records how it runs on this server:

1. **The source's own API**, when it is set up here: ABHA through Eka, DigiLocker, Withings, Oura, Ultrahuman, Gmail, Outlook.
2. Otherwise, for a portal, **its recipe**: Apollo 24|7, Dr Lal, Thyrocare, Metropolis, or the demo lab.
3. Otherwise **Claude's navigator**, when it is on.

A portal the person names by address is offered only where `typedPortals` allows it (`docs/record-agent.md`, section 3). The record agent (`server/src/records/service.ts`) asks the registry instead of keeping its own lists.

## The public catalogue

`GET /v1/connectors` lists the operations and every connector, with whether this server runs it now. `?region=in` narrows the list to one data region. No sign-in is needed: it describes connectors, never connections, people or credentials. It answers with `Access-Control-Allow-Origin: *`, so documentation sites can read it. It is served even when the record agent is off, with every connector unavailable.

## The organisation API

The organisation side of LotusPond Health is in place, with no organisation operation live yet:

- **Organisations and keys** live in the default database (`organisations`, `organisation_keys`, migration `0014`), never in a person's cell. A key looks like `lpk_…`. Only its SHA-256 is stored, and the key itself is shown once. Each key lists the operations it may call, and only organisation operations can be given.
- **Making them**, on the server (the production image has the same commands, `node dist/index.js …`):

  ```bash
  npx tsx src/index.ts org:create "City Hospital" in
  npx tsx src/index.ts org:key <organisation id> "Pilot" claims.status,preauth.submit   # or: all
  npx tsx src/index.ts org:revoke <key id>
  ```

- **Calls.** Every call sends `Authorization: Bearer lpk_…`, with no cookies or browsers involved.
  - `GET /v1/organisation`: who the key belongs to, and which operations it may call.
  - `POST /v1/operations/{id}`: run an operation.
- **Refusals.**
  - An operation that runs only on a person's authority answers `403 wrong_authority`; `records.fetch` belongs to LotusPond Health.
  - One outside the key's list answers `403 not_in_key`.
  - A planned operation answers `501 operation_not_offered` until its first adapter is live.
- **Audit.** Every call, allowed or refused, is recorded in `organisation_calls` with the organisation, the key, the operation and the outcome.

## Next

1. ~~Organisations and API keys~~: done (above).
2. **Connections and running operations.** `/v1/connections` holds an organisation's links to its systems, with sealed credentials and health status. Operations become idempotent and asynchronous, with webhooks, and writes go through an approvals queue. The same operations are served as MCP tools for organisations' agents.
3. **First adapters, with a pilot.** Either EHR write-back for one AI-scribe customer across two authorised HIS vendors, or claims status and pre-authorisation for one hospital, preferring NHCX where the payer is on it (`docs/abdm.md`; the plan in Notion).
4. **LotusPond Link.** An organisation using the organisation API can ask a person to share records from their LotusPond Health account. The person approves in their consent centre and can revoke it there.
