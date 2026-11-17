// LotusPond's sandbox hospital: synthetic patients, visits, documents and claims, so an organisation can build against
// the API and the MCP server from its first key, before any real system is connected. Every person here is made up.
// Uploaded documents are kept in memory per connection (at most 50 each) and disappear when the server restarts.
import { randomUUID } from 'node:crypto';
import type { HisAdapter, HisContext } from './types.ts';
import { HisError } from './types.ts';
import type { OperationInput, RunnableOperation } from './operations.ts';

const SYSTEM = 'https://health.lotuspond.ai/sandbox';
const MRN = `${SYSTEM}/mrn`;
const ABHA = 'https://healthid.abdm.gov.in';

interface SandboxPatient { id: string; mrn: string; abha: string; given: string; family: string; gender: 'male' | 'female'; birthDate: string; phone: string }
interface SandboxEncounter { id: string; patient: string; kind: 'AMB' | 'IMP'; start: string; end?: string; reason: string; department: string; docs: { id: string; title: string; text: string }[] }

// Synthetic people. ABHA numbers start 91-0000, which no real ABHA number does.
const PATIENTS: SandboxPatient[] = [
  { id: 'sbx-p-1001', mrn: 'MRN1001', abha: '91-0000-0000-1001', given: 'Asha', family: 'Raman', gender: 'female', birthDate: '1968-04-12', phone: '+919000001001' },
  { id: 'sbx-p-1002', mrn: 'MRN1002', abha: '91-0000-0000-1002', given: 'Vikram', family: 'Nair', gender: 'male', birthDate: '1975-09-30', phone: '+919000001002' },
  { id: 'sbx-p-1003', mrn: 'MRN1003', abha: '91-0000-0000-1003', given: 'Meera', family: 'Iyer', gender: 'female', birthDate: '1990-01-21', phone: '+919000001003' },
  { id: 'sbx-p-1004', mrn: 'MRN1004', abha: '91-0000-0000-1004', given: 'Rahul', family: 'Verma', gender: 'male', birthDate: '1983-06-05', phone: '+919000001004' },
  { id: 'sbx-p-1005', mrn: 'MRN1005', abha: '91-0000-0000-1005', given: 'Fatima', family: 'Sheikh', gender: 'female', birthDate: '1959-11-17', phone: '+919000001005' },
  { id: 'sbx-p-1006', mrn: 'MRN1006', abha: '91-0000-0000-1006', given: 'Arjun', family: 'Reddy', gender: 'male', birthDate: '2012-03-08', phone: '+919000001006' },
];

const ENCOUNTERS: SandboxEncounter[] = [
  { id: 'sbx-e-2001', patient: 'sbx-p-1001', kind: 'AMB', start: '2026-09-02T10:15:00+05:30', end: '2026-09-02T10:40:00+05:30', reason: 'Diabetes review', department: 'Endocrinology',
    docs: [{ id: 'sbx-d-3001', title: 'OPD note', text: 'Synthetic note. HbA1c 7.4%. Continue metformin 500 mg twice daily. Review in 3 months.' }] },
  { id: 'sbx-e-2002', patient: 'sbx-p-1001', kind: 'IMP', start: '2026-10-11T08:00:00+05:30', end: '2026-10-14T12:00:00+05:30', reason: 'Laparoscopic cholecystectomy', department: 'General Surgery',
    docs: [{ id: 'sbx-d-3002', title: 'Discharge summary', text: 'Synthetic discharge summary. Uneventful recovery. Paracetamol as needed. Suture check in 7 days.' }] },
  { id: 'sbx-e-2003', patient: 'sbx-p-1002', kind: 'AMB', start: '2026-10-20T16:00:00+05:30', end: '2026-10-20T16:25:00+05:30', reason: 'Chest pain on exertion', department: 'Cardiology',
    docs: [{ id: 'sbx-d-3003', title: 'OPD note', text: 'Synthetic note. ECG normal sinus rhythm. Treadmill test advised.' }] },
  { id: 'sbx-e-2004', patient: 'sbx-p-1003', kind: 'AMB', start: '2026-11-03T11:30:00+05:30', reason: 'Antenatal visit, 24 weeks', department: 'Obstetrics', docs: [] },
  { id: 'sbx-e-2005', patient: 'sbx-p-1005', kind: 'IMP', start: '2026-11-12T21:10:00+05:30', reason: 'Community-acquired pneumonia', department: 'Internal Medicine', docs: [] },
  { id: 'sbx-e-2006', patient: 'sbx-p-1006', kind: 'AMB', start: '2026-08-18T09:00:00+05:30', end: '2026-08-18T09:20:00+05:30', reason: 'Asthma follow-up', department: 'Paediatrics', docs: [] },
];

