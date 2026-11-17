// Eka Care EMR: patients and their visits in a clinic's Eka workspace, through Eka's published developer APIs
// (https://developer.eka.care, read 17 November 2026). The clinic grants access by giving a sharing key for its
// workspace; LotusPond adds the connection with an Eka API client's id and secret and that key, after checking the
// clinic's written authority. Nothing here signs in as a person.
//
//   Sign-in   POST /connect-auth/v1/account/login { client_id, client_secret, sharing_key? } → access_token, expires_in
//   Patients  GET /profiles/v1/patient/by-mobile/?mob=+91…&full_profile=true      by mobile number
//             GET /profiles/v1/patient/{username}/username/?flatten=true          by the clinic's patient id (UHID)
//             GET /profiles/v1/patient/{oid}                                      by Eka's id
//             GET /profiles/v1/patient/search?prefix=…                            by name (only some workspaces)
//   Visits    GET /dr/v1/appointment?patient_id={oid}&page_no=0                    appointments, with prescription PDFs
//
// Settings: baseUrl (optional; https://api.eka.care, or https://api.dev.eka.care for Eka's sandbox).
// Credentials: clientId, clientSecret and the clinic's sharingKey.
import { createHash } from 'node:crypto';
import type { HisAdapter, HisContext } from './types.ts';
import { HisError } from './types.ts';
import type { OperationInput, RunnableOperation } from './operations.ts';

export const EKA_DEFAULT_BASE = 'https://api.eka.care';
const TIMEOUT_MS = 20_000;
const SYSTEM = 'https://eka.care';
const OID = `${SYSTEM}/oid`;
const USERNAME = `${SYSTEM}/username`;
const ABHA = 'https://healthid.abdm.gov.in';

type Json = Record<string, unknown>;
interface EkaProfile { oid?: string; username?: string; fln?: string; fn?: string; ln?: string; gen?: string; dob?: string; mobile?: string; ccd?: string; email?: string; abha?: string }
interface EkaAppointment {
  appointment_id?: string; patient_id?: string; doctor_id?: string; clinic_id?: string; status?: string; mode?: string;
  start_time?: number; end_time?: number; prescription_id?: string; prescription_url?: string; channel?: string;
}

/** The API's root: https only, except a server on this machine (tests). */
function base(settings: Record<string, string>): URL {
  let u: URL;
  try { u = new URL(settings.baseUrl || EKA_DEFAULT_BASE); } catch { throw new HisError(422, 'bad_connection', 'This Eka connection has no valid address. LotusPond needs to fix it.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new HisError(422, 'bad_connection', 'This Eka connection must use https.');
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  return u;
}

// Access tokens, kept in memory per connection and credentials, renewed at 80% of their life and once more on a 401.
const tokens = new Map<string, { token: string; renewAt: number }>();
const tokenKey = (ctx: HisContext) => `${ctx.connectionId}:${createHash('sha256').update(JSON.stringify([ctx.settings.baseUrl ?? '', ctx.secret?.clientId, ctx.secret?.clientSecret, ctx.secret?.sharingKey])).digest('hex')}`;

async function send(ctx: HisContext, url: URL, init: RequestInit): Promise<Response> {
  try {
    return await ctx.fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
  } catch (e) {
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new HisError(504, 'system_timeout', 'Eka Care did not answer in time. Try again.');
    throw new HisError(502, 'system_unreachable', 'Eka Care could not be reached.');
  }
}

async function accessToken(ctx: HisContext, fresh = false): Promise<string> {
  const s = ctx.secret;
  if (!s?.clientId || !s.clientSecret) throw new HisError(422, 'bad_connection', 'This Eka connection has no API client credentials. LotusPond needs to set them.');
  const key = tokenKey(ctx);
  const cached = tokens.get(key);
  const now = ctx.now.getTime();
  if (!fresh && cached && cached.renewAt > now) return cached.token;
  const res = await send(ctx, new URL('connect-auth/v1/account/login', base(ctx.settings)), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: s.clientId, client_secret: s.clientSecret, ...(s.sharingKey ? { sharing_key: s.sharingKey } : {}) }),
  });
  if (res.status === 400 || res.status === 401 || res.status === 403) throw new HisError(502, 'system_refused', "Eka Care refused LotusPond's credentials for this connection. LotusPond has been told.");
  if (!res.ok) throw new HisError(502, 'system_error', `Eka Care's sign-in answered with an error (${res.status}).`);
  const body = await res.json().catch(() => null) as { access_token?: string; expires_in?: number } | null;
  if (!body?.access_token) throw new HisError(502, 'system_error', 'Eka Care did not return an access token.');
  tokens.set(key, { token: body.access_token, renewAt: now + Math.max(30, body.expires_in ?? 1800) * 800 });
  return body.access_token;
}

