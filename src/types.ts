// Shared data contracts for LotusPond Health. Everything is processed and stored in the browser.

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
