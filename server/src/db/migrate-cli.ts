// Apply migrations without starting the server: `npm run db:migrate -w server`.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.ts';
import { openDatabase } from './client.ts';

const config = loadConfig();
const database = await openDatabase({ url: config.databaseUrl, pgliteDir: path.join(path.resolve(config.dataDir), 'pglite') });
await database.migrate(fileURLToPath(new URL('../../drizzle', import.meta.url)));
console.log(`Migrations applied (${database.kind}).`);
await database.close();