const CLAIMS: Record<string, { patient: string; status: 'approved' | 'query' | 'pending' | 'rejected'; insurer: string; amount: number; approved?: number; note: string }> = {
  'CLM-1001': { patient: 'sbx-p-1001', status: 'approved', insurer: 'Sandbox General Insurance', amount: 145000, approved: 132500, note: 'Approved with deductions for non-payable items.' },
  'CLM-1002': { patient: 'sbx-p-1005', status: 'query', insurer: 'Sandbox Health TPA', amount: 98000, note: 'Query raised: send the chest X-ray report and the admission notes.' },
  'PA-2001': { patient: 'sbx-p-1005', status: 'pending', insurer: 'Sandbox Health TPA', amount: 60000, note: 'Pre-authorisation under review.' },
  'CLM-1003': { patient: 'sbx-p-1002', status: 'rejected', insurer: 'Sandbox General Insurance', amount: 22000, note: 'Rejected: outpatient treatment is not covered by the policy.' },
};

const uploads = new Map<string, { id: string; patient: string; encounter?: string; title: string; contentType: string; size: number; author?: string; at: string }[]>();

const patientResource = (p: SandboxPatient) => ({
  resourceType: 'Patient', id: p.id,
  identifier: [{ system: MRN, value: p.mrn, type: { text: 'MRN' } }, { system: ABHA, value: p.abha, type: { text: 'ABHA number (synthetic)' } }],
  name: [{ use: 'official', given: [p.given], family: p.family, text: `${p.given} ${p.family}` }],
  gender: p.gender, birthDate: p.birthDate,
  telecom: [{ system: 'phone', value: p.phone, use: 'mobile' }],
  meta: { tag: [{ system: SYSTEM, code: 'synthetic', display: 'Synthetic sandbox data' }] },
});

const docResource = (d: { id: string; title: string; contentType: string; patient: string; encounter?: string; date: string; text?: string; size?: number; author?: string }) => ({
  resourceType: 'DocumentReference', id: d.id, status: 'current',
  type: { text: d.title }, subject: { reference: `Patient/${d.patient}` },
  ...(d.encounter ? { context: { encounter: [{ reference: `Encounter/${d.encounter}` }] } } : {}),
  ...(d.author ? { author: [{ display: d.author }] } : {}),
  date: d.date, description: d.title,
  content: [{ attachment: { contentType: d.contentType, title: d.title, ...(d.text ? { data: Buffer.from(d.text).toString('base64') } : {}), ...(d.size !== undefined ? { size: d.size } : {}) } }],
});

const bundle = (entries: unknown[]) => ({ resourceType: 'Bundle', type: 'searchset', total: entries.length, entry: entries.map(resource => ({ resource })) });

const digits = (s: string) => s.replace(/\D/g, '');

function search(input: OperationInput<'patients.search'>) {
  const id = input.identifier?.includes('|') ? input.identifier.split('|').pop()! : input.identifier;
  const name = input.name?.toLowerCase();
  const found = PATIENTS.filter(p =>
    (!id || p.mrn.toLowerCase() === id.toLowerCase() || digits(p.abha) === digits(id) || p.id === id)
    && (!name || `${p.given} ${p.family}`.toLowerCase().includes(name))
    && (!input.phone || digits(p.phone).endsWith(digits(input.phone).slice(-10)))
    && (!input.birthDate || p.birthDate === input.birthDate));
  return bundle(found.slice(0, input.limit).map(patientResource));
}

