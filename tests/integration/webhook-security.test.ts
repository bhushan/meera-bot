import { describe, it, expect } from 'vitest';
import { createHarness, TEST_CHAT_ID, TEST_SECRET } from '../helpers/harness';
import { STRONG_NOTE } from '../fixtures/notes';

const SCORE = { score: 9, reason: 'Specific and evidenced.', keywords: ['ph'] };
const DRAFT = {
  draft:
    'Batch fourteen came back with a measured pH shift. I am not claiming the batch was unsafe, only that a same-formula reorder is not always the same formula. Compare every certificate of analysis against a baseline you keep yourself, because the customer should not be the one who notices first.',
  used_news: false,
  news_url: null,
};

const note = (updateId: number, chatId = TEST_CHAT_ID) => ({
  update_id: updateId,
  channel_post: {
    message_id: updateId,
    date: 1_790_000_000,
    chat: { id: chatId, type: 'channel' },
    text: STRONG_NOTE,
  },
});

describe('webhook secret enforcement', () => {
  it('rejects a missing secret header with 401 and touches nothing', async () => {
    const harness = createHarness({ gemini: { score: SCORE, draft: DRAFT } });
    const response = await harness.post(note(1), { secret: null });

    expect(response.status).toBe(401);
    expect(harness.repo.updates.size).toBe(0);
    expect(harness.repo.notes.size).toBe(0);
    expect(harness.gemini.requests).toHaveLength(0);
    expect(harness.telegram.sent).toHaveLength(0);
  });

  it('rejects a wrong secret with 401', async () => {
    const harness = createHarness({ gemini: { score: SCORE, draft: DRAFT } });
    const response = await harness.post(note(2), { secret: 'wrong-secret-value-0123456789' });
    expect(response.status).toBe(401);
    expect(harness.repo.notes.size).toBe(0);
  });

  it('rejects a secret that is a prefix of the real one', async () => {
    const harness = createHarness({});
    expect((await harness.post(note(3), { secret: TEST_SECRET.slice(0, -1) })).status).toBe(401);
  });

  it('accepts the exact secret', async () => {
    const harness = createHarness({ gemini: { score: SCORE, draft: DRAFT } });
    expect((await harness.post(note(4))).status).toBe(200);
  });

  it('checks the secret before parsing the body, so a malformed body still 401s', async () => {
    const harness = createHarness({});
    const response = await harness.post(null, { secret: null, rawBody: 'not json' });
    expect(response.status).toBe(401);
  });
});

describe('allowed chat enforcement', () => {
  it('rejects a note from a different chat with 403 and stores nothing', async () => {
    const harness = createHarness({ gemini: { score: SCORE, draft: DRAFT } });
    const response = await harness.post(note(10, -1009999999999));

    expect(response.status).toBe(403);
    expect(harness.repo.updates.size).toBe(0);
    expect(harness.repo.notes.size).toBe(0);
    expect(harness.gemini.requests).toHaveLength(0);
    expect(harness.telegram.sent).toHaveLength(0);
  });

  it('rejects a review callback from a different chat', async () => {
    const harness = createHarness({});
    const response = await harness.post({
      update_id: 11,
      callback_query: {
        id: 'cbq',
        from: { id: 7, is_bot: false },
        data: 'rv:a:AB12CD',
        message: { message_id: 1, date: 1, chat: { id: 999, type: 'private' } },
      },
    });
    expect(response.status).toBe(403);
    expect(harness.repo.reviews).toHaveLength(0);
  });
});

describe('malformed payloads', () => {
  it.each([
    ['unparseable JSON', 'definitely not json'],
    ['a JSON scalar', '"just a string"'],
    ['an object with no update_id', '{"message":{}}'],
  ])('answers 400 for %s without storing anything', async (_label, rawBody) => {
    const harness = createHarness({});
    const response = await harness.post(null, { rawBody });
    expect(response.status).toBe(400);
    expect(harness.repo.updates.size).toBe(0);
  });
});

describe('update idempotency', () => {
  it('processes a repeated update_id exactly once', async () => {
    const harness = createHarness({ gemini: { score: SCORE, draft: DRAFT } });

    const first = await harness.post(note(20));
    const second = await harness.post(note(20));
    const third = await harness.post(note(20));

    expect(first.body).toMatchObject({ accepted: 'note' });
    expect(second.body).toMatchObject({ duplicate: true });
    expect(third.body).toMatchObject({ duplicate: true });
    expect(second.status).toBe(200);

    expect(harness.repo.notes.size).toBe(1);
    expect(harness.repo.drafts.size).toBe(1);
    expect(harness.gemini.labels.filter((l) => l === 'draft')).toHaveLength(1);
    expect(harness.telegram.sent).toHaveLength(1);
  });

  it('treats concurrent deliveries of the same update as one', async () => {
    const harness = createHarness({ gemini: { score: SCORE, draft: DRAFT } });
    const responses = await Promise.all([
      harness.post(note(21)),
      harness.post(note(21)),
      harness.post(note(21)),
    ]);
    await harness.settle();

    expect(responses.filter((r) => r.body.duplicate === true)).toHaveLength(2);
    expect(harness.repo.drafts.size).toBe(1);
  });
});

describe('rate limiting and concurrency', () => {
  it('stops processing once the per-chat window is exhausted', async () => {
    const harness = createHarness({
      rateLimitMaxEvents: 2,
      gemini: { score: SCORE, draft: DRAFT },
    });

    const first = await harness.post(note(30));
    const second = await harness.post(note(31));
    const third = await harness.post(note(32));

    expect(first.body).toMatchObject({ accepted: 'note' });
    expect(second.body).toMatchObject({ accepted: 'note' });
    expect(third.body).toMatchObject({ rateLimited: true });
    expect(third.status).toBe(200);

    expect(harness.repo.notes.size).toBe(2);
    expect(harness.repo.updates.get(32)!.status).toBe('rate_limited');
    expect(harness.lastMessage()!.text).toMatch(/too many notes/i);
  });

  it('answers 429 when the in-process concurrency guard is saturated', async () => {
    const harness = createHarness({ concurrencyLimit: 1, gemini: { score: SCORE, draft: DRAFT } });

    // Both requests are started before either settles, so the first still holds
    // the only slot when the second arrives.
    const a = harness.post(note(40));
    const b = harness.post(note(41));
    const [, second] = await Promise.all([a, b]);
    await harness.settle();

    expect(second.status).toBe(429);
    expect(harness.repo.updates.has(41)).toBe(false);
  });

  it('releases the concurrency slot after the scheduled work finishes', async () => {
    const harness = createHarness({ concurrencyLimit: 1, gemini: { score: SCORE, draft: DRAFT } });
    expect((await harness.post(note(50))).status).toBe(200);
    expect((await harness.post(note(51))).status).toBe(200);
    expect(harness.repo.drafts.size).toBe(2);
  });
});
