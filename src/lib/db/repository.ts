import type { PriorDecision } from '../gemini/scoring';
import type { NewsItem } from '../news/types';
import type {
  DraftRow,
  NoteRow,
  NoteStatus,
  RateLimitResult,
  ReviewOutcome,
  ReviewSource,
  UpdateStatus,
  VoiceSkillRow,
} from './types';

export interface ClaimUpdateInput {
  updateId: number;
  chatId: number | null;
  messageId: number | null;
  updateType: string;
}

export interface StoreNoteInput {
  updateId: number;
  chatId: number;
  messageId: number;
  rawText: string;
  receivedAt: string;
}

export interface CreateDraftInput {
  noteId: string;
  shortId: string;
  voiceSkillId: string;
  body: string;
  geminiModel: string;
  usedNews: boolean;
  newsItem: NewsItem | null;
  uncertaintyNote: string | null;
}

export interface RecordReviewInput {
  shortId: string;
  decision: 'approved' | 'rejected';
  chatId: number;
  userId: number | null;
  username: string | null;
  updateId: number;
  source: ReviewSource;
}

/**
 * Everything the pipeline needs from persistence.
 *
 * Defined as an interface so the integration tests can run the real pipeline
 * against an in-memory implementation with no Supabase client in sight.
 */
export interface Repository {
  /** Returns true only for the first caller for a given Telegram update id. */
  claimUpdate(input: ClaimUpdateInput): Promise<boolean>;
  setUpdateStatus(updateId: number, status: UpdateStatus, failureReason?: string): Promise<void>;

  storeNote(input: StoreNoteInput): Promise<NoteRow>;
  setNoteScore(
    noteId: string,
    score: { score: number; reason: string; keywords: string[]; status: NoteStatus },
  ): Promise<void>;
  setNoteStatus(noteId: string, status: NoteStatus, failureReason?: string | null): Promise<void>;

  getActiveVoiceSkill(): Promise<VoiceSkillRow | null>;
  /** Insert (if new) and activate a voice skill version. Idempotent by content hash. */
  activateVoiceSkill(content: string, contentHash: string): Promise<VoiceSkillRow>;

  createDraft(input: CreateDraftInput): Promise<DraftRow>;
  setDraftTelegramMessageId(draftId: string, telegramMessageId: number): Promise<void>;
  getDraftByShortId(shortId: string): Promise<DraftRow | null>;
  recordReview(input: RecordReviewInput): Promise<ReviewOutcome>;

  /** Recent approved/rejected note excerpts, used as novelty context for scoring. */
  getRecentDecisions(limit: number): Promise<PriorDecision[]>;

  getCachedNews(queryHash: string): Promise<NewsItem[] | null>;
  putCachedNews(
    queryHash: string,
    query: string,
    items: NewsItem[],
    ttlSeconds: number,
  ): Promise<void>;

  checkRateLimit(
    chatId: number,
    windowSeconds: number,
    maxEvents: number,
  ): Promise<RateLimitResult>;

  /** Cheap liveness probe for /api/health. */
  ping(): Promise<void>;
}
