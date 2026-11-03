// Server secrets: the directory HMAC key and the file-encryption keys.
// Production reads them from the environment and refuses to start without them. Development (and `npm run local`,
// through LOCAL_SECRETS=true) generates them once and keeps them in DATA_DIR/secrets, with a warning.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, hkdfSync, randomBytes } from 'node:crypto';
import type { DataRegion } from '../../../shared/regions.ts';
import { decodeKey, type Config } from '../config.ts';

export interface FileKeyring {
  /** Key for new files. */
  current: Buffer;
  /** Keys still accepted for reading (rotation in progress). */
  previous: Buffer[];
}

export interface Secrets {
  /** HMAC key for email → cell lookups. */
  directoryKey: Buffer;
  /** HMAC key for client addresses in the audit log. */
  auditKey: Buffer;
  /** File keys per served region; null when FILE_ENCRYPTION=off. Regions in the default cell share its keyring. */
  fileKeys: Partial<Record<DataRegion | 'default', FileKeyring>> | null;
}

/** Two independent keys from one secret, so a directory hash and an audit hash of the same text never match. */
function derive(secret: string, label: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), `lotuspond:${label}:v1`, 32));
}

const GENERATE_HINT = 'Generate one with `openssl rand -base64 32`.';

/** Read a secret from DATA_DIR/secrets, creating it on first use. */
function localSecret(dataDir: string, name: string, envName: string, warn: (msg: string) => void): string {
  const dir = path.resolve(dataDir, 'secrets');
  const file = path.join(dir, name);
  if (fs.existsSync(file)) {
    warn(`[secrets] ${envName} is not set; using the development value in ${file}.`);
    return fs.readFileSync(file, 'utf8').trim();
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const value = randomBytes(32).toString('base64');
  fs.writeFileSync(file, `${value}\n`, { mode: 0o600 });
  const loses = envName === 'DIRECTORY_SECRET' ? 'existing accounts cannot sign in' : 'stored files cannot be read';
  warn(`[secrets] ${envName} is not set; generated a development value in ${file}. On a server, set ${envName} from a secret store and back it up: without it, ${loses}.`);
  return value;
}

export interface ResolveOptions {
  /** Where generated secrets are kept; defaults to config.dataDir. */
  dataDir?: string;
  /** Generate missing secrets in memory only (tests). */
  ephemeral?: boolean;
  warn?: (msg: string) => void;
}

/** The secrets this server needs, or an error naming the missing variable when it is in production. */
export function resolveSecrets(config: Config, opts: ResolveOptions = {}): Secrets {
  const warn = opts.warn ?? (m => console.warn(m));
  const strict = config.env === 'production' && !config.localSecrets;
  const dataDir = opts.dataDir ?? config.dataDir;
  const missing = (envName: string, file: string): string => {
    if (strict) throw new Error(`${envName} is required in production. ${GENERATE_HINT} See README, "Security".`);
    if (opts.ephemeral) return randomBytes(32).toString('base64');
    return localSecret(dataDir, file, envName, warn);
  };

  const directorySecret = config.directorySecret ?? missing('DIRECTORY_SECRET', 'directory-secret');
  const secrets: Secrets = { directoryKey: derive(directorySecret, 'directory'), auditKey: derive(directorySecret, 'audit-ip'), fileKeys: null };

  if (!config.fileEncryption) {
    warn('[secrets] FILE_ENCRYPTION=off: uploaded files are stored without encryption.');
    return secrets;
  }

  // The default cell always exists (regions without storage of their own, sessions from before cells), so the
  // shared key is always needed. A cell with its own storage may have its own key; it still reads files written
  // with the shared keys before that key was set.
  const decode = (s: string) => decodeKey(s)!; // formats were checked by loadConfig
  const shared: FileKeyring = {
    current: decode(config.fileEncryptionKey ?? missing('FILE_ENCRYPTION_KEY', 'file-encryption-key')),
    previous: config.fileEncryptionPreviousKeys.map(decode),
  };
  const fileKeys: NonNullable<Secrets['fileKeys']> = { default: shared };
  for (const c of config.cells) {
    if (!c.databaseUrl && !c.dataDir) continue;
    fileKeys[c.region] = c.fileEncryptionKey
      ? { current: decode(c.fileEncryptionKey), previous: [...c.fileEncryptionPreviousKeys.map(decode), shared.current, ...shared.previous] }
      : shared;
  }
  secrets.fileKeys = fileKeys;
  return secrets;
}

/** Secrets for tests and for apps created without explicit secrets outside production. */
export function ephemeralSecrets(): Secrets {
  const s = randomBytes(32).toString('base64');
  const key = randomBytes(32);
  return { directoryKey: derive(s, 'directory'), auditKey: derive(s, 'audit-ip'), fileKeys: { default: { current: key, previous: [] } } };
}

/** Short, non-reversible identifier of a key, stored in each encrypted file's header. */
export function keyId(key: Buffer): Buffer {
  return createHash('sha256').update('lotuspond:file-key-id:v1').update(key).digest().subarray(0, 4);
}
