// Runtime configuration from environment variables. See server/.env.example.
import { z } from 'zod';
import type { DataRegion } from '../../shared/regions.ts';

const bool = z.enum(['true', 'false', '1', '0']).transform(v => v === 'true' || v === '1');

export const DATA_REGIONS: readonly DataRegion[] = ['in', 'eu', 'us', 'global'];

/** A 32-byte key, base64 encoded (standard or URL-safe alphabet). */
const key32 = z.string().trim().refine(s => decodeKey(s) !== null, 'Use 32 random bytes in base64, e.g. from `openssl rand -base64 32`.');
const keyList = z.string().trim().refine(s => !s || s.split(',').every(k => decodeKey(k.trim()) !== null), 'Use comma-separated 32-byte base64 keys.');

/** Per-cell settings, e.g. CELL_IN_DATABASE_URL. */
function cellEnv(r: DataRegion) {
  const p = `CELL_${r.toUpperCase()}_`;
  return {
    [`${p}DATABASE_URL`]: z.string().url().optional(),
    [`${p}DATA_DIR`]: z.string().optional(),
    [`${p}FILE_ENCRYPTION_KEY`]: key32.optional(),
    [`${p}FILE_ENCRYPTION_PREVIOUS_KEYS`]: keyList.optional(),
  };
}

const Env = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  HOST: z.string().default('0.0.0.0'),
  /** postgres://user:pass@host:5432/db. When unset, an embedded PGlite database is kept in DATA_DIR. */
  DATABASE_URL: z.string().url().optional(),
  /** Uploaded files and the embedded database live here. */
  DATA_DIR: z.string().default('.data'),
  /** Built frontend to serve (defaults to ../dist in production). */
  STATIC_DIR: z.string().optional(),
  /** Public address of this server, e.g. https://health.lotuspond.ai. Used in OAuth and MCP metadata for agents; derived from the request when unset. */
  PUBLIC_URL: z.string().url().optional(),
  /** Extra origins allowed to make changes, comma-separated (for a frontend on another host). */
  APP_ORIGINS: z.string().default(''),
  /** Origins of the iOS and Android apps. They may call the API with bearer tokens (CORS, no cookies). */
  APP_CLIENT_ORIGINS: z.string().default('capacitor://localhost,https://localhost'),
  /** API origin of each region when regions run on separate hosts, e.g. "in=https://in.health.lotuspond.ai,eu=https://eu.health.lotuspond.ai". */
  REGION_API_ORIGINS: z.string().default(''),
  /** Send cookies over HTTPS only. Defaults to true in production. */
  COOKIE_SECURE: bool.optional(),
  /** Read the client address from X-Forwarded-For (set when running behind a reverse proxy). */
  TRUST_PROXY: bool.default(false),
  SESSION_DAYS: z.coerce.number().positive().max(365).default(30),
  MAX_UPLOAD_MB: z.coerce.number().positive().max(1024).default(50),
  /* Nearby labs and facilities (see server/src/facilities/). */
  FACILITY_SEARCH: z.enum(['on', 'off', 'true', 'false', '1', '0']).default('on'),
  /** 'fixture' answers from recorded responses in server/data/fixtures (development and tests only). */
  FACILITY_PROVIDER: z.enum(['http', 'fixture']).default('http'),
  /** Lab partners for home sample collection, comma-separated. Only 'fake' (the simulated lab) exists so far. */
  LAB_PARTNERS: z.string().optional(),
  LAB_FAKE_STEP_MS: z.coerce.number().int().min(100).max(3_600_000).default(10_000),
  /**
   * The optional Claude read of photographed and scanned reports (docs/report-reading.md): on when Anthropic
   * credentials are set (ANTHROPIC_API_KEY, read by the SDK), unless AI_EXTRACTION=off.
   */
  AI_EXTRACTION: z.enum(['on', 'off']).default('on'),
  AI_EXTRACTION_MODEL: z.string().trim().min(1).default('claude-opus-5-5'),
  /** LotusPond's assistant (chat in the app): on when Anthropic credentials are set, unless ASSISTANT=off. */
  ASSISTANT: z.enum(['on', 'off']).default('on'),
  ASSISTANT_MODEL: z.string().trim().min(1).default('claude-opus-5-5'),
  /* Orange Health Labs (lab/partners/orange.ts), with LAB_PARTNERS=orange. */
  /** The partner API key Orange Health issues (integrations@orangehealth.in). */
  ORANGE_API_KEY: z.string().trim().min(8).optional(),
  /** The secret set with Orange Health for signing webhooks. */
  ORANGE_WEBHOOK_SECRET: z.string().trim().min(16, 'Use at least 16 characters, e.g. from `openssl rand -hex 32`.').optional(),
  /** Our webhook path secret: Orange Health posts to PUBLIC_URL/hooks/orange/<this>. */
  ORANGE_HOOK_SECRET: z.string().trim().regex(/^[\w-]{24,128}$/, 'Use 24-128 letters, digits, - or _, e.g. from `openssl rand -hex 32`.').optional(),
  /** JSON file with the tests and packages Orange Health offers us, with prices (see docs/lab-partners.md). */
  ORANGE_CATALOG_FILE: z.string().trim().optional(),
  ORANGE_API_URL: z.string().url().default('https://sandbox-partner-api.orangehealth.dev'),
  /** Who collects payment, as named on Orange Health orders. */
  ORANGE_PAYMENT_TYPE: z.string().trim().min(1).default('paid_by_group'),
  /** Optional comma-separated addresses Orange Health sends webhooks from. */
  ORANGE_WEBHOOK_IPS: z.string().default(''),
  OVERPASS_URL: z.string().url().default('https://overpass-api.de/api/interpreter'),
  GEOCODER_URL: z.string().url().default('https://nominatim.openstreetmap.org'),
  /** Contact address sent to OpenStreetMap services (Nominatim usage policy asks for one). */
  GEO_CONTACT_EMAIL: z.string().email().optional(),
  GEO_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(20_000),
  /** Map tiles: a self-hosted Protomaps .pmtiles file (URL or path), or a MapLibre style URL. Otherwise OpenStreetMap raster tiles. */
  MAP_PMTILES_URL: z.string().optional(),
  MAP_STYLE_URL: z.string().url().optional(),
  /** Fonts and sprites for the Protomaps style; self-host them next to the .pmtiles file for no third-party requests. */
  MAP_ASSETS_URL: z.string().default('https://protomaps.github.io/basemaps-assets'),
  /** Directory whose .pmtiles files are served at /api/map/files/<name>. */
  MAP_TILES_DIR: z.string().optional(),

  /** Data-residency cells this deployment holds records for: "all" or a comma-separated list of in, eu, us, global. */
  SERVED_REGIONS: z.string().default('all'),
  /** HMAC key for the email directory (and, derived from it, for hashing addresses in the audit log). */
  DIRECTORY_SECRET: z.string().trim().min(32, 'Use at least 32 characters, e.g. from `openssl rand -base64 32`.').optional(),
  /** AES-256-GCM key for uploaded files. Required in production unless FILE_ENCRYPTION=off. */
  FILE_ENCRYPTION_KEY: key32.optional(),
  /** Older keys, still accepted for reading while files are re-encrypted with `files:rekey`. */
  FILE_ENCRYPTION_PREVIOUS_KEYS: keyList.optional(),
  FILE_ENCRYPTION: z.enum(['on', 'off']).default('on'),
  /** Generate missing secrets in DATA_DIR even when NODE_ENV=production (npm run local on a laptop; never on a server). */
  LOCAL_SECRETS: bool.default(false),
  /** Account events are kept this long. */
  AUDIT_RETENTION_DAYS: z.coerce.number().int().positive().max(3650).default(400),
  /** Published contacts, shown on the Account page. India (DPDP Act) requires a grievance contact. */
  GRIEVANCE_CONTACT: z.string().trim().max(300).optional(),
  DPO_CONTACT: z.string().trim().max(300).optional(),
  ...Object.assign({}, ...DATA_REGIONS.map(cellEnv)) as Record<string, z.ZodOptional<z.ZodString>>,
});

