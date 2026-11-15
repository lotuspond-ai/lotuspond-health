# One LotusPond account

Status: **accepted on 2026-11-16, not built yet.** The decision is recorded in the LotusPond Works repository:
- [ADR-0018, one LotusPond account for Health and Works](https://github.com/lotuspond-ai/lotuspond/blob/main/docs/architecture/0018-one-lotuspond-account.md);
- [ADR-0019, databases, tenancy and placement](https://github.com/lotuspond-ai/lotuspond/blob/main/docs/architecture/0019-database-tenancy-and-placement.md).

The links work once [lotuspond-ai/lotuspond#49](https://github.com/lotuspond-ai/lotuspond/pull/49) is merged. This page says what the decision changes for Health.

## Settled by the owner, 2026-11-16

- **Health opens in India only at first.** Health sign-up accepts only people resident in India. Their accounts and records are kept in the India cell. The other cells stay in the code and open later by configuration.
- **Domains.** Accounts is at `accounts.lotuspond.ai`, Health stays at `health.lotuspond.ai`, and hosted Works is at `works.lotuspond.ai`.

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

## Before launch

Moving account identity (not records) into Accounts changes who processes account data. The privacy policy, the consumer health data policy and the sign-up consent text need review before this ships.
