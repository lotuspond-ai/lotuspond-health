// Sign-in through LotusPond Accounts (docs/identity.md), when ACCOUNTS_ISSUER is set. Health is an OpenID Connect
// relying party; after the callback it starts its own session exactly as a password sign-in does.
//
//   GET  /api/auth/accounts/start?intent=signup|login   to Accounts, with PKCE, state and nonce in a signed cookie
//   GET  /api/auth/accounts/callback                    back from Accounts: sign in, link, or start sign-up
//   GET  /api/auth/accounts/pending                     the Accounts identity waiting to finish sign-up
//   POST /api/auth/accounts/complete                    finish sign-up: country, age and Health's own consents
//   POST /api/auth/accounts/app-exchange                the apps: trade the one-time code for a session token
//   GET  /api/auth/accounts/sign-out                    after Health's own sign-out: sign out of Accounts too
//   POST /api/auth/accounts/backchannel-logout          Accounts says a person signed out there (Back-Channel Logout)
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
import { and, eq, inArray } from 'drizzle-orm';
import { countryPolicy, REGIONS, signUpProblem, type DataRegion } from '../../../shared/regions.ts';
import { sessions, users, type UserRow } from '../db/schema.ts';
import type { Cell } from '../cells.ts';
import { AccountsClient, LOGOUT_TOKEN_MAX_AGE_S, OidcError, randomToken, type AccountsIdentity } from '../auth/oidc.ts';
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
/** Set by Health's own sign-out (routes/auth.ts) so that only it, not a link from another site, signs out of Accounts. */
const SIGN_OUT_COOKIE = 'lp_accounts_sign_out';
const SIGN_OUT_TTL_S = 2 * 60;
/** Where the website goes after signing out of Health, to sign out of Accounts too. */
export const ACCOUNTS_SIGN_OUT_PATH = '/api/auth/accounts/sign-out';
const PENDING_COOKIE = 'lp_accounts_pending';
const COOKIE_PATH = '/api/auth/accounts';
const FLOW_TTL_S = 10 * 60;
const PENDING_TTL_S = 30 * 60;

interface Flow {
  state: string; nonce: string; verifier: string; signUp: boolean; exp: number;
  /** The app's PKCE challenge, when an app started this sign-in in the system browser. */
  app?: string;
  /** The website: this sign-in was handed over from another regional host, so it is not handed on again. */
  hop?: boolean;
}
type Pending = AccountsIdentity & { exp: number };
/** The one-time code handed to an app: a session for an account, or an identity waiting to finish sign-up. */
type AppCode =
  | { k: 'session'; uid: string; region: DataRegion; sid?: string; ch: string; jti: string; exp: number }
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

const cookieKeyOf = (deps: Pick<Deps, 'secrets'>) => createHmac('sha256', deps.secrets.directoryKey).update('lotuspond:accounts-cookies:v1').digest();

/** Health's sign-out of a session that came from Accounts: allow one trip to Accounts' sign-out in the next 2 minutes. */
export function issueSignOutTicket(c: Ctx, deps: Pick<Deps, 'secrets' | 'config'>): string {
  const body = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + SIGN_OUT_TTL_S })).toString('base64url');
  const sealed = `${body}.${createHmac('sha256', cookieKeyOf(deps)).update(body).digest('base64url')}`;
  setCookie(c, SIGN_OUT_COOKIE, sealed, { httpOnly: true, sameSite: 'Lax', secure: deps.config.cookieSecure, path: COOKIE_PATH, maxAge: SIGN_OUT_TTL_S });
  return ACCOUNTS_SIGN_OUT_PATH;
}

