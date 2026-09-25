/**
 * Insert `voice-skill.txt` as a voice skill version and make it the active one.
 *
 * Safe to run repeatedly: versions are keyed by content hash, so unchanged
 * content re-activates the existing row instead of creating a duplicate.
 */
import { loadScriptEnv } from './_shared';
import { createSupabaseClient, createSupabaseRepository } from '../src/lib/db/supabase-repository';
import { hashVoiceSkill, readVoiceSkillFile } from '../src/lib/voice/voice-skill';

async function main(): Promise<void> {
  const env = loadScriptEnv();
  const content = readVoiceSkillFile();
  const hash = hashVoiceSkill(content);

  const repo = createSupabaseRepository(
    createSupabaseClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY),
  );

  const before = await repo.getActiveVoiceSkill();
  const skill = await repo.activateVoiceSkill(content, hash);

  console.log('Active voice skill:');
  console.log(`  version:      ${skill.version}`);
  console.log(`  content_hash: ${skill.content_hash.slice(0, 12)}...`);
  console.log(`  characters:   ${skill.content.length}`);
  console.log(
    before?.id === skill.id
      ? '  change:       none (this version was already active)'
      : `  change:       activated (previous: ${before ? `version ${before.version}` : 'none'})`,
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
