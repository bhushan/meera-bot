import { validationError } from '../errors';
import { telegramUpdateSchema, MEDIA_KEYS, type TelegramMessage } from './types';

export type ReviewDecision = 'approved' | 'rejected';
export type ReviewSource = 'callback' | 'command';

export interface ParsedNote {
  kind: 'note';
  updateId: number;
  chatId: number;
  messageId: number;
  text: string;
  sourceType: 'message' | 'channel_post';
  receivedAt: string;
  fromId?: number;
  fromUsername?: string;
}

export interface ParsedReviewCommand {
  kind: 'review_command';
  updateId: number;
  chatId: number;
  messageId: number;
  decision: ReviewDecision;
  draftShortId: string;
  source: 'command';
  fromId?: number;
  fromUsername?: string;
}

export interface ParsedReviewCallback {
  kind: 'review_callback';
  updateId: number;
  chatId: number;
  messageId: number;
  callbackQueryId: string;
  decision: ReviewDecision;
  draftShortId: string;
  source: 'callback';
  fromId: number;
  fromUsername?: string;
}

export interface ParsedInvalidCommand {
  kind: 'invalid_command';
  updateId: number;
  chatId: number;
  messageId: number;
  reason: string;
}

export interface ParsedUnsupportedMedia {
  kind: 'unsupported_media';
  updateId: number;
  chatId: number;
  messageId: number;
  mediaType: string;
}

export interface ParsedIgnored {
  kind: 'ignored';
  updateId: number;
  chatId?: number;
  reason: string;
}

export type ParsedUpdate =
  | ParsedNote
  | ParsedReviewCommand
  | ParsedReviewCallback
  | ParsedInvalidCommand
  | ParsedUnsupportedMedia
  | ParsedIgnored;

/** Short ids are Crockford-ish base32: unambiguous uppercase letters and digits. */
export const DRAFT_SHORT_ID_PATTERN = /^[0-9A-HJ-NP-TV-Z]{6}$/;

/** `APPROVE AB12CD`, `/reject@bot AB12CD`, case-insensitive, nothing else on the line. */
const REVIEW_COMMAND = /^\/?(approve|reject)(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9]{1,16})$/i;

/** Inline button payload, well under Telegram's 64-byte callback_data limit. */
export const CALLBACK_PREFIX = 'rv';
const CALLBACK_DATA = /^rv:(a|r):([0-9A-HJ-NP-TV-Z]{6})$/;

export function buildCallbackData(decision: ReviewDecision, draftShortId: string): string {
  return `${CALLBACK_PREFIX}:${decision === 'approved' ? 'a' : 'r'}:${draftShortId}`;
}

function detectMedia(message: TelegramMessage): string | null {
  for (const key of MEDIA_KEYS) {
    if (key in message && (message as Record<string, unknown>)[key] != null) return key;
  }
  return null;
}

function authorFields(message: TelegramMessage) {
  const from = message.from;
  return {
    ...(from?.id !== undefined ? { fromId: from.id } : {}),
    ...(from?.username !== undefined ? { fromUsername: from.username } : {}),
  };
}

/**
 * Normalise a raw Telegram update into a single discriminated shape.
 *
 * Throws a non-retryable validation {@link AppError} only when the payload is not a
 * Telegram update at all. Unknown-but-well-formed updates return `{ kind: 'ignored' }`
 * so a future Bot API addition never causes a webhook retry storm.
 */
export function parseUpdate(raw: unknown): ParsedUpdate {
  const result = telegramUpdateSchema.safeParse(raw);
  if (!result.success) {
    const paths = result.error.issues.map((issue) => issue.path.join('.') || '(root)');
    throw validationError('Malformed Telegram update payload', { paths });
  }
  const update = result.data;
  const updateId = update.update_id;

  if (update.callback_query) {
    const query = update.callback_query;
    const message = query.message;
    const match = CALLBACK_DATA.exec(query.data ?? '');
    if (!match || !message) {
      return {
        kind: 'ignored',
        updateId,
        ...(message ? { chatId: message.chat.id } : {}),
        reason: 'unrecognised_callback_data',
      };
    }
    return {
      kind: 'review_callback',
      updateId,
      chatId: message.chat.id,
      messageId: message.message_id,
      callbackQueryId: query.id,
      decision: match[1] === 'a' ? 'approved' : 'rejected',
      draftShortId: match[2]!,
      source: 'callback',
      fromId: query.from.id,
      ...(query.from.username !== undefined ? { fromUsername: query.from.username } : {}),
    };
  }

  const message = update.channel_post ?? update.message;
  if (!message) {
    return { kind: 'ignored', updateId, reason: 'unsupported_update_type' };
  }

  const chatId = message.chat.id;
  const messageId = message.message_id;

  // A bot author means our own reply (or another bot) came back to us. Never act on it.
  if (message.from?.is_bot === true) {
    return { kind: 'ignored', updateId, chatId, reason: 'bot_message' };
  }

  const media = detectMedia(message);
  if (media) {
    return { kind: 'unsupported_media', updateId, chatId, messageId, mediaType: media };
  }

  const text = (message.text ?? '').trim();
  if (text.length === 0) {
    return { kind: 'ignored', updateId, chatId, reason: 'empty_text' };
  }

  const command = REVIEW_COMMAND.exec(text);
  if (command) {
    const decision: ReviewDecision =
      command[1]!.toLowerCase() === 'approve' ? 'approved' : 'rejected';
    const shortId = command[2]!.toUpperCase();
    if (!DRAFT_SHORT_ID_PATTERN.test(shortId)) {
      return {
        kind: 'invalid_command',
        updateId,
        chatId,
        messageId,
        reason: 'draft id must be 6 characters using 0-9 and A-Z without I, L, O or U',
      };
    }
    return {
      kind: 'review_command',
      updateId,
      chatId,
      messageId,
      decision,
      draftShortId: shortId,
      source: 'command',
      ...authorFields(message),
    };
  }

  return {
    kind: 'note',
    updateId,
    chatId,
    messageId,
    text,
    sourceType: update.channel_post ? 'channel_post' : 'message',
    receivedAt: new Date((message.date ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    ...authorFields(message),
  };
}