export function accountsRoutes(deps: Deps, runtime: AccountsRuntime) {
  const { config, cells } = deps;
  const { client } = runtime;
  const app = new Hono<AppEnv>();
  const cookieKey = cookieKeyOf(deps);

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
  async function signIn(c: Ctx, cell: Cell, user: UserRow, forApp: boolean, sid: string | undefined) {
    const { token, expiresAt } = await createSession(cell.db, user.region, user.id, config.sessionTtlMs, c.req.header('user-agent'), { sid });
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
      ...(!forApp && c.req.query('hop') === '1' ? { hop: true } : {}),
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
        ? { k: 'session', uid: outcome.user.id, region: outcome.user.region, ...(id.sessionId ? { sid: id.sessionId } : {}), ch, jti: randomToken(), exp: inSeconds(APP_CODE_TTL_S) }
        : { k: 'pending', id: outcome.id, ch, jti: randomToken(), exp: inSeconds(APP_CODE_TTL_S) };
      return toApp(c, { code: box(code) });
    }
    // The website: an account held by another regional host signs in there, on that host's own site and session.
    // The browser starts again on that host (LotusPond Accounts remembers the person, so it does not ask again),
    // rather than carrying a code across hosts that only the URL would protect. Handed over once at most.
    if (outcome.kind === 'elsewhere') {
      if (flow.hop) return fail(c, 'wrong_region', flow.signUp);
      return c.redirect(`${outcome.origin}${COOKIE_PATH}/start?${new URLSearchParams({ intent: flow.signUp ? 'signup' : 'login', hop: '1' })}`, 302);
    }
    if (outcome.kind === 'error') return fail(c, outcome.code, flow.signUp);
    if (outcome.kind === 'account') {
      await signIn(c, outcome.cell, outcome.user, false, id.sessionId);
      return back(c, '/app');
    }
    // Someone new to Health: finish sign-up on Health's page.
    put(c, PENDING_COOKIE, { ...outcome.id, exp: inSeconds(PENDING_TTL_S) } satisfies Pending, PENDING_TTL_S);
    return back(c, '/signup?accounts=continue');
  });

  /** Logout tokens already acted on, by jti, until they are too old to be accepted anyway. One instance only, as for
   *  app codes; a replay could at most end sessions that the first delivery already ended. */
  const seenLogouts = new Map<string, number>();

  /**
   * Accounts says a person signed out there (OpenID Connect Back-Channel Logout 1.0). End the Health sessions that came
   * from that Accounts session (`sid`), or, when only the account (`sub`) is named, every session from Accounts for
   * that account, website and apps. Password sessions are separate sign-ins and stay. Returns how many ended.
   */
  async function backchannelLogout(token: string): Promise<number> {
    const t = await client.verifyLogoutToken(token);
    const now = Date.now();
    for (const [k, until] of seenLogouts) if (until < now) seenLogouts.delete(k);
    if (seenLogouts.has(t.jti)) throw new OidcError('invalid_token', 'This logout token was already used.');
    seenLogouts.set(t.jti, (t.iat + LOGOUT_TOKEN_MAX_AGE_S + 60) * 1000);
    let ended = 0;
    for (const cell of cells.cells) {
      const owners = t.subject ? (await cell.db.select({ id: users.id }).from(users).where(eq(users.accountsSubject, t.subject))).map(u => u.id) : null;
      if (owners && !owners.length) continue;
      const which = and(
        eq(sessions.viaAccounts, true),
        t.sessionId ? eq(sessions.accountsSid, t.sessionId) : undefined,
        owners ? inArray(sessions.userId, owners) : undefined,
      );
      const gone = await cell.db.delete(sessions).where(which).returning({ userId: sessions.userId });
      ended += gone.length;
      for (const userId of new Set(gone.map(g => g.userId))) await recordEvent(cell.db, null, userId, 'accounts_signed_out');
    }
    return ended;
  }
  runtime.fake?.onLogoutToken(backchannelLogout);

  app.post('/backchannel-logout', async c => {
    c.header('Cache-Control', 'no-store');
    const form = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
    const token = form.logout_token;
    if (typeof token !== 'string' || !token) return c.json({ error: 'invalid_request', error_description: 'logout_token is missing.' }, 400);
    try {
      await backchannelLogout(token);
    } catch (e) {
      if (!(e instanceof OidcError)) throw e;
      console.warn(`[accounts] back-channel logout refused: ${e.message}`);
      return c.json({ error: 'invalid_request', error_description: e.message }, 400);
    }
    return c.body(null, 200);
  });

  /** After Health's own sign-out (with its ticket): sign out of Accounts too, then back to the sign-in page. */
  app.get('/sign-out', async c => {
    const ticket = open<{ exp: number }>(getCookie(c, SIGN_OUT_COOKIE));
    drop(c, SIGN_OUT_COOKIE);
    if (!ticket) return back(c, '/login');
    const url = await client.endSessionUrl(`${publicOrigin(c, config)}/login`).catch(e => {
      console.warn(`[accounts] sign-out at Accounts unavailable: ${(e as Error).message}`);
      return null;
    });
    return url ? c.redirect(url, 302) : back(c, '/login');
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
    const startSession = async (cell: Cell, user: UserRow, sid: string | undefined) => {
      const session = await signIn(c, cell, user, true, sid);
      return c.json({ ...(await sessionInfo(cell.db, user)), ...session });
    };
    if (code.k === 'pending') return startSignUp(code.id);
    if (code.k === 'identity') {
      // Handed over by another regional host: decide here, where the account's region is served.
      const outcome = await resolve(c, code.id);
      if (outcome.kind === 'account') return startSession(outcome.cell, outcome.user, code.id.sessionId);
      if (outcome.kind === 'new') return startSignUp(outcome.id);
      const reason = outcome.kind === 'error' ? outcome.code : 'wrong_region';
      throw new HttpError(409, reason, ACCOUNTS_ERRORS[reason]);
    }
    const cell = cells.forRegion(code.region);
    const [user] = cell ? await cell.db.select().from(users).where(eq(users.id, code.uid)).limit(1) : [];
    if (!cell || !user) throw expired();
    return startSession(cell, user, code.sid);
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
    const { token, expiresAt } = await createSession(cell.db, user.region, user.id, config.sessionTtlMs, c.req.header('user-agent'), { sid: pending.sessionId });
    if (forApp) return c.json({ ...(await sessionInfo(cell.db, user)), token, expiresAt: expiresAt.toISOString() }, 201);
    writeSessionCookie(c, token, expiresAt, config.cookieSecure);
    return c.json(await sessionInfo(cell.db, user), 201);
  });

  return app;
}
