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

-- ---------- Goals and alerts private to each phone; abuse limits (Oct 2026 audit) ----------
-- Each phone makes a random secret; only its hash is stored. Phones linked with a one-time code share an owner.
create table public.device_keys (
  key_hash text primary key,
  owner uuid not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index device_keys_owner_idx on public.device_keys (owner);
alter table public.device_keys enable row level security;
create table public.device_links (            -- one-time 6-digit codes (hashed), 10 minutes, single use
  code_hash text primary key,
  owner uuid not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index device_links_owner_idx on public.device_links (owner);
alter table public.device_links enable row level security;
alter table public.goals add column owner uuid;     -- null = made with an old per-player code, not yet handed in
create index goals_owner_tag_idx on public.goals (owner, tag);
alter table public.push_subs add column owner uuid;  -- goal alerts only go to the goal owner's phones
alter policy "Anyone can read goals" on public.goals using (false);  -- goals are private now; the function serves each phone its own
alter policy "Anyone can read goals" on public.goals rename to "Goals are private (served by the function)";

-- Call counters for the function's abuse limits (cleared after two days by the function itself).
create table public.rate_hits (
  key text not null,
  bucket bigint not null,
  n integer not null default 0,
  at timestamptz not null default now(),
  primary key (key, bucket)
);
create index rate_hits_at_idx on public.rate_hits (at);
alter table public.rate_hits enable row level security;
create or replace function public.rate_hit(p_key text, p_window integer, p_max integer)
returns boolean language plpgsql security definer set search_path = public as $$
declare b bigint := floor(extract(epoch from now()) / greatest(p_window, 1)); c integer;
begin
  insert into public.rate_hits as r (key, bucket, n) values (p_key, b, 1)
  on conflict (key, bucket) do update set n = r.n + 1
  returning r.n into c;
  return c <= p_max;
end $$;
revoke execute on function public.rate_hit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.rate_hit(text, integer, integer) to service_role;

-- The public key only ever reads (and RLS decides what); the function writes with its own key.
revoke insert, update, delete, truncate, references, trigger on all tables in schema public from anon, authenticated;

-- Which phone (device owner) started tracking which player. Each owner can hold 2 active players; the app holds 50.
create table if not exists public.profile_adders (
  owner uuid not null,
  tag text not null references public.profiles(tag) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (owner, tag)
);
create index if not exists profile_adders_tag_idx on public.profile_adders (tag);
alter table public.profile_adders enable row level security;
revoke all on public.profile_adders from anon, authenticated;

-- Explore (looking at any player or club without tracking), safe slot claims and usage counts.
-- Short-lived copies of public game data that Explore has fetched, shared by everyone. Only the server function
-- reads or writes it; entries older than a day are deleted every hour.
create table if not exists public.explore_cache (
  key text primary key,
  body jsonb not null,
  fetched_at timestamptz not null default now()
);
create index if not exists explore_cache_fetched_idx on public.explore_cache (fetched_at);
alter table public.explore_cache enable row level security;
revoke all on public.explore_cache from anon, authenticated;

-- Hourly counts of what the server does (lookups, cache hits, game API calls, limits hit). No identifiers.
create table if not exists public.usage_counters (
  key text not null,
  hour timestamptz not null,
  n integer not null default 0,
  primary key (key, hour)
);
alter table public.usage_counters enable row level security;
revoke all on public.usage_counters from anon, authenticated;

create or replace function public.count_usage(p_keys text[])
returns void language sql security definer set search_path = public as $$
  insert into public.usage_counters as u (key, hour, n)
  select k, date_trunc('hour', now()), count(*) from unnest(p_keys) k group by k
  on conflict (key, hour) do update set n = u.n + excluded.n;
$$;
revoke execute on function public.count_usage(text[]) from public, anon, authenticated;
grant execute on function public.count_usage(text[]) to service_role;

-- Takes a tracking spot in one locked step, so two requests at the same moment can't both take the last spot.
-- With an owner: starts the profile (inserting p_row if it's new, or waking it if paused) when the app has fewer
-- than p_max active profiles and the owner holds fewer than p_per, and records the owner as holding it.
-- Without an owner: only wakes a paused profile, when the app has room.
create or replace function public.claim_slot(p_owner uuid, p_tag text, p_row jsonb, p_max integer, p_per integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  cur public.profiles%rowtype;
  n_active integer;
  held text[];
begin
  perform pg_advisory_xact_lock(hashtext('brawl:claim_slot'));
  select * into cur from public.profiles where tag = p_tag;
  if cur.tag is not null and cur.active then
    return jsonb_build_object('status', 'exists');
  end if;
  select count(*) into n_active from public.profiles where active;
  if n_active >= p_max then
    return jsonb_build_object('status', 'full');
  end if;
  if p_owner is not null then
    select coalesce(array_agg(a.tag order by a.created_at), '{}') into held
      from public.profile_adders a join public.profiles p on p.tag = a.tag
      where a.owner = p_owner and p.active;
    if coalesce(array_length(held, 1), 0) >= p_per then
      return jsonb_build_object('status', 'phone_full', 'held', to_jsonb(held));
    end if;
  end if;
  if cur.tag is not null then
    update public.profiles set active = true, last_open_at = now() where tag = p_tag;
  elsif p_row is not null then
    insert into public.profiles (tag, club, name, icon, trophies, club_name, club_badge, follow)
    values (p_tag, p_row->>'club', p_row->>'name', (p_row->>'icon')::bigint, (p_row->>'trophies')::integer,
            p_row->>'club_name', (p_row->>'club_badge')::bigint, coalesce((p_row->>'follow')::boolean, true));
  else
    return jsonb_build_object('status', 'missing');
  end if;
  if p_owner is not null then
    insert into public.profile_adders (owner, tag) values (p_owner, p_tag) on conflict do nothing;
  end if;
  return jsonb_build_object('status', 'ok');
end $$;
revoke execute on function public.claim_slot(uuid, text, jsonb, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_slot(uuid, text, jsonb, integer, integer) to service_role;
