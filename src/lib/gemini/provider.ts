import { GoogleGenAI } from '@google/genai';
import { AppError } from '../errors';
import type { GenerateTextFn } from './client';

/**
 * Real `@google/genai` adapter.
 *
 * Kept behind the {@link GenerateTextFn} seam so route handlers, the pipeline and
 * every test stay free of provider types. One `GoogleGenAI` instance is reused
 * across invocations of a warm serverless container.
 */
export function createGoogleGenAiGenerateText(apiKey: string): GenerateTextFn {
  const ai = new GoogleGenAI({ apiKey });

  return async ({
    model,
    prompt,
    systemInstruction,
    temperature,
    maxOutputTokens,
    responseSchema,
    signal,
  }) => {
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        abortSignal: signal,
        responseMimeType: 'application/json',
        ...(responseSchema ? { responseJsonSchema: responseSchema } : {}),
        ...(systemInstruction ? { systemInstruction } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      },
    });

    const finishReason = response.candidates?.[0]?.finishReason;

    // `maxOutputTokens` is a budget for reasoning tokens and visible output
    // together, not for the visible output alone. A budget sized for the JSON
    // gets spent on reasoning and the object is cut off part-written, which
    // reaches the caller as unparseable text. Name the real cause here.
    if (finishReason === 'MAX_TOKENS') {
      throw new AppError({
        kind: 'gemini',
        message: 'Gemini stopped at the output token limit before finishing its response',
        retryable: true,
        context: {
          finishReason,
          maxOutputTokens,
          thoughtsTokenCount: response.usageMetadata?.thoughtsTokenCount,
          candidatesTokenCount: response.usageMetadata?.candidatesTokenCount,
        },
      });
    }

    const text = response.text;
    if (typeof text !== 'string' || text.trim().length === 0) {
      // Usually a safety block. Surface the finish reason (never the prompt)
      // so the cause is visible in logs.
      throw new AppError({
        kind: 'gemini',
        message: 'Gemini returned an empty response',
        retryable: true,
        context: { finishReason, promptFeedback: response.promptFeedback?.blockReason },
      });
    }
    return text;
  };
}
