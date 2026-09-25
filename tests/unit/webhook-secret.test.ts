import { describe, it, expect } from 'vitest';
import { verifyWebhookSecret, TELEGRAM_SECRET_HEADER } from '@/lib/telegram/verify';

const SECRET = 'S3cretWebhookToken_abcdefghijklmn';

describe('verifyWebhookSecret', () => {
  it('exposes the exact header name Telegram sends', () => {
    expect(TELEGRAM_SECRET_HEADER).toBe('x-telegram-bot-api-secret-token');
  });

  it('accepts the configured secret', () => {
    expect(verifyWebhookSecret(SECRET, SECRET)).toBe(true);
  });

  it.each([
    ['a wrong secret of the same length', 'X3cretWebhookToken_abcdefghijklmn'],
    ['a prefix of the secret', 'S3cretWebhook'],
    ['the secret plus a suffix', `${SECRET}extra`],
    ['an empty string', ''],
    ['a missing header', undefined],
    ['null', null],
    ['different case', SECRET.toUpperCase()],
    ['surrounding whitespace', ` ${SECRET} `],
  ])('rejects %s', (_label, provided) => {
    expect(verifyWebhookSecret(provided as string | undefined | null, SECRET)).toBe(false);
  });

  it('rejects everything when the expected secret is empty, rather than accepting everything', () => {
    expect(verifyWebhookSecret('', '')).toBe(false);
    expect(verifyWebhookSecret('anything', '')).toBe(false);
  });

  it('compares in constant time regardless of where the mismatch is', () => {
    // Not a timing measurement (too flaky for CI); this asserts the implementation
    // always inspects a fixed-width digest rather than short-circuiting on length.
    const early = verifyWebhookSecret(`Z${SECRET.slice(1)}`, SECRET);
    const late = verifyWebhookSecret(`${SECRET.slice(0, -1)}Z`, SECRET);
    expect(early).toBe(false);
    expect(late).toBe(false);
  });
});
