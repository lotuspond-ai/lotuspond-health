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
  /* Nearby labs and facilities (see server/src/facilities/). */
  FACILITY_SEARCH: z.enum(['on', 'off', 'true', 'false', '1', '0']).default('on'),
  /** 'fixture' answers from recorded responses in server/data/fixtures (development and tests only). */
  FACILITY_PROVIDER: z.enum(['http', 'fixture']).default('http'),
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
  facilities: FacilityConfig;
  map: MapConfig;
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
    facilities: {
      search: !['off', 'false', '0'].includes(e.FACILITY_SEARCH),
      provider: e.FACILITY_PROVIDER,
      overpassUrl: e.OVERPASS_URL,
      geocoderUrl: e.GEOCODER_URL.replace(/\/$/, ''),
      contactEmail: e.GEO_CONTACT_EMAIL,
      timeoutMs: e.GEO_TIMEOUT_MS,
    },
    map: {
      pmtilesUrl: e.MAP_PMTILES_URL || undefined,
      styleUrl: e.MAP_STYLE_URL,
      assetsUrl: e.MAP_ASSETS_URL.replace(/\/$/, ''),
      tilesDir: e.MAP_TILES_DIR,
    },
  };
}