export interface FacilityConfig {
  search: boolean;
  provider: 'http' | 'fixture';
  overpassUrl: string;
  geocoderUrl: string;
  contactEmail: string | undefined;
  timeoutMs: number;
}

export interface MapConfig {
  pmtilesUrl: string | undefined;
  styleUrl: string | undefined;
  assetsUrl: string;
  tilesDir: string | undefined;
}

export interface OrangeConfig {
  apiKey: string;
  webhookSecret: string;
  hookSecret: string;
  catalogFile: string;
  apiUrl: string;
  paymentType: string;
  webhookIps: string[];
}

export interface CellConfig {
  region: DataRegion;
  /** Own PostgreSQL database. */
  databaseUrl?: string;
  /** Own directory for files (and an embedded database when there is no databaseUrl). */
  dataDir?: string;
  fileEncryptionKey?: string;
  fileEncryptionPreviousKeys: string[];
}

export interface Config {
  env: 'development' | 'production' | 'test';
  port: number;
  host: string;
  databaseUrl: string | undefined;
  dataDir: string;
  staticDir: string | undefined;
  /** Public origin (no trailing slash), when configured. */
  publicUrl: string | undefined;
  allowedOrigins: string[];
  appClientOrigins: string[];
  regionApiOrigins: Partial<Record<DataRegion, string>>;
  cookieSecure: boolean;
  trustProxy: boolean;
  sessionTtlMs: number;
  maxUploadBytes: number;
  facilities: FacilityConfig;
  /** Lab partners switched on (docs/lab-booking-backend.md). */
  labs: { partners: string[]; fakeStepMs: number; orange?: OrangeConfig };
  /** The Claude read is on (credentials present and not switched off), and its model. */
  aiExtraction: { enabled: boolean; model: string };
  assistant: { enabled: boolean; model: string };
  map: MapConfig;
  servedRegions: DataRegion[];
  /** Settings for each served region. A region with neither databaseUrl nor dataDir is kept in the default cell. */
  cells: CellConfig[];
  directorySecret: string | undefined;
  fileEncryption: boolean;
  fileEncryptionKey: string | undefined;
  fileEncryptionPreviousKeys: string[];
  localSecrets: boolean;
  auditRetentionMs: number;
  grievanceContact: string | undefined;
  dpoContact: string | undefined;
}

