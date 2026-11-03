// Storage for uploaded originals. Files are kept on disk under DATA_DIR/files/<profileId>/<documentId>.
// Swap in an object-store implementation (S3, GCS) of the same interface for multi-instance deployments.
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

export interface FileStore {
  put(key: string, data: Uint8Array): Promise<void>;
  /** Web stream of the file, or null when it does not exist. */
  get(key: string): Promise<ReadableStream<Uint8Array> | null>;
  delete(key: string): Promise<void>;
  /** Remove every file whose key starts with `prefix/`. */
  deletePrefix(prefix: string): Promise<void>;
}

const SAFE_KEY = /^[0-9a-f-]{36}(?:\/[0-9a-f-]{36})?$/;

export class DiskFileStore implements FileStore {
  private readonly root: string;
  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private resolve(key: string): string {
    if (!SAFE_KEY.test(key)) throw new Error(`Unsafe storage key: ${key}`);
    return path.join(this.root, key);
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    const file = this.resolve(key);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, data, { mode: 0o600 });
    await fs.rename(tmp, file);
  }

  async get(key: string): Promise<ReadableStream<Uint8Array> | null> {
    const file = this.resolve(key);
    try {
      await fs.access(file);
    } catch {
      return null;
    }
    return Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>;
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true });
  }

  async deletePrefix(prefix: string): Promise<void> {
    await fs.rm(this.resolve(prefix), { recursive: true, force: true });
  }
}
