// Database connection: PostgreSQL when DATABASE_URL is set, otherwise embedded PGlite (Postgres compiled to WASM).
import fs from 'node:fs';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema.ts';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface Database {
  db: Db;
  kind: 'postgres' | 'pglite';
  migrate: (migrationsFolder: string) => Promise<void>;
  close: () => Promise<void>;
}

export interface DatabaseOptions {
  /** postgres:// connection string. */
  url?: string;
  /** Directory for embedded PGlite data; omit for an in-memory database (tests). */
  pgliteDir?: string;
}

export async function openDatabase(opts: DatabaseOptions): Promise<Database> {
  if (opts.url) {
    const { default: pg } = await import('pg');
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    const pool = new pg.Pool({ connectionString: opts.url, max: 10 });
    const db = drizzle({ client: pool, schema });
    return {
      db: db as unknown as Db,
      kind: 'postgres',
      // Several servers (or test processes) may start together: one applies migrations while the others wait.
      migrate: async folder => {
        const conn = await pool.connect();
        try {
          await conn.query('SELECT pg_advisory_lock(727631)');
          await migrate(drizzle({ client: conn, schema }), { migrationsFolder: folder });
        } finally {
          await conn.query('SELECT pg_advisory_unlock(727631)').catch(() => {});
          conn.release();
        }
      },
      close: () => pool.end(),
    };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const { migrate } = await import('drizzle-orm/pglite/migrator');
  if (opts.pgliteDir) fs.mkdirSync(opts.pgliteDir, { recursive: true });
  const client = opts.pgliteDir ? new PGlite(opts.pgliteDir) : new PGlite();
  const db = drizzle({ client, schema });
  return {
    db: db as unknown as Db,
    kind: 'pglite',
    migrate: folder => migrate(db, { migrationsFolder: folder }),
    close: () => client.close(),
  };
}
