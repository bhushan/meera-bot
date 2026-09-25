import type { NewsItem } from '../news/types';
import type { DraftStatus } from '../db/types';
import { buildCallbackData } from './parse';
import { escapeHtml, TELEGRAM_MAX_MESSAGE_LENGTH } from './format';
import type { InlineButton } from './client';

/** YYYY-MM-DD, or `unknown` when the feed gave us no parseable date. */
const formatDate = (iso: string | null): string =>
  iso ? (iso.split('T')[0] ?? 'unknown') : 'unknown';

/**
 * The verification block required whenever a draft used a news angle.
 * Shape is fixed by the brief; every interpolated value is HTML-escaped.
 */
export function buildNewsReviewBlock(newsItem: NewsItem): string {
  return [
    `NEWS SOURCE: ${escapeHtml(newsItem.headline)}`,
    `FROM: ${escapeHtml(newsItem.publication)} | ${escapeHtml(formatDate(newsItem.publishedAt))}`,
    `LINK: ${escapeHtml(newsItem.url)}`,
    'CHECK BEFORE PUBLISHING: You are the author of this claim.',
  ].join('\n');
}

export interface DraftMessageInput {
  shortId: string;
  score: number;
  scoreReason: string;
  body: string;
  newsItem: NewsItem | null;
  uncertaintyNote: string | null;
}

export function buildDraftMessage(input: DraftMessageInput): string {
  const sections: string[] = [
    `DRAFT ${escapeHtml(input.shortId)}`,
    `SCORE: ${input.score}/10`,
    `WHY: ${escapeHtml(input.scoreReason)}`,
    '',
    escapeHtml(input.body),
  ];

  if (input.newsItem) {
    sections.push('', buildNewsReviewBlock(input.newsItem));
  }

  if (input.uncertaintyNote) {
    sections.push('', `STILL UNVERIFIED: ${escapeHtml(input.uncertaintyNote)}`);
  }

  sections.push(
    '',
    `Nothing is sent anywhere until you decide. Use the buttons below, or reply APPROVE ${escapeHtml(
      input.shortId,
    )} or REJECT ${escapeHtml(input.shortId)}.`,
  );

  return sections.join('\n');
}

export function reviewKeyboard(shortId: string): InlineButton[][] {
  return [
    [
      { text: 'Approve', callbackData: buildCallbackData('approved', shortId) },
      { text: 'Reject', callbackData: buildCallbackData('rejected', shortId) },
    ],
  ];
}

export function buildRejectionMessage(input: { score: number; reason: string }): string {
  return [
    `SCORED ${input.score}/10, so no draft was written.`,
    '',
    `WHY: ${escapeHtml(input.reason)}`,
    '',
    'The note is saved. Send a sharper version with a number, a mechanism, or something you personally observed, and it will be scored again.',
  ].join('\n');
}

export function buildUnsupportedMediaMessage(mediaType: string): string {
  return `This version accepts text notes only. Your ${escapeHtml(
    mediaType,
  )} message was not processed. Type the note out, or send a transcript, and it will go through scoring.`;
}

export function buildInvalidCommandMessage(reason: string): string {
  return `That command was not understood: ${escapeHtml(
    reason,
  )}. Use APPROVE <draft-id> or REJECT <draft-id>, for example APPROVE AB12CD.`;
}

export function buildUnknownDraftMessage(shortId: string): string {
  return `No draft found with id ${escapeHtml(shortId)}. Check the id on the draft message and try again.`;
}

export function buildReviewConfirmation(input: {
  shortId: string;
  status: DraftStatus;
  changed: boolean;
}): string {
  const shortId = escapeHtml(input.shortId);

  if (input.status === 'rejected') {
    return input.changed
      ? `Draft ${shortId} is rejected and kept on file.`
      : `Draft ${shortId} was already rejected. Nothing changed.`;
  }

  const lead = input.changed
    ? `Draft ${shortId} is approved and saved.`
    : `Draft ${shortId} was already approved. Nothing changed.`;
  // An approval is always followed by `buildCopyableDraft`, so say where the post is.
  return `${lead} The post is in the next message, ready to copy into LinkedIn. This bot does not post anything.`;
}

export interface CopyableDraft {
  text: string;
  /** `null` sends the text verbatim, with no entity parsing at all. */
  parseMode: 'HTML' | null;
}

/**
 * The approved post on its own, with nothing to trim before pasting.
 *
 * A `<pre>` block gives Telegram clients a one-tap copy control. The client
 * splits anything over the message limit into chunks, which would leave the
 * opening tag unclosed and earn a non-retryable HTTP 400 on a decision that is
 * already committed, so an oversized post falls back to unparsed plain text.
 */
export function buildCopyableDraft(body: string): CopyableDraft {
  const wrapped = `<pre>${escapeHtml(body)}</pre>`;
  return wrapped.length <= TELEGRAM_MAX_MESSAGE_LENGTH
    ? { text: wrapped, parseMode: 'HTML' }
    : { text: body, parseMode: null };
}

/** Deliberately vague about internals; the request id is the only handle for support. */
export function buildFailureMessage(requestId: string): string {
  return `Something went wrong and this note could not be processed. Your note was saved and nothing was sent anywhere. Reference: ${escapeHtml(
    requestId,
  )}`;
}

export function buildRateLimitedMessage(): string {
  return 'Too many notes arrived at once. This one was saved but not processed. Send it again in a minute.';
}
