import type { Repository } from '../db/repository';
import type { GeminiClient } from '../gemini/client';
import type { Logger } from '../logger';
import type { TelegramClient } from '../telegram/client';
import type { NewsSearchResult, SearchGoogleNewsOptions } from '../news/rss';

export type NewsSearchFn = (options: SearchGoogleNewsOptions) => Promise<NewsSearchResult>;

export interface PipelineConfig {
  requestId: string;
  /** How long an identical news query is served from `news_cache`. */
  newsCacheTtlSeconds: number;
  newsTimeoutMs: number;
  /** How many past decisions are shown to the scorer as novelty context. */
  recentDecisionsLimit: number;
}

export const DEFAULT_PIPELINE_CONFIG: Omit<PipelineConfig, 'requestId'> = {
  newsCacheTtlSeconds: 6 * 60 * 60,
  newsTimeoutMs: 6000,
  recentDecisionsLimit: 12,
};

export interface PipelineDeps {
  repo: Repository;
  gemini: GeminiClient;
  telegram: TelegramClient;
  logger: Logger;
  config: PipelineConfig;
  searchNews: NewsSearchFn;
  now: () => Date;
}
