// The connector core: one description of every outside system LotusPond reaches (a lab portal, ABHA, a wearable's
// API, and later a hospital information system or an insurer/TPA portal), what it can do there, and on whose
// authority. LotusPond Health uses it for a person's own records; the organisation side (LotusPond Works: hospitals,
// clinics, insurers and health-tech builders) uses the same connectors under an organisation's contracted access.
// See docs/connectors.md.
import type { SourceCategory, SourceSignIn } from '../../../shared/sources.ts';
import type { DataRegion } from '../../../shared/regions.ts';
import type { ApiFetcher } from '../records/api/types.ts';
import type { Recipe } from '../records/recipes/types.ts';

/**
 * Whose say-so a connection runs on. Never mixed: an organisation's credential never reaches a person's own records,
 * and a person's consent never lets an organisation act in their name.
 *   person        the person (or a parent for a family member) signs in and consents; LotusPond Health
 *   organisation  an organisation's contracted or delegated access to its own systems; LotusPond Works
 */
export type Authority = 'person' | 'organisation';

/** How the system is reached. */
export type Reach = 'browser' | 'api' | 'abdm';

export type OperationId =
  | 'records.fetch'
  | 'patients.search'
  | 'encounters.list'
  | 'documents.upload'
  | 'claims.status'
  | 'preauth.submit';

export interface OperationSpec {
  id: OperationId;
  summary: string;
  /** Who may run it. */
  authority: Authority[];
  /** It changes something in the other system. */
  writes: boolean;
  /** Who must approve each call before it is sent: nobody (reads), the person, or a clinician (clinical writes). */
  approval: 'none' | 'person' | 'clinician';
  /** What it returns, as FHIR R4 resource types. */
  fhir: string[];
  /** Built and offered today, or defined so connectors and docs agree on the contract before the first adapter. */
  stage: 'live' | 'planned';
}

export const OPERATIONS: Record<OperationId, OperationSpec> = {
  'records.fetch': {
    id: 'records.fetch', summary: "Bring in a person's reports and readings from a system they use, as documents and FHIR bundles for review",
    authority: ['person'], writes: false, approval: 'none', fhir: ['DocumentReference', 'Bundle', 'Observation', 'DiagnosticReport'], stage: 'live',
  },
  'patients.search': {
    id: 'patients.search', summary: 'Find a patient in a hospital information system by identifiers the organisation already holds',
    authority: ['organisation'], writes: false, approval: 'none', fhir: ['Patient'], stage: 'planned',
  },
  'encounters.list': {
    id: 'encounters.list', summary: "List a patient's visits and admissions, with their documents",
    authority: ['organisation'], writes: false, approval: 'none', fhir: ['Encounter', 'DocumentReference'], stage: 'planned',
  },
  'documents.upload': {
    id: 'documents.upload', summary: 'Attach a document (a note, a discharge summary, a report) to a patient or encounter; drafts by AI need a clinician',
    authority: ['organisation'], writes: true, approval: 'clinician', fhir: ['DocumentReference'], stage: 'planned',
  },
  'claims.status': {
    id: 'claims.status', summary: 'Read the status of a cashless or reimbursement claim with an insurer or TPA',
    authority: ['organisation'], writes: false, approval: 'none', fhir: ['ClaimResponse'], stage: 'planned',
  },
  'preauth.submit': {
    id: 'preauth.submit', summary: 'Submit a pre-authorisation request, with its documents, to an insurer or TPA',
    authority: ['organisation'], writes: true, approval: 'clinician', fhir: ['Claim', 'ClaimResponse'], stage: 'planned',
  },
};

/** What anyone may read about a connector: no credentials, no people, nothing about any connection. */
export interface ConnectorInfo {
  id: string;
  name: string;
  category: SourceCategory;
  regions: DataRegion[];
  authority: Authority;
  reach: Reach;
  signIn: SourceSignIn;
  operations: OperationId[];
  /** Whether this server can run it now (its recipe, API keys or browser are set up here). */
  available: boolean;
}

/** How `records.fetch` runs for a connector: its official API, a recipe for its portal, or Claude's navigator. */
export type RecordsImpl =
  | { via: 'api'; fetcher: ApiFetcher }
  | { via: 'recipe'; recipe: Recipe }
  | { via: 'navigator' };

export interface Connector extends ConnectorInfo {
  /** How records.fetch would run here. Set even when `available` is false for a policy reason (typed portals), so a
   *  connection saved earlier fails with that reason rather than a generic one. */
  records: RecordsImpl | null;
}
