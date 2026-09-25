import { describe, it, expect } from 'vitest';
import { createHarness, TEST_CHAT_ID, TEST_VOICE_SKILL } from '../helpers/harness';
import { STRONG_NOTE, WEAK_NOTE } from '../fixtures/notes';
import type { NewsItem } from '@/lib/news/types';

let nextUpdateId = 5000;
const channelPost = (text: string, overrides: Record<string, unknown> = {}) => ({
  update_id: (nextUpdateId += 1),
  channel_post: {
    message_id: nextUpdateId,
    date: 1_790_000_000,
    chat: { id: TEST_CHAT_ID, type: 'channel' },
    text,
    ...overrides,
  },
});

const STRONG_SCORE = {
  score: 9,
  reason: 'A specific manufacturing observation with a measured pH shift.',
  keywords: ['preservative blend', 'ph stability', 'certificate of analysis'],
};

const WEAK_SCORE = {
  score: 2,
  reason: 'This is a personal reminder, not an argument.',
  keywords: [],
};

const DRAFT_BODY =
  'Batch fourteen came back from the manufacturer and the pH stability data was outside the range I expected. I am not claiming the batch was unsafe. I am claiming that a same-formula reorder is not automatically the same formula, and that the difference showed up in texture before it showed up in any paperwork I was sent. Ask your manufacturer for the certificate of analysis on every batch and compare it against a baseline you keep yourself.';

const NEWS: NewsItem = {
  headline: 'Preservative supply shifts hit small skincare brands',
  publication: 'Cosmetics Business',
  publishedAt: '2026-09-22T09:00:00.000Z',
  url: 'https://news.example/preservative-supply',
  description: 'Reformulations ripple through contract manufacturing.',
};

describe('acceptance: the strong note produces a draft', () => {
  it('stores the note, scores it, drafts it, and returns a pending draft to Telegram', async () => {
    const harness = createHarness({
      gemini: {
        score: STRONG_SCORE,
        draft: { draft: DRAFT_BODY, used_news: false, news_url: null },
      },
    });

    const response = await harness.post(channelPost(STRONG_NOTE));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, accepted: 'note' });

    const note = [...harness.repo.notes.values()][0]!;
    expect(note.raw_text).toBe(STRONG_NOTE);
    expect(note.score).toBe(9);
    expect(note.status).toBe('drafted');

    const draft = harness.onlyDraft()!;
    expect(draft.status).toBe('pending');
    expect(draft.body).toBe(DRAFT_BODY);
    expect(draft.gemini_model).toBe('gemini-2.5-flash');
    expect(draft.telegram_message_id).toBeGreaterThan(0);

    const message = harness.lastMessage()!;
    expect(message.chatId).toBe(TEST_CHAT_ID);
    expect(message.text).toContain(`DRAFT ${draft.short_id}`);
    expect(message.text).toContain('SCORE: 9/10');
    expect(message.inlineKeyboard).toEqual([
      [
        { text: 'Approve', callbackData: `rv:a:${draft.short_id}` },
        { text: 'Reject', callbackData: `rv:r:${draft.short_id}` },
      ],
    ]);

    expect(harness.repo.updates.get(response.body.ok ? note.telegram_update_id : 0)?.status).toBe(
      'done',
    );
  });

  it('sends the versioned voice skill on the drafting call', async () => {
    const harness = createHarness({
      gemini: {
        score: STRONG_SCORE,
        draft: { draft: DRAFT_BODY, used_news: false, news_url: null },
      },
    });
    await harness.post(channelPost(STRONG_NOTE));

    const draftRequest = harness.gemini.requests.find((r) => r.label === 'draft')!;
    expect(draftRequest.systemInstruction).toContain(TEST_VOICE_SKILL);

    const draft = harness.onlyDraft()!;
    const activeSkill = harness.repo.voiceSkills.find((s) => s.is_active)!;
    expect(draft.voice_skill_id).toBe(activeSkill.id);
  });

  it('seeds the voice skill from file when the database has none, rather than dropping the note', async () => {
    const harness = createHarness({
      seedVoiceSkill: null,
      gemini: {
        score: STRONG_SCORE,
        draft: { draft: DRAFT_BODY, used_news: false, news_url: null },
      },
    });
    await harness.post(channelPost(STRONG_NOTE));

    expect(harness.onlyDraft()).toBeDefined();
    const seeded = harness.repo.voiceSkills.find((s) => s.is_active)!;
    expect(seeded.content).toContain('Meera writes like a technically trained founder');
  });
});

