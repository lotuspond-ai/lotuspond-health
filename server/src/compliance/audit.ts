// Account events: what the person sees as "Recent activity", and what scopes a breach investigation.
// An event holds its kind, a narrow typed detail (shared/types.ts AuditDetail), a keyed hash of the client address
// and a short device description. Never health data, names, emails or file names.
import { createHmac } from 'node:crypto';
import { desc, eq, lt } from 'drizzle-orm';
import type { ActivityEvent, AuditDetail, AuditKind } from '../../../shared/types.ts';
import type { Db } from '../db/client.ts';
import { auditEvents, type AuditEventRow } from '../db/schema.ts';
import { clientIp, type Ctx, type Deps } from '../http.ts';

/** "Chrome on macOS", "Safari on iPhone", or null. Version numbers and the rest of the string are dropped. */
export function shortUserAgent(ua: string | undefined | null): string | null {
  if (!ua) return null;
  const browser =
    /Edg(?:e|A|iOS)?\//.test(ua) ? 'Edge'
      : /OPR\/|Opera/.test(ua) ? 'Opera'
        : /SamsungBrowser\//.test(ua) ? 'Samsung Internet'
          : /Firefox\/|FxiOS\//.test(ua) ? 'Firefox'
            : /Chrome\/|CriOS\/|Chromium\//.test(ua) ? 'Chrome'
              : /Safari\//.test(ua) && /Version\//.test(ua) ? 'Safari'
                : null;
  const os =
    /iPhone/.test(ua) ? 'iPhone'
      : /iPad/.test(ua) ? 'iPad'
        : /Android/.test(ua) ? 'Android'
          : /CrOS/.test(ua) ? 'ChromeOS'
            : /Windows/.test(ua) ? 'Windows'
              : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
                : /Linux/.test(ua) ? 'Linux'
                  : null;
  if (browser && os) return `${browser} on ${os}`;
  if (browser || os) return browser ?? os;
  return ua.replace(/[^\x20-\x7e]/g, '').slice(0, 40) || null;
}

/** HMAC of the client address with a server key: equal addresses match, but the address cannot be read back. */
export function hashIp(key: Buffer, ip: string): string | null {
  if (!ip || ip === 'unknown') return null;
  return createHmac('sha256', key).update(ip).digest('hex').slice(0, 32);
}

export interface EventContext { ipHash: string | null; userAgent: string | null }

export function eventContext(c: Ctx, deps: Pick<Deps, 'config' | 'secrets'>): EventContext {
  return { ipHash: hashIp(deps.secrets.auditKey, clientIp(c, deps.config.trustProxy)), userAgent: shortUserAgent(c.req.header('user-agent')) };
}

/** Narrow a detail to its allowed fields, so nothing else can be logged by mistake. */
function cleanDetail(d: AuditDetail | undefined): AuditDetail | null {
  if (!d) return null;
  const out: AuditDetail = {};
  if (d.consent) out.consent = d.consent;
  if (typeof d.granted === 'boolean') out.granted = d.granted;
  if (d.unitSystem) out.unitSystem = d.unitSystem;
  if (d.profileId && /^[0-9a-f-]{36}$/i.test(d.profileId)) out.profileId = d.profileId;
  return Object.keys(out).length ? out : null;
}

/**
 * Record an event. A failure to write is logged and does not fail the person's request: the action itself
 * (signing in, deleting records) matters more to them than its log entry.
 */
export async function recordEvent(db: Db, ctx: EventContext | null, userId: string, kind: AuditKind, detail?: AuditDetail): Promise<void> {
  try {
    await db.insert(auditEvents).values({ userId, kind, detail: cleanDetail(detail), ipHash: ctx?.ipHash ?? null, userAgent: ctx?.userAgent ?? null });
  } catch (e) {
    console.error(`[audit] could not record ${kind}`, e);
  }
}

export const toActivity = (e: AuditEventRow): ActivityEvent => ({
  id: e.id, kind: e.kind, createdAt: e.createdAt.toISOString(), device: e.userAgent, detail: e.detail ?? null,
});

export async function recentActivity(db: Db, userId: string, limit = 50): Promise<ActivityEvent[]> {
  const rows = await db.select().from(auditEvents).where(eq(auditEvents.userId, userId)).orderBy(desc(auditEvents.createdAt)).limit(limit);
  return rows.map(toActivity);
}

/**
 * On account deletion: remove the account's history and keep one record that an account with this (random) id
 * was deleted, with no address hash or device.
 */
export async function eraseHistory(db: Db, userId: string): Promise<void> {
  await db.delete(auditEvents).where(eq(auditEvents.userId, userId));
  await recordEvent(db, null, userId, 'account_deleted');
}

export async function purgeOldEvents(db: Db, retentionMs: number): Promise<void> {
  await db.delete(auditEvents).where(lt(auditEvents.createdAt, new Date(Date.now() - retentionMs)));
}
