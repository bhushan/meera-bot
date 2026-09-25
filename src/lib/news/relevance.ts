import { z } from 'zod';
import type { GeminiClient } from '../gemini/client';
import type { NewsItem } from './types';

export const newsRelevanceSchema = z.object({
  relevant: z.boolean(),
  index: z.number().int().min(0).max(50).nullable().optional(),
  reason: z.string().max(300).optional(),
});

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    relevant: { type: 'boolean' },
    index: { type: ['integer', 'null'] },
    reason: { type: 'string' },
  },
  required: ['relevant'],
} as const;

export interface SelectRelevantNewsInput {
  noteText: string;
  candidates: NewsItem[];
}

export interface SelectRelevantNewsResult {
  item: NewsItem | null;
  reason: string;
}

const SYSTEM_INSTRUCTION = `You decide whether a news search result is genuinely relevant to a founder's note about skincare, formulation, or running a D2C brand.

Be strict. A headline that merely shares a keyword is not relevant. A result is relevant only if it would materially strengthen a post built on the note: it corroborates the note's mechanism, shows the same problem happening at industry scale, or gives the reader something concrete to check.

You have only headlines, publications, dates and one-line RSS descriptions. You have not read the articles. When in doubt, answer that nothing is relevant: writing the post from the note alone is always an acceptable outcome.

Return JSON only: {"relevant": boolean, "index": number or null, "reason": one short sentence}.`;

/**
 * Ask Gemini to pick at most one retrieved result. Always resolves: a failure to
 * assess relevance means the post is written without a news angle.
 */
export async function selectRelevantNews(
  gemini: GeminiClient,
  input: SelectRelevantNewsInput,
): Promise<SelectRelevantNewsResult> {
  const { noteText, candidates } = input;
  if (candidates.length === 0) {
    return { item: null, reason: 'No news results were retrieved.' };
  }

  const list = candidates
    .map(
      (item, index) =>
        `[${index}] HEADLINE: ${item.headline}\n    PUBLICATION: ${item.publication}\n    PUBLISHED: ${
          item.publishedAt ?? 'unknown'
        }\n    DESCRIPTION: ${item.description ?? '(none)'}`,
    )
    .join('\n');

  try {
    const result = await gemini.generateJson({
      label: 'news-relevance',
      systemInstruction: SYSTEM_INSTRUCTION,
      prompt: `THE FOUNDER'S NOTE:\n"""\n${noteText}\n"""\n\nSEARCH RESULTS:\n${list}\n\nWhich result, if any, is genuinely relevant? Answer with relevant=false and index=null to use none of them.`,
      schema: newsRelevanceSchema,
      responseSchema: RESPONSE_SCHEMA as unknown as Record<string, unknown>,
      temperature: 0,
      // Budgets reasoning tokens as well as the visible output, so this is far
      // larger than the response needs on its own.
      maxOutputTokens: 1024,
    });

    const reason = result.reason ?? '';
    if (result.relevant !== true) return { item: null, reason };

    const index = result.index;
    if (typeof index !== 'number' || index < 0 || index >= candidates.length) {
      return { item: null, reason: reason || 'Model selected an index outside the result list.' };
    }
    return { item: candidates[index]!, reason };
  } catch {
    // Relevance is an optional enhancement; never let it fail the pipeline.
    return { item: null, reason: 'News relevance check was unavailable.' };
  }
}
