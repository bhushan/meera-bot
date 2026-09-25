import { describe, it, expect, vi } from 'vitest';
import { draftPost, draftModelOutputSchema, sanitiseDraft } from '@/lib/gemini/drafting';
import type { GeminiClient } from '@/lib/gemini/client';
import type { NewsItem } from '@/lib/news/types';
import { STRONG_NOTE } from '../fixtures/notes';

const VOICE_SKILL =
  'Meera writes like a technically trained founder explaining a specific problem.';

const NEWS: NewsItem = {
  headline: 'Preservative supply shifts hit small skincare brands',
  publication: 'Cosmetics Business',
  publishedAt: '2026-09-20T09:00:00.000Z',
  url: 'https://news.example/preservative-supply',
  description: 'Reformulations are rippling through contract manufacturing.',
};

const BODY =
  'Batch fourteen came back with a measured pH shift of about 0.4 units. I am not claiming the batch was unsafe. I am claiming the finished product moved outside the range the emollient blend was designed for, and that a same-formula reorder is not always the same formula. Ask your manufacturer for the certificate of analysis for every batch and compare it against a baseline.';

const capturing = (payload: Record<string, unknown>) => {
  const calls: { prompt: string; systemInstruction?: string; label: string }[] = [];
  const gemini: GeminiClient = {
    model: 'gemini-2.5-flash',
    generateJson: vi.fn(async (request: unknown) => {
      calls.push(request as (typeof calls)[number]);
      return payload as never;
    }),
  };
  return { gemini, calls };
};

describe('draftModelOutputSchema', () => {
  it('accepts a well-formed draft payload', () => {
    expect(
      draftModelOutputSchema.safeParse({ draft: BODY, used_news: false, news_url: null }).success,
    ).toBe(true);
  });

  it.each([
    ['a missing draft', { used_news: false }],
    ['an empty draft', { draft: '   ', used_news: false }],
    ['a draft far too short to post', { draft: 'Too short.', used_news: false }],
    ['a non-boolean used_news', { draft: BODY, used_news: 'yes' }],
    ['a missing used_news', { draft: BODY }],
  ])('rejects %s', (_label, payload) => {
    expect(draftModelOutputSchema.safeParse(payload).success).toBe(false);
  });
});

describe('sanitiseDraft', () => {
  it('removes emojis wherever they appear', () => {
    const out = sanitiseDraft('Batch fourteen 🎉 shifted pH ✨.', { allowHashtags: false });
    expect(out).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    expect(out).toContain('Batch fourteen');
    expect(out).toContain('shifted pH');
  });

  it('strips a trailing hashtag block when the note did not use hashtags', () => {
    const out = sanitiseDraft(`${BODY}\n\n#skincare #formulation #founder`, {
      allowHashtags: false,
    });
    expect(out).not.toContain('#skincare');
    expect(out.trim().endsWith('baseline.')).toBe(true);
  });

  it('strips inline hashtags but keeps the surrounding sentence', () => {
    const out = sanitiseDraft('Compare the #CoA against a baseline.', { allowHashtags: false });
    expect(out).toBe('Compare the CoA against a baseline.');
  });

  it('keeps hashtags when the original note explicitly used them', () => {
    const out = sanitiseDraft(`${BODY}\n\n#skincare`, { allowHashtags: true });
    expect(out).toContain('#skincare');
  });

  it('collapses runs of blank lines without destroying paragraphs', () => {
    const out = sanitiseDraft('Para one.\n\n\n\n\nPara two.', { allowHashtags: false });
    expect(out).toBe('Para one.\n\nPara two.');
  });
});

