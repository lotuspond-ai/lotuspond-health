// Sign-in through LotusPond Accounts (docs/identity.md), when ACCOUNTS_ISSUER is set. Health is an OpenID Connect
// relying party; after the callback it starts its own session exactly as a password sign-in does.
//
//   GET  /api/auth/accounts/start?intent=signup|login   to Accounts, with PKCE, state and nonce in a signed cookie
//   GET  /api/auth/accounts/callback                    back from Accounts: sign in, link, or start sign-up
//   GET  /api/auth/accounts/pending                     the Accounts identity waiting to finish sign-up
//   POST /api/auth/accounts/complete                    finish sign-up: country, age and Health's own consents
//   POST /api/auth/accounts/app-exchange                the apps: trade the one-time code for a session token
//
// The iOS and Android apps sign in through the system browser (RFC 8252): they open /start?client=app with a PKCE
// challenge of their own; the callback sends the browser back to the app (APP_ACCOUNTS_REDIRECT) with a one-time
// code, encrypted and bound to that challenge, which the app trades with its verifier for a token session.
//
// Accounts proves who the person is. Health still asks its own questions (country, age, the health-data consent), so
// a first sign-in ends on Health's sign-up page with the email filled in and no password.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
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
import { AccountsAppExchangeBody, AccountsCompleteBody } from '../schemas.ts';
import { insertAccount, isUniqueViolation, sessionInfo } from './auth.ts';
import { ACCOUNTS_ERRORS, APP_ACCOUNTS_REDIRECT, APP_LINK_PATH, type AccountsErrorCode } from '../../../shared/identity.ts';

const FLOW_COOKIE = 'lp_accounts_flow';
const PENDING_COOKIE = 'lp_accounts_pending';
const COOKIE_PATH = '/api/auth/accounts';
const FLOW_TTL_S = 10 * 60;
const PENDING_TTL_S = 30 * 60;

interface Flow {
  state: string; nonce: string; verifier: string; signUp: boolean; exp: number;
  /** The app's PKCE challenge, when an app started this sign-in in the system browser. */
  app?: string;
}
type Pending = AccountsIdentity & { exp: number };
/** The one-time code handed to an app: a session for an account, or an identity waiting to finish sign-up. */
type AppCode =
  | { k: 'session'; uid: string; region: DataRegion; ch: string; jti: string; exp: number }
  | { k: 'pending'; id: AccountsIdentity; ch: string; jti: string; exp: number }
  /** For another regional host (REGION_API_ORIGINS), which decides for itself. Hosts share DIRECTORY_SECRET, so it
   *  can open the code; the app goes there only if the host is one the server publishes (apiOrigins). */
  | { k: 'identity'; id: AccountsIdentity; ch: string; jti: string; exp: number };
/** An app holds its sign-up in progress as this token (it has no cookies across sites). */
type AppPending = Pending & { k: 'app-pending' };

const APP_CODE_TTL_S = 2 * 60;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

