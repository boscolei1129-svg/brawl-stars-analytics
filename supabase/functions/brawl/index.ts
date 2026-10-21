// Brawl Stars Analytics server function. Every profile is a player tag (plus the club it follows);
// requests name it with `tag` (no #). Requests without one mean the original profile, LEGACY.
//   POST {action:"profile_lookup", tag, club?}     check a player (and club) before adding: name, icon, trophies
//   POST {action:"profile_add", tag, device, club?, from?}  start tracking a new profile (game stats are public); each device can start PER_DEVICE
//   POST {action:"profile_release", tag, device}   this device no longer holds the profile it started (it pauses when nobody holds it)
//   POST {action:"refresh", tag, src?:"auto"|"live"}  fetch fresh stats, save a reading and new battles
// Goals and alerts are private to a device. Each device sends `device`, a random secret it made itself; devices
// linked with a one-time code share one owner. Nobody else can see or change them.
//   POST {action:"goals_list", tag, device} / {action:"goal_add", tag, device, kind, target, brawler?} / {action:"goal_delete", tag, device, id}
//   POST {action:"link_create", device}            a 6-digit code (10 minutes, single use) to link another device
//   POST {action:"link_redeem", device, code}      this device joins the device that made the code
//   POST {action:"claim_legacy", tag, device, code, endpoint?}  move goals made under the old per-player code to this device
//   POST {action:"check_code", tag, code}         old app versions only
//   POST {action:"push_key"}                       public key for turning on notifications
//   POST {action:"push_subscribe", tag, device, sub, prefs?} / {action:"push_prefs", tag, device, endpoint, prefs}
//   POST {action:"push_unsubscribe", tag, endpoint} / {action:"push_test", tag, endpoint}
//   POST {action:"recap"}                          daily summary for devices whose chosen time just passed (run by the schedule every 5 minutes)
//   POST {action:"recap_preview", tag}             the daily summary text, without sending it
// Explore: look at any player or club without tracking it (nothing is saved about the visitor or the player,
// answers are cached for everyone for a couple of minutes).
//   POST {action:"explore_player", tag}            public profile, brawlers and the battles the game still lists
//   POST {action:"explore_club", tag}              club details and members
import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const LEGACY = "8YRJ090Q2"; // the first profile; requests without a tag mean this one
const MAX_PROFILES = 50; // profiles tracked at once (each one's club is read every 15 minutes)
const PER_DEVICE = 2; // active profiles one device (and the devices linked to it) can have started
const THIN_AFTER_DAYS = 30; // older readings are folded into one per day
const KEEP_BATTLES_DAYS = 365; // battles and play sessions older than this are deleted
// Player and club tags only use these characters. People often type O for 0.
const TAG_RE = /^[0289PYLQGRJCUV]{3,14}$/;
const normTag = (t: unknown) => String(t ?? "").toUpperCase().replace(/[\s#]/g, "").replace(/O/g, "0");
const MIN_GAP_MS = 60_000; // refreshes closer together than this reuse the last reading
const TZ = "Asia/Shanghai"; // time zone for a device that didn't send its own
const STEP_ME = 500, STEP_CLUB = 5000; // milestone sizes for notifications
const GAP_MS = 20 * 60_000; // battles closer together than this are one play session
const BATTLE_MS = 3 * 60_000; // a session starts about one battle before its first battle ends
const ACTIVITY_EVERY_MS = 4 * 60_000; // read members' battle logs at most this often
const DEV_RE = /^[A-Za-z0-9_-]{43}$/; // a device secret: 32 random bytes, base64url
const LINK_MS = 10 * 60_000; // one-time link codes last this long
const MAX_GOALS = 25; // per player, per owner

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const strip = (t: unknown) => String(t ?? "").replace(/^#/, "");
// The "_" parameter gives every request a new URL; without it BrawlTime can return a copy that is hours old.
const feed = (proc: string, tag: string) =>
  `https://brawltime.ninja/api/${proc}?input=${encodeURIComponent(JSON.stringify({ json: tag }))}&_=${Date.now()}`;

async function getFeed(url: string) {
  const r = await fetch(url, {
    headers: { "User-Agent": "BrawlStarsAnalytics/1.0 (personal stats tracker)" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`BrawlTime answered ${r.status}`);
  const j = await r.json();
  const d = j?.result?.data?.json;
  if (!d || typeof d !== "object") throw new Error("BrawlTime returned no data");
  return d;
}

// BrawlTime sometimes times out (408) or hiccups; one retry with a fresh URL usually succeeds.
async function getFeedRetry(makeUrl: () => string) {
  try {
    return await getFeed(makeUrl());
  } catch (_e) {
    await new Promise((r) => setTimeout(r, 1500));
    return await getFeed(makeUrl());
  }
}

// Official Brawl Stars API, used when a key is saved in the BS_API_KEY secret. Supercell keys only work from
// fixed addresses, so requests go through RoyaleAPI's proxy (allow 45.79.218.79 on the key).
async function officialGet(path: string) {
  const key = Deno.env.get("BS_API_KEY");
  if (!key) return null;
  const r = await fetch(`https://bsproxy.royaleapi.dev/v1${path}`, {
    headers: { Authorization: `Bearer ${key.trim()}`, Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`Brawl Stars API answered ${r.status}`);
  return await r.json();
}

async function getOfficialClub(clubTag: string) {
  const d = await officialGet(`/clubs/${encodeURIComponent("#" + clubTag)}`);
  if (d === null) return null;
  if (!d || !Array.isArray(d.members)) throw new Error("Brawl Stars API returned no club");
  return d;
}

// Club member lists (Supercell's own included) can trail the game by up to about an hour, while each
// player's profile is live. With a key, read every member's profile and rebuild the total from those.
// If a profile can't be read this time, the member keeps the last live number saved (when there is one),
// so the club total doesn't dip back to the older club-list figure.
async function liveMembers(club: any, prev: any): Promise<Set<string>> {
  const done = new Set<string>();
  if (!Deno.env.get("BS_API_KEY")) return done;
  const prevTr = new Map((prev?.members ?? []).map((m: any[]) => [m[0], m[3]]));
  const queue = club.members.slice();
  const read = (tag: string) => officialGet(`/players/${encodeURIComponent("#" + tag)}`);
  const worker = async () => {
    for (let m = queue.shift(); m; m = queue.shift()) {
      let p: any = null;
      try { p = await read(m[0]); } catch (_e) {
        await new Promise((r) => setTimeout(r, 400));
        try { p = await read(m[0]); } catch (_e2) { p = null; }
      }
      if (p && typeof p.trophies === "number") { m[3] = p.trophies; if (p.icon?.id) m[4] = p.icon.id; done.add(m[0]); }
      else if (prevTr.has(m[0]) && prev?.src === "official") m[3] = prevTr.get(m[0]);
    }
  };
  await Promise.all(Array.from({ length: 5 }, worker));
  if (done.size) club.trophies = club.members.reduce((sum: number, m: any[]) => sum + (Number(m[3]) || 0), 0);
  return done;
}

async function getClub(clubTag: string): Promise<{ data: any; src: string; officialError: string | null }> {
  let officialError: string | null = null;
  try {
    const d = await getOfficialClub(clubTag);
    if (d) return { data: d, src: "official", officialError };
  } catch (e) {
    officialError = String((e as Error)?.message ?? e);
  }
  return { data: await getFeedRetry(() => feed("club.byTag", clubTag)), src: "brawltime", officialError };
}

function compactPlayer(d: any, me: string) {
  const player = {
    name: d.name, tag: strip(d.tag), trophies: d.trophies, highest: d.highestTrophies,
    v3: d["3vs3Victories"], solo: d.soloVictories, duo: d.duoVictories, exp: d.expLevel, prestige: d.totalPrestigeLevel,
    rankName: d.rankedRankName, elo: d.rankedElo, seasonBestElo: d.highestSeasonRankedElo, bestElo: d.highestAllTimeRankedElo,
    bestRankName: d.highestAllTimeRankedRankName, club: d.club?.name ?? null, clubTag: strip(d.club?.tag),
    icon: d.icon?.id ?? null, rank: d.rankedRank ?? null, bestRank: d.highestAllTimeRankedRank ?? null,
  };
  const brawlers: Record<string, unknown[]> = {};
  for (const [k, v] of Object.entries<any>(d.brawlers ?? {})) {
    brawlers[k] = [v.trophies, v.highestTrophies, v.power, v.name, v.prestigeLevel ?? 0, v.maxWinStreak ?? 0, v.currentWinStreak ?? 0, v.id ?? null];
  }
  const battles = (d.battles ?? []).map((x: any) => {
    let mine: any = null;
    for (const team of x.teams ?? []) for (const pl of team) if (strip(pl.tag) === me) mine = pl;
    return {
      t: new Date(x.timestamp).toISOString(), mode: x.event?.mode ?? null, map: x.event?.map ?? null,
      result: x.result ?? null, win: typeof x.victory === "boolean" ? x.victory : null,
      tc: x.trophyChange ?? null, brawler: mine?.brawler ?? null, ranked: !!x.ranked, event_id: x.event?.id ?? null,
    };
  }).filter((b: any) => b.t && !b.t.startsWith("Invalid"));
  return { player, brawlers, battles };
}

function compactClub(c: any, src: string) {
  const members = (c.members ?? []).map((m: any) => [strip(m.tag), m.name, m.role, m.trophies, m.icon?.id ?? null]);
  return {
    name: c.name, tag: strip(c.tag), trophies: c.trophies, req: c.requiredTrophies, type: c.type, desc: c.description,
    members, src,
  };
}

// Club lists lag; your own profile doesn't. Put your live trophies into your row and the total.
function patchMyRow(club: any, myTrophies: number, me: string) {
  const row = club.members.find((m: any[]) => m[0] === me);
  if (!row || typeof myTrophies !== "number" || row[3] === myTrophies) return false;
  club.trophies += myTrophies - row[3];
  row[3] = myTrophies;
  return true;
}

// Key-order-independent JSON, so a list read back from the database (which reorders keys) compares equal.
function stable(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v as object).sort().map((k) => JSON.stringify(k) + ":" + stable((v as any)[k])).join(",") + "}";
  }
  return JSON.stringify(v ?? null);
}

const ms = (v: unknown) => (v ? new Date(String(v)).getTime() : 0);

// Club lists are saved in full (club column) when the members or club details change; otherwise only the
// members whose trophies moved go in club_upd ({d:1, trophies, upd:[[tag, trophies]]}). The full current
// list lives in settings.
async function clubFull(tag: string): Promise<any> {
  const saved = await getSetting("club_full:" + tag);
  if (saved) return JSON.parse(saved);
  const { data, error } = await sb.from("readings").select("club, club_upd").eq("tag", tag).or("club.not.is.null,club_upd.not.is.null")
    .order("ts", { ascending: true }).order("id", { ascending: true });
  if (error) throw error;
  let full: any = null;
  for (const r of data ?? []) full = applyClub(full, r.club ?? r.club_upd);
  return full;
}
function applyClub(base: any, c: any) {
  if (!c?.d) return c;
  if (!base) return null;
  const upd = new Map((c.upd ?? []).map((u: any[]) => [u[0], u[1]]));
  return { ...base, trophies: c.trophies, members: base.members.map((m: any[]) => (upd.has(m[0]) ? [m[0], m[1], m[2], upd.get(m[0]), m[4] ?? null] : m)) };
}
function clubChange(full: any, club: any) {
  const same = (a: any, b: any) => stable(a) === stable(b);
  const details = (c: any) => [c.name, c.tag, c.req, c.type, c.desc, c.src, c.members.map((m: any[]) => [m[0], m[1], m[2], m[4] ?? null]).sort()];
  if (!full || !same(details(full), details(club))) return club;
  const old = new Map(full.members.map((m: any[]) => [m[0], m[3]]));
  const upd = club.members.filter((m: any[]) => old.get(m[0]) !== m[3]).map((m: any[]) => [m[0], m[3]]);
  if (!upd.length && full.trophies === club.trophies) return null;
  return { d: 1, trophies: club.trophies, upd };
}

async function getSetting(key: string) {
  const { data, error } = await sb.from("settings").select("value").eq("key", key).maybeSingle();
  if (error) throw error;
  return data?.value ?? null;
}

// Brawler lists are saved as changes only (just the brawlers whose numbers moved); the full current
// list is kept in settings. Without it, adding the saved changes up in order gives the same list.
async function brawlersFull(tag: string): Promise<Record<string, unknown>> {
  const saved = await getSetting("brawlers_full:" + tag);
  if (saved) return JSON.parse(saved);
  const { data, error } = await sb.from("readings").select("brawlers").eq("tag", tag).not("brawlers", "is", null)
    .order("ts", { ascending: true }).order("id", { ascending: true });
  if (error) throw error;
  const full: Record<string, unknown> = {};
  for (const r of data ?? []) Object.assign(full, r.brawlers);
  return full;
}

// follow: the profile follows whatever club the player is in (set when it was added with the player's own club).
type Profile = { tag: string; club: string | null; name: string | null; club_name: string | null; active?: boolean; follow?: boolean };
async function getProfile(tag: string): Promise<Profile | null> {
  const { data, error } = await sb.from("profiles").select("*").eq("tag", tag).maybeSingle();
  if (error) throw error;
  return data;
}

async function refresh(src: string, p: Profile) {
  const me = p.tag;
  // Opening a profile keeps it on the schedule (and wakes it up if it had paused).
  if (src === "live") {
    await sb.from("profiles").update({ last_open_at: new Date().toISOString() }).eq("tag", me);
    if (p.active === false) await claimSlot(null, me, null); // wakes it while the app has room
  }
  const { data: lastRows, error: lastErr } = await sb.from("readings")
    .select("id, ts, checked, nb, trophies, club_trophies, player").eq("tag", me)
    .order("ts", { ascending: false }).order("id", { ascending: false }).limit(1);
  if (lastErr) throw lastErr;
  const last = lastRows?.[0] ?? null;
  const lastSeen = last ? Math.max(ms(last.ts), ms(last.checked)) : 0;
  if (last && Date.now() - lastSeen < MIN_GAP_MS) {
    return { ok: true, skipped: true, ts: new Date(lastSeen).toISOString() };
  }
  const [pr, cr] = await Promise.allSettled([
    getFeedRetry(() => feed("player.byTag", me)),
    p.club ? getClub(p.club) : Promise.resolve(null),
  ]);
  // A profile without a club only has player data.
  const clubOk = cr.status === "fulfilled" && !!cr.value;
  if (pr.status === "rejected" && !clubOk) throw new Error(String(pr.reason?.message ?? (cr as any).reason?.message ?? pr.reason));

  const now = new Date().toISOString();
  const row: Record<string, unknown> = { tag: me, src, ts: now };
  let saved = 0, stale = false, newFull: Record<string, unknown> | null = null, fullNow: Record<string, any> | null = null;
  let feedClub: { tag: string; name: string | null } | null = null;
  if (pr.status === "fulfilled") {
    const { player, brawlers, battles } = compactPlayer(pr.value, me);
    feedClub = player.clubTag ? { tag: player.clubTag, name: player.club } : null;
    if (battles.length) {
      // Re-saving known battles is harmless (same data) and fills in details added later, like the map's id.
      const { error } = await sb.from("battles").upsert(battles.map((b: any) => ({ ...b, tag: me })), { onConflict: "tag,t" });
      if (error) throw error;
      saved = battles.length;
    }
    const nb = battles.length ? battles.reduce((m: string, b: any) => (b.t > m ? b.t : m), battles[0].t) : null;
    // A delayed feed (older newest battle than what's saved) must not overwrite newer player data.
    const { data: maxRow } = await sb.from("readings").select("nb").eq("tag", me).not("nb", "is", null).order("nb", { ascending: false }).limit(1);
    stale = nb != null && ms(nb) < ms(maxRow?.[0]?.nb);
    if (!stale) {
      row.nb = nb;
      row.trophies = player.trophies;
      row.player = player;
      const full = await brawlersFull(me);
      const delta: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(brawlers)) if (stable(full[k]) !== stable(v)) delta[k] = v;
      if (Object.keys(delta).length) { row.brawlers = delta; newFull = { ...full, ...delta }; }
      fullNow = (newFull ?? full) as Record<string, any>;
    }
  }
  let patched = false, live = 0, newClub: any = null, prevClub: any = null;
  if (clubOk) {
    const cv = (cr as PromiseFulfilledResult<any>).value;
    const club = compactClub(cv.data, cv.src);
    prevClub = await clubFull(me);
    const fresh = await liveMembers(club, prevClub);
    live = fresh.size;
    if (!fresh.has(me) && typeof row.trophies === "number") patched = patchMyRow(club, row.trophies as number, me);
    row.club_trophies = club.trophies;
    const change = clubChange(prevClub, club);
    if (change) { if (change.d) row.club_upd = change; else row.club = change; newClub = club; }
  }
  // The player moved to another club, or left theirs: a profile that follows them switches from the next check on.
  let switched = false;
  if (p.follow && pr.status === "fulfilled") {
    const gone = clubOk && !(newClub ?? prevClub)?.members?.some((m: any[]) => m[0] === me);
    const next = feedClub && feedClub.tag !== p.club ? feedClub : !feedClub && p.club && gone ? { tag: null, name: null } : undefined;
    if (next) { switched = true; await sb.from("profiles").update({ club: next.tag, club_name: next.name, club_badge: null }).eq("tag", me); }
  }
  let activity: unknown = null;
  if (clubOk && p.club) {
    try { activity = await trackActivity((newClub ?? prevClub)?.members?.map((m: any[]) => m[0]) ?? [], p.club); }
    catch (e) { activity = { error: String((e as Error)?.message ?? e) }; }
  }
  const result = {
    activity,
    ok: true, ts: now, trophies: (row.trophies as number) ?? null, club_trophies: (row.club_trophies as number) ?? null,
    battles_seen: saved, stored_brawlers: "brawlers" in row, stored_club: "club" in row ? "full" : "club_upd" in row ? "update" : false,
    club_source: clubOk ? (cr as any).value.src : null, club_live_members: live, club_patched: patched,
    official_error: clubOk ? (cr as any).value.officialError : null,
    player_error: pr.status === "rejected" ? String(pr.reason?.message ?? pr.reason) : null,
    club_error: cr.status === "rejected" ? String(cr.reason?.message ?? cr.reason) : null,
  };
  // Keep the profile's card (name, picture, trophies, club name) current for the home screen.
  const card: Record<string, unknown> = { last_refresh_at: now };
  if (pr.status === "fulfilled" && !stale) Object.assign(card, { name: (row.player as any)?.name ?? null, icon: (row.player as any)?.icon ?? null, trophies: row.trophies ?? null });
  // (BrawlTime's club data has no badge, so a missing one leaves the saved badge alone.)
  if (clubOk && !switched) Object.assign(card, { club_name: (newClub ?? prevClub)?.name ?? null, club_badge: (cr as any).value.data?.badgeId ?? undefined });
  await sb.from("profiles").update(card).eq("tag", me);
  // Nothing moved since the last reading: mark that reading as confirmed now instead of adding a copy.
  const unchanged = !!last && pr.status === "fulfilled" && (clubOk || !p.club) && !stale &&
    !("brawlers" in row) && !newClub && row.trophies === last.trophies && (row.club_trophies ?? null) === (last.club_trophies ?? null) &&
    ms(row.nb) === ms(last.nb) && stable(row.player) === stable(last.player);
  if (unchanged) {
    const { error } = await sb.from("readings").update({ checked: now }).eq("id", last!.id);
    if (error) throw error;
    return { ...result, unchanged: true };
  }
  const { error } = await sb.from("readings").insert(row);
  if (error) throw error;
  if (newFull) {
    const { error: setErr } = await sb.from("settings").upsert({ key: "brawlers_full:" + me, value: JSON.stringify(newFull) });
    if (setErr) throw setErr;
  }
  if (newClub) {
    const { error: setErr } = await sb.from("settings").upsert({ key: "club_full:" + me, value: JSON.stringify(newClub) });
    if (setErr) throw setErr;
  }
  let notified = 0;
  try {
    notified = await checkEvents(p, {
      trophies: typeof row.trophies === "number" ? row.trophies as number : null,
      club: typeof row.club_trophies === "number" ? row.club_trophies as number : null,
      elo: (row.player as any)?.elo ?? null, brawlers: fullNow, prevClub, newClub,
    });
  } catch (e) {
    console.error("notifications failed", String((e as Error)?.message ?? e));
  }
  return { ...result, notified };
}

// ---------- member activity ----------
// Official battle log times look like 20261020T031519.000Z.
function battleTime(s: unknown) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/.exec(String(s ?? ""));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
}
// Adds new battles from members' battle logs to their play sessions. A battle within GAP_MS of the
// member's latest session extends it; otherwise it starts a new one.
function mergeBattles(prev: any | null, battles: { t: number; tc: number; mode: string | null }[]) {
  const seen = prev ? ms(prev.ended_at) : 0;
  const fresh = battles.filter((b) => b.t > seen).sort((a, b) => a.t - b.t);
  const out: any[] = [];
  let cur: any = prev ? { id: prev.id, tag: prev.tag, started_at: prev.started_at, ended_at: prev.ended_at, battles: prev.battles, tc: prev.tc, modes: { ...(prev.modes ?? {}) }, dirty: false } : null;
  for (const b of fresh) {
    if (cur && b.t - ms(cur.ended_at) <= GAP_MS) {
      cur.ended_at = new Date(b.t).toISOString();
      cur.battles += 1;
      cur.tc += b.tc || 0;
      if (b.mode) cur.modes[b.mode] = (cur.modes[b.mode] ?? 0) + 1;
      cur.dirty = true;
    } else {
      if (cur?.dirty) out.push(cur);
      cur = { tag: prev?.tag, started_at: new Date(Math.max(b.t - BATTLE_MS, seen)).toISOString(), ended_at: new Date(b.t).toISOString(),
        battles: 1, tc: b.tc || 0, modes: b.mode ? { [b.mode]: 1 } : {}, dirty: true };
    }
  }
  if (cur?.dirty) out.push(cur);
  return out.map(({ dirty: _d, ...r }) => r);
}
async function trackActivity(tags: string[], club: string) {
  if (!Deno.env.get("BS_API_KEY") || !tags.length) return null;
  // Two profiles in the same club share its activity, so the timer is per club.
  const at = Number(await getSetting("activity_at:" + club)) || 0;
  if (Date.now() - at < ACTIVITY_EVERY_MS) return { skipped: true };
  await setSetting("activity_at:" + club, String(Date.now()));
  const { data: latest, error } = await sb.from("latest_sessions").select("*").in("tag", tags);
  if (error) throw error;
  const last = new Map((latest ?? []).map((r: any) => [r.tag, r]));
  const queue = tags.slice(), inserts: any[] = [], updates: any[] = [];
  let read = 0, battles = 0;
  const getLog = (tag: string) => officialGet(`/players/${encodeURIComponent("#" + tag)}/battlelog`);
  const worker = async () => {
    for (let tag = queue.shift(); tag; tag = queue.shift()) {
      let log: any = null;
      try { log = await getLog(tag); } catch (_e) {
        await new Promise((r) => setTimeout(r, 400));
        try { log = await getLog(tag); } catch (_e2) { log = null; }
      }
      if (!log?.items) continue;
      read++;
      const items = log.items.map((x: any) => ({ t: battleTime(x.battleTime), tc: x.battle?.trophyChange ?? 0, mode: x.event?.mode ?? x.battle?.mode ?? null }))
        .filter((b: any) => !isNaN(b.t));
      const prev = last.get(tag) ?? { tag, ended_at: null };
      const rows = mergeBattles(last.has(tag) ? prev : null, items).map((r) => ({ ...r, tag }));
      battles += items.filter((b: any) => b.t > (last.has(tag) ? ms(prev.ended_at) : 0)).length;
      for (const r of rows) (r.id ? updates : inserts).push({ ...r, ...(r.id ? {} : { club }), updated_at: new Date().toISOString() });
    }
  };
  await Promise.all(Array.from({ length: 5 }, worker));
  if (inserts.length) { const { error: e } = await sb.from("sessions").insert(inserts); if (e) throw e; }
  for (const u of updates) {
    const { id, ...rest } = u;
    const { error: e } = await sb.from("sessions").update(rest).eq("id", id);
    if (e) throw e;
  }
  return { members: read, battles, new_sessions: inserts.length, extended: updates.length };
}

// ---------- notifications ----------
async function setSetting(key: string, value: unknown) {
  const { error } = await sb.from("settings").upsert({ key, value: typeof value === "string" ? value : JSON.stringify(value) });
  if (error) throw error;
}
// Keys that identify this server to Apple's and Google's push services. Made once and kept private.
async function vapid() {
  const saved = await getSetting("vapid");
  if (saved) return JSON.parse(saved);
  const k = webpush.generateVAPIDKeys();
  const v = { publicKey: k.publicKey, privateKey: k.privateKey, subject: "https://boscolei1129-svg.github.io/brawl-stars-analytics/" };
  await setSetting("vapid", v);
  return v;
}
async function pushTo(subs: any[], payload: unknown) {
  if (!subs.length) return 0;
  const v = await vapid();
  webpush.setVapidDetails(v.subject, v.publicKey, v.privateKey);
  let sent = 0;
  for (const s of subs) {
    // Revalidate stored subscriptions too: older versions accepted arbitrary URLs.
    const sub = cleanSub({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } });
    if (!sub) continue;
    try {
      // web-push uses a single HTTPS request and does not follow redirects.
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), { TTL: 6 * 3600, urgency: "normal", timeout: 10000 });
      sent++;
      await sb.from("push_subs").update({ last_sent_at: new Date().toISOString() }).eq("endpoint", s.endpoint);
    } catch (e: any) {
      // 404/410: the device turned notifications off or the app was removed, so forget it.
      if (e?.statusCode === 404 || e?.statusCode === 410) await sb.from("push_subs").delete().eq("endpoint", s.endpoint);
      else console.error("push failed", e?.statusCode ?? "", e?.body ?? String(e));
    }
  }
  return sent;
}
// Goal alerts only go to the devices that own the goal; everything else is about public stats.
async function notify(tag: string, kind: string, payload: unknown, owner?: string | null) {
  const { data, error } = await sb.from("push_subs").select("*").eq("tag", tag);
  if (error) throw error;
  return pushTo((data ?? []).filter((s: any) => s.prefs?.[kind] !== false && (owner === undefined || (s.owner ?? null) === (owner ?? null))), payload);
}
const fmtN = (n: number) => Math.round(n).toLocaleString("en-US");
const sgnN = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "") + fmtN(Math.abs(n));
const titleCase = (s: string) => String(s ?? "").toLowerCase().replace(/(^|[\s-])\S/g, (c) => c.toUpperCase());

