import { describeError } from '../errors';
import type { ParsedReviewCallback, ParsedReviewCommand } from '../telegram/parse';
import {
  buildFailureMessage,
  buildReviewConfirmation,
  buildUnknownDraftMessage,
} from '../telegram/messages';
import type { PipelineDeps } from './deps';

export type ReviewInput = ParsedReviewCommand | ParsedReviewCallback;

export type HandleReviewOutcome =
  | { status: 'applied'; shortId: string; decision: 'approved' | 'rejected' }
  | { status: 'already_decided'; shortId: string; currentStatus: 'approved' | 'rejected' }
  | { status: 'not_found'; shortId: string }
  | { status: 'failed'; shortId: string; reason: string };

/**
 * Apply a human decision to a draft.
 *
 * Idempotent end to end: the status change happens inside `record_draft_review`,
 * which only moves a draft out of `pending`, so a second button press or a
 * re-delivered update confirms the existing state instead of changing it.
 * Rejected drafts are kept; nothing is ever deleted or published.
 */
export async function handleReview(
  deps: PipelineDeps,
  review: ReviewInput,
): Promise<HandleReviewOutcome> {
  const { repo, telegram, logger, config } = deps;
  const shortId = review.draftShortId;

  try {
    const outcome = await repo.recordReview({
      shortId,
      decision: review.decision,
      chatId: review.chatId,
      userId: review.fromId ?? null,
      username: review.fromUsername ?? null,
      updateId: review.updateId,
      source: review.source,
    });

    if (!outcome.found) {
      logger.warn('review_draft_not_found', { shortId, updateId: review.updateId });
      if (review.kind === 'review_callback') {
        await telegram.answerCallbackQuery({
          callbackQueryId: review.callbackQueryId,
          text: 'Draft not found',
        });
      }
      await telegram.sendMessage({
        chatId: review.chatId,
        text: buildUnknownDraftMessage(shortId),
      });
      await repo.setUpdateStatus(review.updateId, 'done');
      return { status: 'not_found', shortId };
    }

    const { draft, changed } = outcome;
    logger.info('review_recorded', {
      shortId,
      draftId: draft.id,
      decision: review.decision,
      changed,
      previousStatus: outcome.previousStatus,
      source: review.source,
      actorId: review.fromId ?? null,
      updateId: review.updateId,
    });

    if (review.kind === 'review_callback') {
      await telegram.answerCallbackQuery({
        callbackQueryId: review.callbackQueryId,
        text: changed
          ? draft.status === 'approved'
            ? 'Approved'
            : 'Rejected'
          : `Already ${draft.status}`,
      });
    }

    // Retire the buttons on the original draft message so the state is unambiguous.
    const draftMessageId =
      draft.telegram_message_id ??
      (review.kind === 'review_callback' ? review.messageId : undefined);
    if (draftMessageId) {
      try {
        await telegram.editMessageReplyMarkup({
          chatId: review.chatId,
          messageId: draftMessageId,
          inlineKeyboard: [],
        });
      } catch (err) {
        logger.warn('review_markup_cleanup_failed', { shortId, err });
      }
    }

    await telegram.sendMessage({
      chatId: review.chatId,
      text: buildReviewConfirmation({ shortId: draft.short_id, status: draft.status, changed }),
    });
    await repo.setUpdateStatus(review.updateId, 'done');

    if (!changed) {
      return {
        status: 'already_decided',
        shortId: draft.short_id,
        currentStatus: draft.status as 'approved' | 'rejected',
      };
    }
    return { status: 'applied', shortId: draft.short_id, decision: review.decision };
  } catch (err) {
    const reason = describeError(err);
    logger.error('review_failed', { shortId, updateId: review.updateId, err });
    try {
      await repo.setUpdateStatus(review.updateId, 'dead_letter', reason);
      await telegram.sendMessage({
        chatId: review.chatId,
        text: buildFailureMessage(config.requestId),
      });
    } catch (notifyError) {
      logger.error('review_failure_notification_failed', { err: notifyError });
    }
    return { status: 'failed', shortId, reason };
  }
}