/** Decode a base64 key to 32 bytes, or null. */
export function decodeKey(s: string): Buffer | null {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) return null;
  const buf = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return buf.length === 32 ? buf : null;
}

const list = (s: string | undefined) => (s ?? '').split(',').map(x => x.trim()).filter(Boolean);

/** "in=https://in.example,eu=https://eu.example" → { in: 'https://in.example', eu: 'https://eu.example' }. */
function parseRegionOrigins(raw: string): Partial<Record<DataRegion, string>> {
  const out: Partial<Record<DataRegion, string>> = {};
  for (const pair of list(raw)) {
    const [region, url] = pair.split('=').map(x => x?.trim());
    if (!DATA_REGIONS.includes(region as DataRegion) || !url || !/^https?:\/\/[^/]+$/.test(url.replace(/\/$/, ''))) {
      throw new Error(`Invalid configuration: REGION_API_ORIGINS: "${pair}" should look like in=https://in.health.lotuspond.ai`);
    }
    out[region as DataRegion] = url.replace(/\/$/, '');
  }
  return out;
}

function parseRegions(raw: string): DataRegion[] {
  const v = raw.trim().toLowerCase();
  if (v === '' || v === 'all') return [...DATA_REGIONS];
  const out = list(v);
  const unknown = out.filter(r => !DATA_REGIONS.includes(r as DataRegion));
  if (unknown.length) throw new Error(`Invalid configuration: SERVED_REGIONS: unknown region ${unknown.join(', ')} (use in, eu, us, global or all)`);
  return [...new Set(out)] as DataRegion[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  if (e.FACILITY_PROVIDER === 'fixture' && e.NODE_ENV === 'production') {
    throw new Error('Invalid configuration: FACILITY_PROVIDER=fixture is for development only.');
  }
  // The simulated lab is on by default in development, so booking can be tried without a partner.
  const labPartners = list(e.LAB_PARTNERS ?? (e.NODE_ENV === 'development' ? 'fake' : ''));
  const unknownLab = labPartners.filter(p => p !== 'fake' && p !== 'orange');
  if (unknownLab.length) throw new Error(`Invalid configuration: LAB_PARTNERS: unknown partner ${unknownLab.join(', ')} (use fake or orange)`);
  let orange: OrangeConfig | undefined;
  if (labPartners.includes('orange')) {
    const missing = (['ORANGE_API_KEY', 'ORANGE_WEBHOOK_SECRET', 'ORANGE_HOOK_SECRET', 'ORANGE_CATALOG_FILE'] as const).filter(k => !e[k]);
    if (missing.length) throw new Error(`Invalid configuration: LAB_PARTNERS=orange needs ${missing.join(', ')} (see docs/lab-partners.md)`);
    orange = {
      apiKey: e.ORANGE_API_KEY!, webhookSecret: e.ORANGE_WEBHOOK_SECRET!, hookSecret: e.ORANGE_HOOK_SECRET!, catalogFile: e.ORANGE_CATALOG_FILE!,
      apiUrl: e.ORANGE_API_URL.replace(/\/$/, ''), paymentType: e.ORANGE_PAYMENT_TYPE, webhookIps: list(e.ORANGE_WEBHOOK_IPS),
    };
    if (e.NODE_ENV === 'production' && /sandbox|\.dev(\/|$)/.test(orange.apiUrl)) {
      console.warn('[config] ORANGE_API_URL is the Orange Health sandbox; bookings will not reach a real lab.');
    }
  }
  if (labPartners.includes('fake') && e.NODE_ENV === 'production') {
    throw new Error('Invalid configuration: LAB_PARTNERS=fake is the simulated lab, for development and tests only.');
  }
  const cellVar = (r: DataRegion, name: string) => (e as unknown as Record<string, string | undefined>)[`CELL_${r.toUpperCase()}_${name}`];
  const servedRegions = parseRegions(e.SERVED_REGIONS);

  const cells: CellConfig[] = servedRegions.map(region => ({
    region,
    databaseUrl: cellVar(region, 'DATABASE_URL'),
    dataDir: cellVar(region, 'DATA_DIR'),
    fileEncryptionKey: cellVar(region, 'FILE_ENCRYPTION_KEY'),
    fileEncryptionPreviousKeys: list(cellVar(region, 'FILE_ENCRYPTION_PREVIOUS_KEYS')),
  }));

  // Settings that would mix two cells' data, or that would silently do nothing.
  const urls = new Map<string, string>();
  if (e.DATABASE_URL) urls.set(e.DATABASE_URL, 'DATABASE_URL');
  for (const c of cells) {
    const name = `CELL_${c.region.toUpperCase()}_`;
    if (c.databaseUrl) {
      const other = urls.get(c.databaseUrl);
      if (other) throw new Error(`Invalid configuration: ${name}DATABASE_URL is the same database as ${other}. Each cell needs its own database; leave it unset to keep this region in the default database.`);
      urls.set(c.databaseUrl, `${name}DATABASE_URL`);
    }
    if ((c.fileEncryptionKey || c.fileEncryptionPreviousKeys.length) && !c.databaseUrl && !c.dataDir) {
      throw new Error(`Invalid configuration: ${name}FILE_ENCRYPTION_KEY is set, but this region has no database or data directory of its own, so it uses the default cell and its key.`);
    }
  }
  const dirs = cells.filter(c => c.dataDir).map(c => c.dataDir!);
  if (new Set(dirs).size !== dirs.length) throw new Error('Invalid configuration: two cells share a CELL_*_DATA_DIR. Give each cell its own directory.');
  for (const r of DATA_REGIONS) {
    if (!servedRegions.includes(r) && (cellVar(r, 'DATABASE_URL') || cellVar(r, 'DATA_DIR'))) {
      console.warn(`[config] CELL_${r.toUpperCase()}_* is set but "${r}" is not in SERVED_REGIONS; it is ignored.`);
    }
  }

  return {
    env: e.NODE_ENV,
    port: e.PORT,
    host: e.HOST,
    databaseUrl: e.DATABASE_URL,
    dataDir: e.DATA_DIR,
    staticDir: e.STATIC_DIR,
    publicUrl: e.PUBLIC_URL ? new URL(e.PUBLIC_URL).origin : undefined,
    allowedOrigins: e.APP_ORIGINS.split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean),
    appClientOrigins: e.APP_CLIENT_ORIGINS.split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean),
    regionApiOrigins: parseRegionOrigins(e.REGION_API_ORIGINS),
    cookieSecure: e.COOKIE_SECURE ?? e.NODE_ENV === 'production',
    trustProxy: e.TRUST_PROXY,
    sessionTtlMs: e.SESSION_DAYS * 24 * 60 * 60 * 1000,
    maxUploadBytes: Math.round(e.MAX_UPLOAD_MB * 1024 * 1024),
    facilities: {
      search: !['off', 'false', '0'].includes(e.FACILITY_SEARCH),
      provider: e.FACILITY_PROVIDER,
      overpassUrl: e.OVERPASS_URL,
      geocoderUrl: e.GEOCODER_URL.replace(/\/$/, ''),
      contactEmail: e.GEO_CONTACT_EMAIL,
      timeoutMs: e.GEO_TIMEOUT_MS,
    },
    labs: { partners: labPartners, fakeStepMs: e.LAB_FAKE_STEP_MS, ...(orange ? { orange } : {}) },
    aiExtraction: { enabled: e.AI_EXTRACTION === 'on' && !!(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN), model: e.AI_EXTRACTION_MODEL },
    assistant: { enabled: e.ASSISTANT === 'on' && !!(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN), model: e.ASSISTANT_MODEL },
    map: {
      pmtilesUrl: e.MAP_PMTILES_URL || undefined,
      styleUrl: e.MAP_STYLE_URL,
      assetsUrl: e.MAP_ASSETS_URL.replace(/\/$/, ''),
      tilesDir: e.MAP_TILES_DIR,
    },
    servedRegions,
    cells,
    directorySecret: e.DIRECTORY_SECRET,
    fileEncryption: e.FILE_ENCRYPTION === 'on',
    fileEncryptionKey: e.FILE_ENCRYPTION_KEY,
    fileEncryptionPreviousKeys: list(e.FILE_ENCRYPTION_PREVIOUS_KEYS),
    localSecrets: e.LOCAL_SECRETS,
    auditRetentionMs: e.AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    grievanceContact: e.GRIEVANCE_CONTACT || undefined,
    dpoContact: e.DPO_CONTACT || undefined,
  };
}
