// Entry point: open the database, apply migrations, start the HTTP server.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { loadConfig } from './config.ts';
import { openDatabase } from './db/client.ts';
import { DiskFileStore } from './lib/files.ts';
import { purgeExpiredSessions } from './auth/sessions.ts';
import { createApp } from './app.ts';

// This file runs from server/src (tsx) or server/dist (bundle); both are one level below server/.
const serverRoot = fileURLToPath(new URL('..', import.meta.url));

// Optional server/.env (see .env.example); variables already set in the environment win.
try { process.loadEnvFile('.env'); } catch { /* no .env file */ }
const config = loadConfig();
const dataDir = path.resolve(config.dataDir);
if (!config.staticDir && config.env === 'production') {
  const built = path.resolve(serverRoot, '..', 'dist');
  if (fs.existsSync(built)) config.staticDir = built;
}

const database = await openDatabase({ url: config.databaseUrl, pgliteDir: path.join(dataDir, 'pglite') });
await database.migrate(path.join(serverRoot, 'drizzle'));
await purgeExpiredSessions(database.db);

const app = createApp({ db: database.db, files: new DiskFileStore(path.join(dataDir, 'files')), config });
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, info => {
  console.log(`[api] LotusPond Health API on http://localhost:${info.port} (${database.kind}${database.kind === 'pglite' ? ` in ${path.join(dataDir, 'pglite')}` : ''})`);
  if (config.staticDir) console.log(`[api] serving the app from ${config.staticDir}`);
});

const sweep = setInterval(() => void purgeExpiredSessions(database.db).catch(() => {}), 6 * 60 * 60 * 1000);
sweep.unref();

let stopping = false;
async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`[api] ${signal}: shutting down`);
  server.close();
  await database.close().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', () => void stop('SIGINT'));
process.on('SIGTERM', () => void stop('SIGTERM'));
