// Browser storage: IndexedDB through idb-keyval. Without IndexedDB (private modes, Node) it stores nothing.
import { del, delMany, get, keys, set } from 'idb-keyval';
import type { Persisted, StorageBackend } from './index.ts';

export const STORAGE_KEY = 'lotuspond:v1';
export const BLOB_PREFIX = 'lotuspond:blob:';

const hasIDB = () => typeof indexedDB !== 'undefined';

export const idbBackend: StorageBackend = {
  name: 'indexeddb',
  async loadPayload() {
    if (!hasIDB()) return null;
    try { return (await get(STORAGE_KEY)) ?? null; } catch { return null; } // unavailable: run in memory
  },
  async savePayload(payload: Persisted) { if (hasIDB()) await set(STORAGE_KEY, payload); },
  async deletePayload() { if (hasIDB()) await del(STORAGE_KEY); },
  async loadBlob(key) {
    if (!hasIDB()) return null;
    try {
      const b = await get<Blob>(BLOB_PREFIX + key);
      return b instanceof Blob ? b : null;
    } catch { return null; }
  },
  async saveBlob(key, blob) { if (hasIDB()) await set(BLOB_PREFIX + key, blob); },
  async deleteBlob(key) { if (hasIDB()) await del(BLOB_PREFIX + key); },
  async clearBlobs() {
    if (!hasIDB()) return;
    const all = await keys();
    await delMany(all.filter(k => typeof k === 'string' && k.startsWith(BLOB_PREFIX)));
  },
};
