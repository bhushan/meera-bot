import { type AppError, describeError, isAppError } from '../errors';
import type { Repository } from '../db/repository';
import type { Logger } from '../logger';
import type { TelegramClient } from '../telegram/client';
import { parseUpdate, type ParsedUpdate } from '../telegram/parse';
import {
  buildInvalidCommandMessage,
  buildRateLimitedMessage,
  buildUnsupportedMediaMessage,
} from '../telegram/messages';
import { verifyWebhookSecret } from '../telegram/verify';
import type { ConcurrencyGuard } from '../util/concurrency';

export interface WebhookConfig {
  allowedChatId: number;
  webhookSecret: string;
  rateLimitWindowSeconds: number;
  rateLimitMaxEvents: number;
}

export interface WebhookDeps {
  repo: Repository;
  telegram: TelegramClient;
  logger: Logger;
  config: WebhookConfig;
  guard: ConcurrencyGuard;
  /**
   * Hands long-running work to the platform. In production this is Next's
   * `after()`, which keeps the HTTP response fast while the pipeline finishes.
   * Tests pass an inline scheduler so assertions can await the whole flow.
   */
  schedule: (work: () => Promise<void>) => void;
  /** Runs the note pipeline or the review gate for an accepted update. */
  dispatch: (parsed: ParsedUpdate) => Promise<void>;
}

export interface WebhookRequest {
  rawBody: string;
  secretHeader: string | null;
}

export interface WebhookResponse {
  status: number;
  body: { ok: boolean; [key: string]: unknown };
}

const updateTypeOf = (parsed: ParsedUpdate): string => parsed.kind;

export async function handleTelegramWebhook(
  deps: WebhookDeps,
  request: WebhookRequest,
): Promise<WebhookResponse> {
  const { repo, telegram, logger, config, guard, schedule, dispatch } = deps;

  // 1. Authenticate the caller before anything else touches the payload.
  if (!verifyWebhookSecret(request.secretHeader, config.webhookSecret)) {
    logger.warn('webhook_secret_rejected', { hasHeader: request.secretHeader !== null });
    return { status: 401, body: { ok: false, error: 'unauthorized' } };
  }

  // 2. Parse. A payload that is not a Telegram update at all is a client error.
  let parsed: ParsedUpdate;
  try {
    parsed = parseUpdate(JSON.parse(request.rawBody));
  } catch (err) {
    logger.warn('webhook_payload_rejected', { err });
    return { status: 400, body: { ok: false, error: 'invalid_payload' } };
  }

  const chatId = 'chatId' in parsed ? parsed.chatId : undefined;
  const log = logger.child({ updateId: parsed.updateId, updateKind: parsed.kind });

  // An update with no chat context (an unsubscribed update type) is simply dropped.
  if (chatId === undefined) {
    log.info('webhook_ignored_no_chat');
    return { status: 200, body: { ok: true, ignored: true } };
  }

  // 3. Only the configured chat may reach the pipeline at all.
  if (chatId !== config.allowedChatId) {
    log.warn('webhook_chat_not_allowed', { chatId });
    return { status: 403, body: { ok: false, error: 'forbidden' } };
  }

  // 4. Concurrency guard sits *before* the claim so a rejected request is retried
  //    by Telegram rather than being silently marked as processed.
  const release = guard.tryAcquire();
  if (!release) {
    log.warn('webhook_concurrency_exceeded', { active: guard.active, limit: guard.limit });
    return { status: 429, body: { ok: false, error: 'busy' } };
  }

  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    release();
  };

  try {
    // 5. Exactly-once: the first caller for this update_id wins.
    const claimed = await repo.claimUpdate({
      updateId: parsed.updateId,
      chatId,
      messageId: 'messageId' in parsed ? parsed.messageId : null,
      updateType: updateTypeOf(parsed),
    });
    if (!claimed) {
      log.info('webhook_duplicate_update');
      releaseOnce();
      return { status: 200, body: { ok: true, duplicate: true } };
    }

    // 6. Per-chat sliding window, enforced in Postgres so it holds across instances.
    const rate = await repo.checkRateLimit(
      chatId,
      config.rateLimitWindowSeconds,
      config.rateLimitMaxEvents,
    );
    if (!rate.allowed) {
      log.warn('webhook_rate_limited', { used: rate.used, limit: rate.limit });
      await repo.setUpdateStatus(parsed.updateId, 'rate_limited', 'per-chat rate limit exceeded');
      // The note itself is not stored here: the update row records that it arrived,
      // and Telegram is told to stop retrying so a burst cannot amplify.
      schedule(async () => {
        try {
          await telegram.sendMessage({ chatId, text: buildRateLimitedMessage() });
        } catch (err) {
          log.warn('rate_limit_notice_failed', { err });
        } finally {
          releaseOnce();
        }
      });
      return { status: 200, body: { ok: true, rateLimited: true } };
    }

    // 7. Short, terminal responses are handled here; real work is scheduled.
    if (parsed.kind === 'ignored') {
      log.info('webhook_ignored', { reason: parsed.reason });
      await repo.setUpdateStatus(parsed.updateId, 'ignored', parsed.reason);
      releaseOnce();
      return { status: 200, body: { ok: true, ignored: true } };
    }

    if (parsed.kind === 'unsupported_media' || parsed.kind === 'invalid_command') {
      const text =
        parsed.kind === 'unsupported_media'
          ? buildUnsupportedMediaMessage(parsed.mediaType)
          : buildInvalidCommandMessage(parsed.reason);
      schedule(async () => {
        try {
          await telegram.sendMessage({ chatId, text, replyToMessageId: parsed.messageId });
          await repo.setUpdateStatus(parsed.updateId, 'ignored', parsed.kind);
        } catch (err) {
          log.error('webhook_notice_failed', { err });
          await repo
            .setUpdateStatus(parsed.updateId, 'failed', describeError(err))
            .catch(() => undefined);
        } finally {
          releaseOnce();
        }
      });
      return { status: 200, body: { ok: true, handled: parsed.kind } };
    }

    schedule(async () => {
      try {
        await dispatch(parsed);
      } catch (err) {
        // `dispatch` already handles its own failures; this is the last resort.
        log.error('webhook_dispatch_failed', { err });
        await repo
          .setUpdateStatus(parsed.updateId, 'dead_letter', describeError(err))
          .catch(() => undefined);
      } finally {
        releaseOnce();
      }
    });

    return { status: 200, body: { ok: true, accepted: parsed.kind } };
  } catch (err) {
    releaseOnce();
    log.error('webhook_failed', { err });
    const status = isAppError(err) ? (err as AppError).status : 500;
    return { status: status >= 500 ? 500 : status, body: { ok: false, error: 'internal_error' } };
  }
}
