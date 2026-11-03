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
  /** Extra origins allowed to make changes, comma-separated (for a frontend on another host). */
  APP_ORIGINS: z.string().default(''),
  /** Send cookies over HTTPS only. Defaults to true in production. */
  COOKIE_SECURE: bool.optional(),
  /** Read the client address from X-Forwarded-For (set when running behind a reverse proxy). */
  TRUST_PROXY: bool.default(false),
  SESSION_DAYS: z.coerce.number().positive().max(365).default(30),
  MAX_UPLOAD_MB: z.coerce.number().positive().max(1024).default(50),

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
  allowedOrigins: string[];
  cookieSecure: boolean;
  trustProxy: boolean;
  sessionTtlMs: number;
  maxUploadBytes: number;
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
    allowedOrigins: e.APP_ORIGINS.split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean),
    cookieSecure: e.COOKIE_SECURE ?? e.NODE_ENV === 'production',
    trustProxy: e.TRUST_PROXY,
    sessionTtlMs: e.SESSION_DAYS * 24 * 60 * 60 * 1000,
    maxUploadBytes: Math.round(e.MAX_UPLOAD_MB * 1024 * 1024),
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
