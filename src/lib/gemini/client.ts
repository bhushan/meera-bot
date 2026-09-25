import type { z } from 'zod';
import { AppError } from '../errors';
import type { Logger } from '../logger';
import { withRetry } from '../util/retry';
import { withTimeout } from '../util/timeout';

export interface GenerateTextArgs {
  model: string;
  prompt: string;
  systemInstruction?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** Gemini `responseSchema`, used to constrain decoding to our JSON shape. */
  responseSchema?: Record<string, unknown>;
  signal: AbortSignal;
}

/**
 * Minimal seam over the provider SDK. Production wires this to `@google/genai`;
 * tests supply a scripted function so no test ever calls a paid API.
 */
export type GenerateTextFn = (args: GenerateTextArgs) => Promise<string>;

export interface GenerateJsonRequest<T> {
  /** Short stage name used in logs and timeouts, e.g. `score` or `draft`. */
  label: string;
  prompt: string;
  systemInstruction?: string;
  schema: z.ZodType<T>;
  responseSchema?: Record<string, unknown>;
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export interface GeminiClient {
  readonly model: string;
  generateJson<T>(request: GenerateJsonRequest<T>): Promise<T>;
}

export interface GeminiClientOptions {
  model: string;
  generateText: GenerateTextFn;
  logger: Logger;
  attempts?: number;
  defaultTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Remove ```json fences some models wrap around structured output. */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```$/.exec(trimmed);
  return (fenced ? fenced[1]! : trimmed).trim();
}

const statusOf = (err: unknown): number | undefined => {
  if (typeof err !== 'object' || err === null) return undefined;
  const candidate = err as { status?: unknown; code?: unknown };
  if (typeof candidate.status === 'number') return candidate.status;
  if (typeof candidate.code === 'number') return candidate.code;
  return undefined;
};

/**
 * Map a provider failure onto our error model.
 * 4xx other than 429 means the request is wrong (bad key, bad model name, bad
 * arguments) and retrying it produces the same answer.
 */
export function classifyGeminiError(err: unknown): AppError {
  const status = statusOf(err);
  const message = err instanceof Error ? err.message : String(err);

  if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
    return new AppError({
      kind: status === 401 || status === 403 ? 'authorization' : 'config',
      message: `Gemini rejected the request (HTTP ${status})`,
      retryable: false,
      context: { status },
      cause: err,
    });
  }

  return new AppError({
    kind: 'gemini',
    message: `Gemini call failed${status ? ` (HTTP ${status})` : ''}: ${message.slice(0, 200)}`,
    retryable: true,
    context: { status },
    cause: err,
  });
}

export function createGeminiClient(options: GeminiClientOptions): GeminiClient {
  const { model, generateText, logger, attempts = 3, defaultTimeoutMs = 25_000, sleep } = options;

  return {
    model,

    async generateJson<T>(request: GenerateJsonRequest<T>): Promise<T> {
      const {
        label,
        prompt,
        systemInstruction,
        schema,
        responseSchema,
        temperature,
        maxOutputTokens,
        timeoutMs = defaultTimeoutMs,
      } = request;

      const attempt = async (): Promise<T> => {
        let text: string;
        try {
          text = await withTimeout(
            (signal) =>
              generateText({
                model,
                prompt,
                ...(systemInstruction !== undefined ? { systemInstruction } : {}),
                ...(temperature !== undefined ? { temperature } : {}),
                ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
                ...(responseSchema !== undefined ? { responseSchema } : {}),
                signal,
              }),
            { ms: timeoutMs, label: `gemini.${label}` },
          );
        } catch (err) {
          // Timeouts are already AppErrors and are retryable.
          throw err instanceof AppError ? err : classifyGeminiError(err);
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(stripCodeFences(text));
        } catch {
          throw new AppError({
            kind: 'validation',
            message: `Gemini ${label} returned text that is not JSON`,
            // Re-prompting usually fixes a malformed generation, so allow a retry
            // even though callers must never retry *their own* validation errors.
            retryable: true,
            context: { label, textLength: text.length },
          });
        }

        const result = schema.safeParse(parsed);
        if (!result.success) {
          throw new AppError({
            kind: 'validation',
            message: `Gemini ${label} JSON did not match the expected schema`,
            retryable: true,
            context: {
              label,
              issues: result.error.issues.slice(0, 5).map((issue) => ({
                path: issue.path.join('.'),
                code: issue.code,
              })),
            },
          });
        }
        return result.data;
      };

      return withRetry(attempt, {
        attempts,
        label: `gemini.${label}`,
        ...(sleep ? { sleep } : {}),
        onRetry: (attemptNumber, err, delayMs) =>
          logger.warn('gemini_retry', { label, attempt: attemptNumber, delayMs, err }),
      });
    },
  };
}
