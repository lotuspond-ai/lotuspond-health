// Hand a file to the system share sheet (Save to Files, Drive, AirDrop, Mail, a PDF viewer...). Used in the apps,
// where links to the API cannot be opened directly because requests need the sign-in token.
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

const cancelled = (e: unknown) => /cancel/i.test(e instanceof Error ? e.message : String(e));

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (typeof native === 'function') return native.call(bytes);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Characters that are safe in a file name on both platforms (no separators, reserved or control characters). */
const safeName = (name: string) =>
  [...name].map(c => (c.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(c) ? ' ' : c)).join('').trim().slice(0, 120) || 'file';

export async function shareBlob(blob: Blob, fileName: string, title: string): Promise<void> {
  // The cache copy is only a hand-off. It is not deleted here because the receiving app may still be reading it
  // after the sheet closes; the OS clears the cache directory.
  const path = `share/${safeName(fileName)}`;
  const { uri } = await Filesystem.writeFile({ path, data: await toBase64(blob), directory: Directory.Cache, recursive: true });
  try {
    await Share.share({ title, files: [uri], dialogTitle: title });
  } catch (e) {
    if (!cancelled(e)) throw e;
  }
}
