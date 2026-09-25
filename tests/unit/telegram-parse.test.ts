import { describe, it, expect } from 'vitest';
import { parseUpdate } from '@/lib/telegram/parse';
import { AppError } from '@/lib/errors';

const CHANNEL_POST = {
  update_id: 100,
  channel_post: {
    message_id: 11,
    date: 1_700_000_000,
    chat: { id: -1001234567890, type: 'channel', title: 'Skinstinct notes' },
    text: 'Batch fourteen came back with a pH shift.',
  },
};

const DIRECT_MESSAGE = {
  update_id: 101,
  message: {
    message_id: 12,
    date: 1_700_000_100,
    chat: { id: 8675309, type: 'private' },
    from: { id: 8675309, is_bot: false, username: 'meera', first_name: 'Meera' },
    text: 'Customer asked why the serum stings at pH 3.5.',
  },
};

describe('parseUpdate: notes', () => {
  it('parses a channel post into a note', () => {
    const parsed = parseUpdate(CHANNEL_POST);
    expect(parsed).toMatchObject({
      kind: 'note',
      updateId: 100,
      chatId: -1001234567890,
      messageId: 11,
      sourceType: 'channel_post',
      text: 'Batch fourteen came back with a pH shift.',
    });
  });

  it('parses a direct message into a note and keeps the author identity', () => {
    const parsed = parseUpdate(DIRECT_MESSAGE);
    expect(parsed).toMatchObject({
      kind: 'note',
      updateId: 101,
      chatId: 8675309,
      messageId: 12,
      sourceType: 'message',
      fromId: 8675309,
      fromUsername: 'meera',
    });
  });

  it('trims surrounding whitespace from the note text', () => {
    const parsed = parseUpdate({
      ...DIRECT_MESSAGE,
      message: { ...DIRECT_MESSAGE.message, text: '   spaced out note   ' },
    });
    expect(parsed).toMatchObject({ kind: 'note', text: 'spaced out note' });
  });
});

describe('parseUpdate: ignored traffic', () => {
  it('ignores messages sent by bots so the bot cannot answer itself', () => {
    const parsed = parseUpdate({
      ...DIRECT_MESSAGE,
      message: { ...DIRECT_MESSAGE.message, from: { id: 42, is_bot: true, username: 'meera_bot' } },
    });
    expect(parsed).toMatchObject({ kind: 'ignored', reason: 'bot_message' });
  });

  it('ignores edited messages and other update types we do not subscribe to', () => {
    expect(parseUpdate({ update_id: 5, edited_message: { message_id: 1 } })).toMatchObject({
      kind: 'ignored',
      reason: 'unsupported_update_type',
    });
    expect(parseUpdate({ update_id: 6, my_chat_member: {} })).toMatchObject({ kind: 'ignored' });
  });

  it('ignores empty or whitespace-only text', () => {
    const parsed = parseUpdate({
      ...DIRECT_MESSAGE,
      message: { ...DIRECT_MESSAGE.message, text: '    ' },
    });
    expect(parsed).toMatchObject({ kind: 'ignored', reason: 'empty_text' });
  });

  it('tolerates unknown fields from newer Bot API versions', () => {
    const parsed = parseUpdate({
      ...CHANNEL_POST,
      some_future_field: { nested: true },
      channel_post: { ...CHANNEL_POST.channel_post, brand_new_flag: true },
    });
    expect(parsed.kind).toBe('note');
  });
});

describe('parseUpdate: unsupported media', () => {
  it.each([
    ['photo', { photo: [{ file_id: 'abc', file_unique_id: 'u', width: 1, height: 1 }] }],
    ['voice', { voice: { file_id: 'abc', file_unique_id: 'u', duration: 3 } }],
    ['document', { document: { file_id: 'abc', file_unique_id: 'u' } }],
    ['video', { video: { file_id: 'a', file_unique_id: 'u', width: 1, height: 1, duration: 1 } }],
    ['sticker', { sticker: { file_id: 'a', file_unique_id: 'u', width: 1, height: 1, type: 'x' } }],
  ])('flags a %s message as unsupported media', (_label, payload) => {
    const parsed = parseUpdate({
      update_id: 200,
      message: { message_id: 20, date: 1, chat: { id: 8675309, type: 'private' }, ...payload },
    });
    expect(parsed).toMatchObject({ kind: 'unsupported_media', chatId: 8675309, updateId: 200 });
  });

  it('treats a captioned photo as unsupported media, not as a note', () => {
    const parsed = parseUpdate({
      update_id: 201,
      message: {
        message_id: 21,
        date: 1,
        chat: { id: 8675309, type: 'private' },
        photo: [{ file_id: 'a', file_unique_id: 'u', width: 1, height: 1 }],
        caption: 'batch fourteen',
      },
    });
    expect(parsed.kind).toBe('unsupported_media');
  });
});

