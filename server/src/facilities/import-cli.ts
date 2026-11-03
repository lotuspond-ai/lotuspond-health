// Import partner labs from a JSON file (format: server/data/README.md). Upserts by slug.
//   npm run partners:import -w server -- data/partners.example.json
// With the embedded database (no DATABASE_URL), stop the API server first: PGlite allows one process at a time.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.ts';
import { openDatabase } from '../db/client.ts';
import { upsertPartners, validatePartners } from './partners.ts';

const serverRoot = fileURLToPath(new URL('../..', import.meta.url));
const args = process.argv.slice(2);
const check = args.includes('--check');
const file = args.find(a => !a.startsWith('--'));
if (!file) {
  console.error('Usage: npm run partners:import -w server -- <file.json> [--check]\n  --check  validate only, change nothing');
  process.exit(2);
}

// npm runs workspace scripts from server/; accept paths relative to where the command was typed too.
const candidates = [path.resolve(process.env.INIT_CWD ?? process.cwd(), file), path.resolve(process.cwd(), file)];
const resolved = candidates.find(p => fs.existsSync(p));
if (!resolved) {
  console.error(`File not found: ${file}`);
  process.exit(2);
}

let raw: unknown;
try {
  raw = JSON.parse(fs.readFileSync(resolved, 'utf8'));
} catch (e) {
  console.error(`${file} is not valid JSON: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}

const { labs, problems } = validatePartners(raw);
for (const p of problems) console.error(`  ✗ ${p.index >= 0 ? `entry ${p.index + 1}` : 'file'}${p.slug ? ` (${p.slug})` : ''}: ${p.message}`);
if (problems.length) {
  console.error(`${problems.length} problem(s); nothing was imported.`);
  process.exit(1);
}
if (check) {
  console.log(`${labs.length} partner lab(s) are valid.`);
  process.exit(0);
}

try { process.loadEnvFile(path.join(process.cwd(), '.env')); } catch { /* no .env file */ }
const config = loadConfig();
const database = await openDatabase({ url: config.databaseUrl, pgliteDir: path.join(path.resolve(config.dataDir), 'pglite') });
try {
  await database.migrate(path.join(serverRoot, 'drizzle'));
  const { created, updated } = await upsertPartners(database.db, labs);
  console.log(`Imported ${labs.length} partner lab(s): ${created} new, ${updated} updated (${database.kind}).`);
} finally {
  await database.close();
}
