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
import { purgeSpentTokens } from './auth/spent-tokens.ts';
import { purgeExpiredAgentSecrets } from './agents/grants.ts';
import { purgeOldNotifications } from './notifications.ts';
import { claudeAssistant } from './assistant/agent.ts';
import { createApp } from './app.ts';
import { claudeExtractor } from './extraction/claude.ts';
import { createLabs, fakePartner, orangePartner, type Labs } from './lab/runtime.ts';
import type { PartnerConfig } from './lab/partners/types.ts';
import { createRecordAgent } from './records/service.ts';
import { browserProvider } from './records/browsers.ts';
import { demoPortal } from './records/demo-portal.ts';
import { createEka } from './records/abdm/eka.ts';
import { abhaFetcher } from './records/abdm/abha.ts';
import { withingsFetcher } from './records/api/withings.ts';
import { ouraFetcher } from './records/api/oura.ts';
import { ultrahumanFetcher } from './records/api/ultrahuman.ts';
import { gmailFetcher, outlookFetcher } from './records/api/mail.ts';
import { digilockerFetcher } from './records/api/digilocker.ts';
import { createOrganisation, createOrganisationKey, ORGANISATION_OPERATIONS, revokeOrganisationKey } from './connectors/organisations.ts';
import type { OperationId } from './connectors/types.ts';
import { exportAccounts, linkAccounts, readJsonLines } from './auth/accounts-migration.ts';

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
// Organisations of the connector core (docs/connectors.md), kept in the default database:
//   org:create "<name>" [region]                        prints the new organisation's id
//   org:key <organisation id> "<key name>" <op,op|all>  prints a new API key, once
//   org:revoke <key id>
if (command === 'org:create' || command === 'org:key' || command === 'org:revoke') {
  const [a, b, c] = process.argv.slice(3);
  const db = registry.defaultCell.db;
  try {
    if (command === 'org:create') {
      if (!a) fail('Usage: org:create "<name>" [region]');
      const region = (b ?? 'in') as keyof typeof REGIONS;
      if (!(region in REGIONS)) fail(`Unknown region "${region}". Use one of: ${Object.keys(REGIONS).join(', ')}.`);
      const org = await createOrganisation(db, a, region);
      console.log(`Organisation ${org.name} (${org.region}): ${org.id}`);
    } else if (command === 'org:key') {
      if (!a || !b || !c) fail(`Usage: org:key <organisation id> "<key name>" <operation,operation|all>. Operations: ${ORGANISATION_OPERATIONS.join(', ')}.`);
      const ops = (c === 'all' ? ORGANISATION_OPERATIONS : c.split(',').map(x => x.trim())) as OperationId[];
      const { key, row } = await createOrganisationKey(db, a, b, ops);
      console.log(`Key ${row.name} (${row.id}) for ${row.operations.join(', ')}. Shown once, keep it safe:\n${key}`);
    } else {
      if (!a) fail('Usage: org:revoke <key id>');
      console.log((await revokeOrganisationKey(db, a)) ? 'Key revoked.' : 'No active key with that id.');
    }
  } catch (e) { await opened.close(); fail(e); }
  await opened.close();
  process.exit(0);
}
// Moving account identity into LotusPond Accounts (docs/identity.md, "Moving the directory into Accounts"):
//   accounts:export <file>   every account in this server's cells, for Accounts to import (JSON Lines; holds
//                            emails and password hashes: readable by its owner only; delete it once imported)
//   accounts:link <file>     Accounts' answer, { "health_user_id", "sub" } per line: link each account
if (command === 'accounts:export' || command === 'accounts:link') {
  const file = process.argv[3];
  if (!file) fail(`Usage: ${command} <file>`);
  try {
    if (command === 'accounts:export') {
      if (fs.existsSync(file)) fail(`${file} already exists; choose a new file name.`);
      const fd = fs.openSync(file, 'wx', 0o600);
      const n = await exportAccounts(allCells, line => fs.writeSync(fd, `${line}\n`));
      fs.closeSync(fd);
      console.log(`[accounts] ${n} accounts written to ${file} (owner-readable only). It holds emails and password hashes: hand it to LotusPond Accounts over a secure channel and delete it once imported.`);
    } else {
      const r = await linkAccounts(allCells, readJsonLines(fs.readFileSync(file, 'utf8')));
      console.log(`[accounts] linked ${r.linked}, already linked ${r.unchanged}, conflicts ${r.conflicts.length}, not on this server ${r.missing.length}, unreadable lines ${r.invalid}.`);
      for (const c of r.conflicts) console.log(`[accounts]   conflict: ${c.health_user_id}: ${c.reason}`);
      if (r.missing.length) console.log(`[accounts]   not on this server (another regional host, or deleted): ${r.missing.join(', ')}`);
    }
  } catch (e) { await opened.close(); fail(e); }
  await opened.close();
  process.exit(0);
}
if (command) fail(`Unknown command "${command}". Commands: files:rekey, org:create, org:key, org:revoke, accounts:export, accounts:link.`);

