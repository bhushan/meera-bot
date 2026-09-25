import { randomBytes, randomUUID } from 'node:crypto';

/** Crockford base32 without I, L, O and U so ids are unambiguous when retyped. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const SHORT_ID_LENGTH = 6;

/**
 * Human-retypable draft id. 32^6 ~= 1.07e9 values; collisions are additionally
 * guarded by a UNIQUE constraint on `drafts.short_id`.
 */
export function generateDraftShortId(): string {
  const bytes = randomBytes(SHORT_ID_LENGTH);
  let out = '';
  for (let i = 0; i < SHORT_ID_LENGTH; i += 1) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

export function generateRequestId(): string {
  return `req_${randomBytes(8).toString('hex')}`;
}

export const newUuid = (): string => randomUUID();
