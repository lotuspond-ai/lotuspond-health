// Database schema (PostgreSQL). Generate migrations with `npm run db:generate -w server`.
import { boolean, date, doublePrecision, index, integer, jsonb, pgTable, real, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { AuditDetail, AuditKind, ConsentDetail, ConsentKind, RefRange } from '../../../shared/types.ts';
import type { DataRegion, UnitSystem } from '../../../shared/regions.ts';
import type { LabResultBundle, OrderStatus } from '../../../shared/lab-bundle.ts';
import type { NotificationDetail } from '../../../shared/notifications.ts';

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
 * The latest row per kind is the current state; for family_profile and agent_sharing, per profile or connection.
 */
export const consents = pgTable('consents', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind').$type<ConsentKind>().notNull(),
  version: text('version').notNull(),
  granted: boolean('granted').notNull(),
  /** Country of residence when the decision was made. */
  country: text('country'),
  /** For per-item consents (family_profile, agent_sharing): the profile or connection, as ids and permissions only. */
  detail: jsonb('detail').$type<ConsentDetail>(),
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

/* ---------- lab bookings (personal data: kept in the account's cell) ---------- */

/**
 * Home sample collections booked with a lab partner (docs/lab-booking-backend.md). The lab code reads and writes
 * these through lab/store/drizzle.ts, which maps them to the booking service's records.
 */
export const labOrders = pgTable('lab_orders', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  profileId: uuid('profile_id').notNull().references(() => profiles.id, { onDelete: 'cascade' }),
  partner: text('partner').notNull(),
  /** The partner's order number, once it has accepted the booking. */
  partnerRef: text('partner_ref'),
  /** The partner's per-order token, when its API needs one on later calls (Orange Health). Useless without our API key. */
  partnerToken: text('partner_token'),
  status: text('status').$type<OrderStatus>().notNull(),
  /** The partner's own last status and when it says it began: guards against out-of-date reads. */
  partnerStatus: text('partner_status'),
  partnerStatusAt: timestamp('partner_status_at', { withTimezone: true }),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  items: jsonb('items').$type<{ code: string; name: string; pricePaise: number }[]>().notNull().default([]),
  slotStart: timestamp('slot_start', { withTimezone: true }),
  slotEnd: timestamp('slot_end', { withTimezone: true }),
  pricePaise: integer('price_paise').notNull().default(0),
  payer: text('payer').$type<'partner' | 'lotuspond'>().notNull().default('partner'),
  /** Patient name, age, sex, mobile number and address, sealed with the cell's file key (lab/sealer.ts), base64. */
  contactCt: text('contact_ct'),
  piiPurgedAt: timestamp('pii_purged_at', { withTimezone: true }),
  /** The booking notice version accepted, and when. */
  consentVersion: text('consent_version'),
  consentedAt: timestamp('consented_at', { withTimezone: true }),
  idempotencyKey: text('idempotency_key'),
  requestHash: text('request_hash'),
  placementAttempts: integer('placement_attempts').notNull().default(0),
  nextPlacementAt: timestamp('next_placement_at', { withTimezone: true }),
  failureReason: text('failure_reason'),
  /** The partner's identifier for the last report stored (lab_results), to tell a new or amended report from a repeat. */
  reportVersion: text('report_version'),
  /** The partner status time the last report check covered; a later partner status means check again. */
  reportCheckedStatusAt: timestamp('report_checked_status_at', { withTimezone: true }),
  reportAttempts: integer('report_attempts').notNull().default(0),
  nextReportAt: timestamp('next_report_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, t => [
  uniqueIndex('lab_orders_partner_ref_key').on(t.partner, t.partnerRef),
  uniqueIndex('lab_orders_idempotency_key').on(t.userId, t.idempotencyKey),
  index('lab_orders_profile_idx').on(t.profileId, t.createdAt),
  index('lab_orders_status_idx').on(t.status, t.lastSyncedAt),
  index('lab_orders_placement_idx').on(t.nextPlacementAt),
]);

/** Every status change and partner update on an order: its timeline, and the audit trail for support. */
export const labOrderEvents = pgTable('lab_order_events', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  orderId: uuid('order_id').notNull().references(() => labOrders.id, { onDelete: 'cascade' }),
  status: text('status').$type<OrderStatus>().notNull(),
  partnerStatus: text('partner_status'),
  source: text('source').$type<'webhook' | 'poll' | 'api' | 'user' | 'system'>().notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
  note: text('note'),
}, t => [index('lab_order_events_order_idx').on(t.orderId, t.id)]);

/**
 * Reports fetched from the partner, waiting for the person to review them (docs/lab-booking-backend.md §5.3).
 * Saving one turns it into ordinary records: a document (the PDF) and measurements. Each delivery for an order has
 * the next sequence number; a newer one replaces what an earlier one saved.
 */
export const labResults = pgTable('lab_results', {
  id: uuid('id').primaryKey(),
  orderId: uuid('order_id').notNull().references(() => labOrders.id, { onDelete: 'cascade' }),
  profileId: uuid('profile_id').notNull().references(() => profiles.id, { onDelete: 'cascade' }),
  sequence: integer('sequence').notNull(),
  partial: boolean('partial').notNull(),
  /** The partner's report version, or a hash of the report when it gives none. */
  partnerVersion: text('partner_version').notNull(),
  /** The rows as the lab printed them, for the app to match to the catalogue (shared/lab-bundle.ts). */
  bundle: jsonb('bundle').$type<LabResultBundle>().notNull(),
  /** The report PDF in the cell's file store, keyed <profile>/<result id> like documents (deleted with the profile). */
  pdfKey: text('pdf_key'),
  pdfBytes: integer('pdf_bytes'),
  pdfSha256: text('pdf_sha256'),
  status: text('status').$type<'pending' | 'saved' | 'dismissed' | 'superseded'>().notNull().default('pending'),
  /** The document the PDF became when saved. */
  documentId: uuid('document_id').references(() => documents.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
}, t => [
  uniqueIndex('lab_results_order_sequence_key').on(t.orderId, t.sequence),
  index('lab_results_profile_idx').on(t.profileId, t.status),
]);

/**
 * Partner webhooks as received, before processing (lab/webhooks/). Kept in the partner's region cell, sealed,
 * because a body may carry results. Purged 7 days after processing.
 */
export const labWebhookInbox = pgTable('lab_webhook_inbox', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  partner: text('partner').notNull(),
  /** The partner's event id, or a hash of the body. */
  dedupeKey: text('dedupe_key').notNull(),
  headers: jsonb('headers').$type<Record<string, string>>().notNull(),
  /** Sealed raw body, base64. */
  body: text('body').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  error: text('error'),
  deadAt: timestamp('dead_at', { withTimezone: true }),
}, t => [
  uniqueIndex('lab_webhook_inbox_dedupe_key').on(t.partner, t.dedupeKey),
  index('lab_webhook_inbox_due_idx').on(t.processedAt, t.nextAttemptAt),
]);

/* ---------- agent connections (shared/agents.ts, server/src/agents/) ---------- */

/**
 * OAuth clients that registered themselves (RFC 7591 dynamic client registration): Claude, ChatGPT and other agent
 * platforms. Not personal data, so kept in the default database. Public clients only: they prove themselves with PKCE.
 */
export const oauthClients = pgTable('oauth_clients', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  redirectUris: jsonb('redirect_uris').$type<string[]>().notNull(),
  createdAt: createdAt(),
});

