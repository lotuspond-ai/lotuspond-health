// In-app notifications (shared/notifications.ts): written when a connected agent adds to someone's records, listed
// by the bell in the app, and undoable from there. Everything is in the account's cell.
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { NOTIFICATION_KEEP_DAYS, NOTIFICATION_LIST_MAX, type AppNotification, type NotificationDetail, type NotificationList } from '../../shared/notifications.ts';
import type { Db } from './db/client.ts';
import { documents, measurements, notifications, profiles, type NotificationRow, type ProfileRow } from './db/schema.ts';
import type { FileStore } from './lib/files.ts';

export function toNotification(r: NotificationRow): AppNotification {
  return {
    id: r.id, kind: r.kind, profileId: r.profileId, connectionId: r.connectionId, agentName: r.agentName, detail: r.detail,
    createdAt: r.createdAt.toISOString(), readAt: r.readAt?.toISOString() ?? null, undoneAt: r.undoneAt?.toISOString() ?? null,
  };
}

/** Tell the person an agent added something. A failure here never undoes the write: the write is logged anyway. */
export async function notifyAgentWrite(db: Db, n: { userId: string; profileId: string; connectionId: string | null; agentName: string; detail: NotificationDetail }): Promise<void> {
  try {
    await db.insert(notifications).values({ userId: n.userId, profileId: n.profileId, kind: 'agent_write', connectionId: n.connectionId, agentName: n.agentName.slice(0, 80), detail: n.detail });
  } catch (e) {
    console.error('[notifications] could not record an agent write', e);
  }
}

export async function listNotifications(db: Db, userId: string): Promise<NotificationList> {
  const [rows, [{ count }]] = await Promise.all([
    db.select().from(notifications).where(eq(notifications.userId, userId)).orderBy(desc(notifications.createdAt)).limit(NOTIFICATION_LIST_MAX),
    db.select({ count: sql<number>`count(*)::int` }).from(notifications).where(and(eq(notifications.userId, userId), isNull(notifications.readAt))),
  ]);
  return { unread: Number(count), items: rows.map(toNotification) };
}

/** Mark these (or all) as read. */
export async function markRead(db: Db, userId: string, ids?: string[]): Promise<void> {
  const where = and(eq(notifications.userId, userId), isNull(notifications.readAt), ids ? inArray(notifications.id, ids) : undefined);
  await db.update(notifications).set({ readAt: new Date() }).where(where);
}

const without = (list: string[], remove: string[] | undefined) => {
  const gone = new Set((remove ?? []).map(x => x.toLowerCase()));
  return list.filter(x => !gone.has(x.toLowerCase()));
};

/**
 * Undo what an agent added: delete the reading or the saved file (results already added from that file stay), or take the added entries off the profile's lists (only those still
 * there; anything the person added or changed since stays). Returns whether anything was still there to remove.
 */
export async function undoAgentWrite(db: Db, files: FileStore, userId: string, id: string): Promise<{ notification: AppNotification; removed: boolean; profile?: ProfileRow } | null> {
  const [row] = await db.select().from(notifications).where(and(eq(notifications.id, id), eq(notifications.userId, userId))).limit(1);
  if (!row) return null;
  if (row.undoneAt) return { notification: toNotification(row), removed: false };
  const d = row.detail;
  let removed = false;
  let profile: ProfileRow | undefined;
  if (d.type === 'reading') {
    const gone = await db.delete(measurements).where(and(eq(measurements.id, d.measurementId), eq(measurements.profileId, row.profileId))).returning({ id: measurements.id });
    removed = gone.length > 0;
  } else if (d.type === 'document') {
    const [doc] = await db.delete(documents).where(and(eq(documents.id, d.documentId), eq(documents.profileId, row.profileId))).returning();
    if (doc) { await files.delete(doc.storageKey); removed = true; }
  } else {
    const [p] = await db.select().from(profiles).where(and(eq(profiles.id, row.profileId), eq(profiles.userId, userId))).limit(1);
    if (p) {
      const next = { conditions: without(p.conditions, d.conditions), medications: without(p.medications, d.medications), allergies: without(p.allergies, d.allergies) };
      removed = next.conditions.length !== p.conditions.length || next.medications.length !== p.medications.length || next.allergies.length !== p.allergies.length;
      profile = p;
      if (removed) [profile] = await db.update(profiles).set({ ...next, updatedAt: new Date() }).where(eq(profiles.id, p.id)).returning();
    }
  }
  const now = new Date();
  const [updated] = await db.update(notifications).set({ undoneAt: now, readAt: row.readAt ?? now }).where(eq(notifications.id, row.id)).returning();
  return { notification: toNotification(updated), removed, profile };
}

export async function purgeOldNotifications(db: Db): Promise<void> {
  await db.delete(notifications).where(lt(notifications.createdAt, new Date(Date.now() - NOTIFICATION_KEEP_DAYS * 24 * 60 * 60_000)));
}
