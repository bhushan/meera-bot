import 'server-only';
import { getEnv, type Env } from './env';
import { createSupabaseClient, createSupabaseRepository } from './db/supabase-repository';
import type { Repository } from './db/repository';
import { createGeminiClient, type GeminiClient } from './gemini/client';
import { createGoogleGenAiGenerateText } from './gemini/provider';
import { createTelegramClient, type TelegramClient } from './telegram/client';
import { createConcurrencyGuard, type ConcurrencyGuard } from './util/concurrency';
import { rootLogger, type Logger } from './logger';
import { searchGoogleNews } from './news/rss';
import type { NewsSearchFn } from './pipeline/deps';

/**
 * Per-container composition root.
 *
 * Everything here is built once per warm serverless container and shared across
 * invocations. `server-only` makes it a build error to import this from a client
 * component, which is the guard that keeps the service role key off the browser.
 */
export interface Runtime {
  env: Env;
  repo: Repository;
  gemini: GeminiClient;
  telegram: TelegramClient;
  guard: ConcurrencyGuard;
  searchNews: NewsSearchFn;
  logger: Logger;
}

/** Concurrent pipelines per container. Vercel's per-instance memory is the real ceiling. */
const MAX_CONCURRENT_PIPELINES = 4;

let cached: Runtime | null = null;

export function getRuntime(): Runtime {
  if (cached) return cached;

  // Throws a ConfigValidationError listing offending keys (never their values).
  const env = getEnv();
  const logger = rootLogger;

  cached = {
    env,
    repo: createSupabaseRepository(
      createSupabaseClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY),
    ),
    gemini: createGeminiClient({
      model: env.GEMINI_MODEL,
      generateText: createGoogleGenAiGenerateText(env.GEMINI_API_KEY),
      logger,
    }),
    telegram: createTelegramClient({ token: env.TELEGRAM_BOT_TOKEN, logger }),
    guard: createConcurrencyGuard(MAX_CONCURRENT_PIPELINES),
    searchNews: searchGoogleNews,
    logger,
  };
  return cached;
}

/** Test-only: drop the memoised runtime. */
export function resetRuntime(): void {
  cached = null;
}
