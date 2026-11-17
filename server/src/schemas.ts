// Request validation. Shapes mirror the types in shared/types.ts.
import { z } from 'zod';
import { BLOOD_TYPES, DOCUMENT_KINDS, LIMITS, ORGAN_IDS, RELATIONSHIPS, SEXES } from '../../shared/constants.ts';
import { roundCoord } from '../../shared/facilities.ts';
import { isCountryCode } from '../../shared/regions.ts';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date in the form yyyy-mm-dd.')
  .refine(s => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'That date does not exist.');

const pastDate = isoDate.refine(s => s <= new Date().toISOString().slice(0, 10), 'Date of birth cannot be in the future.');

const listField = z.array(z.string().trim().min(1).max(LIMITS.listItemLength)).max(LIMITS.listItems)
  .transform(items => [...new Set(items)]);

/* ---------------- auth ---------------- */

export const Email = z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address.').max(254));
export const NewPassword = z.string()
  .min(LIMITS.passwordMin, `Use at least ${LIMITS.passwordMin} characters.`)
  .max(LIMITS.passwordMax, `Use at most ${LIMITS.passwordMax} characters.`);

/** Sign-up. Country, age and consent rules are checked by signUpProblem() in shared/regions.ts. */
export const RegisterBody = z.object({
  email: Email,
  password: NewPassword,
  displayName: z.string().trim().min(1, 'Enter your name.').max(80),
  country: z.string({ error: 'Choose the country you live in.' }).trim().toUpperCase().max(2, 'Choose the country you live in.'),
  ageConfirmed: z.boolean({ error: 'Confirm your age.' }),
  consents: z.object({
    termsAndPrivacy: z.boolean().default(false),
    healthData: z.boolean().default(false),
    crossBorder: z.boolean().default(false),
    marketing: z.boolean().default(false),
  }, { error: 'Answer the consent questions.' }),
});

/** Finishing sign-up after LotusPond Accounts: the same questions without the email and password Accounts holds. */
export const AccountsCompleteBody = RegisterBody.omit({ email: true, password: true });

export const PreferencesBody = z.object({ unitSystem: z.enum(['conventional', 'si'], { error: 'Choose conventional or SI units.' }) });

export const ConsentPatchBody = z.object({
  kind: z.enum(['terms', 'privacy', 'health_data', 'cross_border', 'marketing'], { error: 'Unknown consent.' }),
  granted: z.boolean(),
});

export const LoginBody = z.object({
  email: z.string().trim().toLowerCase().max(254),
  password: z.string().max(LIMITS.passwordMax),
});

export const ChangePasswordBody = z.object({
  currentPassword: z.string().max(LIMITS.passwordMax),
  newPassword: NewPassword,
});

/** The password, or nothing for an account that signs in only through LotusPond Accounts (it needs a recent sign-in instead). */
export const DeleteAccountBody = z.object({ password: z.string().max(LIMITS.passwordMax).default('') });

/* ---------------- profiles ---------------- */

/** Home area. Coordinates are rounded to about 1 km here, so a precise position can never be stored. */
const coordinate = (min: number, max: number, what: string) =>
  z.number().finite().min(min, `${what} must be between ${min} and ${max}.`).max(max, `${what} must be between ${min} and ${max}.`)
    .transform(v => roundCoord(v)).nullable();
const optionalText = (max: number) => z.string().trim().max(max).transform(s => s || null).nullable();

export const profileLocationFields = {
  country: z.string().trim().toUpperCase().refine(isCountryCode, 'Choose a country.').nullable(),
  locality: optionalText(120),
  postalCode: optionalText(20).refine(s => s == null || /^[\p{L}\p{N} -]+$/u.test(s), 'Use letters, digits, spaces or hyphens.'),
  latitude: coordinate(-90, 90, 'Latitude'),
  longitude: coordinate(-180, 180, 'Longitude'),
};

/** Latitude and longitude are set or cleared together. */
function pairedCoordinates(b: { latitude?: number | null; longitude?: number | null }): boolean {
  if (b.latitude === undefined && b.longitude === undefined) return true;
  if (b.latitude === undefined || b.longitude === undefined) return false;
  return (b.latitude === null) === (b.longitude === null);
}
const PAIRED = { message: 'Send latitude and longitude together.', path: ['latitude'] };

const profileFields = {
  displayName: z.string().trim().min(1, 'Enter a name.').max(80),
  relationship: z.enum(RELATIONSHIPS as [string, ...string[]]),
  dateOfBirth: pastDate.nullable(),
  sex: z.enum(SEXES as [string, ...string[]]).nullable(),
  heightCm: z.number().min(20, 'Height looks too small.').max(272, 'Height looks too large.').nullable(),
  weightKg: z.number().min(0.5, 'Weight looks too small.').max(650, 'Weight looks too large.').nullable(),
  bloodType: z.enum(BLOOD_TYPES as [string, ...string[]]).nullable(),
  conditions: listField,
  medications: listField,
  allergies: listField,
  notes: z.string().max(LIMITS.notesLength),
  ...profileLocationFields,
};

export const ProfileCreateBody = z.object({
  ...profileFields,
  /** What the account holder confirmed (shared/family.ts); recorded as a family_profile consent. */
  confirmation: z.enum(['guardian', 'agreed'], { error: 'Confirm that you may keep this person\'s records.' }),
}).partial().required({ displayName: true, confirmation: true }).refine(pairedCoordinates, PAIRED);
export const ProfilePatchBody = z.object(profileFields).partial().refine(pairedCoordinates, PAIRED);

/* ---------------- records ---------------- */

const RefRange = z.object({
  low: z.number().finite().optional(),
  high: z.number().finite().optional(),
  text: z.string().max(200).optional(),
  source: z.enum(['report', 'typical']),
});

const measurementFields = {
  markerId: z.string().max(80).nullable(),
  rawName: z.string().max(300),
  value: z.number().finite().nullable(),
  valueText: z.string().max(300),
  unit: z.string().max(60),
  range: RefRange.nullable(),
  status: z.enum(['low', 'normal', 'high', 'unknown']),
  date: isoDate.nullable(),
  sourceFile: z.string().max(300),
  confidence: z.enum(['high', 'medium', 'low']),
  documentId: z.uuid().nullable().optional(),
};

export const MeasurementInput = z.object(measurementFields);
export const MeasurementsCreateBody = z.object({
  measurements: z.array(MeasurementInput).min(1).max(LIMITS.measurementsPerRequest),
});
export const MeasurementPatchBody = z.object(measurementFields).partial();

const organ = z.enum(ORGAN_IDS as [string, ...string[]]).nullable();
const scanText = (n: number) => z.string().max(n).optional();

export const ScanInput = z.object({
  fileName: z.string().min(1).max(300),
  kind: z.enum(['image', 'dicom']),
  organ,
  modality: scanText(40),
  bodyPart: scanText(80),
  date: isoDate.nullable(),
  thumbDataUrl: z.string().max(800_000).regex(/^data:image\/[\w.+-]+[;,]/, 'Thumbnail must be an image data URL.'),
  blobKey: z.uuid(),
  width: z.number().int().positive().max(100_000).optional(),
  height: z.number().int().positive().max(100_000).optional(),
  note: scanText(2000),
});
export const ScansCreateBody = z.object({ scans: z.array(ScanInput).min(1).max(LIMITS.scansPerRequest) });
export const ScanPatchBody = z.object({
  organ,
  modality: scanText(40),
  bodyPart: scanText(80),
  date: isoDate.nullable(),
  note: scanText(2000),
}).partial();

export const DocumentKind = z.enum(DOCUMENT_KINDS as [string, ...string[]]);
