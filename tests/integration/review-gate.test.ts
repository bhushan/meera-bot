import { describe, it, expect } from 'vitest';
import { createHarness, TEST_CHAT_ID } from '../helpers/harness';
import { STRONG_NOTE } from '../fixtures/notes';

const SCORE = { score: 9, reason: 'Specific and evidenced.', keywords: ['ph'] };
const DRAFT = {
  draft:
    'Batch fourteen came back with a measured pH shift of about 0.4 units. I am not claiming the batch was unsafe, only that a same-formula reorder is not always the same formula. Compare every certificate of analysis against a baseline you keep yourself.',
  used_news: false,
  news_url: null,
};

let updateId = 100;
const nextId = () => (updateId += 1);

async function harnessWithPendingDraft() {
  const harness = createHarness({ gemini: { score: SCORE, draft: DRAFT } });
  await harness.post({
    update_id: nextId(),
    channel_post: {
      message_id: updateId,
      date: 1_790_000_000,
      chat: { id: TEST_CHAT_ID, type: 'channel' },
      text: STRONG_NOTE,
    },
  });
  const draft = harness.onlyDraft()!;
  return { harness, draft };
}

const callback = (shortId: string, decision: 'a' | 'r', messageId: number) => ({
  update_id: nextId(),
  callback_query: {
    id: `cbq-${updateId}`,
    from: { id: 8675309, is_bot: false, username: 'meera' },
    data: `rv:${decision}:${shortId}`,
    message: { message_id: messageId, date: 1, chat: { id: TEST_CHAT_ID, type: 'channel' } },
  },
});

const command = (text: string) => ({
  update_id: nextId(),
  message: {
    message_id: updateId,
    date: 1,
    chat: { id: TEST_CHAT_ID, type: 'channel' },
    from: { id: 8675309, is_bot: false, username: 'meera' },
    text,
  },
});

describe('approval', () => {
  it('moves a pending draft to approved via the inline button', async () => {
    const { harness, draft } = await harnessWithPendingDraft();
    await harness.post(callback(draft.short_id, 'a', draft.telegram_message_id!));

    expect(harness.repo.drafts.get(draft.id)!.status).toBe('approved');
    expect(harness.telegram.answered.at(-1)).toMatchObject({ text: 'Approved' });
    expect(harness.lastMessage()!.text).toMatch(/approved/i);
  });

  it('moves a pending draft to approved via the text command', async () => {
    const { harness, draft } = await harnessWithPendingDraft();
    await harness.post(command(`APPROVE ${draft.short_id}`));
    expect(harness.repo.drafts.get(draft.id)!.status).toBe('approved');
  });

  it('accepts a lowercase command', async () => {
    const { harness, draft } = await harnessWithPendingDraft();
    await harness.post(command(`approve ${draft.short_id.toLowerCase()}`));
    expect(harness.repo.drafts.get(draft.id)!.status).toBe('approved');
  });

  it('records who acted, when, and with which Telegram update', async () => {
    const { harness, draft } = await harnessWithPendingDraft();
    const update = callback(draft.short_id, 'a', draft.telegram_message_id!);
    await harness.post(update);

    expect(harness.repo.reviews).toHaveLength(1);
    expect(harness.repo.reviews[0]).toMatchObject({
      draft_id: draft.id,
      decision: 'approved',
      actor_chat_id: TEST_CHAT_ID,
      actor_user_id: 8675309,
      actor_username: 'meera',
      telegram_update_id: update.update_id,
      source: 'callback',
      applied: true,
    });
  });

  it('retires the inline keyboard once a decision is recorded', async () => {
    const { harness, draft } = await harnessWithPendingDraft();
    await harness.post(callback(draft.short_id, 'a', draft.telegram_message_id!));
    expect(harness.telegram.edited.at(-1)).toMatchObject({
      chatId: TEST_CHAT_ID,
      messageId: draft.telegram_message_id,
      inlineKeyboard: [],
    });
  });

  it('never publishes anywhere: the only outputs are database rows and Telegram messages', async () => {
    const { harness, draft } = await harnessWithPendingDraft();
    await harness.post(callback(draft.short_id, 'a', draft.telegram_message_id!));
    const allText = harness.telegram.sent.map((m) => m.text).join('\n');
    expect(allText).not.toMatch(/posted to linkedin|published to linkedin|scheduled for/i);
    expect(allText).toMatch(/does not post anything/i);
  });
});

