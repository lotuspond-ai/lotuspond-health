// Data saved by the earlier, browser-only version of LotusPond (IndexedDB key "lotuspond:v1").
// It can be imported once into the open profile.
import { get, set } from 'idb-keyval';
import type { Measurement, ParseResult, ScanItem } from '../types';

const LEGACY_KEY = 'lotuspond:v1';
const BLOB_PREFIX = 'lotuspond:blob:';
const HANDLED_KEY = 'lotuspond:v1-handled';

interface LegacyData { measurements: Measurement[]; scans: ScanItem[] }

function isLegacy(v: unknown): v is LegacyData {
  return !!v && typeof v === 'object' && Array.isArray((v as LegacyData).measurements) && Array.isArray((v as LegacyData).scans);
}

/** Saved data from the earlier version, unless it was already imported or dismissed. */
export async function findLegacyData(): Promise<LegacyData | null> {
  if (typeof indexedDB === 'undefined') return null;
  try {
    if (await get(HANDLED_KEY)) return null;
    const v: unknown = await get(LEGACY_KEY);
    if (!isLegacy(v) || (!v.measurements.length && !v.scans.length)) return null;
    return v;
  } catch {
    return null;
  }
}

/** The earlier data as a parse result (with original scan files) ready for addResult. */
export async function legacyAsResult(data: LegacyData): Promise<ParseResult> {
  const blobs: Record<string, Blob> = {};
  for (const s of data.scans) {
    try {
      const b = await get<Blob>(BLOB_PREFIX + s.blobKey);
      if (b instanceof Blob) blobs[s.blobKey] = b;
    } catch { /* missing original */ }
  }
  return { measurements: data.measurements, scans: data.scans.filter(s => blobs[s.blobKey]), blobs, warnings: [], detectedDate: null };
}

/** Stop offering the import (the data itself is left in place). */
export async function markLegacyHandled(): Promise<void> {
  try { await set(HANDLED_KEY, new Date().toISOString()); } catch { /* storage unavailable */ }
}
