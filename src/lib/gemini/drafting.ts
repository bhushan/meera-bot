import { z } from 'zod';
import type { GeminiClient } from './client';
import type { NewsItem } from '../news/types';

export const draftModelOutputSchema = z.object({
  draft: z.string().trim().min(120).max(8000),
  used_news: z.boolean(),
  news_url: z.string().nullable().optional(),
  uncertainty_note: z.string().max(500).nullable().optional(),
});

export type DraftModelOutput = z.infer<typeof draftModelOutputSchema>;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    draft: { type: 'string' },
    used_news: { type: 'boolean' },
    news_url: { type: ['string', 'null'] },
    uncertainty_note: { type: ['string', 'null'] },
  },
  required: ['draft', 'used_news'],
} as const;

export interface DraftPostInput {
  noteText: string;
  voiceSkill: string;
  newsItem: NewsItem | null;
}

export interface DraftPostResult {
  body: string;
  usedNews: boolean;
  /** Present only when the draft genuinely used the item we retrieved. */
  newsItem: NewsItem | null;
  uncertaintyNote: string | null;
}

/**
 * Emoji and pictographic ranges. Deliberately broad: the voice profile forbids
 * emojis outright, and a false positive here costs nothing.
 *
 * Zero-width joiners and variation selectors are stripped by a separate pattern:
 * a character class that mixes base code points with combining ones matches
 * surprising sequences.
 */
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{27BF}\u{2B00}-\u{2BFF}]/gu;
const EMOJI_JOINERS = /\u{FE0F}|\u{200D}/gu;

const TRAILING_HASHTAG_BLOCK = /\n+\s*(?:#[\p{L}\p{N}_]+[ \t]*)+$/gu;
const INLINE_HASHTAG = /#(?=[\p{L}\p{N}_])/gu;

export interface SanitiseOptions {
  allowHashtags: boolean;
}

/** Enforce the house rules the model is asked for but cannot be trusted to keep. */
export function sanitiseDraft(draft: string, { allowHashtags }: SanitiseOptions): string {
  let body = draft.replace(EMOJI, '').replace(EMOJI_JOINERS, '');

  if (!allowHashtags) {
    body = body.replace(TRAILING_HASHTAG_BLOCK, '');
    body = body.replace(INLINE_HASHTAG, '');
  }

  return body
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const SYSTEM_PREAMBLE = `You draft LinkedIn posts for one specific founder. Everything you write must sound like her and must be supported by what she actually wrote.

VOICE PROFILE (follow it exactly):`;

const SYSTEM_RULES = `

HARD RULES:
- Base the post primarily on the submitted note. Keep the note's actual argument; do not replace it with a different one.
- Never invent her experiences, business numbers, customer messages, studies, product facts, or manufacturing details. If it is not in the note, you do not have it.
- If the factual support is thin, make the uncertainty visible in the post rather than filling the gap with invented specifics.
- Use the supplied news item only when it materially strengthens the argument. It is optional and you may ignore it.
- You have not read any article body. Do not summarise, quote, or characterise an article beyond its headline and the one-line description supplied.
- No emoji, ever. No hashtags unless the note itself used them. No clickbait opening, no motivational close, no promotional hype.
- End with a specific question the reader can ask, a fact they can verify, or a practical implication they can act on.
- Length: roughly 150 to 350 words, formatted as plain LinkedIn paragraphs separated by a blank line. No markdown headings, no bullet characters unless the note's logic truly needs a list.

Return JSON only:
- "draft": the post body, ready to paste into LinkedIn.
- "used_news": true only if the supplied news item genuinely shaped the post.
- "news_url": the exact URL you were given if used_news is true, otherwise null.
- "uncertainty_note": one sentence naming what remains unverified, or null.`;

const buildNewsBlock = (newsItem: NewsItem | null): string => {
  if (!newsItem) {
    return 'AVAILABLE NEWS CONTEXT: none. No news search result was relevant, so write the post from the note alone.';
  }
  return `AVAILABLE NEWS CONTEXT (optional, from an RSS search; we have not read the article body, only this metadata):
- HEADLINE: ${newsItem.headline}
- PUBLICATION: ${newsItem.publication}
- PUBLISHED: ${newsItem.publishedAt ?? 'unknown'}
- URL: ${newsItem.url}
- RSS DESCRIPTION: ${newsItem.description ?? '(none supplied)'}

Use it only if it materially strengthens the note's argument. If it does not, set used_news to false and ignore it.`;
};

export async function draftPost(
  gemini: GeminiClient,
  input: DraftPostInput,
): Promise<DraftPostResult> {
  const { noteText, voiceSkill, newsItem } = input;

  const output = await gemini.generateJson({
    label: 'draft',
    systemInstruction: `${SYSTEM_PREAMBLE}\n${voiceSkill}\n${SYSTEM_RULES}`,
    prompt: `${buildNewsBlock(newsItem)}\n\nTHE FOUNDER'S NOTE (the source of truth for every claim):\n"""\n${noteText}\n"""\n\nWrite the post.`,
    schema: draftModelOutputSchema,
    responseSchema: RESPONSE_SCHEMA as unknown as Record<string, unknown>,
    temperature: 0.6,
    // Budgets reasoning tokens as well as the visible output, so this is far
    // larger than the response needs on its own.
    maxOutputTokens: 4096,
  });

  // The model may only claim to have used news we actually retrieved, and only at
  // the exact URL we supplied. Anything else is treated as no news at all, so the
  // verification block can never point at a fabricated source.
  const usedNews =
    output.used_news === true && newsItem !== null && output.news_url === newsItem.url;

  return {
    body: sanitiseDraft(output.draft, { allowHashtags: noteText.includes('#') }),
    usedNews,
    newsItem: usedNews ? newsItem : null,
    uncertaintyNote: output.uncertainty_note ?? null,
  };
}
