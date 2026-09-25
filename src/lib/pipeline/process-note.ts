import { createHash } from 'node:crypto';
import { describeError } from '../errors';
import { draftPost } from '../gemini/drafting';
import { meetsThreshold, scoreNote } from '../gemini/scoring';
import { newsQueryFromKeywords } from '../news/rss';
import type { NewsItem } from '../news/types';
import { selectRelevantNews } from '../news/relevance';
import type { ParsedNote } from '../telegram/parse';
import {
  buildDraftMessage,
  buildFailureMessage,
  buildRejectionMessage,
  reviewKeyboard,
} from '../telegram/messages';
import { generateDraftShortId } from '../util/id';
import { loadActiveVoiceSkill } from '../voice/voice-skill';
import type { PipelineDeps } from './deps';

export type ProcessNoteOutcome =
  | { status: 'rejected'; noteId: string; score: number }
  | { status: 'drafted'; noteId: string; draftShortId: string; score: number; usedNews: boolean }
  | { status: 'failed'; noteId: string | null; reason: string };

const queryHash = (query: string): string =>
  createHash('sha256').update(query, 'utf8').digest('hex').slice(0, 40);

/**
 * Find an optional news angle. Never throws: news is an enhancement, and a failed
 * search simply produces a draft written from the note alone.
 */
async function findNewsAngle(
  deps: PipelineDeps,
  noteText: string,
  keywords: string[],
): Promise<NewsItem | null> {
  const { repo, gemini, logger, config, searchNews, now } = deps;

  const query = newsQueryFromKeywords(keywords);
  if (query.length === 0) return null;
  const hash = queryHash(query);

  let candidates: NewsItem[] | null = null;
  try {
    candidates = await repo.getCachedNews(hash);
  } catch (err) {
    logger.warn('news_cache_read_failed', { err });
  }

  if (candidates) {
    logger.info('news_cache_hit', { query, count: candidates.length });
  } else {
    const result = await searchNews({
      keywords,
      logger,
      timeoutMs: config.newsTimeoutMs,
      now: now(),
    });
    logger.info('news_search', {
      query: result.query,
      outcome: result.outcome,
      count: result.items.length,
    });

    // Cache both hits and confirmed misses; never cache a transport failure.
    if (result.outcome === 'ok' || result.outcome === 'empty') {
      try {
        await repo.putCachedNews(hash, result.query, result.items, config.newsCacheTtlSeconds);
      } catch (err) {
        logger.warn('news_cache_write_failed', { err });
      }
    }
    candidates = result.items;
  }

  if (candidates.length === 0) return null;

  const selection = await selectRelevantNews(gemini, { noteText, candidates });
  logger.info('news_relevance', {
    selected: selection.item !== null,
    url: selection.item?.url ?? null,
  });
  return selection.item;
}

/**
 * The full note pipeline: store, score, optionally find news, draft, persist as
 * pending, and hand the draft back to Telegram for a human decision.
 *
 * Nothing here publishes anywhere. The only outputs are database rows and a
 * Telegram message carrying Approve/Reject controls.
 */
export async function processNote(
  deps: PipelineDeps,
  note: ParsedNote,
): Promise<ProcessNoteOutcome> {
  const { repo, gemini, telegram, logger, config } = deps;
  let noteId: string | null = null;

  try {
    // 1. Persist the raw note before any AI call so nothing is ever lost.
    const stored = await repo.storeNote({
      updateId: note.updateId,
      chatId: note.chatId,
      messageId: note.messageId,
      rawText: note.text,
      receivedAt: note.receivedAt,
    });
    noteId = stored.id;
    logger.info('note_stored', { noteId, chatId: note.chatId, messageId: note.messageId });

    // 2. Score it.
    await repo.setNoteStatus(noteId, 'scoring');
    let priorDecisions: Awaited<ReturnType<typeof repo.getRecentDecisions>> = [];
    try {
      priorDecisions = await repo.getRecentDecisions(config.recentDecisionsLimit);
    } catch (err) {
      logger.warn('recent_decisions_unavailable', { err });
    }

    const score = await scoreNote(gemini, { noteText: note.text, priorDecisions });
    logger.info('note_scored', { noteId, score: score.score, keywords: score.keywords });

    if (!meetsThreshold(score.score)) {
      await repo.setNoteScore(noteId, {
        score: score.score,
        reason: score.reason,
        keywords: score.keywords,
        status: 'rejected_low_score',
      });
      await telegram.sendMessage({
        chatId: note.chatId,
        text: buildRejectionMessage({ score: score.score, reason: score.reason }),
        replyToMessageId: note.messageId,
      });
      await repo.setUpdateStatus(note.updateId, 'done');
      logger.info('note_rejected_low_score', { noteId, score: score.score });
      return { status: 'rejected', noteId, score: score.score };
    }

    await repo.setNoteScore(noteId, {
      score: score.score,
      reason: score.reason,
      keywords: score.keywords,
      status: 'scored',
    });

    // 3. Optional news angle.
    const newsItem = await findNewsAngle(deps, note.text, score.keywords);

    // 4. Draft in her voice, always with the active versioned voice skill.
    await repo.setNoteStatus(noteId, 'drafting');
    const voiceSkill = await loadActiveVoiceSkill(repo, logger);
    const draft = await draftPost(gemini, {
      noteText: note.text,
      voiceSkill: voiceSkill.content,
      newsItem,
    });

    // 5. Store as pending, atomically with the note's status flip.
    const shortId = generateDraftShortId();
    const draftRow = await repo.createDraft({
      noteId,
      shortId,
      voiceSkillId: voiceSkill.id,
      body: draft.body,
      geminiModel: gemini.model,
      usedNews: draft.usedNews,
      newsItem: draft.newsItem,
      uncertaintyNote: draft.uncertaintyNote,
    });
    logger.info('draft_created', {
      noteId,
      draftId: draftRow.id,
      shortId: draftRow.short_id,
      usedNews: draft.usedNews,
      voiceSkillVersion: voiceSkill.version,
    });

    // 6. Hand it to the human.
    const sent = await telegram.sendMessage({
      chatId: note.chatId,
      text: buildDraftMessage({
        shortId: draftRow.short_id,
        score: score.score,
        scoreReason: score.reason,
        body: draft.body,
        newsItem: draft.newsItem,
        uncertaintyNote: draft.uncertaintyNote,
      }),
      inlineKeyboard: reviewKeyboard(draftRow.short_id),
      disableLinkPreview: true,
    });
    await repo.setDraftTelegramMessageId(draftRow.id, sent.messageId);
    await repo.setUpdateStatus(note.updateId, 'done');

    return {
      status: 'drafted',
      noteId,
      draftShortId: draftRow.short_id,
      score: score.score,
      usedNews: draft.usedNews,
    };
  } catch (err) {
    const reason = describeError(err);
    logger.error('note_pipeline_failed', { noteId, updateId: note.updateId, err });

    // Best-effort bookkeeping: a failure here must not mask the original error.
    try {
      if (noteId) await repo.setNoteStatus(noteId, 'failed', reason);
      await repo.setUpdateStatus(note.updateId, 'dead_letter', reason);
    } catch (bookkeepingError) {
      logger.error('failure_bookkeeping_failed', { err: bookkeepingError });
    }

    try {
      await telegram.sendMessage({
        chatId: note.chatId,
        text: buildFailureMessage(config.requestId),
        replyToMessageId: note.messageId,
      });
    } catch (notifyError) {
      logger.error('failure_notification_failed', { err: notifyError });
    }

    return { status: 'failed', noteId, reason };
  }
}
