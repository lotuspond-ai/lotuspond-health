// Profile helpers: the editable draft used by profile forms, and small calculations.
import type { BloodType, Profile, ProfileInput, Relationship, Sex } from '../types';

/** Today's date as yyyy-mm-dd (local time), e.g. as the latest allowed birth date. */
export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0)} MB`;
}

export interface ProfileDraft {
  displayName: string;
  relationship: Relationship;
  dateOfBirth: string;
  sex: Sex | '';
  heightCm: string;
  weightKg: string;
  bloodType: BloodType | '';
  conditions: string[];
  medications: string[];
  allergies: string[];
  notes: string;
}

// Two decimals, so heights and weights entered in feet, inches or pounds survive the round trip through cm and kg.
const num = (v: number | null) => (v == null ? '' : String(Math.round(v * 100) / 100));

export function toDraft(p: Profile): ProfileDraft {
  return {
    displayName: p.displayName, relationship: p.relationship, dateOfBirth: p.dateOfBirth ?? '', sex: p.sex ?? '',
    heightCm: num(p.heightCm), weightKg: num(p.weightKg), bloodType: p.bloodType ?? '',
    conditions: p.conditions, medications: p.medications, allergies: p.allergies, notes: p.notes,
  };
}

export const emptyDraft = (relationship: Relationship = 'child'): ProfileDraft => ({
  displayName: '', relationship, dateOfBirth: '', sex: '', heightCm: '', weightKg: '', bloodType: '', conditions: [], medications: [], allergies: [], notes: '',
});

function parseNumber(s: string): number | null {
  const n = parseFloat(s.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

export function fromDraft(d: ProfileDraft): ProfileInput {
  return {
    displayName: d.displayName.trim(), relationship: d.relationship, dateOfBirth: d.dateOfBirth || null, sex: d.sex || null,
    heightCm: parseNumber(d.heightCm), weightKg: parseNumber(d.weightKg), bloodType: d.bloodType || null,
    conditions: d.conditions, medications: d.medications, allergies: d.allergies, notes: d.notes,
  };
}

/** Problems to fix before saving, keyed by field. */
export function checkDraft(d: ProfileDraft): Partial<Record<keyof ProfileDraft, string>> {
  const e: Partial<Record<keyof ProfileDraft, string>> = {};
  if (!d.displayName.trim()) e.displayName = 'Enter a name.';
  if (d.dateOfBirth && d.dateOfBirth > todayIso()) e.dateOfBirth = 'Date of birth cannot be in the future.';
  const h = parseNumber(d.heightCm), w = parseNumber(d.weightKg);
  if (d.heightCm && (h == null || h < 20 || h > 272)) e.heightCm = 'Enter height in centimetres, between 20 and 272.';
  if (d.weightKg && (w == null || w < 0.5 || w > 650)) e.weightKg = 'Enter weight in kilograms, between 0.5 and 650.';
  return e;
}

/** Body mass index from a draft, when height and weight are both set. */
export function bmiOf(heightCm: number | null, weightKg: number | null): number | null {
  if (!heightCm || !weightKg) return null;
  const m = heightCm / 100;
  return Math.round((weightKg / (m * m)) * 10) / 10;
}

