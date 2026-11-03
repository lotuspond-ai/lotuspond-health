// Export a backup file: a download in the browser, the system share sheet in the apps
// (Save to Files, Drive, AirDrop, email...). Nothing is sent anywhere unless the user picks a destination.
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import type { Measurement, ScanItem } from '../types';
import { buildExport, downloadBlob } from '../lib/export';
import { isNative } from './platform';

export const exportFileName = (d = new Date()) => `lotuspond-health-${d.toISOString().slice(0, 10)}.json`;

const cancelled = (e: unknown) => /cancel/i.test(e instanceof Error ? e.message : String(e));

export async function saveExport(state: { measurements: Measurement[]; scans: ScanItem[] }): Promise<void> {
  const text = JSON.stringify(buildExport(state), null, 2);
  const name = exportFileName();
  if (!isNative) {
    downloadBlob(new Blob([text], { type: 'application/json' }), name);
    return;
  }
  // The cache copy is only a hand-off to the share sheet. It is not deleted here because the receiving app
  // may still be reading it after the sheet closes; the OS clears the cache directory, and the next export
  // on the same day overwrites it.
  const { uri } = await Filesystem.writeFile({ path: name, data: text, directory: Directory.Cache, encoding: Encoding.UTF8 });
  try {
    await Share.share({ title: 'LotusPond Health backup', files: [uri], dialogTitle: 'Save your backup' });
  } catch (e) {
    if (!cancelled(e)) throw e;
  }
}
