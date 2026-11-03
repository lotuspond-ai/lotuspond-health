import { useCallback, useSyncExternalStore } from 'react';

/** Phone layout: bottom tabs, full-screen dialogs, the organ panel as a bottom sheet. Mirrors the CSS breakpoint. */
export const COMPACT = '(max-width: 760px)';

/** Live result of a CSS media query. */
export function useMedia(query: string): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const mq = matchMedia(query);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return useSyncExternalStore(subscribe, () => matchMedia(query).matches, () => false);
}
