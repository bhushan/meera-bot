# Security

This is a single-operator system holding one founder's unpublished writing. The threat model is small but the blast radius of a leaked key is not: `SUPABASE_SERVICE_ROLE_KEY` bypasses row level security, and `TELEGRAM_BOT_TOKEN` grants full control of the bot.

## Secret handling

**Secrets in use**

| Variable | What it grants | Where it lives |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Full control of the bot: read the channel, send messages, move the webhook | Vercel environment variables, local `.env.local` |
| `TELEGRAM_WEBHOOK_SECRET` | Ability to submit updates that the app will accept | Same |
| `GEMINI_API_KEY` | Billable model calls | Same |
| `SUPABASE_SERVICE_ROLE_KEY` | Full read and write on every table, bypassing RLS | Same |

**Rules enforced in code**

- `.gitignore` ignores `.env` and every `.env.*` variant except `.env.example`. `.env.example` contains only empty placeholders.
- `src/lib/env.ts` validates configuration at startup and throws a `ConfigValidationError` that names the invalid keys but never their values.
- `src/lib/runtime.ts` imports `server-only`. Importing it from a client component is a build error, which is what keeps the service role key out of the browser bundle.
- Nothing is placed on `env` in `next.config.ts` and no secret is prefixed `NEXT_PUBLIC_`.
- `src/lib/logger.ts` redacts recursively: any key matching `token|secret|key|password|authorization|auth|credential|cookie`, plus any string shaped like a Telegram bot token, anywhere in a log payload.
- The Telegram setup scripts print the bot id only, never the token.
- `/api/health` reports a bot id, a model name, a Supabase project ref and the public base URL. It never returns a credential.

**Rotation**

| Secret | How to rotate |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | `/revoke` then `/token` in BotFather, update Vercel, redeploy, re-run `npm run telegram:set-webhook` |
| `TELEGRAM_WEBHOOK_SECRET` | Generate a new value, update Vercel, redeploy, then re-run `npm run telegram:set-webhook`. Do it in that order: the old secret keeps working until `setWebhook` is called again |
| `GEMINI_API_KEY` | Create a new key in Google AI Studio, update Vercel, redeploy, delete the old key |
| `SUPABASE_SERVICE_ROLE_KEY` | Rotate in Supabase project settings, update Vercel, redeploy. This invalidates the old key immediately, so expect a short outage |

## Webhook validation

Every request to `POST /api/telegram/webhook` passes four checks, in this order:

1. **Secret token.** `X-Telegram-Bot-Api-Secret-Token` is compared against `TELEGRAM_WEBHOOK_SECRET`. Both sides are HMAC'd to a fixed 32-byte digest with a per-process random key, then compared with `crypto.timingSafeEqual`. Hashing first means the comparison width does not leak the secret's length and a length mismatch cannot throw. An empty configured secret rejects everything, so a misconfigured deployment fails closed. Failure: `401`, nothing is parsed or stored.
2. **Payload shape.** The body is parsed with Zod. Unknown fields are allowed so a future Bot API field cannot cause a rejection, but a payload that is not an update at all gets `400`.
3. **Allowed chat.** `chat.id` must equal `TELEGRAM_ALLOWED_CHAT_ID`. Anything else gets `403` and is never stored. This is the control that matters if the bot is added to another chat: no note is processed, no model call is made, no message is sent back.
4. **Exactly-once.** `claim_telegram_update` inserts the `update_id` with a UNIQUE constraint. A re-delivery returns `200 {"duplicate": true}` and does no work.

**Abuse controls**

- Per-chat sliding window (20 updates per 60 seconds) enforced by a Postgres function with an advisory lock, so it holds across serverless instances.
- In-process concurrency guard (4 concurrent pipelines per container), checked *before* the update is claimed so a rejected request returns `429` and Telegram retries it, rather than being marked processed and dropped.
- Bot-authored messages are ignored, which makes a bot-to-bot reply loop impossible.
- Media messages are answered with a short text-only notice and never sent to a model.

**Deliberate omissions**

There is no admin dashboard and no public read path to any draft. The only routes are the webhook and `/api/health`. Adding a dashboard would mean adding authentication, sessions and an authorization surface to a system that has exactly one user who already has Telegram and Supabase.

## Model-output safety

