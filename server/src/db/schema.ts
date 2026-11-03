// Database schema (PostgreSQL). Generate migrations with `npm run db:generate -w server`.
import { date, doublePrecision, index, integer, jsonb, pgTable, real, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { RefRange } from '../../../shared/types.ts';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Stored lower-cased and trimmed. */
  email: text('email').notNull(),
  passwordHash: text('password_hash').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, t => [uniqueIndex('users_email_key').on(t.email)]);

export const sessions = pgTable('sessions', {
  /** SHA-256 of the cookie token, so a database leak does not expose live sessions. */
  id: text('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  userAgent: text('user_agent'),
}, t => [index('sessions_user_idx').on(t.userId)]);

export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  relationship: text('relationship').notNull().default('self'),
  displayName: text('display_name').notNull(),
  dateOfBirth: date('date_of_birth', { mode: 'string' }),
  sex: text('sex'),
  heightCm: real('height_cm'),
  weightKg: real('weight_kg'),
  bloodType: text('blood_type'),
  conditions: jsonb('conditions').$type<string[]>().notNull().default([]),
  medications: jsonb('medications').$type<string[]>().notNull().default([]),
  allergies: jsonb('allergies').$type<string[]>().notNull().default([]),
  notes: text('notes').notNull().default(''),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, t => [index('profiles_user_idx').on(t.userId)]);

/** Original uploaded files. The bytes live in the file store under `storage_key`. */
export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  profileId: uuid('profile_id').notNull().references(() => profiles.id, { onDelete: 'cascade' }),
  fileName: text('file_name').notNull(),
  contentType: text('content_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  sha256: text('sha256').notNull(),
  kind: text('kind').notNull().default('other'),
  storageKey: text('storage_key').notNull(),
  createdAt: createdAt(),
}, t => [index('documents_profile_idx').on(t.profileId)]);

export const measurements = pgTable('measurements', {
  id: uuid('id').primaryKey().defaultRandom(),
  profileId: uuid('profile_id').notNull().references(() => profiles.id, { onDelete: 'cascade' }),
  documentId: uuid('document_id').references(() => documents.id, { onDelete: 'set null' }),
  markerId: text('marker_id'),
  rawName: text('raw_name').notNull(),
  value: doublePrecision('value'),
  valueText: text('value_text').notNull(),
  unit: text('unit').notNull().default(''),
  range: jsonb('range').$type<RefRange | null>(),
  status: text('status').notNull(),
  date: date('date', { mode: 'string' }),
  sourceFile: text('source_file').notNull(),
  confidence: text('confidence').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, t => [index('measurements_profile_date_idx').on(t.profileId, t.date)]);

export const scans = pgTable('scans', {
  id: uuid('id').primaryKey().defaultRandom(),
  profileId: uuid('profile_id').notNull().references(() => profiles.id, { onDelete: 'cascade' }),
  /** The stored original (image or DICOM). Deleting the document deletes the scan. */
  documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  fileName: text('file_name').notNull(),
  kind: text('kind').notNull(),
  organ: text('organ'),
  modality: text('modality'),
  bodyPart: text('body_part'),
  date: date('date', { mode: 'string' }),
  thumbDataUrl: text('thumb_data_url').notNull(),
  width: integer('width'),
  height: integer('height'),
  note: text('note'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, t => [index('scans_profile_idx').on(t.profileId)]);

export type UserRow = typeof users.$inferSelect;
export type ProfileRow = typeof profiles.$inferSelect;
export type DocumentRow = typeof documents.$inferSelect;
export type MeasurementRow = typeof measurements.$inferSelect;
export type ScanRow = typeof scans.$inferSelect;
