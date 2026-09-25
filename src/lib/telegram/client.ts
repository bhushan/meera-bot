import { AppError } from '../errors';
import type { Logger } from '../logger';
import { withRetry } from '../util/retry';
import { withTimeout } from '../util/timeout';
import { chunkMessage, TELEGRAM_MAX_MESSAGE_LENGTH } from './format';

export interface InlineButton {
  text: string;
  callbackData: string;
}

export interface SendMessageInput {
  chatId: number;
  text: string;
  /** Rendered onto the final chunk so buttons sit at the bottom of the draft. */
  inlineKeyboard?: InlineButton[][];
  parseMode?: 'HTML' | 'MarkdownV2' | null;
  disableLinkPreview?: boolean;
  replyToMessageId?: number;
}

export interface AnswerCallbackQueryInput {
  callbackQueryId: string;
  text?: string;
}

export interface EditReplyMarkupInput {
  chatId: number;
  messageId: number;
  inlineKeyboard: InlineButton[][];
}

export interface TelegramClient {
  sendMessage(input: SendMessageInput): Promise<{ messageId: number }>;
  answerCallbackQuery(input: AnswerCallbackQueryInput): Promise<void>;
  editMessageReplyMarkup(input: EditReplyMarkupInput): Promise<void>;
}

export interface TelegramClientOptions {
  token: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  attempts?: number;
}

const toApiKeyboard = (keyboard: InlineButton[][]) => ({
  inline_keyboard: keyboard.map((row) =>
    row.map((button) => ({ text: button.text, callback_data: button.callbackData })),
  ),
});

/** Telegram echoes a `description` we can safely log; the token never appears in it. */
interface TelegramApiError {
  ok: false;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

export function createTelegramClient(options: TelegramClientOptions): TelegramClient {
  const { token, logger, fetchImpl = fetch, sleep, timeoutMs = 8000, attempts = 3 } = options;

  // Built once; never logged. `redact()` also masks it if it ever reaches a log line.
  const baseUrl = `https://api.telegram.org/bot${token}`;

  async function callOnce<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    const response = await withTimeout(
      (signal) =>
        fetchImpl(`${baseUrl}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal,
        }),
      { ms: timeoutMs, label: `telegram.${method}` },
    );

    const raw = await response.text();
    let parsed: unknown;
    try {
      parsed = raw.length > 0 ? JSON.parse(raw) : {};
    } catch {
      parsed = {};
    }

    if (response.ok && (parsed as { ok?: boolean }).ok === true) {
      return (parsed as { result: T }).result;
    }

    const apiError = parsed as TelegramApiError;
    const status = response.status;
    // 429 and 5xx are transient. 4xx (except 429) means the request itself is wrong.
    const retryable = status === 429 || status >= 500;
    throw new AppError({
      kind: 'telegram',
      message: `Telegram ${method} failed with HTTP ${status}${
        apiError.description ? `: ${apiError.description}` : ''
      }`,
      retryable,
      context: {
        method,
        status,
        errorCode: apiError.error_code,
        description: apiError.description,
        retryAfter: apiError.parameters?.retry_after,
      },
    });
  }

  async function call<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    return withRetry(() => callOnce<T>(method, payload), {
      attempts,
      label: `telegram.${method}`,
      ...(sleep ? { sleep } : {}),
      onRetry: (attempt, err, delayMs) =>
        logger.warn('telegram_retry', { method, attempt, delayMs, err }),
    });
  }

  return {
    async sendMessage(input) {
      const parseMode = input.parseMode === undefined ? 'HTML' : input.parseMode;
      const chunks = chunkMessage(input.text, TELEGRAM_MAX_MESSAGE_LENGTH);
      if (chunks.length === 0) chunks.push('(empty message)');

      let lastMessageId = 0;
      for (let index = 0; index < chunks.length; index += 1) {
        const isLast = index === chunks.length - 1;
        const payload: Record<string, unknown> = {
          chat_id: input.chatId,
          text: chunks[index],
          ...(parseMode ? { parse_mode: parseMode } : {}),
          ...(input.disableLinkPreview ? { link_preview_options: { is_disabled: true } } : {}),
          ...(index === 0 && input.replyToMessageId
            ? {
                reply_parameters: {
                  message_id: input.replyToMessageId,
                  allow_sending_without_reply: true,
                },
              }
            : {}),
          ...(isLast && input.inlineKeyboard
            ? { reply_markup: toApiKeyboard(input.inlineKeyboard) }
            : {}),
        };
        const result = await call<{ message_id: number }>('sendMessage', payload);
        lastMessageId = result.message_id;
      }
      return { messageId: lastMessageId };
    },

    async answerCallbackQuery(input) {
      await call('answerCallbackQuery', {
        callback_query_id: input.callbackQueryId,
        ...(input.text ? { text: input.text } : {}),
      });
    },

    async editMessageReplyMarkup(input) {
      try {
        await call('editMessageReplyMarkup', {
          chat_id: input.chatId,
          message_id: input.messageId,
          reply_markup: toApiKeyboard(input.inlineKeyboard),
        });
      } catch (err) {
        // A second click on the same button produces "message is not modified".
        // That is the idempotent happy path, not a failure.
        const description = String(
          (err as AppError)?.context?.description ?? (err as Error)?.message ?? '',
        );
        if (/not modified|message to edit not found/i.test(description)) {
          logger.debug('telegram_markup_already_current', {
            chatId: input.chatId,
            messageId: input.messageId,
          });
          return;
        }
        throw err;
      }
    },
  };
}