function encounters(ctx: HisContext, input: OperationInput<'encounters.list'>) {
  if (!PATIENTS.some(p => p.id === input.patient)) throw new HisError(404, 'patient_not_found', `No patient ${input.patient} in the sandbox hospital.`);
  const mine = uploads.get(ctx.connectionId) ?? [];
  const list = ENCOUNTERS.filter(e => e.patient === input.patient).sort((a, b) => b.start.localeCompare(a.start)).slice(0, input.limit);
  const entries: unknown[] = [];
  for (const e of list) {
    entries.push({
      resourceType: 'Encounter', id: e.id, status: e.end ? 'finished' : 'in-progress',
      class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: e.kind, display: e.kind === 'IMP' ? 'inpatient encounter' : 'ambulatory' },
      subject: { reference: `Patient/${e.patient}` }, period: { start: e.start, ...(e.end ? { end: e.end } : {}) },
      reasonCode: [{ text: e.reason }], serviceType: { text: e.department },
    });
    for (const d of e.docs) entries.push(docResource({ ...d, contentType: 'text/plain', patient: e.patient, encounter: e.id, date: e.end ?? e.start }));
    for (const u of mine.filter(x => x.encounter === e.id)) entries.push(docResource({ ...u, date: u.at }));
  }
  for (const u of mine.filter(x => x.patient === input.patient && !x.encounter)) entries.push(docResource({ ...u, date: u.at }));
  return bundle(entries);
}

function upload(ctx: HisContext, input: OperationInput<'documents.upload'>) {
  if (!PATIENTS.some(p => p.id === input.patient)) throw new HisError(404, 'patient_not_found', `No patient ${input.patient} in the sandbox hospital.`);
  if (input.encounter && !ENCOUNTERS.some(e => e.id === input.encounter && e.patient === input.patient)) {
    throw new HisError(404, 'encounter_not_found', `Encounter ${input.encounter} is not one of this patient's visits.`);
  }
  const list = uploads.get(ctx.connectionId) ?? [];
  const doc = { id: `sbx-d-${randomUUID().slice(0, 8)}`, patient: input.patient, encounter: input.encounter, title: input.title, contentType: input.contentType,
    size: Buffer.from(input.data, 'base64').length, author: input.author, at: ctx.now.toISOString() };
  list.push(doc);
  uploads.set(ctx.connectionId, list.slice(-50));
  return docResource({ ...doc, date: doc.at });
}

function claim(input: OperationInput<'claims.status'>) {
  const c = CLAIMS[input.claim.toUpperCase()];
  if (!c) throw new HisError(404, 'claim_not_found', `No claim ${input.claim} in the sandbox. Try CLM-1001, CLM-1002, CLM-1003 or PA-2001.`);
  const outcome = c.status === 'approved' ? 'complete' : c.status === 'rejected' ? 'error' : c.status === 'query' ? 'partial' : 'queued';
  return {
    resourceType: 'ClaimResponse', id: `sbx-cr-${input.claim.toUpperCase()}`, status: 'active',
    type: { text: input.claim.toUpperCase().startsWith('PA-') ? 'Pre-authorisation' : 'Claim' },
    use: input.claim.toUpperCase().startsWith('PA-') ? 'preauthorization' : 'claim',
    patient: { reference: `Patient/${c.patient}` }, insurer: { display: c.insurer },
    request: { identifier: { value: input.claim.toUpperCase() } },
    outcome, disposition: c.note,
    total: [
      { category: { text: 'submitted' }, amount: { value: c.amount, currency: 'INR' } },
      ...(c.approved !== undefined ? [{ category: { text: 'benefit' }, amount: { value: c.approved, currency: 'INR' } }] : []),
    ],
    extension: [{ url: `${SYSTEM}/claim-status`, valueCode: c.status }],
  };
}

export const sandboxAdapter: HisAdapter = {
  connectorId: 'sandbox',
  operations: ['patients.search', 'encounters.list', 'documents.upload', 'claims.status'],
  requiredSettings: [],
  async run<O extends RunnableOperation>(op: O, input: OperationInput<O>, ctx: HisContext) {
    switch (op) {
      case 'patients.search': return search(input as OperationInput<'patients.search'>);
      case 'encounters.list': return encounters(ctx, input as OperationInput<'encounters.list'>);
      case 'documents.upload': return upload(ctx, input as OperationInput<'documents.upload'>);
      case 'claims.status': return claim(input as OperationInput<'claims.status'>);
    }
    throw new HisError(400, 'not_supported', `The sandbox does not run ${op}.`);
  },
};
