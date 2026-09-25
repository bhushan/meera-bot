import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

/** Lowercase header name; Next.js `Headers` lookups are case-insensitive anyway. */
export const TELEGRAM_SECRET_HEADER = 'x-telegram-bot-api-secret-token';

/** Per-process key so digests cannot be precomputed by an attacker. */
const COMPARISON_KEY = randomBytes(32);

const digest = (value: string): Buffer =>
  createHmac('sha256', COMPARISON_KEY).update(value).digest();

/**
 * Timing-safe comparison of the `X-Telegram-Bot-Api-Secret-Token` header.
 *
 * Both sides are HMAC'd to a fixed 32-byte digest first, so the comparison width
 * does not leak the secret's length and `timingSafeEqual` never throws on a
 * length mismatch. An empty expected secret rejects everything: a misconfigured
 * deployment must fail closed, not open.
 */
export function verifyWebhookSecret(
  provided: string | undefined | null,
  expected: string,
): boolean {
  if (typeof expected !== 'string' || expected.length === 0) return false;
  if (typeof provided !== 'string' || provided.length === 0) return false;
  return timingSafeEqual(digest(provided), digest(expected));
}
