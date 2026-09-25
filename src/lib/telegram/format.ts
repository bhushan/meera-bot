/** Telegram message hard limit. */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

/**
 * Escape text for Telegram's `parse_mode: 'HTML'`.
 * The ampersand must be replaced first or we would double-escape our own entities.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const MARKDOWN_V2_RESERVED = /[\\_*[\]()~`>#+\-=|{}.!]/g;

/** Escape text for Telegram's `parse_mode: 'MarkdownV2'`. */
export function escapeMarkdownV2(value: string): string {
  return value.replace(MARKDOWN_V2_RESERVED, (char) => `\\${char}`);
}

/**
 * Split text into chunks that fit Telegram's message limit, preferring paragraph
 * then line then hard-character boundaries so drafts stay readable.
 */
export function chunkMessage(text: string, limit = TELEGRAM_MAX_MESSAGE_LENGTH): string[] {
  if (limit <= 0) throw new Error('chunkMessage limit must be positive');
  if (text.length <= limit) return text.length > 0 ? [text] : [];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    const window = remaining.slice(0, limit + 1);
    let cut = window.lastIndexOf('\n\n');
    if (cut <= 0) cut = window.lastIndexOf('\n');
    if (cut <= 0) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = limit;
    else cut = Math.min(cut, limit);

    const piece = remaining.slice(0, cut).trim();
    if (piece.length > 0) chunks.push(piece);
    remaining = remaining.slice(cut).replace(/^\s+/, '');
    // Defensive: a boundary search that made no progress would loop forever.
    if (piece.length === 0 && remaining.length > limit) {
      chunks.push(remaining.slice(0, limit));
      remaining = remaining.slice(limit);
    }
  }

  const tail = remaining.trim();
  if (tail.length > 0) chunks.push(tail);
  return chunks;
}
