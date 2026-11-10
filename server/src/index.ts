// Entry point: resolve secrets, open the default database and every cell (applying migrations to each), start the
// HTTP server. `node dist/index.js files:rekey` instead re-encrypts stored files with the current key and exits.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { REGIONS } from '../../shared/regions.ts';
import { loadConfig } from './config.ts';
import { openCells, type Cell } from './cells.ts';
import { resolveSecrets } from './compliance/secrets.ts';
import { purgeOldEvents } from './compliance/audit.ts';
import { EncryptedFileStore } from './lib/files-encrypted.ts';
import { purgeExpiredSessions } from './auth/sessions.ts';
import { purgeExpiredAgentSecrets } from './agents/grants.ts';
import { createApp } from './app.ts';
import { createLabs, fakePartner, orangePartner, type Labs } from './lab/runtime.ts';
import type { PartnerConfig } from './lab/partners/types.ts';

// This file runs from server/src (tsx) or server/dist (bundle); both are one level below server/.
const serverRoot = fileURLToPath(new URL('..', import.meta.url));
const command = process.argv[2];

// Optional server/.env (see .env.example); variables already set in the environment win.
try { process.loadEnvFile('.env'); } catch { /* no .env file */ }

function fail(e: unknown): never {
  console.error(`[api] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

const config = (() => { try { return loadConfig(); } catch (e) { return fail(e); } })();
if (!config.staticDir && config.env === 'production') {
  const built = path.resolve(serverRoot, '..', 'dist');
  if (fs.existsSync(built)) config.staticDir = built;
}

const secrets = (() => { try { return resolveSecrets(config); } catch (e) { return fail(e); } })();
const opened = await openCells(config, secrets, path.join(serverRoot, 'drizzle')).catch(fail);
const { registry } = opened;
/** The default cell and every cell with storage of its own. */
const allCells: Cell[] = [...new Set([registry.defaultCell, ...registry.cells])];

if (command === 'files:rekey') {
  if (!config.fileEncryption) fail('FILE_ENCRYPTION=off: there is nothing to re-encrypt.');
  let failed = 0;
  for (const cell of allCells) {
    if (!(cell.files instanceof EncryptedFileStore)) continue;
    const r = await cell.files.rekey();
    failed += r.failed.length;
    console.log(`[files] ${cell.id} cell: ${r.checked} files checked, ${r.encrypted} encrypted for the first time, ${r.rekeyed} moved to the current key${r.failed.length ? `, ${r.failed.length} could not be read: ${r.failed.join(', ')}` : ''}.`);
  }
  await opened.close();
  process.exit(failed ? 1 : 0);
}
if (command) fail(`Unknown command "${command}". The only command is files:rekey.`);

async function sweep() {
  for (const cell of allCells) {
    await purgeExpiredSessions(cell.db);
    await purgeOldEvents(cell.db, config.auditRetentionMs);
    await purgeExpiredAgentSecrets(cell.db);
  }
}
await sweep();

if (config.env === 'production' && registry.serves('in') && !config.grievanceContact) {
  console.warn('[api] GRIEVANCE_CONTACT is not set. India\'s DPDP Act requires a published grievance contact for accounts in India.');
}

// Lab booking (docs/lab-booking-backend.md). The simulated lab runs in this process and posts its webhooks here over HTTP.
let labs: Labs | undefined;
let stopFakeLab: (() => void) | undefined;
if (config.labs.partners.length) {
  const partners: PartnerConfig[] = [];
  if (config.labs.partners.includes('fake')) {
    const fake = fakePartner({
      stepMs: config.labs.fakeStepMs,
      deliver: async (hookPath, req) => {
        const res = await fetch(`http://127.0.0.1:${config.port}${hookPath}`, { method: 'POST', headers: req.headers, body: req.rawBody });
        if (!res.ok) throw new Error(`webhook receiver replied ${res.status}`);
      },
    });
    stopFakeLab = fake.lab.start(1000);
    partners.push(fake.config);
  }
  if (config.labs.orange) {
    try {
      partners.push(orangePartner(config.labs.orange));
    } catch (e) {
      fail(e);
    }
  }
  try {
    labs = createLabs({ cells: registry, secrets, partners });
  } catch (e) {
    fail(e);
  }
}

const app = createApp({ db: opened.defaultDatabase.db, files: registry.defaultCell.files, config, cells: registry, secrets, labs });
const stopLabs = labs?.start();
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, info => {
  const where = (d: (typeof opened.databases)[number]) => (d.database.kind === 'pglite' ? `PGlite in ${path.dirname(d.filesRoot)}` : 'PostgreSQL');
  console.log(`[api] LotusPond Health API on http://localhost:${info.port} (${where(opened.databases[0])})`);
  for (const cell of allCells) {
    const regions = registry.regionsOf(cell).map(r => REGIONS[r].name);
    const db = opened.databases.find(d => d.id === cell.id)!;
    console.log(`[api]   ${cell.id} cell: ${regions.length ? regions.join(', ') : 'no regions (directory and shared data)'}; ${where(db)}; files in ${db.filesRoot}${config.fileEncryption ? ', encrypted' : ', NOT encrypted'}`);
  }
  if (config.staticDir) console.log(`[api] serving the app from ${config.staticDir}`);
  if (labs) console.log(`[api] lab booking: ${[...labs.partners.keys()].join(', ')}${labs.partners.has('fake') ? ` (the simulated lab; orders move a step every ${config.labs.fakeStepMs / 1000} s)` : ''}`);
});

const timer = setInterval(() => void sweep().catch(() => {}), 6 * 60 * 60 * 1000);
timer.unref();

let stopping = false;
async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`[api] ${signal}: shutting down`);
  stopLabs?.();
  stopFakeLab?.();
  server.close();
  await opened.close();
  process.exit(0);
}
process.on('SIGINT', () => void stop('SIGINT'));
process.on('SIGTERM', () => void stop('SIGTERM'));