describe('acceptance: the weak note is rejected without a drafting call', () => {
  it('stores the note, records the score, and never calls the drafting model', async () => {
    const harness = createHarness({ gemini: { score: WEAK_SCORE } });

    const response = await harness.post(channelPost(WEAK_NOTE));
    expect(response.status).toBe(200);

    expect(harness.gemini.labels).toEqual(['score']);
    expect(harness.gemini.labels).not.toContain('draft');
    expect(harness.repo.drafts.size).toBe(0);
    expect(harness.searchNews).not.toHaveBeenCalled();

    const note = [...harness.repo.notes.values()][0]!;
    expect(note.raw_text).toBe(WEAK_NOTE);
    expect(note.status).toBe('rejected_low_score');
    expect(note.score).toBe(2);
    expect(note.score_reason).toBe(WEAK_SCORE.reason);

    const message = harness.lastMessage()!;
    expect(message.text).toContain('2/10');
    expect(message.text).toContain(WEAK_SCORE.reason);
    expect(message.inlineKeyboard).toBeUndefined();
  });

  it('keeps the rejected note on file rather than deleting it', async () => {
    const harness = createHarness({ gemini: { score: WEAK_SCORE } });
    await harness.post(channelPost(WEAK_NOTE));
    expect(harness.repo.notes.size).toBe(1);
  });
});

describe('score threshold behaviour at the boundary', () => {
  it('a score of 5 stops the pipeline', async () => {
    const harness = createHarness({
      gemini: { score: { score: 5, reason: 'Close, but unsupported.', keywords: ['ph'] } },
    });
    await harness.post(channelPost(STRONG_NOTE));
    expect(harness.gemini.labels).toEqual(['score']);
    expect(harness.repo.drafts.size).toBe(0);
    expect([...harness.repo.notes.values()][0]!.status).toBe('rejected_low_score');
  });

  it('a score of 6 continues to drafting', async () => {
    const harness = createHarness({
      gemini: {
        score: { score: 6, reason: 'Just enough evidence.', keywords: ['ph'] },
        draft: { draft: DRAFT_BODY, used_news: false, news_url: null },
      },
    });
    await harness.post(channelPost(STRONG_NOTE));
    expect(harness.gemini.labels).toContain('draft');
    expect(harness.repo.drafts.size).toBe(1);
    expect([...harness.repo.notes.values()][0]!.status).toBe('drafted');
  });
});