describe('draftPost', () => {
  it('sends the voice skill as the system instruction on every drafting call', async () => {
    const { gemini, calls } = capturing({ draft: BODY, used_news: false, news_url: null });
    await draftPost(gemini, { noteText: STRONG_NOTE, voiceSkill: VOICE_SKILL, newsItem: null });
    await draftPost(gemini, {
      noteText: 'another note entirely',
      voiceSkill: VOICE_SKILL,
      newsItem: NEWS,
    });

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.label).toBe('draft');
      expect(call.systemInstruction ?? '').toContain(VOICE_SKILL);
    }
  });

  it('sends the note text and refuses to let the model invent facts', async () => {
    const { gemini, calls } = capturing({ draft: BODY, used_news: false, news_url: null });
    await draftPost(gemini, { noteText: STRONG_NOTE, voiceSkill: VOICE_SKILL, newsItem: null });

    const call = calls[0]!;
    expect(call.prompt).toContain(STRONG_NOTE);
    const instructions = `${call.systemInstruction ?? ''}${call.prompt}`;
    expect(instructions).toMatch(/do not invent|never invent|must not invent/i);
    expect(instructions).toMatch(/uncertain/i);
    expect(instructions).toMatch(/no emoji/i);
  });

  it('passes only retrieved news metadata, and says the body was not read', async () => {
    const { gemini, calls } = capturing({ draft: BODY, used_news: true, news_url: NEWS.url });
    await draftPost(gemini, { noteText: STRONG_NOTE, voiceSkill: VOICE_SKILL, newsItem: NEWS });

    const call = calls[0]!;
    expect(call.prompt).toContain(NEWS.headline);
    expect(call.prompt).toContain(NEWS.publication);
    expect(call.prompt).toContain(NEWS.url);
    expect(call.prompt).toMatch(/have not (read|retrieved) the article/i);
  });

  it('states that no news is available when the search found nothing', async () => {
    const { gemini, calls } = capturing({ draft: BODY, used_news: false, news_url: null });
    await draftPost(gemini, { noteText: STRONG_NOTE, voiceSkill: VOICE_SKILL, newsItem: null });
    expect(calls[0]!.prompt).toMatch(/no news/i);
  });

  it('reports usedNews when the model used the supplied item', async () => {
    const { gemini } = capturing({ draft: BODY, used_news: true, news_url: NEWS.url });
    const result = await draftPost(gemini, {
      noteText: STRONG_NOTE,
      voiceSkill: VOICE_SKILL,
      newsItem: NEWS,
    });
    expect(result.usedNews).toBe(true);
    expect(result.newsItem).toEqual(NEWS);
  });

  it('forces usedNews to false when no news item was supplied, even if the model claims otherwise', async () => {
    const { gemini } = capturing({
      draft: BODY,
      used_news: true,
      news_url: 'https://made.up/story',
    });
    const result = await draftPost(gemini, {
      noteText: STRONG_NOTE,
      voiceSkill: VOICE_SKILL,
      newsItem: null,
    });
    expect(result.usedNews).toBe(false);
    expect(result.newsItem).toBeNull();
  });

  it('forces usedNews to false when the model cites a URL we never supplied', async () => {
    const { gemini } = capturing({
      draft: BODY,
      used_news: true,
      news_url: 'https://made.up/story',
    });
    const result = await draftPost(gemini, {
      noteText: STRONG_NOTE,
      voiceSkill: VOICE_SKILL,
      newsItem: NEWS,
    });
    expect(result.usedNews).toBe(false);
    expect(result.newsItem).toBeNull();
  });

  it('keeps usedNews false when the model declined the news angle', async () => {
    const { gemini } = capturing({ draft: BODY, used_news: false, news_url: null });
    const result = await draftPost(gemini, {
      noteText: STRONG_NOTE,
      voiceSkill: VOICE_SKILL,
      newsItem: NEWS,
    });
    expect(result.usedNews).toBe(false);
    expect(result.newsItem).toBeNull();
  });

  it('sanitises the returned body', async () => {
    const { gemini } = capturing({
      draft: `${BODY} 🎯\n\n#skincare #ingredients`,
      used_news: false,
      news_url: null,
    });
    const result = await draftPost(gemini, {
      noteText: STRONG_NOTE,
      voiceSkill: VOICE_SKILL,
      newsItem: null,
    });
    expect(result.body).not.toContain('🎯');
    expect(result.body).not.toContain('#skincare');
  });

  it('preserves hashtags when the source note itself used them', async () => {
    const { gemini } = capturing({
      draft: `${BODY}\n\n#CoA`,
      used_news: false,
      news_url: null,
    });
    const result = await draftPost(gemini, {
      noteText: 'Suppliers change blends quietly. #CoA checks matter.',
      voiceSkill: VOICE_SKILL,
      newsItem: null,
    });
    expect(result.body).toContain('#CoA');
  });
});
