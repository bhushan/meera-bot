import { describeEnv } from '@/lib/env';
import { rootLogger } from '@/lib/logger';
import { getRuntime } from '@/lib/runtime';
import { generateRequestId } from '@/lib/util/id';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

interface CheckResult {
  ok: boolean;
  detail?: string;
}

/**
 * Liveness and dependency probe.
 *
 * Reports which subsystems are configured and whether the database answers.
 * Never returns a secret: `describeEnv` exposes only a bot id, a model name,
 * a Supabase project ref and the public base URL.
 */
export async function GET(): Promise<Response> {
  const requestId = generateRequestId();
  const logger = rootLogger.child({ requestId });
  const startedAt = Date.now();

  const checks: Record<string, CheckResult> = {};
  let env: ReturnType<typeof describeEnv> | null = null;
  let deps: ReturnType<typeof getRuntime> | null = null;

  try {
    deps = getRuntime();
    env = describeEnv(deps.env);
    checks.config = { ok: true };
  } catch (err) {
    // Surface which keys are wrong, never what they contain.
    const invalidKeys = (err as { invalidKeys?: string[] }).invalidKeys;
    checks.config = {
      ok: false,
      detail: invalidKeys ? `invalid keys: ${invalidKeys.join(', ')}` : 'configuration invalid',
    };
  }

  if (deps) {
    try {
      await deps.repo.ping();
      checks.database = { ok: true };
    } catch (err) {
      logger.error('health_database_unreachable', { err });
      checks.database = { ok: false, detail: 'database unreachable' };
    }

    try {
      const skill = await deps.repo.getActiveVoiceSkill();
      checks.voiceSkill = skill
        ? { ok: true, detail: `version ${skill.version}` }
        : { ok: false, detail: 'no active voice skill; run npm run db:seed-voice-skill' };
    } catch {
      checks.voiceSkill = { ok: false, detail: 'unavailable' };
    }
  }

  const ok = Object.values(checks).every((check) => check.ok);

  return Response.json(
    {
      ok,
      service: 'meera-bot',
      time: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      checks,
      ...(env ? { config: env } : {}),
      concurrency: deps ? { active: deps.guard.active, limit: deps.guard.limit } : undefined,
    },
    {
      status: ok ? 200 : 503,
      headers: { 'cache-control': 'no-store', 'x-request-id': requestId },
    },
  );
}
