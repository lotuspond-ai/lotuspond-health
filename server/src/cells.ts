// Data-residency cells (docs/research.md §2). Each served region's personal data (accounts, sessions, profiles,
// records, consents, audit events and uploaded files) lives in that region's cell: its own database and file store.
// A region without storage of its own is kept in the default cell, which is also the default database used for
// non-personal data (the directory, partner labs, the facility cache). With no CELL_* settings, every region is in
// the default cell: one database and one file store, as before cells existed.
import path from 'node:path';
import type { DataRegion } from '../../shared/regions.ts';
import type { Config } from './config.ts';
import { openDatabase, type Database, type Db } from './db/client.ts';
import { DiskFileStore, type FileStore } from './lib/files.ts';
import { EncryptedFileStore } from './lib/files-encrypted.ts';
import { ephemeralSecrets, type FileKeyring, type Secrets } from './compliance/secrets.ts';
import type { Deps } from './http.ts';

export interface Cell {
  /** 'default', or the region id for a cell with its own storage. */
  id: 'default' | DataRegion;
  db: Db;
  files: FileStore;
}

export class CellRegistry {
  readonly defaultCell: Cell;
  private readonly byRegion: Map<DataRegion, Cell>;

  constructor(defaultCell: Cell, byRegion: Iterable<[DataRegion, Cell]>) {
    this.defaultCell = defaultCell;
    this.byRegion = new Map(byRegion);
  }

  /** The cell holding a region's accounts, or null when this deployment does not serve that region. */
  forRegion(region: string | null | undefined): Cell | null {
    return (region && this.byRegion.get(region as DataRegion)) || null;
  }

  serves(region: DataRegion): boolean {
    return this.byRegion.has(region);
  }

  get servedRegions(): DataRegion[] {
    return [...this.byRegion.keys()];
  }

  /** Regions kept in a cell. */
  regionsOf(cell: Cell): DataRegion[] {
    return [...this.byRegion].filter(([, c]) => c === cell).map(([r]) => r);
  }

  /** Every distinct cell that serves at least one region (the default cell once, however many regions it holds). */
  get cells(): Cell[] {
    return [...new Set(this.byRegion.values())];
  }
}

/** One cell serving every region: the default database and file store (tests, and deployments without cells). */
export function singleCell(db: Db, files: FileStore, regions: readonly DataRegion[] = ['in', 'eu', 'us', 'global']): CellRegistry {
  const cell: Cell = { id: 'default', db, files };
  return new CellRegistry(cell, regions.map(r => [r, cell]));
}

export function fileStore(root: string, ring: FileKeyring | null | undefined): FileStore {
  const disk = new DiskFileStore(root);
  return ring ? new EncryptedFileStore(disk, ring) : disk;
}

export interface OpenCells {
  registry: CellRegistry;
  /** The default database (deps.db). */
  defaultDatabase: Database;
  /** Every opened database, default first. */
  databases: { id: Cell['id']; database: Database; filesRoot: string }[];
  close(): Promise<void>;
}

/** Open the default database and each cell's database, run migrations on every one, and build the file stores. */
export async function openCells(config: Config, secrets: Secrets, migrationsFolder: string): Promise<OpenCells> {
  const dataDir = path.resolve(config.dataDir);
  const opened: OpenCells['databases'] = [];
  const closeAll = () => Promise.all(opened.map(o => o.database.close().catch(() => {}))).then(() => {});
  try {
    const defaultDatabase = await openDatabase({ url: config.databaseUrl, pgliteDir: path.join(dataDir, 'pglite') });
    const defaultRoot = path.join(dataDir, 'files');
    opened.push({ id: 'default', database: defaultDatabase, filesRoot: defaultRoot });
    await defaultDatabase.migrate(migrationsFolder);
    const defaultCell: Cell = { id: 'default', db: defaultDatabase.db, files: fileStore(defaultRoot, secrets.fileKeys?.default) };

    const byRegion: [DataRegion, Cell][] = [];
    for (const c of config.cells) {
      if (!c.databaseUrl && !c.dataDir) {
        byRegion.push([c.region, defaultCell]);
        continue;
      }
      const cellDir = path.resolve(c.dataDir ?? path.join(dataDir, 'cells', c.region));
      const database = await openDatabase({ url: c.databaseUrl, pgliteDir: path.join(cellDir, 'pglite') });
      const filesRoot = path.join(cellDir, 'files');
      opened.push({ id: c.region, database, filesRoot });
      await database.migrate(migrationsFolder);
      byRegion.push([c.region, { id: c.region, db: database.db, files: fileStore(filesRoot, secrets.fileKeys?.[c.region] ?? secrets.fileKeys?.default) }]);
    }
    return { registry: new CellRegistry(defaultCell, byRegion), defaultDatabase, databases: opened, close: closeAll };
  } catch (e) {
    await closeAll();
    throw e;
  }
}

/** What createApp accepts: the cells and secrets may be left out, giving one default cell (tests, simple setups). */
export type DepsInput = Omit<Deps, 'cells' | 'secrets'> & Partial<Pick<Deps, 'cells' | 'secrets'>>;

export function completeDeps(input: DepsInput): Deps {
  if (input.config.env === 'production' && (!input.cells || !input.secrets)) {
    throw new Error('In production, createApp needs the cells and secrets opened by index.ts.');
  }
  return {
    ...input,
    cells: input.cells ?? singleCell(input.db, input.files, input.config.servedRegions),
    secrets: input.secrets ?? ephemeralSecrets(),
  };
}
