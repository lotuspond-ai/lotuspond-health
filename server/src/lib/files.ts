// Storage for uploaded originals. Files are kept on disk under <cell data dir>/files/<profileId>/<documentId>,
// encrypted by EncryptedFileStore (files-encrypted.ts) unless FILE_ENCRYPTION=off.
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

/** A store that can also hand back whole files and list its keys (what encryption and re-keying need). */
export interface ByteStore extends FileStore {
  read(key: string): Promise<Uint8Array | null>;
  keys(): AsyncIterable<string>;
}

const SAFE_KEY = /^[0-9a-f-]{36}(?:\/[0-9a-f-]{36})?$/;

export class DiskFileStore implements ByteStore {
  readonly root: string;
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

  async read(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await fs.readFile(this.resolve(key)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async *keys(): AsyncIterable<string> {
    let dirs: string[];
    try {
      dirs = await fs.readdir(this.root);
    } catch {
      return;
    }
    for (const dir of dirs) {
      let names: string[];
      try {
        names = await fs.readdir(path.join(this.root, dir));
      } catch {
        continue;
      }
      for (const name of names) {
        const key = `${dir}/${name}`;
        if (SAFE_KEY.test(key)) yield key;
      }
    }
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true });
  }

  async deletePrefix(prefix: string): Promise<void> {
    await fs.rm(this.resolve(prefix), { recursive: true, force: true });
  }
}
