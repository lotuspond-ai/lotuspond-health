// Runtime configuration from environment variables. See server/.env.example.
import { z } from 'zod';
import { COUNTRY_CODES, LEGAL_RESTRICTIONS, OPEN_COUNTRIES, isCountryCode, type DataRegion } from '../../shared/regions.ts';

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
   * Sign-in through LotusPond Accounts (docs/identity.md): its OpenID Connect issuer URL, or 'fake' for the stand-in
   * issuer inside this server (development and tests only). Unset keeps Health's own email-and-password sign-in only.
   */
  ACCOUNTS_ISSUER: z.string().optional(),
  ACCOUNTS_CLIENT_ID: z.string().optional(),
  /** Unset for a public client (PKCE only). */
  ACCOUNTS_CLIENT_SECRET: z.string().optional(),
  /**
   * Health's own email-and-password sign-up and sign-in, and its email directory. 'off' once every account is in
   * LotusPond Accounts (docs/identity.md, "Moving the directory into Accounts"); needs ACCOUNTS_ISSUER.
   */
  PASSWORD_SIGN_IN: z.enum(['on', 'off']).default('on'),
  /**
   * Universal links (iOS) and verified app links (Android) for returning a sign-in to the apps: the https origin of
   * the host the apps claim (shared/identity.ts, APP_LINKS_HOST), which this server must also answer for. Unset: the
   * apps' private-use scheme only.
   */
  APP_LINKS_ORIGIN: z.string().url().optional(),
  /** Apple Developer team id, for apple-app-site-association (10 characters, e.g. A1B2C3D4E5). */
  APPLE_TEAM_ID: z.string().regex(/^[A-Z0-9]{10}$/, 'APPLE_TEAM_ID is the 10-character Apple Developer team id.').optional(),
  /** SHA-256 fingerprints of the Android app's signing certificates, comma-separated (AA:BB:…), for assetlinks.json. */
  ANDROID_APP_SHA256: z.string().optional(),
  /**
   * The optional Claude read of photographed and scanned reports (docs/report-reading.md): on when Anthropic
   * credentials are set (ANTHROPIC_API_KEY, read by the SDK), unless AI_EXTRACTION=off.
   */
  AI_EXTRACTION: z.enum(['on', 'off']).default('on'),
  AI_EXTRACTION_MODEL: z.string().trim().min(1).default('claude-opus-5-5'),
  /** LotusPond's assistant (chat in the app): on when Anthropic credentials are set, unless ASSISTANT=off. */
  ASSISTANT: z.enum(['on', 'off']).default('on'),
  ASSISTANT_MODEL: z.string().trim().min(1).default('claude-opus-5-5'),
  /* WhatsApp (docs/whatsapp.md): the assistant on WhatsApp through Meta's Cloud API. On when all four are set. */
  /** The business phone number's id in WhatsApp Manager (not the number itself). */
  WHATSAPP_PHONE_NUMBER_ID: z.string().trim().regex(/^\d{5,32}$/, 'The phone number id is digits, from WhatsApp Manager.').optional(),
  /** The number people message, with country code, e.g. 919876543210 (used for the wa.me link). */
  WHATSAPP_NUMBER: z.string().trim().transform(s => s.replace(/[\s+()-]/g, '')).pipe(z.string().regex(/^\d{8,15}$/, 'Write the number with its country code, digits only.')).optional(),
  /** A system user access token with whatsapp_business_messaging. */
  WHATSAPP_ACCESS_TOKEN: z.string().trim().min(20).optional(),
  /** The Meta app secret: webhook deliveries are signed with it. */
  WHATSAPP_APP_SECRET: z.string().trim().min(16).optional(),
  /** What Meta sends when the webhook is verified; set the same value in the app's webhook settings. */
  WHATSAPP_VERIFY_TOKEN: z.string().trim().min(16).optional(),
  WHATSAPP_GRAPH_URL: z.string().url().default('https://graph.facebook.com/v23.0'),
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
  /* The record agent (docs/record-agent.md): fetches reports from portals in a browser of its own for each person. */
  /** On by default in development and tests; in production it needs RECORD_AGENT=on. */
  RECORD_AGENT: z.enum(['on', 'off']).optional(),
  /**
   * Where its browsers run: 'local' starts Chromium on this server (Playwright); 'cdp' connects to any browser service
   * that gives a Chrome DevTools Protocol address (Steel, Browserless, Hyperbrowser, Anchor, your own); 'browserbase'
   * creates a Browserbase session for each run.
   */
  RECORD_BROWSER: z.enum(['local', 'cdp', 'browserbase']).default('local'),
  /** For 'cdp': the wss:// address, with its key, e.g. wss://connect.steel.dev?apiKey=… */
  RECORD_BROWSER_CDP_URL: z.string().url().optional(),
  /** For 'local': a Chromium or Chrome to use instead of Playwright's own. */
  RECORD_BROWSER_EXECUTABLE: z.string().optional(),
  BROWSERBASE_API_KEY: z.string().trim().min(8).optional(),
  BROWSERBASE_PROJECT_ID: z.string().trim().min(4).optional(),
  BROWSERBASE_API_URL: z.string().url().default('https://api.browserbase.com'),
  /** Runs at the same time on this server; more wait their turn. */
  RECORD_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(2),
  /** The pretend lab portal at /demo-portal, to try the agent (development and tests only; on by default there). */
  RECORD_DEMO_PORTAL: z.enum(['on', 'off']).optional(),
  /** Claude finding its way around portals without a recipe: on when Anthropic credentials are set, unless off. */
  RECORD_NAVIGATOR: z.enum(['on', 'off']).default('on'),
  RECORD_NAVIGATOR_MODEL: z.string().trim().min(1).default('claude-opus-5-5'),
  /** Development only: save a screenshot and the page at every step of a run here, to fix recipes against real pages. */
  RECORD_DEBUG_DIR: z.string().optional(),
  /* ABHA through Eka Care's ABDM Connect (docs/abdm.md): on when the client id and secret are set. */
  EKA_CLIENT_ID: z.string().trim().min(4).optional(),
  EKA_CLIENT_SECRET: z.string().trim().min(8).optional(),
  /** https://api.eka.care: console clients, sandbox or production, sign in here (the client decides which NHA). */
  EKA_API_URL: z.string().url().default('https://api.eka.care'),
  /** LotusPond as the health information user its consent requests come from (Eka's clinic and doctor ids). */
  EKA_HIU_CLINIC_ID: z.string().trim().min(1).optional(),
  EKA_HIU_DOCTOR_OID: z.string().trim().min(1).optional(),
  /* Withings (docs/record-agent.md): on when the client id and secret are set. Register the redirect URI
     PUBLIC_URL/records/oauth/withings/callback in the Withings developer dashboard. */
  WITHINGS_CLIENT_ID: z.string().trim().min(8).optional(),
  WITHINGS_CLIENT_SECRET: z.string().trim().min(8).optional(),
  /* Oura and Ultrahuman, the same way: redirect URIs PUBLIC_URL/records/oauth/oura/callback and
     PUBLIC_URL/records/oauth/ultrahuman/callback. Ultrahuman grants CGM data on request: ULTRAHUMAN_CGM=on once it has. */
  OURA_CLIENT_ID: z.string().trim().min(8).optional(),
  OURA_CLIENT_SECRET: z.string().trim().min(8).optional(),
  ULTRAHUMAN_CLIENT_ID: z.string().trim().min(8).optional(),
  ULTRAHUMAN_CLIENT_SECRET: z.string().trim().min(8).optional(),
  ULTRAHUMAN_CGM: z.enum(['on', 'off']).default('off'),
  /* Email, for report PDFs labs send: a Google OAuth client (Gmail API, scope gmail.readonly) and a Microsoft Entra app
     (Graph, Mail.Read, personal and work accounts). Redirect URIs PUBLIC_URL/records/oauth/gmail/callback and
     PUBLIC_URL/records/oauth/outlook/callback. */
  GMAIL_CLIENT_ID: z.string().trim().min(8).optional(),
  GMAIL_CLIENT_SECRET: z.string().trim().min(8).optional(),
  OUTLOOK_CLIENT_ID: z.string().trim().min(8).optional(),
  OUTLOOK_CLIENT_SECRET: z.string().trim().min(8).optional(),
  /* DigiLocker's Authorized Partner (Requester) API: credentials from DigiLocker's partner portal once LotusPond is
     registered as a Requester. Redirect URI PUBLIC_URL/records/oauth/digilocker/callback. DIGILOCKER_API_URL points at
     a sandbox when DigiLocker gives one. */
  DIGILOCKER_CLIENT_ID: z.string().trim().min(4).optional(),
  DIGILOCKER_CLIENT_SECRET: z.string().trim().min(8).optional(),
  DIGILOCKER_API_URL: z.string().url().default('https://digilocker.meripehchaan.gov.in'),
  /** The key Eka signs webhooks with; the webhook at /hooks/eka is served only when it is set. */
  EKA_WEBHOOK_SIGNING_KEY: z.string().trim().min(16).optional(),
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
  /** Countries where sign-up is open: a comma-separated list of ISO codes, or `all`. Empty: shared/regions.ts OPEN_COUNTRIES (India). */
  OPEN_COUNTRIES: z.string().default(''),
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

