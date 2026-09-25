# meera-bot

A private Telegram assistant that turns Meera Pillai's raw skincare notes into LinkedIn drafts in her own voice, and stops at a human review gate.

**It never publishes to LinkedIn and never schedules anything.** Approval marks a row in Postgres and hands the post back as a copy-ready block. Meera does the posting.

```
Telegram note  ->  score 0-10  ->  (optional news angle)  ->  draft in her voice
                        |
                    below 6: stop, explain why
                                                         ->  Telegram: Approve / Reject
                                                                        |
                                                            Supabase records the decision
                                                                        |
                                                            approved: the post comes back
                                                            on its own, ready to copy
                                                                        |
                                                            Meera pastes it into LinkedIn
```

## Live deployment

| | |
| --- | --- |
| App | https://meera-bot-pink.vercel.app |
| Health | https://meera-bot-pink.vercel.app/api/health |
| Bot | [@meera546352627374_bot](https://t.me/meera546352627374_bot) |
| Model | `gemini-3.8-flash` |
| Database | Supabase `lemtkszbtwbgxekcrlfv`, `us-east-1` |

The Supabase region is matched to the Vercel function region (`iad1`) on purpose: the pipeline makes several database round trips per note, so a cross-continent pairing would add seconds of latency to every draft.

See [`docs/component-map.md`](docs/component-map.md) for the full flow and data model, and [`SECURITY.md`](SECURITY.md) for the security posture.

## Stack

| Concern | Choice |
| --- | --- |
| Runtime | TypeScript (strict), Next.js App Router on Vercel serverless |
| Telegram | Bot API over a webhook, never long polling |
| Model | Google Gemini via `@google/genai`, model set by `GEMINI_MODEL` |
| Persistence | Supabase Postgres, service role key, server-side only |
| News | Google News RSS, metadata only, no scraping of protected pages |
| Validation | Zod on every external input and every model output |
| Tests | Vitest, all external services mocked, no test calls a paid API |

## Local setup

Requires Node 20.9 or newer.

```bash
git clone <this repo>
cd meera-bot
npm install
cp .env.example .env.local
```

Fill in `.env.local`:

| Variable | Where to get it |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | BotFather, `/newbot`. Format `<bot_id>:<auth_token>` |
| `TELEGRAM_WEBHOOK_SECRET` | Generate one: `openssl rand -hex 24`. Telegram only accepts `A-Z a-z 0-9 _ -`, 1 to 256 characters |
| `TELEGRAM_ALLOWED_CHAT_ID` | See "Telegram bot and private channel setup" below. Channels are negative, for example `-1001234567890` |
| `GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com/apikey) |
| `GEMINI_MODEL` | `gemini-3.8-flash` is the current default. Google retires model ids over time and a retired id returns a non-retryable 404, so check `models.list` if drafting stops working |
| `SUPABASE_URL` | Supabase project settings, API, Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase project settings, API, `service_role` key. Server-side only |
| `APP_BASE_URL` | Your production origin, with no trailing slash, for example `https://meera-bot-pink.vercel.app` |

Then:

```bash
npm run typecheck
npm test
npm run dev          # http://localhost:3000
```

`npm run dev` is only useful for `/api/health`. Telegram requires a public HTTPS URL, so the webhook itself is exercised by the test suite locally and by the real deployment in production.

## Supabase migration

The schema is one idempotent SQL file: [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql). It is safe to run more than once.

**Option A, SQL editor (no CLI needed).** Open your Supabase project, SQL Editor, New query, paste the whole file, Run. It should finish with `Success`.

**Option B, Supabase CLI.**

```bash
brew install supabase/tap/supabase
supabase link --project-ref <your-project-ref>
supabase db push
```

**Option C, psql.**

```bash
psql "$SUPABASE_DB_URL" -f supabase/migrations/0001_init.sql
```

Then seed the voice profile:

```bash
npm run db:seed-voice-skill
```

This reads `voice-skill.txt`, inserts it as a new version keyed by content hash, and makes it the active one. Running it again with unchanged content is a no-op. Every draft carries a foreign key to the exact voice skill version that produced it, so changing the profile later does not rewrite history.

Verify the schema landed:

```sql
select table_name from information_schema.tables
 where table_schema = 'public' order by table_name;
-- draft_reviews, drafts, news_cache, notes, rate_limit_events, telegram_updates, voice_skills

select version, is_active, length(content) from public.voice_skills;
```

## Telegram bot and private channel setup

1. **Create the bot.** Message [@BotFather](https://t.me/BotFather), send `/newbot`, follow the prompts, copy the token into `TELEGRAM_BOT_TOKEN`.
2. **Let the bot see channel posts.** Send `/setprivacy` to BotFather, pick your bot, choose **Disable**. Without this the bot cannot read messages in groups.
3. **Create the private channel** in Telegram (New Channel, Private).
4. **Add the bot as an administrator** of that channel with permission to post messages. A bot cannot read a channel it does not administer.
5. **Find the chat id.** Post any message in the channel, then run:

   ```bash
   curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates" \
     | jq '.result[].channel_post.chat | {id, title}'
   ```

   Copy the `id` (a negative number like `-1001234567890`) into `TELEGRAM_ALLOWED_CHAT_ID`.

   If `getUpdates` returns an empty array, a webhook is already set. Run `npm run telegram:delete-webhook` first, post again, then retry.

   A direct chat with the bot works too: send `/start` and read `.result[].message.chat.id`, which will be a positive number.

## Webhook setup

Set `APP_BASE_URL` to the deployed origin first, then:

```bash
npm run telegram:set-webhook
```

This calls `setWebhook` with the `secret_token`, restricts `allowed_updates` to `message`, `channel_post` and `callback_query`, then verifies with `getWebhookInfo` and exits non-zero if the result does not match. The token and the secret are never printed.

```bash
npm run telegram:webhook-info     # read-only check
npm run telegram:delete-webhook   # rollback, keeps pending updates
```

## Testing

```bash
npm test                  # unit + integration
npm run test:unit
npm run test:integration
npm run test:watch
npm run verify            # format, lint, typecheck, test, build
```

No test reaches the network. `tests/helpers/setup.ts` replaces `globalThis.fetch` with a stub that throws, so an accidental real call fails loudly rather than silently costing money.

Coverage includes update parsing (channel posts, direct messages, callbacks, malformed payloads), webhook secret rejection, allowed-chat enforcement, update idempotency, the Gemini score schema, threshold behaviour at exactly 5 and exactly 6, Gemini retry behaviour, RSS parsing and its timeout / irrelevant / empty fallbacks, voice-skill injection into every drafting call, approval and rejection idempotency, HTML and MarkdownV2 escaping, and environment validation.

The two acceptance fixtures from the brief live in `tests/fixtures/notes.ts`. They are test-only: nothing under `src/` imports them, so no fixture text or score is hard-coded into production behaviour.

## Vercel deployment

```bash
npm i -g vercel
vercel login
vercel link
```

Add each secret to production. `vercel env add` reads the value from stdin, which keeps it out of your shell history:

```bash
for KEY in TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET TELEGRAM_ALLOWED_CHAT_ID \
           GEMINI_API_KEY GEMINI_MODEL SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY APP_BASE_URL; do
  printf '%s' "$(grep "^$KEY=" .env.local | cut -d= -f2-)" | vercel env add "$KEY" production
done
```

Then:

```bash
vercel --prod
curl -s https://<your-app>.vercel.app/api/health | jq
npm run telegram:set-webhook
```

`/api/health` should report `"ok": true` with `config`, `database` and `voiceSkill` all passing. If `voiceSkill` fails, run `npm run db:seed-voice-skill`.

Send a note in the channel to confirm end to end.

## How it behaves

**Scoring.** Gemini returns `{score, reason, keywords}` against six criteria: a defensible point, specific evidence, relevance to the domain, enough substance for a post, novelty against past decisions, and no unsupported medical advice. Below 6 the pipeline stops, saves the score, and explains why. At 6 or above it continues. The drafting model is never called for a rejected note.

**News.** Keywords go to Google News RSS. Only recent items with a parseable date and an `http(s)` link survive. Gemini is then asked whether any result is genuinely relevant, and is explicitly allowed to say no. Identical queries are cached in Postgres for 6 hours. If RSS is slow, fails, or returns nothing usable, the draft is written from the note alone.

Only the headline, publication, date and RSS description are ever sent to the model. No article body is fetched. When a draft does use a source, this block is appended to the Telegram message, built from our stored metadata rather than anything the model said:

```
NEWS SOURCE: [headline]
FROM: [publication] | [date]
LINK: [url]
CHECK BEFORE PUBLISHING: You are the author of this claim.
```

If the model claims a URL we did not supply, `used_news` is forced to false and no block is shown.

**Drafting.** The active voice skill is sent as the system instruction on every drafting call. The model is told not to invent her experiences, numbers, customer messages, studies or product facts, and to make uncertainty visible rather than fill gaps. Output is schema-validated, then emoji are stripped and hashtags removed unless the original note used them.

**Review.** The draft message carries a six-character id, the score and its reason, the body, the source block when applicable, and Approve / Reject buttons. `APPROVE <id>` and `REJECT <id>` work as text too. The status change and the audit row happen inside one Postgres function that only moves a draft out of `pending`, so a second button press, a redelivered update, or a reject-after-approve all confirm the existing state instead of changing it. Rejected drafts are kept.

**Handover.** An approval is answered with two messages: the confirmation, then the post body alone in a code block, which Telegram gives a one-tap copy control. Nothing has to be trimmed before pasting. A post too long to fit one message is sent as unparsed plain text instead, because a code block split across chunks would leave an unclosed tag and earn a 400 on a decision already committed. A repeat approval re-sends the block, which is the only way to recover the text after the draft message has scrolled away.

## Operations

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Config, database and voice-skill checks. `200` when healthy, `503` otherwise. No secrets |
| `POST /api/telegram/webhook` | The only write path. Secret-token authenticated |

Logs are one JSON object per line with a `requestId` on every line and an `updateId` on pipeline lines. Errors are classified as `config`, `validation`, `authorization`, `rate_limit`, `telegram`, `gemini`, `supabase`, `rss`, `timeout` or `internal`. Transient kinds are retried with exponential backoff and jitter, at most three attempts. Validation and authorization failures are never retried. An update that cannot be completed ends at `status = 'dead_letter'` with a `failure_reason`, and Meera gets a short message quoting the request id.

Useful queries:

```sql
-- Anything stuck
select update_id, update_type, status, failure_reason, created_at
  from telegram_updates where status in ('failed','dead_letter')
 order by created_at desc limit 20;

-- This week's decisions
select d.short_id, d.status, d.used_news, n.score, left(n.raw_text, 60) as note
  from drafts d join notes n on n.id = d.note_id
 where d.created_at > now() - interval '7 days'
 order by d.created_at desc;

-- Prune expired news cache
delete from news_cache where expires_at < now();
```

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| No reply to any message | `npm run telegram:webhook-info`. If `url` is empty, run `telegram:set-webhook`. If `last_error` is set, it names the cause |
| `getWebhookInfo` shows 401 errors | `TELEGRAM_WEBHOOK_SECRET` in Vercel does not match the one used by `setWebhook`. Update Vercel, redeploy, re-run `telegram:set-webhook` |
| Webhook returns 403 | The chat is not `TELEGRAM_ALLOWED_CHAT_ID`. Re-read the id with `getUpdates` and note that channel ids are negative |
| Bot sees nothing in the channel | It is not an administrator there, or privacy mode is still enabled (`/setprivacy` -> Disable in BotFather) |
| `/api/health` reports `config: invalid keys: ...` | Those keys are missing or malformed in Vercel. Values are never printed, only key names |
| `/api/health` reports `no active voice skill` | Run `npm run db:seed-voice-skill` |
| Everything gets scored but nothing drafts | Check logs for `gemini_retry`. An `authorization` kind means a bad `GEMINI_API_KEY`; a `config` kind usually means an invalid `GEMINI_MODEL` |
| Drafts never carry a news source | Expected when RSS finds nothing recent or the relevance check declines. Logs show `news_search` with `outcome` and `news_relevance` with `selected` |
| Duplicate drafts for one note | Should be impossible: `telegram_updates.update_id` is unique and `notes` is unique on `(chat_id, message_id)`. If it happens, the migration did not fully apply |
| Webhook returns 429 | The container hit its concurrency limit. Telegram retries automatically, before the update is claimed, so nothing is lost |
| Logs show `Gemini stopped at the output token limit` | `maxOutputTokens` budgets the model's reasoning tokens and its visible output together, and reasoning consumed the budget before the JSON was finished. The context line reports `thoughtsTokenCount` against `maxOutputTokens`; raise the budget for that call in `src/lib/gemini` |

## Rollback

**Stop inbound processing immediately:**

```bash
npm run telegram:delete-webhook
```

Nothing is processed until the webhook is set again. Pending updates are preserved and delivered on reconnect. Use `--drop-pending` only if you want to discard the backlog.

**Roll back the code:** promote the previous deployment in the Vercel dashboard, or `vercel rollback`. Then re-run `npm run telegram:set-webhook` if `APP_BASE_URL` changed.

**Roll back a voice skill version:**

```sql
update voice_skills set is_active = false where is_active;
update voice_skills set is_active = true  where version = <older version>;
```

Existing drafts keep their original `voice_skill_id`, so history stays accurate.

**Schema rollback** is deliberately not automated. The migration only creates things, so re-running it is safe and there is no destructive step to undo. Dropping tables would destroy notes and drafts, which the brief requires be kept.

## Known limitations

- Text notes only. Photos, voice notes and documents get a short "text only" reply and are not transcribed.
- One draft per note. There is no "give me another angle" command.
- The concurrency guard is per serverless container, not global. The Postgres rate limiter is the part that holds across instances.
- Google News RSS gives headlines and one-line descriptions only. The system cannot verify an article's contents, which is exactly why the verification block tells Meera to check before publishing.
- Novelty scoring compares against at most the last 12 decisions, not the full history.
- `/api/health` is unauthenticated. It exposes a bot id, a model name and a Supabase project ref, none of which are secret, but it does reveal that the deployment exists.
