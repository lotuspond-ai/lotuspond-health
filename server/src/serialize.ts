// Database rows → API shapes (shared/types.ts).
import type { Account, BloodType, Measurement, Profile, Relationship, ScanItem, Sex, StoredDocument } from '../../shared/types.ts';
import type { DocumentRow, MeasurementRow, ProfileRow, ScanRow, UserRow } from './db/schema.ts';

export const toAccount = (u: UserRow): Account => ({
  id: u.id, email: u.email, createdAt: u.createdAt.toISOString(), country: u.country, region: u.region, unitSystem: u.unitSystem,
  hasPassword: !!u.passwordHash,
});

export const toProfile = (p: ProfileRow): Profile => ({
  id: p.id,
  relationship: p.relationship as Relationship,
  displayName: p.displayName,
  dateOfBirth: p.dateOfBirth,
  sex: p.sex as Sex | null,
  heightCm: p.heightCm,
  weightKg: p.weightKg,
  bloodType: p.bloodType as BloodType | null,
  conditions: p.conditions,
  medications: p.medications,
  allergies: p.allergies,
  notes: p.notes,
  createdAt: p.createdAt.toISOString(),
  updatedAt: p.updatedAt.toISOString(),
  country: p.country,
  locality: p.locality,
  postalCode: p.postalCode,
  latitude: p.latitude,
  longitude: p.longitude,
});

export const toDocument = (d: DocumentRow): StoredDocument => ({
  id: d.id,
  fileName: d.fileName,
  contentType: d.contentType,
  sizeBytes: d.sizeBytes,
  kind: d.kind as StoredDocument['kind'],
  createdAt: d.createdAt.toISOString(),
});

export const toMeasurement = (m: MeasurementRow): Measurement => ({
  id: m.id,
  markerId: m.markerId,
  rawName: m.rawName,
  value: m.value,
  valueText: m.valueText,
  unit: m.unit,
  range: m.range ?? null,
  status: m.status as Measurement['status'],
  date: m.date,
  sourceFile: m.sourceFile,
  confidence: m.confidence as Measurement['confidence'],
  documentId: m.documentId,
});

export const toScan = (s: ScanRow): ScanItem => ({
  id: s.id,
  fileName: s.fileName,
  kind: s.kind as ScanItem['kind'],
  organ: s.organ as ScanItem['organ'],
  modality: s.modality ?? undefined,
  bodyPart: s.bodyPart ?? undefined,
  date: s.date,
  thumbDataUrl: s.thumbDataUrl,
  blobKey: s.documentId,
  width: s.width ?? undefined,
  height: s.height ?? undefined,
  note: s.note ?? undefined,
});
