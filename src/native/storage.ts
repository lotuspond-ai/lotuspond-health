// App storage on iOS / Android: results and scan files as files in the app's Library folder
// (src/lib/storage/files.ts has the layout). Replaces the WebView's IndexedDB, which the OS may clear
// under storage pressure; data from IndexedDB is moved over on first launch.
import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { createFileBackend, type FileOps } from '../lib/storage/files';
import { idbBackend } from '../lib/storage/idb';
import type { StorageBackend } from '../lib/storage';

// Library is private to the app and hidden from the Files app. iOS includes it in device backups (as it did the
// WebView data); on Android it is the app's files folder, which data_extraction_rules.xml keeps out of cloud backup.
const directory = Directory.Library;

const fileOps: FileOps = {
  async ensureDir(path) {
    try { await Filesystem.mkdir({ path, directory, recursive: true }); } catch { /* already there; list() reports real failures */ }
  },
  async list(path) {
    return (await Filesystem.readdir({ path, directory })).files.map(f => f.name);
  },
  async readText(path) {
    const { data } = await Filesystem.readFile({ path, directory, encoding: Encoding.UTF8 });
    return typeof data === 'string' ? data : data.text();
  },
  async writeText(path, text) {
    await Filesystem.writeFile({ path, data: text, directory, encoding: Encoding.UTF8, recursive: true });
  },
  async writeBase64(path, data, append) {
    if (append) await Filesystem.appendFile({ path, data, directory });
    else await Filesystem.writeFile({ path, data, directory, recursive: true });
  },
  async readBlob(path, type) {
    // Read through the WebView's local file server instead of passing base64 over the bridge.
    const { uri } = await Filesystem.getUri({ path, directory });
    const res = await fetch(Capacitor.convertFileSrc(uri));
    if (!res.ok) throw new Error(`Scan file could not be read (${res.status}).`);
    const blob = await res.blob();
    return type && blob.type !== type ? new Blob([blob], { type }) : blob;
  },
  async rename(from, to) {
    await Filesystem.rename({ from, to, directory, toDirectory: directory });
  },
  async remove(path) {
    try { await Filesystem.deleteFile({ path, directory }); } catch { /* missing */ }
  },
  async removeDir(path) {
    try { await Filesystem.rmdir({ path, directory, recursive: true }); } catch { /* missing */ }
  },
};

export const createNativeStorage = (): StorageBackend => createFileBackend(fileOps, { legacy: idbBackend });
