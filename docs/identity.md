# One LotusPond account

Status: **accepted on 2026-11-16. Health's side is built for the website, off unless `ACCOUNTS_ISSUER` is set** ([Built so far](#built-so-far)). LotusPond Accounts itself is not built yet. The decision is recorded in the LotusPond Works repository:
- [ADR-0018, one LotusPond account for Health and Works](https://github.com/lotuspond-ai/lotuspond/blob/main/docs/architecture/0018-one-lotuspond-account.md);
- [ADR-0019, databases, tenancy and placement](https://github.com/lotuspond-ai/lotuspond/blob/main/docs/architecture/0019-database-tenancy-and-placement.md).

The links work once [lotuspond-ai/lotuspond#49](https://github.com/lotuspond-ai/lotuspond/pull/49) is merged. This page says what the decision changes for Health.

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

## Existing accounts

- Health's Argon2id hashes and regions are imported into Accounts unchanged.
- If the same email also has a Works account, the two are joined only after the person proves control of each: mailbox verification where that product had already verified the address, otherwise one sign-in with that product's old password.
- Health's `users.password_hash` is dropped only after a reviewed migration and a period with both sign-in paths available.

## Built so far

Health's side works for the website, against a stand-in for Accounts. It changes nothing until `ACCOUNTS_ISSUER` is set; password sign-up and sign-in work as before alongside it.

| Setting | Meaning |
| --- | --- |
| `ACCOUNTS_ISSUER` | The Accounts OpenID Connect issuer URL (https), or `fake` for the stand-in inside the server. `fake` is refused in production. |
| `ACCOUNTS_CLIENT_ID` | Health's client id at Accounts (`lotuspond-health` for the stand-in). |
| `ACCOUNTS_CLIENT_SECRET` | Optional. Without it Health is a public client and relies on PKCE alone. |

To try it: `ACCOUNTS_ISSUER=fake npm run dev`, open `/signup` and choose **Continue with LotusPond Account**. The stand-in's page asks for an email and lets you choose what Accounts would say: whether the email is verified, the region, and whether the account came from a company's single sign-on.

- **Flow** (`server/src/routes/accounts.ts`, `server/src/auth/oidc.ts`). Authorization code with PKCE (S256), state and nonce, kept for 10 minutes in a signed, HttpOnly cookie. The ID token is checked against the issuer's published keys (RS256 or ES256), with its issuer, audience, expiry and nonce. Then Health starts its own session, as for a password sign-in.
- **First sign-in.** Health still asks its own questions: name, country, age, Terms and Privacy, and the health-data consent. The email comes from Accounts and there is no Health password (`users.password_hash` is null; `users.accounts_subject` holds the Accounts `sub`). The Accounts identity waits for 30 minutes in a signed cookie while the person answers.
- **Existing Health accounts** with the same email are linked on their first Accounts sign-in, only when Accounts says the email is verified. They keep their password until the reviewed migration removes it.
- **Refused:** accounts from a company's single sign-on; a region this server does not serve; a country whose region differs from the one Accounts holds the account in; a Health account already linked to another Accounts subject.
- **Accounts without a Health password** cannot use the password form (it says to use Accounts) or change a password here. They can delete their account within 10 minutes of signing in with Accounts, instead of typing a password.

### Claims

Health reads `sub`, `email` and `email_verified`, plus two LotusPond claims whose names are this side's proposal until Accounts publishes its own:

- `region`: `in`, `eu`, `us` or `global`, the cell that holds the account;
- `enterprise_connection`: present (any non-empty string) when the account was created through a company's single sign-on.

### Not built yet

- **The apps.** Sign-in through the system browser (RFC 8252) with a custom-scheme or app-link redirect. Until then the apps keep the password form, and `/api/auth/accounts/complete` refuses app clients.
- **The `directory` moving into Accounts.** Health still keeps its email directory; the `region` claim is checked against it.
- **The agents' consent page** (`/oauth/authorize`) still uses Health's session, not the Accounts session.
- **Sign-out at Accounts** (RP-initiated logout). Signing out of Health ends only Health's session.
- **Removing passwords** for linked accounts, after the reviewed migration.

## Before launch

Moving account identity (not records) into Accounts changes who processes account data. The privacy policy, the consumer health data policy and the sign-up consent text need review before this ships.
