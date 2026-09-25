import { describe, it, expect } from 'vitest';
import { escapeHtml, escapeMarkdownV2, chunkMessage } from '@/lib/telegram/format';

describe('escapeHtml', () => {
  it('escapes the characters Telegram HTML treats as markup', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
    expect(escapeHtml('<b>bold</b>')).toBe('&lt;b&gt;bold&lt;/b&gt;');
    expect(escapeHtml('say "hi"')).toBe('say &quot;hi&quot;');
  });

  it('escapes ampersands before angle brackets so entities are not double-built', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('neutralises an injection attempt inside a draft body', () => {
    const malicious = '<a href="https://evil.example">click</a>';
    const escaped = escapeHtml(malicious);
    expect(escaped).not.toContain('<a ');
    expect(escaped).toContain('&lt;a href=&quot;https://evil.example&quot;&gt;');
  });

  it('leaves plain prose and unicode untouched', () => {
    expect(escapeHtml('pH dropped 0.4 units — batch 14')).toBe('pH dropped 0.4 units — batch 14');
    expect(escapeHtml('')).toBe('');
  });
});

describe('escapeMarkdownV2', () => {
  it('escapes every character MarkdownV2 reserves', () => {
    expect(escapeMarkdownV2('a_b*c[d]e')).toBe('a\\_b\\*c\\[d\\]e');
    expect(escapeMarkdownV2('1. point!')).toBe('1\\. point\\!');
    expect(escapeMarkdownV2('a+b=c|d{e}f')).toBe('a\\+b\\=c\\|d\\{e\\}f');
    expect(escapeMarkdownV2('pre`code`')).toBe('pre\\`code\\`');
    expect(escapeMarkdownV2('back\\slash')).toBe('back\\\\slash');
    expect(escapeMarkdownV2('~strike~ >quote #tag -dash .dot')).toBe(
      '\\~strike\\~ \\>quote \\#tag \\-dash \\.dot',
    );
  });

  it('leaves unreserved characters alone', () => {
    expect(escapeMarkdownV2('batch 14 pH 5.0')).toBe('batch 14 pH 5\\.0');
  });
});

describe('chunkMessage', () => {
  it('returns a single chunk when the text fits', () => {
    expect(chunkMessage('short', 4096)).toEqual(['short']);
  });

  it('splits oversized text into chunks within the limit', () => {
    const text = Array.from({ length: 400 }, (_, i) => `paragraph number ${i}`).join('\n\n');
    const chunks = chunkMessage(text, 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(500);
    expect(chunks.join('\n\n').replace(/\s+/g, ' ')).toContain('paragraph number 399');
  });

  it('splits a single unbroken run that exceeds the limit', () => {
    const chunks = chunkMessage('x'.repeat(1000), 300);
    expect(chunks.length).toBe(4);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(300);
    expect(chunks.join('')).toBe('x'.repeat(1000));
  });

  it('never emits an empty chunk', () => {
    for (const chunk of chunkMessage('a\n\n\n\nb', 4)) expect(chunk.length).toBeGreaterThan(0);
  });
});
