import { beforeAll, afterAll, vi } from 'vitest';

/**
 * Global guard: no test may ever reach a real network endpoint (paid or otherwise).
 * Individual tests that need HTTP install their own `vi.fn()` stub over globalThis.fetch;
 * anything that slips through hits this and fails loudly.
 */
const realFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    throw new Error(
      `Test attempted a real network call to ${String(input)}. Stub fetch in the test instead.`,
    );
  }) as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});
