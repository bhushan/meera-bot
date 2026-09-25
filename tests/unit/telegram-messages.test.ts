import { describe, it, expect } from 'vitest';
import {
  buildDraftMessage,
  buildRejectionMessage,
  buildNewsReviewBlock,
  buildUnsupportedMediaMessage,
  buildFailureMessage,
  buildReviewConfirmation,
  buildUnknownDraftMessage,
  reviewKeyboard,
} from '@/lib/telegram/messages';
import type { NewsItem } from '@/lib/news/types';

const NEWS: NewsItem = {
  headline: 'Preservative supply shifts hit small brands',
  publication: 'Cosmetics Business',
  publishedAt: '2026-09-22T09:00:00.000Z',
  url: 'https://news.example/preservative-supply?a=1&b=2',
  description: 'Reformulations ripple through contract manufacturing.',
};

const BODY = 'Batch fourteen came back with a measured pH shift of about 0.4 units.';

describe('buildNewsReviewBlock', () => {
  it('renders the four required lines in the required order', () => {
    const block = buildNewsReviewBlock(NEWS);
    const lines = block.split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('NEWS SOURCE: Preservative supply shifts hit small brands');
    expect(lines[1]).toBe('FROM: Cosmetics Business | 2026-09-22');
    expect(lines[2]).toBe('LINK: https://news.example/preservative-supply?a=1&amp;b=2');
    expect(lines[3]).toBe('CHECK BEFORE PUBLISHING: You are the author of this claim.');
  });

  it('escapes HTML in every interpolated field', () => {
    const block = buildNewsReviewBlock({
      ...NEWS,
      headline: '<script>alert(1)</script>',
      publication: 'A & B',
    });
    expect(block).not.toContain('<script>');
    expect(block).toContain('&lt;script&gt;');
    expect(block).toContain('A &amp; B');
  });

  it('says unknown rather than inventing a date when the feed had none', () => {
    expect(buildNewsReviewBlock({ ...NEWS, publishedAt: null })).toContain(
      'FROM: Cosmetics Business | unknown',
    );
  });
});

describe('buildDraftMessage', () => {
  const base = {
    shortId: 'AB12CD',
    score: 8,
    scoreReason: 'Specific manufacturing observation with a measured pH shift.',
    body: BODY,
    newsItem: null,
    uncertaintyNote: null,
  };

  it('leads with the draft id and the score', () => {
    const text = buildDraftMessage(base);
    expect(text).toContain('DRAFT AB12CD');
    expect(text).toContain('SCORE: 8/10');
    expect(text).toContain('Specific manufacturing observation');
  });

  it('includes the draft body', () => {
    expect(buildDraftMessage(base)).toContain(BODY);
  });

  it('omits the news block when no news was used', () => {
    expect(buildDraftMessage(base)).not.toContain('NEWS SOURCE:');
    expect(buildDraftMessage(base)).not.toContain('CHECK BEFORE PUBLISHING');
  });

  it('appends the exact news block when news was used', () => {
    const text = buildDraftMessage({ ...base, newsItem: NEWS });
    expect(text).toContain(buildNewsReviewBlock(NEWS));
  });

  it('escapes HTML in the draft body so a model cannot inject markup', () => {
    const text = buildDraftMessage({ ...base, body: 'A <b>bold</b> claim & a caveat' });
    expect(text).toContain('A &lt;b&gt;bold&lt;/b&gt; claim &amp; a caveat');
    expect(text).not.toContain('<b>bold</b>');
  });

  it('spells out both review routes', () => {
    const text = buildDraftMessage(base);
    expect(text).toContain('APPROVE AB12CD');
    expect(text).toContain('REJECT AB12CD');
  });

  it('surfaces an uncertainty note when the model flagged one', () => {
    const text = buildDraftMessage({
      ...base,
      uncertaintyNote: 'The 0.4 figure is from one batch.',
    });
    expect(text).toContain('The 0.4 figure is from one batch.');
  });
});

describe('reviewKeyboard', () => {
  it('offers exactly one Approve and one Reject button bound to the draft', () => {
    const keyboard = reviewKeyboard('AB12CD');
    expect(keyboard).toEqual([
      [
        { text: 'Approve', callbackData: 'rv:a:AB12CD' },
        { text: 'Reject', callbackData: 'rv:r:AB12CD' },
      ],
    ]);
    for (const row of keyboard) {
      for (const button of row) {
        expect(Buffer.byteLength(button.callbackData, 'utf8')).toBeLessThanOrEqual(64);
      }
    }
  });
});

describe('other messages', () => {
  it('explains a low-score rejection with the score and the reason, and creates no draft', () => {
    const text = buildRejectionMessage({ score: 3, reason: 'This is a personal reminder.' });
    expect(text).toContain('3/10');
    expect(text).toContain('This is a personal reminder.');
    expect(text).toMatch(/no draft/i);
  });

  it('escapes the rejection reason', () => {
    expect(buildRejectionMessage({ score: 2, reason: '<i>nope</i>' })).toContain('&lt;i&gt;');
  });

  it('tells the sender that only text is supported', () => {
    const text = buildUnsupportedMediaMessage('voice');
    expect(text).toMatch(/text/i);
    expect(text).toContain('voice');
  });

  it('gives a user-safe failure message that names no internals', () => {
    const text = buildFailureMessage('req_abc123');
    expect(text).toMatch(/could not|failed|unable/i);
    expect(text).toContain('req_abc123');
    expect(text).not.toMatch(/supabase|gemini|stack|postgres/i);
  });

  it('confirms a fresh decision and an already-applied one differently', () => {
    const fresh = buildReviewConfirmation({ shortId: 'AB12CD', status: 'approved', changed: true });
    const repeat = buildReviewConfirmation({
      shortId: 'AB12CD',
      status: 'approved',
      changed: false,
    });
    expect(fresh).toContain('AB12CD');
    expect(fresh).toMatch(/approved/i);
    expect(repeat).toMatch(/already/i);
    expect(fresh).not.toMatch(/already/i);
  });

  it('never claims anything was published to LinkedIn', () => {
    const all = [
      buildDraftMessage({
        shortId: 'AB12CD',
        score: 8,
        scoreReason: 'x',
        body: BODY,
        newsItem: NEWS,
        uncertaintyNote: null,
      }),
      buildReviewConfirmation({ shortId: 'AB12CD', status: 'approved', changed: true }),
    ].join('\n');
    expect(all).not.toMatch(/publish(ed|ing) to linkedin|posted to linkedin|scheduled/i);
  });

  it('reports an unknown draft id without leaking whether other ids exist', () => {
    const text = buildUnknownDraftMessage('ZZZZZZ');
    expect(text).toContain('ZZZZZZ');
    expect(text).toMatch(/not found|no draft/i);
  });
});
