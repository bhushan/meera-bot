import { describe, it, expect, vi } from 'vitest';
import { createLogger, redact } from '@/lib/logger';

describe('redact', () => {
  it('masks values under sensitive keys', () => {
    const out = redact({
      token: '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw',
      apiKey: 'AIzaSyABC',
      nested: { serviceRoleKey: 'eyJhbGciOi', SECRET: 'x' },
      chatId: -100123,
    }) as Record<string, unknown>;

    expect(out.token).toBe('[redacted]');
    expect(out.apiKey).toBe('[redacted]');
    expect((out.nested as Record<string, unknown>).serviceRoleKey).toBe('[redacted]');
    expect((out.nested as Record<string, unknown>).SECRET).toBe('[redacted]');
    expect(out.chatId).toBe(-100123);
  });

  it('masks anything shaped like a Telegram bot token wherever it appears', () => {
    const out = redact({
      url: 'https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage',
      note: 'token is 987654321:BBHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw ok',
    }) as Record<string, string>;

    expect(out.url).not.toContain('AAHdqTcv');
    expect(out.url).toContain('api.telegram.org');
    expect(out.url).toContain('bot<redacted>');
    expect(out.note).not.toContain('BBHdqTcv');
  });

  it('handles arrays, nulls and cycles without throwing', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => redact(cyclic)).not.toThrow();
    expect(redact([1, { password: 'p' }, null])).toEqual([1, { password: '[redacted]' }, null]);
  });
});

describe('createLogger', () => {
  it('emits one JSON line per call with bound context', () => {
    const sink = vi.fn();
    const log = createLogger({ requestId: 'req_1' }, sink);
    log.info('note_received', { updateId: 42 });

    expect(sink).toHaveBeenCalledTimes(1);
    const line = JSON.parse(sink.mock.calls[0]![0] as string);
    expect(line.level).toBe('info');
    expect(line.event).toBe('note_received');
    expect(line.requestId).toBe('req_1');
    expect(line.updateId).toBe(42);
    expect(typeof line.time).toBe('string');
  });

  it('child loggers inherit and extend context', () => {
    const sink = vi.fn();
    const log = createLogger({ requestId: 'req_1' }, sink).child({ updateId: 7 });
    log.warn('slow');
    const line = JSON.parse(sink.mock.calls[0]![0] as string);
    expect(line.requestId).toBe('req_1');
    expect(line.updateId).toBe(7);
    expect(line.level).toBe('warn');
  });

  it('serialises errors with kind and message but not stack secrets', () => {
    const sink = vi.fn();
    const log = createLogger({}, sink);
    log.error('pipeline_failed', { err: new Error('boom'), token: 'abc' });
    const line = JSON.parse(sink.mock.calls[0]![0] as string);
    expect(line.err.message).toBe('boom');
    expect(line.token).toBe('[redacted]');
  });

  it('never throws on unserialisable payloads', () => {
    const sink = vi.fn();
    const log = createLogger({}, sink);
    const bad = {
      toJSON() {
        throw new Error('nope');
      },
    };
    expect(() => log.info('x', { bad })).not.toThrow();
    expect(sink).toHaveBeenCalled();
  });
});
