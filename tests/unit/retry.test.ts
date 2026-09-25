import { describe, it, expect, vi } from 'vitest';
import { withRetry, computeBackoffMs } from '@/lib/util/retry';
import { withTimeout } from '@/lib/util/timeout';
import { AppError } from '@/lib/errors';

describe('computeBackoffMs', () => {
  it('grows exponentially and stays inside the cap', () => {
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const ms = computeBackoffMs(attempt, { baseMs: 100, maxMs: 2000, random: () => 1 });
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(2000);
    }
    expect(computeBackoffMs(1, { baseMs: 100, maxMs: 9999, random: () => 0 })).toBeLessThan(
      computeBackoffMs(3, { baseMs: 100, maxMs: 9999, random: () => 0 }),
    );
  });

  it('applies jitter so two callers do not retry in lockstep', () => {
    const low = computeBackoffMs(3, { baseMs: 100, maxMs: 9999, random: () => 0 });
    const high = computeBackoffMs(3, { baseMs: 100, maxMs: 9999, random: () => 0.999 });
    expect(high).toBeGreaterThan(low);
  });
});

describe('withRetry', () => {
  it('returns the first successful result without sleeping', async () => {
    const sleep = vi.fn(async () => {});
    const fn = vi.fn(async () => 'ok');
    await expect(withRetry(fn, { attempts: 3, sleep, label: 't' })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries transient failures up to the attempt cap then rethrows', async () => {
    const sleep = vi.fn(async () => {});
    const err = new AppError({ kind: 'gemini', message: '503' });
    const fn = vi.fn(async () => {
      throw err;
    });
    await expect(withRetry(fn, { attempts: 3, sleep, label: 'gemini' })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('succeeds on a later attempt', async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new AppError({ kind: 'telegram', message: 'flaky' });
      return calls;
    });
    await expect(withRetry(fn, { attempts: 3, sleep, label: 't' })).resolves.toBe(3);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry validation failures', async () => {
    const sleep = vi.fn(async () => {});
    const fn = vi.fn(async () => {
      throw new AppError({ kind: 'validation', message: 'bad shape' });
    });
    await expect(withRetry(fn, { attempts: 3, sleep, label: 'v' })).rejects.toThrow('bad shape');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not retry authorization failures', async () => {
    const sleep = vi.fn(async () => {});
    const fn = vi.fn(async () => {
      throw new AppError({ kind: 'authorization', message: '401' });
    });
    await expect(withRetry(fn, { attempts: 3, sleep, label: 'a' })).rejects.toThrow('401');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('honours a per-call shouldRetry override', async () => {
    const sleep = vi.fn(async () => {});
    const fn = vi.fn(async () => {
      throw new AppError({ kind: 'gemini', message: 'nope' });
    });
    await expect(
      withRetry(fn, { attempts: 3, sleep, label: 'g', shouldRetry: () => false }),
    ).rejects.toThrow('nope');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('reports the attempt number to onRetry', async () => {
    const sleep = vi.fn(async () => {});
    const seen: number[] = [];
    const fn = vi.fn(async () => {
      throw new AppError({ kind: 'rss', message: 'x' });
    });
    await expect(
      withRetry(fn, { attempts: 3, sleep, label: 'r', onRetry: (a) => seen.push(a) }),
    ).rejects.toThrow();
    expect(seen).toEqual([1, 2]);
  });
});

describe('withTimeout', () => {
  it('resolves when the work finishes in time', async () => {
    await expect(withTimeout(async () => 'fast', { ms: 1000, label: 'x' })).resolves.toBe('fast');
  });

  it('rejects with a timeout AppError and aborts the signal', async () => {
    let aborted = false;
    const promise = withTimeout(
      (signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
      { ms: 10, label: 'slow-op' },
    );
    await expect(promise).rejects.toMatchObject({ kind: 'timeout' });
    expect(aborted).toBe(true);
  });

  it('includes the label in the timeout message', async () => {
    await expect(
      withTimeout(() => new Promise(() => {}), { ms: 5, label: 'gemini.score' }),
    ).rejects.toThrow(/gemini\.score/);
  });
});
