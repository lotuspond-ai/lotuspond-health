import { defineConfig } from 'drizzle-kit';

// `npm run db:generate -w server` writes SQL migrations to ./drizzle from the schema.
// The server applies them on start-up, for both PostgreSQL and the embedded PGlite database.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
