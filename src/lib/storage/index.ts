// Where saved results and original scan files live. The store talks to one backend:
// IndexedDB in the browser (./idb.ts), app files on iOS / Android (./files.ts via src/native/storage.ts).
import type { Measurement, ScanItem } from '../../types';

/** Everything the store saves, apart from the original scan files. */
export interface Persisted { version: 1; measurements: Measurement[]; scans: ScanItem[] }

export interface StorageBackend {
  readonly name: string;
  /**
   * The saved payload, or null when nothing has been saved yet. Rejects only when stored data may exist but
   * could not be read; the store then keeps this session in memory rather than write over it.
   */
  loadPayload(): Promise<unknown>;
  savePayload(payload: Persisted): Promise<void>;
  deletePayload(): Promise<void>;
  loadBlob(key: string): Promise<Blob | null>;
  saveBlob(key: string, blob: Blob): Promise<void>;
  deleteBlob(key: string): Promise<void>;
  /** Remove every saved scan file. */
  clearBlobs(): Promise<void>;
}
