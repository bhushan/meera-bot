/** A news result we actually retrieved from the RSS feed. Never model-invented. */
export interface NewsItem {
  headline: string;
  publication: string;
  /** ISO-8601 UTC, or null when the feed omitted a parseable pubDate. */
  publishedAt: string | null;
  url: string;
  /**
   * The RSS `<description>` only. We never fetch the article body, so nothing
   * downstream may claim the article was read.
   */
  description: string | null;
}
