import { randomUUID } from 'node:crypto';
import type {
  ClaimUpdateInput,
  CreateDraftInput,
  RecordReviewInput,
  Repository,
  StoreNoteInput,
} from '@/lib/db/repository';
import type {
  DraftRow,
  DraftStatus,
  NoteRow,
  NoteStatus,
  RateLimitResult,
  ReviewOutcome,
  UpdateStatus,
  VoiceSkillRow,
} from '@/lib/db/types';
import type { PriorDecision } from '@/lib/gemini/scoring';
import type { NewsItem } from '@/lib/news/types';

interface UpdateRow {
  update_id: number;
  chat_id: number | null;
  message_id: number | null;
  update_type: string;
  status: UpdateStatus;
  failure_reason: string | null;
}

interface ReviewRow {
  draft_id: string;
  decision: 'approved' | 'rejected';
  actor_chat_id: number;
  actor_user_id: number | null;
  actor_username: string | null;
  telegram_update_id: number;
  source: 'callback' | 'command';
  applied: boolean;
}

/**
 * In-memory Repository that reproduces the constraints the SQL migration enforces:
 * unique telegram update ids, one note per (chat_id, message_id), a review that
 * only moves a `pending` draft, and a unique (draft_id, telegram_update_id) audit row.
 *
 * Integration tests run the real pipeline against this, so no test touches Supabase.
 */
export class FakeRepository implements Repository {
  readonly updates = new Map<number, UpdateRow>();
  readonly notes = new Map<string, NoteRow>();
  readonly drafts = new Map<string, DraftRow>();
  readonly reviews: ReviewRow[] = [];
  readonly voiceSkills: VoiceSkillRow[] = [];
  readonly newsCache = new Map<string, { items: NewsItem[]; expiresAt: number; query: string }>();
  readonly rateLimitEvents: { chatId: number; at: number }[] = [];

  /** Per-method failure injection for error-path tests. */
  failures = new Map<keyof Repository, Error>();
  calls: string[] = [];

  constructor(options: { seedVoiceSkill?: string } = {}) {
    if (options.seedVoiceSkill) {
      this.voiceSkills.push({
        id: randomUUID(),
        version: 1,
        content_hash: 'seed-hash',
        content: options.seedVoiceSkill,
        is_active: true,
      });
    }
  }

  failOn(method: keyof Repository, error: Error): void {
    this.failures.set(method, error);
  }

  private guard(method: keyof Repository): void {
    this.calls.push(method);
    const failure = this.failures.get(method);
    if (failure) throw failure;
  }

  async claimUpdate(input: ClaimUpdateInput): Promise<boolean> {
    this.guard('claimUpdate');
    if (this.updates.has(input.updateId)) return false;
    this.updates.set(input.updateId, {
      update_id: input.updateId,
      chat_id: input.chatId,
      message_id: input.messageId,
      update_type: input.updateType,
      status: 'processing',
      failure_reason: null,
    });
    return true;
  }

  async setUpdateStatus(updateId: number, status: UpdateStatus, failureReason?: string) {
    this.guard('setUpdateStatus');
    const row = this.updates.get(updateId);
    if (row) {
      row.status = status;
      row.failure_reason = failureReason ?? null;
    }
  }

  async storeNote(input: StoreNoteInput): Promise<NoteRow> {
    this.guard('storeNote');
    const existing = [...this.notes.values()].find(
      (note) => note.chat_id === input.chatId && note.message_id === input.messageId,
    );
    if (existing) return existing;

    const row: NoteRow = {
      id: randomUUID(),
      telegram_update_id: input.updateId,
      chat_id: input.chatId,
      message_id: input.messageId,
      raw_text: input.rawText,
      received_at: input.receivedAt,
      status: 'received',
      score: null,
      score_reason: null,
      keywords: [],
      failure_reason: null,
    };
    this.notes.set(row.id, row);
    return row;
  }

  async setNoteScore(
    noteId: string,
    score: { score: number; reason: string; keywords: string[]; status: NoteStatus },
  ) {
    this.guard('setNoteScore');
    const note = this.notes.get(noteId);
    if (!note) throw new Error(`unknown note ${noteId}`);
    note.score = score.score;
    note.score_reason = score.reason;
    note.keywords = score.keywords;
    note.status = score.status;
  }

  async setNoteStatus(noteId: string, status: NoteStatus, failureReason?: string | null) {
    this.guard('setNoteStatus');
    const note = this.notes.get(noteId);
    if (!note) throw new Error(`unknown note ${noteId}`);
    note.status = status;
    note.failure_reason = failureReason ?? null;
  }

  async getActiveVoiceSkill(): Promise<VoiceSkillRow | null> {
    this.guard('getActiveVoiceSkill');
    return this.voiceSkills.find((skill) => skill.is_active) ?? null;
  }

