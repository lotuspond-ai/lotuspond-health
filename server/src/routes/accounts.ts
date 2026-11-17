// Sign-in through LotusPond Accounts (docs/identity.md), when ACCOUNTS_ISSUER is set. Health is an OpenID Connect
// relying party; after the callback it starts its own session exactly as a password sign-in does.
//
//   GET  /api/auth/accounts/start?intent=signup|login   to Accounts, with PKCE, state and nonce in a signed cookie
//   GET  /api/auth/accounts/callback                    back from Accounts: sign in, link, or start sign-up
//   GET  /api/auth/accounts/pending                     the Accounts identity waiting to finish sign-up
//   POST /api/auth/accounts/complete                    finish sign-up: country, age and Health's own consents
//
// Accounts proves who the person is. Health still asks its own questions (country, age, the health-data consent), so
// a first sign-in ends on Health's sign-up page with the email filled in and no password.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { eq } from 'drizzle-orm';
import { countryPolicy, REGIONS, signUpProblem, type DataRegion } from '../../../shared/regions.ts';
import { users, type UserRow } from '../db/schema.ts';
import type { Cell } from '../cells.ts';
import { AccountsClient, OidcError, randomToken, type AccountsIdentity } from '../auth/oidc.ts';
import { fakeAccounts, FAKE_ACCOUNTS_PATH, type FakeAccounts } from '../auth/fake-accounts.ts';
import { createSession, wantsTokenSession, writeSessionCookie } from '../auth/sessions.ts';
import { eventContext, recordEvent } from '../compliance/audit.ts';
import { claim, locate, release } from '../compliance/directory.ts';
import { conflict, HttpError, notFound } from '../lib/errors.ts';
import { readJson, type AppEnv, type Ctx, type Deps } from '../http.ts';
import { publicOrigin } from '../agents/oauth.ts';
import { AccountsCompleteBody } from '../schemas.ts';
import { insertAccount, isUniqueViolation, sessionInfo } from './auth.ts';
import { ACCOUNTS_ERRORS } from '../../../shared/identity.ts';

const FLOW_COOKIE = 'lp_accounts_flow';
const PENDING_COOKIE = 'lp_accounts_pending';
const COOKIE_PATH = '/api/auth/accounts';
const FLOW_TTL_S = 10 * 60;
const PENDING_TTL_S = 30 * 60;

interface Flow { state: string; nonce: string; verifier: string; signUp: boolean; exp: number }
type Pending = AccountsIdentity & { exp: number };


export interface AccountsRuntime { client: AccountsClient; fake?: FakeAccounts }

export function accountsRuntime(deps: Pick<Deps, 'config'>): AccountsRuntime | null {
  const cfg = deps.config.accounts;
  if (!cfg) return null;
  if (cfg.issuer === 'fake') {
    const fake = fakeAccounts(cfg.clientId);
    return { client: new AccountsClient(cfg, fake.fetch, fake.metadata), fake };
  }
  return { client: new AccountsClient(cfg) };
}

export { FAKE_ACCOUNTS_PATH };

