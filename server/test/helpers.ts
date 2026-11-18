// Shared by the tests: a browser-like client for app.request(), sign-up through the stand-in Accounts, and sign-up bodies.
import assert from 'node:assert/strict';
import type { Hono } from 'hono';
import type { AppEnv } from '../src/http.ts';
import type { RegisterInput, SessionInfo } from '../../shared/types.ts';
import { countryPolicy } from '../../shared/regions.ts';

let clients = 0;

/**
 * Keeps cookies by name and sends same-origin fetch metadata, like the app in a browser. `signUp` makes an account the
 * way people do once Health passwords are off: through LotusPond Accounts, here the stand-in issuer inside the server
 * (its config needs ACCOUNTS_ISSUER=fake).
 */
export function makeClient(app: Hono<AppEnv>, opts: { ip?: string; userAgent?: string } = {}) {
  const ip = opts.ip ?? `10.1.${++clients % 250}.${Math.floor(clients / 250) + 1}`;
  const jar = new Map<string, string>();
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { 'sec-fetch-site': 'same-origin', 'x-forwarded-for': ip, ...headers };
    if (opts.userAgent) h['user-agent'] = opts.userAgent;
    if (jar.size) h.cookie = cookieHeader();
    let payload: FormData | string | undefined;
    if (body instanceof FormData) payload = body;
    else if (body instanceof URLSearchParams) { payload = body.toString(); h['content-type'] = 'application/x-www-form-urlencoded'; }
    else if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
    const res = await app.request(url, { method, headers: h, body: payload });
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';');
      const at = pair.indexOf('=');
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1);
      const gone = !value || attrs.some(a => /^\s*max-age=0\s*$/i.test(a)) || attrs.some(a => /^\s*expires=Thu, 01 Jan 1970/i.test(a));
      if (gone) jar.delete(name); else jar.set(name, value);
    }
    return res;
  }
  const json = async <T>(method: string, url: string, body?: unknown, expect = 200): Promise<T> => {
    const res = await call(method, url, body);
    const text = await res.text();
    assert.equal(res.status, expect, `${method} ${url} → ${res.status} ${text}`);
    return (text ? JSON.parse(text) : null) as T;
  };
  /** Through the stand-in Accounts to Health's own sign-up questions; answers as POST /api/auth/accounts/complete does. */
  async function signUpCall(body: RegisterInput, who: { region?: string; verified?: boolean } = {}) {
    const start = await call('GET', '/api/auth/accounts/start?intent=signup');
    assert.equal(start.status, 302, 'Accounts sign-in is on (ACCOUNTS_ISSUER=fake)');
    const authorize = new URL(start.headers.get('location')!, 'http://localhost');
    const form = new URLSearchParams();
    for (const k of ['client_id', 'redirect_uri', 'state', 'nonce', 'code_challenge']) form.set(k, authorize.searchParams.get(k)!);
    form.set('email', body.email);
    if (who.verified !== false) form.set('email_verified', 'true');
    form.set('region', who.region ?? regionOf(body.country));
    const issued = await call('POST', authorize.pathname, form);
    assert.equal(issued.status, 302, await issued.clone().text());
    const back = await call('GET', issued.headers.get('location')!);
    assert.equal(back.status, 302, await back.clone().text());
    const { email: _email, password: _password, ...answers } = body;
    return call('POST', '/api/auth/accounts/complete', answers);
  }
  return {
    ip,
    call,
    get cookie() { return cookieHeader(); },
    set cookie(v: string) {
      jar.clear();
      for (const part of v.split(';')) { const at = part.indexOf('='); if (at > 0) jar.set(part.slice(0, at).trim(), part.slice(at + 1)); }
    },
    json,
    /** Status and error code of a request expected to fail. */
    error: async (method: string, url: string, body?: unknown) => {
      const res = await call(method, url, body);
      const data = await res.json().catch(() => null) as { error?: { code: string; message: string } } | null;
      return { status: res.status, code: data?.error?.code, message: data?.error?.message ?? '' };
    },
    signUpCall,
    /** Sign up through Accounts and expect it to work: the new session's SessionInfo. */
    signUp: async <T = SessionInfo>(body: RegisterInput, who: { region?: string } = {}): Promise<T> => {
      const res = await signUpCall(body, who);
      const text = await res.text();
      assert.equal(res.status, 201, `sign-up through Accounts → ${res.status} ${text}`);
      return JSON.parse(text) as T;
    },
  };
}

/** The region Accounts holds a person in, from their country (shared/regions.ts). */
const regionOf = (country: string): string => countryPolicy(country).region;

export type TestClient = ReturnType<typeof makeClient>;

/** A sign-up body that meets every rule for the country; override any part. */
export function registration(email: string, country = 'IN', over: Partial<RegisterInput> = {}): RegisterInput {
  return {
    email, password: 'correct horse battery', displayName: 'Asha Rao', country, ageConfirmed: true,
    consents: { termsAndPrivacy: true, healthData: true, crossBorder: true, marketing: false },
    ...over,
  };
}

export const measurement = (over: Record<string, unknown> = {}) => ({
  markerId: 'ldl', rawName: 'LDL Cholesterol', value: 138, valueText: '138', unit: 'mg/dL',
  range: { high: 100, text: '< 100', source: 'report' }, status: 'high', date: '2026-03-14',
  sourceFile: 'report.pdf', confidence: 'high', ...over,
});

export async function upload(c: TestClient, profileId: string, name: string, bytes: Uint8Array, type = 'application/pdf') {
  const form = new FormData();
  form.append('file', new File([bytes], name, { type }));
  form.append('kind', 'report');
  const res = await c.call('POST', `/api/profiles/${profileId}/documents`, form);
  assert.equal(res.status, 201, await res.clone().text());
  return await res.json() as { id: string };
}

/**
 * Someone with a LotusPond Health account who opens the developer console (it uses the Health sign-in), optionally
 * making an organisation there. Needs ACCOUNTS_ISSUER=fake, like `signUp`.
 */
export async function consoleUser(app: Hono<AppEnv>, email: string, organisation?: { name: string; region: string }) {
  const person = makeClient(app);
  await person.signUp(registration(email));
  const org = organisation
    ? await person.json<{ id: string; access: string; role: string; approves: boolean }>('POST', '/api/console/organisations', organisation, 201)
    : (await person.json('GET', '/api/console'), null);
  return { person, org };
}