// Goals reached, trophy milestones and roster changes since the last refresh. The first run only records
// where things stand, so nothing old is announced.
async function checkEvents(p: Profile, cur: { trophies: number | null; club: number | null; elo: number | null; brawlers: Record<string, any> | null; prevClub: any; newClub: any }) {
  const raw = await getSetting("notify_state:" + p.tag);
  const who = p.name ?? "#" + p.tag;
  const clubName = cur.newClub?.name ?? cur.prevClub?.name ?? p.club_name ?? "The club";
  const url = (hash: string) => "./?p=" + p.tag + "#" + hash;
  const first = !raw;
  const st = raw ? JSON.parse(raw) : {};
  // A different club than last time (the player moved): start its milestones from where it is, and don't
  // announce its whole member list as joins and leaves.
  const clubTag = cur.newClub?.tag ?? cur.prevClub?.tag ?? null;
  const moved = !!clubTag && st.clubTag !== undefined && st.clubTag !== clubTag;
  if (clubTag && st.clubTag !== clubTag) { st.clubTag = clubTag; st.club = null; }
  const out: { kind: string; payload: unknown; owner?: string | null }[] = [];
  if (cur.trophies != null) {
    const m = Math.floor(cur.trophies / STEP_ME) * STEP_ME;
    if (st.me == null) st.me = m;
    else if (m > st.me) {
      out.push({ kind: "milestones", payload: { title: "🏆 " + fmtN(m) + " trophies", body: who + " just passed " + fmtN(m) + ". Now at " + fmtN(cur.trophies) + ".", tag: "me-milestone-" + p.tag, url: url("me") } });
      st.me = m;
    }
  }
  if (cur.club != null) {
    const m = Math.floor(cur.club / STEP_CLUB) * STEP_CLUB;
    if (st.club == null) st.club = m;
    else if (m > st.club) {
      out.push({ kind: "milestones", payload: { title: "⭐ " + clubName + " passed " + fmtN(m), body: "The club is at " + fmtN(cur.club) + " trophies.", tag: "club-milestone-" + p.tag, url: url("club") } });
      st.club = m;
    }
  }
  const { data: goals } = await sb.from("goals").select("*").eq("tag", p.tag);
  st.goals = Array.isArray(st.goals) ? st.goals : [];
  for (const g of goals ?? []) {
    if (st.goals.includes(g.id)) continue;
    const b = g.kind === "brawler" ? cur.brawlers?.[g.brawler] : null;
    const v = g.kind === "player" ? cur.trophies : g.kind === "club" ? cur.club : g.kind === "elo" ? cur.elo : b ? b[0] : null;
    if (v == null || v < g.target) continue;
    st.goals.push(g.id);
    if (first || (g.start != null && g.start >= g.target)) continue; // already there when it was set
    const name = g.kind === "player" ? fmtN(g.target) + " trophies" : g.kind === "club" ? "Club at " + fmtN(g.target)
      : g.kind === "elo" ? fmtN(g.target) + " Elo" : titleCase(b?.[3] ?? g.brawler) + " at " + fmtN(g.target);
    out.push({ kind: "goals", owner: g.owner ?? null, payload: { title: "🎯 Goal reached", body: who + ": " + name + ". Now at " + fmtN(v) + ".", tag: "goal-" + g.id, url: url("goals") } });
  }
  st.goals = st.goals.filter((id: string) => (goals ?? []).some((g: any) => g.id === id));
  if (!first && !moved && cur.prevClub?.members && cur.newClub?.members && cur.prevClub.tag === cur.newClub.tag) {
    const before = new Map(cur.prevClub.members.map((m: any[]) => [m[0], m[1]]));
    const after = new Map(cur.newClub.members.map((m: any[]) => [m[0], m[1]]));
    const joined = [...after].filter(([t]) => !before.has(t)).map(([, n]) => n);
    const left = [...before].filter(([t]) => !after.has(t)).map(([, n]) => n);
    const list = (a: string[]) => (a.length <= 2 ? a.join(" and ") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]);
    if (joined.length || left.length) {
      const parts = [joined.length ? list(joined) + " joined" : "", left.length ? list(left) + " left" : ""].filter(Boolean);
      out.push({ kind: "roster", payload: { title: "👋 " + clubName + " members", body: parts.join(". ") + ". The club has " + after.size + "/30.", tag: "roster-" + p.tag, url: url("club") } });
    }
  }
  await setSetting("notify_state:" + p.tag, st);
  let sent = 0;
  for (const o of out) sent += await notify(p.tag, o.kind, o.payload, o.kind === "goals" ? o.owner ?? null : undefined);
  return sent;
}