type Outcome =
  | { kind: 'account'; cell: Cell; user: UserRow }
  | { kind: 'new'; id: AccountsIdentity }
  | { kind: 'error'; code: AccountsErrorCode }
  /** The account is held by a region another host of this deployment serves. */
  | { kind: 'elsewhere'; origin: string };


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
  // App codes and app sign-up tokens travel through the system browser and the OS, so they are encrypted too.
  const boxKey = createHmac('sha256', deps.secrets.directoryKey).update('lotuspond:accounts-app-codes:v1').digest();
  const box = (value: object) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', boxKey, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
  };
  const unbox = <T extends { exp: number }>(sealed: string): T | null => {
    try {
      const raw = Buffer.from(sealed, 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', boxKey, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      const v = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')) as T;
      return v.exp * 1000 > Date.now() ? v : null;
    } catch { return null; }
  };
  /** Codes already traded, until they expire. One server instance only; with several, a code could be replayed
   *  within its two minutes, still only by the app holding the PKCE verifier. */
  const usedCodes = new Map<string, number>();
  const spend = (jti: string, exp: number) => {
    const now = Date.now();
    for (const [k, until] of usedCodes) if (until < now) usedCodes.delete(k);
    if (usedCodes.has(jti)) return false;
    usedCodes.set(jti, exp * 1000);
    return true;
  };
  const inSeconds = (s: number) => Math.floor(Date.now() / 1000) + s;

  const put = (c: Ctx, name: string, value: object, ttl: number) =>
    setCookie(c, name, seal(value), { httpOnly: true, sameSite: 'Lax', secure: config.cookieSecure, path: COOKIE_PATH, maxAge: ttl });
  const drop = (c: Ctx, name: string) => deleteCookie(c, name, { path: COOKIE_PATH, secure: config.cookieSecure });

  const redirectUri = (c: Ctx) => `${publicOrigin(c, config)}${COOKIE_PATH}/callback`;
  const back = (c: Ctx, path: string) => c.redirect(`${publicOrigin(c, config)}${path}`, 302);
  const fail = (c: Ctx, code: keyof typeof ACCOUNTS_ERRORS, signUp = false) => back(c, `/${signUp ? 'signup' : 'login'}?accounts_error=${code}`);

  /** Start Health's own session: a cookie for the website, a token in the answer for the apps. */
  async function signIn(c: Ctx, cell: Cell, user: UserRow, forApp = false) {
    const { token, expiresAt } = await createSession(cell.db, user.region, user.id, config.sessionTtlMs, c.req.header('user-agent'));
    if (!forApp) writeSessionCookie(c, token, expiresAt, config.cookieSecure);
    await recordEvent(cell.db, eventContext(c, deps), user.id, 'sign_in');
    return { token, expiresAt: expiresAt.toISOString() };
  }

  /** Back to the app that started the sign-in: its https app link when APP_LINKS_ORIGIN is set (a host of its own,
   *  so iOS hands the link to the app), else its private-use scheme. A page rather than a bare redirect, with a
   *  button: iOS opens a universal link for a tap, not always for an automatic redirect. */
  function toApp(c: Ctx, params: Record<string, string>) {
    const base = config.appLinks.origin ? `${config.appLinks.origin}${APP_LINK_PATH}` : APP_ACCOUNTS_REDIRECT;
    const url = `${base}?${new URLSearchParams(params)}`;
    const href = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
    c.header('Referrer-Policy', 'no-referrer');
    return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="0;url=${href}"><title>Back to LotusPond Health</title>
<style>body{font:17px/1.5 system-ui,sans-serif;max-width:26rem;margin:4rem auto;padding:0 1rem;color:#12302e;background:#f3f6f5;text-align:center}
a{display:inline-block;margin-top:1rem;padding:.8rem 1.4rem;border-radius:.6rem;background:#b8506d;color:#fff;text-decoration:none}</style></head>
<body><p>${params.error ? 'Sign-in did not finish.' : 'Signed in to your LotusPond account.'}</p><a href="${href}">Open LotusPond Health</a></body></html>`);
  }

  /** What a checked Accounts identity means here: an account to sign in to (linking it if need be), someone new, or a refusal. */
  async function resolve(c: Ctx, id: AccountsIdentity): Promise<Outcome> {
    // An employer can suspend, reset or audit an account made through its single sign-on: never for health records.
    if (id.enterpriseConnection) return { kind: 'error', code: 'enterprise_account' };
    const elsewhere = (region: DataRegion): Outcome => {
      const origin = config.regionApiOrigins[region];
      return origin ? { kind: 'elsewhere', origin } : { kind: 'error', code: 'wrong_region' };
    };
    if (id.region && !cells.forRegion(id.region)) return elsewhere(id.region);
    const linked = await bySubject(id);
    if (linked) return { kind: 'account', ...linked };
    // A Health account with this email from before Accounts: linked when Accounts has verified the address
    // (settled by the owner, 2026-11-17).
    const found = await locate(deps, id.email);
    if (found) {
      if (!found.cell) return elsewhere(found.region);
      if (found.user.accountsSubject) return { kind: 'error', code: 'already_linked' };
      if (!id.emailVerified) return { kind: 'error', code: 'email_unverified' };
      if (id.region && id.region !== found.region) return { kind: 'error', code: 'wrong_region' };
      const [user] = await found.cell.db.update(users).set({ accountsSubject: id.subject, updatedAt: new Date() })
        .where(eq(users.id, found.user.id)).returning();
      await recordEvent(found.cell.db, eventContext(c, deps), user.id, 'accounts_linked');
      return { kind: 'account', cell: found.cell, user };
    }
    if (!id.emailVerified) return { kind: 'error', code: 'email_unverified' };
    return { kind: 'new', id };
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
    const forApp = c.req.query('client') === 'app';
    const appChallenge = c.req.query('code_challenge') ?? '';
    if (forApp && !CHALLENGE.test(appChallenge)) return c.text('The app sent no valid code_challenge (PKCE, S256).', 400);
    const flow: Flow = {
      state: randomToken(), nonce: randomToken(), verifier: randomToken(), signUp, exp: inSeconds(FLOW_TTL_S),
      ...(forApp ? { app: appChallenge } : {}),
    };
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
    const outcome = await resolve(c, id);

    if (flow.app) {
      const ch = flow.app;
      if (outcome.kind === 'error') return toApp(c, { error: outcome.code });
      if (outcome.kind === 'elsewhere') {
        const code: AppCode = { k: 'identity', id, ch, jti: randomToken(), exp: inSeconds(APP_CODE_TTL_S) };
        return toApp(c, { code: box(code), api_origin: outcome.origin });
      }
      const code: AppCode = outcome.kind === 'account'
        ? { k: 'session', uid: outcome.user.id, region: outcome.user.region, ch, jti: randomToken(), exp: inSeconds(APP_CODE_TTL_S) }
        : { k: 'pending', id: outcome.id, ch, jti: randomToken(), exp: inSeconds(APP_CODE_TTL_S) };
      return toApp(c, { code: box(code) });
    }
    // The website does not move between regional hosts here: an account held elsewhere is refused, as before.
    if (outcome.kind === 'error' || outcome.kind === 'elsewhere') return fail(c, outcome.kind === 'error' ? outcome.code : 'wrong_region', flow.signUp);
    if (outcome.kind === 'account') {
      await signIn(c, outcome.cell, outcome.user);
      return back(c, '/app');
    }
    // Someone new to Health: finish sign-up on Health's page.
    put(c, PENDING_COOKIE, { ...outcome.id, exp: inSeconds(PENDING_TTL_S) } satisfies Pending, PENDING_TTL_S);
    return back(c, '/signup?accounts=continue');
  });

  /** The apps: trade the one-time code from the system browser, with the PKCE verifier only the app holds. */
  app.post('/app-exchange', async c => {
    const body = await readJson(c, AccountsAppExchangeBody);
    const code = unbox<AppCode>(body.code);
    const expired = () => new HttpError(400, 'accounts_expired', ACCOUNTS_ERRORS.expired);
    if (!code) throw expired();
    const challenge = createHash('sha256').update(body.verifier).digest('base64url');
    if (challenge.length !== code.ch.length || !timingSafeEqual(Buffer.from(challenge), Buffer.from(code.ch))) throw expired();
    if (!spend(code.jti, code.exp)) throw expired();
    const startSignUp = (id: AccountsIdentity) => {
      const pending: AppPending = { ...id, k: 'app-pending', exp: inSeconds(PENDING_TTL_S) };
      return c.json({ pending: { email: id.email, region: id.region }, pendingToken: box(pending) });
    };
    const startSession = async (cell: Cell, user: UserRow) => {
      const session = await signIn(c, cell, user, true);
      return c.json({ ...(await sessionInfo(cell.db, user)), ...session });
    };
    if (code.k === 'pending') return startSignUp(code.id);
    if (code.k === 'identity') {
      // Handed over by another regional host: decide here, where the account's region is served.
      const outcome = await resolve(c, code.id);
      if (outcome.kind === 'account') return startSession(outcome.cell, outcome.user);
      if (outcome.kind === 'new') return startSignUp(outcome.id);
      const reason = outcome.kind === 'error' ? outcome.code : 'wrong_region';
      throw new HttpError(409, reason, ACCOUNTS_ERRORS[reason]);
    }
    const cell = cells.forRegion(code.region);
    const [user] = cell ? await cell.db.select().from(users).where(eq(users.id, code.uid)).limit(1) : [];
    if (!cell || !user) throw expired();
    return startSession(cell, user);
  });

  app.get('/pending', c => {
    const pending = open<Pending>(getCookie(c, PENDING_COOKIE));
    if (!pending) throw notFound('There is no LotusPond Accounts sign-up waiting. Start again.');
    return c.json({ email: pending.email, region: pending.region });
  });

  app.post('/complete', async c => {
    // The website keeps the identity in a cookie; the apps send the token /app-exchange gave them.
    const forApp = wantsTokenSession(c);
    const body = await readJson(c, AccountsCompleteBody);
    const fromApp = forApp && body.pendingToken ? unbox<AppPending>(body.pendingToken) : null;
    const pending: Pending | null = forApp ? (fromApp?.k === 'app-pending' ? fromApp : null) : open<Pending>(getCookie(c, PENDING_COOKIE));
    if (!pending) throw new HttpError(409, 'accounts_expired', ACCOUNTS_ERRORS.expired);
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
    if (!forApp) drop(c, PENDING_COOKIE);
    await recordEvent(cell.db, eventContext(c, deps), user.id, 'account_created');
    const { token, expiresAt } = await createSession(cell.db, user.region, user.id, config.sessionTtlMs, c.req.header('user-agent'));
    if (forApp) return c.json({ ...(await sessionInfo(cell.db, user)), token, expiresAt: expiresAt.toISOString() }, 201);
    writeSessionCookie(c, token, expiresAt, config.cookieSecure);
    return c.json(await sessionInfo(cell.db, user), 201);
  });

  return app;
}
