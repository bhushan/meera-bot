import { describe, it, expect, vi } from 'vitest';
import { selectRelevantNews, newsRelevanceSchema } from '@/lib/news/relevance';
import type { GeminiClient } from '@/lib/gemini/client';
import type { NewsItem } from '@/lib/news/types';
import { STRONG_NOTE } from '../fixtures/notes';

const candidate = (n: number): NewsItem => ({
  headline: `Headline ${n}`,
  publication: `Publication ${n}`,
  publishedAt: '2026-09-22T09:00:00.000Z',
  url: `https://news.example/${n}`,
  description: `Description ${n}`,
});

const gemini = (payload: unknown, capture?: { last?: unknown }): GeminiClient => ({
  model: 'gemini-2.5-flash',
  generateJson: vi.fn(async (request: unknown) => {
    if (capture) capture.last = request;
    return payload as never;
  }),
});

describe('newsRelevanceSchema', () => {
  it('accepts a selection and a rejection', () => {
    expect(newsRelevanceSchema.safeParse({ relevant: true, index: 0, reason: 'x' }).success).toBe(
      true,
    );
    expect(
      newsRelevanceSchema.safeParse({ relevant: false, index: null, reason: 'x' }).success,
    ).toBe(true);
  });

  it('rejects a missing relevant flag', () => {
    expect(newsRelevanceSchema.safeParse({ index: 0 }).success).toBe(false);
  });
});

describe('selectRelevantNews', () => {
  const candidates = [candidate(0), candidate(1), candidate(2)];

  it('returns the chosen candidate', async () => {
    const result = await selectRelevantNews(
      gemini({ relevant: true, index: 1, reason: 'on point' }),
      {
        noteText: STRONG_NOTE,
        candidates,
      },
    );
    expect(result.item).toEqual(candidates[1]);
    expect(result.reason).toBe('on point');
  });

  it('returns null when the model says nothing is relevant', async () => {
    const result = await selectRelevantNews(
      gemini({ relevant: false, index: null, reason: 'unrelated' }),
      { noteText: STRONG_NOTE, candidates },
    );
    expect(result.item).toBeNull();
  });

  it('returns null without calling the model when there are no candidates', async () => {
    const client = gemini({ relevant: true, index: 0 });
    const result = await selectRelevantNews(client, { noteText: STRONG_NOTE, candidates: [] });
    expect(result.item).toBeNull();
    expect(client.generateJson).not.toHaveBeenCalled();
  });

  it('returns null when the model picks an index outside the candidate list', async () => {
    const result = await selectRelevantNews(gemini({ relevant: true, index: 9, reason: 'x' }), {
      noteText: STRONG_NOTE,
      candidates,
    });
    expect(result.item).toBeNull();
  });

  it('returns null when the model claims relevance but supplies no index', async () => {
    const result = await selectRelevantNews(gemini({ relevant: true, index: null, reason: 'x' }), {
      noteText: STRONG_NOTE,
      candidates,
    });
    expect(result.item).toBeNull();
  });

  it('degrades to no-news when the relevance call itself fails', async () => {
    const failing: GeminiClient = {
      model: 'gemini-2.5-flash',
      generateJson: vi.fn(async () => {
        throw new Error('model unavailable');
      }),
    };
    const result = await selectRelevantNews(failing, { noteText: STRONG_NOTE, candidates });
    expect(result.item).toBeNull();
    expect(result.reason).toMatch(/unavailable|failed/i);
  });

  it('shows the model every candidate with its index, and permits refusal', async () => {
    const capture: { last?: unknown } = {};
    await selectRelevantNews(gemini({ relevant: false, index: null, reason: 'x' }, capture), {
      noteText: STRONG_NOTE,
      candidates,
    });
    const prompt = (capture.last as { prompt: string }).prompt;
    expect(prompt).toContain('[0]');
    expect(prompt).toContain('[2]');
    expect(prompt).toContain('Headline 2');
    expect(prompt).toContain(STRONG_NOTE);
    expect(prompt).toMatch(/none|reject|ignore/i);
  });
});