  async activateVoiceSkill(content: string, contentHash: string): Promise<VoiceSkillRow> {
    this.guard('activateVoiceSkill');
    let skill = this.voiceSkills.find((row) => row.content_hash === contentHash);
    if (!skill) {
      skill = {
        id: randomUUID(),
        version: this.voiceSkills.length + 1,
        content_hash: contentHash,
        content,
        is_active: false,
      };
      this.voiceSkills.push(skill);
    }
    for (const row of this.voiceSkills) row.is_active = row.id === skill.id;
    return skill;
  }

  async createDraft(input: CreateDraftInput): Promise<DraftRow> {
    this.guard('createDraft');
    if ([...this.drafts.values()].some((draft) => draft.short_id === input.shortId)) {
      throw new Error('duplicate short_id');
    }
    const news = input.newsItem;
    // Mirrors drafts_news_metadata_check.
    if (input.usedNews && (!news?.headline || !news.url || !news.publication)) {
      throw new Error('drafts_news_metadata_check violation');
    }
    const row: DraftRow = {
      id: randomUUID(),
      short_id: input.shortId,
      note_id: input.noteId,
      voice_skill_id: input.voiceSkillId,
      body: input.body,
      status: 'pending',
      gemini_model: input.geminiModel,
      used_news: input.usedNews,
      news_headline: news?.headline ?? null,
      news_publication: news?.publication ?? null,
      news_published_at: news?.publishedAt ?? null,
      news_url: news?.url ?? null,
      news_description: news?.description ?? null,
      uncertainty_note: input.uncertaintyNote,
      telegram_message_id: null,
      created_at: new Date().toISOString(),
    };
    this.drafts.set(row.id, row);
    const note = this.notes.get(input.noteId);
    if (note) note.status = 'drafted';
    return row;
  }

  async setDraftTelegramMessageId(draftId: string, telegramMessageId: number) {
    this.guard('setDraftTelegramMessageId');
    const draft = this.drafts.get(draftId);
    if (draft) draft.telegram_message_id = telegramMessageId;
  }

  async getDraftByShortId(shortId: string): Promise<DraftRow | null> {
    this.guard('getDraftByShortId');
    return [...this.drafts.values()].find((d) => d.short_id === shortId.toUpperCase()) ?? null;
  }

  async recordReview(input: RecordReviewInput): Promise<ReviewOutcome> {
    this.guard('recordReview');
    const draft = [...this.drafts.values()].find((d) => d.short_id === input.shortId.toUpperCase());
    if (!draft) return { found: false };

    const previousStatus: DraftStatus = draft.status;
    let changed = false;
    if (draft.status === 'pending') {
      draft.status = input.decision;
      changed = true;
    }

    const duplicate = this.reviews.some(
      (r) => r.draft_id === draft.id && r.telegram_update_id === input.updateId,
    );
    if (!duplicate) {
      this.reviews.push({
        draft_id: draft.id,
        decision: input.decision,
        actor_chat_id: input.chatId,
        actor_user_id: input.userId,
        actor_username: input.username,
        telegram_update_id: input.updateId,
        source: input.source,
        applied: changed,
      });
    }

    return { found: true, changed, previousStatus, draft };
  }

  async getRecentDecisions(limit: number): Promise<PriorDecision[]> {
    this.guard('getRecentDecisions');
    return [...this.drafts.values()]
      .filter((draft) => draft.status !== 'pending')
      .slice(0, limit)
      .map((draft) => ({
        status: draft.status as 'approved' | 'rejected',
        excerpt: (this.notes.get(draft.note_id)?.raw_text ?? '').slice(0, 220),
      }));
  }

  async getCachedNews(queryHash: string): Promise<NewsItem[] | null> {
    this.guard('getCachedNews');
    const entry = this.newsCache.get(queryHash);
    if (!entry || entry.expiresAt <= Date.now()) return null;
    return entry.items;
  }

  async putCachedNews(queryHash: string, query: string, items: NewsItem[], ttlSeconds: number) {
    this.guard('putCachedNews');
    this.newsCache.set(queryHash, { items, query, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async checkRateLimit(
    chatId: number,
    windowSeconds: number,
    maxEvents: number,
  ): Promise<RateLimitResult> {
    this.guard('checkRateLimit');
    const cutoff = Date.now() - windowSeconds * 1000;
    const used = this.rateLimitEvents.filter((e) => e.chatId === chatId && e.at > cutoff).length;
    if (used >= maxEvents) return { allowed: false, used, limit: maxEvents };
    this.rateLimitEvents.push({ chatId, at: Date.now() });
    return { allowed: true, used: used + 1, limit: maxEvents };
  }

  async ping(): Promise<void> {
    this.guard('ping');
  }
}
