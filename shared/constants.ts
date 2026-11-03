// Enumerations shared by the browser app and the API server.
import type { BloodType, DocumentKind, OrganId, Relationship, Sex } from './types.ts';

export const ORGAN_IDS: readonly OrganId[] = ['brain', 'thyroid', 'airway', 'lungs', 'heart', 'esophagus', 'liver', 'stomach',
  'spleen', 'pancreas', 'kidneys', 'intestine', 'colon', 'marrow', 'skin'];

export const RELATIONSHIPS: readonly Relationship[] = ['self', 'partner', 'child', 'parent', 'sibling', 'other'];
export const SEXES: readonly Sex[] = ['female', 'male', 'intersex'];
export const BLOOD_TYPES: readonly BloodType[] = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
export const DOCUMENT_KINDS: readonly DocumentKind[] = ['report', 'scan', 'other'];

/** Limits enforced by the API and mirrored in the interface. */
export const LIMITS = {
  passwordMin: 10,
  passwordMax: 256,
  profilesPerAccount: 20,
  measurementsPerRequest: 2000,
  scansPerRequest: 50,
  listItems: 50,
  listItemLength: 120,
  notesLength: 5000,
} as const;