// ---------- daily recap ----------
// Each device picks its own time and sends its own time zone. The schedule calls recap() every 5 minutes;
// a device is due when its time passed within the last 30 minutes and it hasn't had that day's recap.
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
function zoneOk(tz: unknown) {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}
function localParts(t: number, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, min: (+p.hour % 24) * 60 + +p.minute };
}
const RECAP_WINDOW_MIN = 30;
// The local date whose recap this device should get now, or null.
function recapDue(sub: any, now: number): string | null {
  if (sub.prefs?.recap === false) return null;
  const at = HHMM.test(String(sub.prefs?.recap_at ?? "")) ? String(sub.prefs.recap_at) : "22:00";
  const tz = zoneOk(sub.prefs?.tz) ? sub.prefs.tz : TZ;
  const want = +at.slice(0, 2) * 60 + +at.slice(3);
  const t = localParts(now, tz);
  if (t.min >= want) return t.min - want <= RECAP_WINDOW_MIN && sub.last_recap !== t.date ? t.date : null;
  // Just after midnight, a recap set for late last night may still be owed.
  const y = localParts(now - (t.min + 1) * 60_000, tz).date;
  return t.min + 1440 - want <= RECAP_WINDOW_MIN && sub.last_recap !== y ? y : null;
}

// Reads every row of a query, 1,000 at a time (the database hands out at most that many per request).
async function readAll(make: () => any) {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await make().range(from, from + 999);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}

