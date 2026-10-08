-- Last Card database (Supabase). Paste all of this into the SQL Editor and run it once.
-- One row per table (game room). Every player's browser reads the row, applies a move with the
-- game rules in engine.js, and saves it back through lc_save, which only accepts the save if
-- nobody else saved first (version check). Realtime pushes each saved row to everyone at the table.

create table if not exists public.lc_rooms (
  code text primary key check (code ~ '^[a-z0-9-]{1,24}$'),
  version int not null default 1,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.lc_rooms enable row level security;
revoke all on public.lc_rooms from anon, authenticated;
grant usage on schema public to anon, authenticated;
grant select on public.lc_rooms to anon, authenticated;
drop policy if exists "anyone can read tables" on public.lc_rooms;
create policy "anyone can read tables" on public.lc_rooms for select to anon, authenticated using (true);

-- Save a table. p_version is the version the browser started from (0 for a brand new table).
-- Returns the new version, or -1 if someone else saved first (the browser reloads and retries).
create or replace function public.lc_save(p_code text, p_version int, p_state jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare
  v int;
begin
  if coalesce(p_code, '') !~ '^[a-z0-9-]{1,24}$' then raise exception 'bad_code'; end if;
  if p_state is null or jsonb_typeof(p_state) <> 'object' then raise exception 'bad_state'; end if;
  if pg_column_size(p_state) > 100000 then raise exception 'too_big'; end if;
  if p_version = 0 then
    insert into public.lc_rooms (code, version, state) values (p_code, 1, p_state)
    on conflict (code) do nothing
    returning version into v;
  else
    update public.lc_rooms set state = p_state, version = version + 1, updated_at = now()
    where code = p_code and version = p_version
    returning version into v;
  end if;
  return coalesce(v, -1);
end $$;
revoke all on function public.lc_save(text, int, jsonb) from public;
grant execute on function public.lc_save(text, int, jsonb) to anon, authenticated;

-- Live updates: send every saved row to the players at that table.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'lc_rooms'
  ) then
    alter publication supabase_realtime add table public.lc_rooms;
  end if;
end $$;

-- Optional cleanup of tables nobody has touched in 30 days:
-- delete from public.lc_rooms where updated_at < now() - interval '30 days';