/**
 * One connected agent: what it may do and which profiles it may see. Kept in the account's cell. Revoking deletes
 * the row, and its tokens with it.
 */
export const agentGrants = pgTable('agent_grants', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind').$type<'oauth' | 'token'>().notNull(),
  /** The OAuth client (oauth_clients.id in the default database); null for tokens made on Account. */
  clientId: text('client_id'),
  name: text('name').notNull(),
  redirectHost: text('redirect_host'),
  scopes: jsonb('scopes').$type<string[]>().notNull(),
  /** Kinds of data shared (shared/agents.ts AgentCategory); null for every kind (connections made before categories). */
  categories: jsonb('categories').$type<string[]>(),
  profileIds: jsonb('profile_ids').$type<string[]>().notNull(),
  createdAt: createdAt(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  /** When the last agent_access audit event was written, so reads are logged at most once an hour. */
  lastLoggedAt: timestamp('last_logged_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
}, t => [index('agent_grants_user_idx').on(t.userId), uniqueIndex('agent_grants_user_client_key').on(t.userId, t.clientId)]);

/**
 * Secrets issued for a grant, stored as SHA-256: authorization codes (single use, minutes), access tokens (an hour,
 * or as long as the grant for tokens made on Account) and refresh tokens (rotated on every use).
 */
export const agentTokens = pgTable('agent_tokens', {
  id: text('id').primaryKey(),
  grantId: uuid('grant_id').notNull().references(() => agentGrants.id, { onDelete: 'cascade' }),
  type: text('type').$type<'code' | 'access' | 'refresh'>().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  /** Authorization codes: the PKCE challenge (S256) and the redirect URI they were issued for. */
  codeChallenge: text('code_challenge'),
  redirectUri: text('redirect_uri'),
  /** The resource (RFC 8707) the token is for. */
  resource: text('resource'),
  createdAt: createdAt(),
}, t => [index('agent_tokens_grant_idx').on(t.grantId)]);

/**
 * What the person is told in the app (shared/notifications.ts): today, each addition a connected agent made. In the
 * account's cell. connection_id has no foreign key, so a notification outlives a disconnected agent.
 */
export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  profileId: uuid('profile_id').notNull().references(() => profiles.id, { onDelete: 'cascade' }),
  kind: text('kind').$type<'agent_write'>().notNull(),
  connectionId: uuid('connection_id'),
  agentName: text('agent_name').notNull(),
  detail: jsonb('detail').$type<NotificationDetail>().notNull(),
  createdAt: createdAt(),
  readAt: timestamp('read_at', { withTimezone: true }),
  undoneAt: timestamp('undone_at', { withTimezone: true }),
}, t => [index('notifications_user_idx').on(t.userId, t.createdAt)]);

