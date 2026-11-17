// A FHIR R4 adapter for any hospital system that exposes the standard REST API: Bahmni and OpenMRS (the FHIR2 module),
// InterSystems TrakCare (through the hospital's interoperability toolkit) and any other FHIR R4 server. LotusPond
// adds a connection only with the hospital's written authority, and with the address and credentials its IT team
// gives; the adapter never signs in as a person and never works around the server's own access controls.
//
// Settings: baseUrl (the FHIR root, e.g. https://his.example.org/openmrs/ws/fhir2/R4). Credentials: a bearer token,
// or a user name and password for HTTP Basic, or none.
import type { HisAdapter, HisContext } from './types.ts';
import { HisError } from './types.ts';
import type { OperationInput, RunnableOperation } from './operations.ts';

const TIMEOUT_MS = 20_000;
type Resource = { resourceType?: string; id?: string; [k: string]: unknown };
type Bundle = { resourceType: 'Bundle'; entry?: { resource?: Resource }[] };

/** The FHIR root: https only, except a server on this machine (tests and local development). */
export function fhirBase(settings: Record<string, string>): URL {
  let u: URL;
  try { u = new URL(settings.baseUrl ?? ''); } catch { throw new HisError(422, 'bad_connection', 'This connection has no valid FHIR address. LotusPond needs to fix it.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new HisError(422, 'bad_connection', 'This connection must use https.');
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  return u;
}

async function call(ctx: HisContext, method: 'GET' | 'POST', path: string, query?: Record<string, string | undefined>, body?: unknown): Promise<Resource | null> {
  const url = new URL(path, fhirBase(ctx.settings));
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== '') url.searchParams.set(k, v);
  const headers: Record<string, string> = { Accept: 'application/fhir+json' };
  if (body !== undefined) headers['Content-Type'] = 'application/fhir+json';
  const s = ctx.secret;
  if (s?.token) headers.Authorization = `Bearer ${s.token}`;
  else if (s?.username) headers.Authorization = `Basic ${Buffer.from(`${s.username}:${s.password ?? ''}`).toString('base64')}`;
  let res: Response;
  try {
    res = await ctx.fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
  } catch (e) {
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new HisError(504, 'system_timeout', 'The hospital system did not answer in time. Try again.');
    throw new HisError(502, 'system_unreachable', 'The hospital system could not be reached.');
  }
  if (res.status === 404) return null;
  if (res.status === 401 || res.status === 403) throw new HisError(502, 'system_refused', "The hospital system refused LotusPond's credentials for this connection. LotusPond has been told.");
  if (res.status === 400 || res.status === 422) throw new HisError(422, 'system_rejected', 'The hospital system rejected the request. Check the input.');
  if (!res.ok) throw new HisError(502, 'system_error', `The hospital system answered with an error (${res.status}).`);
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text) as Resource; } catch { throw new HisError(502, 'system_error', 'The hospital system did not answer with FHIR JSON.'); }
}

const entries = (b: Resource | null, type: string): Resource[] =>
  ((b as Bundle | null)?.entry ?? []).map(e => e.resource).filter((r): r is Resource => !!r && r.resourceType === type);

/** A plain searchset with only the resources: no links or paging addresses that would point at the hospital's server. */
const bundle = (resources: Resource[]) => ({ resourceType: 'Bundle', type: 'searchset', total: resources.length, entry: resources.map(resource => ({ resource })) });

async function searchPatients(ctx: HisContext, input: OperationInput<'patients.search'>) {
  const b = await call(ctx, 'GET', 'Patient', {
    identifier: input.identifier, name: input.name, telecom: input.phone ? `phone|${input.phone.replace(/\s/g, '')}` : undefined,
    birthdate: input.birthDate, _count: String(input.limit),
  });
  return bundle(entries(b, 'Patient').slice(0, input.limit));
}

async function listEncounters(ctx: HisContext, input: OperationInput<'encounters.list'>) {
  const patient = await call(ctx, 'GET', `Patient/${encodeURIComponent(input.patient)}`);
  if (!patient || patient.resourceType !== 'Patient') throw new HisError(404, 'patient_not_found', `No patient ${input.patient} in this system.`);
  const enc = entries(await call(ctx, 'GET', 'Encounter', { patient: input.patient, _sort: '-date', _count: String(input.limit) }), 'Encounter').slice(0, input.limit);
  // Not every server offers DocumentReference search (some OpenMRS versions do not): visits are still returned.
  let docs: Resource[] = [];
  try { docs = entries(await call(ctx, 'GET', 'DocumentReference', { patient: input.patient, _count: '50' }), 'DocumentReference'); } catch (e) {
    if (!(e instanceof HisError) || e.status !== 422) throw e;
  }
  return bundle([...enc, ...docs]);
}

async function uploadDocument(ctx: HisContext, input: OperationInput<'documents.upload'>) {
  const resource = {
    resourceType: 'DocumentReference', status: 'current', docStatus: 'final',
    type: { text: input.title }, description: input.title,
    subject: { reference: `Patient/${input.patient}` },
    ...(input.encounter ? { context: { encounter: [{ reference: `Encounter/${input.encounter}` }] } } : {}),
    ...(input.author ? { author: [{ display: input.author }] } : {}),
    date: ctx.now.toISOString(),
    content: [{ attachment: { contentType: input.contentType, title: input.title, data: input.data } }],
  };
  const created = await call(ctx, 'POST', 'DocumentReference', undefined, resource);
  // Servers may answer 201 with the resource, or with no body (return=minimal): either way the write happened.
  if (created?.resourceType === 'DocumentReference') return created;
  return { ...resource, content: [{ attachment: { contentType: input.contentType, title: input.title } }] };
}

export function fhirAdapter(connectorId: string): HisAdapter {
  return {
    connectorId,
    operations: ['patients.search', 'encounters.list', 'documents.upload'],
    requiredSettings: ['baseUrl'],
    async run<O extends RunnableOperation>(op: O, input: OperationInput<O>, ctx: HisContext) {
      switch (op) {
        case 'patients.search': return searchPatients(ctx, input as OperationInput<'patients.search'>);
        case 'encounters.list': return listEncounters(ctx, input as OperationInput<'encounters.list'>);
        case 'documents.upload': return uploadDocument(ctx, input as OperationInput<'documents.upload'>);
      }
      throw new HisError(400, 'not_supported', `This connection does not run ${op}.`);
    },
  };
}
