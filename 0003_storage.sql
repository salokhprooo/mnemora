-- Media storage (images / audio attached to notes) + public-deck helpers.
-- Objects live under  <user_id>/<filename>  so the first path segment is the owner.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'media', 'media', false, 10485760,   -- 10 MB per file
  array['image/png','image/jpeg','image/gif','image/webp','audio/mpeg','audio/mp4','audio/ogg','audio/wav','audio/webm']
)
on conflict (id) do update set file_size_limit = excluded.file_size_limit,
                               allowed_mime_types = excluded.allowed_mime_types,
                               public = false;

-- SVG is deliberately NOT allowed (it can carry scripts).

create policy media_select on storage.objects for select to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy media_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy media_update on storage.objects for update to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy media_delete on storage.objects for delete to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- Account deletion: the user removes their own data; auth.users cascade removes everything else.
-- (Deleting the auth user itself needs the service role, so do it from an Edge Function, never the browser.)
create or replace function public.delete_my_data() returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  delete from public.review_logs   where user_id = auth.uid();
  delete from public.cards         where user_id = auth.uid();
  delete from public.notes         where user_id = auth.uid();
  delete from public.decks         where user_id = auth.uid();
  delete from public.card_templates where user_id = auth.uid();
  delete from public.deck_options  where user_id = auth.uid();
  delete from public.tags          where user_id = auth.uid();
  delete from public.sync_metadata where user_id = auth.uid();
end $$;
revoke all on function public.delete_my_data() from public, anon;
grant execute on function public.delete_my_data() to authenticated;
