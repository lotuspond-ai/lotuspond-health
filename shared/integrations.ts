// Hospital and clinic systems an organisation can reach through LotusPond Health's organisation API and MCP server,
// with an honest status for each. Shared by the server's catalogue (GET /v1/connectors), the developers page and the
// developer console, so they never disagree. See docs/connectors.md ("Which hospital systems to build for").
//
// Status:
//   available    runs today: call it with a key (the sandbox) or once LotusPond has set up the connection
//   on_request   runs today through an open standard (FHIR R4); LotusPond sets it up per hospital, with the hospital's
//                written authority and its IT team switching the interface on
//   in_build     the vendor publishes developer access; LotusPond's adapter is being built
//   planned      needs the vendor's partnership or a national network's onboarding first; not offered yet
//
// No entry claims a partnership: none of these vendors has a signed agreement with LotusPond. Names are the vendors'
// own product names, used only to say which systems a connection can reach.

export type IntegrationStatus = 'available' | 'on_request' | 'in_build' | 'planned';
export type IntegrationKind = 'sandbox' | 'fhir' | 'vendor_api' | 'national';

export interface Integration {
  id: string;
  name: string;
  /** Who makes it, or "Open source". */
  vendor: string;
  kind: IntegrationKind;
  status: IntegrationStatus;
  /** How LotusPond reaches it, in a few words. */
  how: string;
  /** Hospital groups or settings known to run it (public sources, November 2026). */
  usedBy: string;
  /** Organisation operations it supports once available. */
  operations: ('patients.search' | 'encounters.list' | 'documents.upload' | 'claims.status' | 'preauth.submit')[];
}

export const INTEGRATIONS: readonly Integration[] = [
  {
    id: 'sandbox', name: 'LotusPond sandbox hospital', vendor: 'LotusPond', kind: 'sandbox', status: 'available',
    how: 'Synthetic patients, visits and claims, for building and testing', usedBy: 'Every new organisation, from the first key',
    operations: ['patients.search', 'encounters.list', 'documents.upload', 'claims.status'],
  },
  {
    id: 'fhir', name: 'Any FHIR R4 server', vendor: 'HL7 FHIR standard', kind: 'fhir', status: 'on_request',
    how: 'FHIR R4 REST: Patient, Encounter and DocumentReference', usedBy: 'Hospitals whose HIS exposes FHIR R4',
    operations: ['patients.search', 'encounters.list', 'documents.upload'],
  },
  {
    id: 'bahmni', name: 'Bahmni and OpenMRS', vendor: 'Open source', kind: 'fhir', status: 'on_request',
    how: 'OpenMRS FHIR2 module (FHIR R4)', usedBy: 'Public and non-profit hospitals and clinics',
    operations: ['patients.search', 'encounters.list', 'documents.upload'],
  },
  {
    id: 'trakcare', name: 'TrakCare', vendor: 'InterSystems', kind: 'fhir', status: 'on_request',
    how: "FHIR R4 through the hospital's InterSystems interoperability toolkit", usedBy: 'Manipal Hospitals, Sir Ganga Ram Hospital',
    operations: ['patients.search', 'encounters.list', 'documents.upload'],
  },
  {
    id: 'eka', name: 'Eka Care EMR', vendor: 'Eka Care', kind: 'vendor_api', status: 'on_request',
    how: "Eka's published EMR APIs, with the clinic's sharing key for its Eka workspace", usedBy: 'Clinics and doctors using Eka',
    operations: ['patients.search', 'encounters.list'],
  },
  {
    id: 'abdm', name: 'ABDM-certified HIS (consented records)', vendor: 'National Health Authority', kind: 'national', status: 'planned',
    how: "ABDM health-information-user flow, with each patient's consent", usedBy: 'C-DAC e-Sushrut, NIC NextGen eHospital and other certified systems',
    operations: ['encounters.list'],
  },
  {
    id: 'nhcx', name: 'NHCX claims exchange', vendor: 'National Health Authority', kind: 'national', status: 'planned',
    how: 'National Health Claims Exchange (FHIR claim profiles)', usedBy: 'Insurers and TPAs on NHCX',
    operations: ['claims.status', 'preauth.submit'],
  },
  {
    id: 'akhil', name: 'Miracle HIS', vendor: 'Akhil Systems', kind: 'vendor_api', status: 'planned',
    how: "Needs Akhil Systems' partnership", usedBy: 'Aster, Paras, probably CARE',
    operations: ['patients.search', 'encounters.list', 'documents.upload'],
  },
  {
    id: 'karexpert', name: 'KareXpert', vendor: 'KareXpert', kind: 'vendor_api', status: 'planned',
    how: "Needs KareXpert's partnership", usedBy: 'Artemis and mid-size hospitals',
    operations: ['patients.search', 'encounters.list', 'documents.upload'],
  },
  {
    id: 'insta', name: 'Insta HMS', vendor: 'Practo', kind: 'vendor_api', status: 'planned',
    how: "Needs Practo's partnership", usedBy: 'Clinic chains and hospitals',
    operations: ['patients.search', 'encounters.list', 'documents.upload'],
  },
  {
    id: 'suvarna', name: 'Suvarna HIMS', vendor: 'Suvarna Technosoft', kind: 'vendor_api', status: 'planned',
    how: "Needs Suvarna's partnership", usedBy: 'Probably KIMS; medical colleges',
    operations: ['patients.search', 'encounters.list', 'documents.upload', 'claims.status'],
  },
  {
    id: 'mocdoc', name: 'MocDoc', vendor: 'Yro Systems', kind: 'vendor_api', status: 'planned',
    how: "Published REST API; keys come through each MocDoc customer", usedBy: 'Small and mid-size hospitals and clinics',
    operations: ['patients.search', 'encounters.list'],
  },
] as const;

export const INTEGRATION_STATUS_TEXT: Record<IntegrationStatus, { label: string; detail: string }> = {
  available: { label: 'Available', detail: 'Works today with an API key.' },
  on_request: { label: 'Available on request', detail: "Works today through FHIR R4 or the vendor's published API. We set it up for your hospital or clinic once it confirms your access in writing and gives the access its system needs (an interface switched on, or a sharing key)." },
  in_build: { label: 'In build', detail: 'The vendor publishes developer access; our connector is being built.' },
  planned: { label: 'Planned', detail: "Needs the vendor's partnership or a national network's onboarding first." },
};

export const integrationById = (id: string) => INTEGRATIONS.find(i => i.id === id);
