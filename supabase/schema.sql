-- Brawl Stars Analytics database (Supabase / Postgres). Already applied to the live project; kept here for reference.

-- One row per stats reading. trophies/club_trophies/nb are set when that feed answered; the bulky
-- brawler and club-member lists are only stored when they changed since the previous reading.
create table public.readings (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  nb timestamptz,                 -- newest battle contained in this reading
  src text not null default 'auto',
  trophies integer,
  club_trophies integer,
  player jsonb,
  brawlers jsonb,                 -- only the brawlers that changed since the previous list
  club jsonb,
  checked timestamptz,            -- last time a refresh found nothing new and confirmed this reading
  club_upd jsonb                  -- between full club lists: only the members whose trophies moved
);
create index readings_ts_idx on public.readings (ts desc);

create table public.battles (
  t timestamptz primary key,      -- battle time from the game
  mode text,
  map text,
  result text,
  win boolean,
  tc integer,                     -- trophy change
  brawler text,
  ranked boolean not null default false,
  event_id bigint                 -- the game's id for the mode + map (used for map pictures)
);

create table public.goals (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('player', 'club', 'brawler', 'elo')),
  target integer not null check (target > 0),
  brawler text,
  start integer,
  created_at timestamptz not null default now()
);

-- Private settings (owner code hash). No policies: only the server function can read it.
create table public.settings (
  key text primary key,
  value text not null
);
-- settings also holds 'brawlers_full' and 'club_full' (the current full lists), 'vapid' (the server's
-- private push keys) and 'notify_state' (what was last announced), all written by the function.
-- insert into public.settings values ('owner_code_sha256', encode(sha256(convert_to('YOURCODE', 'UTF8')), 'hex'));

alter table public.readings enable row level security;
alter table public.battles enable row level security;
alter table public.goals enable row level security;
alter table public.settings enable row level security;

create policy "Anyone can read readings" on public.readings for select to anon, authenticated using (true);
create policy "Anyone can read battles" on public.battles for select to anon, authenticated using (true);
create policy "Anyone can read goals" on public.goals for select to anon, authenticated using (true);

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

-- Save a reading every 15 minutes, even when nobody has the app open.
select cron.schedule(
  'brawl-refresh',
  '7,22,37,52 * * * *',
  $$ select net.http_post(
       url := 'https://iuukdskmzjglpvtlwldw.supabase.co/functions/v1/brawl',
       body := '{"action":"refresh","src":"auto"}'::jsonb,
       headers := '{"Content-Type":"application/json"}'::jsonb,
       timeout_milliseconds := 60000) $$
);

-- Devices that turned on notifications. Private: only the server function reads or writes it.
create table public.push_subs (
  endpoint text primary key,
  p256dh text not null,
  auth text not null,
  prefs jsonb not null default '{"goals": true, "milestones": true, "roster": true, "recap": true}'::jsonb,
  created_at timestamptz not null default now(),
  last_sent_at timestamptz
);
alter table public.push_subs enable row level security;

-- Nightly recap notification at 10 PM Shanghai time (14:00 UTC).
select cron.schedule(
  'brawl-recap',
  '0 14 * * *',
  $$ select net.http_post(
       url := 'https://iuukdskmzjglpvtlwldw.supabase.co/functions/v1/brawl',
       body := '{"action":"recap"}'::jsonb,
       headers := '{"Content-Type":"application/json"}'::jsonb,
       timeout_milliseconds := 60000) $$
);
