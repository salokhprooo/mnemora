-- Row Level Security. Users can only touch their own rows; public decks are readable by anyone signed in.
-- The frontend only ever holds the anon key, so RLS is the real authorization boundary.

alter table public.profiles       enable row level security;
alter table public.user_settings  enable row level security;
alter table public.deck_options   enable row level security;
alter table public.decks          enable row level security;
alter table public.card_templates enable row level security;
alter table public.notes          enable row level security;
alter table public.tags           enable row level security;
alter table public.card_tags      enable row level security;
alter table public.cards          enable row level security;
alter table public.review_logs    enable row level security;
alter table public.sync_metadata  enable row level security;

-- profiles: id = auth.uid() ----------------------------------------------------------------
create policy profiles_select on public.profiles for select using (id = (select auth.uid()));
create policy profiles_insert on public.profiles for insert with check (id = (select auth.uid()));
create policy profiles_update on public.profiles for update
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- user_settings ------------------------------------------------------------------------------
create policy user_settings_select on public.user_settings for select using (user_id = (select auth.uid()));
create policy user_settings_insert on public.user_settings for insert with check (user_id = (select auth.uid()));
create policy user_settings_update on public.user_settings for update
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Generic owner policies for the sync tables. WITH CHECK on UPDATE stops a user re-assigning rows
-- to someone else (changing user_id), and FK checks below stop cross-tenant references.
do $$
declare t text;
begin
  foreach t in array array['deck_options','card_templates','notes','tags','cards','review_logs','sync_metadata'] loop
    execute format('create policy %I_select on public.%I for select using (user_id = (select auth.uid()))', t, t);
    execute format('create policy %I_insert on public.%I for insert with check (user_id = (select auth.uid()))', t, t);
    execute format('create policy %I_update on public.%I for update
                    using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t, t);
    execute format('create policy %I_delete on public.%I for delete using (user_id = (select auth.uid()))', t, t);
  end loop;
end $$;

-- review_logs are append-only history: no deletes from clients.
drop policy review_logs_delete on public.review_logs;

-- decks: owner full access; public (non-deleted) decks are readable by any authenticated user.
create policy decks_select on public.decks for select
  using (user_id = (select auth.uid()) or (is_public and deleted_at is null and (select auth.uid()) is not null));
create policy decks_insert on public.decks for insert with check (user_id = (select auth.uid()));
create policy decks_update on public.decks for update
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy decks_delete on public.decks for delete using (user_id = (select auth.uid()));

-- Cards/notes of a public deck are readable (read-only) so decks can be shared and cloned.
create policy cards_select_public on public.cards for select
  using (deleted_at is null and exists (
    select 1 from public.decks d where d.id = cards.deck_id and d.is_public and d.deleted_at is null));
create policy notes_select_public on public.notes for select
  using (deleted_at is null and exists (
    select 1 from public.cards c join public.decks d on d.id = c.deck_id
    where c.note_id = notes.id and d.is_public and d.deleted_at is null));
create policy templates_select_public on public.card_templates for select
  using (deleted_at is null and exists (
    select 1 from public.notes n join public.cards c on c.note_id = n.id join public.decks d on d.id = c.deck_id
    where n.template_id = card_templates.id and d.is_public and d.deleted_at is null));

-- card_tags: owner only (written by the sync_note_tags trigger, security definer).
create policy card_tags_select on public.card_tags for select using (user_id = (select auth.uid()));

-- ------------------------------------------------------------------------------------------
-- Cross-tenant reference guard: a row may only point at rows owned by the same user.
-- (RLS filters reads, but a plain FK would still let user A reference user B's deck id.)
create or replace function public.assert_same_owner() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'cards' then
    if not exists (select 1 from public.notes n where n.id = new.note_id and n.user_id = new.user_id)
       or not exists (select 1 from public.decks d where d.id = new.deck_id and d.user_id = new.user_id) then
      raise exception 'foreign reference belongs to another user' using errcode = '42501';
    end if;
  elsif tg_table_name = 'notes' then
    if not exists (select 1 from public.card_templates t where t.id = new.template_id and t.user_id = new.user_id) then
      raise exception 'foreign reference belongs to another user' using errcode = '42501';
    end if;
  elsif tg_table_name = 'review_logs' then
    if not exists (select 1 from public.cards c where c.id = new.card_id and c.user_id = new.user_id) then
      raise exception 'foreign reference belongs to another user' using errcode = '42501';
    end if;
  elsif tg_table_name = 'decks' then
    if new.parent_id is not null and not exists (
         select 1 from public.decks d where d.id = new.parent_id and d.user_id = new.user_id) then
      raise exception 'foreign reference belongs to another user' using errcode = '42501';
    end if;
    if new.options_id is not null and not exists (
         select 1 from public.deck_options o where o.id = new.options_id and o.user_id = new.user_id) then
      raise exception 'foreign reference belongs to another user' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

create trigger cards_owner_guard       before insert or update on public.cards       for each row execute function public.assert_same_owner();
create trigger notes_owner_guard       before insert or update on public.notes       for each row execute function public.assert_same_owner();
create trigger review_logs_owner_guard before insert or update on public.review_logs for each row execute function public.assert_same_owner();
create trigger decks_owner_guard       before insert or update on public.decks       for each row execute function public.assert_same_owner();

-- ------------------------------------------------------------------------------------------
-- Review history must never be rewritten by an older client: only `undone` may flip, nothing else.
create or replace function public.protect_review_log() returns trigger
language plpgsql as $$
begin
  if new.id is distinct from old.id or new.user_id is distinct from old.user_id
     or new.card_id is distinct from old.card_id or new.rating is distinct from old.rating
     or new.reviewed_at is distinct from old.reviewed_at or new.state is distinct from old.state
     or new.stability is distinct from old.stability or new.difficulty is distinct from old.difficulty
     or new.elapsed_days is distinct from old.elapsed_days or new.scheduled_days is distinct from old.scheduled_days
     or new.duration_ms is distinct from old.duration_ms then
    raise exception 'review_logs are append-only' using errcode = '42501';
  end if;
  -- `undone` is monotonic: once true it stays true.
  new.undone := old.undone or new.undone;
  return new;
end $$;
create trigger review_logs_protect before update on public.review_logs
  for each row execute function public.protect_review_log();
