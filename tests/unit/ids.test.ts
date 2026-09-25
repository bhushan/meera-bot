import { describe, it, expect } from 'vitest';
import { generateDraftShortId, generateRequestId } from '@/lib/util/id';
import { DRAFT_SHORT_ID_PATTERN } from '@/lib/telegram/parse';

describe('generateDraftShortId', () => {
  it('produces ids that match the shared draft id pattern', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateDraftShortId()).toMatch(DRAFT_SHORT_ID_PATTERN);
    }
  });

  it('never emits the visually ambiguous characters I, L, O or U', () => {
    const sample = Array.from({ length: 500 }, () => generateDraftShortId()).join('');
    expect(sample).not.toMatch(/[ILOU]/);
  });

  it('is effectively unique across a realistic volume of drafts', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => generateDraftShortId()));
    expect(ids.size).toBe(2000);
  });
});

describe('generateRequestId', () => {
  it('is prefixed and unique', () => {
    const a = generateRequestId();
    const b = generateRequestId();
    expect(a).toMatch(/^req_[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
  });
});