- Every Gemini response is decoded against a JSON Schema and then validated with Zod. Unvalidated model output never reaches the database or Telegram.
- A draft may only cite a news source we actually retrieved, at the exact URL we supplied. If the model returns any other URL, `used_news` is forced to `false` and no source block is shown. The database enforces the same rule: `drafts_news_metadata_check` rejects a row claiming `used_news` without headline, publication and URL.
- Only the headline, publication, date and RSS description are sent to the model. No article body is fetched, and no protected page is scraped.
- Draft text is HTML-escaped before it reaches Telegram, so a model-generated `<a href>` cannot become a live link in the review message.

## Database hardening

Verified against the live project with Supabase's own database linter (`get_advisors`, security):

- **`function_search_path_mutable` (WARN): fixed.** All seven Postgres functions now pin `set search_path = ''`. Without it they inherit the caller's `search_path`, so a role able to create objects in an earlier schema could shadow a table or operator they depend on. Every reference inside them is already schema-qualified or lives in `pg_catalog`, so an empty path is safe.
- **`rls_enabled_no_policy` (INFO): intentional, not a defect.** All seven tables have RLS enabled with zero policies. That is the deny-all posture this system wants: `anon` and `authenticated` can read nothing at all, and the server reaches the data only with the service role key, which bypasses RLS. Adding policies would only be needed if a browser client were ever to talk to these tables directly, which it must not.

The transactional guarantees were exercised against the real database rather than only against mocks. A duplicate `claim_telegram_update` inserted nothing; `create_draft_for_note` flipped the note to `drafted` in the same transaction as the draft insert; and for a single draft, three review calls (approve, approve again, then reject) produced three audit rows but exactly one applied change, with the draft staying `approved`.

## Data retention

| Data | Retention | Rationale |
| --- | --- | --- |
| `notes` | Indefinite. Never deleted, including rejected and failed notes | A rejected note is the raw material for a better one later |
| `drafts` | Indefinite, including rejected drafts | Explicit product requirement |
| `draft_reviews` | Indefinite | Audit trail of who decided what, and when |
| `telegram_updates` | Indefinite | Deduplication ledger; deleting a row would allow a replay |
| `news_cache` | 6 hours (`expires_at`) | Expired rows are ignored on read. Prune with `delete from news_cache where expires_at < now()` |
| `rate_limit_events` | Pruned automatically to ten times the window on each check | Operational only |
| Vercel function logs | Vercel's retention for the plan in use | Logs contain note ids and update ids, never note text or secrets |

**Personal data.** The stored content is Meera's own writing plus Telegram chat, message and user ids. No customer data is collected. To erase everything for a note, delete in this order: `draft_reviews`, `drafts`, `notes`. Leave the `telegram_updates` row in place so the update cannot be replayed.

## Incident response

**If a secret leaks**

1. Rotate the affected secret first (table above). Do not start by investigating.
2. For `TELEGRAM_BOT_TOKEN`: `/revoke` in BotFather immediately. This invalidates the old token and drops the webhook, so re-run `npm run telegram:set-webhook` after updating Vercel.
3. For `SUPABASE_SERVICE_ROLE_KEY`: rotate in Supabase, then review `draft_reviews` and `drafts` for rows you do not recognise. `draft_reviews.actor_chat_id` should only ever be `TELEGRAM_ALLOWED_CHAT_ID`.
4. Check whether the secret reached a public place: `git log -p -S'<fragment>' --all`. If it is in Git history, rotating is necessary but not sufficient; rewrite history or make the repository private.

**If the bot behaves unexpectedly**

1. `npm run telegram:delete-webhook`. This stops all inbound processing immediately and preserves pending updates, so nothing Meera sends is lost while you investigate.
2. Check `/api/health` for configuration and database status.
3. Query the failures: `select update_id, update_type, status, failure_reason, created_at from telegram_updates where status in ('failed','dead_letter') order by created_at desc limit 20;`
4. Correlate with Vercel logs. Every log line carries `requestId`, and pipeline lines carry `updateId`. A user-facing failure message quotes the `requestId`.
5. When resolved, `npm run telegram:set-webhook` to resume. Queued updates are delivered on reconnect.

**If a draft contains something it should not**

The review gate is the control: an unapproved draft has gone nowhere. Reject it, which keeps the row for inspection, then check `drafts.used_news` and the `news_*` columns to see whether a news angle was involved, and `drafts.voice_skill_id` to see which voice version produced it.

## Reporting a vulnerability

This is a coursework project and not a production service. Open a GitHub issue for anything non-sensitive. For anything that would disclose a secret, contact the repository owner directly rather than filing publicly.
