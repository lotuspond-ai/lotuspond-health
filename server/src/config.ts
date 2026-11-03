// Runtime configuration from environment variables. See server/.env.example.
import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform(v => v === 'true' || v === '1');

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
});

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
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;
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
  };
}
