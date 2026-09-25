import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { AppError } from '../errors';
import type { Repository } from '../db/repository';
import type { VoiceSkillRow } from '../db/types';
import type { Logger } from '../logger';

export const VOICE_SKILL_FILENAME = 'voice-skill.txt';

/** Content hash doubles as the version identity of a voice skill. */
export function hashVoiceSkill(content: string): string {
  return createHash('sha256').update(content.trim(), 'utf8').digest('hex');
}

/**
 * Read the versioned voice profile from disk. `next.config.ts` traces this file
 * into the webhook bundle so it is present in the serverless runtime too.
 */
export function readVoiceSkillFile(cwd: string = process.cwd()): string {
  const content = readFileSync(path.join(cwd, VOICE_SKILL_FILENAME), 'utf8').trim();
  if (content.length === 0) {
    throw new AppError({
      kind: 'config',
      message: `${VOICE_SKILL_FILENAME} is empty`,
      retryable: false,
    });
  }
  return content;
}

/**
 * The active voice skill, which every drafting call must use.
 *
 * The database is the source of record because `drafts.voice_skill_id` is a
 * foreign key, so each draft is permanently tied to the exact profile version
 * that produced it. If no row is active yet (a fresh project where the seed
 * command was not run), seed it from the file rather than failing the note.
 */
export async function loadActiveVoiceSkill(
  repo: Repository,
  logger: Logger,
  readFile: () => string = readVoiceSkillFile,
): Promise<VoiceSkillRow> {
  const existing = await repo.getActiveVoiceSkill();
  if (existing) return existing;

  logger.warn('voice_skill_missing_seeding_from_file', { filename: VOICE_SKILL_FILENAME });
  const content = readFile();
  const seeded = await repo.activateVoiceSkill(content, hashVoiceSkill(content));
  logger.info('voice_skill_seeded', { version: seeded.version });
  return seeded;
}
