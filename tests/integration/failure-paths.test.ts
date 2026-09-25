import { describe, it, expect } from 'vitest';
import { createHarness, TEST_CHAT_ID } from '../helpers/harness';
import { STRONG_NOTE } from '../fixtures/notes';
import { AppError } from '@/lib/errors';

const SCORE = { score: 9, reason: 'Specific and evidenced.', keywords: ['ph'] };
const DRAFT = {
  draft:
    'Batch fourteen came back with a measured pH shift of about 0.4 units. I am not claiming the batch was unsafe, only that a same-formula reorder is not always the same formula. Compare every certificate of analysis against a baseline.',
  used_news: false,
  news_url: null,
};

let updateId = 700;
const note = () => ({
  update_id: (updateId += 1),
  channel_post: {
    message_id: updateId,
    date: 1_790_000_000,
    chat: { id: TEST_CHAT_ID, type: 'channel' },
    text: STRONG_NOTE,
  },
});

describe('when scoring fails', () => {
  it('keeps the note, dead-letters the update, and sends a user-safe message', async () => {
    const harness = createHarness({ gemini: { score: SCORE, draft: DRAFT } });
    harness.gemini.failures.set('score', new AppError({ kind: 'gemini', message: 'overloaded' }));

    const update = note();
    const response = await harness.post(update);
    expect(response.status).toBe(200);

    const stored = [...harness.repo.notes.values()][0]!;
    expect(stored.raw_text).toBe(STRONG_NOTE);
    expect(stored.status).toBe('failed');
    expect(stored.failure_reason).toContain('gemini');

    expect(harness.repo.updates.get(update.update_id)!.status).toBe('dead_letter');
    expect(harness.repo.drafts.size).toBe(0);

    const message = harness.lastMessage()!.text;
    expect(message).toMatch(/something went wrong/i);
    expect(message).toContain('req_test');
    expect(message).not.toMatch(/gemini|supabase|overloaded/i);
  });
});

describe('when drafting fails', () => {
  it('preserves the score and leaves no partial draft', async () => {
    const harness = createHarness({ gemini: { score: SCORE, draft: DRAFT } });
    harness.gemini.failures.set('draft', new AppError({ kind: 'gemini', message: 'timeout' }));

    const update = note();
    await harness.post(update);

    const stored = [...harness.repo.notes.values()][0]!;
    expect(stored.score).toBe(9);
    expect(stored.status).toBe('failed');
    expect(harness.repo.drafts.size).toBe(0);
    expect(harness.repo.updates.get(update.update_id)!.status).toBe('dead_letter');
  });
});

describe('when persistence fails', () => {
  it('dead-letters the update when the note cannot be stored', async () => {
    const harness = createHarness({ gemini: { score: SCORE, draft: DRAFT } });
    harness.repo.failOn(
      'storeNote',
      new AppError({ kind: 'supabase', message: 'connection lost' }),
    );

    const update = note();
    await harness.post(update);

    expect(harness.repo.notes.size).toBe(0);
    expect(harness.repo.updates.get(update.update_id)!.status).toBe('dead_letter');
    expect(harness.gemini.requests).toHaveLength(0);
    expect(harness.lastMessage()!.text).toMatch(/something went wrong/i);
  });
});

describe('when Telegram delivery fails', () => {
  it('still records the draft rather than losing the work', async () => {
    const harness = createHarness({ gemini: { score: SCORE, draft: DRAFT } });
    const update = note();
    harness.telegram.failNextSend = new AppError({ kind: 'telegram', message: 'chat not found' });

    await harness.post(update);

    expect(harness.repo.drafts.size).toBe(1);
    expect([...harness.repo.drafts.values()][0]!.status).toBe('pending');
    expect(harness.repo.updates.get(update.update_id)!.status).toBe('dead_letter');
  });
});

describe('when news lookup fails', () => {
  it('does not fail the note: the draft is written without a news angle', async () => {
    const harness = createHarness({ gemini: { score: SCORE, draft: DRAFT } });
    harness.repo.failOn('getCachedNews', new Error('cache table missing'));
    harness.searchNews.mockResolvedValue({ items: [], outcome: 'error', query: 'q' });

    const update = note();
    await harness.post(update);

    expect(harness.repo.drafts.size).toBe(1);
    expect(harness.repo.updates.get(update.update_id)!.status).toBe('done');
  });
});
