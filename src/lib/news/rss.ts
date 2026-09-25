import { XMLParser } from 'fast-xml-parser';
import type { Logger } from '../logger';
import { withTimeout } from '../util/timeout';
import type { NewsItem } from './types';

/** Refuse to parse anything implausibly large before handing it to the XML parser. */
const MAX_FEED_BYTES = 2_000_000;
const DEFAULT_MAX_AGE_DAYS = 30;
const DEFAULT_MAX_RESULTS = 6;
const MAX_QUERY_LENGTH = 200;

/** Build a Google News search query from validated keywords. Multi-word terms are quoted. */
export function newsQueryFromKeywords(keywords: string[]): string {
  const terms: string[] = [];
  for (const raw of keywords) {
    const keyword = raw.trim().replace(/["\\]/g, '').replace(/\s+/g, ' ');
    if (keyword.length === 0 || keyword.length > 60) continue;
    terms.push(keyword.includes(' ') ? `"${keyword}"` : keyword);
  }
  let query = terms.join(' ');
  if (query.length > MAX_QUERY_LENGTH) query = query.slice(0, MAX_QUERY_LENGTH).trimEnd();
  return query;
}

export function buildGoogleNewsUrl(query: string): string {
  const url = new URL('https://news.google.com/rss/search');
  url.searchParams.set('q', query);
  url.searchParams.set('hl', 'en-IN');
  url.searchParams.set('gl', 'IN');
  url.searchParams.set('ceid', 'IN:en');
  return url.toString();
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  // fast-xml-parser resolves only the five predefined XML entities and never
  // dereferences DTD/external entities, so a crafted feed cannot read local files.
  processEntities: true,
});

const asArray = <T>(value: T | T[] | undefined): T[] => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

/** RSS descriptions from Google News contain HTML. Reduce them to plain text. */
const toPlainText = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const text = value
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
  return text.length > 0 ? text.slice(0, 500) : null;
};

const textOf = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (value && typeof value === 'object' && '#text' in value) {
    return String((value as { '#text': unknown })['#text'] ?? '').trim();
  }
  return '';
};

export interface ParseRssOptions {
  now: Date;
  maxAgeDays?: number;
  maxResults?: number;
}

/**
 * Parse a Google News RSS document into {@link NewsItem}s.
 * Never throws: an unusable feed is an absent news angle, not a pipeline failure.
 */
export function parseRssFeed(xml: string, options: ParseRssOptions): NewsItem[] {
  const { now, maxAgeDays = DEFAULT_MAX_AGE_DAYS, maxResults = DEFAULT_MAX_RESULTS } = options;
  if (typeof xml !== 'string' || xml.length === 0 || xml.length > MAX_FEED_BYTES) return [];

  let parsed: unknown;
  try {
    parsed = parser.parse(xml);
  } catch {
    return [];
  }

  const channel = (parsed as { rss?: { channel?: unknown } })?.rss?.channel;
  if (!channel || typeof channel !== 'object') return [];

  const rawItems = asArray((channel as { item?: unknown }).item) as Record<string, unknown>[];
  const cutoff = now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000;

  const items: NewsItem[] = [];
  for (const raw of rawItems) {
    if (items.length >= maxResults) break;
    if (!raw || typeof raw !== 'object') continue;

    const url = textOf(raw.link);
    if (!/^https?:\/\//i.test(url)) continue;

    const published = new Date(textOf(raw.pubDate));
    const publishedMs = published.getTime();
    // An item with no parseable date cannot be shown to be recent, so we drop it
    // rather than presenting an unknown-age story as current context.
    if (!Number.isFinite(publishedMs)) continue;
    if (publishedMs < cutoff || publishedMs > now.getTime()) continue;

    const sourceNode = raw.source;
    const publication =
      textOf(sourceNode) ||
      (() => {
        const title = textOf(raw.title);
        const dash = title.lastIndexOf(' - ');
        return dash > 0 ? title.slice(dash + 3) : 'Unknown publication';
      })();

    let headline = textOf(raw.title);
    if (publication && headline.endsWith(` - ${publication}`)) {
      headline = headline.slice(0, -(publication.length + 3)).trim();
    }
    if (headline.length === 0) continue;

    items.push({
      headline: headline.slice(0, 300),
      publication: publication.slice(0, 120),
      publishedAt: published.toISOString(),
      url,
      description: toPlainText(raw.description),
    });
  }

  return items;
}

export type NewsSearchOutcome = 'ok' | 'empty' | 'timeout' | 'error';

export interface NewsSearchResult {
  items: NewsItem[];
  outcome: NewsSearchOutcome;
  query: string;
}

export interface SearchGoogleNewsOptions {
  keywords: string[];
  logger: Logger;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAgeDays?: number;
  maxResults?: number;
  now?: Date;
}

/**
 * Query Google News RSS. Always resolves: a failed, slow or empty search simply
 * means the draft is written without a news angle.
 */
export async function searchGoogleNews(
  options: SearchGoogleNewsOptions,
): Promise<NewsSearchResult> {
  const {
    keywords,
    logger,
    fetchImpl = fetch,
    timeoutMs = 6000,
    maxAgeDays,
    maxResults,
    now = new Date(),
  } = options;

  const query = newsQueryFromKeywords(keywords);
  if (query.length === 0) {
    return { items: [], outcome: 'empty', query };
  }

  try {
    const response = await withTimeout(
      (signal) =>
        fetchImpl(buildGoogleNewsUrl(query), {
          signal,
          headers: { accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8' },
        }),
      { ms: timeoutMs, label: 'news.rss' },
    );

    if (!response.ok) {
      logger.warn('news_rss_http_error', { status: response.status, query });
      return { items: [], outcome: 'error', query };
    }

    const xml = await response.text();
    const items = parseRssFeed(xml, {
      now,
      ...(maxAgeDays !== undefined ? { maxAgeDays } : {}),
      ...(maxResults !== undefined ? { maxResults } : {}),
    });

    return { items, outcome: items.length > 0 ? 'ok' : 'empty', query };
  } catch (err) {
    const timedOut =
      typeof err === 'object' && err !== null && (err as { kind?: string }).kind === 'timeout';
    logger.warn('news_rss_unavailable', { query, timedOut, err });
    return { items: [], outcome: timedOut ? 'timeout' : 'error', query };
  }
}
