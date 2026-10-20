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
-- settings also holds 'brawlers_full' and 'club_full' (the current full lists), 'activity_at' (when
-- battle logs were last read), 'vapid' (the server's private push keys) and 'notify_state' (what was
-- last announced), all written by the function.
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

-- Save a reading for every profile every 15 minutes, even when nobody has the app open.
-- (Replaced by the per-profile schedule in "Multiple players" below.)

-- Devices that turned on notifications. Private: only the server function reads or writes it.
create table public.push_subs (
  endpoint text primary key,
  p256dh text not null,
  auth text not null,
  -- also recap_at ("HH:MM", the device's chosen daily recap time) and tz (the device's time zone)
  prefs jsonb not null default '{"goals": true, "milestones": true, "roster": true, "recap": true}'::jsonb,
  created_at timestamptz not null default now(),
  last_sent_at timestamptz,
  last_recap text  -- local date of the last daily recap this device got
);
alter table public.push_subs enable row level security;

-- Daily recap: every 5 minutes, send it to devices whose chosen time has just passed.
select cron.schedule(
  'brawl-recap',
  '*/5 * * * *',
  $$ select net.http_post(
       url := 'https://iuukdskmzjglpvtlwldw.supabase.co/functions/v1/brawl',
       body := '{"action":"recap"}'::jsonb,
       headers := '{"Content-Type":"application/json"}'::jsonb,
       timeout_milliseconds := 60000) $$
);

-- Play sessions of club members, built from their battle logs: battles less than 20 minutes apart
-- belong to the same session. Brawl Stars doesn't share online status, so playing is the signal.
create table if not exists public.sessions (
  id bigint generated always as identity primary key,
  tag text not null,
  started_at timestamptz not null,   -- about 3 minutes before the first battle ended
  ended_at timestamptz not null,     -- when the last battle ended
  battles integer not null default 1,
  tc integer not null default 0,     -- trophies won or lost in the session
  modes jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create index if not exists sessions_tag_end_idx on public.sessions (tag, ended_at desc);
create index if not exists sessions_end_idx on public.sessions (ended_at);
create index if not exists sessions_updated_idx on public.sessions (updated_at);
alter table public.sessions enable row level security;
create policy "Anyone can read sessions" on public.sessions for select to anon, authenticated using (true);

-- Each member's most recent session (what the server extends when new battles arrive).
create or replace view public.latest_sessions with (security_invoker = true) as
  select distinct on (tag) * from public.sessions order by tag, ended_at desc;

-- ---------- Multiple players ----------
-- Profiles: every tracked player (and the club it follows). Readable by anyone, like the stats.
create table public.profiles (
  tag text primary key,
  club text,
  name text,
  icon bigint,
  trophies integer,
  club_name text,
  club_badge bigint,                       -- the club's badge picture id
  follow boolean not null default true,    -- follow whatever club the player is in
  created_at timestamptz not null default now(),
  last_open_at timestamptz not null default now(),
  last_refresh_at timestamptz,
  active boolean not null default true,    -- false = paused (nobody opened it for 30 days)
  keep boolean not null default false      -- never pause
);
alter table public.profiles enable row level security;
create policy "Anyone can read profiles" on public.profiles for select to anon, authenticated using (true);

-- Each profile's code (guards its goals and alerts). Private: only the server function reads it.
create table public.profile_codes (
  tag text primary key references public.profiles(tag) on delete cascade,
  code_sha256 text not null
);
alter table public.profile_codes enable row level security;

-- Every row says which profile it belongs to (the first profile, #8YRJ090Q2, owned all rows before this).
alter table public.readings add column tag text not null;
create index readings_tag_ts_idx on public.readings (tag, ts);
create index readings_tag_id_idx on public.readings (tag, id);
alter table public.battles add column tag text not null;
alter table public.battles drop constraint battles_pkey;
alter table public.battles add primary key (tag, t);          -- two tracked players can be in the same battle
alter table public.goals add column tag text not null;
create index goals_tag_idx on public.goals (tag);
alter table public.push_subs add column tag text not null;
alter table public.push_subs drop constraint push_subs_pkey;
alter table public.push_subs add primary key (endpoint, tag);  -- a phone can have alerts for several profiles
-- Sessions belong to members; the club column says which club's activity they were read for.
alter table public.sessions add column club text;
create index sessions_club_end_idx on public.sessions (club, ended_at);
create index sessions_club_upd_idx on public.sessions (club, updated_at);
-- Server state in settings is kept per profile ('brawlers_full:TAG', 'club_full:TAG', 'notify_state:TAG')
-- and activity timing per club ('activity_at:CLUBTAG').

-- Each profile has its own minute in every 15, so they don't all hit the game's API at once.
-- Profiles nobody has opened for 30 days pause (opening one wakes it up).
select cron.schedule(
  'brawl-refresh',
  '* * * * *',
  $$
  update public.profiles set active = false where active and not keep and last_open_at < now() - interval '30 days';
  select net.http_post(
    url := 'https://iuukdskmzjglpvtlwldw.supabase.co/functions/v1/brawl',
    body := jsonb_build_object('action', 'refresh', 'src', 'auto', 'tag', tag),
    headers := '{"Content-Type":"application/json"}'::jsonb,
    timeout_milliseconds := 60000)
  from public.profiles
  where active and mod(hashtext(tag)::bigint + 2147483648, 15) = mod(extract(minute from now())::int, 15);
  $$
);
