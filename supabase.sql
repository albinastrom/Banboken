-- Banboken – databas för molnsynk och livematcher (Supabase, gratisnivån räcker).
-- Kör hela filen en gång i Supabase: SQL Editor → New query → klistra in → Run.
-- Säkerhet: Row Level Security är på för alla tabeller. Varje användare ser bara sina egna dokument.
-- Livematcher kan bara läsas och uppdateras via funktionerna längst ned, och bara med matchens kod.

-- ---------- Användarens dokument (ronder, banor, profil, golfbag, vänner, referens) ----------
create table if not exists public.user_docs (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind       text not null check (kind in ('round','course','profile','bag','friends','baseline','ratings')),
  doc_id     text not null check (char_length(doc_id) between 1 and 64),
  data       jsonb,
  deleted    boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, kind, doc_id),
  constraint user_docs_size check (pg_column_size(data) < 400000)
);
create index if not exists user_docs_changes on public.user_docs (user_id, updated_at);
alter table public.user_docs enable row level security;

drop policy if exists "egna dokument läsa" on public.user_docs;
drop policy if exists "egna dokument skapa" on public.user_docs;
drop policy if exists "egna dokument ändra" on public.user_docs;
drop policy if exists "egna dokument ta bort" on public.user_docs;
create policy "egna dokument läsa"    on public.user_docs for select using (auth.uid() = user_id);
create policy "egna dokument skapa"   on public.user_docs for insert with check (auth.uid() = user_id);
create policy "egna dokument ändra"   on public.user_docs for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "egna dokument ta bort" on public.user_docs for delete using (auth.uid() = user_id);

-- Servern sätter alltid tiden, så telefonernas klockor spelar ingen roll.
create or replace function public.banboken_touch() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end $$;
drop trigger if exists user_docs_touch on public.user_docs;
create trigger user_docs_touch before insert or update on public.user_docs
  for each row execute function public.banboken_touch();

-- Om tabellen redan fanns från en tidigare version: tillåt även dokumenttypen 'ratings'.
alter table public.user_docs drop constraint if exists user_docs_kind_check;
alter table public.user_docs add constraint user_docs_kind_check check (kind in ('round','course','profile','bag','friends','baseline','ratings'));

-- ---------- Delad officiell slopetabell ----------
-- Alla (även utan konto) kan läsa. Bara konton i banboken_admins kan skapa, ändra eller ta bort rader.
create table if not exists public.banboken_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  added_at timestamptz not null default now()
);
alter table public.banboken_admins enable row level security;   -- inga policies: hanteras bara i SQL Editor

create or replace function public.is_banboken_admin() returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.banboken_admins where user_id = auth.uid());
$$;
revoke all on function public.is_banboken_admin() from public;
grant execute on function public.is_banboken_admin() to anon, authenticated;

create table if not exists public.tee_ratings (
  rk         text primary key check (char_length(rk) between 5 and 300),
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  -- Grundkontroller i databasen; appen validerar dessutom alla fält vid import.
  constraint tee_ratings_valid check (
    (data->>'gender') in ('men','women') and (data->>'holes') in ('18','front9','back9')
    and (data->>'slope')::numeric between 55 and 155
    and (data->>'cr')::numeric between 25 and 90
    and char_length(coalesce(data->>'source','')) > 0
    and (data->>'verifiedAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
  )
);
alter table public.tee_ratings enable row level security;
drop policy if exists "alla läser slopetabellen" on public.tee_ratings;
drop policy if exists "admin skriver slopetabellen" on public.tee_ratings;
create policy "alla läser slopetabellen" on public.tee_ratings for select using (true);
create policy "admin skriver slopetabellen" on public.tee_ratings for all
  using (public.is_banboken_admin()) with check (public.is_banboken_admin());
drop trigger if exists tee_ratings_touch on public.tee_ratings;
create trigger tee_ratings_touch before insert or update on public.tee_ratings
  for each row execute function public.banboken_touch();

-- Gör dig själv till administratör (byt e-postadressen och kör raden efter att du loggat in i appen en gång):
-- insert into public.banboken_admins (user_id) select id from auth.users where email = 'din@epost.se';

-- ---------- Livematcher ----------
create table if not exists public.live_matches (
  code       text primary key check (code ~ '^[A-HJ-NP-Z2-9]{8}$'),
  owner      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '2 days',
  constraint live_matches_size check (pg_column_size(data) < 200000)
);
alter table public.live_matches enable row level security;
drop policy if exists "ägaren styr matchen" on public.live_matches;
create policy "ägaren styr matchen" on public.live_matches for all
  using (auth.uid() = owner) with check (auth.uid() = owner);
drop trigger if exists live_matches_touch on public.live_matches;
create trigger live_matches_touch before insert or update on public.live_matches
  for each row execute function public.banboken_touch();

-- Spelarnas egna resultat i en livematch. Inga policies: nås bara via funktionerna nedan.
create table if not exists public.live_scores (
  code       text not null references public.live_matches(code) on delete cascade,
  player_id  text not null check (char_length(player_id) between 1 and 40),
  holes      jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (code, player_id)
);
alter table public.live_scores enable row level security;

-- Läs en livematch med kod (även utan konto). Ingen kan lista alla matcher.
create or replace function public.get_live_match(p_code text)
returns table (data jsonb, updated_at timestamptz, scores jsonb)
language sql security definer stable set search_path = public as $$
  select m.data, m.updated_at,
         coalesce((select jsonb_object_agg(s.player_id, jsonb_build_object('h', s.holes, 't', s.updated_at))
                   from public.live_scores s where s.code = m.code), '{}'::jsonb)
  from public.live_matches m
  where m.code = upper(p_code) and m.expires_at > now();
$$;

-- En medspelare för in sina egna hålresultat (packade: -1 struket, 0 tomt, 1–20 slag).
create or replace function public.live_put_player(p_code text, p_player text, p_holes jsonb)
returns void
language plpgsql security definer set search_path = public as $$
declare ok boolean;
begin
  if not exists (
    select 1 from public.live_matches m, jsonb_array_elements(m.data -> 'x') e
    where m.code = upper(p_code) and m.expires_at > now() and e ->> 'i' = p_player
  ) then
    raise exception 'Matchen eller spelaren finns inte';
  end if;
  if jsonb_typeof(p_holes) <> 'array' or jsonb_array_length(p_holes) > 18 then
    raise exception 'Felaktiga hål';
  end if;
  select bool_and(jsonb_typeof(v) = 'number' and (v #>> '{}')::numeric between -1 and 20
                  and (v #>> '{}')::numeric = trunc((v #>> '{}')::numeric))
    into ok from jsonb_array_elements(p_holes) v;
  if ok is not true then raise exception 'Felaktiga värden'; end if;
  insert into public.live_scores (code, player_id, holes)
  values (upper(p_code), p_player, p_holes)
  on conflict (code, player_id) do update set holes = excluded.holes, updated_at = now();
end $$;

revoke all on function public.get_live_match(text) from public;
revoke all on function public.live_put_player(text, text, jsonb) from public;
grant execute on function public.get_live_match(text) to anon, authenticated;
grant execute on function public.live_put_player(text, text, jsonb) to anon, authenticated;

-- Städa bort gamla livematcher (kör gärna ibland, eller schemalägg med pg_cron):
-- delete from public.live_matches where expires_at < now();