export function accountsRoutes(deps: Deps, runtime: AccountsRuntime) {
  const { config, cells } = deps;
  const { client } = runtime;
  const app = new Hono<AppEnv>();
  const cookieKey = createHmac('sha256', deps.secrets.directoryKey).update('lotuspond:accounts-cookies:v1').digest();

  const seal = (value: object) => {
    const body = Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${body}.${createHmac('sha256', cookieKey).update(body).digest('base64url')}`;
  };
  const open = <T extends { exp: number }>(sealed: string | undefined): T | null => {
    const [body, mac] = sealed?.split('.') ?? [];
    if (!body || !mac) return null;
    const want = createHmac('sha256', cookieKey).update(body).digest();
    const got = Buffer.from(mac, 'base64url');
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    try {
      const v = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
      return v.exp * 1000 > Date.now() ? v : null;
    } catch { return null; }
  };
  const put = (c: Ctx, name: string, value: object, ttl: number) =>
    setCookie(c, name, seal(value), { httpOnly: true, sameSite: 'Lax', secure: config.cookieSecure, path: COOKIE_PATH, maxAge: ttl });
  const drop = (c: Ctx, name: string) => deleteCookie(c, name, { path: COOKIE_PATH, secure: config.cookieSecure });

  const redirectUri = (c: Ctx) => `${publicOrigin(c, config)}${COOKIE_PATH}/callback`;
  const back = (c: Ctx, path: string) => c.redirect(`${publicOrigin(c, config)}${path}`, 302);
  const fail = (c: Ctx, code: keyof typeof ACCOUNTS_ERRORS, signUp = false) => back(c, `/${signUp ? 'signup' : 'login'}?accounts_error=${code}`);

  async function signIn(c: Ctx, cell: Cell, user: UserRow) {
    const { token, expiresAt } = await createSession(cell.db, user.region, user.id, config.sessionTtlMs, c.req.header('user-agent'));
    writeSessionCookie(c, token, expiresAt, config.cookieSecure);
    await recordEvent(cell.db, eventContext(c, deps), user.id, 'sign_in');
  }

  /** The Health account already linked to this Accounts subject: the region's cell first, then every cell here. */
  async function bySubject(id: AccountsIdentity): Promise<{ cell: Cell; user: UserRow } | null> {
    const first = id.region ? cells.forRegion(id.region) : null;
    for (const cell of [...(first ? [first] : []), ...cells.cells.filter(x => x !== first)]) {
      const [user] = await cell.db.select().from(users).where(eq(users.accountsSubject, id.subject)).limit(1);
      if (user) return { cell, user };
    }
    return null;
  }

  app.get('/start', async c => {
    const signUp = c.req.query('intent') === 'signup';
    const flow: Flow = { state: randomToken(), nonce: randomToken(), verifier: randomToken(), signUp, exp: Math.floor(Date.now() / 1000) + FLOW_TTL_S };
    put(c, FLOW_COOKIE, flow, FLOW_TTL_S);
    return c.redirect(await client.authorizeUrl({ redirectUri: redirectUri(c), state: flow.state, nonce: flow.nonce, verifier: flow.verifier, signUp }), 302);
  });

  app.get('/callback', async c => {
    const flow = open<Flow>(getCookie(c, FLOW_COOKIE));
    drop(c, FLOW_COOKIE);
    const q = c.req.query();
    if (!flow || q.state !== flow.state) return fail(c, 'expired');
    if (q.error) return fail(c, q.error === 'access_denied' ? 'cancelled' : 'sign_in_failed', flow.signUp);
    if (!q.code) return fail(c, 'sign_in_failed', flow.signUp);

    let id: AccountsIdentity;
    try {
      id = await client.signIn({ code: q.code, verifier: flow.verifier, redirectUri: redirectUri(c), nonce: flow.nonce });
    } catch (e) {
      if (!(e instanceof OidcError)) throw e;
      console.warn(`[accounts] sign-in refused: ${e.code}: ${e.message}`);
      return fail(c, 'sign_in_failed', flow.signUp);
    }
    // An employer can suspend, reset or audit an account made through its single sign-on: never for health records.
    if (id.enterpriseConnection) return fail(c, 'enterprise_account', flow.signUp);
    if (id.region && !cells.forRegion(id.region)) return fail(c, 'wrong_region', flow.signUp);

    const linked = await bySubject(id);
    if (linked) {
      await signIn(c, linked.cell, linked.user);
      return back(c, '/app');
    }

    // A Health account with this email from before Accounts: link it when Accounts has verified the address.
    const found = await locate(deps, id.email);
    if (found) {
      if (!found.cell) return fail(c, 'wrong_region', flow.signUp);
      if (found.user.accountsSubject) return fail(c, 'already_linked', flow.signUp);
      if (!id.emailVerified) return fail(c, 'email_unverified', flow.signUp);
      if (id.region && id.region !== found.region) return fail(c, 'wrong_region', flow.signUp);
      const [user] = await found.cell.db.update(users).set({ accountsSubject: id.subject, updatedAt: new Date() })
        .where(eq(users.id, found.user.id)).returning();
      await recordEvent(found.cell.db, eventContext(c, deps), user.id, 'accounts_linked');
      await signIn(c, found.cell, user);
      return back(c, '/app');
    }

    // Someone new to Health: finish sign-up on Health's page.
    if (!id.emailVerified) return fail(c, 'email_unverified', true);
    put(c, PENDING_COOKIE, { ...id, exp: Math.floor(Date.now() / 1000) + PENDING_TTL_S } satisfies Pending, PENDING_TTL_S);
    return back(c, '/signup?accounts=continue');
  });

  app.get('/pending', c => {
    const pending = open<Pending>(getCookie(c, PENDING_COOKIE));
    if (!pending) throw notFound('There is no LotusPond Accounts sign-up waiting. Start again.');
    return c.json({ email: pending.email, region: pending.region });
  });

  app.post('/complete', async c => {
    // Browsers only for now: the apps will sign in through the system browser (RFC 8252) in a later change.
    if (wantsTokenSession(c)) throw new HttpError(400, 'not_supported', 'The apps cannot sign up with LotusPond Accounts yet.');
    const pending = open<Pending>(getCookie(c, PENDING_COOKIE));
    if (!pending) throw new HttpError(409, 'accounts_expired', ACCOUNTS_ERRORS.expired);
    const body = await readJson(c, AccountsCompleteBody);
    const problem = signUpProblem(body, cells.servedRegions, config.openCountries);
    if (problem) {
      const refused = problem.code === 'country_unavailable' || problem.code === 'region_not_served';
      throw new HttpError(refused ? 403 : 400, problem.code, problem.message);
    }
    const policy = countryPolicy(body.country);
    if (pending.region && pending.region !== policy.region) {
      throw new HttpError(409, 'region_mismatch', `Your LotusPond account is held on ${REGIONS[pending.region as DataRegion].storage}, but records for people in that country are kept on ${REGIONS[policy.region].storage}. Choose the country you live in, or contact support.`);
    }
    const cell = cells.forRegion(policy.region)!;
    const taken = 'A LotusPond Health account already uses this email. Sign in with LotusPond Accounts to link it.';
    if (await locate(deps, pending.email)) throw conflict(taken, 'email_taken');
    const userId = crypto.randomUUID();
    if (!(await claim(deps, pending.email, policy.region, userId))) throw conflict(taken, 'email_taken');
    let user: UserRow;
    try {
      user = await insertAccount(cell, { id: userId, email: pending.email, passwordHash: null, accountsSubject: pending.subject }, policy, body.displayName, body.consents.marketing);
    } catch (e) {
      await release(deps, userId).catch(() => {});
      if (isUniqueViolation(e)) throw conflict(taken, 'email_taken');
      throw e;
    }
    drop(c, PENDING_COOKIE);
    await recordEvent(cell.db, eventContext(c, deps), user.id, 'account_created');
    const { token, expiresAt } = await createSession(cell.db, user.region, user.id, config.sessionTtlMs, c.req.header('user-agent'));
    writeSessionCookie(c, token, expiresAt, config.cookieSecure);
    return c.json(await sessionInfo(cell.db, user), 201);
  });

  return app;
}