export interface AccountsConfig {
  /** The issuer URL, or 'fake' for the stand-in issuer (auth/fake-accounts.ts). */
  issuer: string;
  clientId: string;
  clientSecret?: string;
}

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

export interface RecordAgentConfig {
  browser:
    | { kind: 'local'; executablePath?: string }
    | { kind: 'cdp'; url: string }
    | { kind: 'browserbase'; apiKey: string; projectId: string; apiUrl: string };
  concurrency: number;
  demoPortal: boolean;
  /**
   * Whether people may type a portal's address ("another lab"). Its owner controls the address's DNS, so a browser on
   * this server could be pointed at our own network; in production that needs a browser off our servers (cdp or
   * browserbase). Portals LotusPond lists have fixed hosts and work with any browser.
   */
  typedPortals: boolean;
  /** Claude's model for the navigator, when it is on. */
  navigator: { model: string } | undefined;
  /** Development only: where each step's screenshot and page are saved. */
  debugDir?: string;
  /** ABHA through Eka Care's ABDM Connect, when its client is set. */
  eka?: { apiUrl: string; clientId: string; clientSecret: string; hiu?: { clinicId: string; doctorOid: string }; webhookSigningKey?: string };
  /** Withings, when its client is set; `redirectUri` is where its sign-in page sends people back. */
  withings?: { clientId: string; clientSecret: string; redirectUri: string };
  oura?: { clientId: string; clientSecret: string; redirectUri: string };
  ultrahuman?: { clientId: string; clientSecret: string; redirectUri: string; cgm: boolean };
  gmail?: { clientId: string; clientSecret: string; redirectUri: string };
  outlook?: { clientId: string; clientSecret: string; redirectUri: string };
  digilocker?: { clientId: string; clientSecret: string; redirectUri: string; apiUrl: string };
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
  /** Sign-in through LotusPond Accounts, when ACCOUNTS_ISSUER is set. */
  accounts?: AccountsConfig;
  /** Health's own password sign-up and sign-in, and the email directory they use. False: LotusPond Accounts only. */
  passwordSignIn: boolean;
  /** Universal links and app links for the apps (routes/app-links.ts). */
  appLinks: { origin?: string; appleTeamId?: string; androidSha256: string[] };
  /** The Claude read is on (credentials present and not switched off), and its model. */
  aiExtraction: { enabled: boolean; model: string };
  assistant: { enabled: boolean; model: string };
  /** The record agent (records/), when switched on. */
  records: RecordAgentConfig | undefined;
  /** The assistant on WhatsApp, when the Cloud API is set up (and the assistant is on). */
  whatsapp: { phoneNumberId: string; number: string; accessToken: string; appSecret: string; verifyToken: string; graphUrl: string } | undefined;
  map: MapConfig;
  servedRegions: DataRegion[];
  /** Countries where this server accepts sign-up (OPEN_COUNTRIES; India by default). */
  openCountries: string[];
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

function parseOpenCountries(raw: string): string[] {
  const v = raw.trim().toUpperCase();
  if (v === '') return [...OPEN_COUNTRIES];
  if (v === 'ALL') return COUNTRY_CODES.filter(c => !LEGAL_RESTRICTIONS[c]);
  const out = [...new Set(list(v))];
  const unknown = out.filter(c => !isCountryCode(c));
  if (unknown.length) throw new Error(`Invalid configuration: OPEN_COUNTRIES: unknown country ${unknown.join(', ')} (use ISO codes such as IN, or all)`);
  const restricted = out.filter(c => LEGAL_RESTRICTIONS[c]);
  if (restricted.length) throw new Error(`Invalid configuration: OPEN_COUNTRIES: ${restricted.join(', ')} cannot open (shared/regions.ts LEGAL_RESTRICTIONS)`);
  return out;
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
  let records: RecordAgentConfig | undefined;
  if ((e.RECORD_AGENT ?? (e.NODE_ENV === 'production' ? 'off' : 'on')) === 'on') {
    const b = e.RECORD_BROWSER;
    if (b === 'cdp' && !e.RECORD_BROWSER_CDP_URL) throw new Error('Invalid configuration: RECORD_BROWSER=cdp needs RECORD_BROWSER_CDP_URL (the wss:// address of the browser service).');
    if (b === 'browserbase' && !(e.BROWSERBASE_API_KEY && e.BROWSERBASE_PROJECT_ID)) throw new Error('Invalid configuration: RECORD_BROWSER=browserbase needs BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID.');
    const demoPortal = (e.RECORD_DEMO_PORTAL ?? (e.NODE_ENV === 'production' ? 'off' : 'on')) === 'on';
    if (demoPortal && e.NODE_ENV === 'production') throw new Error('Invalid configuration: RECORD_DEMO_PORTAL is the pretend lab portal, for development and tests only.');
    if (e.RECORD_DEBUG_DIR && e.NODE_ENV === 'production') throw new Error('Invalid configuration: RECORD_DEBUG_DIR saves people\'s portal pages to disk, for development only.');
    records = {
      browser: b === 'cdp' ? { kind: 'cdp', url: e.RECORD_BROWSER_CDP_URL! }
        : b === 'browserbase' ? { kind: 'browserbase', apiKey: e.BROWSERBASE_API_KEY!, projectId: e.BROWSERBASE_PROJECT_ID!, apiUrl: e.BROWSERBASE_API_URL.replace(/\/$/, '') }
          : { kind: 'local', ...(e.RECORD_BROWSER_EXECUTABLE ? { executablePath: e.RECORD_BROWSER_EXECUTABLE } : {}) },
      concurrency: e.RECORD_CONCURRENCY,
      demoPortal,
      typedPortals: b !== 'local' || e.NODE_ENV !== 'production',
      navigator: e.RECORD_NAVIGATOR === 'on' && !!(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) ? { model: e.RECORD_NAVIGATOR_MODEL } : undefined,
      ...(e.RECORD_DEBUG_DIR ? { debugDir: e.RECORD_DEBUG_DIR } : {}),
      ...(e.EKA_CLIENT_ID && e.EKA_CLIENT_SECRET ? {
        eka: {
          apiUrl: e.EKA_API_URL.replace(/\/$/, ''), clientId: e.EKA_CLIENT_ID, clientSecret: e.EKA_CLIENT_SECRET,
          ...(e.EKA_HIU_CLINIC_ID && e.EKA_HIU_DOCTOR_OID ? { hiu: { clinicId: e.EKA_HIU_CLINIC_ID, doctorOid: e.EKA_HIU_DOCTOR_OID } } : {}),
          ...(e.EKA_WEBHOOK_SIGNING_KEY ? { webhookSigningKey: e.EKA_WEBHOOK_SIGNING_KEY } : {}),
        },
      } : {}),
    };
    if (!!e.EKA_CLIENT_ID !== !!e.EKA_CLIENT_SECRET) throw new Error('Invalid configuration: EKA_CLIENT_ID and EKA_CLIENT_SECRET go together.');
    const oauthClient = (name: string, id: string | undefined, secret: string | undefined, source: string) => {
      if (!!id !== !!secret) throw new Error(`Invalid configuration: ${name}_CLIENT_ID and ${name}_CLIENT_SECRET go together.`);
      if (!id || !secret) return undefined;
      if (!e.PUBLIC_URL) throw new Error(`Invalid configuration: ${name} needs PUBLIC_URL, for the address its sign-in page sends people back to.`);
      return { clientId: id, clientSecret: secret, redirectUri: `${new URL(e.PUBLIC_URL).origin}/records/oauth/${source}/callback` };
    };
    const withings = oauthClient('WITHINGS', e.WITHINGS_CLIENT_ID, e.WITHINGS_CLIENT_SECRET, 'withings');
    const oura = oauthClient('OURA', e.OURA_CLIENT_ID, e.OURA_CLIENT_SECRET, 'oura');
    const ultrahuman = oauthClient('ULTRAHUMAN', e.ULTRAHUMAN_CLIENT_ID, e.ULTRAHUMAN_CLIENT_SECRET, 'ultrahuman');
    if (withings) records.withings = withings;
    if (oura) records.oura = oura;
    if (ultrahuman) records.ultrahuman = { ...ultrahuman, cgm: e.ULTRAHUMAN_CGM === 'on' };
    const gmail = oauthClient('GMAIL', e.GMAIL_CLIENT_ID, e.GMAIL_CLIENT_SECRET, 'gmail');
    const outlook = oauthClient('OUTLOOK', e.OUTLOOK_CLIENT_ID, e.OUTLOOK_CLIENT_SECRET, 'outlook');
    if (gmail) records.gmail = gmail;
    if (outlook) records.outlook = outlook;
    const digilocker = oauthClient('DIGILOCKER', e.DIGILOCKER_CLIENT_ID, e.DIGILOCKER_CLIENT_SECRET, 'digilocker');
    if (digilocker) records.digilocker = { ...digilocker, apiUrl: e.DIGILOCKER_API_URL.replace(/\/$/, '') };
  }
  const androidSha256 = list(e.ANDROID_APP_SHA256).map(s => s.toUpperCase());
  const badPrint = androidSha256.find(s => !/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(s));
  if (badPrint) throw new Error(`Invalid configuration: ANDROID_APP_SHA256: ${badPrint} is not a SHA-256 fingerprint (32 bytes as AA:BB:…).`);
  if (e.APP_LINKS_ORIGIN && !e.APP_LINKS_ORIGIN.startsWith('https://')) throw new Error('Invalid configuration: APP_LINKS_ORIGIN must use https.');
  let accounts: AccountsConfig | undefined;
  if (e.ACCOUNTS_ISSUER) {
    if (e.ACCOUNTS_ISSUER === 'fake') {
      if (e.NODE_ENV === 'production') throw new Error('Invalid configuration: ACCOUNTS_ISSUER=fake is the stand-in sign-in service, for development and tests only.');
      accounts = { issuer: 'fake', clientId: e.ACCOUNTS_CLIENT_ID ?? 'lotuspond-health' };
    } else {
      let url: URL;
      try { url = new URL(e.ACCOUNTS_ISSUER); } catch { throw new Error('Invalid configuration: ACCOUNTS_ISSUER must be a URL, or fake.'); }
      if (url.protocol !== 'https:' && !(e.NODE_ENV !== 'production' && url.hostname === 'localhost')) {
        throw new Error('Invalid configuration: ACCOUNTS_ISSUER must use https.');
      }
      if (!e.ACCOUNTS_CLIENT_ID) throw new Error('Invalid configuration: ACCOUNTS_ISSUER needs ACCOUNTS_CLIENT_ID.');
      accounts = { issuer: e.ACCOUNTS_ISSUER.replace(/\/$/, ''), clientId: e.ACCOUNTS_CLIENT_ID, ...(e.ACCOUNTS_CLIENT_SECRET ? { clientSecret: e.ACCOUNTS_CLIENT_SECRET } : {}) };
    }
  }
  if (e.PASSWORD_SIGN_IN === 'off' && !accounts) throw new Error('Invalid configuration: PASSWORD_SIGN_IN=off needs ACCOUNTS_ISSUER: without passwords, LotusPond Accounts is the only way to sign in.');
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
    ...(accounts ? { accounts } : {}),
    passwordSignIn: e.PASSWORD_SIGN_IN === 'on',
    appLinks: {
      ...(e.APP_LINKS_ORIGIN ? { origin: new URL(e.APP_LINKS_ORIGIN).origin } : {}),
      ...(e.APPLE_TEAM_ID ? { appleTeamId: e.APPLE_TEAM_ID } : {}),
      androidSha256,
    },
    aiExtraction: { enabled: e.AI_EXTRACTION === 'on' && !!(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN), model: e.AI_EXTRACTION_MODEL },
    assistant: { enabled: e.ASSISTANT === 'on' && !!(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN), model: e.ASSISTANT_MODEL },
    records,
    whatsapp: e.WHATSAPP_PHONE_NUMBER_ID && e.WHATSAPP_NUMBER && e.WHATSAPP_ACCESS_TOKEN && e.WHATSAPP_APP_SECRET && e.WHATSAPP_VERIFY_TOKEN
      ? { phoneNumberId: e.WHATSAPP_PHONE_NUMBER_ID, number: e.WHATSAPP_NUMBER, accessToken: e.WHATSAPP_ACCESS_TOKEN, appSecret: e.WHATSAPP_APP_SECRET, verifyToken: e.WHATSAPP_VERIFY_TOKEN, graphUrl: e.WHATSAPP_GRAPH_URL.replace(/\/$/, '') }
      : undefined,
    map: {
      pmtilesUrl: e.MAP_PMTILES_URL || undefined,
      styleUrl: e.MAP_STYLE_URL,
      assetsUrl: e.MAP_ASSETS_URL.replace(/\/$/, ''),
      tilesDir: e.MAP_TILES_DIR,
    },
    servedRegions,
    openCountries: parseOpenCountries(e.OPEN_COUNTRIES),
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
