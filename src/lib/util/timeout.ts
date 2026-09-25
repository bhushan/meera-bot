import { AppError } from '../errors';

export interface TimeoutOptions {
  ms: number;
  label: string;
}

/**
 * Run `work` with a hard deadline. The supplied AbortSignal is aborted on timeout
 * so the underlying fetch/SDK call stops burning execution time.
 */
export async function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  { ms, label }: TimeoutOptions,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // Reject *before* aborting: `abort()` synchronously fires listeners that may
      // reject `work` with a generic "aborted" error, which would otherwise win the
      // race and hide the real cause.
      reject(
        new AppError({
          kind: 'timeout',
          message: `${label} timed out after ${ms}ms`,
          retryable: true,
          context: { label, timeoutMs: ms },
        }),
      );
      controller.abort();
    }, ms);
  });

  try {
    return await Promise.race([work(controller.signal), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
