# One LotusPond account

Status: **accepted on 2026-11-16. Health's side is built for the website and the apps, off unless `ACCOUNTS_ISSUER` is set** ([Built so far](#built-so-far)). LotusPond Accounts itself is not built yet. The decisions are recorded here:
- [ADR-0001, one LotusPond account for Health and Works](https://github.com/lotuspond-ai/lotuspond/blob/main/docs/architecture/0001-one-lotuspond-account.md), in the company repository (it was Works ADR-0018);
- [ADR-0002, separate databases for Accounts, Health and Works](https://github.com/lotuspond-ai/lotuspond/blob/main/docs/architecture/0002-account-and-product-databases.md), in the company repository (it was part of Works ADR-0019).

This page says what the decision changes for Health.

## Settled by the owner, 2026-11-16

- **Health opens in India only at first.** Health sign-up accepts only people resident in India. Their accounts and records are kept in the India cell. The other cells stay in the code and open later by configuration.
- **Domains.** Accounts is at `accounts.lotuspond.ai`, Health stays at `health.lotuspond.ai`, and hosted Works is at `works.lotuspond.ai`.

## Settled by the owner, 2026-11-17

- **Existing Health accounts are linked by verified email.** The first time someone signs in with LotusPond Accounts, a Health account with the same email is joined to it when Accounts says that email is verified. No sign-in with the old Health password is asked for.

## What changes

- **Sign-up and sign-in move to LotusPond Accounts.**
  - The service is at `accounts.lotuspond.ai`, one page for Health and Works.
  - Health becomes an OpenID Connect relying party, using the authorization-code flow with PKCE.
  - The `/signup` and `/login` pages send people to Accounts and return them to Health's own onboarding.
- **Health keeps its own session.** After the callback it creates the same host-only cookie (or app bearer token) as today. No cookie is shared across `lotuspond.ai`.
- **The apps** sign in through the system browser (RFC 8252) instead of a password form, then receive Health's bearer token as now.
- **Cells stay.** Accounts uses the same four regions. The account's `region` claim tells Health which cell to use, so Health's email `directory` moves into Accounts. Records, files, profiles, consents and agent grants never leave Health's cells.
- **Health-specific consent stays in Health:** the age confirmation, the health-data consent, family profiles and agent sharing.
- **Agent access stays in Health.** The OAuth 2.1 server for `/mcp` is unchanged. Its consent page uses the Accounts session to know who is signed in.
- **Employer-managed accounts are refused.** An account created through a company's single sign-on (an enterprise connection in Works) cannot open Health. The person is asked to use a personal account, so an employer can never suspend, reset or audit the account that holds their health records.
- **Works never sees Health data,** nor whether a person uses Health.

## The developer console's organisation accounts

The organisation API's console already has accounts of its own, built like LotusPond Works' (a person's account, with organisations as workspaces and a role in each), and kept apart from personal Health accounts ([connectors.md](connectors.md#the-organisation-api)). When Accounts ships:

- they sign in through Accounts too, and are stored by `(issuer, subject)`;
- a managed account from a Works enterprise connection may open the console, because it holds no one's health records; it still cannot open personal Health;
- organisations and memberships stay in Health, as Works keeps its own.

## Existing accounts

- Health's Argon2id hashes and regions are imported into Accounts unchanged.
- If the same email also has a Works account, the two are joined only after the person proves control of each: mailbox verification where that product had already verified the address, otherwise one sign-in with that product's old password.
- Health's `users.password_hash` is dropped only after a reviewed migration and a period with both sign-in paths available.

## Built so far

Health's side works for the website and the apps, against a stand-in for Accounts. It changes nothing until `ACCOUNTS_ISSUER` is set; password sign-up and sign-in work as before alongside it.

| Setting | Meaning |
| --- | --- |
| `ACCOUNTS_ISSUER` | The Accounts OpenID Connect issuer URL (https), or `fake` for the stand-in inside the server. `fake` is refused in production. |
| `ACCOUNTS_CLIENT_ID` | Health's client id at Accounts (`lotuspond-health` for the stand-in). |
| `ACCOUNTS_CLIENT_SECRET` | Optional. Without it Health is a public client and relies on PKCE alone. |

To try it: `ACCOUNTS_ISSUER=fake npm run dev`, open `/signup` and choose **Continue with LotusPond Account**. The stand-in's page asks for an email and lets you choose what Accounts would say: whether the email is verified, the region, and whether the account came from a company's single sign-on. It remembers the sign-in in that browser until you sign out at it, so `prompt=none` can be tried.

- **Flow** (`server/src/routes/accounts.ts`, `server/src/auth/oidc.ts`). Authorization code with PKCE (S256), state and nonce, kept for 10 minutes in a signed, HttpOnly cookie. The ID token is checked against the issuer's published keys (RS256 or ES256), with its issuer, audience, expiry and nonce. Then Health starts its own session, as for a password sign-in.
- **First sign-in.** Health still asks its own questions: name, country, age, Terms and Privacy, and the health-data consent. The email comes from Accounts and there is no Health password (`users.password_hash` is null; `users.accounts_subject` holds the Accounts `sub`). The Accounts identity waits for 30 minutes in a signed cookie while the person answers.
- **Existing Health accounts** with the same email are linked on their first Accounts sign-in, only when Accounts says the email is verified. **Once linked, their Health password opens nothing while `ACCOUNTS_ISSUER` is set** (settled by the owner, 2026-11-18): it may have been changed or leaked since they moved, and Health cannot reset passwords. The hash is kept, so a rollback (`ACCOUNTS_ISSUER` unset) brings the password back, until the reviewed migration removes it. The Account page offers no Health password for them.
- **Regional hosts on the website** (`REGION_API_ORIGINS`, where each regional host is its own site and API). If the account is held in a region another host serves, the callback sends the browser to `/api/auth/accounts/start?hop=1` on that host, which signs it in on its own site with its own session. No code or token crosses between hosts: Accounts remembers the person, so the second pass does not ask again. Each regional host's `/api/auth/accounts/callback` must be registered as a redirect URI at Accounts. A sign-in is handed on once at most, then refused with `wrong_region`. The stand-in issuer remembers a sign-in only on the host it ran on, so the second host asks for the email again.
- **Signing out** (OpenID Connect RP-Initiated Logout 1.0). Sessions record whether they came from Accounts (`sessions.via_accounts`). Signing out of such a session on the website ends Health's session, then sends the browser to Accounts' `end_session_endpoint`, which returns it to Health's `/login` page.
  - That page must be registered at Accounts as a post-logout redirect URI.
  - The trip to Accounts needs a 2-minute ticket that only Health's own sign-out sets, so a link from another site cannot sign anyone out of Accounts.
  - **The ID token goes as `id_token_hint`.** Accounts' Hydra refuses `post_logout_redirect_uri` without it, so each session from Accounts keeps the ID token it started from (`sessions.accounts_id_token`, migration 0019). Hydra accepts an expired token as the hint, so it works for the whole session. Accounts still asks the person to confirm before signing out.
  - **The ticket is encrypted** (AES-256-GCM), since it carries that token, and the apps' ticket travels in an address.
  - **A session from before ID tokens were kept** signs out at Accounts with `client_id` only and stays on Accounts' signed-out page: without a hint, Accounts would refuse the return address.
  - Password sessions sign out of Health only.
  - **In the apps**, the Accounts sign-in lives in the system browser, so after Health's own sign-out the app opens `/api/auth/accounts/sign-out?ticket=…` there.
    - The 2-minute ticket goes in the address because that browser has no cookie from the app. Someone who got it could at most sign the browser that opens it out of Accounts.
    - Accounts returns to Health's `/api/auth/accounts/signed-out`, which hands on to the app with `signed_out=1`. That uses the app link or the private-use scheme, like a sign-in. The app then closes the browser and says it is signed out of both.
    - So the apps need no post-logout address of their own at Accounts, only Health's https page.
- **Back-channel logout** (OpenID Connect Back-Channel Logout 1.0). When someone signs out at Accounts, or Accounts closes their account, Accounts posts a logout token to `POST /api/auth/accounts/backchannel-logout`.
  - **Checks:** the token is checked like an ID token (signature, issuer, audience). It must also be at most 5 minutes old, carry the back-channel logout event and a `jti`, and carry no nonce. A token is acted on once.
  - **What ends:** sessions record the Accounts session (`sessions.accounts_sid`) from the ID token's `sid`. A token naming a `sid` ends the Health sessions from that Accounts session. A token naming only the account (`sub`) ends every session from Accounts for it, on the website and in the apps.
  - **What stays:** password sessions are separate sign-ins and stay.
  - **Audit:** each account affected gets an `accounts_signed_out` event ("Signed out from LotusPond Accounts").
  - **Registration:** register the endpoint at Accounts as Health's `backchannel_logout_uri`, with `backchannel_logout_session_required`. With regional hosts, register each host's, since each ends only the sessions in its own cells.
  - **Replays:** a token is refused if it was already used, on any instance or regional host (see one-time tokens below).
  - **Stand-in:** its sign-out page has **Sign out everywhere**, which sends Health a logout token for an email.
- **An agent's consent page** (`/oauth/authorize`). Someone an agent sends who is not signed in to Health is first checked silently at Accounts (`prompt=none`).
  - **Already signed in at Accounts** (for example from LotusPond Works): Health signs them in and returns them to the consent page, with no sign-in page.
  - **Not signed in at Accounts** (`login_required`): they get Health's sign-in page.
  - **The consent address** (`next`) is kept through that page's Accounts button, a first sign-up, refusals and a regional hand-off. Only this site's `/oauth/authorize?…` is accepted (`agentConsentNext`, shared/identity.ts).
  - The consent itself stays in Health, with Health's session.
  - In development, `npm run dev` forwards `/oauth` as well as `/api`, so the whole path works on one origin.
- **Refused:** accounts from a company's single sign-on; a region this server does not serve; a country whose region differs from the one Accounts holds the account in; a Health account already linked to another Accounts subject.
- **Accounts without a Health password** cannot use the password form (it says to use Accounts) or change a password here. They can delete their account within 10 minutes of signing in with Accounts, instead of typing a password.
- **The apps** sign in through the system browser (RFC 8252): Custom Tabs on Android and SFSafariViewController on iOS (`@capacitor/browser`), never the app's own web view.
  1. The app makes its own PKCE pair (`src/api/accountsApp.ts`) and opens `/api/auth/accounts/start?client=app&code_challenge=…` on its API host.
  2. The browser signs in with Accounts. Health's callback then shows a short page that sends the browser back to the app, at `ai.lotuspond.health:/accounts?code=…` (or `?error=…`). This is a private-use URI scheme named after the app id, registered in `AndroidManifest.xml` and `Info.plist`. The page also has a button, in case the browser asks before opening the app.
  3. The code is encrypted, lasts 2 minutes, works once, and is bound to the app's PKCE challenge, so another app that catches the link cannot use it. The app trades it with its verifier at `POST /api/auth/accounts/app-exchange` for a token session, the same kind a password sign-in gives it (`src/native/accounts.ts`).
  4. Someone new answers Health's questions in the app. The exchange gives the app an encrypted sign-up token, valid for 30 minutes, which it sends with `POST /api/auth/accounts/complete`.
  - **Universal links and app links.** With `APP_LINKS_ORIGIN` set, the return is the https link `https://open.health.lotuspond.ai/accounts-return?code=…` instead, which the apps claim: Associated Domains in `ios/App/App/App.entitlements`, and an `autoVerify` intent filter in `AndroidManifest.xml`. Only another app on the device could catch the private-use scheme, so the https link is the stronger return. It needs a host of its own, because iOS keeps a link in the browser when it stays on the domain already open, and the sign-in runs on `health.lotuspond.ai`. The private-use scheme stays registered as the fallback: if the link opens in the browser, `/accounts-return` on that host offers it with the same code.
  - **Regional hosts** (`REGION_API_ORIGINS`). The app starts on its current host. If the account is held in a region another host serves (from the `region` claim, or the shared directory for an existing account), the return link carries a code for that host and `api_origin=<that host>`. The app goes there only if the host is one `/api/auth/config` lists, so its verifier is never sent to a host named only in a link. That host opens the code, which works because the hosts share `DIRECTORY_SECRET`, as they already must for the directory. It then signs in, links or starts sign-up in its own region. A new person finishes sign-up on the host for the country they choose, as with a password.
  - Tested in `server/test/accounts.test.ts`, `server/test/accounts-regions.test.ts` and `server/test/app-links.test.ts`, and from the app client through a stand-in web view and system browser in `tools/test-app-client.ts`. **Not yet run on a phone** (docs/mobile.md, "Not done yet").

### One-time tokens

App sign-in codes and back-channel logout tokens each work once, across every instance and regional host. Using one is recorded in `spent_tokens` in the default database they share: a SHA-256 of the token's kind and id, and when it expires.
- **One insert:** the record is a single insert that does nothing if the row exists, so two instances racing on one token cannot both win.
- **Only where it can be used:** an app code is marked used only by a host that can use it, so a wrong host does not burn it for the right one.
- **Clean-up:** the server's sweep removes records once the token could no longer be accepted anyway.

### Setting up universal links and app links

| Setting | Meaning |
| --- | --- |
| `APP_LINKS_ORIGIN` | `https://open.health.lotuspond.ai`. Point that name at this server; it serves the files below on any host. |
| `APPLE_TEAM_ID` | The Apple Developer team id (10 characters). It serves `/.well-known/apple-app-site-association` for `<team>.ai.lotuspond.health`. |
| `ANDROID_APP_SHA256` | SHA-256 fingerprints of the release signing certificate, comma-separated (`AA:BB:…`). With Play App Signing, use the app signing key from Play Console (*Setup → App integrity*), and the upload key too if you install builds signed with it. It serves `/.well-known/assetlinks.json`. |

Also needed outside the repository:
- DNS for `open.health.lotuspond.ai` with an https certificate.
- The *Associated Domains* capability on the `ai.lotuspond.health` App ID in the Apple Developer account. Personal Teams cannot sign it; docs/mobile.md says what to do for those builds.

Apple fetches the file through its CDN, which can take a day to pick up a change.

### Claims

Health reads `sub`, `email` and `email_verified`, plus two LotusPond claims, named as LotusPond Accounts publishes them (the owner settled `org` on 2026-11-17, as ADR-0001 decision 7 has it):

- `region`: `in`, `eu`, `us` or `global`, the cell that holds the account;
- `org`: present (any non-empty string) on a company-managed account, naming its organisation. Health refuses such accounts.

**Asking for sign-up:** Health sends `screen_hint=signup`, and Accounts opens its sign-up page. Not `prompt=create`: Accounts' Hydra refuses that value and aborts the sign-in. The stand-in issuer refuses it too, as it refuses a return address after sign-out without `id_token_hint`, so Health's tests catch both.

### Moving the directory into Accounts

Health's side is built; running it is a decision, and the privacy texts need review first ([Before launch](#before-launch)).

1. **Export.** On each regional host, run `npm run accounts:export -w server -- <file>` (production: `node dist/index.js accounts:export <file>`).
   - It writes every account in that host's cells as JSON Lines: Health's user id, email, Argon2id hash exactly as stored, region, country, creation time, and any Accounts subject already linked.
   - The file is owner-readable only and is never overwritten. It holds emails and password hashes, so hand it to Accounts over a secure channel and delete it once imported.
2. **Accounts imports it.** The hashes and regions stay unchanged, so people keep their password, and an email that also has a Works account is joined as described in [Existing accounts](#existing-accounts).
3. **Link.** Accounts answers with one `{ "health_user_id", "sub" }` line per account. On each host, `accounts:link <file>` links them in one go and records `accounts_linked` for each account. It reports, without changing them:
   - accounts already linked;
   - conflicts (linked to another subject, or a subject already used);
   - ids another host holds;
   - unreadable lines.
4. **`PASSWORD_SIGN_IN=off`** (needs `ACCOUNTS_ISSUER`). LotusPond Accounts becomes the only way in:
   - **Password routes:** `/register`, `/login` and the password change answer `use_accounts`.
   - **Sign-in page:** shows only Continue with LotusPond Account.
   - **Deleting an account:** asks for a recent Accounts sign-in instead of a password.
   - **The email directory is no longer read or written.** An account is found by its Accounts subject. The host comes from the `region` claim. One never linked is found by email in the host's own cells, and a new one is created without a directory entry.
5. **Later**, after a reviewed migration: drop the `directory` table and `users.password_hash`. The WhatsApp directory, keyed by phone number, stays.

### Database

All of this PR's schema changes are in one migration, `0017_accounts_sign_in`:
- `users.password_hash` nullable;
- `users.accounts_subject`, unique;
- `sessions.via_accounts` and `sessions.accounts_sid`;
- the `spent_tokens` table.

### Not built yet

- **Dropping the `directory` table and `users.password_hash`**, after the reviewed migration and a period with `PASSWORD_SIGN_IN=off`.

## Before launch

Moving account identity (not records) into Accounts changes who processes account data. The privacy policy, the consumer health data policy and the sign-up consent text need review before this ships.
