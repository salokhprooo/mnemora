-- RLS / integrity tests. Each check RAISEs NOTICE 'PASS ...' or 'FAIL ...'. Runs as superuser, switches role per check.
\set ON_ERROR_STOP off
set client_min_messages = notice;

-- two users + a third for public-deck checks
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'alice@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'bob@example.com');

create or replace function pg_temp.as_user(u uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', u::text, false);
  execute 'set role authenticated';
end $$;
create or replace function pg_temp.as_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', false);
  execute 'set role anon';
end $$;
create or replace function pg_temp.check(name text, ok boolean) returns void language plpgsql as $$
begin raise notice '%', case when ok then 'PASS ' || name else 'FAIL ' || name end; end $$;

-- ---- signup trigger created profile + settings
select pg_temp.check('signup trigger creates profile', (select count(*) from profiles) = 2);
select pg_temp.check('signup trigger creates user_settings', (select count(*) from user_settings) = 2);

-- ---- Alice builds a collection
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
insert into deck_options (id, user_id, name) values ('a0000000-0000-0000-0000-000000000001', auth.uid(), 'Default');
insert into decks (id, user_id, name, options_id) values ('a0000000-0000-0000-0000-0000000000d1', auth.uid(), 'Spanish', 'a0000000-0000-0000-0000-000000000001');
insert into card_templates (id, user_id, name, kind, fields, templates)
  values ('a0000000-0000-0000-0000-0000000000e1', auth.uid(), 'Basic', 'basic', '["Front","Back"]', '[{"name":"Card 1","front":"{{Front}}","back":"{{Back}}"}]');
insert into notes (id, user_id, template_id, fields, tags, guid)
  values ('a0000000-0000-0000-0000-0000000000f1', auth.uid(), 'a0000000-0000-0000-0000-0000000000e1', '{"Front":"hola","Back":"hello"}', '{greetings,a1}', 'g1');
insert into cards (id, user_id, note_id, deck_id) values ('a0000000-0000-0000-0000-0000000000c1', auth.uid(), 'a0000000-0000-0000-0000-0000000000f1', 'a0000000-0000-0000-0000-0000000000d1');
insert into review_logs (id, user_id, card_id, deck_id, rating, state, stability, difficulty, reviewed_at)
  values ('a0000000-0000-0000-0000-0000000000b1', auth.uid(), 'a0000000-0000-0000-0000-0000000000c1', 'a0000000-0000-0000-0000-0000000000d1', 3, 0, 3.1, 5.2, now());
select pg_temp.check('owner can read own cards', (select count(*) from cards) = 1);
select pg_temp.check('tag trigger populated card_tags', (select count(*) from card_tags) = 2);
reset role;

-- ---- Bob cannot see or touch Alice's data
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.check('bob sees 0 cards',       (select count(*) from cards) = 0);
select pg_temp.check('bob sees 0 notes',       (select count(*) from notes) = 0);
select pg_temp.check('bob sees 0 review_logs', (select count(*) from review_logs) = 0);
select pg_temp.check('bob sees 0 decks',       (select count(*) from decks) = 0);
select pg_temp.check('bob sees 0 tags',        (select count(*) from tags) = 0);
select pg_temp.check('bob sees only his profile', (select count(*) from profiles) = 1);

update cards set reps = 99 where id = 'a0000000-0000-0000-0000-0000000000c1';
delete from decks where id = 'a0000000-0000-0000-0000-0000000000d1';
reset role;
select pg_temp.check('bob UPDATE/DELETE affected nothing',
  (select reps from cards where id = 'a0000000-0000-0000-0000-0000000000c1') = 0
  and exists (select 1 from decks where id = 'a0000000-0000-0000-0000-0000000000d1'));

-- Bob cannot insert rows claiming to be Alice
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
do $$ begin
  begin
    insert into decks (user_id, name) values ('00000000-0000-0000-0000-00000000000a', 'evil');
    perform pg_temp.check('bob cannot insert as alice', false);
  exception when others then perform pg_temp.check('bob cannot insert as alice', true); end;
end $$;

-- Bob cannot re-assign his own row to Alice (UPDATE ... WITH CHECK)
insert into decks (id, user_id, name) values ('b0000000-0000-0000-0000-0000000000d1', auth.uid(), 'Bob deck');
do $$ begin
  begin
    update decks set user_id = '00000000-0000-0000-0000-00000000000a' where id = 'b0000000-0000-0000-0000-0000000000d1';
    perform pg_temp.check('bob cannot transfer row to alice', false);
  exception when others then perform pg_temp.check('bob cannot transfer row to alice', true); end;
end $$;

-- Cross-tenant reference: Bob's card pointing at Alice's note/deck must be rejected by the guard trigger
insert into card_templates (id, user_id, name, kind, fields, templates)
  values ('b0000000-0000-0000-0000-0000000000e1', auth.uid(), 'Basic', 'basic', '["Front","Back"]', '[]');
insert into notes (id, user_id, template_id, fields, guid)
  values ('b0000000-0000-0000-0000-0000000000f1', auth.uid(), 'b0000000-0000-0000-0000-0000000000e1', '{}', 'bg1');
do $$ begin
  begin
    insert into cards (user_id, note_id, deck_id, ord) values (auth.uid(), 'b0000000-0000-0000-0000-0000000000f1', 'a0000000-0000-0000-0000-0000000000d1', 0);
    perform pg_temp.check('cannot reference another user''s deck', false);
  exception when others then perform pg_temp.check('cannot reference another user''s deck', true); end;
  begin
    insert into notes (user_id, template_id, fields, guid) values (auth.uid(), 'a0000000-0000-0000-0000-0000000000e1', '{}', 'bg2');
    perform pg_temp.check('cannot use another user''s template', false);
  exception when others then perform pg_temp.check('cannot use another user''s template', true); end;
  begin
    insert into review_logs (user_id, card_id, deck_id, rating, state, stability, difficulty, reviewed_at)
      values (auth.uid(), 'a0000000-0000-0000-0000-0000000000c1', 'b0000000-0000-0000-0000-0000000000d1', 3, 0, 1, 5, now());
    perform pg_temp.check('cannot log review on another user''s card', false);
  exception when others then perform pg_temp.check('cannot log review on another user''s card', true); end;
end $$;
reset role;

-- ---- review_logs are append-only for clients
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
do $$ declare n int; begin
  delete from review_logs where id = 'a0000000-0000-0000-0000-0000000000b1';
  get diagnostics n = row_count;
  perform pg_temp.check('client cannot delete review_logs', n = 0);
end $$;
do $$ begin
  begin
    update review_logs set rating = 1 where id = 'a0000000-0000-0000-0000-0000000000b1';
    perform pg_temp.check('client cannot rewrite review rating', false);
  exception when others then perform pg_temp.check('client cannot rewrite review rating', true); end;
end $$;
update review_logs set undone = true where id = 'a0000000-0000-0000-0000-0000000000b1';
update review_logs set undone = false where id = 'a0000000-0000-0000-0000-0000000000b1';
select pg_temp.check('undone flag is monotonic (cannot be reset)', (select undone from review_logs) = true);
reset role;

-- ---- public decks: readable by other signed-in users, read-only, hidden from anon cards
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
update decks set is_public = true where id = 'a0000000-0000-0000-0000-0000000000d1';
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.check('bob can read alice''s PUBLIC deck', (select count(*) from decks where id = 'a0000000-0000-0000-0000-0000000000d1') = 1);
select pg_temp.check('bob can read cards of public deck', (select count(*) from cards where deck_id = 'a0000000-0000-0000-0000-0000000000d1') = 1);
select pg_temp.check('bob can read note+template of public deck',
  (select count(*) from notes where id = 'a0000000-0000-0000-0000-0000000000f1') = 1
  and (select count(*) from card_templates where id = 'a0000000-0000-0000-0000-0000000000e1') = 1);
select pg_temp.check('bob still cannot read alice''s review_logs', (select count(*) from review_logs) = 0);
update decks set name = 'hacked' where id = 'a0000000-0000-0000-0000-0000000000d1';
update cards set reps = 5 where id = 'a0000000-0000-0000-0000-0000000000c1';
reset role;
select pg_temp.check('bob cannot modify public deck or its cards',
  (select name from decks where id = 'a0000000-0000-0000-0000-0000000000d1') = 'Spanish'
  and (select reps from cards where id = 'a0000000-0000-0000-0000-0000000000c1') = 0);
select pg_temp.as_anon();
select pg_temp.check('anon sees no cards', (select count(*) from cards) = 0);
select pg_temp.check('anon sees no notes', (select count(*) from notes) = 0);
select pg_temp.check('anon sees no profiles', (select count(*) from profiles) = 0);
reset role;

-- ---- soft-deleted public deck is hidden
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
update decks set deleted_at = now() where id = 'a0000000-0000-0000-0000-0000000000d1';
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.check('deleted public deck disappears for others', (select count(*) from decks where id = 'a0000000-0000-0000-0000-0000000000d1') = 0);
reset role;

-- ---- constraints
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
do $$ begin
  begin insert into decks (user_id, name) values (auth.uid(), 'bad::name'); perform pg_temp.check('deck name rejects ::', false);
  exception when check_violation then perform pg_temp.check('deck name rejects ::', true); end;
  begin insert into deck_options (user_id, name, desired_retention) values (auth.uid(), 'x', 1.5); perform pg_temp.check('retention constraint', false);
  exception when check_violation then perform pg_temp.check('retention constraint', true); end;
  begin insert into cards (user_id, note_id, deck_id, state) values (auth.uid(), 'a0000000-0000-0000-0000-0000000000f1', 'a0000000-0000-0000-0000-0000000000d1', 9); perform pg_temp.check('card state constraint', false);
  exception when others then perform pg_temp.check('card state constraint', true); end;
  begin insert into notes (user_id, template_id, fields, guid) values (auth.uid(), 'a0000000-0000-0000-0000-0000000000e1', '{}', 'g1'); perform pg_temp.check('duplicate note guid rejected', false);
  exception when unique_violation then perform pg_temp.check('duplicate note guid rejected', true); end;
end $$;
reset role;

-- ---- delete_my_data()
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select public.delete_my_data();
reset role;
select pg_temp.check('delete_my_data wipes only the caller',
  (select count(*) from decks where user_id = '00000000-0000-0000-0000-00000000000b') = 0
  and (select count(*) from cards where user_id = '00000000-0000-0000-0000-00000000000a') = 1);
select pg_temp.as_anon();
do $$ begin
  begin perform public.delete_my_data(); perform pg_temp.check('anon cannot call delete_my_data', false);
  exception when others then perform pg_temp.check('anon cannot call delete_my_data', true); end;
end $$;
reset role;

-- ---- indexes exist for the hot query paths
select pg_temp.check('queue / browse / sync indexes exist',
  (select count(*) from pg_indexes where schemaname = 'public'
     and indexname in ('cards_queue_idx','cards_browse_idx','cards_sync_idx','review_logs_user_time_idx','review_logs_card_idx','notes_tags_idx')) = 6);

-- ---- every public table has RLS enabled
select pg_temp.check('RLS enabled on all public tables',
  (select count(*) from pg_tables where schemaname = 'public' and not rowsecurity) = 0);

-- ---- sync semantics: server cursor, last-writer-wins guard, clock clamp
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
insert into decks (id, user_id, name, updated_at) values ('a0000000-0000-0000-0000-0000000000d9', auth.uid(), 'Sync1', '2026-01-01T10:00:00Z');
reset role;
create temp table s1 as select synced_at as t1, updated_at as u1 from decks where id = 'a0000000-0000-0000-0000-0000000000d9';
select pg_temp.check('client-supplied updated_at is kept on insert', (select u1 = '2026-01-01T10:00:00Z' from s1));
select pg_temp.check('synced_at is server time, not the client time', (select t1 > now() - interval '1 minute' from s1));

select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
update decks set name = 'Newer', updated_at = '2026-01-02T10:00:00Z' where id = 'a0000000-0000-0000-0000-0000000000d9';
reset role;
select pg_temp.check('newer client write is applied', (select name = 'Newer' from decks where id = 'a0000000-0000-0000-0000-0000000000d9'));
select pg_temp.check('synced_at advanced for a write that carries an OLD updated_at (offline-device case)',
  (select synced_at > (select t1 from s1) from decks where id = 'a0000000-0000-0000-0000-0000000000d9'));

create temp table s2 as select synced_at as t2 from decks where id = 'a0000000-0000-0000-0000-0000000000d9';
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
update decks set name = 'Stale', updated_at = '2026-01-01T12:00:00Z' where id = 'a0000000-0000-0000-0000-0000000000d9';
reset role;
select pg_temp.check('stale write (older updated_at) is silently skipped',
  (select name = 'Newer' and updated_at = '2026-01-02T10:00:00Z' from decks where id = 'a0000000-0000-0000-0000-0000000000d9'));
select pg_temp.check('a skipped write does not move the sync cursor',
  (select synced_at = (select t2 from s2) from decks where id = 'a0000000-0000-0000-0000-0000000000d9'));

select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
update decks set name = 'Equal', updated_at = '2026-01-02T10:00:00Z' where id = 'a0000000-0000-0000-0000-0000000000d9';
reset role;
select pg_temp.check('equal updated_at is accepted (idempotent re-push)', (select name = 'Equal' from decks where id = 'a0000000-0000-0000-0000-0000000000d9'));

select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
update decks set name = 'Future', updated_at = now() + interval '400 days' where id = 'a0000000-0000-0000-0000-0000000000d9';
reset role;
select pg_temp.check('a far-future client clock is clamped (+5 min max)',
  (select updated_at <= now() + interval '6 minutes' from decks where id = 'a0000000-0000-0000-0000-0000000000d9'));

-- upsert (the exact statement shape the sync client uses) honours the guard too
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
insert into decks (id, user_id, name, updated_at) values ('a0000000-0000-0000-0000-0000000000d9', auth.uid(), 'OldUpsert', '2020-01-01T00:00:00Z')
  on conflict (id) do update set name = excluded.name, updated_at = excluded.updated_at;
reset role;
select pg_temp.check('stale UPSERT cannot overwrite a newer row', (select name = 'Future' from decks where id = 'a0000000-0000-0000-0000-0000000000d9'));

-- ---- review history can never go backwards (cards_history_guard)
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
update cards set state = 2, reps = 5, lapses = 1, stability = 12.5, difficulty = 4.2, scheduled_days = 12,
                 last_review = '2026-03-01T10:00:00Z', due = '2026-03-13T10:00:00Z'
  where id = 'a0000000-0000-0000-0000-0000000000c1';
-- a stale device uploads an OLDER snapshot (and a newer updated_at) together with an unrelated edit
update cards set reps = 1, state = 1, stability = 1, last_review = '2026-02-01T10:00:00Z', suspended = true,
                 updated_at = now()
  where id = 'a0000000-0000-0000-0000-0000000000c1';
reset role;
select pg_temp.check('stale snapshot cannot regress reps / last_review',
  (select reps = 5 and last_review = '2026-03-01T10:00:00Z' and state = 2 and stability = 12.5 and lapses = 1 from cards where id = 'a0000000-0000-0000-0000-0000000000c1'));
select pg_temp.check('...but the unrelated edit (suspended) is still applied',
  (select suspended from cards where id = 'a0000000-0000-0000-0000-0000000000c1'));

select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
update cards set reps = 6, last_review = '2026-03-02T10:00:00Z', stability = 20, updated_at = now()
  where id = 'a0000000-0000-0000-0000-0000000000c1';
reset role;
select pg_temp.check('a genuinely newer review is accepted',
  (select reps = 6 and last_review = '2026-03-02T10:00:00Z' and stability = 20 from cards where id = 'a0000000-0000-0000-0000-0000000000c1'));
