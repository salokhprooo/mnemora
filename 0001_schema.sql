-- Mnemora schema. Run in order: 0001 (schema) -> 0002 (RLS) -> 0003 (storage + functions).
-- Every user-owned row carries user_id; RLS (0002) restricts access to auth.uid().
-- Rows are soft-deleted (deleted_at) so deletions can propagate to other devices.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- helpers
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  -- Clients send their own updated_at (used for last-writer-wins). Fill it only when absent, and clamp
  -- clocks that run far ahead so one wrong device clock cannot win every future conflict.
  if new.updated_at is null then
    new.updated_at := now();
  end if;
  new.updated_at := least(new.updated_at, now() + interval '5 minutes');
  return new;
end $$;

-- Server-assigned sync cursor. Pull uses synced_at (NOT the client-written updated_at): a device that was
-- offline for a day pushes rows whose updated_at is old, and other devices must still receive them.
create or replace function public.touch_synced_at() returns trigger
language plpgsql as $$
begin
  new.synced_at := clock_timestamp();
  return new;
end $$;

-- Last-writer-wins guard: a stale client can never overwrite a newer server row. Returning NULL from a BEFORE
-- trigger silently skips that row's update (the client re-pulls and merges on its next sync).
create or replace function public.lww_guard() returns trigger
language plpgsql as $$
begin
  if new.updated_at < old.updated_at then
    return null;
  end if;
  return new;
end $$;


-- Review history can never go backwards. A stale device may legitimately edit a card (suspend it, move it), but its
-- scheduling snapshot must not replace one that already contains more recent reviews. Enforced server-side because
-- frontend-only rules cannot be trusted. Fires after a_lww_guard (by name) and before the updated_at/synced_at triggers.
create or replace function public.cards_history_guard() returns trigger
language plpgsql as $$
begin
  if old.last_review is not null
     and (new.last_review is null or new.last_review < old.last_review
          or (new.last_review = old.last_review and new.reps < old.reps)) then
    new.state          := old.state;
    new.due            := old.due;
    new.stability      := old.stability;
    new.difficulty     := old.difficulty;
    new.scheduled_days := old.scheduled_days;
    new.step           := old.step;
    new.reps           := old.reps;
    new.lapses         := old.lapses;
    new.last_review    := old.last_review;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------- profiles
create table public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  display_name  text not null default '' check (char_length(display_name) <= 80),
  avatar_url    text check (avatar_url is null or char_length(avatar_url) <= 500),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(nullif(new.raw_user_meta_data->>'full_name',''), split_part(new.email,'@',1), ''));
  insert into public.user_settings (user_id) values (new.id) on conflict do nothing;
  return new;
end $$;

-- ---------------------------------------------------------------- user_settings
create table public.user_settings (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  settings    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  synced_at   timestamptz not null default clock_timestamp()
);

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------- deck_options
create table public.deck_options (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  name               text not null check (char_length(name) between 1 and 80),
  new_per_day        int  not null default 20  check (new_per_day between 0 and 9999),
  reviews_per_day    int  not null default 200 check (reviews_per_day between 0 and 9999),
  learning_steps     double precision[] not null default '{1,10}',
  relearning_steps   double precision[] not null default '{10}',
  desired_retention  double precision not null default 0.9 check (desired_retention between 0.7 and 0.99),
  maximum_interval   int  not null default 36500 check (maximum_interval between 1 and 36500),
  fsrs_params        double precision[] check (fsrs_params is null or array_length(fsrs_params, 1) = 19),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  synced_at   timestamptz not null default clock_timestamp(),
  deleted_at         timestamptz
);
create index deck_options_sync_idx on public.deck_options (user_id, synced_at, id);

-- ---------------------------------------------------------------- decks
create table public.decks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  parent_id   uuid references public.decks(id) on delete set null,
  name        text not null check (char_length(name) between 1 and 120 and position('::' in name) = 0),
  description text not null default '' check (char_length(description) <= 2000),
  options_id  uuid references public.deck_options(id) on delete set null,
  is_public   boolean not null default false,
  position    int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  synced_at   timestamptz not null default clock_timestamp(),
  deleted_at  timestamptz,
  check (parent_id is null or parent_id <> id)
);
create index decks_sync_idx   on public.decks (user_id, synced_at, id);
create index decks_parent_idx on public.decks (parent_id);
create index decks_public_idx on public.decks (is_public) where is_public and deleted_at is null;

-- ---------------------------------------------------------------- card_templates (note types)
create table public.card_templates (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 80),
  kind        text not null check (kind in
                ('basic','basic_reversed','basic_optional_reversed','cloze','multiple_choice','image','image_occlusion','audio','custom')),
  fields      jsonb not null check (jsonb_typeof(fields) = 'array'),
  templates   jsonb not null check (jsonb_typeof(templates) = 'array'),
  css         text not null default '' check (char_length(css) <= 20000),
  builtin     boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  synced_at   timestamptz not null default clock_timestamp(),
  deleted_at  timestamptz
);
create index card_templates_sync_idx on public.card_templates (user_id, synced_at, id);

-- ---------------------------------------------------------------- notes
create table public.notes (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  template_id  uuid not null references public.card_templates(id) on delete restrict,
  fields       jsonb not null check (jsonb_typeof(fields) = 'object'),
  tags         text[] not null default '{}',
  guid         text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  synced_at   timestamptz not null default clock_timestamp(),
  deleted_at   timestamptz,
  unique (user_id, guid)
);
create index notes_sync_idx on public.notes (user_id, synced_at, id);
create index notes_tags_idx on public.notes using gin (tags);

