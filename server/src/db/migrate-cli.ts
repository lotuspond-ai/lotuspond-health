// Apply migrations without starting the server: `npm run db:migrate -w server`.
// Migrates the default database and every cell's database (the server also does this on start-up).
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.ts';
import { openCells } from '../cells.ts';
import { ephemeralSecrets } from '../compliance/secrets.ts';

// Optional server/.env (see .env.example); variables already set in the environment win.
try { process.loadEnvFile('.env'); } catch { /* no .env file */ }
const config = loadConfig();
// File stores are not used here, so no secrets are needed.
const opened = await openCells(config, { ...ephemeralSecrets(), fileKeys: null }, fileURLToPath(new URL('../../drizzle', import.meta.url)));
console.log(`Migrations applied: ${opened.databases.map(d => `${d.id} (${d.database.kind})`).join(', ')}.`);
await opened.close();
