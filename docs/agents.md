# Connected agents

LotusPond Health is a remote [MCP](https://modelcontextprotocol.io) server. Any agent that can add a remote MCP connector (Claude, ChatGPT, Claude Code, Cursor, VS Code, Gemini CLI, your own) can read a person's health records through it, once the person allows that agent. The code is in `server/src/agents/`, the shared types are in `shared/agents.ts`, and the Account panel is `src/components/AgentConnections.tsx`.

## Connecting

There is one address for every agent: `https://<server>/mcp` (the `PUBLIC_URL` setting decides `<server>`; without it, the request's host is used).

| Agent | How |
| --- | --- |
| Claude (web, desktop, mobile) | Settings → Connectors → Add custom connector → paste the address. Claude registers itself, opens the LotusPond sign-in, and the person chooses profiles and permissions. |
| ChatGPT | Settings → Apps & connectors → developer mode → Create → paste the address, authentication OAuth. Which ChatGPT plans offer this is OpenAI's choice. |
| Claude Code | `claude mcp add --transport http lotuspond https://<server>/mcp`, then `/mcp` to sign in. |
| Cursor, VS Code, other MCP clients | Add a remote (HTTP / Streamable HTTP) server with the address. |
| Agents without OAuth | Account → Connected agents → Create an access token. Send it as `Authorization: Bearer lpt_…`. The panel shows a ready-made `mcpServers` JSON block. |

On Account, each connection shows who it can see, what it may do and when it was last used, with a Disconnect button that stops it at once. Recent activity records each connection, disconnection and write, and a read at most once an hour per connection.

## Tools

| Tool | Permission | What it returns or does |
| --- | --- | --- |
| `list_profiles` | read | The profiles shared with this connection: id, name, relationship, age, sex |
| `get_health_summary` | read | The synthesis (see below). The suggested first call |
| `get_profile_details` | read | Date of birth, height, weight, BMI, blood type, conditions, medications, allergies, notes |
| `get_results` | read | Latest value of each marker, with its LOINC code, range, trend and direction; filter by body system, out-of-range only, or since a date |
| `get_marker_history` | read | Every result of one marker (catalogue id, common name or the name on the report) |
| `list_files` | read | Scans (modality, body area, date) and files (name, type, date). Never file contents or images |
| `find_lab_tests` | read, lab booking on | Home-collection tests and prices at a pincode |
| `list_lab_orders` | read, lab booking on | A profile's bookings and their status |
| `propose_lab_booking` | read, lab booking on | Checks the tests are offered and returns a link (`/app?book=…&profile=…&pincode=…#labs`). The person reviews it, picks a visit and confirms in the app. Nothing is booked or paid by the agent |
| `log_reading` | write | Saves a value the person stated, such as glucose or weight, marked "Added by <agent>" |
| `add_to_profile` | write | Appends conditions, medications or allergies. It never removes; duplicates are skipped |

Every tool takes an optional `profile_id`. Without one, it uses the account holder's profile if shared, or the only profile shared. Tool results are JSON, in `structuredContent` and as text.

### The health summary (`synthesis.ts`)

The summary is arithmetic on the person's own results, so every line can be explained:

- **Out of range:** the latest result is above or below its range. The range comes from the report, or the catalogue's typical adult range, and is labelled as such.
- **Trend:** the change since the previous result, relative to the range width. Under 5% counts as steady.
- **Direction:** whether the latest result moved toward its range, away from it, or stayed inside.
- **Follow-ups:**
  - out-of-range results older than three months;
  - results moving away from range;
  - tests that the profile's conditions usually keep an eye on, when one is missing or older than its usual interval. For example, HbA1c every 6 months with diabetes, TSH yearly with a thyroid condition.

  Each follow-up is a suggestion to ask a clinician, never a treatment.
- **By system:** marker and out-of-range counts per body system.

Every response carries the disclaimer that this is information to discuss with a clinician, not a diagnosis.

## Protocol and security

- **Transport.** Stateless Streamable HTTP: `POST /mcp` with one JSON-RPC message, answered with JSON. Protocol versions 2025-11-25, 2025-06-18 and 2025-03-26 (batches accepted). `GET` returns 405, since there are no server-initiated messages. Calls are limited to 120 per connection per minute.
- **Authorization** ([MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), OAuth 2.1):
  - **Discovery.** A call without a token gets `401` with `WWW-Authenticate: Bearer resource_metadata=…`. That leads to the protected-resource metadata (RFC 9728), then to the authorization-server metadata (RFC 8414).
  - **Clients** are public only, and PKCE S256 is required. A client identifies itself in one of two ways: dynamic registration (`POST /oauth/register`, RFC 7591; ids `lpcl_…`), or a client ID metadata document. In the second case the `client_id` is an https URL, fetched with no redirects, a 5 s timeout, 16 KB maximum, and refused when the host resolves to a private address.
  - **Redirect URIs** may be https, http on loopback only (any port, RFC 8252), or an app scheme. They must match the registration exactly.
  - **Consent page** (`GET /oauth/authorize`). It is served by the API, using the person's session cookie; signed out, it goes through `/login?next=…` and back. It names the agent, where it returns to, the profiles and the permissions. Read is always granted; write is optional. The form carries an HMAC bound to the session and request, and refuses cross-site posts. It cannot be framed.
  - **Tokens.** Secrets are random and carry their kind and the account's region (`lpc_in.…` code, `lpa_…` access, `lpr_…` refresh, `lpt_…` made on Account), so each request goes straight to the account's cell. Only SHA-256 digests are stored.
    - Codes last 5 minutes and work once.
    - Access tokens last 1 hour.
    - Refresh tokens last 90 days and rotate on every use.
    - Tokens are bound to the `/mcp` resource (RFC 8707).
  - **Disconnecting** deletes the grant and all of its tokens. Revoking one token works too (`POST /oauth/revoke`, RFC 7009).
- **Consent records.** Allowing a connection, changing its profiles or permissions, and disconnecting each add an `agent_sharing` consent record: text version, agent name, profiles, permissions, time and country. Account shows them in the consent history. Adding a family member records a `family_profile` consent with what the account holder confirmed (parent or guardian for a child or anyone under 18; the person's agreement for an adult; `shared/family.ts`).
- **Data residency.** Grants and tokens live in the account's cell like everything else personal; only registered client names and redirect URIs are in the default database.
- **Minimum necessary.** Agents see only the profiles shared with them and only summary data: no files, scan images, email address, contact details or lab booking addresses. Write tools only add.
- **Prompt injection.** Test names and notes come from uploaded documents. The server instructions and tool descriptions tell agents to treat them as data, and no tool sends anything to a third party.

## Not built yet

- Wearable APIs (Oura, Fitbit, Garmin) and ABHA/ABDM records as sources. Readings from Apple Health and Health Connect come in through the apps ([health-import.md](health-import.md)) and reach agents as ordinary results.
- Per-connection limits by data category (for example results but not medications) and expiry for OAuth connections.
- Notifications to the person when an agent writes, and a weekly digest of agent activity.
- A listing in the agent directories (Claude connector directory, ChatGPT apps) once the policy and legal review is done.
