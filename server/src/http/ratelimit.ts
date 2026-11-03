// Fixed-window counters per key (e.g. per client address). In memory, so per process: enough for one
// instance; with several, move the counters to Postgres or Redis behind the same interface.
export interface RateLimiter {
  /** Counts one hit; returns 0 if allowed, or the ms until the window resets if over the limit. */
  hit(key: string, now: number): number;
}

export function fixedWindowLimiter(limit: number, windowMs: number): RateLimiter {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    hit(key, now) {
      let w = windows.get(key);
      if (!w || now - w.start >= windowMs) {
        w = { start: now, count: 0 };
        windows.set(key, w);
        if (windows.size > 10_000) {
          for (const [k, v] of windows) if (now - v.start >= windowMs) windows.delete(k);
        }
      }
      w.count++;
      return w.count > limit ? w.start + windowMs - now : 0;
    },
  };
}
