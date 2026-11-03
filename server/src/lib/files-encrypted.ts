// Encryption at rest for uploaded originals: AES-256-GCM with a random 96-bit IV per file.
//
// File layout (37-byte header, then the ciphertext):
//   0  magic   "LPEF"
//   4  version 1
//   5  key id  first 4 bytes of SHA-256 over the key (picks the key during rotation; reveals nothing about it)
//   9  iv      12 random bytes
//   21 tag     16-byte GCM authentication tag
//   37 ciphertext
// The header bytes before the tag and the storage key are authenticated as associated data, so a changed byte,
// a swapped header, or a file moved to another profile's path fails to decrypt.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { HttpError } from './errors.ts';
import type { ByteStore, FileStore } from './files.ts';
import { keyId, type FileKeyring } from '../compliance/secrets.ts';

const MAGIC = Buffer.from('LPEF', 'ascii');
const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const AAD_END = MAGIC.length + 1 + 4 + IV_BYTES; // 21
export const HEADER_BYTES = AAD_END + TAG_BYTES; // 37

export class FileIntegrityError extends HttpError {
  readonly storageKey: string;
  readonly reason: string;
  constructor(storageKey: string, reason: string) {
    super(500, 'file_unreadable', 'This file could not be read. It may have been damaged. Upload it again if you still have it.');
    this.storageKey = storageKey;
    this.reason = reason;
  }
}

export function isEncrypted(data: Uint8Array): boolean {
  return data.byteLength >= HEADER_BYTES && Buffer.from(data.buffer, data.byteOffset, 4).equals(MAGIC);
}

export function encryptFile(storageKey: string, plain: Uint8Array, key: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const aad = Buffer.concat([MAGIC, Buffer.of(VERSION), keyId(key), iv]);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.concat([aad, Buffer.from(storageKey, 'utf8')]));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([aad, cipher.getAuthTag(), body]);
}

/** The plaintext, or a FileIntegrityError when the file is not ours, was changed, or its key is unknown. */
export function decryptFile(storageKey: string, data: Uint8Array, ring: FileKeyring): Buffer {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (!isEncrypted(buf)) throw new FileIntegrityError(storageKey, 'no encryption header');
  if (buf[4] !== VERSION) throw new FileIntegrityError(storageKey, `unknown format version ${buf[4]}`);
  const id = buf.subarray(5, 9);
  const key = [ring.current, ...ring.previous].find(k => keyId(k).equals(id));
  if (!key) throw new FileIntegrityError(storageKey, 'encrypted with a key this server does not have');
  const iv = buf.subarray(9, AAD_END);
  const tag = buf.subarray(AAD_END, HEADER_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.concat([buf.subarray(0, AAD_END), Buffer.from(storageKey, 'utf8')]));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(buf.subarray(HEADER_BYTES)), decipher.final()]);
  } catch {
    throw new FileIntegrityError(storageKey, 'authentication failed (changed or damaged)');
  }
}

/** Wraps a byte store so everything written is encrypted and everything read is verified first. */
export class EncryptedFileStore implements FileStore {
  readonly inner: ByteStore;
  private readonly ring: FileKeyring;
  constructor(inner: ByteStore, ring: FileKeyring) {
    if (ring.current.length !== 32) throw new Error('File encryption needs a 32-byte key.');
    this.inner = inner;
    this.ring = ring;
  }

  put(key: string, data: Uint8Array): Promise<void> {
    return this.inner.put(key, encryptFile(key, data, this.ring.current));
  }

  /** Decrypts and authenticates the whole file before returning any of it, so tampered bytes are never served. */
  async get(key: string): Promise<ReadableStream<Uint8Array> | null> {
    const data = await this.inner.read(key);
    if (!data) return null;
    let plain: Buffer;
    try {
      plain = decryptFile(key, data, this.ring);
    } catch (e) {
      if (e instanceof FileIntegrityError) console.error(`[files] could not decrypt ${key}: ${e.reason}`);
      throw e;
    }
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(plain.buffer, plain.byteOffset, plain.byteLength));
        controller.close();
      },
    });
  }

  delete(key: string): Promise<void> {
    return this.inner.delete(key);
  }

  deletePrefix(prefix: string): Promise<void> {
    return this.inner.deletePrefix(prefix);
  }

  /**
   * Re-encrypt every file that is not under the current key: files written with a previous key, and plaintext
   * files from before encryption was turned on. Safe to run while the server is up and to run again.
   */
  async rekey(): Promise<{ checked: number; encrypted: number; rekeyed: number; failed: string[] }> {
    const out = { checked: 0, encrypted: 0, rekeyed: 0, failed: [] as string[] };
    const currentId = keyId(this.ring.current);
    for await (const key of this.inner.keys()) {
      out.checked++;
      const data = await this.inner.read(key);
      if (!data) continue;
      if (!isEncrypted(data)) {
        await this.inner.put(key, encryptFile(key, data, this.ring.current));
        out.encrypted++;
        continue;
      }
      if (Buffer.from(data.buffer, data.byteOffset + 5, 4).equals(currentId)) continue;
      try {
        await this.inner.put(key, encryptFile(key, decryptFile(key, data, this.ring), this.ring.current));
        out.rekeyed++;
      } catch {
        out.failed.push(key);
      }
    }
    return out;
  }
}
