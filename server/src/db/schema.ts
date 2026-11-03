// Database schema (PostgreSQL). Generate migrations with `npm run db:generate -w server`.
import { boolean, date, doublePrecision, index, integer, jsonb, pgTable, real, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { AuditDetail, AuditKind, ConsentKind, RefRange } from '../../../shared/types.ts';
import type { DataRegion, UnitSystem } from '../../../shared/regions.ts';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Stored lower-cased and trimmed. */
  email: text('email').notNull(),
  passwordHash: text('password_hash').notNull(),
  /** ISO 3166-1 alpha-2 country of residence from sign-up. Null for accounts created before it was asked. */
  country: text('country'),
  /** Data-residency cell that holds this account (shared/regions.ts). */
  region: text('region').$type<DataRegion>().notNull().default('global'),
  unitSystem: text('unit_system').$type<UnitSystem>().notNull().default('conventional'),
  /** When the person confirmed they are old enough to hold an account. */
  ageConfirmedAt: timestamp('age_confirmed_at', { withTimezone: true }),
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
  /* Home area. Coordinates are rounded to 2 decimals (about 1 km) before saving; precise positions are never stored. */
  country: text('country'),
  locality: text('locality'),
  postalCode: text('postal_code'),
  latitude: doublePrecision('latitude'),
  longitude: doublePrecision('longitude'),
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

/* ---------- nearby labs and facilities (not personal data; kept in the default database) ---------- */

/** Labs LotusPond partners with. Imported by an admin: `npm run partners:import -w server -- file.json`. */
export const partnerLabs = pgTable('partner_labs', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull(),
  brand: text('brand').notNull(),
  name: text('name').notNull(),
  address: text('address').notNull(),
  locality: text('locality'),
  region: text('region'),
  postalCode: text('postal_code'),
  /** ISO 3166-1 alpha-2. */
  country: text('country').notNull(),
  latitude: doublePrecision('latitude').notNull(),
  longitude: doublePrecision('longitude').notNull(),
  phone: text('phone'),
  website: text('website'),
  bookingUrl: text('booking_url'),
  services: jsonb('services').$type<string[]>().notNull().default([]),
  openingHours: text('opening_hours'),
  accreditation: text('accreditation'),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, t => [uniqueIndex('partner_labs_slug_key').on(t.slug), index('partner_labs_country_idx').on(t.country)]);

/** Responses from OpenStreetMap services, keyed by rounded query (places 7 days, geocoding 30 days). */
export const facilityCache = pgTable('facility_cache', {
  key: text('key').primaryKey(),
  payload: jsonb('payload').notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
});
/**
 * Consent decisions, append-only: each grant or withdrawal is a new row with the text version it refers to.
 * The latest row per kind is the current state.
 */
export const consents = pgTable('consents', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind').$type<ConsentKind>().notNull(),
  version: text('version').notNull(),
  granted: boolean('granted').notNull(),
  /** Country of residence when the decision was made. */
  country: text('country'),
  createdAt: createdAt(),
}, t => [index('consents_user_idx').on(t.userId, t.createdAt)]);

/**
 * Account events (sign-in, export, deletion…) for the person's own activity view and for scoping a breach.
 * Holds no health data: only the kind, a small typed detail, a keyed hash of the client address and a short
 * device description. No foreign key, so the `account_deleted` record outlives the account.
 */
export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  kind: text('kind').$type<AuditKind>().notNull(),
  detail: jsonb('detail').$type<AuditDetail>(),
  ipHash: text('ip_hash'),
  userAgent: text('user_agent'),
  createdAt: createdAt(),
}, t => [index('audit_events_user_idx').on(t.userId, t.createdAt)]);

/**
 * Which cell holds each account, keyed by an HMAC of the email (DIRECTORY_SECRET) so no address is stored in plain
 * text outside its cell. Lives in the default database only; cells leave theirs empty.
 */
export const directory = pgTable('directory', {
  emailHash: text('email_hash').primaryKey(),
  region: text('region').$type<DataRegion>().notNull(),
  userId: uuid('user_id').notNull(),
  createdAt: createdAt(),
}, t => [index('directory_user_idx').on(t.userId)]);

export type UserRow = typeof users.$inferSelect;
export type ConsentRow = typeof consents.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
export type ProfileRow = typeof profiles.$inferSelect;
export type DocumentRow = typeof documents.$inferSelect;
export type MeasurementRow = typeof measurements.$inferSelect;
export type ScanRow = typeof scans.$inferSelect;
export type PartnerLabRow = typeof partnerLabs.$inferSelect;
