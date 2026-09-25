import { z } from 'zod';
import { ConfigValidationError } from './errors';

export { ConfigValidationError };

export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

/** Treat empty strings (a very common shape in CI/Vercel) as "not set". */
const blankToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const httpUrl = (opts: { httpsOnly: boolean }) =>
  z
    .string()
    .trim()
    .refine(
      (value) => {
        let url: URL;
        try {
          url = new URL(value);
        } catch {
          return false;
        }
        return opts.httpsOnly ? url.protocol === 'https:' : /^https?:$/.test(url.protocol);
      },
      opts.httpsOnly ? 'must be an https:// URL' : 'must be an http(s):// URL',
    )
    .transform((value) => value.replace(/\/+$/, ''));

export const envSchema = z.object({
  /** `<bot_id>:<auth_token>` as issued by BotFather. */
  TELEGRAM_BOT_TOKEN: z
    .string()
    .trim()
    .regex(/^\d{6,20}:[A-Za-z0-9_-]{30,}$/, 'must look like <bot_id>:<auth_token>'),
  /**
   * Telegram only permits 1-256 chars of A-Z a-z 0-9 _ - in `secret_token`,
   * so anything outside that set would silently fail at setWebhook time.
   */
  TELEGRAM_WEBHOOK_SECRET: z
    .string()
    .min(16, 'must be at least 16 characters')
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/, 'may only contain A-Z a-z 0-9 _ -'),
  TELEGRAM_ALLOWED_CHAT_ID: z
    .string()
    .trim()
    .regex(/^-?\d{1,19}$/, 'must be a numeric Telegram chat id')
    .transform((value) => Number(value))
    .refine(Number.isSafeInteger, 'must be a safe integer'),
  GEMINI_API_KEY: z.string().trim().min(20, 'looks too short to be a Gemini API key'),
  GEMINI_MODEL: z.preprocess(
    blankToUndefined,
    z.string().trim().min(1).max(120).default(DEFAULT_GEMINI_MODEL),
  ),
  SUPABASE_URL: httpUrl({ httpsOnly: true }),
  SUPABASE_SERVICE_ROLE_KEY: z.string().trim().min(20, 'looks too short to be a service role key'),
  APP_BASE_URL: httpUrl({ httpsOnly: false }),
});

export type Env = z.infer<typeof envSchema>;

export type EnvSource = Record<string, string | undefined>;

/**
 * Validate configuration. Throws {@link ConfigValidationError} listing the offending
 * keys. Values are never included in the message, so this is safe to log.
 */
export function parseEnv(source: EnvSource | Record<string, unknown>): Env {
  const result = envSchema.safeParse(source);
  if (result.success) return result.data;

  const byKey = new Map<string, string>();
  for (const issue of result.error.issues) {
    const key = String(issue.path[0] ?? '(root)');
    if (!byKey.has(key)) byKey.set(key, issue.message);
  }
  const invalidKeys = [...byKey.keys()].sort();
  const detail = invalidKeys.map((key) => `${key} (${byKey.get(key)})`).join(', ');
  throw new ConfigValidationError(invalidKeys, detail);
}

let cached: Env | null = null;

/** Memoised accessor used by server code. Fails fast on the first call. */
export function getEnv(source: EnvSource = process.env): Env {
  if (cached) return cached;
  cached = parseEnv(source);
  return cached;
}

/** Test-only: drop the memoised environment. */
export function resetEnvCache(): void {
  cached = null;
}

/** Redacted view of configuration, safe to return from /api/health. */
export function describeEnv(env: Env): Record<string, string> {
  const botId = env.TELEGRAM_BOT_TOKEN.split(':')[0] ?? 'unknown';
  return {
    telegramBotId: botId,
    geminiModel: env.GEMINI_MODEL,
    supabaseProject: new URL(env.SUPABASE_URL).hostname.split('.')[0] ?? 'unknown',
    appBaseUrl: env.APP_BASE_URL,
  };
}
