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

On Account, each connection shows who it can see, which kinds of data, what it may do, when it was last used and when it expires. *Change* edits all of these, and *Disconnect* stops the connection at once. Recent activity records each connection, disconnection and write, and a read at most once an hour per connection.

## Tools

| Tool | Permission | Kind of data | What it returns or does |
| --- | --- | --- | --- |
| `list_profiles` | read | basics | The profiles shared with this connection: id, name, relationship, age, sex |
| `get_health_summary` | read | basics, plus what is shared | The synthesis (see below). The suggested first call |
| `get_profile_details` | read | basics, plus conditions and labs when shared | Date of birth, height, weight, BMI, blood type; conditions, medications, allergies and notes (conditions); the home area (labs) |
| `get_results` | read | results | Latest value of each marker, with its LOINC code, range, trend and direction; filter by body system, out-of-range only, or since a date |
| `get_marker_history` | read | results | Every result of one marker (catalogue id, common name or the name on the report) |
| `list_files` | read | files | Scans (modality, body area, date) and files (name, type, date). Never file contents or images |
| `find_lab_tests` | read, lab booking on | labs | Home-collection tests and prices at a pincode |
| `list_lab_orders` | read, lab booking on | labs | A profile's bookings and their status |
| `propose_lab_booking` | read, lab booking on | labs | Checks the tests are offered and returns a link (`/app?book=…&profile=…&pincode=…#labs`). The person reviews it, picks a visit and confirms in the app. Nothing is booked or paid by the agent |
| `log_reading` | write | results | Saves a value the person stated, such as glucose or weight, marked "Added by <agent>" |
| `add_to_profile` | write | conditions | Appends conditions, medications or allergies. It never removes; duplicates are skipped |

### Kinds of data and expiry

Each connection shares the **basics** of its profiles: name, relationship, age, sex, height, weight, BMI and blood type. On top of that, the person ticks which kinds of data it may see (`AgentCategory` in `shared/agents.ts`):

- **results:** lab results and readings;
- **conditions:** conditions, medications, allergies and profile notes;
- **files:** the list of scans and files;
- **labs:** home lab tests, bookings and the home area.

A tool whose kind isn't shared is not listed and can't be called. The summary leaves those fields out and names them in `notShared`, so the agent can say what it can't see instead of guessing. Follow-ups based on conditions need both conditions and results, because they would reveal the condition. The server instructions list what the connection shares.

- **Choosing.** The consent page shows every kind ticked, the person's earlier choice when they reconnect, and *Keep connected for*: 30 days, 90 days, a year (the default) or until disconnected. Tokens made on Account offer the same choices, plus 7 days.
- **Changing.** On Account, *Change* edits the profiles, the kinds of data, the write permission and the expiry of any connection. Changes apply to the agent's next request, because every call re-reads the grant.
- **Expiry.** When a connection expires, its grant and all its tokens are deleted on the next use or the hourly purge.
- **Older connections.** Connections made before kinds of data existed (`categories` is null) share every kind, as their consent page said. A consent page rendered before the change, and posted after it, does the same. The page carries a `categories_shown` marker, so a form without it is recognised as an older page.
- **Consent records.** The `agent_sharing` record now also stores the kinds of data and the expiry.

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

## Notifications of what agents add

Every time an agent adds something, the person is told in the app:
- `log_reading` reports the reading;
- `add_to_profile` reports only the entries that were new, since duplicates are skipped.

Code: `server/src/notifications.ts`, `server/src/routes/notifications.ts`, `shared/notifications.ts`, and `src/components/Notifications.tsx`.

- **The bell.** It sits in the top bar and shows the number of new notifications. Opening it lists the latest 50, for example "Claude added a reading: Systolic blood pressure 138 mmHg (10 Nov) to your records.", and marks them read.
  - The app checks every minute while it is in view, and at once when it comes back into view.
  - Something that arrives while the app is open also shows as a toast.
  - The preview has no agents, so it shows no bell.
