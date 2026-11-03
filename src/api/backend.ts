// The contract between the interface and wherever records are kept.
// HttpBackend talks to the LotusPond API; BrowserBackend keeps everything in this browser (preview builds).
import type {
  DocumentKind, Measurement, MeasurementInput, Profile, ProfileInput, ProfileRecords, ScanInput, ScanItem, SessionInfo, StoredDocument,
  FacilityQuery, FacilitySearchResult, GeoCandidate, GeoReverse, PublicConfig,
} from '../types';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type ScanPatch = Partial<Pick<ScanItem, 'organ' | 'modality' | 'bodyPart' | 'date' | 'note'>>;

export interface Backend {
  /** 'server': records are kept by the LotusPond API. 'browser': records are kept in this browser only. */
  readonly kind: 'server' | 'browser';

  /** The signed-in session, or null when signed out. */
  me(): Promise<SessionInfo | null>;
  register(input: { email: string; password: string; displayName: string }): Promise<SessionInfo>;
  login(input: { email: string; password: string }): Promise<SessionInfo>;
  logout(): Promise<void>;
  changePassword(currentPassword: string, newPassword: string): Promise<void>;
  signOutOtherSessions(): Promise<void>;
  deleteAccount(password: string): Promise<void>;

  createProfile(input: ProfileInput): Promise<Profile>;
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
}

/** A message suitable for showing to the person. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error && e.message) return e.message;
  return 'Something went wrong. Try again.';
}
