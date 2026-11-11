// The bell in the top bar (shared/notifications.ts): what connected agents added to the records, with an Undo for
// each. It checks every minute while the app is in view and when it comes back into view, and shows a toast when an
// agent has just added something.
import { useCallback, useEffect, useRef, useState } from 'react';
import { backend, errorMessage, isPreview } from '../api';
import { describeWrite, type AppNotification, type NotificationList } from '../../shared/notifications';
import { useHealth } from '../lib/store';
import { useSession } from '../state/session';
import { useUI } from '../state/ui';
import { toast } from '../state/toast';
import { formatDate } from '../lib/derive';
import '../styles/agents.css';

const POLL_MS = 60_000;

const bell = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9" /><path d="M10 19a2 2 0 0 0 4 0" />
  </svg>
);

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return formatDate(iso.slice(0, 10));
}

export function NotificationBell() {
  const signedIn = useSession(s => s.status === 'signed-in');
  const profiles = useSession(s => s.profiles);
  const replaceProfile = useSession(s => s.replaceProfile);
  const setView = useUI(s => s.setView);
  const [data, setData] = useState<NotificationList | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const seen = useRef<Set<string> | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const whose = useCallback((id: string) => {
    const p = profiles.find(x => x.id === id);
    return !p ? 'a removed profile' : p.relationship === 'self' ? 'your records' : `${p.displayName}’s records`;
  }, [profiles]);

  const load = useCallback(async () => {
    try {
      const next = await backend.notifications();
      // A toast for additions that arrived while the app was open (not for those waiting at sign-in).
      if (seen.current) {
        for (const n of next.items) if (!n.readAt && !seen.current.has(n.id)) toast.info(`${n.agentName} added ${describeWrite(n.detail)} to ${whose(n.profileId)}.`);
      }
      seen.current = new Set(next.items.map(n => n.id));
      setData(next);
    } catch { /* offline or signed out: try again on the next tick */ }
  }, [whose]);

  useEffect(() => {
    if (!signedIn || isPreview) return;
    const tick = () => { if (document.visibilityState === 'visible') void load(); };
    const first = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => { window.clearTimeout(first); window.clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [signedIn, load]);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', away); window.removeEventListener('keydown', key); };
  }, [open]);

  if (!signedIn || isPreview || !data) return null;

  async function toggle() {
    const opening = !open;
    setOpen(opening);
    if (opening && data?.unread) {
      try { setData(await backend.markNotificationsRead()); } catch { /* the count stays until the next check */ }
    }
  }

  async function undo(n: AppNotification) {
    setBusy(n.id);
    try {
      const r = await backend.undoNotification(n.id);
      if (r.profile) replaceProfile(r.profile);
      if (n.detail.type === 'reading' && useHealth.getState().profileId === n.profileId) await useHealth.getState().openProfile(n.profileId);
      setData(d => d && { ...d, items: d.items.map(x => (x.id === n.id ? r.notification : x)) });
      toast.info(r.removed ? `Removed what ${n.agentName} added.` : 'That was already removed.');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="notif" ref={root}>
      <button className="notif__trigger" aria-haspopup="dialog" aria-expanded={open} onClick={() => void toggle()}
        aria-label={data.unread ? `Notifications, ${data.unread} new` : 'Notifications'}>
        {bell}{data.unread > 0 && <span className="notif__count" aria-hidden>{data.unread > 9 ? '9+' : data.unread}</span>}
      </button>
      {open && (
        <div className="notif__panel" role="dialog" aria-label="Notifications">
          <p className="pmenu__label">What connected agents added</p>
          {data.items.length === 0 && <p className="note notif__empty">Nothing yet. When an agent adds a reading or a profile entry, it shows here and you can undo it.</p>}
          <ul>
            {data.items.map(n => (
              <li key={n.id} className={n.undoneAt ? 'is-undone' : undefined}>
                <p><b>{n.agentName}</b> added {describeWrite(n.detail)}{n.detail.type === 'reading' && n.detail.date ? ` (${formatDate(n.detail.date)})` : ''} to {whose(n.profileId)}.</p>
                <small>{ago(n.createdAt)}{n.undoneAt ? ' · Undone' : ''}</small>
                {!n.undoneAt && <button type="button" className="btn btn--small" disabled={busy === n.id} onClick={() => void undo(n)}>{busy === n.id ? 'Undoing…' : 'Undo'}</button>}
              </li>
            ))}
          </ul>
          <button type="button" className="pmenu__row" onClick={() => { setOpen(false); setView('account'); }}>Manage connected agents</button>
        </div>
      )}
    </div>
  );
}
