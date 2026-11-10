// Keeps the open profile's lab orders and results current: loaded when the profile changes, then checked every
// few seconds while the lab is working on something and Find a lab is open, otherwise every minute, and again
// whenever the app comes back to the foreground.
import { useEffect } from 'react';
import { refreshInterval, useLab } from '../../state/lab';
import { useActiveProfile, useSession } from '../../state/session';
import { useUI } from '../../state/ui';

export function useLabFollow(enabled: boolean): void {
  const profileId = useActiveProfile()?.id ?? null;
  const region = useSession(s => s.account?.region ?? null);
  const onPage = useUI(s => s.view === 'labs');
  const every = useLab(s => (onPage ? refreshInterval(s.orders) : 60_000));

  useEffect(() => {
    void useLab.getState().load(enabled ? profileId : null);
  }, [enabled, profileId, region]);

  useEffect(() => {
    if (enabled && onPage) void useLab.getState().refresh();
  }, [enabled, onPage]);

  useEffect(() => {
    if (!enabled || !profileId) return;
    const tick = () => { if (!document.hidden) void useLab.getState().refresh(); };
    const timer = setInterval(tick, every);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [enabled, profileId, every]);
}
