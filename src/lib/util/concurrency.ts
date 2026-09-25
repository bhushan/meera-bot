/**
 * Non-blocking in-process concurrency guard.
 *
 * Serverless caveat: this bounds work inside one warm container, not across the
 * whole deployment. It is the cheap half of the protection; the Postgres sliding
 * window in `check_rate_limit` is the half that holds across instances.
 */
export interface ConcurrencyGuard {
  /** Returns a release function, or null when the guard is already at capacity. */
  tryAcquire(): (() => void) | null;
  readonly active: number;
  readonly limit: number;
}

export function createConcurrencyGuard(limit: number): ConcurrencyGuard {
  let active = 0;
  return {
    tryAcquire() {
      if (active >= limit) return null;
      active += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active -= 1;
      };
    },
    get active() {
      return active;
    },
    get limit() {
      return limit;
    },
  };
}