async function sweep() {
  await purgeSpentTokens(registry.defaultCell.db);
  for (const cell of allCells) {
    await purgeExpiredSessions(cell.db);
    await purgeOldEvents(cell.db, config.auditRetentionMs);
    await purgeExpiredAgentSecrets(cell.db);
    await purgeOldNotifications(cell.db);
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

const extractor = config.aiExtraction.enabled ? claudeExtractor({ model: config.aiExtraction.model }) : undefined;
const assistant = config.assistant.enabled ? claudeAssistant({ model: config.assistant.model }) : undefined;
// The record agent (docs/record-agent.md): its browsers reach this server's demo portal at its local address.
const records = config.records
  ? createRecordAgent({
    cells: registry, secrets, config: config.records, browsers: browserProvider(config.records.browser), selfUrl: `http://127.0.0.1:${config.port}`,
    maxBytes: config.maxUploadBytes, ...(config.records.navigator ? { navigator: { model: config.records.navigator.model } } : {}),
    apis: [
      ...(config.records.withings ? [withingsFetcher(config.records.withings)] : []),
      ...(config.records.oura ? [ouraFetcher(config.records.oura)] : []),
      ...(config.records.ultrahuman ? [ultrahumanFetcher(config.records.ultrahuman, { cgm: config.records.ultrahuman.cgm })] : []),
      ...(config.records.gmail ? [gmailFetcher(config.records.gmail)] : []),
      ...(config.records.outlook ? [outlookFetcher(config.records.outlook)] : []),
      ...(config.records.digilocker ? [digilockerFetcher(config.records.digilocker, { apiUrl: config.records.digilocker.apiUrl })] : []),
    ],
    ...(config.records.eka ? { abdm: abhaFetcher({ eka: createEka(config.records.eka), ...(config.records.eka.hiu ? { hiu: config.records.eka.hiu } : {}) }) } : {}),
  })
  : undefined;
const portal = config.records?.demoPortal ? demoPortal() : undefined;
let whatsapp: import('./whatsapp/service.ts').WhatsAppService | undefined;
const app = createApp({ db: opened.defaultDatabase.db, files: registry.defaultCell.files, config, cells: registry, secrets, labs, extractor, assistant, records }, { whatsapp: { onService: s => { whatsapp = s; } }, demoPortal: portal });
const sweepWhatsApp = setInterval(() => void whatsapp?.purge().catch(() => {}), 60 * 60 * 1000);
sweepWhatsApp.unref();
const stopLabs = labs?.start();
const stopRecords = records?.start();
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, info => {
  const where = (d: (typeof opened.databases)[number]) => (d.database.kind === 'pglite' ? `PGlite in ${path.dirname(d.filesRoot)}` : 'PostgreSQL');
  console.log(`[api] LotusPond Health API on http://localhost:${info.port} (${where(opened.databases[0])})`);
  for (const cell of allCells) {
    const regions = registry.regionsOf(cell).map(r => REGIONS[r].name);
    const db = opened.databases.find(d => d.id === cell.id)!;
    console.log(`[api]   ${cell.id} cell: ${regions.length ? regions.join(', ') : 'no regions (directory and shared data)'}; ${where(db)}; files in ${db.filesRoot}${config.fileEncryption ? ', encrypted' : ', NOT encrypted'}`);
  }
  if (config.staticDir) console.log(`[api] serving the app from ${config.staticDir}`);
  if (assistant) console.log(`[api] assistant: on (${config.assistant.model})`);
  if (whatsapp) console.log(`[api] WhatsApp: on (+${config.whatsapp!.number}); Meta posts to ${config.publicUrl ?? '<PUBLIC_URL>'}/hooks/whatsapp`);
  else if (config.whatsapp) console.warn('[api] WhatsApp is set up but the assistant is off, so WhatsApp is off too.');
  if (extractor) console.log(`[api] reading reports with Claude: on (${config.aiExtraction.model}), only for uploads the person sends`);
  if (records) console.log(`[api] record agent: on, browsers on ${records.browserLabel}${config.records!.navigator ? `, navigator ${config.records!.navigator.model}` : ', recipes only'}${portal ? '; demo portal at /demo-portal' : ''}`);
  if (config.accounts) console.log(`[api] LotusPond Accounts sign-in: ${config.accounts.issuer === 'fake' ? 'the stand-in issuer at /api/dev-accounts (development only)' : config.accounts.issuer}`);
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
  stopRecords?.();
  stopFakeLab?.();
  server.close();
  await opened.close();
  process.exit(0);
}
process.on('SIGINT', () => void stop('SIGINT'));
process.on('SIGTERM', () => void stop('SIGTERM'));
