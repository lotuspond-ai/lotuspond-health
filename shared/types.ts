// Shared data contracts for LotusPond Health, used by the browser app and the API server.

/** Anatomy groups rendered in the 3D model (one clickable unit each). */
export type OrganId =
  | 'brain' | 'thyroid' | 'airway' | 'lungs' | 'heart' | 'esophagus' | 'liver' | 'stomach'
  | 'spleen' | 'pancreas' | 'kidneys' | 'intestine' | 'colon' | 'marrow' | 'skin';

/** Body systems used to group biomarkers in the UI. */
export type SystemId =
  | 'heart' | 'metabolic' | 'liver' | 'kidney' | 'blood' | 'thyroid' | 'nutrition' | 'inflammation' | 'hormones' | 'urine';

export type Status = 'low' | 'normal' | 'high' | 'unknown';

export interface RefRange {
  low?: number;
  high?: number;
  /** Original text as printed, e.g. "13.0 - 17.0" or "<200". */
  text?: string;
  /** 'report' = taken from the user's file; 'typical' = generic adult range from the catalog. */
  source: 'report' | 'typical';
}

export interface BiomarkerDef {
  id: string;                 // stable slug, e.g. 'ldl'
  name: string;               // display name, e.g. 'LDL cholesterol'
  aliases: string[];          // lower-case match strings, e.g. ['ldl', 'ldl cholesterol', 'ldl-c']
  unit: string;               // canonical unit, e.g. 'mg/dL'
  altUnits?: { unit: string; factor: number }[]; // value_in_canonical = value * factor
  typical?: { low?: number; high?: number };     // generic adult range in canonical unit
  system: SystemId;
  organs: OrganId[];          // anatomy this marker relates to (first = primary)
  about: string;              // one or two plain-language sentences; no diagnosis
  lowerIsBetter?: boolean;
}

export interface Measurement {
  id: string;
  markerId: string | null;    // null when the row could not be matched to the catalog
  rawName: string;            // name as written in the source
  value: number | null;       // numeric value in `unit`
  valueText: string;          // original text (keeps '<5', 'Negative', etc.)
  unit: string;
  range: RefRange | null;
  status: Status;
  date: string | null;        // ISO yyyy-mm-dd of sample collection
  sourceFile: string;
  confidence: 'high' | 'medium' | 'low';
  /** Stored document this value was read from, when the original file was kept. */
  documentId?: string | null;
}

export type ScanKind = 'image' | 'dicom';

export interface ScanItem {
  id: string;
  fileName: string;
  kind: ScanKind;
  organ: OrganId | null;      // body region the scan shows (user can change)
  modality?: string;          // 'CT', 'MR', 'US', 'XR', 'Photo'...
  bodyPart?: string;          // free text, e.g. 'Chest', 'Abdomen'
  date: string | null;
  thumbDataUrl: string;       // small PNG/JPEG data URL for lists
  blobKey: string;            // key of the original file blob in IndexedDB
  width?: number;
  height?: number;
  note?: string;
}

export interface ParseResult {
  measurements: Measurement[];
  scans: ScanItem[];
  /** Original file blobs to persist, keyed by ScanItem.blobKey. */
  blobs: Record<string, Blob>;
  warnings: string[];
  detectedDate: string | null;
}

/* ---------------- accounts, profiles and stored files ---------------- */

export interface Account {
  id: string;
  email: string;
  createdAt: string;          // ISO timestamp
  /** ISO 3166-1 alpha-2 country of residence, chosen at sign-up (decides storage region and rules). */
  country?: string | null;
  /** Data-residency cell holding this account's records (see shared/regions.ts). */
  region?: 'in' | 'eu' | 'us' | 'global';
  /** How lab values are shown. */
  unitSystem?: 'conventional' | 'si';
}

