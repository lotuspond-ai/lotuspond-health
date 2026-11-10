import { useLayoutEffect, useRef } from 'react';

/** Close on Escape. Subscribes once and always calls the latest `close`, so there is no gap while effects re-run. */
export function useEscape(close: () => void) {
  const latest = useRef(close);
  useLayoutEffect(() => { latest.current = close; });
  useLayoutEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') latest.current(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
}
