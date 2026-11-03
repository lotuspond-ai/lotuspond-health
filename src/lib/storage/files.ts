// App-file storage for the iOS / Android apps. The file operations are passed in (src/native/storage.ts binds
// them to Capacitor Filesystem), so this logic has no platform imports and is tested in Node.
//
// Layout under `root`:
//   data-0.json, data-1.json   the payload, written to the two slots in turn with a rising sequence number.
//                              A crash mid-write can only spoil the slot being written; loading takes the
//                              newest slot that parses, so the previous save survives.
//   scans/<key>.<ext>          original scan files, written in chunks to <name>.part and then renamed, so a
//                              half-written file is never taken for a complete one.
import type { Persisted, StorageBackend } from './index.ts';

export interface FileOps {
  /** Create the directory and any parents; succeed if it exists. */
  ensureDir(path: string): Promise<void>;
  /** Names of the entries in a directory. Rejects when it cannot be listed. */
  list(path: string): Promise<string[]>;
  readText(path: string): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
  /** Write base64-encoded bytes, replacing the file or appending to it. */
  writeBase64(path: string, base64: string, append: boolean): Promise<void>;
  /** The file's contents as a Blob of the given type. */
  readBlob(path: string, type: string): Promise<Blob>;
  /** Rename to a name that does not exist yet. */
  rename(from: string, to: string): Promise<void>;
  /** Delete a file; succeed if it is missing. */
  remove(path: string): Promise<void>;
  /** Delete a directory and everything in it; succeed if it is missing. */
  removeDir(path: string): Promise<void>;
}

export interface FileBackendOptions {
  root?: string;
  /** Bytes per bridge call when writing a scan file. */
  chunkSize?: number;
  /** Where data was kept before (IndexedDB): migrated on first load, and still read for any file it missed. */
  legacy?: StorageBackend;
}

const SLOTS = ['data-0.json', 'data-1.json'];

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif',
  'image/heic': 'heic', 'image/heif': 'heif', 'image/bmp': 'bmp', 'image/tiff': 'tif', 'application/dicom': 'dcm',
};
const TYPE: Record<string, string> = Object.fromEntries(Object.entries(EXT).map(([t, e]) => [e, t]));

export const extFor = (type: string) => EXT[type.toLowerCase()] ?? 'bin';
const typeFor = (name: string) => TYPE[name.slice(name.lastIndexOf('.') + 1)] ?? '';

/** Base64 of a Blob, using the platform encoder where there is one. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (typeof native === 'function') return native.call(bytes);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

interface Slot { seq: number; payload: unknown }

function parseSlot(text: string): Slot | null {
  try {
    const v = JSON.parse(text) as Partial<Slot> | null;
    return v && typeof v.seq === 'number' && v.payload && typeof v.payload === 'object' ? { seq: v.seq, payload: v.payload } : null;
  } catch { return null; }
}

/** Runs tasks one after another; a failed task does not stop the ones after it. */
function serial() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task);
    tail = run.catch(() => {});
    return run;
  };
}