// Trophies the club's members won or lost since `from`, counted only while they were in the club:
// members joining or leaving don't count, and neither do you. Walks the saved club lists in order.
async function clubGrowth(tag: string, from: number) {
  const fromIso = new Date(from).toISOString();
  const { data: base, error } = await sb.from("readings").select("ts, club").eq("tag", tag).not("club", "is", null)
    .lte("ts", fromIso).order("ts", { ascending: false }).order("id", { ascending: false }).limit(1);
  if (error) throw error;
  const rows = await readAll(() => {
    let q = sb.from("readings").select("ts, club, club_upd").eq("tag", tag).or("club.not.is.null,club_upd.not.is.null");
    if (base?.length) q = q.gt("ts", base[0].ts);
    return q.order("ts", { ascending: true }).order("id", { ascending: true });
  });
  let state: any = base?.[0]?.club ?? null;
  const per = new Map<string, { name: string; gain: number }>();
  let total = 0;
  for (const r of rows) {
    const next = applyClub(state, r.club ?? r.club_upd);
    if (!next?.members) continue;
    if (state?.members && ms(r.ts) > from) {
      const before = new Map(state.members.map((m: any[]) => [m[0], m[3]]));
      for (const m of next.members) {
        const was = before.get(m[0]);
        if (m[0] === tag || typeof was !== "number" || typeof m[3] !== "number" || m[3] === was) continue;
        total += m[3] - was;
        const e = per.get(m[0]) ?? { name: m[1], gain: 0 };
        e.gain += m[3] - was; e.name = m[1];
        per.set(m[0], e);
      }
    }
    state = next;
  }
  const top = [...per.values()].sort((a, b) => b.gain - a.gain)[0];
  return { total, top: top && top.gain > 0 ? top : null };
}

// What the recap says: the last 24 hours of your battles, and what other members added to the club.
async function recapData(tag: string, now: number) {
  const since = now - 24 * 3600_000;
  const { data: bs, error } = await sb.from("battles").select("win, tc").eq("tag", tag).gte("t", new Date(since).toISOString());
  if (error) throw error;
  const n = bs?.length ?? 0, w = (bs ?? []).filter((b: any) => b.win === true).length, l = (bs ?? []).filter((b: any) => b.win === false).length;
  const net = (bs ?? []).reduce((a: number, b: any) => a + (b.tc ?? 0), 0);
  const { data: pr } = await sb.from("readings").select("trophies").eq("tag", tag).not("trophies", "is", null).order("ts", { ascending: false }).limit(1);
  return { n, w, l, net, me: pr?.[0]?.trophies ?? null, club: await clubGrowth(tag, since) };
}
function recapBody(d: Awaited<ReturnType<typeof recapData>>) {
  const you = d.n
    ? "You: " + d.n + (d.n === 1 ? " battle, " : " battles, ") + sgnN(d.net) + " trophies" + (d.w + d.l ? ", " + Math.round((d.w / (d.w + d.l)) * 100) + "% wins" : "") + "."
    : "You: no battles.";
  const club = d.club.total
    ? "Club: " + sgnN(d.club.total) + " from other members' battles" + (d.club.top ? ". Top: " + d.club.top.name + " " + sgnN(d.club.top.gain) : "") + "."
    : "Club: no change from other members.";
  return you + (d.me != null ? " Now " + fmtN(d.me) + "." : "") + "\n" + club;
}
async function recap() {
  const now = Date.now();
  const { data: subs, error } = await sb.from("push_subs").select("*");
  if (error) throw error;
  const due = (subs ?? []).map((s: any) => ({ s, day: recapDue(s, now) })).filter((x) => x.day);
  if (!due.length) return { ok: true, due: 0 };
  let sent = 0;
  const bodies: Record<string, string> = {};
  for (const tag of [...new Set(due.map((x) => x.s.tag as string))]) {
    const p = await getProfile(tag);
    if (!p) continue;
    // Freshen the stats first so the recap is current.
    try { await refresh("auto", p); } catch (e) { console.error("recap refresh failed", tag, String(e)); }
    const d = await recapData(tag, Date.now());
    const body = bodies[tag] = recapBody(d);
    for (const { s, day } of due.filter((x) => x.s.tag === tag)) {
      await sb.from("push_subs").update({ last_recap: day }).eq("endpoint", s.endpoint).eq("tag", tag);
      if (d.n || d.club.total) sent += await pushTo([s], { title: "📊 Daily recap · " + (p.name ?? "#" + tag), body, tag: "recap-" + tag, url: "./?p=" + tag + "#me" });
    }
  }
  return { ok: true, due: due.length, sent, bodies };
}

// When a device saves its settings, a recap time that has only just passed counts as done for today,
// so the next recap comes the next time that time comes round (what the app shows), not straight away.
const recapMark = (prefs: any, now: number) => recapDue({ prefs, last_recap: null }, now);

const PREF_KEYS = ["goals", "milestones", "roster", "recap"];
const cleanPrefs = (p: any) => ({
  ...Object.fromEntries(PREF_KEYS.map((k) => [k, p?.[k] !== false])),
  recap_at: HHMM.test(String(p?.recap_at ?? "")) ? String(p.recap_at) : "22:00",
  tz: zoneOk(p?.tz) ? String(p.tz) : TZ,
});
function cleanSub(sub: any) {
  const endpoint = String(sub?.endpoint ?? ""), p256dh = String(sub?.keys?.p256dh ?? ""), auth = String(sub?.keys?.auth ?? "");
  if (endpoint.length > 1000 || p256dh.length > 88 || auth.length > 24) return null;
  let url: URL;
  try { url = new URL(endpoint); } catch { return null; }
  // Only browser push services may receive server-signed requests. In particular,
  // reject arbitrary domains, IP literals, credentials and nonstandard ports.
  const host = url.hostname;
  const provider = host === "fcm.googleapis.com" || host === "updates.push.services.mozilla.com"
    || /^[a-z0-9-]+\.push\.apple\.com$/.test(host)
    || /^[a-z0-9-]+\.notify\.windows\.com$/.test(host);
  if (url.protocol !== "https:" || !provider || url.username || url.password || url.port || url.hash || url.pathname === "/") return null;
  const bytes = (s: string) => {
    if (!/^[A-Za-z0-9_-]+={0,2}$/.test(s)) return null;
    try { return atob(s.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "")); } catch { return null; }
  };
  const publicKey = bytes(p256dh), authKey = bytes(auth);
  if (!publicKey || publicKey.length !== 65 || publicKey.charCodeAt(0) !== 4 || !authKey || authKey.length !== 16) return null;
  // Pass the parsed URL onwards so the request library cannot interpret the
  // original string differently (for example, backslashes or whitespace).
  return { endpoint: url.href, p256dh, auth };
}

