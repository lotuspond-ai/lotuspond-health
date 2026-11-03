// Shared by the compliance and file tests: a browser-like client for app.request(), and sign-up bodies.
import assert from 'node:assert/strict';
import type { Hono } from 'hono';
import type { AppEnv } from '../src/http.ts';
import type { RegisterInput } from '../../shared/types.ts';

let clients = 0;

/** Keeps the session cookie and sends same-origin fetch metadata, like the app in a browser. */
export function makeClient(app: Hono<AppEnv>, opts: { ip?: string; userAgent?: string } = {}) {
  const ip = opts.ip ?? `10.1.${++clients % 250}.${Math.floor(clients / 250) + 1}`;
  let cookie = '';
  async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { 'sec-fetch-site': 'same-origin', 'x-forwarded-for': ip, ...headers };
    if (opts.userAgent) h['user-agent'] = opts.userAgent;
    if (cookie) h.cookie = cookie;
    let payload: FormData | string | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
    const res = await app.request(url, { method, headers: h, body: payload });
    const set = res.headers.get('set-cookie');
    if (set) {
      const [pair] = set.split(';');
      cookie = pair.endsWith('=') ? '' : pair;
    }
    return res;
  }
  return {
    ip,
    call,
    get cookie() { return cookie; },
    set cookie(v: string) { cookie = v; },
    json: async <T>(method: string, url: string, body?: unknown, expect = 200): Promise<T> => {
      const res = await call(method, url, body);
      const text = await res.text();
      assert.equal(res.status, expect, `${method} ${url} → ${res.status} ${text}`);
      return (text ? JSON.parse(text) : null) as T;
    },
    /** Status and error code of a request expected to fail. */
    error: async (method: string, url: string, body?: unknown) => {
      const res = await call(method, url, body);
      const data = await res.json().catch(() => null) as { error?: { code: string; message: string } } | null;
      return { status: res.status, code: data?.error?.code, message: data?.error?.message ?? '' };
    },
  };
}

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
