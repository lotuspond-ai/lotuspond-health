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

/** Measurement as sent to the API; the server assigns the id. */
export type MeasurementInput = Omit<Measurement, 'id'>;

/** Scan as sent to the API: `blobKey` is the id of the stored document holding the original file. */
export type ScanInput = Omit<ScanItem, 'id'>;
