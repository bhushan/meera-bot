import { config as loadDotenv } from 'dotenv';
import { parseEnv, type Env } from '../src/lib/env';
import { ConfigValidationError } from '../src/lib/errors';

/**
 * Scripts read configuration from `.env.local` then `.env`, without overriding
 * anything already exported in the shell (so CI can inject values).
 */
export function loadScriptEnv(): Env {
  loadDotenv({ path: '.env.local', quiet: true });
  loadDotenv({ path: '.env', quiet: true });

  try {
    return parseEnv(process.env);
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      console.error('Configuration is incomplete. Fix these keys in .env.local:');
      for (const key of err.invalidKeys) console.error(`  - ${key}`);
      console.error('\nSee .env.example for the full list.');
      process.exit(1);
    }
    throw err;
  }
}

/** Never print a token. This shows only enough to confirm which bot is configured. */
export const describeToken = (token: string): string => {
  const botId = token.split(':')[0] ?? 'unknown';
  return `bot ${botId} (token hidden)`;
};

export const webhookUrl = (baseUrl: string): string =>
  `${baseUrl.replace(/\/+$/, '')}/api/telegram/webhook`;

export interface TelegramApiResult<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export async function callTelegram<T>(
  token: string,
  method: string,
  payload?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });

  const data = (await response.json()) as TelegramApiResult<T>;
  if (!response.ok || !data.ok) {
    // `description` comes from Telegram and never contains the token.
    throw new Error(
      `Telegram ${method} failed (HTTP ${response.status})${
        data.description ? `: ${data.description}` : ''
      }`,
    );
  }
  return data.result as T;
}

export interface WebhookInfo {
  url?: string;
  has_custom_certificate?: boolean;
  pending_update_count?: number;
  max_connections?: number;
  allowed_updates?: string[];
  last_error_date?: number;
  last_error_message?: string;
  ip_address?: string;
}

export function printWebhookInfo(info: WebhookInfo): void {
  console.log('  url:                  ', info.url || '(none)');
  console.log('  allowed_updates:      ', (info.allowed_updates ?? []).join(', ') || '(all)');
  console.log('  pending_update_count: ', info.pending_update_count ?? 0);
  console.log('  max_connections:      ', info.max_connections ?? '(default)');
  if (info.last_error_message) {
    const when = info.last_error_date
      ? new Date(info.last_error_date * 1000).toISOString()
      : 'unknown';
    console.log(`  last_error:            ${info.last_error_message} (at ${when})`);
  } else {
    console.log('  last_error:            none');
  }
}

export const ALLOWED_UPDATES = ['message', 'channel_post', 'callback_query'] as const;
