// The contract between the interface and wherever records are kept.
// HttpBackend talks to the LotusPond API; BrowserBackend keeps everything in this browser (preview builds).
import type {
  Account, ActivityEvent, ConsentKind, ConsentRecord, DocumentKind, Measurement, MeasurementInput, Profile, ProfileInput, ProfileRecords,
  RegisterInput, ScanInput, FamilyConfirmation, AiExtraction, ScanItem, ServiceInfo, SessionInfo, StoredDocument,
  FacilityQuery, FacilitySearchResult, GeoCandidate, GeoReverse, PublicConfig,
} from '../types';
import type { NotificationList, UndoResult } from '../../shared/notifications';
import type { AgentConnection, AgentConnectionsInfo, CreateAgentTokenInput, CreatedAgentToken, UpdateAgentConnectionInput } from '../../shared/agents';
import type { LabBookingInput, LabCatalog, LabOrderView, LabResultSaved, LabResultView, LabSlot } from '../../shared/lab-bundle';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Extra fields of the server's error, for example `region` and `apiOrigin` on `wrong_region`. */
  readonly detail: Record<string, unknown>;
  constructor(status: number, code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export type ScanPatch = Partial<Pick<ScanItem, 'organ' | 'modality' | 'bodyPart' | 'date' | 'note'>>;

export interface Backend {
  /** 'server': records are kept by the LotusPond API. 'browser': records are kept in this browser only. */
  readonly kind: 'server' | 'browser';

  /** Regions this backend holds records for, the consent version and published contacts. */
  service(): Promise<ServiceInfo>;
  /** The signed-in session, or null when signed out. */
  me(): Promise<SessionInfo | null>;
  register(input: RegisterInput): Promise<SessionInfo>;
  login(input: { email: string; password: string }): Promise<SessionInfo>;
  logout(): Promise<void>;
  changePassword(currentPassword: string, newPassword: string): Promise<void>;
  signOutOtherSessions(): Promise<void>;
  deleteAccount(password: string): Promise<void>;
  updatePreferences(patch: { unitSystem: 'conventional' | 'si' }): Promise<Account>;
  /** Every consent decision, newest first. */
  consents(): Promise<ConsentRecord[]>;
  /** Grant or withdraw a consent; returns the updated list. Required consents cannot be withdrawn (delete the account instead). */
  setConsent(kind: ConsentKind, granted: boolean): Promise<ConsentRecord[]>;
  /** Recent account events, newest first. */
  activity(): Promise<ActivityEvent[]>;

  /** Add a family member, with what the account holder confirmed (shared/family.ts); recorded as a consent. */
  createProfile(input: ProfileInput, confirmation: FamilyConfirmation): Promise<Profile>;
  updateProfile(id: string, patch: Partial<ProfileInput>): Promise<Profile>;
  deleteProfile(id: string): Promise<void>;

  records(profileId: string): Promise<ProfileRecords>;
  clearRecords(profileId: string): Promise<void>;

  addMeasurements(profileId: string, rows: MeasurementInput[]): Promise<Measurement[]>;
  updateMeasurement(profileId: string, id: string, patch: Partial<MeasurementInput>): Promise<Measurement>;
  deleteMeasurement(profileId: string, id: string): Promise<void>;

  uploadDocument(profileId: string, file: Blob, fileName: string, kind: DocumentKind): Promise<StoredDocument>;
  documentFile(profileId: string, id: string): Promise<Blob>;
  deleteDocument(profileId: string, id: string): Promise<void>;
  /** Link that opens or downloads the original, or null where the page cannot offer downloads. */
  documentUrl(profileId: string, id: string, download?: boolean): string | null;
  /** Link that downloads a JSON export of the profile, or null where downloads are not possible. */
  exportUrl(profileId: string): string | null;
  /** The JSON export as a file, where there is no link to offer (the iOS and Android apps share it instead). */
  exportFile?(profileId: string): Promise<Blob>;

  addScans(profileId: string, scans: ScanInput[]): Promise<ScanItem[]>;
  updateScan(profileId: string, id: string, patch: ScanPatch): Promise<ScanItem>;
  deleteScan(profileId: string, id: string): Promise<void>;

  /* Nearby labs and facilities. Searches go through the LotusPond server; a preview has none. */
  /** Public settings: map tiles, and whether nearby search is available. */
  publicConfig(): Promise<PublicConfig>;
  nearbyFacilities(query: FacilityQuery): Promise<FacilitySearchResult>;
  /** Up to 5 places matching an area name or postcode. */
  searchPlaces(q: string): Promise<GeoCandidate[]>;
  /** The area around a point (sent rounded to about 1 km). */
  reversePlace(lat: number, lon: number): Promise<GeoReverse>;

  /* Lab booking: home sample collection and its results (docs/lab-booking-backend.md). Needs the LotusPond server. */
  /** Packages from the partners serving the account's region at this pincode. */
  labCatalog(pincode: string): Promise<LabCatalog>;
  labSlots(q: { partner: string; pincode: string; date: string; items: string[] }): Promise<LabSlot[]>;
  /** A profile's bookings, newest first. */
  labOrders(profileId: string): Promise<LabOrderView[]>;
  /** One booking with its status timeline. */
  labOrder(profileId: string, id: string): Promise<LabOrderView>;
  /**
   * Book. Retrying the same booking (after a network error) must reuse the same idempotency key, so the lab is never
   * asked twice. An order still `placing` is being confirmed with the lab. A refused booking throws an ApiError whose
   * detail carries the failed `order`.
   */
  bookLab(profileId: string, input: LabBookingInput, idempotencyKey: string): Promise<LabOrderView>;
  cancelLabOrder(profileId: string, id: string, reason?: string): Promise<LabOrderView>;
  /** Slots for moving a booking's visit (the server knows its address). */
  labOrderSlots(profileId: string, id: string, date: string): Promise<LabSlot[]>;
  rescheduleLabOrder(profileId: string, id: string, slot: LabSlot): Promise<LabOrderView>;
  /** Results waiting for review. */
  labResults(profileId: string): Promise<LabResultView[]>;
  /** The report PDF of a result. */
  labReport(profileId: string, resultId: string): Promise<Blob>;
  /** A link that opens the report PDF in the browser, or null in the apps (which fetch it with labReport). */
  labReportUrl(profileId: string, resultId: string): string | null;
  /** Save reviewed values (and the report PDF) as the profile's records. */
  saveLabResult(profileId: string, resultId: string, measurements: MeasurementInput[]): Promise<LabResultSaved>;
  /** Drop a result without saving anything. */
  dismissLabResult(profileId: string, resultId: string): Promise<LabResultView>;

  /**
   * Send one photographed or scanned report to Claude to read it (docs/report-reading.md). Only after the person
   * agreed to the notice for this file; the server records that consent. Needs the LotusPond server.
   */
  extractReport(profileId: string, file: Blob, fileName: string): Promise<AiExtraction>;

  /* Connected agents (shared/agents.ts): AI agents reading the records over MCP. Needs the LotusPond server. */
  agentConnections(): Promise<AgentConnectionsInfo>;
  createAgentToken(input: CreateAgentTokenInput): Promise<CreatedAgentToken>;
  updateAgentConnection(id: string, patch: UpdateAgentConnectionInput): Promise<AgentConnection>;
  disconnectAgent(id: string): Promise<void>;

  /* Notifications (shared/notifications.ts): what connected agents added, with an undo. Needs the LotusPond server. */
  notifications(): Promise<NotificationList>;
  markNotificationsRead(ids?: string[]): Promise<NotificationList>;
  undoNotification(id: string): Promise<UndoResult>;
}

/** A message suitable for showing to the person. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error && e.message) return e.message;
  return 'Something went wrong. Try again.';
}