- **Undo.** Each notification has *Undo*:
  - for a reading, it deletes that reading;
  - for profile entries, it takes the agent's entries off the lists and keeps anything the person added or changed since.

  Undoing twice changes nothing. Each undo adds an `agent_write_undone` event to Recent activity. *Manage connected agents* opens Account.
- **API:**
  - `GET /api/notifications` returns `{ unread, items }`;
  - `POST /api/notifications/read` takes `{ ids? }`, or marks all as read;
  - `POST /api/notifications/:id/undo` returns the notification, whether anything was removed, and the profile as it now is.
- **Storage.** Notifications are kept in the account's data region (the `notifications` table), for 180 days. They are deleted with their profile or the account, and they outlive a disconnected agent, so its additions can still be undone.

## Protocol and security

- **Transport.** Stateless Streamable HTTP: `POST /mcp` with one JSON-RPC message, answered with JSON. Protocol versions 2025-11-25, 2025-06-18 and 2025-03-26 (batches accepted). `GET` returns 405, since there are no server-initiated messages. Calls are limited to 120 per connection per minute.
- **Authorization** ([MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), OAuth 2.1):
  - **Discovery.** A call without a token gets `401` with `WWW-Authenticate: Bearer resource_metadata=…`. That leads to the protected-resource metadata (RFC 9728), then to the authorization-server metadata (RFC 8414).
  - **Clients** are public only, and PKCE S256 is required. A client identifies itself in one of two ways: dynamic registration (`POST /oauth/register`, RFC 7591; ids `lpcl_…`), or a client ID metadata document. In the second case the `client_id` is an https URL, fetched with no redirects, a 5 s timeout, 16 KB maximum, and refused when the host resolves to a private address.
  - **Redirect URIs** may be https, http on loopback only (any port, RFC 8252), or an app scheme. They must match the registration exactly.
  - **Consent page** (`GET /oauth/authorize`). It is served by the API, using the person's session cookie; signed out, it goes through `/login?next=…` and back. It names the agent and where it returns to, then offers the profiles, the kinds of data, the permissions and how long to stay connected. Read is always granted; write is optional. The form carries an HMAC bound to the session and request, and refuses cross-site posts. It cannot be framed.
  - **Tokens.** Secrets are random and carry their kind and the account's region (`lpc_in.…` code, `lpa_…` access, `lpr_…` refresh, `lpt_…` made on Account), so each request goes straight to the account's cell. Only SHA-256 digests are stored.
    - Codes last 5 minutes and work once.
    - Access tokens last 1 hour.
    - Refresh tokens last 90 days and rotate on every use.
    - Tokens are bound to the `/mcp` resource (RFC 8707).
  - **Disconnecting** deletes the grant and all of its tokens. Revoking one token works too (`POST /oauth/revoke`, RFC 7009).
- **Consent records.** Allowing a connection, changing it, and disconnecting each add an `agent_sharing` consent record: text version, agent name, profiles, permissions, kinds of data, expiry, time and country. Account shows them in the consent history. Adding a family member records a `family_profile` consent with what the account holder confirmed (parent or guardian for a child or anyone under 18; the person's agreement for an adult; `shared/family.ts`).
- **Data residency.** Grants and tokens live in the account's cell like everything else personal; only registered client names and redirect URIs are in the default database.
- **Minimum necessary.** Agents see only the profiles shared with them and only summary data: no files, scan images, email address, contact details or lab booking addresses. Write tools only add.
- **Prompt injection.** Test names and notes come from uploaded documents. The server instructions and tool descriptions tell agents to treat them as data, and no tool sends anything to a third party.

## Not built yet

- Wearable APIs (Oura, Fitbit, Garmin), and ABDM records fetched over the network ([abdm.md](abdm.md); FHIR files exported from ABHA apps can already be uploaded). Readings from Apple Health and Health Connect come in through the apps ([health-import.md](health-import.md)) and reach agents as ordinary results.
- A weekly digest of agent activity, and email or push delivery of the notifications below (the server has no mail or push provider yet).
- A listing in the agent directories (Claude connector directory, ChatGPT apps) once the policy and legal review is done.
