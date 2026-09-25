import { describe, it, expect, vi } from 'vitest';
import {
  buildGoogleNewsUrl,
  parseRssFeed,
  searchGoogleNews,
  newsQueryFromKeywords,
} from '@/lib/news/rss';
import { createLogger } from '@/lib/logger';

const silent = createLogger({}, () => {});
const NOW = new Date('2026-09-25T12:00:00.000Z');

const feed = (items: string) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Google News</title>${items}</channel></rss>`;

const item = (opts: {
  title: string;
  link: string;
  pubDate: string;
  source?: string;
  sourceUrl?: string;
  description?: string;
}) => `<item>
  <title>${opts.title}</title>
  <link>${opts.link}</link>
  <guid isPermaLink="false">abc123</guid>
  <pubDate>${opts.pubDate}</pubDate>
  <description>${opts.description ?? ''}</description>
  ${opts.source ? `<source url="${opts.sourceUrl ?? 'https://pub.example'}">${opts.source}</source>` : ''}
</item>`;

const RECENT = item({
  title: 'Preservative supply shifts hit small skincare brands - Cosmetics Business',
  link: 'https://news.google.com/rss/articles/recent',
  pubDate: 'Mon, 22 Sep 2026 09:00:00 GMT',
  source: 'Cosmetics Business',
  description:
    '&lt;a href="https://x"&gt;Preservative supply shifts&lt;/a&gt;&nbsp;&nbsp;Cosmetics Business',
});

const STALE = item({
  title: 'Old news about cartons - Packaging Weekly',
  link: 'https://news.google.com/rss/articles/stale',
  pubDate: 'Tue, 01 Jan 2019 09:00:00 GMT',
  source: 'Packaging Weekly',
});

describe('newsQueryFromKeywords / buildGoogleNewsUrl', () => {
  it('joins keywords into a quoted OR-free query', () => {
    expect(newsQueryFromKeywords(['preservative', 'pH stability'])).toBe(
      'preservative "pH stability"',
    );
  });

  it('drops empty keywords and caps the query length', () => {
    const query = newsQueryFromKeywords(['  ', 'a'.repeat(300), 'ph']);
    expect(query).not.toContain('  ');
    expect(query.length).toBeLessThanOrEqual(200);
  });

  it('builds a Google News RSS search URL with the query encoded', () => {
    const url = new URL(buildGoogleNewsUrl('preservative "pH stability"'));
    expect(url.origin).toBe('https://news.google.com');
    expect(url.pathname).toBe('/rss/search');
    expect(url.searchParams.get('q')).toBe('preservative "pH stability"');
    expect(url.searchParams.get('hl')).toBeTruthy();
  });
});

describe('parseRssFeed', () => {
  it('extracts headline, publication, date, url and description', () => {
    const items = parseRssFeed(feed(RECENT), { now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      headline: 'Preservative supply shifts hit small skincare brands',
      publication: 'Cosmetics Business',
      publishedAt: '2026-09-22T09:00:00.000Z',
      url: 'https://news.google.com/rss/articles/recent',
      description: 'Preservative supply shifts  Cosmetics Business',
    });
  });

  it('strips the " - Publication" suffix Google appends to titles', () => {
    const items = parseRssFeed(feed(RECENT), { now: NOW });
    expect(items[0]!.headline).not.toContain('Cosmetics Business');
  });

  it('drops items older than the freshness window', () => {
    expect(parseRssFeed(feed(RECENT + STALE), { now: NOW, maxAgeDays: 30 })).toHaveLength(1);
    expect(parseRssFeed(feed(STALE), { now: NOW, maxAgeDays: 30 })).toHaveLength(0);
  });

  it('drops items with a future publication date', () => {
    const future = item({
      title: 'Tomorrow - Pub',
      link: 'https://news.google.com/rss/articles/future',
      pubDate: 'Fri, 25 Dec 2099 09:00:00 GMT',
      source: 'Pub',
    });
    expect(parseRssFeed(feed(future), { now: NOW })).toHaveLength(0);
  });

  it('drops items with an unparseable or missing date rather than guessing', () => {
    const undated = item({
      title: 'No date - Pub',
      link: 'https://news.google.com/rss/articles/undated',
      pubDate: 'not a date',
      source: 'Pub',
    });
    expect(parseRssFeed(feed(undated), { now: NOW })).toHaveLength(0);
  });

  it('drops items with a missing or non-http link', () => {
    const bad = item({
      title: 'Bad link - Pub',
      link: 'javascript:alert(1)',
      pubDate: 'Mon, 22 Sep 2026 09:00:00 GMT',
      source: 'Pub',
    });
    expect(parseRssFeed(feed(bad), { now: NOW })).toHaveLength(0);
  });

  it('handles a feed with a single item not wrapped in an array', () => {
    expect(parseRssFeed(feed(RECENT), { now: NOW })).toHaveLength(1);
  });

  it('returns an empty list for a feed with no items', () => {
    expect(parseRssFeed(feed(''), { now: NOW })).toEqual([]);
  });

  it('returns an empty list for malformed XML instead of throwing', () => {
    expect(parseRssFeed('<rss><channel><item>', { now: NOW })).toEqual([]);
    expect(parseRssFeed('not xml at all', { now: NOW })).toEqual([]);
    expect(parseRssFeed('', { now: NOW })).toEqual([]);
  });

  it('refuses an oversized payload rather than parsing it', () => {
    expect(parseRssFeed('x'.repeat(3_000_000), { now: NOW })).toEqual([]);
  });

  it('does not expand external entities', () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
      <rss><channel>${item({
        title: '&xxe; - Pub',
        link: 'https://news.google.com/rss/articles/x',
        pubDate: 'Mon, 22 Sep 2026 09:00:00 GMT',
        source: 'Pub',
      })}</channel></rss>`;
    const items = parseRssFeed(xxe, { now: NOW });
    for (const parsed of items) expect(parsed.headline).not.toContain('root:');
  });

  it('caps the number of items returned', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      item({
        title: `Headline ${i} - Pub`,
        link: `https://news.google.com/rss/articles/${i}`,
        pubDate: 'Mon, 22 Sep 2026 09:00:00 GMT',
        source: 'Pub',
      }),
    ).join('');
    expect(parseRssFeed(feed(many), { now: NOW, maxResults: 5 })).toHaveLength(5);
  });
});

