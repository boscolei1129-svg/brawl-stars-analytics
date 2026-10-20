// Brawl Stars Analytics server function. Every profile is a player tag (plus the club it follows);
// requests name it with `tag` (no #). Requests without one mean the original profile, LEGACY.
//   POST {action:"profile_lookup", tag, club?}     check a player (and club) before adding: name, icon, trophies
//   POST {action:"profile_add", tag, club?}        start tracking a new profile (anyone can; game stats are public)
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
import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const LEGACY = "8YRJ090Q2"; // the first profile; requests without a tag mean this one
const MAX_PROFILES = 20; // profiles tracked at once (each one's club is read every 15 minutes)
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
  if (src === "live") await sb.from("profiles").update({ last_open_at: new Date().toISOString(), active: true }).eq("tag", me);
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
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 6 * 3600, urgency: "normal" });
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
  if (!/^https:\/\//.test(endpoint) || !p256dh || !auth || endpoint.length > 1000) return null;
  return { endpoint, p256dh, auth };
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
// True while `key` has been used at most `max` times in the current `windowS`-second window. If the counter
// itself fails, the request goes through: a broken limit shouldn't take the app down.
async function allow(key: string, windowS: number, max: number) {
  const { data, error } = await sb.rpc("rate_hit", { p_key: key, p_window: windowS, p_max: max });
  if (error) { console.error("rate_hit", error.message); return true; }
  return data === true;
}
class Limited extends Error { constructor() { super("slow_down"); } }
async function limit(key: string, windowS: number, max: number) { if (!(await allow(key, windowS, max))) throw new Limited(); }

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
  await limit("newdev:" + ip, 3600, 30);
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
  if (!(await allow("code:" + tag, 3600, 10)) || !(await allow("codeip:" + ip, 3600, 20))) return false;
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
const publicProfile = (p: any) => ({ tag: p.tag, club: p.club, name: p.name, icon: p.icon, trophies: p.trophies, club_name: p.club_name, club_badge: p.club_badge ?? null });
const fail = (error: string, status = 400) => json({ ok: false, error }, status);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "Use POST" }, 405);
  let body: any = {};
  try { body = await req.json(); } catch { /* empty body */ }
  const tag = body.tag == null || body.tag === "" ? LEGACY : normTag(body.tag);
  const ip = ipOf(req);
  try {
    switch (body.action) {
      case "profile_lookup": {
        if (!TAG_RE.test(tag)) return fail("bad_tag");
        await limit("look:" + ip, 600, 40);
        const [found, existing] = await Promise.all([lookup(tag, body.club), getProfile(tag)]);
        return json({ ok: true, ...found, tracked: !!existing, profile: existing ? publicProfile(existing) : null });
      }
      case "profile_add": {
        if (!TAG_RE.test(tag)) return fail("bad_tag");
        const existing = await getProfile(tag);
        if (existing) {
          // Already tracked (someone else added it): this device just saves it. A profile that was set to some
          // other club (or none) goes back to following the player's own club when anyone adds it that way, and
          // can't be pointed away from it again, so nobody can spoil a player's profile for everyone else.
          const patch: Record<string, unknown> = {};
          if (!existing.active) Object.assign(patch, { active: true, last_open_at: new Date().toISOString() });
          if (!existing.follow && body.club === undefined) patch.follow = true;
          if (Object.keys(patch).length) await sb.from("profiles").update(patch).eq("tag", tag);
          return json({ ok: true, exists: true, profile: publicProfile({ ...existing, ...patch }) });
        }
        await limit("add:" + ip, 3600, 6);
        const { count } = await sb.from("profiles").select("tag", { count: "exact", head: true }).eq("active", true);
        if ((count ?? 0) >= MAX_PROFILES) return fail("full", 409);
        const found = await lookup(tag, body.club);
        // Left to the player's own club (or none), the profile keeps following them if they move.
        const follow = body.club === undefined || !!found.club?.own || (!found.club && !found.player.club);
        const row = { tag, club: found.club?.tag ?? null, name: found.player.name, icon: found.player.icon, trophies: found.player.trophies,
          club_name: found.club?.name ?? null, club_badge: found.club?.badge ?? null, follow };
        const { error } = await sb.from("profiles").insert(row);
        if (error) { if (error.code === "23505") return json({ ok: true, exists: true, profile: row }); throw error; }
        // First reading now, so the dashboard has something to show straight away.
        let first: unknown = null;
        try { first = await refresh("live", row); } catch (e) { first = { error: String((e as Error)?.message ?? e) }; }
        return json({ ok: true, created: true, profile: publicProfile((await getProfile(tag)) ?? row), first });
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
        await sb.from("device_links").delete().eq("owner", owner);
        const expires_at = new Date(Date.now() + LINK_MS).toISOString();
        for (let i = 0; i < 5; i++) {
          const code = sixDigits();
          const { error } = await sb.from("device_links").insert({ code_hash: await sha256("link:" + code), owner, expires_at });
          if (!error) return json({ ok: true, code, expires_at });
          if (error.code !== "23505") throw error;
        }
        throw new Error("no_code");
      }
      case "link_redeem": {
        if (typeof body.device !== "string" || !DEV_RE.test(body.device)) return fail("no_device", 401);
        // Six digits are only safe because guesses are scarce: per address, and for everyone together.
        await limit("linkr:" + ip, 3600, 10);
        await limit("linkr:all", 3600, 300);
        const code = String(body.code ?? "").replace(/\D/g, "");
        if (code.length !== 6) return fail("bad_link");
        const code_hash = await sha256("link:" + code);
        const { data: link } = await sb.from("device_links").select("*").eq("code_hash", code_hash).gt("expires_at", new Date().toISOString()).maybeSingle();
        if (!link) return fail("bad_link", 404);
        const key_hash = await deviceHash(body.device);
        const { data: mine } = await sb.from("device_keys").select("owner").eq("key_hash", key_hash).maybeSingle();
        if (mine?.owner === link.owner) return fail("same_device");
        await sb.from("device_links").delete().eq("code_hash", code_hash); // single use
        let moved = 0;
        if (mine?.owner) {
          // This device (and any linked to it) joins the other one, bringing its own goals and alerts along.
          const g = await sb.from("goals").update({ owner: link.owner }, { count: "exact" }).eq("owner", mine.owner);
          moved = g.count ?? 0;
          await sb.from("push_subs").update({ owner: link.owner }).eq("owner", mine.owner);
          await sb.from("device_keys").update({ owner: link.owner }).eq("owner", mine.owner);
        } else {
          const { error } = await sb.from("device_keys").insert({ key_hash, owner: link.owner });
          if (error) throw error;
        }
        return json({ ok: true, moved });
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
        await limit("ptest:" + ip, 3600, 20);
        const { data } = await sb.from("push_subs").select("*").eq("endpoint", String(body.endpoint ?? "")).eq("tag", tag);
        if (!data?.length) return fail("not_subscribed", 404);
        const p = await getProfile(tag);
        const sent = await pushTo(data, { title: "✅ Notifications are on", body: "You'll hear about " + (p?.name ?? "this profile") + "'s goals, milestones, club changes and get a daily recap.", tag: "test", url: "./?p=" + tag + "#goals" });
        return json({ ok: sent > 0, sent, error: sent ? null : "push_failed" });
      }
      case "push_selftest": {
        // Builds (but doesn't send) an encrypted push for a test subscription, to check the crypto works here.
        await limit("selftest:" + ip, 3600, 10);
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
});
