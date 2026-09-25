import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppError } from '@/lib/errors';

const generateContent = vi.fn();

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent };
  },
}));

const { createGoogleGenAiGenerateText } = await import('@/lib/gemini/provider');

const call = () =>
  createGoogleGenAiGenerateText('test-key')({
    model: 'gemini-test',
    prompt: 'score this',
    maxOutputTokens: 512,
    signal: new AbortController().signal,
  });

beforeEach(() => generateContent.mockReset());

describe('createGoogleGenAiGenerateText', () => {
  it('returns the text of a completed generation', async () => {
    generateContent.mockResolvedValue({
      text: '{"score":8}',
      candidates: [{ finishReason: 'STOP' }],
    });
    await expect(call()).resolves.toBe('{"score":8}');
  });

  it('reports a truncated generation as such, not as malformed output', async () => {
    // The token budget covers thinking and visible output together, so a budget
    // sized for the JSON alone gets eaten by thinking and the object is cut off
    // mid-write. Downstream this used to surface as "not JSON", which named the
    // symptom and hid the cause.
    generateContent.mockResolvedValue({
      text: '{\n  "score": 6,',
      candidates: [{ finishReason: 'MAX_TOKENS' }],
      usageMetadata: { thoughtsTokenCount: 488, candidatesTokenCount: 9 },
    });

    const err = (await call().catch((e: unknown) => e)) as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.message).toMatch(/token limit/i);
    expect(err.message).not.toMatch(/not JSON/i);
    expect(err.context).toMatchObject({
      finishReason: 'MAX_TOKENS',
      maxOutputTokens: 512,
      thoughtsTokenCount: 488,
    });
  });

  it('reports truncation even when nothing at all was emitted', async () => {
    generateContent.mockResolvedValue({
      text: '',
      candidates: [{ finishReason: 'MAX_TOKENS' }],
      usageMetadata: { thoughtsTokenCount: 512, candidatesTokenCount: 0 },
    });
    await expect(call()).rejects.toThrow(/token limit/i);
  });

  it('reports an empty response that was not truncated', async () => {
    generateContent.mockResolvedValue({ text: '   ', candidates: [{ finishReason: 'STOP' }] });
    await expect(call()).rejects.toThrow(/empty response/i);
  });

  it('surfaces a safety block reason without echoing the prompt', async () => {
    generateContent.mockResolvedValue({
      text: '',
      candidates: [{ finishReason: 'SAFETY' }],
      promptFeedback: { blockReason: 'SAFETY' },
    });

    const err = (await call().catch((e: unknown) => e)) as AppError;
    expect(err.context).toMatchObject({ finishReason: 'SAFETY', promptFeedback: 'SAFETY' });
    expect(JSON.stringify(err.context)).not.toContain('score this');
  });

  it('passes the caller budget through to the model', async () => {
    generateContent.mockResolvedValue({ text: '{}', candidates: [{ finishReason: 'STOP' }] });
    await call();
    expect(generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ maxOutputTokens: 512 }),
      }),
    );
  });
});