/**
 * Conversations with LotusPond's own assistant (server/src/assistant/), in the account's cell. One conversation is
 * about one profile; the person can ask about others in it.
 */
export const assistantConversations = pgTable('assistant_conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  profileId: uuid('profile_id').notNull().references(() => profiles.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  /** Where it happens: the app, or WhatsApp from the linked number. */
  channel: text('channel').$type<'app' | 'whatsapp'>().notNull().default('app'),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [index('assistant_conversations_user_idx').on(t.userId, t.updatedAt)]);

/**
 * Every message of a conversation as sent to and returned by the model, in order and never edited (the model's
 * thinking blocks are valid only in an unchanged history). `text` and `meta` are what the app shows.
 */
export const assistantMessages = pgTable('assistant_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id').notNull().references(() => assistantConversations.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  role: text('role').$type<'user' | 'assistant'>().notNull(),
  /** The message as the API takes it (content blocks, tool uses and results included). */
  content: jsonb('content').$type<unknown>().notNull(),
  /** Shown in the app: the person's words, or the assistant's reply; empty for tool-result turns. */
  text: text('text').notNull().default(''),
  meta: jsonb('meta').$type<{ tools?: string[]; organs?: string[]; links?: { label: string; url: string }[]; wrote?: boolean; refused?: boolean }>(),
  createdAt: createdAt(),
}, t => [uniqueIndex('assistant_messages_seq_key').on(t.conversationId, t.seq)]);

/* ---------- WhatsApp (shared/whatsapp.ts, server/src/whatsapp/) ---------- */

/** The WhatsApp number linked to an account, in the account's cell. One number per account, one account per number. */
export const whatsappLinks = pgTable('whatsapp_links', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  /** The WhatsApp id: the number with its country code, digits only. */
  phone: text('phone').notNull(),
  /** The profile WhatsApp works on and saves reports to. */
  profileId: uuid('profile_id').notNull().references(() => profiles.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
}, t => [uniqueIndex('whatsapp_links_phone_key').on(t.phone)]);

/**
 * Which cell holds the account a WhatsApp number is linked to, keyed by an HMAC of the number (like `directory`).
 * Default database only.
 */
export const whatsappDirectory = pgTable('whatsapp_directory', {
  phoneHash: text('phone_hash').primaryKey(),
  region: text('region').$type<DataRegion>().notNull(),
  userId: uuid('user_id').notNull(),
  createdAt: createdAt(),
}, t => [index('whatsapp_directory_user_idx').on(t.userId)]);

/** Link codes waiting to be sent from WhatsApp, keyed by an HMAC of the code. Default database only. */
export const whatsappLinkCodes = pgTable('whatsapp_link_codes', {
  codeHash: text('code_hash').primaryKey(),
  region: text('region').$type<DataRegion>().notNull(),
  userId: uuid('user_id').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
}, t => [index('whatsapp_link_codes_user_idx').on(t.userId)]);

/** Ids of incoming WhatsApp messages already handled (Meta can deliver one more than once). Default database only. */
export const whatsappInbound = pgTable('whatsapp_inbound', {
  messageId: text('message_id').primaryKey(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
});

export type UserRow = typeof users.$inferSelect;
export type ConsentRow = typeof consents.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
export type ProfileRow = typeof profiles.$inferSelect;
export type DocumentRow = typeof documents.$inferSelect;
export type MeasurementRow = typeof measurements.$inferSelect;
export type ScanRow = typeof scans.$inferSelect;
export type PartnerLabRow = typeof partnerLabs.$inferSelect;
export type LabOrderRow = typeof labOrders.$inferSelect;
export type LabOrderEventRow = typeof labOrderEvents.$inferSelect;
export type LabWebhookInboxRow = typeof labWebhookInbox.$inferSelect;
export type LabResultRow = typeof labResults.$inferSelect;
export type OAuthClientRow = typeof oauthClients.$inferSelect;
export type AgentGrantRow = typeof agentGrants.$inferSelect;
export type AgentTokenRow = typeof agentTokens.$inferSelect;
export type NotificationRow = typeof notifications.$inferSelect;
export type AssistantConversationRow = typeof assistantConversations.$inferSelect;
export type AssistantMessageRow = typeof assistantMessages.$inferSelect;
export type WhatsAppLinkRow = typeof whatsappLinks.$inferSelect;