/** Who a profile belongs to, relative to the account holder. */
export type Relationship = 'self' | 'partner' | 'child' | 'parent' | 'sibling' | 'other';
export type Sex = 'female' | 'male' | 'intersex';
export type BloodType = 'A+' | 'A-' | 'B+' | 'B-' | 'AB+' | 'AB-' | 'O+' | 'O-';

/** One person's health record. An account can hold several (for example a parent and their children). */
export interface Profile {
  id: string;
  relationship: Relationship;
  displayName: string;
  dateOfBirth: string | null; // yyyy-mm-dd
  sex: Sex | null;            // sex assigned at birth; used to pick typical ranges
  heightCm: number | null;
  weightKg: number | null;
  bloodType: BloodType | null;
  conditions: string[];
  medications: string[];
  allergies: string[];
  notes: string;
  createdAt: string;
  updatedAt: string;
  /** Home area (see ProfileLocation). The API always sends these; older stored profiles may lack them. */
  country?: string | null;
  locality?: string | null;
  postalCode?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

export type ProfileInput = Partial<Omit<Profile, 'id' | 'createdAt' | 'updatedAt'>> & { displayName: string };

export type DocumentKind = 'report' | 'scan' | 'other';

/** An original file the person uploaded (lab report PDF, CSV export, DICOM, photo). */
export interface StoredDocument {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  kind: DocumentKind;
  createdAt: string;
}

/** Everything stored for one profile. */
export interface ProfileRecords {
  measurements: Measurement[];
  scans: ScanItem[];
  documents: StoredDocument[];
}

/** A signed-in account and the profiles it can open. */
export interface SessionInfo {
  account: Account;
  profiles: Profile[];
}

/* ---------------- consent, activity and sign-up ---------------- */

/** What a person agreed to. `cross_border` applies where records are stored outside their country. */
export type ConsentKind = 'terms' | 'privacy' | 'health_data' | 'cross_border' | 'marketing';

/** One consent decision. Decisions are never edited; a change adds a new record. */
export interface ConsentRecord {
  kind: ConsentKind;
  /** Version of the consent texts (CONSENT_VERSION in shared/regions.ts). */
  version: string;
  granted: boolean;
  createdAt: string;
  /** Country of residence at the time. */
  country: string | null;
}

/** Account events kept in the audit log and shown as "Recent activity". */
export type AuditKind =
  | 'account_created' | 'sign_in' | 'sign_in_failed' | 'sign_out' | 'password_changed' | 'sessions_revoked'
  | 'export' | 'profile_deleted' | 'records_deleted' | 'account_deleted' | 'consent_changed' | 'preferences_changed'
  | 'lab_order_created' | 'lab_order_cancelled';

/** The only details an audit event may carry. Deliberately narrow: never names, values, file names or other health data. */
export interface AuditDetail {
  consent?: ConsentKind;
  granted?: boolean;
  unitSystem?: 'conventional' | 'si';
  /** Opaque id of the profile acted on. */
  profileId?: string;
}

export interface ActivityEvent {
  id: string;
  kind: AuditKind;
  createdAt: string;
  /** Short device description, e.g. "Firefox on Windows". */
  device: string | null;
  detail: AuditDetail | null;
}

/** Everything sign-up sends. The server checks each rule again. */
export interface RegisterInput {
  email: string;
  password: string;
  displayName: string;
  /** ISO 3166-1 alpha-2 country of residence. */
  country: string;
  /** The person confirmed they are at least the country's minimum age. */
  ageConfirmed: boolean;
  consents: {
    /** Terms and Privacy Policy (recorded as two consents). */
    termsAndPrivacy: boolean;
    healthData: boolean;
    /** Required when the country's records are stored abroad. */
    crossBorder: boolean;
    /** Optional product emails. */
    marketing: boolean;
  };
}

/** Public facts about this server, for sign-up and the Account page. */
export interface ServiceInfo {
  /** Data regions this server holds records for. Sign-up for other regions is refused. */
  servedRegions: ('in' | 'eu' | 'us' | 'global')[];
  /** API origin for each region, when regions are served by separate regional hosts (REGION_API_ORIGINS). */
  apiOrigins: Partial<Record<'in' | 'eu' | 'us' | 'global', string>>;
  consentVersion: string;
  contacts: {
    /** Grievance officer (India, DPDP Act). */
    grievance: string | null;
    /** Data protection officer. */
    dpo: string | null;
  };
}

/** Measurement as sent to the API; the server assigns the id. */
export type MeasurementInput = Omit<Measurement, 'id'>;

/** Scan as sent to the API: `blobKey` is the id of the stored document holding the original file. */
export type ScanInput = Omit<ScanItem, 'id'>;

/* ---------------- location, nearby labs and facilities ---------------- */

/** A person's saved home area. Coordinates are rounded to 2 decimals (about 1 km) before they are stored. */
export interface ProfileLocation {
  /** ISO 3166-1 alpha-2. */
  country: string | null;
  /** Display label, e.g. "Indiranagar, Bengaluru". */
  locality: string | null;
  postalCode: string | null;
  latitude: number | null;
  longitude: number | null;
}

export type FacilityKind = 'lab' | 'imaging' | 'hospital' | 'clinic';

/** Services a partner lab offers. */
export type PartnerService = 'blood' | 'urine' | 'imaging' | 'home_collection' | 'ecg' | 'health_checkup';

interface FacilityBase {
  /** Stable id: `osm:node/123` or `partner:<slug>`. */
  id: string;
  kind: FacilityKind;
  name: string;
  lat: number;
  lon: number;
  /** From the searched point, in kilometres. */
  distanceKm: number;
  /** Short street address, when known. */
  address: string | null;
  phone: string | null;
  website: string | null;
  /** OpenStreetMap opening_hours syntax, e.g. "Mo-Sa 07:00-21:00". */
  openingHours: string | null;
}

/** A public facility from OpenStreetMap. */
export interface Place extends FacilityBase {
  source: 'osm';
  operator: string | null;
  emergency: boolean;
}

/** A lab LotusPond partners with (offered where the country policy has partnerLabs). */
export interface PartnerLab extends FacilityBase {
  source: 'partner';
  slug: string;
  brand: string;
  locality: string | null;
  region: string | null;
  postalCode: string | null;
  country: string;
  bookingUrl: string | null;
  services: PartnerService[];
  /** e.g. "NABL". */
  accreditation: string | null;
}

export type Facility = Place | PartnerLab;

export interface FacilitySearchResult {
  partners: PartnerLab[];
  places: Place[];
  attribution: string;
  center: { lat: number; lon: number };
  radiusKm: number;
  /** Set when public listings could not be loaded but partner labs could. */
  notice?: { code: 'search_unavailable' | 'search_off'; message: string };
}

export interface FacilityQuery {
  lat: number;
  lon: number;
  radiusKm: number;
  kinds?: FacilityKind[];
  /** The person's country (ISO-2); partner labs are only included where its policy offers them. */
  country?: string | null;
}

/** A place found by area or postcode search. */
export interface GeoCandidate {
  label: string;
  /** Longer description to tell similar names apart. */
  detail: string | null;
  lat: number;
  lon: number;
  country: string | null;
  postalCode: string | null;
}

export interface GeoReverse {
  label: string;
  country: string | null;
  postalCode: string | null;
}

/** How the map gets its background tiles (from GET /api/config). */
export type MapSettings =
  | { type: 'pmtiles'; url: string; assetsUrl: string; attribution: string }
  | { type: 'style'; url: string }
  | { type: 'raster'; tiles: string[]; attribution: string; maxZoom: number };

export interface PublicConfig {
  map: MapSettings | null;
  /** Nearby search (OpenStreetMap places and area search) is available on this server. */
  nearbySearch: boolean;
}
