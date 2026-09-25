import { isRetryable } from '../errors';

export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  random?: () => number;
}

/**
 * Exponential backoff with full jitter: delay is drawn uniformly from
 * `[base * 2^(attempt-1) / 2, base * 2^(attempt-1)]`, capped at `maxMs`.
 */
export function computeBackoffMs(attempt: number, options: BackoffOptions): number {
  const { baseMs, maxMs, random = Math.random } = options;
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const half = exponential / 2;
  return Math.min(maxMs, Math.round(half + random() * half));
}

export interface RetryOptions {
  /** Total attempts including the first. */
  attempts: number;
  label: string;
  baseMs?: number;
  maxMs?: number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Overrides the default `isRetryable` classification. */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Retry transient failures. Validation and authorization errors are never retried
 * because re-sending them produces the same answer.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const {
    attempts,
    baseMs = 300,
    maxMs = 4000,
    random,
    sleep = defaultSleep,
    shouldRetry = isRetryable,
    onRetry,
  } = options;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const isLast = attempt >= attempts;
      if (isLast || !shouldRetry(err, attempt)) throw err;
      const delayMs = computeBackoffMs(attempt, { baseMs, maxMs, ...(random ? { random } : {}) });
      onRetry?.(attempt, err, delayMs);
      await sleep(delayMs);
    }
  }
  throw lastError;
}
