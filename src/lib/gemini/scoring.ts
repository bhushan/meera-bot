import { z } from 'zod';
import type { GeminiClient } from './client';

/** A note scoring below this never reaches the drafting call. */
export const SCORE_THRESHOLD = 6;

export const meetsThreshold = (score: number): boolean => score >= SCORE_THRESHOLD;

export const noteScoreSchema = z.object({
  score: z.number().int().min(0).max(10),
  reason: z.string().trim().min(1).max(400),
  keywords: z.array(z.string().trim().min(1).max(60)).max(10),
});

export type NoteScore = z.infer<typeof noteScoreSchema>;

/** JSON Schema handed to Gemini so decoding is constrained to this exact shape. */
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'integer', minimum: 0, maximum: 10 },
    reason: { type: 'string' },
    keywords: { type: 'array', items: { type: 'string' }, minItems: 0, maxItems: 5 },
  },
  required: ['score', 'reason', 'keywords'],
} as const;

export interface PriorDecision {
  status: 'approved' | 'rejected';
  excerpt: string;
}

export interface ScoreNoteInput {
  noteText: string;
  priorDecisions?: PriorDecision[];
}

const SYSTEM_INSTRUCTION = `You are the editorial gatekeeper for a founder-led LinkedIn feed in the D2C skincare industry.
You judge whether a raw voice-note-style fragment is worth developing into a post. You are deliberately hard to impress.

Score each note from 0 to 10 against these criteria:
1. Clear, defensible point. Does the note assert something specific that could be argued with?
2. Specific evidence: a mechanism, a number, a measurement, a direct observation, or first-hand founder experience.
3. Relevance to skincare, formulation science, founder operations, customer education, or industry transparency.
4. Enough substance to sustain a useful LinkedIn post rather than a one-line remark.
5. Novelty relative to notes that were previously approved or rejected.
6. Safety: a note that requires making an unsupported medical diagnosis or giving treatment advice scores 0.

Guidance on the range:
- 0-3: a personal reminder, an errand, a logistics note, a fragment with no argument, or unsafe medical advice.
- 4-5: on topic but generic, unsupported, or already covered.
- 6-7: a real point with at least one concrete piece of evidence.
- 8-10: a specific, evidenced, non-obvious point that only this founder could make.

Return JSON only. "reason" is one concise sentence addressed to the founder explaining the score.
"keywords" holds three to five search terms drawn from the note. Each must be one to three words, the kind of short phrase someone would actually type into a news search ("contract manufacturing", "certificate of analysis", "skin barrier"), never a long descriptive phrase ("contract manufacturing quality control"), because a long phrase matches no articles. Return an empty array when the note does not merit a post.`;

const buildPrompt = (input: ScoreNoteInput): string => {
  const history = (input.priorDecisions ?? []).filter((d) => d.excerpt.trim().length > 0);
  const historyBlock =
    history.length === 0
      ? ''
      : `\n\nPREVIOUSLY REVIEWED NOTES (for novelty only, do not copy them):\n${history
          .map((d) => `- [${d.status}] ${d.excerpt}`)
          .join('\n')}`;

  return `Score the following note.${historyBlock}\n\nNOTE:\n"""\n${input.noteText}\n"""`;
};

/** Trim, lowercase, de-duplicate and cap keywords at the five the brief asks for. */
export function normaliseKeywords(keywords: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of keywords) {
    const keyword = raw.trim().toLowerCase().replace(/\s+/g, ' ');
    if (keyword.length === 0 || seen.has(keyword)) continue;
    seen.add(keyword);
    out.push(keyword);
    if (out.length === 5) break;
  }
  return out;
}

export async function scoreNote(gemini: GeminiClient, input: ScoreNoteInput): Promise<NoteScore> {
  const result = await gemini.generateJson({
    label: 'score',
    systemInstruction: SYSTEM_INSTRUCTION,
    prompt: buildPrompt(input),
    schema: noteScoreSchema,
    responseSchema: RESPONSE_SCHEMA as unknown as Record<string, unknown>,
    temperature: 0.1,
    // Budgets reasoning tokens as well as the visible output, so this is far
    // larger than the response needs on its own.
    maxOutputTokens: 2048,
  });

  return { ...result, keywords: normaliseKeywords(result.keywords) };
}
