import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { AppError } from '../errors';
import type { PriorDecision } from '../gemini/scoring';
import type { NewsItem } from '../news/types';
import type {
  ClaimUpdateInput,
  CreateDraftInput,
  RecordReviewInput,
  Repository,
  StoreNoteInput,
} from './repository';
import type {
  DraftRow,
  NoteRow,
  NoteStatus,
  RateLimitResult,
  ReviewOutcome,
  UpdateStatus,
  VoiceSkillRow,
} from './types';

const NOTE_EXCERPT_LENGTH = 220;

const supabaseError = (operation: string, cause: unknown): AppError =>
  new AppError({
    kind: 'supabase',
    message: `Supabase ${operation} failed`,
    retryable: true,
    context: {
      operation,
      // PostgREST errors carry a stable code/message pair and no credentials.
      code: (cause as { code?: string })?.code,
      detail: (cause as { message?: string })?.message,
    },
    cause,
  });

export function createSupabaseClient(url: string, serviceRoleKey: string): SupabaseClient {
  // Service role key: server-only. Never imported by a client component.
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-application-name': 'meera-bot' } },
  });
}

export function createSupabaseRepository(client: SupabaseClient): Repository {
  const rpc = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw supabaseError(fn, error);
    return data as T;
  };

  return {
    async claimUpdate(input: ClaimUpdateInput): Promise<boolean> {
      return rpc<boolean>('claim_telegram_update', {
        p_update_id: input.updateId,
        p_chat_id: input.chatId,
        p_message_id: input.messageId,
        p_update_type: input.updateType,
      });
    },

    async setUpdateStatus(updateId: number, status: UpdateStatus, failureReason?: string) {
      const { error } = await client
        .from('telegram_updates')
        .update({ status, failure_reason: failureReason ?? null })
        .eq('update_id', updateId);
      if (error) throw supabaseError('telegram_updates.update', error);
    },

    async storeNote(input: StoreNoteInput): Promise<NoteRow> {
      return rpc<NoteRow>('store_note', {
        p_update_id: input.updateId,
        p_chat_id: input.chatId,
        p_message_id: input.messageId,
        p_raw_text: input.rawText,
        p_received_at: input.receivedAt,
      });
    },

    async setNoteScore(noteId, score) {
      const { error } = await client
        .from('notes')
        .update({
          score: score.score,
          score_reason: score.reason,
          keywords: score.keywords,
          status: score.status,
        })
        .eq('id', noteId);
      if (error) throw supabaseError('notes.updateScore', error);
    },

    async setNoteStatus(noteId: string, status: NoteStatus, failureReason?: string | null) {
      const { error } = await client
        .from('notes')
        .update({ status, failure_reason: failureReason ?? null })
        .eq('id', noteId);
      if (error) throw supabaseError('notes.updateStatus', error);
    },

    async getActiveVoiceSkill(): Promise<VoiceSkillRow | null> {
      const { data, error } = await client
        .from('voice_skills')
        .select('id, version, content_hash, content, is_active')
        .eq('is_active', true)
        .maybeSingle();
      if (error) throw supabaseError('voice_skills.select', error);
      return (data as VoiceSkillRow | null) ?? null;
    },

    async activateVoiceSkill(content: string, contentHash: string): Promise<VoiceSkillRow> {
      return rpc<VoiceSkillRow>('activate_voice_skill', {
        p_content: content,
        p_content_hash: contentHash,
      });
    },

    async createDraft(input: CreateDraftInput): Promise<DraftRow> {
      const news = input.newsItem;
      return rpc<DraftRow>('create_draft_for_note', {
        p_note_id: input.noteId,
        p_short_id: input.shortId,
        p_voice_skill_id: input.voiceSkillId,
        p_body: input.body,
        p_gemini_model: input.geminiModel,
        p_used_news: input.usedNews,
        p_news_headline: news?.headline ?? null,
        p_news_publication: news?.publication ?? null,
        p_news_published_at: news?.publishedAt ?? null,
        p_news_url: news?.url ?? null,
        p_news_description: news?.description ?? null,
        p_uncertainty_note: input.uncertaintyNote,
      });
    },

    async setDraftTelegramMessageId(draftId: string, telegramMessageId: number) {
      const { error } = await client
        .from('drafts')
        .update({ telegram_message_id: telegramMessageId })
        .eq('id', draftId);
      if (error) throw supabaseError('drafts.setMessageId', error);
    },

    async getDraftByShortId(shortId: string): Promise<DraftRow | null> {
      const { data, error } = await client
        .from('drafts')
        .select('*')
        .eq('short_id', shortId.toUpperCase())
        .maybeSingle();
      if (error) throw supabaseError('drafts.select', error);
      return (data as DraftRow | null) ?? null;
    },

    async recordReview(input: RecordReviewInput): Promise<ReviewOutcome> {
      const data = await rpc<{
        found: boolean;
        changed?: boolean;
        previous_status?: string;
        draft?: DraftRow;
      }>('record_draft_review', {
        p_short_id: input.shortId,
        p_decision: input.decision,
        p_chat_id: input.chatId,
        p_user_id: input.userId,
        p_username: input.username,
        p_update_id: input.updateId,
        p_source: input.source,
      });

      if (!data?.found || !data.draft) return { found: false };
      return {
        found: true,
        changed: data.changed === true,
        previousStatus: (data.previous_status ?? 'pending') as DraftRow['status'],
        draft: data.draft,
      };
    },

    async getRecentDecisions(limit: number): Promise<PriorDecision[]> {
      const { data, error } = await client
        .from('drafts')
        .select('status, notes!inner(raw_text)')
        .in('status', ['approved', 'rejected'])
        .order('updated_at', { ascending: false })
        .limit(limit);
      if (error) throw supabaseError('drafts.recentDecisions', error);

      type Row = {
        status: 'approved' | 'rejected';
        notes: { raw_text: string } | { raw_text: string }[];
      };
      return ((data ?? []) as Row[]).map((row) => {
        const note = Array.isArray(row.notes) ? row.notes[0] : row.notes;
        return {
          status: row.status,
          excerpt: (note?.raw_text ?? '').slice(0, NOTE_EXCERPT_LENGTH),
        };
      });
    },

    async getCachedNews(queryHash: string): Promise<NewsItem[] | null> {
      const { data, error } = await client
        .from('news_cache')
        .select('payload, expires_at')
        .eq('query_hash', queryHash)
        .gt('expires_at', new Date().toISOString())
        .maybeSingle();
      if (error) throw supabaseError('news_cache.select', error);
      const payload = (data as { payload?: unknown } | null)?.payload;
      return Array.isArray(payload) ? (payload as NewsItem[]) : null;
    },

    async putCachedNews(queryHash, query, items, ttlSeconds) {
      const { error } = await client.from('news_cache').upsert(
        {
          query_hash: queryHash,
          query,
          payload: items,
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
        },
        { onConflict: 'query_hash' },
      );
      if (error) throw supabaseError('news_cache.upsert', error);
    },

    async checkRateLimit(
      chatId: number,
      windowSeconds: number,
      maxEvents: number,
    ): Promise<RateLimitResult> {
      const data = await rpc<{ allowed: boolean; used: number; limit: number }>(
        'check_rate_limit',
        {
          p_chat_id: chatId,
          p_window_seconds: windowSeconds,
          p_max_events: maxEvents,
        },
      );
      return { allowed: data.allowed, used: data.used, limit: data.limit };
    },

    async ping(): Promise<void> {
      const { error } = await client
        .from('voice_skills')
        .select('id', { head: true, count: 'exact' })
        .limit(1);
      if (error) throw supabaseError('ping', error);
    },
  };
}
