import { describe, it, expect, vi } from 'vitest';
import { createTelegramClient } from '@/lib/telegram/client';
import { createLogger } from '@/lib/logger';
import { AppError } from '@/lib/errors';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
const silentLogger = createLogger({}, () => {});

const okResponse = (result: unknown) =>
  new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const client = (fetchImpl: typeof fetch) =>
  createTelegramClient({
    token: TOKEN,
    logger: silentLogger,
    fetchImpl,
    sleep: async () => {},
  });

describe('TelegramClient.sendMessage', () => {
  it('posts to the bot endpoint with HTML parse mode and returns the message id', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ message_id: 55 })) as unknown as typeof fetch;
    const result = await client(fetchImpl).sendMessage({ chatId: -100, text: 'hello' });

    expect(result.messageId).toBe(55);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ chat_id: -100, text: 'hello', parse_mode: 'HTML' });
  });

  it('attaches an inline keyboard when one is supplied, on the final chunk only', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ message_id: 7 })) as unknown as typeof fetch;
    const longText = 'x'.repeat(5000);
    await client(fetchImpl).sendMessage({
      chatId: 1,
      text: longText,
      inlineKeyboard: [[{ text: 'Approve', callbackData: 'rv:a:AB12CD' }]],
    });

    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(2);
    const first = JSON.parse((calls[0]![1] as RequestInit).body as string);
    const last = JSON.parse((calls[1]![1] as RequestInit).body as string);
    expect(first.reply_markup).toBeUndefined();
    expect(last.reply_markup).toEqual({
      inline_keyboard: [[{ text: 'Approve', callback_data: 'rv:a:AB12CD' }]],
    });
  });

  it('retries a 429 and honours retry_after', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 1 } }),
          {
            status: 429,
          },
        ),
      )
      .mockResolvedValueOnce(okResponse({ message_id: 9 })) as unknown as typeof fetch;

    await expect(client(fetchImpl).sendMessage({ chatId: 1, text: 'hi' })).resolves.toEqual({
      messageId: 9,
    });
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it('retries a 5xx up to three attempts then throws a telegram AppError', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('bad gateway', { status: 502 }),
    ) as unknown as typeof fetch;
    await expect(client(fetchImpl).sendMessage({ chatId: 1, text: 'hi' })).rejects.toMatchObject({
      kind: 'telegram',
    });
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
  });

  it('does not retry a 400 from Telegram', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ ok: false, error_code: 400, description: 'chat not found' }),
          {
            status: 400,
          },
        ),
    ) as unknown as typeof fetch;

    await expect(client(fetchImpl).sendMessage({ chatId: 1, text: 'hi' })).rejects.toThrow(
      AppError,
    );
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('never leaks the bot token in the thrown error message', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('nope', { status: 500 }),
    ) as unknown as typeof fetch;
    try {
      await client(fetchImpl).sendMessage({ chatId: 1, text: 'hi' });
      throw new Error('expected a failure');
    } catch (err) {
      expect(
        JSON.stringify(err instanceof AppError ? { m: err.message, c: err.context } : err),
      ).not.toContain('AAHdqTcv');
    }
  });
});

describe('TelegramClient.answerCallbackQuery / editMessageReplyMarkup', () => {
  it('answers a callback query', async () => {
    const fetchImpl = vi.fn(async () => okResponse(true)) as unknown as typeof fetch;
    await client(fetchImpl).answerCallbackQuery({ callbackQueryId: 'cbq-1', text: 'Approved' });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toContain('/answerCallbackQuery');
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      callback_query_id: 'cbq-1',
      text: 'Approved',
    });
  });

  it('clears the inline keyboard after a decision', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ message_id: 3 })) as unknown as typeof fetch;
    await client(fetchImpl).editMessageReplyMarkup({ chatId: 1, messageId: 3, inlineKeyboard: [] });
    const body = JSON.parse(
      ((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit)
        .body as string,
    );
    expect(body.reply_markup).toEqual({ inline_keyboard: [] });
  });

  it('swallows the "message is not modified" error so repeat clicks stay idempotent', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error_code: 400,
            description: 'Bad Request: message is not modified',
          }),
          { status: 400 },
        ),
    ) as unknown as typeof fetch;

    await expect(
      client(fetchImpl).editMessageReplyMarkup({ chatId: 1, messageId: 3, inlineKeyboard: [] }),
    ).resolves.toBeUndefined();
  });
});
