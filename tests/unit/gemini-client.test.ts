import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createGeminiClient, classifyGeminiError, stripCodeFences } from '@/lib/gemini/client';
import { createLogger } from '@/lib/logger';
import { AppError } from '@/lib/errors';

const silent = createLogger({}, () => {});
const schema = z.object({ ok: z.boolean() });

const build = (generateText: ReturnType<typeof vi.fn>) =>
  createGeminiClient({
    model: 'gemini-2.5-flash',
    generateText: generateText as never,
    logger: silent,
    sleep: async () => {},
  });

describe('stripCodeFences', () => {
  it('unwraps fenced JSON that some models emit despite responseMimeType', () => {
    expect(stripCodeFences('```json\n{"ok":true}\n```')).toBe('{"ok":true}');
    expect(stripCodeFences('```\n{"ok":true}\n```')).toBe('{"ok":true}');
    expect(stripCodeFences('{"ok":true}')).toBe('{"ok":true}');
    expect(stripCodeFences('  \n{"ok":true}\n  ')).toBe('{"ok":true}');
  });
});

describe('classifyGeminiError', () => {
  it('marks auth and bad-request failures as non-retryable', () => {
    for (const status of [400, 401, 403, 404]) {
      expect(classifyGeminiError({ status }).retryable).toBe(false);
    }
  });

  it('marks rate limits and server failures as retryable', () => {
    for (const status of [429, 500, 502, 503, 504]) {
      expect(classifyGeminiError({ status }).retryable).toBe(true);
    }
  });

  it('treats unknown transport failures as retryable', () => {
    expect(classifyGeminiError(new Error('socket hang up')).retryable).toBe(true);
  });
});

describe('GeminiClient.generateJson', () => {
  it('parses, validates and returns the model payload', async () => {
    const generateText = vi.fn(async () => '{"ok":true}');
    await expect(
      build(generateText).generateJson({ label: 'score', prompt: 'p', schema }),
    ).resolves.toEqual({ ok: true });
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it('passes the model, system instruction and response schema through', async () => {
    const generateText = vi.fn(async () => '{"ok":true}');
    await build(generateText).generateJson({
      label: 'draft',
      prompt: 'the note',
      systemInstruction: 'the voice skill',
      schema,
      responseSchema: { type: 'object' },
      temperature: 0.4,
    });
    const [args] = generateText.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(args).toMatchObject({
      model: 'gemini-2.5-flash',
      prompt: 'the note',
      systemInstruction: 'the voice skill',
      responseSchema: { type: 'object' },
      temperature: 0.4,
    });
  });

  it('retries transient failures and succeeds on a later attempt', async () => {
    const generateText = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('overloaded'), { status: 503 }))
      .mockRejectedValueOnce(Object.assign(new Error('rate limited'), { status: 429 }))
      .mockResolvedValueOnce('{"ok":true}');

    await expect(
      build(generateText).generateJson({ label: 'score', prompt: 'p', schema }),
    ).resolves.toEqual({ ok: true });
    expect(generateText).toHaveBeenCalledTimes(3);
  });

  it('gives up after exactly three attempts', async () => {
    const generateText = vi.fn(async () => {
      throw Object.assign(new Error('overloaded'), { status: 503 });
    });
    await expect(
      build(generateText).generateJson({ label: 'score', prompt: 'p', schema }),
    ).rejects.toMatchObject({ kind: 'gemini' });
    expect(generateText).toHaveBeenCalledTimes(3);
  });

  it('does not retry an invalid API key', async () => {
    const generateText = vi.fn(async () => {
      throw Object.assign(new Error('API key not valid'), { status: 401 });
    });
    await expect(
      build(generateText).generateJson({ label: 'score', prompt: 'p', schema }),
    ).rejects.toThrow(AppError);
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it('re-prompts when the model returns unparseable text, then fails as a validation error', async () => {
    const generateText = vi.fn(async () => 'I cannot answer that.');
    await expect(
      build(generateText).generateJson({ label: 'score', prompt: 'p', schema }),
    ).rejects.toMatchObject({ kind: 'validation' });
    expect(generateText).toHaveBeenCalledTimes(3);
  });

  it('re-prompts when the JSON parses but fails the Zod schema', async () => {
    const generateText = vi
      .fn()
      .mockResolvedValueOnce('{"ok":"yes"}')
      .mockResolvedValueOnce('{"ok":true}');
    await expect(
      build(generateText).generateJson({ label: 'score', prompt: 'p', schema }),
    ).resolves.toEqual({ ok: true });
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it('never includes the prompt or API key in the surfaced error', async () => {
    const generateText = vi.fn(async () => {
      throw Object.assign(new Error('boom AIzaSyLEAKED'), { status: 503 });
    });
    try {
      await build(generateText).generateJson({
        label: 'score',
        prompt: 'secret note text',
        schema,
      });
      throw new Error('expected failure');
    } catch (err) {
      const dumped = JSON.stringify({
        m: (err as Error).message,
        c: (err as AppError).context,
      });
      expect(dumped).not.toContain('secret note text');
    }
  });
});
