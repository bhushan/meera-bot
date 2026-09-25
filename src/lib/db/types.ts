export type UpdateStatus =
  'received' | 'processing' | 'done' | 'ignored' | 'rate_limited' | 'failed' | 'dead_letter';

export type NoteStatus =
  'received' | 'scoring' | 'scored' | 'rejected_low_score' | 'drafting' | 'drafted' | 'failed';

export type DraftStatus = 'pending' | 'approved' | 'rejected';

export type ReviewSource = 'callback' | 'command';

export interface NoteRow {
  id: string;
  telegram_update_id: number;
  chat_id: number;
  message_id: number;
  raw_text: string;
  received_at: string;
  status: NoteStatus;
  score: number | null;
  score_reason: string | null;
  keywords: string[];
  failure_reason: string | null;
}

export interface DraftRow {
  id: string;
  short_id: string;
  note_id: string;
  voice_skill_id: string;
  body: string;
  status: DraftStatus;
  gemini_model: string;
  used_news: boolean;
  news_headline: string | null;
  news_publication: string | null;
  news_published_at: string | null;
  news_url: string | null;
  news_description: string | null;
  uncertainty_note: string | null;
  telegram_message_id: number | null;
  created_at: string;
}

export interface VoiceSkillRow {
  id: string;
  version: number;
  content_hash: string;
  content: string;
  is_active: boolean;
}

export type ReviewOutcome =
  | { found: false }
  | {
      found: true;
      /** false when the draft had already left `pending` (a repeat click). */
      changed: boolean;
      previousStatus: DraftStatus;
      draft: DraftRow;
    };

export interface RateLimitResult {
  allowed: boolean;
  used: number;
  limit: number;
}