/** A GET to Eka with the access token; null on 404. Renews the token once if Eka says it has expired. */
async function get(ctx: HisContext, path: string, query: Record<string, string | undefined> = {}): Promise<unknown> {
  const url = new URL(path, base(ctx.settings));
  for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, v);
  for (const fresh of [false, true]) {
    const token = await accessToken(ctx, fresh);
    // Eka's EMR docs show the token both as `Authorization: Bearer` and as an `auth` header; both are sent. The
    // client id goes in `client-id`, as the patient directory APIs require.
    const res = await send(ctx, url, { method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, auth: token, 'client-id': ctx.secret!.clientId! } });
    if (res.status === 401 && !fresh) continue;
    if (res.status === 404) return null;
    if (res.status === 401 || res.status === 403) throw new HisError(502, 'system_refused', 'Eka Care refused this request for the connection. LotusPond has been told.');
    if (res.status === 400 || res.status === 422) throw new HisError(422, 'system_rejected', 'Eka Care rejected the request. Check the input.');
    if (!res.ok) throw new HisError(502, 'system_error', `Eka Care answered with an error (${res.status}).`);
    return res.json().catch(() => { throw new HisError(502, 'system_error', 'Eka Care did not answer with JSON.'); });
  }
  throw new HisError(502, 'system_refused', 'Eka Care refused this request for the connection.');
}

/** Profiles from any of Eka's shapes: an array, one profile, or a wrapper holding a list. */
function profiles(body: unknown): EkaProfile[] {
  if (Array.isArray(body)) return body.filter((x): x is EkaProfile => !!x && typeof x === 'object');
  if (body && typeof body === 'object') {
    const o = body as Json;
    for (const k of ['profiles', 'patients', 'data', 'results']) if (Array.isArray(o[k])) return profiles(o[k]);
    if (typeof o.oid === 'string') return [o as EkaProfile];
  }
  return [];
}

const GENDER: Record<string, string> = { M: 'male', F: 'female', O: 'other', U: 'unknown' };

export function ekaPatient(p: EkaProfile) {
  const mobile = p.mobile ? `${p.ccd ?? ''}${p.mobile}` : undefined;
  return {
    resourceType: 'Patient', id: p.oid,
    identifier: [
      { system: OID, value: p.oid, type: { text: 'Eka profile id' } },
      ...(p.username ? [{ system: USERNAME, value: p.username, type: { text: 'Clinic patient id (UHID)' } }] : []),
      ...(p.abha ? [{ system: ABHA, value: p.abha, type: { text: 'ABHA address' } }] : []),
    ],
    name: [{ text: p.fln ?? [p.fn, p.ln].filter(Boolean).join(' '), ...(p.fn ? { given: [p.fn] } : {}), ...(p.ln ? { family: p.ln } : {}) }],
    ...(p.gen && GENDER[p.gen.toUpperCase()] ? { gender: GENDER[p.gen.toUpperCase()] } : {}),
    ...(p.dob ? { birthDate: p.dob } : {}),
    telecom: [
      ...(mobile ? [{ system: 'phone', value: mobile, use: 'mobile' }] : []),
      ...(p.email ? [{ system: 'email', value: p.email }] : []),
    ],
  };
}

const ENCOUNTER_STATUS: Record<string, string> = {
  BK: 'planned', CK: 'arrived', RV: 'planned', IN: 'planned', PA: 'planned', OG: 'in-progress',
  CM: 'finished', CMNP: 'finished', AB: 'cancelled', CN: 'cancelled', CND: 'cancelled', CNS: 'cancelled', PNR: 'cancelled',
  RE: 'planned', RES: 'planned', RED: 'planned',
};
const iso = (seconds?: number) => (typeof seconds === 'number' && seconds > 0 ? new Date(seconds * 1000).toISOString() : undefined);