describe('parseUpdate: review commands', () => {
  it.each([
    ['APPROVE AB12CD', 'approved', 'AB12CD'],
    ['REJECT AB12CD', 'rejected', 'AB12CD'],
    ['approve ab12cd', 'approved', 'AB12CD'],
    ['  REJECT   ab12cd  ', 'rejected', 'AB12CD'],
    ['/approve AB12CD', 'approved', 'AB12CD'],
    ['/reject@meera_bot AB12CD', 'rejected', 'AB12CD'],
  ])('parses %s', (text, decision, draftShortId) => {
    const parsed = parseUpdate({
      ...DIRECT_MESSAGE,
      message: { ...DIRECT_MESSAGE.message, text },
    });
    expect(parsed).toMatchObject({
      kind: 'review_command',
      decision,
      draftShortId,
      source: 'command',
    });
  });

  it('treats prose that merely mentions approve as a note, not a command', () => {
    const parsed = parseUpdate({
      ...DIRECT_MESSAGE,
      message: {
        ...DIRECT_MESSAGE.message,
        text: 'I approve of stricter CoA checks because suppliers change blends quietly.',
      },
    });
    expect(parsed.kind).toBe('note');
  });

  it('reports a malformed draft id instead of silently treating it as a note', () => {
    const parsed = parseUpdate({
      ...DIRECT_MESSAGE,
      message: { ...DIRECT_MESSAGE.message, text: 'APPROVE zzz' },
    });
    expect(parsed).toMatchObject({ kind: 'invalid_command' });
  });
});

describe('parseUpdate: callback queries', () => {
  it('parses an approve callback', () => {
    const parsed = parseUpdate({
      update_id: 300,
      callback_query: {
        id: 'cbq-1',
        from: { id: 8675309, is_bot: false, username: 'meera' },
        data: 'rv:a:AB12CD',
        message: { message_id: 30, date: 1, chat: { id: 8675309, type: 'private' } },
      },
    });
    expect(parsed).toMatchObject({
      kind: 'review_callback',
      decision: 'approved',
      draftShortId: 'AB12CD',
      callbackQueryId: 'cbq-1',
      chatId: 8675309,
      messageId: 30,
      source: 'callback',
    });
  });

  it('parses a reject callback', () => {
    const parsed = parseUpdate({
      update_id: 301,
      callback_query: {
        id: 'cbq-2',
        from: { id: 8675309, is_bot: false },
        data: 'rv:r:AB12CD',
        message: { message_id: 31, date: 1, chat: { id: 8675309, type: 'private' } },
      },
    });
    expect(parsed).toMatchObject({ kind: 'review_callback', decision: 'rejected' });
  });

  it('ignores callback data it does not recognise', () => {
    const parsed = parseUpdate({
      update_id: 302,
      callback_query: {
        id: 'cbq-3',
        from: { id: 8675309, is_bot: false },
        data: 'something:else',
        message: { message_id: 32, date: 1, chat: { id: 8675309, type: 'private' } },
      },
    });
    expect(parsed).toMatchObject({ kind: 'ignored', reason: 'unrecognised_callback_data' });
  });
});

describe('parseUpdate: malformed payloads', () => {
  it.each([
    ['null', null],
    ['a string', 'not an update'],
    ['an array', [1, 2, 3]],
    ['an empty object', {}],
    ['a non-numeric update_id', { update_id: 'abc' }],
    ['a missing chat id', { update_id: 1, message: { message_id: 1, date: 1, text: 'hi' } }],
    [
      'a non-numeric chat id',
      {
        update_id: 1,
        message: { message_id: 1, date: 1, chat: { id: 'x', type: 'private' }, text: 'hi' },
      },
    ],
  ])('throws a validation AppError for %s', (_label, payload) => {
    expect(() => parseUpdate(payload)).toThrow(AppError);
    try {
      parseUpdate(payload);
    } catch (err) {
      expect((err as AppError).kind).toBe('validation');
      expect((err as AppError).retryable).toBe(false);
    }
  });
});
