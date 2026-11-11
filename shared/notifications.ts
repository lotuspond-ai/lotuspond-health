// What the person is told in the app (the bell in the top bar, src/components/Notifications.tsx). Today: every time a
// connected agent adds to their records (server/src/agents/tools.ts), with an Undo. Kept in the account's cell, like
// the records they describe; removed after NOTIFICATION_KEEP_DAYS, or with the profile or the account.
import type { Profile } from './types.ts';

/** What an agent added: a reading (one result), or entries appended to a profile's lists. */
export type NotificationDetail =
  | { type: 'reading'; measurementId: string; marker: string; value: string; unit: string; date: string | null }
  | { type: 'profile'; conditions?: string[]; medications?: string[]; allergies?: string[] };

export interface AppNotification {
  id: string;
  kind: 'agent_write';
  profileId: string;
  /** The connection that wrote it; it may since have been disconnected. */
  connectionId: string | null;
  agentName: string;
  detail: NotificationDetail;
  createdAt: string;
  readAt: string | null;
  /** When the person undid it from the notification. */
  undoneAt: string | null;
}

export interface NotificationList {
  unread: number;
  items: AppNotification[];
}

/** What undoing returns: whether anything was still there to remove, and the profile as it now is (profile entries). */
export interface UndoResult {
  notification: AppNotification;
  removed: boolean;
  profile?: Profile;
}

export const NOTIFICATION_KEEP_DAYS = 180;
/** How many the bell lists. */
export const NOTIFICATION_LIST_MAX = 50;

/** "a reading: Fasting glucose 104 mg/dL" or "a condition: Asthma; an allergy: Penicillin". */
export function describeWrite(d: NotificationDetail): string {
  if (d.type === 'reading') return `a reading: ${d.marker} ${d.value}${d.unit ? ` ${d.unit}` : ''}`;
  const part = (list: string[] | undefined, one: string, many: string) =>
    list?.length ? `${list.length === 1 ? one : many}: ${list.join(', ')}` : null;
  return [part(d.conditions, 'a condition', 'conditions'), part(d.medications, 'a medication', 'medications'), part(d.allergies, 'an allergy', 'allergies')]
    .filter(Boolean).join('; ');
}