export function ekaEncounter(a: EkaAppointment) {
  const start = iso(a.start_time);
  const end = iso(a.end_time);
  return {
    resourceType: 'Encounter', id: a.appointment_id,
    status: ENCOUNTER_STATUS[a.status ?? ''] ?? 'unknown',
    class: a.mode === 'tele'
      ? { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'VR', display: 'virtual' }
      : { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' },
    subject: { reference: `Patient/${a.patient_id}` },
    ...(start ? { period: { start, ...(end && end !== start ? { end } : {}) } } : {}),
    ...(a.doctor_id ? { participant: [{ individual: { identifier: { system: `${SYSTEM}/doctor`, value: a.doctor_id } } }] } : {}),
    ...(a.clinic_id ? { serviceProvider: { identifier: { system: `${SYSTEM}/clinic`, value: a.clinic_id } } } : {}),
    extension: [{ url: `${SYSTEM}/appointment-status`, valueCode: a.status ?? 'unknown' }],
  };
}

function prescription(a: EkaAppointment) {
  if (!a.prescription_url || !/^https:\/\//.test(a.prescription_url)) return null;
  return {
    resourceType: 'DocumentReference', id: a.prescription_id ?? `rx-${a.appointment_id}`, status: 'current',
    type: { text: 'Prescription' }, description: 'Prescription',
    subject: { reference: `Patient/${a.patient_id}` },
    context: { encounter: [{ reference: `Encounter/${a.appointment_id}` }] },
    ...(iso(a.end_time ?? a.start_time) ? { date: iso(a.end_time ?? a.start_time) } : {}),
    content: [{ attachment: { contentType: 'application/pdf', title: 'Prescription', url: a.prescription_url } }],
  };
}

const bundle = (resources: unknown[]) => ({ resourceType: 'Bundle', type: 'searchset', total: resources.length, entry: resources.map(resource => ({ resource })) });
const digits = (s: string) => s.replace(/\D/g, '');

/** A mobile number as Eka wants it: +<country code><number>, India assumed for ten digits. */
function mobileForEka(phone: string): string {
  const d = digits(phone);
  if (phone.trim().startsWith('+')) return `+${d}`;
  return d.length === 10 ? `+91${d}` : `+${d}`;
}

async function searchPatients(ctx: HisContext, input: OperationInput<'patients.search'>) {
  let found: EkaProfile[] = [];
  if (input.phone) {
    found = profiles(await get(ctx, 'profiles/v1/patient/by-mobile/', { mob: mobileForEka(input.phone), full_profile: 'true' }));
  } else if (input.identifier) {
    const id = input.identifier.includes('|') ? input.identifier.split('|').pop()!.trim() : input.identifier.trim();
    if (!/^[A-Za-z0-9._@-]{1,64}$/.test(id)) throw new HisError(400, 'invalid_input', 'That identifier has characters Eka does not use.');
    found = profiles(await get(ctx, `profiles/v1/patient/${encodeURIComponent(id)}/username/`, { flatten: 'true' }));
    // An Eka profile id is all digits; try it as one when no clinic id matched.
    if (!found.length && /^\d{6,}$/.test(id)) found = profiles(await get(ctx, `profiles/v1/patient/${id}`));
  } else if (input.name) {
    try {
      found = profiles(await get(ctx, 'profiles/v1/patient/search', { prefix: input.name, limit: String(Math.min(input.limit, 50)), select: 'abha,dob,gen' }));
    } catch (e) {
      if (e instanceof HisError && (e.code === 'system_refused' || e.code === 'system_rejected')) {
        throw new HisError(422, 'name_search_unavailable', 'This Eka workspace does not allow search by name. Search by mobile number or the clinic’s patient id instead.');
      }
      throw e;
    }
  }
  // Narrow on what the person gave alongside the main key (Eka filters on one key at a time).
  const name = input.name?.toLowerCase();
  const matched = found.filter(p => p.oid
    && (!input.birthDate || !p.dob || p.dob === input.birthDate)
    && (!name || !(input.phone || input.identifier) || (p.fln ?? `${p.fn ?? ''} ${p.ln ?? ''}`).toLowerCase().includes(name)));
  return bundle(matched.slice(0, input.limit).map(ekaPatient));
}

async function listEncounters(ctx: HisContext, input: OperationInput<'encounters.list'>) {
  if (!/^\d{1,32}$/.test(input.patient)) throw new HisError(404, 'patient_not_found', `No patient ${input.patient} in this Eka workspace.`);
  const patient = profiles(await get(ctx, `profiles/v1/patient/${input.patient}`));
  if (!patient.length) throw new HisError(404, 'patient_not_found', `No patient ${input.patient} in this Eka workspace.`);
  const body = await get(ctx, 'dr/v1/appointment', { patient_id: input.patient, page_no: '0' }) as { appointments?: EkaAppointment[] } | null;
  const appointments = (body?.appointments ?? [])
    .filter(a => a && a.appointment_id && (!a.patient_id || a.patient_id === input.patient))
    .map(a => ({ ...a, patient_id: input.patient }))
    .sort((a, b) => (b.start_time ?? 0) - (a.start_time ?? 0))
    .slice(0, input.limit);
  const resources: unknown[] = [];
  for (const a of appointments) {
    resources.push(ekaEncounter(a));
    const rx = prescription(a);
    if (rx) resources.push(rx);
  }
  return bundle(resources);
}

export const ekaAdapter: HisAdapter = {
  connectorId: 'eka',
  operations: ['patients.search', 'encounters.list'],
  requiredSettings: [],
  async run<O extends RunnableOperation>(op: O, input: OperationInput<O>, ctx: HisContext) {
    switch (op) {
      case 'patients.search': return searchPatients(ctx, input as OperationInput<'patients.search'>);
      case 'encounters.list': return listEncounters(ctx, input as OperationInput<'encounters.list'>);
    }
    throw new HisError(400, 'not_supported', `Eka Care connections do not run ${op}.`);
  },
};

/** For tests: forget cached tokens. */
export function resetEkaTokens(): void { tokens.clear(); }
