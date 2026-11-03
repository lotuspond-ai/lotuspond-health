// Cache of OpenStreetMap responses in the facility_cache table, keyed by the rounded query.
import { eq, lt } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { facilityCache } from '../db/schema.ts';

const DAY = 24 * 60 * 60 * 1000;
export const PLACES_TTL_MS = 7 * DAY;
export const GEOCODE_TTL_MS = 30 * DAY;
/** Rows older than the longest lifetime are removed now and then. */
const PURGE_AFTER_MS = GEOCODE_TTL_MS + DAY;

export class FacilityCache {
  private readonly db: Db;
  private readonly inflight = new Map<string, Promise<unknown>>();
  private writes = 0;
  /** Counters for tests and diagnostics. */
  readonly stats = { hits: 0, misses: 0 };

  constructor(db: Db) {
    this.db = db;
  }

  async get<T>(key: string, maxAgeMs: number, now = Date.now()): Promise<T | undefined> {
    const [row] = await this.db.select().from(facilityCache).where(eq(facilityCache.key, key)).limit(1);
    if (!row || now - row.fetchedAt.getTime() > maxAgeMs) return undefined;
    return (row.payload as { v: T }).v;
  }

  /** Values are wrapped so that null (for example "no address here") can be cached too. */
  async set(key: string, value: unknown): Promise<void> {
    const fetchedAt = new Date();
    const payload = { v: value };
    try {
      await this.db.insert(facilityCache).values({ key, payload, fetchedAt })
        .onConflictDoUpdate({ target: facilityCache.key, set: { payload, fetchedAt } });
      if (++this.writes % 200 === 0) {
        await this.db.delete(facilityCache).where(lt(facilityCache.fetchedAt, new Date(Date.now() - PURGE_AFTER_MS)));
      }
    } catch (e) {
      // A failed cache write should not fail the search that produced the data.
      console.error('[facilities] cache write failed', e instanceof Error ? e.message : e);
    }
  }

  /** Cached value, or the result of `load` (stored for next time). Concurrent misses for one key share a single load. */
  async through<T>(key: string, maxAgeMs: number, load: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key, maxAgeMs);
    if (cached !== undefined) {
      this.stats.hits++;
      return cached;
    }
    const pending = this.inflight.get(key) as Promise<T> | undefined;
    if (pending) return pending;
    this.stats.misses++;
    const run = load().then(async value => {
      await this.set(key, value);
      return value;
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, run);
    return run;
  }
}