-- ---------------------------------------------------------------- tags / card_tags
create table public.tags (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 80),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  unique (user_id, name)
);

create table public.card_tags (
  note_id  uuid not null references public.notes(id) on delete cascade,
  tag_id   uuid not null references public.tags(id)  on delete cascade,
  user_id  uuid not null references auth.users(id)   on delete cascade,
  primary key (note_id, tag_id)
);
create index card_tags_tag_idx on public.card_tags (tag_id);

-- Keep tags / card_tags in step with notes.tags (the app writes notes.tags only).
create or replace function public.sync_note_tags() returns trigger
language plpgsql security definer set search_path = public as $$
declare t text; tid uuid;
begin
  delete from public.card_tags where note_id = new.id;
  if new.deleted_at is not null then return new; end if;
  foreach t in array new.tags loop
    insert into public.tags (user_id, name) values (new.user_id, t)
      on conflict (user_id, name) do update set deleted_at = null
      returning id into tid;
    insert into public.card_tags (note_id, tag_id, user_id) values (new.id, tid, new.user_id)
      on conflict do nothing;
  end loop;
  return new;
end $$;

create trigger notes_sync_tags after insert or update of tags, deleted_at on public.notes
  for each row execute function public.sync_note_tags();

-- ---------------------------------------------------------------- cards
create table public.cards (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  note_id         uuid not null references public.notes(id) on delete cascade,
  deck_id         uuid not null references public.decks(id) on delete restrict,
  ord             int  not null default 0 check (ord >= 0),
  state           smallint not null default 0 check (state between 0 and 3),
  due             timestamptz not null default now(),
  stability       double precision not null default 0 check (stability >= 0),
  difficulty      double precision not null default 0 check (difficulty >= 0 and difficulty <= 10),
  scheduled_days  int  not null default 0 check (scheduled_days >= 0),
  step            int  not null default 0 check (step >= 0),
  reps            int  not null default 0 check (reps >= 0),
  lapses          int  not null default 0 check (lapses >= 0),
  last_review     timestamptz,
  suspended       boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  synced_at   timestamptz not null default clock_timestamp(),
  deleted_at      timestamptz,
  unique (note_id, ord)
);
-- Query paths: due queue per deck, browser paging, incremental sync, per-note lookup.
create index cards_queue_idx   on public.cards (user_id, deck_id, state, due) where deleted_at is null and not suspended;
create index cards_browse_idx  on public.cards (user_id, created_at desc)     where deleted_at is null;
create index cards_review_idx  on public.cards (user_id, last_review desc)    where deleted_at is null;
create index cards_sync_idx    on public.cards (user_id, synced_at, id);
create index cards_note_idx    on public.cards (note_id);

-- ---------------------------------------------------------------- review_logs (append-only history)
create table public.review_logs (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  card_id         uuid not null references public.cards(id) on delete cascade,
  deck_id         uuid not null references public.decks(id) on delete cascade,
  rating          smallint not null check (rating between 1 and 4),
  state           smallint not null check (state between 0 and 3),
  stability       double precision not null,
  difficulty      double precision not null,
  elapsed_days    int not null default 0 check (elapsed_days >= 0),
  scheduled_days  int not null default 0 check (scheduled_days >= 0),
  duration_ms     int not null default 0 check (duration_ms between 0 and 3600000),
  reviewed_at     timestamptz not null,
  undone          boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  synced_at   timestamptz not null default clock_timestamp()
);
create index review_logs_user_time_idx on public.review_logs (user_id, reviewed_at desc);
create index review_logs_card_idx      on public.review_logs (card_id, reviewed_at);
create index review_logs_deck_idx      on public.review_logs (user_id, deck_id, reviewed_at desc);
create index review_logs_sync_idx      on public.review_logs (user_id, synced_at, id);

-- ---------------------------------------------------------------- sync_metadata
create table public.sync_metadata (
  user_id          uuid not null references auth.users(id) on delete cascade,
  device_id        text not null check (char_length(device_id) <= 80),
  last_pull_at     timestamptz,
  last_push_at     timestamptz,
  schema_version   int not null default 1,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (user_id, device_id)
);

-- ---------------------------------------------------------------- updated_at triggers
do $$
declare t text;
begin
  foreach t in array array['profiles','user_settings','deck_options','decks','card_templates','notes','tags',
                           'cards','review_logs','sync_metadata'] loop
    execute format('create trigger %I_updated_at before update on public.%I
                    for each row execute function public.set_updated_at()', t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------- sync triggers
-- Trigger names are chosen so BEFORE triggers fire in this order (Postgres sorts them by name):
--   a_lww_guard (may skip the row) -> <table>_*guard / <table>_updated_at -> z_synced_at (stamps the cursor).
do $$
declare t text;
begin
  foreach t in array array['user_settings','deck_options','decks','card_templates','notes','cards'] loop
    execute format('create trigger a_lww_guard before update on public.%I
                    for each row execute function public.lww_guard()', t);
  end loop;
  foreach t in array array['user_settings','deck_options','decks','card_templates','notes','cards','review_logs'] loop
    execute format('create trigger z_synced_at before insert or update on public.%I
                    for each row execute function public.touch_synced_at()', t);
  end loop;
end $$;

create trigger b_cards_history_guard before update on public.cards
  for each row execute function public.cards_history_guard();
