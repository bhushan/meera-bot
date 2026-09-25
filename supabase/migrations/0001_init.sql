-- =============================================================================
-- meera-bot :: initial schema
--
-- Idempotent: safe to run repeatedly against the same project.
-- All timestamps are timestamptz and are written in UTC.
--
-- Security posture: every table has RLS enabled with NO policies, so the
-- anon and authenticated roles can read nothing. The server reaches these
-- tables only with the service role key, which bypasses RLS and is never
-- exposed to browser code.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- telegram_updates : webhook de-duplication ledger
-- -----------------------------------------------------------------------------
create table if not exists public.telegram_updates (
  id                uuid primary key default gen_random_uuid(),
  update_id         bigint      not null,
  chat_id           bigint,
  message_id        bigint,
  update_type       text        not null default 'unknown',
  status            text        not null default 'received',
  attempts          integer     not null default 0,
  failure_reason    text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

do $$ begin
  alter table public.telegram_updates
    add constraint telegram_updates_update_id_key unique (update_id);
exception when duplicate_table or duplicate_object then null; end $$;

do $$ begin
  alter table public.telegram_updates
    add constraint telegram_updates_status_check check (status in (
      'received', 'processing', 'done', 'ignored',
      'rate_limited', 'failed', 'dead_letter'
    ));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.telegram_updates
    add constraint telegram_updates_attempts_check check (attempts >= 0);
exception when duplicate_object then null; end $$;

create index if not exists telegram_updates_status_idx
  on public.telegram_updates (status, created_at desc);
create index if not exists telegram_updates_chat_idx
  on public.telegram_updates (chat_id, created_at desc);

-- -----------------------------------------------------------------------------
-- notes : the raw note, stored before any AI call. Never deleted.
-- -----------------------------------------------------------------------------
create table if not exists public.notes (
  id                  uuid primary key default gen_random_uuid(),
  telegram_update_id  bigint      not null,
  chat_id             bigint      not null,
  message_id          bigint      not null,
  raw_text            text        not null,
  received_at         timestamptz not null default now(),
  status              text        not null default 'received',
  score               integer,
  score_reason        text,
  keywords            text[]      not null default '{}'::text[],
  failure_reason      text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

do $$ begin
  alter table public.notes
    add constraint notes_telegram_update_fk
    foreign key (telegram_update_id)
    references public.telegram_updates (update_id)
    on delete restrict;
exception when duplicate_object then null; end $$;

-- One note per Telegram message, so a webhook replay can never double-store it.
do $$ begin
  alter table public.notes
    add constraint notes_chat_message_key unique (chat_id, message_id);
exception when duplicate_table or duplicate_object then null; end $$;

do $$ begin
  alter table public.notes
    add constraint notes_status_check check (status in (
      'received', 'scoring', 'scored', 'rejected_low_score',
      'drafting', 'drafted', 'failed'
    ));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.notes
    add constraint notes_score_range_check check (score is null or (score between 0 and 10));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.notes
    add constraint notes_raw_text_not_blank check (length(btrim(raw_text)) > 0);
exception when duplicate_object then null; end $$;

create index if not exists notes_status_idx on public.notes (status, created_at desc);
create index if not exists notes_received_idx on public.notes (received_at desc);

-- -----------------------------------------------------------------------------
-- voice_skills : versioned copies of voice-skill.txt
-- -----------------------------------------------------------------------------
create table if not exists public.voice_skills (
  id            uuid primary key default gen_random_uuid(),
  version       integer     not null,
  content_hash  text        not null,
  content       text        not null,
  is_active     boolean     not null default false,
  created_at    timestamptz not null default now()
);

do $$ begin
  alter table public.voice_skills add constraint voice_skills_version_key unique (version);
exception when duplicate_table or duplicate_object then null; end $$;

do $$ begin
  alter table public.voice_skills add constraint voice_skills_hash_key unique (content_hash);
exception when duplicate_table or duplicate_object then null; end $$;

do $$ begin
  alter table public.voice_skills
    add constraint voice_skills_content_not_blank check (length(btrim(content)) > 0);
exception when duplicate_object then null; end $$;

-- At most one active voice skill at a time.
create unique index if not exists voice_skills_single_active_idx
  on public.voice_skills (is_active) where is_active;

-- -----------------------------------------------------------------------------
-- drafts : one pending LinkedIn draft per qualifying note
-- -----------------------------------------------------------------------------
create table if not exists public.drafts (
  id                  uuid primary key default gen_random_uuid(),
  short_id            text        not null,
  note_id             uuid        not null,
  voice_skill_id      uuid        not null,
  body                text        not null,
  status              text        not null default 'pending',
  gemini_model        text        not null,
  used_news           boolean     not null default false,
  news_headline       text,
  news_publication    text,
  news_published_at   timestamptz,
  news_url            text,
  news_description    text,
  uncertainty_note    text,
  telegram_message_id bigint,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

do $$ begin
  alter table public.drafts add constraint drafts_short_id_key unique (short_id);
exception when duplicate_table or duplicate_object then null; end $$;

do $$ begin
  alter table public.drafts
    add constraint drafts_note_fk foreign key (note_id)
    references public.notes (id) on delete restrict;
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.drafts
    add constraint drafts_voice_skill_fk foreign key (voice_skill_id)
    references public.voice_skills (id) on delete restrict;
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.drafts
    add constraint drafts_status_check check (status in ('pending', 'approved', 'rejected'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.drafts
    add constraint drafts_short_id_format_check check (short_id ~ '^[0-9A-HJ-NP-TV-Z]{6}$');
exception when duplicate_object then null; end $$;

-- A draft that claims to use news must carry the metadata that proves it.
do $$ begin
  alter table public.drafts
    add constraint drafts_news_metadata_check check (
      used_news = false
      or (news_headline is not null and news_url is not null and news_publication is not null)
    );
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.drafts
    add constraint drafts_body_not_blank check (length(btrim(body)) > 0);
exception when duplicate_object then null; end $$;

create index if not exists drafts_status_idx on public.drafts (status, created_at desc);
create index if not exists drafts_note_idx on public.drafts (note_id);

-- -----------------------------------------------------------------------------
-- draft_reviews : immutable audit trail of every human decision
-- -----------------------------------------------------------------------------
create table if not exists public.draft_reviews (
  id                  uuid primary key default gen_random_uuid(),
  draft_id            uuid        not null,
  decision            text        not null,
  actor_chat_id       bigint      not null,
  actor_user_id       bigint,
  actor_username      text,
  telegram_update_id  bigint      not null,
  source              text        not null,
  -- false when the decision arrived after the draft had already left 'pending'
  applied             boolean     not null default true,
  created_at          timestamptz not null default now()
);

do $$ begin
  alter table public.draft_reviews
    add constraint draft_reviews_draft_fk foreign key (draft_id)
    references public.drafts (id) on delete restrict;
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.draft_reviews
    add constraint draft_reviews_decision_check check (decision in ('approved', 'rejected'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.draft_reviews
    add constraint draft_reviews_source_check check (source in ('callback', 'command'));
exception when duplicate_object then null; end $$;

-- Re-delivery of the same Telegram update can never create a second review row.
do $$ begin
  alter table public.draft_reviews
    add constraint draft_reviews_update_key unique (draft_id, telegram_update_id);
exception when duplicate_table or duplicate_object then null; end $$;

create index if not exists draft_reviews_draft_idx on public.draft_reviews (draft_id, created_at desc);

-- -----------------------------------------------------------------------------
-- news_cache : identical RSS searches are served from here
-- -----------------------------------------------------------------------------
create table if not exists public.news_cache (
  id          uuid primary key default gen_random_uuid(),
  query_hash  text        not null,
  query       text        not null,
  payload     jsonb       not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);

do $$ begin
  alter table public.news_cache add constraint news_cache_query_hash_key unique (query_hash);
exception when duplicate_table or duplicate_object then null; end $$;

create index if not exists news_cache_expires_idx on public.news_cache (expires_at);

-- -----------------------------------------------------------------------------
-- rate_limit_events : Postgres-backed sliding window per chat
-- -----------------------------------------------------------------------------
create table if not exists public.rate_limit_events (
  id         bigint generated always as identity primary key,
  chat_id    bigint      not null,
  created_at timestamptz not null default now()
);

create index if not exists rate_limit_events_chat_time_idx
  on public.rate_limit_events (chat_id, created_at desc);

-- =============================================================================
-- Triggers: keep updated_at honest
-- =============================================================================
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['telegram_updates', 'notes', 'drafts'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_touch_updated_at', t);
    execute format(
      'create trigger %I before update on public.%I for each row execute function public.touch_updated_at()',
      t || '_touch_updated_at', t
    );
  end loop;
end $$;

-- =============================================================================
-- Transactional operations
--
-- Anything whose partial completion would corrupt workflow state lives here as
-- a single function so it commits or rolls back as one unit.
-- =============================================================================

-- Claim a Telegram update exactly once. Returns true for the first caller only.
create or replace function public.claim_telegram_update(
  p_update_id   bigint,
  p_chat_id     bigint,
  p_message_id  bigint,
  p_update_type text
)
returns boolean
language plpgsql
as $$
declare
  v_inserted boolean := false;
begin
  insert into public.telegram_updates (update_id, chat_id, message_id, update_type, status, attempts)
  values (p_update_id, p_chat_id, p_message_id, coalesce(p_update_type, 'unknown'), 'processing', 1)
  on conflict (update_id) do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

-- Insert the note and move the update forward in one transaction.
create or replace function public.store_note(
  p_update_id   bigint,
  p_chat_id     bigint,
  p_message_id  bigint,
  p_raw_text    text,
  p_received_at timestamptz
)
returns jsonb
language plpgsql
as $$
declare
  v_note public.notes%rowtype;
begin
  insert into public.notes (telegram_update_id, chat_id, message_id, raw_text, received_at, status)
  values (p_update_id, p_chat_id, p_message_id, p_raw_text, coalesce(p_received_at, now()), 'received')
  on conflict (chat_id, message_id) do update
    set updated_at = now()
  returning * into v_note;

  return to_jsonb(v_note);
end;
$$;

-- Store the draft and flip the note to 'drafted' atomically: a draft row without
-- a matching note status (or the reverse) would misreport the workflow.
create or replace function public.create_draft_for_note(
  p_note_id           uuid,
  p_short_id          text,
  p_voice_skill_id    uuid,
  p_body              text,
  p_gemini_model      text,
  p_used_news         boolean,
  p_news_headline     text,
  p_news_publication  text,
  p_news_published_at timestamptz,
  p_news_url          text,
  p_news_description  text,
  p_uncertainty_note  text
)
returns jsonb
language plpgsql
as $$
declare
  v_draft public.drafts%rowtype;
begin
  insert into public.drafts (
    short_id, note_id, voice_skill_id, body, status, gemini_model,
    used_news, news_headline, news_publication, news_published_at,
    news_url, news_description, uncertainty_note
  )
  values (
    upper(p_short_id), p_note_id, p_voice_skill_id, p_body, 'pending', p_gemini_model,
    coalesce(p_used_news, false), p_news_headline, p_news_publication, p_news_published_at,
    p_news_url, p_news_description, p_uncertainty_note
  )
  returning * into v_draft;

  update public.notes
     set status = 'drafted', failure_reason = null
   where id = p_note_id;

  return to_jsonb(v_draft);
end;
$$;

-- Apply a human review. Idempotent by construction: only a 'pending' draft
-- changes status, and a repeated Telegram update inserts no second audit row.
create or replace function public.record_draft_review(
  p_short_id   text,
  p_decision   text,
  p_chat_id    bigint,
  p_user_id    bigint,
  p_username   text,
  p_update_id  bigint,
  p_source     text
)
returns jsonb
language plpgsql
as $$
declare
  v_draft    public.drafts%rowtype;
  v_previous text;
  v_changed  boolean := false;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'invalid decision: %', p_decision using errcode = '22023';
  end if;

  select * into v_draft
    from public.drafts
   where short_id = upper(p_short_id)
     for update;

  if not found then
    return jsonb_build_object('found', false);
  end if;

  v_previous := v_draft.status;

  if v_draft.status = 'pending' then
    update public.drafts
       set status = p_decision
     where id = v_draft.id
    returning * into v_draft;
    v_changed := true;
  end if;

  insert into public.draft_reviews (
    draft_id, decision, actor_chat_id, actor_user_id, actor_username,
    telegram_update_id, source, applied
  )
  values (
    v_draft.id, p_decision, p_chat_id, p_user_id, p_username,
    p_update_id, p_source, v_changed
  )
  on conflict (draft_id, telegram_update_id) do nothing;

  return jsonb_build_object(
    'found', true,
    'changed', v_changed,
    'previous_status', v_previous,
    'draft', to_jsonb(v_draft)
  );
end;
$$;

-- Sliding-window rate limit. Counting and recording happen in one statement pair
-- so two concurrent webhooks cannot both see an under-limit count.
create or replace function public.check_rate_limit(
  p_chat_id        bigint,
  p_window_seconds integer,
  p_max_events     integer
)
returns jsonb
language plpgsql
as $$
declare
  v_used integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('meera_rate_limit', p_chat_id));

  delete from public.rate_limit_events
   where created_at < now() - make_interval(secs => greatest(p_window_seconds, 1) * 10);

  select count(*) into v_used
    from public.rate_limit_events
   where chat_id = p_chat_id
     and created_at > now() - make_interval(secs => greatest(p_window_seconds, 1));

  if v_used >= p_max_events then
    return jsonb_build_object('allowed', false, 'used', v_used, 'limit', p_max_events);
  end if;

  insert into public.rate_limit_events (chat_id) values (p_chat_id);
  return jsonb_build_object('allowed', true, 'used', v_used + 1, 'limit', p_max_events);
end;
$$;

-- Seed / activate a voice skill. The hash is computed by the application so this
-- function needs no crypto extension. Re-running with identical content is a no-op
-- beyond ensuring that row is the active one.
create or replace function public.activate_voice_skill(
  p_content      text,
  p_content_hash text
)
returns jsonb
language plpgsql
as $$
declare
  v_skill public.voice_skills%rowtype;
begin
  select * into v_skill from public.voice_skills where content_hash = p_content_hash;

  if not found then
    insert into public.voice_skills (version, content_hash, content, is_active)
    values (
      (select coalesce(max(version), 0) + 1 from public.voice_skills),
      p_content_hash, p_content, false
    )
    returning * into v_skill;
  end if;

  update public.voice_skills set is_active = false where is_active and id <> v_skill.id;
  update public.voice_skills set is_active = true where id = v_skill.id returning * into v_skill;

  return to_jsonb(v_skill);
end;
$$;

-- =============================================================================
-- Row Level Security: deny-all for anon/authenticated. Service role bypasses RLS.
-- =============================================================================
do $$
declare t text;
begin
  foreach t in array array[
    'telegram_updates', 'notes', 'drafts', 'draft_reviews',
    'voice_skills', 'news_cache', 'rate_limit_events'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

revoke all on function public.claim_telegram_update(bigint, bigint, bigint, text) from anon, authenticated;
revoke all on function public.store_note(bigint, bigint, bigint, text, timestamptz) from anon, authenticated;
revoke all on function public.record_draft_review(text, text, bigint, bigint, text, bigint, text) from anon, authenticated;
revoke all on function public.check_rate_limit(bigint, integer, integer) from anon, authenticated;
revoke all on function public.activate_voice_skill(text, text) from anon, authenticated;
revoke all on function public.create_draft_for_note(uuid, text, uuid, text, text, boolean, text, text, timestamptz, text, text, text) from anon, authenticated;