async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// ---------- abuse limits ----------
// The caller's address. Supabase's gateway (Cloudflare) sets cf-connecting-ip itself and rewrites
// X-Forwarded-For, so a caller can't fake either (checked on the live function, Oct 2026).
function ipOf(req: Request) {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const xff = (req.headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return xff[0] ?? req.headers.get("x-real-ip") ?? "unknown";
}
// Counters are keyed by a scrambled form of the address (salted with a server secret), never the address itself.
async function ipKey(req: Request) {
  return (await sha256("ip:" + Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") + ":" + ipOf(req))).slice(0, 24);
}
// True while `key` has been used at most `max` times in the current `windowS`-second window.
// If the counter itself fails: `closed` limits refuse (anything that calls the game's API, creates players or
// devices, or lets someone guess a code), the rest let the request through, since a broken counter
// shouldn't take goals or alerts down.
async function allow(key: string, windowS: number, max: number, closed = false) {
  const { data, error } = await sb.rpc("rate_hit", { p_key: key, p_window: windowS, p_max: max });
  if (error) { console.error("rate_hit", error.message); use("limit_error:" + (closed ? "closed" : "open")); return !closed; }
  if (data !== true) use("limited:" + key.split(":")[0]);
  return data === true;
}
class Limited extends Error { constructor() { super("slow_down"); } }
async function limit(key: string, windowS: number, max: number, closed = false) { if (!(await allow(key, windowS, max, closed))) throw new Limited(); }

// Hourly counts of what the server does (lookups, cache hits, game API calls, limits hit), with no identifiers.
// They show what Explore costs. Counted in memory and saved once per request.
const usage: string[] = [];
const use = (key: string) => { usage.push(key); };
async function flushUsage() {
  if (!usage.length) return;
  const keys = usage.splice(0);
  const { error } = await sb.rpc("count_usage", { p_keys: keys });
  if (error) console.error("count_usage", error.message);
}

// ---------- devices (who owns goals and alerts) ----------
// A device is known by the hash of its secret. The first write from a new device registers it.
async function ownerOf(device: unknown, ip: string, create: boolean): Promise<string | null> {
  if (typeof device !== "string" || !DEV_RE.test(device)) return null;
  const key_hash = await sha256("device:" + device);
  const { data, error } = await sb.from("device_keys").select("owner, last_seen_at").eq("key_hash", key_hash).maybeSingle();
  if (error) throw error;
  if (data) {
    if (Date.now() - ms(data.last_seen_at) > 86_400_000) await sb.from("device_keys").update({ last_seen_at: new Date().toISOString() }).eq("key_hash", key_hash);
    return data.owner;
  }
  if (!create) return null;
  await limit("newdev:" + ip, 3600, 30, true);
  const owner = crypto.randomUUID();
  const ins = await sb.from("device_keys").insert({ key_hash, owner });
  if (ins.error) {
    if (ins.error.code !== "23505") throw ins.error;
    const again = await sb.from("device_keys").select("owner").eq("key_hash", key_hash).single();
    return again.data?.owner ?? null;
  }
  return owner;
}
const deviceHash = (device: string) => sha256("device:" + device);
// Six digits, from the system's secure random source (rejection sampling keeps every code equally likely).
function sixDigits() {
  const a = new Uint32Array(1);
  for (;;) { crypto.getRandomValues(a); if (a[0] < 4_294_000_000) return String(a[0] % 1_000_000).padStart(6, "0"); }
}

// Old app versions: each player had one code, chosen by whoever added them. Only used to move old goals
// to a device now. Guesses are limited per player and per address.
async function codeOk(tag: string, code: unknown, ip: string) {
  if (typeof code !== "string" || !code.trim()) return false;
  if (!(await allow("code:" + tag, 3600, 10, true)) || !(await allow("codeip:" + ip, 3600, 20, true))) return false;
  const { data } = await sb.from("profile_codes").select("code_sha256").eq("tag", tag).maybeSingle();
  const ok = !!data && data.code_sha256 === (await sha256(code.trim().toUpperCase()));
  if (!ok) await new Promise((r) => setTimeout(r, 800)); // slow down guessing
  return ok;
}

async function currentValue(tag: string, kind: string, brawler?: string) {
  if (kind === "club") {
    const { data } = await sb.from("readings").select("club_trophies").eq("tag", tag).not("club_trophies", "is", null).order("ts", { ascending: false }).limit(1);
    return data?.[0]?.club_trophies ?? null;
  }
  const { data } = await sb.from("readings").select("player").eq("tag", tag).not("player", "is", null)
    .order("nb", { ascending: false, nullsFirst: false }).order("ts", { ascending: false }).limit(1);
  const p = data?.[0]?.player;
  if (kind === "player") return p?.trophies ?? null;
  if (kind === "elo") return p?.elo ?? null;
  if (kind === "brawler" && brawler) {
    const v = (await brawlersFull(tag))[brawler];
    return Array.isArray(v) ? v[0] : null;
  }
  return null;
}

// ---------- adding profiles ----------
// Checks a player (and the club to follow) with the game's API before anything is saved.
async function lookup(tag: string, clubArg: unknown) {
  let pl: any = null;
  try { pl = await officialGet(`/players/${encodeURIComponent("#" + tag)}`); }
  catch (e) { if (/ 404$/.test(String((e as Error)?.message))) throw new Error("player_not_found"); pl = null; }
  if (pl === null) {
    // No API key, or the API is down: BrawlTime knows the same players.
    try { pl = await getFeedRetry(() => feed("player.byTag", tag)); } catch (_e) { throw new Error("player_not_found"); }
  }
  if (!pl?.name) throw new Error("player_not_found");
  const own = pl.club?.tag ? { tag: strip(pl.club.tag), name: pl.club.name ?? null } : null;
  // club: left out = the player's own club; "" or null = no club; a tag = that club.
  const wanted = clubArg === undefined ? own?.tag ?? null : clubArg ? normTag(clubArg) : null;
  let club: any = null;
  if (wanted) {
    if (!TAG_RE.test(wanted)) throw new Error("bad_club");
    let c: any = null;
    try { c = await getOfficialClub(wanted); } catch (e) { if (/ 404$/.test(String((e as Error)?.message))) throw new Error("club_not_found"); }
    if (c === null) { try { c = await getFeedRetry(() => feed("club.byTag", wanted)); } catch (_e) { throw new Error("club_not_found"); } }
    if (!c?.name) throw new Error("club_not_found");
    club = { tag: wanted, name: c.name, badge: c.badgeId ?? null, trophies: c.trophies ?? null, members: Array.isArray(c.members) ? c.members.length : null, own: wanted === own?.tag };
  }
  return { player: { tag, name: pl.name, icon: pl.icon?.id ?? null, trophies: pl.trophies ?? null, club: own }, club };
}
// ---------- thinning old readings ----------
// Readings mostly hold changes (brawlers and club members that moved), which the app adds up in order. A day older
// than THIN_AFTER_DAYS is folded into its last reading: that reading gets the day's changes added together (or the
// club list in full, if it was saved in full that day) and the newest player stats, then the rest are deleted.
// Adding up the folded readings gives exactly the same end-of-day state, and a fold that stops halfway is harmless:
// applying the same changes twice changes nothing. Battles are separate, so trophy charts keep every battle.
const dayKey = (t: unknown) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(String(t)));
function foldClub(acc: any, c: any) {
  if (!c) return acc;
  if (!c.d) return structuredClone(c);
  if (!acc) return { d: 1, trophies: c.trophies, upd: (c.upd ?? []).map((u: any[]) => u.slice()) };
  if (!acc.d) return applyClub(acc, c);
  const m = new Map((acc.upd ?? []).map((u: any[]) => [u[0], u[1]]));
  for (const u of c.upd ?? []) m.set(u[0], u[1]);
  return { d: 1, trophies: c.trophies, upd: [...m].map(([k, v]) => [k, v]) };
}
// The changes to make to the day's last reading (rows in saved order).
function foldDay(rows: any[]) {
  let brawlers: Record<string, unknown> | null = null, club: any = null, best: any = null, clubTr: number | null = null;
  for (const r of rows) {
    if (r.brawlers) brawlers = { ...(brawlers ?? {}), ...r.brawlers };
    club = foldClub(club, r.club ?? r.club_upd);
    if (r.player && (!best || ms(r.nb) >= ms(best.nb))) best = r;
    if (r.club_trophies != null) clubTr = r.club_trophies;
  }
  const patch: Record<string, unknown> = {};
  if (brawlers) patch.brawlers = brawlers;
  if (club) { if (club.d) Object.assign(patch, { club_upd: club, club: null }); else Object.assign(patch, { club, club_upd: null }); }
  if (best) Object.assign(patch, { player: best.player, trophies: best.trophies, nb: best.nb });
  if (clubTr != null) patch.club_trophies = clubTr;
  return patch;
}
async function thinReadings(budget = 60) {
  const cutoff = new Date(Date.now() - THIN_AFTER_DAYS * 86_400_000).toISOString(), cutDay = dayKey(cutoff);
  const { data: profs, error } = await sb.from("profiles").select("tag");
  if (error) throw error;
  let days = 0, removed = 0;
  for (const { tag } of profs ?? []) {
    if (days >= budget) break;
    const mark = "thin_upto:" + tag, from = (await getSetting(mark)) ?? "1970-01-01T00:00:00Z";
    const LIM = 3000;
    const { data: rows, error: e1 } = await sb.from("readings").select("id, ts, nb, trophies, club_trophies, player, brawlers, club, club_upd")
      .eq("tag", tag).gt("ts", from).lt("ts", cutoff).order("ts", { ascending: true }).order("id", { ascending: true }).limit(LIM);
    if (e1) throw e1;
    const groups: any[][] = [];
    for (const r of rows ?? []) {
      const k = dayKey(r.ts);
      if (k >= cutDay) break; // the day the cutoff falls in waits until it's wholly past
      if (!groups.length || dayKey(groups[groups.length - 1][0].ts) !== k) groups.push([]);
      groups[groups.length - 1].push(r);
    }
    if ((rows?.length ?? 0) >= LIM && groups.length > 1) groups.pop(); // the last day may be cut short
    let upto: string | null = null;
    for (const [gi, g] of groups.entries()) {
      if (days >= budget) break;
      const keep = g[g.length - 1];
      // The player's very first reading also stays, so "All" ranges still start where tracking started.
      const first = gi === 0 && !(await getSetting(mark)) ? 1 : 0;
      if (g.length > 1 + first) {
        const { error: e2 } = await sb.from("readings").update(foldDay(g)).eq("id", keep.id);
        if (e2) throw e2;
        const ids = g.slice(first, -1).map((r) => r.id);
        for (let i = 0; i < ids.length; i += 300) {
          const { error: e3 } = await sb.from("readings").delete().in("id", ids.slice(i, i + 300));
          if (e3) throw e3;
        }
        removed += ids.length; days++;
      }
      upto = keep.ts;
    }
    if (upto) {
      const { error: e4 } = await sb.from("settings").upsert({ key: mark, value: upto }, { onConflict: "key" });
      if (e4) throw e4;
    }
  }
  return { days, removed };
}

// ---------- Explore: any player or club, without tracking ----------
// Nothing here creates profiles, devices or schedules. Answers are kept for everyone for a short time (in this
// server's memory and in a small shared table), so many people looking at the same player cost one call to the
// game's API. When the game's API can't be reached, a copy up to a day old is shown, labelled as such.
const EX_TTL = { player: 2 * 60_000, club: 5 * 60_000 };
const EX_STALE_MS = 24 * 3600_000;
const EX_NOT_FOUND_MS = 10 * 60_000; // a tag that doesn't exist isn't asked about again for this long
const EX_MISSES_PER_HOUR = 1000; // fresh fetches Explore may make in an hour, for everyone together (each is 1 or 2 API calls)
const exMem = new Map<string, { at: number; body: any }>();
const exFlight = new Map<string, Promise<any>>();
const exPut = (key: string, v: { at: number; body: any }) => { exMem.delete(key); exMem.set(key, v); if (exMem.size > 400) exMem.delete(exMem.keys().next().value!); };
const notFound = (m: string) => m === "player_not_found" || m === "club_not_found";
async function exCached(key: string, ttl: number, fetcher: () => Promise<any>): Promise<{ at: number; body: any; source: string }> {
  const now = Date.now();
  const nf = exMem.get("nf:" + key);
  if (nf && now - nf.at < EX_NOT_FOUND_MS) throw new Error(nf.body);
  const m = exMem.get(key);
  if (m && now - m.at < ttl) { use("explore:hit"); return { ...m, source: "cache" }; }
  if (exFlight.has(key)) { use("explore:joined"); return await exFlight.get(key)!; }
  const p = (async () => {
    const { data: row } = await sb.from("explore_cache").select("body, fetched_at").eq("key", key).maybeSingle();
    const shared = row ? { at: ms(row.fetched_at), body: row.body } : null;
    if (shared && now - shared.at < ttl) { exPut(key, shared); use("explore:hit"); return { ...shared, source: "cache" }; }
    const stale = [shared, m].filter(Boolean).sort((a, b) => b!.at - a!.at)[0] ?? null;
    const staleOk = stale && Date.now() - stale.at < EX_STALE_MS ? { ...stale, source: "stale" } : null;
    if (!(await allow("exmiss", 3600, EX_MISSES_PER_HOUR, true))) {
      use("explore:budget");
      if (staleOk) return staleOk;
      throw new Limited();
    }
    try {
      const v = { at: Date.now(), body: await fetcher() };
      use("explore:miss");
      exPut(key, v);
      const { error } = await sb.from("explore_cache").upsert({ key, body: v.body, fetched_at: new Date(v.at).toISOString() }, { onConflict: "key" });
      if (error) console.error("explore_cache", error.message);
      return { ...v, source: "live" };
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (notFound(msg)) { exPut("nf:" + key, { at: Date.now(), body: msg }); use("explore:not_found"); throw e; }
      use("explore:upstream_error");
      if (staleOk) return staleOk;
      throw new Error("upstream_unavailable");
    }
  })();
  exFlight.set(key, p);
  try { return await p; } finally { exFlight.delete(key); }
}
const is404 = (e: unknown) => / 404$/.test(String((e as Error)?.message ?? e));
// One battle from the official battle log, from the looked-up player's side. Other players' names and tags are
// left out on purpose.
function exBattle(me: string) {
  return (x: any) => {
    const b = x?.battle ?? {};
    let mine: any = null, team: number | null = null;
    if (Array.isArray(b.teams)) for (const t of b.teams) for (const p of t ?? []) if (strip(p?.tag) === me) { mine = p; team = t.length; }
    if (!mine && Array.isArray(b.players)) for (const p of b.players) if (strip(p?.tag) === me) mine = p;
    const br = mine?.brawler ?? (Array.isArray(mine?.brawlers) ? mine.brawlers[0] : null);
    const t = battleTime(x?.battleTime);
    if (isNaN(t)) return null;
    return {
      t, mode: x?.event?.mode ?? b.mode ?? null, map: x?.event?.map ?? null, type: b.type ?? null,
      result: b.result ?? null, rank: typeof b.rank === "number" ? b.rank : null, tc: typeof b.trophyChange === "number" ? b.trophyChange : null,
      dur: typeof b.duration === "number" ? b.duration : null, star: !!b.starPlayer && strip(b.starPlayer.tag) === me,
      team, players: Array.isArray(b.players) ? b.players.length : null,
      br: br ? { id: br.id ?? null, name: br.name ?? null, power: br.power ?? null, tr: br.trophies ?? null } : null,
    };
  };
}
const dedupeBattles = (list: any[]) => {
  const seen = new Set<string>(), out: any[] = [];
  for (const b of list) { const k = b.t + "|" + b.mode + "|" + b.map; if (!seen.has(k)) { seen.add(k); out.push(b); } }
  return out.sort((a, b) => b.t - a.t);
};
async function explorePlayerFetch(tag: string) {
  let pl: any = null, log: any = null;
  try {
    [pl, log] = await Promise.all([
      officialGet(`/players/${encodeURIComponent("#" + tag)}`),
      officialGet(`/players/${encodeURIComponent("#" + tag)}/battlelog`).catch(() => undefined),
    ]);
  } catch (e) {
    if (is404(e)) throw new Error("player_not_found");
    pl = null;
  }
  if (pl) {
    return {
      tag, name: pl.name, icon: pl.icon?.id ?? null, trophies: pl.trophies ?? null, highest: pl.highestTrophies ?? null, exp: pl.expLevel ?? null,
      v3: pl["3vs3Victories"] ?? null, solo: pl.soloVictories ?? null, duo: pl.duoVictories ?? null, prestige: pl.totalPrestigeLevel ?? null,
      club: pl.club?.tag ? { tag: strip(pl.club.tag), name: pl.club.name ?? null } : null,
      brawlers: (pl.brawlers ?? []).map((b: any) => ({ id: b.id ?? null, name: b.name, power: b.power ?? null, rank: b.rank ?? null, tr: b.trophies ?? null, hi: b.highestTrophies ?? null,
        g: b.gadgets?.length ?? 0, sp: b.starPowers?.length ?? 0, gear: b.gears?.length ?? 0, pr: b.prestigeLevel ?? null })),
      // undefined: the battle log couldn't be read this time; [] : the game lists no recent battles.
      battles: log === undefined ? null : dedupeBattles((log?.items ?? []).map(exBattle(tag)).filter(Boolean)),
      src: "official",
    };
  }
  // No API key, or the official API is down: BrawlTime knows the same public profiles.
  let d: any = null;
  try { d = await getFeedRetry(() => feed("player.byTag", tag)); } catch (e) { if (is404(e)) throw new Error("player_not_found"); throw e; }
  if (!d?.name) throw new Error("player_not_found");
  const cp = compactPlayer(d, tag);
  return {
    tag, name: d.name, icon: d.icon?.id ?? null, trophies: d.trophies ?? null, highest: d.highestTrophies ?? null, exp: d.expLevel ?? null,
    v3: d["3vs3Victories"] ?? null, solo: d.soloVictories ?? null, duo: d.duoVictories ?? null, prestige: d.totalPrestigeLevel ?? null,
    club: d.club?.tag ? { tag: strip(d.club.tag), name: d.club.name ?? null } : null,
    brawlers: Object.values<any>(d.brawlers ?? {}).map((b: any) => ({ id: b.id ?? null, name: b.name, power: b.power ?? null, rank: b.rank ?? null, tr: b.trophies ?? null, hi: b.highestTrophies ?? null,
      g: Array.isArray(b.gadgets) ? b.gadgets.length : 0, sp: Array.isArray(b.starPowers) ? b.starPowers.length : 0, gear: Array.isArray(b.gears) ? b.gears.length : 0, pr: b.prestigeLevel ?? null })),
    battles: dedupeBattles(cp.battles.map((x: any) => {
      const rank = /(\d+)/.exec(String(x.result ?? ""));
      return { t: ms(x.t), mode: x.mode, map: x.map, type: x.ranked ? "ranked" : null,
        result: x.win === true && !rank ? "victory" : x.win === false && !rank ? "defeat" : !rank && x.result === "draw" ? "draw" : null,
        rank: rank ? +rank[1] : null, tc: x.tc, dur: null, star: false, team: null, players: null, br: x.brawler ? { id: null, name: x.brawler, power: null, tr: null } : null };
    })),
    src: "brawltime",
  };
}
async function exploreClubFetch(tag: string) {
  let c: any = null, src = "official";
  try { c = await getOfficialClub(tag); } catch (e) { if (is404(e)) throw new Error("club_not_found"); c = null; }
  if (c === null) {
    src = "brawltime";
    try { c = await getFeedRetry(() => feed("club.byTag", tag)); } catch (e) { if (is404(e)) throw new Error("club_not_found"); throw e; }
  }
  if (!c?.name) throw new Error("club_not_found");
  return {
    tag, name: c.name, desc: c.description ?? null, type: c.type ?? null, badge: c.badgeId ?? null, req: c.requiredTrophies ?? null, trophies: c.trophies ?? null,
    members: (c.members ?? []).map((m: any) => [strip(m.tag), m.name, m.role ?? null, m.trophies ?? null, m.icon?.id ?? null]).sort((a: any[], b: any[]) => (b[3] ?? 0) - (a[3] ?? 0)),
    src,
  };
}

async function activeCount() {
  const { count, error } = await sb.from("profiles").select("tag", { count: "exact", head: true }).eq("active", true);
  if (error) throw error;
  return count ?? 0;
}
// The active profiles a device's owner started (they count towards PER_DEVICE).
async function heldBy(owner: string): Promise<string[]> {
  const { data, error } = await sb.from("profile_adders").select("tag").eq("owner", owner);
  if (error) throw error;
  const tags = (data ?? []).map((r: any) => r.tag);
  if (!tags.length) return [];
  const { data: act, error: e2 } = await sb.from("profiles").select("tag").in("tag", tags).eq("active", true);
  if (e2) throw e2;
  return (act ?? []).map((r: any) => r.tag);
}
// Takes a spot for a profile in one locked database step, so two requests at the same moment can't both squeeze
// into the last spot: starts it (inserting `row` if it's new) when the app and this owner have room, and records
// the owner as holding it. Without an owner it only wakes a paused profile when the app has room.
async function claimSlot(owner: string | null, tag: string, row: Record<string, unknown> | null) {
  const { data, error } = await sb.rpc("claim_slot", { p_owner: owner, p_tag: tag, p_row: row, p_max: MAX_PROFILES, p_per: PER_DEVICE });
  if (error) throw error;
  return data as { status: "ok" | "exists" | "full" | "phone_full"; held?: string[] };
}
const slotFail = (r: { status: string; held?: string[] }) =>
  r.status === "full" ? fail("full", 409) : r.status === "phone_full" ? json({ ok: false, error: "phone_full", held: r.held ?? [] }, 409) : null;
// A quick check before calling the game's API (claimSlot checks again, under the lock).
async function roomFor(owner: string) {
  if ((await activeCount()) >= MAX_PROFILES) return fail("full", 409);
  const held = await heldBy(owner);
  if (held.length >= PER_DEVICE) return json({ ok: false, error: "phone_full", held }, 409);
  return null;
}
async function hold(owner: string, tag: string) {
  const { error } = await sb.from("profile_adders").upsert({ owner, tag }, { onConflict: "owner,tag" });
  if (error) throw error;
}
const publicProfile = (p: any) => ({ tag: p.tag, club: p.club, name: p.name, icon: p.icon, trophies: p.trophies, club_name: p.club_name, club_badge: p.club_badge ?? null });
const fail = (error: string, status = 400) => json({ ok: false, error }, status);

Deno.serve(async (req) => {
  const started = performance.now();
  const stages: string[] = [];
  const measure: StageTimer = async (name, work) => {
    const start = performance.now();
    try { return await work(); }
    finally { stages.push(`${name};dur=${(performance.now() - start).toFixed(1)}`); }
  };
  const res = await handle(req, measure);
  // Counters contain no user identifiers and must not delay a cached answer.
  // waitUntil keeps the task alive on Supabase; other runtimes await it normally.
  const pending = flushUsage().catch((e) => console.error("usage", String(e)));
  const runtime = (globalThis as any).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(pending); else await pending;
  res.headers.set("Server-Timing", [...stages, `app;dur=${(performance.now() - started).toFixed(1)}`].join(", "));
  res.headers.set("Access-Control-Expose-Headers", "Server-Timing");
  return res;
});
type StageTimer = <T>(name: string, work: () => PromiseLike<T>) => Promise<T>;
async function handle(req: Request, measure: StageTimer): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "Use POST" }, 405);
  let body: any = {};
  try { body = await req.json(); } catch { /* empty body */ }
  const tag = body.tag == null || body.tag === "" ? LEGACY : normTag(body.tag);
  const ip = await ipKey(req);
  try {
    switch (body.action) {
      case "profile_lookup": {
        if (!TAG_RE.test(tag)) return fail("bad_tag");
        await limit("look:" + ip, 600, 40, true);
        const [found, existing] = await Promise.all([lookup(tag, body.club), getProfile(tag)]);
        return json({ ok: true, ...found, tracked: !!existing, profile: existing ? publicProfile(existing) : null });
      }
      case "profile_add": {
        if (!TAG_RE.test(tag)) return fail("bad_tag");
        // Which way people come to tracking (Explore or the home screen): counted per hour, no identifiers.
        const via = body.from === "explore" ? "explore" : "home";
        const existing = await getProfile(tag);
        if (existing) {
          // Already tracked (someone else added it): this device just saves it. A profile that was set to some
          // other club (or none) goes back to following the player's own club when anyone adds it that way, and
          // can't be pointed away from it again, so nobody can spoil a player's profile for everyone else.
          const patch: Record<string, unknown> = {};
          if (!existing.active) {
            // Paused: starting it up again takes a spot, like adding a new player.
            const owner = await ownerOf(body.device, ip, true);
            if (!owner) return fail("no_device", 401);
            const r = await claimSlot(owner, tag, null);
            const bad = slotFail(r);
            if (bad) return bad;
            Object.assign(patch, { active: true, last_open_at: new Date().toISOString() });
          }
          if (!existing.follow && body.club === undefined) patch.follow = true;
          if (Object.keys(patch).length) await sb.from("profiles").update(patch).eq("tag", tag);
          use("track:" + (existing.active ? "save" : "wake") + ":" + via);
          return json({ ok: true, exists: true, profile: publicProfile({ ...existing, ...patch }) });
        }
        const owner = await ownerOf(body.device, ip, true);
        if (!owner) return fail("no_device", 401);
        await limit("add:" + ip, 3600, 6, true);
        const full = await roomFor(owner);
        if (full) return full;
        const found = await lookup(tag, body.club);
        // Left to the player's own club (or none), the profile keeps following them if they move.
        const follow = body.club === undefined || !!found.club?.own || (!found.club && !found.player.club);
        const row = { tag, club: found.club?.tag ?? null, name: found.player.name, icon: found.player.icon, trophies: found.player.trophies,
          club_name: found.club?.name ?? null, club_badge: found.club?.badge ?? null, follow };
        const claim = await claimSlot(owner, tag, row);
        const bad = slotFail(claim);
        if (bad) return bad;
        if (claim.status === "exists") { use("track:save:" + via); return json({ ok: true, exists: true, profile: publicProfile((await getProfile(tag)) ?? row) }); }
        use("track:new:" + via);
        // First reading now, so the dashboard has something to show straight away.
        let first: unknown = null;
        try { first = await refresh("live", row); } catch (e) { first = { error: String((e as Error)?.message ?? e) }; }
        return json({ ok: true, created: true, profile: publicProfile((await getProfile(tag)) ?? row), first });
      }
      case "profile_release": {
        // Removed from a device's list. If that device started it and no other device did, it pauses (history kept).
        const owner = await ownerOf(body.device, ip, false);
        if (!owner || !TAG_RE.test(tag)) return json({ ok: true, released: false });
        await limit("rel:" + ip, 3600, 60);
        const { count, error } = await sb.from("profile_adders").delete({ count: "exact" }).eq("owner", owner).eq("tag", tag);
        if (error) throw error;
        if (!count) return json({ ok: true, released: false });
        const { count: others } = await sb.from("profile_adders").select("owner", { count: "exact", head: true }).eq("tag", tag);
        let paused = false;
        if (!others) {
          const { data } = await sb.from("profiles").update({ active: false }).eq("tag", tag).eq("active", true).eq("keep", false).select("tag");
          paused = !!data?.length;
        }
        return json({ ok: true, released: true, paused });
      }
      case "explore_player": {
        if (!body.tag || !TAG_RE.test(tag)) return fail("bad_tag");
        await measure("rate", () => limit("ex:" + ip, 600, 60, true));
        use("explore:player");
        const [r, prof] = await Promise.all([
          measure("lookup", () => exCached("p:" + tag, EX_TTL.player, () => explorePlayerFetch(tag))),
          measure("profile", () => getProfile(tag)),
        ]);
        return json({ ok: true, player: r.body, fetched_at: new Date(r.at).toISOString(), source: r.source, tracked: !!prof, active: prof?.active ?? null });
      }
      case "explore_club": {
        if (!body.tag || !TAG_RE.test(tag)) return fail("bad_tag");
        await measure("rate", () => limit("ex:" + ip, 600, 60, true));
        use("explore:club");
        const [r, { data: fol }] = await Promise.all([
          measure("lookup", () => exCached("c:" + tag, EX_TTL.club, () => exploreClubFetch(tag))),
          measure("profile", () => sb.from("profiles").select("tag").eq("club", tag).eq("active", true).limit(1)),
        ]);
        return json({ ok: true, club: r.body, fetched_at: new Date(r.at).toISOString(), source: r.source, tracked_via: fol?.[0]?.tag ?? null });
      }
      case "refresh": {
        const p = await getProfile(tag);
        if (!p) return fail("unknown_profile", 404);
        return json(await refresh(body.src === "live" ? "live" : "auto", p));
      }
      case "check_code":
        return json({ ok: await codeOk(tag, body.code, ip) });

      // ----- goals: private to the device (and the devices linked to it) -----
      case "goals_list": {
        const owner = await ownerOf(body.device, ip, false);
        if (!owner) return json({ ok: true, goals: [] });
        const { data, error } = await sb.from("goals").select("id, kind, target, brawler, start, created_at").eq("tag", tag).eq("owner", owner).order("created_at");
        if (error) throw error;
        return json({ ok: true, goals: data ?? [] });
      }
      case "goal_add": {
        const owner = await ownerOf(body.device, ip, true);
        if (!owner) return fail("no_device", 401);
        await limit("goal:" + owner, 3600, 60);
        const kind = String(body.kind);
        const target = Math.round(Number(body.target));
        if (!["player", "club", "brawler", "elo"].includes(kind) || !(target > 0) || target > 1e9) return fail("bad_goal");
        const brawler = kind === "brawler" ? String(body.brawler ?? "").slice(0, 40) : null;
        if (kind === "brawler" && !brawler) return fail("bad_goal");
        const { count } = await sb.from("goals").select("id", { count: "exact", head: true }).eq("tag", tag).eq("owner", owner);
        if ((count ?? 0) >= MAX_GOALS) return fail("too_many_goals", 409);
        const start = await currentValue(tag, kind, brawler ?? undefined);
        const { data, error } = await sb.from("goals").insert({ tag, kind, target, brawler, start, owner }).select("id, kind, target, brawler, start, created_at").single();
        if (error) throw error;
        return json({ ok: true, goal: data });
      }
      case "goal_delete": {
        const owner = await ownerOf(body.device, ip, false);
        if (!owner) return fail("no_device", 401);
        const { error } = await sb.from("goals").delete().eq("id", String(body.id)).eq("tag", tag).eq("owner", owner);
        if (error) throw error;
        return json({ ok: true });
      }
      case "link_create": {
        const owner = await ownerOf(body.device, ip, true);
        if (!owner) return fail("no_device", 401);
        await limit("linkc:" + owner, 3600, 10);
        const key_hash = await deviceHash(body.device);
        const expires_at = new Date(Date.now() + LINK_MS).toISOString();
        for (let i = 0; i < 5; i++) {
          const code = sixDigits();
          // Resolve ownership inside the transaction: it may change while this
          // request is in flight if another linked device merges their owner.
          const { data, error } = await sb.rpc("create_device_link", {
            p_code_hash: await sha256("link:" + code), p_key_hash: key_hash, p_expires_at: expires_at,
          });
          if (error) { if (error.code === "23505") continue; throw error; }
          if (data?.status === "no_device") return fail("no_device", 401);
          if (data?.status !== "ok") throw new Error("link_unavailable");
          return json({ ok: true, code, expires_at });
        }
        throw new Error("no_code");
      }
      case "link_redeem": {
        if (typeof body.device !== "string" || !DEV_RE.test(body.device)) return fail("no_device", 401);
        // Six digits are only safe because guesses are scarce: per address, and for everyone together.
        await limit("linkr:" + ip, 3600, 10, true);
        await limit("linkr:all", 3600, 300, true);
        const code = String(body.code ?? "").replace(/\D/g, "");
        if (code.length !== 6) return fail("bad_link");
        const code_hash = await sha256("link:" + code);
        const key_hash = await deviceHash(body.device);
        const { data, error } = await sb.rpc("redeem_device_link", { p_code_hash: code_hash, p_key_hash: key_hash });
        if (error) throw error; // fail closed; never fall back to a non-atomic merge
        if (data?.status === "bad_link") return fail("bad_link", 404);
        if (data?.status === "same_device") return fail("same_device");
        if (data?.status !== "ok") throw new Error("link_unavailable");
        return json({ ok: true, moved: data.moved ?? 0 });
      }
      case "claim_legacy": {
        // A phone that still remembers a player's old code takes over the goals made with it.
        if (!(await codeOk(tag, body.code, ip))) return fail("wrong_code", 403);
        const owner = await ownerOf(body.device, ip, true);
        if (!owner) return fail("no_device", 401);
        const g = await sb.from("goals").update({ owner }, { count: "exact" }).eq("tag", tag).is("owner", null);
        if (g.error) throw g.error;
        if (body.endpoint) await sb.from("push_subs").update({ owner }).eq("tag", tag).eq("endpoint", String(body.endpoint)).is("owner", null);
        return json({ ok: true, goals: g.count ?? 0 });
      }

      // ----- notifications -----
      case "push_key":
        return json({ ok: true, key: (await vapid()).publicKey });
      case "push_subscribe": {
        const owner = await ownerOf(body.device, ip, true);
        if (!owner) return fail("no_device", 401);
        await limit("sub:" + ip, 3600, 30);
        if (!(await getProfile(tag))) return fail("unknown_profile", 404);
        const sub = cleanSub(body.sub);
        if (!sub) return fail("bad_subscription");
        const prefs = cleanPrefs(body.prefs);
        const { error } = await sb.from("push_subs").upsert({ ...sub, tag, owner, prefs, last_recap: recapMark(prefs, Date.now()) }, { onConflict: "endpoint,tag" });
        if (error) throw error;
        return json({ ok: true });
      }
      case "push_prefs": {
        // The subscription's endpoint is a secret only that phone knows, so it is what proves the request.
        const owner = await ownerOf(body.device, ip, false);
        const prefs = cleanPrefs(body.prefs);
        const patch: Record<string, unknown> = { prefs, last_recap: recapMark(prefs, Date.now()) };
        if (owner) patch.owner = owner;
        const { error } = await sb.from("push_subs").update(patch).eq("endpoint", String(body.endpoint ?? "")).eq("tag", tag);
        if (error) throw error;
        return json({ ok: true });
      }
      case "push_unsubscribe": {
        // Without a tag (older app versions), the device stops all its alerts.
        let q = sb.from("push_subs").delete().eq("endpoint", String(body.endpoint ?? ""));
        if (body.tag) q = q.eq("tag", tag);
        const { error } = await q;
        if (error) throw error;
        return json({ ok: true });
      }
      case "push_test": {
        await limit("ptest:" + ip, 3600, 20, true);
        const { data } = await sb.from("push_subs").select("*").eq("endpoint", String(body.endpoint ?? "")).eq("tag", tag);
        if (!data?.length) return fail("not_subscribed", 404);
        const p = await getProfile(tag);
        const sent = await pushTo(data, { title: "✅ Notifications are on", body: "You'll hear about " + (p?.name ?? "this profile") + "'s goals, milestones, club changes and get a daily recap.", tag: "test", url: "./?p=" + tag + "#goals" });
        return json({ ok: sent > 0, sent, error: sent ? null : "push_failed" });
      }
      case "push_selftest": {
        // Builds (but doesn't send) an encrypted push for a test subscription, to check the crypto works here.
        await limit("selftest:" + ip, 3600, 10, true);
        const sub = cleanSub(body.sub);
        if (!sub) return fail("bad_subscription");
        const v = await vapid();
        const d = webpush.generateRequestDetails({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify({ title: "selftest" }),
          { vapidDetails: { subject: v.subject, publicKey: v.publicKey, privateKey: v.privateKey }, TTL: 60 });
        const bodyB64 = btoa(String.fromCharCode(...new Uint8Array(d.body)));
        return json({ ok: true, publicKey: v.publicKey, headers: d.headers, body: bodyB64 });
      }
      case "recap": {
        // Run by the schedule every 5 minutes. Extra calls in between are ignored.
        if (!(await allow("recap", 120, 1))) return json({ ok: true, skipped: true });
        const out = await recap();
        if (new Date().getUTCMinutes() < 5) {
          // Once an hour: drop old abuse counters and expired link codes.
          await sb.from("rate_hits").delete().lt("at", new Date(Date.now() - 2 * 86_400_000).toISOString());
          await sb.from("device_links").delete().lt("expires_at", new Date().toISOString());
          const old = new Date(Date.now() - KEEP_BATTLES_DAYS * 86_400_000).toISOString();
          await sb.from("battles").delete().lt("t", old);
          await sb.from("sessions").delete().lt("ended_at", old);
          await sb.from("explore_cache").delete().lt("fetched_at", new Date(Date.now() - EX_STALE_MS).toISOString());
          await sb.from("usage_counters").delete().lt("hour", new Date(Date.now() - 90 * 86_400_000).toISOString());
          // Old readings are folded a limited number of days at a time, so a run never takes long.
          try { (out as any).thinned = await thinReadings(); } catch (e) { console.error("thin", (e as Error)?.message ?? e); }
        }
        return json(out);
      }
      case "recap_preview": {
        await limit("prev:" + ip, 600, 30);
        const d = await recapData(tag, Date.now());
        return json({ ok: true, body: recapBody(d), data: d });
      }
      default:
        return fail("unknown_action");
    }
  } catch (e) {
    if (e instanceof Limited) return fail("slow_down", 429);
    const msg = String((e as Error)?.message ?? e);
    // Lookup problems are answers, not server failures.
    if (["player_not_found", "club_not_found", "bad_club"].includes(msg)) return fail(msg, 404);
    return json({ ok: false, error: msg }, 502);
  }
}
