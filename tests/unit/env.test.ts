import { describe, it, expect } from 'vitest';
import { parseEnv, ConfigValidationError } from '@/lib/env';

const VALID = {
  TELEGRAM_BOT_TOKEN: '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw',
  TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(32),
  TELEGRAM_ALLOWED_CHAT_ID: '-1001234567890',
  GEMINI_API_KEY: 'AIzaSyDUMMYKEYFORTESTS0000000000000000',
  GEMINI_MODEL: 'gemini-2.5-flash',
  SUPABASE_URL: 'https://abcdefghijklm.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummy.dummy',
  APP_BASE_URL: 'https://meera-bot.vercel.app',
};

describe('parseEnv', () => {
  it('accepts a fully valid environment', () => {
    const env = parseEnv(VALID);
    expect(env.TELEGRAM_ALLOWED_CHAT_ID).toBe(-1001234567890);
    expect(env.GEMINI_MODEL).toBe('gemini-2.5-flash');
    expect(env.APP_BASE_URL).toBe('https://meera-bot.vercel.app');
  });

  it('defaults GEMINI_MODEL when it is absent or blank', () => {
    expect(parseEnv({ ...VALID, GEMINI_MODEL: undefined }).GEMINI_MODEL).toBeTruthy();
    expect(parseEnv({ ...VALID, GEMINI_MODEL: '' }).GEMINI_MODEL).toBeTruthy();
  });

  it('strips a trailing slash from APP_BASE_URL', () => {
    expect(parseEnv({ ...VALID, APP_BASE_URL: 'https://x.vercel.app/' }).APP_BASE_URL).toBe(
      'https://x.vercel.app',
    );
  });

  it.each([
    ['TELEGRAM_BOT_TOKEN', undefined],
    ['TELEGRAM_BOT_TOKEN', 'not-a-token'],
    ['TELEGRAM_WEBHOOK_SECRET', 'short'],
    ['TELEGRAM_WEBHOOK_SECRET', 'has spaces in it and is long enough xxxxx'],
    ['TELEGRAM_ALLOWED_CHAT_ID', 'abc'],
    ['TELEGRAM_ALLOWED_CHAT_ID', ''],
    ['GEMINI_API_KEY', ''],
    ['SUPABASE_URL', 'http://insecure.supabase.co'],
    ['SUPABASE_URL', 'not a url'],
    ['SUPABASE_SERVICE_ROLE_KEY', 'tiny'],
    ['APP_BASE_URL', 'ftp://nope'],
  ])('rejects malformed %s (%s)', (key, value) => {
    expect(() => parseEnv({ ...VALID, [key]: value })).toThrow(ConfigValidationError);
  });

  it('accepts a negative channel chat id and a positive user chat id', () => {
    expect(
      parseEnv({ ...VALID, TELEGRAM_ALLOWED_CHAT_ID: '8675309' }).TELEGRAM_ALLOWED_CHAT_ID,
    ).toBe(8675309);
  });

  it('never includes secret values in the thrown error message', () => {
    try {
      parseEnv({ ...VALID, SUPABASE_SERVICE_ROLE_KEY: 'tiny', TELEGRAM_BOT_TOKEN: 'bad' });
      throw new Error('expected parseEnv to throw');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('SUPABASE_SERVICE_ROLE_KEY');
      expect(message).toContain('TELEGRAM_BOT_TOKEN');
      expect(message).not.toContain('tiny');
      expect(message).not.toContain(VALID.SUPABASE_SERVICE_ROLE_KEY);
      expect(message).not.toContain(VALID.GEMINI_API_KEY);
    }
  });

  it('reports every invalid key at once rather than failing on the first', () => {
    try {
      parseEnv({});
      throw new Error('expected parseEnv to throw');
    } catch (err) {
      const keys = (err as ConfigValidationError).invalidKeys;
      expect(keys).toEqual(
        expect.arrayContaining([
          'TELEGRAM_BOT_TOKEN',
          'TELEGRAM_WEBHOOK_SECRET',
          'TELEGRAM_ALLOWED_CHAT_ID',
          'GEMINI_API_KEY',
          'SUPABASE_URL',
          'SUPABASE_SERVICE_ROLE_KEY',
          'APP_BASE_URL',
        ]),
      );
    }
  });
});