describe('rejection', () => {
  it('moves a pending draft to rejected and keeps the row', async () => {
    const { harness, draft } = await harnessWithPendingDraft();
    await harness.post(callback(draft.short_id, 'r', draft.telegram_message_id!));

    expect(harness.repo.drafts.get(draft.id)!.status).toBe('rejected');
    expect(harness.repo.drafts.size).toBe(1);
    expect(harness.repo.notes.size).toBe(1);
  });

  it('rejects via the text command too', async () => {
    const { harness, draft } = await harnessWithPendingDraft();
    await harness.post(command(`REJECT ${draft.short_id}`));
    expect(harness.repo.drafts.get(draft.id)!.status).toBe('rejected');
  });
});

describe('idempotency', () => {
  it('a repeated button press with a new update id confirms rather than changes', async () => {
    const { harness, draft } = await harnessWithPendingDraft();
    await harness.post(callback(draft.short_id, 'a', draft.telegram_message_id!));
    await harness.post(callback(draft.short_id, 'a', draft.telegram_message_id!));

    expect(harness.repo.drafts.get(draft.id)!.status).toBe('approved');
    expect(harness.repo.reviews.filter((r) => r.applied)).toHaveLength(1);
    expect(harness.repo.reviews).toHaveLength(2);
    expect(harness.lastMessage()!.text).toMatch(/already approved/i);
    expect(harness.telegram.answered.at(-1)).toMatchObject({ text: 'Already approved' });
  });

  it('a redelivery of the exact same update is dropped by the dedup ledger', async () => {
    const { harness, draft } = await harnessWithPendingDraft();
    const update = callback(draft.short_id, 'a', draft.telegram_message_id!);
    await harness.post(update);
    const replay = await harness.post(update);

    expect(replay.body).toMatchObject({ duplicate: true });
    expect(harness.repo.reviews).toHaveLength(1);
  });

  it('a reject after an approve does not flip the decision', async () => {
    const { harness, draft } = await harnessWithPendingDraft();
    await harness.post(callback(draft.short_id, 'a', draft.telegram_message_id!));
    await harness.post(callback(draft.short_id, 'r', draft.telegram_message_id!));

    expect(harness.repo.drafts.get(draft.id)!.status).toBe('approved');
    expect(harness.lastMessage()!.text).toMatch(/already approved/i);
  });

  it('an approve command after a reject does not flip the decision', async () => {
    const { harness, draft } = await harnessWithPendingDraft();
    await harness.post(command(`REJECT ${draft.short_id}`));
    await harness.post(command(`APPROVE ${draft.short_id}`));
    expect(harness.repo.drafts.get(draft.id)!.status).toBe('rejected');
  });

  it('concurrent approve and reject for the same draft resolve to one decision', async () => {
    const { harness, draft } = await harnessWithPendingDraft();
    await Promise.all([
      harness.post(callback(draft.short_id, 'a', draft.telegram_message_id!)),
      harness.post(callback(draft.short_id, 'r', draft.telegram_message_id!)),
    ]);
    await harness.settle();

    const status = harness.repo.drafts.get(draft.id)!.status;
    expect(['approved', 'rejected']).toContain(status);
    expect(harness.repo.reviews.filter((r) => r.applied)).toHaveLength(1);
  });
});

describe('unknown and malformed review targets', () => {
  it('reports an unknown draft id without changing anything', async () => {
    const { harness, draft } = await harnessWithPendingDraft();
    await harness.post(command('APPROVE ZZZZZZ'));

    expect(harness.repo.drafts.get(draft.id)!.status).toBe('pending');
    expect(harness.lastMessage()!.text).toContain('ZZZZZZ');
    expect(harness.lastMessage()!.text).toMatch(/no draft found/i);
  });

  it('explains a malformed draft id instead of treating the message as a note', async () => {
    const harness = createHarness({ gemini: { score: SCORE, draft: DRAFT } });
    await harness.post(command('APPROVE nope'));

    expect(harness.gemini.requests).toHaveLength(0);
    expect(harness.repo.notes.size).toBe(0);
    expect(harness.lastMessage()!.text).toMatch(/not understood/i);
  });

  it('ignores callback data it does not recognise', async () => {
    const harness = createHarness({});
    const response = await harness.post({
      update_id: nextId(),
      callback_query: {
        id: 'cbq-x',
        from: { id: 1, is_bot: false },
        data: 'delete:everything',
        message: { message_id: 1, date: 1, chat: { id: TEST_CHAT_ID, type: 'channel' } },
      },
    });
    expect(response.body).toMatchObject({ ignored: true });
    expect(harness.repo.reviews).toHaveLength(0);
  });
});
