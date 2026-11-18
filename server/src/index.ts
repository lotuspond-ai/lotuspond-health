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
import { purgeExpiredConsoleSessions } from './connectors/console-accounts.ts';
import { purgeExpiredAgentSecrets } from './agents/grants.ts';
import { purgeOldNotifications } from './notifications.ts';
import { claudeAssistant } from './assistant/agent.ts';
import { createApp } from './app.ts';
import { claudeExtractor } from './extraction/claude.ts';
import { createLabs, fakePartner, orangePartner, type Labs } from './lab/runtime.ts';
import type { PartnerConfig } from './lab/partners/types.ts';
import { createRecordAgent } from './records/service.ts';
import { browserProvider, localBrowsers } from './records/browsers.ts';
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
import { organisationRuntime } from './connectors/runtime.ts';
import { organisationAccounts, organisationConnections, organisationMembers, organisations, type OrganisationRole } from './db/schema.ts';
import { HIS_ADAPTERS } from './connectors/his/index.ts';
import { eq } from 'drizzle-orm';

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
//   org:requests                                        organisations that asked for live access, and what they asked for
//   org:live <organisation id>                          give live access, once its written authority is checked
//   org:member <organisation id> <email> [role]         add an organisation account to an organisation (role: owner,
//                                                       admin, editor or viewer; owner by default). The person signs up
//                                                       in the developer console first.
//   org:connect <organisation id> <connector> "<name>" [base url]
//       adds a connection to a real system (fhir, bahmni, trakcare, eka). Credentials come from the environment, never
//       the command line: ORG_CONNECTION_TOKEN (bearer), or ORG_CONNECTION_USER and ORG_CONNECTION_PASSWORD (HTTP
//       Basic), or for Eka Care ORG_CONNECTION_CLIENT_ID, ORG_CONNECTION_CLIENT_SECRET and ORG_CONNECTION_SHARING_KEY.
//       The base url is required for FHIR systems; Eka defaults to https://api.eka.care.
//   org:web-signin <organisation id> <connection id>
//       for the computer-use agent (tasks.run): opens the connection's web app (Eka: https://dr.eka.care) in a browser
//       window on this machine, where someone at the clinic signs in with their own account; pressing Enter here seals
//       the browser's sign-in (cookies and local storage, never the password) into the connection. Run it on a machine
//       with a screen, with DATABASE_URL and the file keys of the server.
if (['org:create', 'org:key', 'org:revoke', 'org:requests', 'org:live', 'org:connect', 'org:member', 'org:web-signin'].includes(command ?? '')) {
  const [a, b, c] = process.argv.slice(3);
  const db = registry.defaultCell.db;
  try {
    if (command === 'org:create') {
      if (!a) fail('Usage: org:create "<name>" [region]');
      const region = (b ?? 'in') as keyof typeof REGIONS;
      if (!(region in REGIONS)) fail(`Unknown region "${region}". Use one of: ${Object.keys(REGIONS).join(', ')}.`);
      const org = await createOrganisation(db, a, region);
      console.log(`Organisation ${org.name} (${org.region}): ${org.id}`);
    } else if (command === 'org:requests') {
      const rows = await db.select().from(organisations);
      const asked = rows.filter(r => r.liveRequestedAt && r.access !== 'live');
      if (!asked.length) console.log('No organisation is waiting for live access.');
      for (const r of asked) console.log(`${r.id}  ${r.name}  asked ${r.liveRequestedAt!.toISOString()} by ${r.liveRequest?.by}\n  systems: ${r.liveRequest?.systems}\n  hospital: ${r.liveRequest?.hospital}\n  note: ${r.liveRequest?.note || '-'}`);
    } else if (command === 'org:live') {
      if (!a) fail('Usage: org:live <organisation id>');
      const rows = await db.update(organisations).set({ access: 'live' }).where(eq(organisations.id, a)).returning({ id: organisations.id });
      console.log(rows.length ? 'The organisation has live access. Add its connections with org:connect.' : 'No such organisation.');
    } else if (command === 'org:member') {
      const role = (c ?? 'owner') as OrganisationRole;
      if (!a || !b || !['owner', 'admin', 'editor', 'viewer'].includes(role)) fail('Usage: org:member <organisation id> <email> [owner|admin|editor|viewer]');
      const [account] = await db.select().from(organisationAccounts).where(eq(organisationAccounts.email, b.trim().toLowerCase())).limit(1);
      if (!account) fail(`No organisation account for ${b}. The person makes one in the developer console first.`);
      await db.insert(organisationMembers).values({ organisationId: a, accountId: account.id, role, approves: role === 'owner' })
        .onConflictDoUpdate({ target: [organisationMembers.organisationId, organisationMembers.accountId], set: { role } });
      console.log(`${account.email} is ${role === 'owner' || role === 'admin' ? 'an' : 'a'} ${role} of organisation ${a}.`);
    } else if (command === 'org:connect') {
      const [, , name, baseUrl] = process.argv.slice(3);
      if (!a || !b || !name || (!baseUrl && b !== 'eka')) fail('Usage: org:connect <organisation id> <fhir|bahmni|trakcare|eka> "<name>" [base url]  (credentials in ORG_CONNECTION_TOKEN, ORG_CONNECTION_USER and ORG_CONNECTION_PASSWORD, or for Eka ORG_CONNECTION_CLIENT_ID, ORG_CONNECTION_CLIENT_SECRET and ORG_CONNECTION_SHARING_KEY)');
      const env = process.env;
      const secret = b === 'eka'
        ? (env.ORG_CONNECTION_CLIENT_ID && env.ORG_CONNECTION_CLIENT_SECRET
          ? { clientId: env.ORG_CONNECTION_CLIENT_ID, clientSecret: env.ORG_CONNECTION_CLIENT_SECRET, ...(env.ORG_CONNECTION_SHARING_KEY ? { sharingKey: env.ORG_CONNECTION_SHARING_KEY } : {}) }
          : fail('An Eka connection needs ORG_CONNECTION_CLIENT_ID and ORG_CONNECTION_CLIENT_SECRET (and the clinic\'s ORG_CONNECTION_SHARING_KEY).'))
        : env.ORG_CONNECTION_TOKEN ? { token: env.ORG_CONNECTION_TOKEN }
        : env.ORG_CONNECTION_USER ? { username: env.ORG_CONNECTION_USER, password: env.ORG_CONNECTION_PASSWORD ?? '' } : null;
      const runtime = organisationRuntime({ db, keyrings: secrets.fileKeys });
      const conn = await runtime.addConnection(a, { connectorId: b, name, settings: baseUrl ? { baseUrl } : {}, secret });
      console.log(`Connection ${conn.name} (${conn.connector}): ${conn.id}${secret ? ', with sealed credentials' : ', without credentials'}.`);
    } else if (command === 'org:web-signin') {
      if (!a || !b) fail('Usage: org:web-signin <organisation id> <connection id>');
      const runtime = organisationRuntime({ db, keyrings: secrets.fileKeys });
      const conn = (await runtime.listConnections(a)).find(x => x.id === b) ?? fail('No such connection for that organisation.');
      const [row] = await db.select().from(organisationConnections).where(eq(organisationConnections.id, conn.id)).limit(1);
      const target = HIS_ADAPTERS.get(conn.connector)?.agentTarget?.({ connectionId: conn.id, settings: row.settings, selfUrl: `http://127.0.0.1:${config.port}` });
      if (!target?.needsSignIn) fail(`${conn.connector} connections have no web app to sign in to.`);
      const session = await localBrowsers({ headless: false, executablePath: config.records?.browser.kind === 'local' ? config.records.browser.executablePath : process.env.RECORD_BROWSER_EXECUTABLE })
        .open({ allowHosts: [...target.allowHosts, ...(process.env.ORG_SIGNIN_EXTRA_HOSTS ?? '').split(',').map(h => h.trim()).filter(Boolean)], acceptDownloads: false });
      const page = await session.context.newPage();
      await page.goto(target.startUrl).catch(() => {});
      console.log(`Sign in to ${target.name} in the browser window that opened, with the clinic user the agent should act as.\nOnly ${target.allowHosts.join(', ')} can load (add hosts a sign-in needs with ORG_SIGNIN_EXTRA_HOSTS). Press Enter here once signed in.`);
      await new Promise<void>(resolve => process.stdin.once('data', () => resolve()));
      const state = await session.close();
      if (!state?.cookies.length) fail('The browser had no sign-in to save. Nothing was changed.');
      await runtime.setWebSession(a, conn.id, state as never);
      console.log(`Saved the sign-in for ${conn.name} (${state.cookies.length} cookies), sealed. Agent tasks on this connection now start signed in.`);
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
if (command) fail(`Unknown command "${command}". Commands: files:rekey, org:create, org:key, org:revoke, org:requests, org:live, org:connect, org:member, org:web-signin.`);

async function sweep() {
  for (const cell of allCells) {
    await purgeExpiredSessions(cell.db);
    await purgeOldEvents(cell.db, config.auditRetentionMs);
    await purgeExpiredAgentSecrets(cell.db);
    await purgeOldNotifications(cell.db);
  }
  await purgeExpiredConsoleSessions(registry.defaultCell.db);
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