export function createFileBackend(fs: FileOps, opts: FileBackendOptions = {}): StorageBackend {
  const root = opts.root ?? 'lotuspond';
  const scansDir = `${root}/scans`;
  const chunk = Math.max(3, Math.floor((opts.chunkSize ?? 3 * 1024 * 1024) / 3) * 3);
  const legacy = opts.legacy;
  const dataQueue = serial();
  const blobQueue = serial();
  let seq = 0;

  // key -> file name in scans/, read once from the directory listing.
  let index: Promise<Map<string, string>> | null = null;
  const scanIndex = () => (index ??= (async () => {
    await fs.ensureDir(scansDir);
    const map = new Map<string, string>();
    for (const name of await fs.list(scansDir)) {
      if (name.endsWith('.part')) { await fs.remove(`${scansDir}/${name}`).catch(() => {}); continue; } // interrupted write
      map.set(name.slice(0, name.indexOf('.') > 0 ? name.indexOf('.') : undefined), name);
    }
    return map;
  })().catch(e => { index = null; throw e; }));

  async function writeSlot(payload: unknown): Promise<void> {
    const next = seq + 1;
    await fs.ensureDir(root);
    await fs.writeText(`${root}/${SLOTS[next % 2]}`, JSON.stringify({ seq: next, payload }));
    seq = next;
  }

  let pending: unknown = null;
  let saving: Promise<void> | null = null;
  const savePayload = (payload: Persisted): Promise<void> => {
    pending = payload;
    // Coalesce: while a write is running, only the newest payload is written after it.
    saving ??= dataQueue(async () => {
      try {
        while (pending) { const p = pending; pending = null; await writeSlot(p); }
      } finally { saving = null; }
    });
    return saving;
  };

  async function writeBlob(key: string, blob: Blob): Promise<void> {
    const map = await scanIndex();
    const name = `${key}.${extFor(blob.type)}`;
    const part = `${scansDir}/${name}.part`;
    let offset = 0;
    do {
      await fs.writeBase64(part, await blobToBase64(blob.slice(offset, offset + chunk)), offset > 0);
      offset += chunk;
    } while (offset < blob.size);
    const old = map.get(key);
    if (old) await fs.remove(`${scansDir}/${old}`);
    await fs.rename(part, `${scansDir}/${name}`);
    map.set(key, name);
  }

  /** Copy data saved by an earlier version (IndexedDB) into files, then remove the copies that made it. */
  async function migrate(): Promise<unknown> {
    if (!legacy) return null;
    const old = await legacy.loadPayload().catch(() => null) as { scans?: { blobKey?: unknown }[] } | null;
    if (!old || typeof old !== 'object') return null;
    const copied: string[] = [];
    for (const s of Array.isArray(old.scans) ? old.scans : []) {
      if (typeof s?.blobKey !== 'string') continue;
      try {
        const blob = await legacy.loadBlob(s.blobKey);
        if (blob) { await blobQueue(() => writeBlob(s.blobKey as string, blob)); copied.push(s.blobKey); }
      } catch { /* left in IndexedDB; loadBlob still finds it there */ }
    }
    await dataQueue(() => writeSlot(old));
    for (const k of copied) await legacy.deleteBlob(k).catch(() => {});
    await legacy.deletePayload().catch(() => {});
    return old;
  }

  return {
    name: 'files',

    async loadPayload() {
      await fs.ensureDir(root);
      const names = new Set(await fs.list(root)); // rejects if the folder cannot be read: do not overwrite it
      let best: Slot | null = null;
      for (const slot of SLOTS) {
        if (!names.has(slot)) continue;
        const parsed = parseSlot(await fs.readText(`${root}/${slot}`));
        if (parsed && (!best || parsed.seq > best.seq)) best = parsed;
      }
      if (best) { seq = Math.max(seq, best.seq); return best.payload; }
      return migrate();
    },

    savePayload,

    deletePayload: () => dataQueue(async () => {
      for (const slot of SLOTS) await fs.remove(`${root}/${slot}`);
    }),

    async loadBlob(key) {
      const name = (await scanIndex()).get(key);
      if (name) return fs.readBlob(`${scansDir}/${name}`, typeFor(name));
      return legacy ? legacy.loadBlob(key) : null;
    },

    saveBlob: (key, blob) => blobQueue(() => writeBlob(key, blob)),

    deleteBlob: key => blobQueue(async () => {
      const map = await scanIndex();
      const name = map.get(key);
      if (name) { await fs.remove(`${scansDir}/${name}`); map.delete(key); }
      await legacy?.deleteBlob(key).catch(() => {});
    }),

    clearBlobs: () => blobQueue(async () => {
      await fs.removeDir(scansDir);
      index = null;
      await legacy?.clearBlobs().catch(() => {});
      await legacy?.deletePayload().catch(() => {});
    }),
  };
}