describe('searchGoogleNews', () => {
  const xmlResponse = (body: string) =>
    new Response(body, { status: 200, headers: { 'content-type': 'application/rss+xml' } });

  it('returns parsed items on success', async () => {
    const fetchImpl = vi.fn(async () => xmlResponse(feed(RECENT))) as unknown as typeof fetch;
    const result = await searchGoogleNews({
      keywords: ['preservative'],
      fetchImpl,
      logger: silent,
      now: NOW,
    });
    expect(result.outcome).toBe('ok');
    expect(result.items).toHaveLength(1);
  });

  it('reports "empty" when the feed has no usable items', async () => {
    const fetchImpl = vi.fn(async () => xmlResponse(feed(STALE))) as unknown as typeof fetch;
    const result = await searchGoogleNews({
      keywords: ['cartons'],
      fetchImpl,
      logger: silent,
      now: NOW,
    });
    expect(result.outcome).toBe('empty');
    expect(result.items).toEqual([]);
  });

  it('reports "empty" when there are no keywords to search with', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await searchGoogleNews({ keywords: [], fetchImpl, logger: silent, now: NOW });
    expect(result.outcome).toBe('empty');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('degrades to "timeout" instead of throwing when the feed hangs', async () => {
    const fetchImpl = vi.fn(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    ) as unknown as typeof fetch;

    const result = await searchGoogleNews({
      keywords: ['preservative'],
      fetchImpl,
      logger: silent,
      now: NOW,
      timeoutMs: 10,
    });
    expect(result.outcome).toBe('timeout');
    expect(result.items).toEqual([]);
  });

  it('degrades to "error" on a non-200 response', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('nope', { status: 503 }),
    ) as unknown as typeof fetch;
    const result = await searchGoogleNews({
      keywords: ['preservative'],
      fetchImpl,
      logger: silent,
      now: NOW,
    });
    expect(result.outcome).toBe('error');
    expect(result.items).toEqual([]);
  });

  it('degrades to "error" when the network call rejects', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ENOTFOUND');
    }) as unknown as typeof fetch;
    const result = await searchGoogleNews({
      keywords: ['preservative'],
      fetchImpl,
      logger: silent,
      now: NOW,
    });
    expect(result.outcome).toBe('error');
  });
});
