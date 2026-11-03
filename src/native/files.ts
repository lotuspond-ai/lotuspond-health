// Small app files on iOS / Android (the app lock's settings), in the app's private Library folder.
// Health records are not kept here: they live in the account on the server.
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';

// Library is private to the app and hidden from the Files app. On Android it is the app's files folder, which
// data_extraction_rules.xml keeps out of cloud backup.
const directory = Directory.Library;

export const fileOps = {
  async ensureDir(path: string): Promise<void> {
    try { await Filesystem.mkdir({ path, directory, recursive: true }); } catch { /* already there; list() reports real failures */ }
  },
  async list(path: string): Promise<string[]> {
    return (await Filesystem.readdir({ path, directory })).files.map(f => f.name);
  },
  async readText(path: string): Promise<string> {
    const { data } = await Filesystem.readFile({ path, directory, encoding: Encoding.UTF8 });
    return typeof data === 'string' ? data : data.text();
  },
  async writeText(path: string, text: string): Promise<void> {
    await Filesystem.writeFile({ path, data: text, directory, encoding: Encoding.UTF8, recursive: true });
  },
};