describe('news angle', () => {
  it('appends the verification block when the draft used a retrieved source', async () => {
    const harness = createHarness({
      news: [NEWS],
      gemini: {
        score: STRONG_SCORE,
        relevance: { relevant: true, index: 0, reason: 'Same mechanism at industry scale.' },
        draft: { draft: DRAFT_BODY, used_news: true, news_url: NEWS.url },
      },
    });
    await harness.post(channelPost(STRONG_NOTE));

    const draft = harness.onlyDraft()!;
    expect(draft.used_news).toBe(true);
    expect(draft.news_url).toBe(NEWS.url);
    expect(draft.news_publication).toBe(NEWS.publication);

    const text = harness.lastMessage()!.text;
    expect(text).toContain(`NEWS SOURCE: ${NEWS.headline}`);
    expect(text).toContain('FROM: Cosmetics Business | 2026-09-22');
    expect(text).toContain(`LINK: ${NEWS.url}`);
    expect(text).toContain('CHECK BEFORE PUBLISHING: You are the author of this claim.');
  });

  it('omits the block and stores no news metadata when the model ignored the item', async () => {
    const harness = createHarness({
      news: [NEWS],
      gemini: {
        score: STRONG_SCORE,
        relevance: { relevant: true, index: 0, reason: 'maybe' },
        draft: { draft: DRAFT_BODY, used_news: false, news_url: null },
      },
    });
    await harness.post(channelPost(STRONG_NOTE));

    const draft = harness.onlyDraft()!;
    expect(draft.used_news).toBe(false);
    expect(draft.news_url).toBeNull();
    expect(harness.lastMessage()!.text).not.toContain('NEWS SOURCE:');
  });

  it('drafts anyway when the relevance check rejects every result', async () => {
    const harness = createHarness({
      news: [NEWS],
      gemini: {
        score: STRONG_SCORE,
        relevance: { relevant: false, index: null, reason: 'Only a shared keyword.' },
        draft: { draft: DRAFT_BODY, used_news: false, news_url: null },
      },
    });
    await harness.post(channelPost(STRONG_NOTE));
    expect(harness.repo.drafts.size).toBe(1);
    expect(harness.onlyDraft()!.used_news).toBe(false);
  });

  it('drafts anyway when the RSS search returns nothing', async () => {
    const harness = createHarness({
      news: { items: [], outcome: 'empty', query: 'q' },
      gemini: {
        score: STRONG_SCORE,
        draft: { draft: DRAFT_BODY, used_news: false, news_url: null },
      },
    });
    await harness.post(channelPost(STRONG_NOTE));
    expect(harness.repo.drafts.size).toBe(1);
    expect(harness.gemini.labels).not.toContain('news-relevance');
  });

  it('drafts anyway when the RSS search times out', async () => {
    const harness = createHarness({
      news: { items: [], outcome: 'timeout', query: 'q' },
      gemini: {
        score: STRONG_SCORE,
        draft: { draft: DRAFT_BODY, used_news: false, news_url: null },
      },
    });
    await harness.post(channelPost(STRONG_NOTE));
    expect(harness.repo.drafts.size).toBe(1);
  });

  it('serves an identical follow-up search from the cache instead of refetching', async () => {
    const harness = createHarness({
      news: [NEWS],
      gemini: {
        score: STRONG_SCORE,
        relevance: { relevant: false, index: null, reason: 'no' },
        draft: { draft: DRAFT_BODY, used_news: false, news_url: null },
      },
    });

    await harness.post(channelPost(STRONG_NOTE));
    await harness.post(channelPost(`${STRONG_NOTE} Second note, same keywords.`));

    expect(harness.searchNews).toHaveBeenCalledTimes(1);
    expect(harness.repo.drafts.size).toBe(2);
  });
});

describe('unsupported input', () => {
  it('replies that only text is supported and never calls the model', async () => {
    const harness = createHarness({});
    const response = await harness.post({
      update_id: 9001,
      channel_post: {
        message_id: 42,
        date: 1,
        chat: { id: TEST_CHAT_ID, type: 'channel' },
        voice: { file_id: 'a', file_unique_id: 'b', duration: 4 },
      },
    });

    expect(response.status).toBe(200);
    expect(harness.gemini.requests).toHaveLength(0);
    expect(harness.repo.notes.size).toBe(0);
    expect(harness.lastMessage()!.text).toMatch(/text notes only/i);
    expect(harness.repo.updates.get(9001)!.status).toBe('ignored');
  });

  it('ignores a bot-authored message so the bot cannot answer itself', async () => {
    const harness = createHarness({});
    await harness.post({
      update_id: 9002,
      message: {
        message_id: 43,
        date: 1,
        chat: { id: TEST_CHAT_ID, type: 'private' },
        from: { id: 1, is_bot: true },
        text: 'DRAFT AB12CD',
      },
    });
    expect(harness.telegram.sent).toHaveLength(0);
    expect(harness.repo.updates.get(9002)!.status).toBe('ignored');
  });
});
