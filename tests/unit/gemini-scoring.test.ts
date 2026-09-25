import { describe, it, expect, vi } from 'vitest';
import { scoreNote, noteScoreSchema, SCORE_THRESHOLD, meetsThreshold } from '@/lib/gemini/scoring';
import type { GeminiClient } from '@/lib/gemini/client';
import { STRONG_NOTE, WEAK_NOTE } from '../fixtures/notes';

const fakeGemini = (payload: unknown, capture?: { last?: unknown }): GeminiClient => ({
  model: 'gemini-2.5-flash',
  generateJson: vi.fn(async (request: unknown) => {
    if (capture) capture.last = request;
    const parsed = noteScoreSchema.safeParse(payload);
    if (!parsed.success) throw new Error('fixture does not satisfy the schema');
    return parsed.data as never;
  }),
});

describe('SCORE_THRESHOLD', () => {
  it('is 6, and the boundary is inclusive', () => {
    expect(SCORE_THRESHOLD).toBe(6);
    expect(meetsThreshold(6)).toBe(true);
    expect(meetsThreshold(5)).toBe(false);
    expect(meetsThreshold(0)).toBe(false);
    expect(meetsThreshold(10)).toBe(true);
  });
});

describe('noteScoreSchema', () => {
  it('accepts a well-formed score payload', () => {
    expect(
      noteScoreSchema.safeParse({
        score: 8,
        reason: 'specific and evidenced',
        keywords: ['a', 'b', 'c'],
      }).success,
    ).toBe(true);
  });

  it.each([
    ['a missing score', { reason: 'x', keywords: [] }],
    ['a non-integer score', { score: 7.5, reason: 'x', keywords: [] }],
    ['a score above 10', { score: 11, reason: 'x', keywords: [] }],
    ['a negative score', { score: -1, reason: 'x', keywords: [] }],
    ['a score as a string', { score: '8', reason: 'x', keywords: [] }],
    ['a missing reason', { score: 8, keywords: [] }],
    ['an empty reason', { score: 8, reason: '   ', keywords: [] }],
    ['keywords that are not strings', { score: 8, reason: 'x', keywords: [1, 2] }],
    ['keywords that are not an array', { score: 8, reason: 'x', keywords: 'a,b' }],
  ])('rejects %s', (_label, payload) => {
    expect(noteScoreSchema.safeParse(payload).success).toBe(false);
  });
});

describe('scoreNote', () => {
  it('returns the validated score for a strong note', async () => {
    const gemini = fakeGemini({
      score: 9,
      reason: 'Specific manufacturing observation with a measured pH shift.',
      keywords: ['preservative', 'pH stability', 'certificate of analysis'],
    });
    const result = await scoreNote(gemini, { noteText: STRONG_NOTE });
    expect(result.score).toBe(9);
    expect(result.keywords).toEqual(['preservative', 'ph stability', 'certificate of analysis']);
  });

  it('returns a sub-threshold score for a weak note', async () => {
    const gemini = fakeGemini({
      score: 1,
      reason: 'A personal reminder with no argument.',
      keywords: [],
    });
    const result = await scoreNote(gemini, { noteText: WEAK_NOTE });
    expect(meetsThreshold(result.score)).toBe(false);
    expect(result.keywords).toEqual([]);
  });

  it('normalises keywords: trims, lowercases, de-duplicates and caps at five', async () => {
    const gemini = fakeGemini({
      score: 7,
      reason: 'ok',
      keywords: ['  pH  ', 'PH', 'preservative', 'CoA', 'batch', 'texture', 'emollient'],
    });
    const result = await scoreNote(gemini, { noteText: STRONG_NOTE });
    expect(result.keywords).toEqual(['ph', 'preservative', 'coa', 'batch', 'texture']);
  });

  it('sends the note text and the scoring criteria to the model', async () => {
    const capture: { last?: unknown } = {};
    const gemini = fakeGemini({ score: 7, reason: 'ok', keywords: ['a'] }, capture);
    await scoreNote(gemini, { noteText: STRONG_NOTE });

    const request = capture.last as { prompt: string; systemInstruction?: string; label: string };
    expect(request.label).toBe('score');
    expect(request.prompt).toContain(STRONG_NOTE);
    const criteria = `${request.systemInstruction ?? ''}${request.prompt}`;
    expect(criteria).toMatch(/defensible/i);
    expect(criteria).toMatch(/evidence|mechanism|number/i);
    expect(criteria).toMatch(/novel/i);
    expect(criteria).toMatch(/medical/i);
  });

  it('includes prior decisions so the model can judge novelty', async () => {
    const capture: { last?: unknown } = {};
    const gemini = fakeGemini({ score: 7, reason: 'ok', keywords: ['a'] }, capture);
    await scoreNote(gemini, {
      noteText: STRONG_NOTE,
      priorDecisions: [
        { status: 'approved', excerpt: 'Earlier post about preservative swaps' },
        { status: 'rejected', excerpt: 'A reminder about cartons' },
      ],
    });
    const request = capture.last as { prompt: string };
    expect(request.prompt).toContain('Earlier post about preservative swaps');
    expect(request.prompt).toContain('A reminder about cartons');
  });

  it('omits the prior-decisions block entirely when there is no history', async () => {
    const capture: { last?: unknown } = {};
    const gemini = fakeGemini({ score: 7, reason: 'ok', keywords: ['a'] }, capture);
    await scoreNote(gemini, { noteText: STRONG_NOTE, priorDecisions: [] });
    expect((capture.last as { prompt: string }).prompt).not.toMatch(
      /PREVIOUSLY (APPROVED|REVIEWED)/,
    );
  });
});
