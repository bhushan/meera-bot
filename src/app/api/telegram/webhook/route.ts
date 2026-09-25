import { after } from 'next/server';
import { getRuntime } from '@/lib/runtime';
import { rootLogger } from '@/lib/logger';
import { generateRequestId } from '@/lib/util/id';
import { TELEGRAM_SECRET_HEADER } from '@/lib/telegram/verify';
import { handleTelegramWebhook } from '@/lib/webhook/handle';
import { DEFAULT_PIPELINE_CONFIG, type PipelineDeps } from '@/lib/pipeline/deps';
import { processNote } from '@/lib/pipeline/process-note';
import { handleReview } from '@/lib/pipeline/review';
import type { ParsedUpdate } from '@/lib/telegram/parse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Telegram gives us ~60s before it retries; `after()` work counts against this. */
export const maxDuration = 60;

/** Per-chat sliding window. Meera sends two or three notes a week, so this is generous. */
const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_MAX_EVENTS = 20;

export async function POST(request: Request): Promise<Response> {
  const requestId = generateRequestId();
  const logger = rootLogger.child({ requestId });

  let deps;
  try {
    deps = getRuntime();
  } catch (err) {
    // Misconfiguration must fail loudly in logs but say nothing useful on the wire.
    logger.error('runtime_configuration_invalid', { err });
    return Response.json({ ok: false, error: 'misconfigured' }, { status: 500 });
  }

  const rawBody = await request.text();

  const pipelineDeps: PipelineDeps = {
    repo: deps.repo,
    gemini: deps.gemini,
    telegram: deps.telegram,
    logger,
    config: { ...DEFAULT_PIPELINE_CONFIG, requestId },
    searchNews: deps.searchNews,
    now: () => new Date(),
  };

  const result = await handleTelegramWebhook(
    {
      repo: deps.repo,
      telegram: deps.telegram,
      logger,
      config: {
        allowedChatId: deps.env.TELEGRAM_ALLOWED_CHAT_ID,
        webhookSecret: deps.env.TELEGRAM_WEBHOOK_SECRET,
        rateLimitWindowSeconds: RATE_LIMIT_WINDOW_SECONDS,
        rateLimitMaxEvents: RATE_LIMIT_MAX_EVENTS,
      },
      guard: deps.guard,
      // `after()` runs the pipeline once the response has been flushed, so Telegram
      // sees a fast 200 and never retries a note that is already being processed.
      schedule: (work) => {
        after(work);
      },
      dispatch: async (parsed: ParsedUpdate) => {
        if (parsed.kind === 'note') {
          await processNote(pipelineDeps, parsed);
          return;
        }
        if (parsed.kind === 'review_command' || parsed.kind === 'review_callback') {
          await handleReview(pipelineDeps, parsed);
        }
      },
    },
    { rawBody, secretHeader: request.headers.get(TELEGRAM_SECRET_HEADER) },
  );

  return Response.json(result.body, {
    status: result.status,
    headers: { 'x-request-id': requestId, 'cache-control': 'no-store' },
  });
}

/** Telegram only ever POSTs. Anything else is a probe. */
export function GET(): Response {
  return Response.json({ ok: false, error: 'method_not_allowed' }, { status: 405 });
}
