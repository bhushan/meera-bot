import { vi } from 'vitest';
import { FakeRepository } from './fake-repository';
import { createLogger, type LogFields } from '@/lib/logger';
import type { GeminiClient, GenerateJsonRequest } from '@/lib/gemini/client';
import type {
  AnswerCallbackQueryInput,
  EditReplyMarkupInput,
  SendMessageInput,
  TelegramClient,
} from '@/lib/telegram/client';
import type { NewsSearchResult } from '@/lib/news/rss';
import type { NewsItem } from '@/lib/news/types';
import type { PipelineDeps } from '@/lib/pipeline/deps';
import { processNote } from '@/lib/pipeline/process-note';
import { handleReview } from '@/lib/pipeline/review';
import { handleTelegramWebhook, type WebhookDeps } from '@/lib/webhook/handle';
import type { ParsedUpdate } from '@/lib/telegram/parse';
import { createConcurrencyGuard } from '@/lib/util/concurrency';

export const TEST_SECRET = 'test_webhook_secret_0123456789';
export const TEST_CHAT_ID = -1001234567890;
export const TEST_VOICE_SKILL =
  'Meera writes like a technically trained founder explaining a specific problem she has personally observed.';

export interface SentMessage extends SendMessageInput {
  messageId: number;
}

export interface FakeTelegram extends TelegramClient {
  sent: SentMessage[];
  answered: AnswerCallbackQueryInput[];
  edited: EditReplyMarkupInput[];
  failNextSend?: Error;
}

export function createFakeTelegram(): FakeTelegram {
  let nextMessageId = 1000;
  const sent: SentMessage[] = [];
  const answered: AnswerCallbackQueryInput[] = [];
  const edited: EditReplyMarkupInput[] = [];

  const client: FakeTelegram = {
    sent,
    answered,
    edited,
    async sendMessage(input) {
      if (client.failNextSend) {
        const err = client.failNextSend;
        delete client.failNextSend;
        throw err;
      }
      nextMessageId += 1;
      sent.push({ ...input, messageId: nextMessageId });
      return { messageId: nextMessageId };
    },
    async answerCallbackQuery(input) {
      answered.push(input);
    },
    async editMessageReplyMarkup(input) {
      edited.push(input);
    },
  };
  return client;
}

export interface GeminiScript {
  score?: unknown | ((prompt: string) => unknown);
  draft?: unknown | ((prompt: string) => unknown);
  relevance?: unknown | ((prompt: string) => unknown);
}

export interface ScriptedGemini extends GeminiClient {
  requests: GenerateJsonRequest<unknown>[];
  labels: string[];
  failures: Map<string, Error>;
}

export function createScriptedGemini(script: GeminiScript): ScriptedGemini {
  const requests: GenerateJsonRequest<unknown>[] = [];
  const failures = new Map<string, Error>();

  const resolve = (value: unknown, prompt: string) =>
    typeof value === 'function' ? (value as (p: string) => unknown)(prompt) : value;

  return {
    model: 'gemini-2.5-flash',
    requests,
    failures,
    get labels() {
      return requests.map((request) => request.label);
    },
    async generateJson<T>(request: GenerateJsonRequest<T>): Promise<T> {
      requests.push(request as GenerateJsonRequest<unknown>);
      const failure = failures.get(request.label);
      if (failure) throw failure;

      const payload =
        request.label === 'score'
          ? resolve(script.score, request.prompt)
          : request.label === 'draft'
            ? resolve(script.draft, request.prompt)
            : resolve(script.relevance, request.prompt);

      if (payload === undefined) {
        throw new Error(`No scripted Gemini response for label "${request.label}"`);
      }
      return request.schema.parse(payload);
    },
  };
}

export interface HarnessOptions {
  gemini?: GeminiScript;
  news?: NewsSearchResult | NewsItem[];
  seedVoiceSkill?: string | null;
  rateLimitMaxEvents?: number;
  concurrencyLimit?: number;
  captureLogs?: boolean;
}

export function createHarness(options: HarnessOptions = {}) {
  const repo = new FakeRepository(
    options.seedVoiceSkill === null
      ? {}
      : { seedVoiceSkill: options.seedVoiceSkill ?? TEST_VOICE_SKILL },
  );
  const telegram = createFakeTelegram();
  const gemini = createScriptedGemini(options.gemini ?? {});
  const logLines: LogFields[] = [];
  const logger = createLogger({ service: 'test' }, (line) => {
    if (options.captureLogs) logLines.push(JSON.parse(line) as LogFields);
  });

  const newsResult: NewsSearchResult = Array.isArray(options.news)
    ? { items: options.news, outcome: options.news.length > 0 ? 'ok' : 'empty', query: 'q' }
    : (options.news ?? { items: [], outcome: 'empty', query: 'q' });

  const searchNews = vi.fn(async () => newsResult);

  const pipelineDeps: PipelineDeps = {
    repo,
    gemini,
    telegram,
    logger,
    config: {
      requestId: 'req_test',
      newsCacheTtlSeconds: 3600,
      newsTimeoutMs: 1000,
      recentDecisionsLimit: 5,
    },
    searchNews,
    now: () => new Date('2026-09-25T12:00:00.000Z'),
  };

  const pending: Promise<void>[] = [];

  const webhookDeps: WebhookDeps = {
    repo,
    telegram,
    logger,
    config: {
      allowedChatId: TEST_CHAT_ID,
      webhookSecret: TEST_SECRET,
      rateLimitWindowSeconds: 60,
      rateLimitMaxEvents: options.rateLimitMaxEvents ?? 20,
    },
    guard: createConcurrencyGuard(options.concurrencyLimit ?? 4),
    schedule: (work) => {
      pending.push(work());
    },
    dispatch: async (parsed: ParsedUpdate) => {
      if (parsed.kind === 'note') {
        await processNote(pipelineDeps, parsed);
        return;
      }
      if (parsed.kind === 'review_command' || parsed.kind === 'review_callback') {
        await handleReview(pipelineDeps, parsed);
      }
    },
  };

  /** Await every job handed to the scheduler, including jobs scheduled by jobs. */
  const settle = async () => {
    while (pending.length > 0) {
      const batch = pending.splice(0, pending.length);
      await Promise.all(batch);
    }
  };

  const post = async (
    update: unknown,
    overrides: { secret?: string | null; rawBody?: string } = {},
  ) => {
    const response = await handleTelegramWebhook(webhookDeps, {
      rawBody: overrides.rawBody ?? JSON.stringify(update),
      secretHeader: overrides.secret === undefined ? TEST_SECRET : overrides.secret,
    });
    await settle();
    return response;
  };

  return {
    repo,
    telegram,
    gemini,
    logger,
    logLines,
    searchNews,
    pipelineDeps,
    webhookDeps,
    post,
    settle,
    lastMessage: () => telegram.sent[telegram.sent.length - 1],
    onlyDraft: () => [...repo.drafts.values()][0],
  };
}
