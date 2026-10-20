// Brawl Stars Analytics server function.
//   POST {action:"refresh", src?:"auto"|"live"}  fetch fresh stats, save a reading and new battles
//   POST {action:"check_code", code}              confirm the owner code (unlocks goal editing)
//   POST {action:"goal_add", code, kind, target, brawler?}
//   POST {action:"goal_delete", code, id}
//   POST {action:"push_key"}                       public key for turning on notifications
//   POST {action:"push_subscribe", code, sub, prefs?} / {action:"push_prefs", code, endpoint, prefs}
//   POST {action:"push_unsubscribe", endpoint} / {action:"push_test", code, endpoint}
//   POST {action:"recap"}                          nightly summary notification (run by the schedule)
import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const ME = "8YRJ090Q2";
const CLUB = "2U0RP22G2";
const MIN_GAP_MS = 60_000; // refreshes closer together than this reuse the last reading
const TZ = "Asia/Shanghai"; // "today" for the nightly recap
const STEP_ME = 500, STEP_CLUB = 5000; // milestone sizes for notifications
const GAP_MS = 20 * 60_000; // battles closer together than this are one play session
const BATTLE_MS = 3 * 60_000; // a session starts about one battle before its first battle ends
const ACTIVITY_EVERY_MS = 4 * 60_000; // read members' battle logs at most this often

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

async function getOfficialClub() {
  const d = await officialGet(`/clubs/${encodeURIComponent("#" + CLUB)}`);
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

async function getClub(): Promise<{ data: any; src: string; officialError: string | null }> {
  let officialError: string | null = null;
  try {
    const d = await getOfficialClub();
    if (d) return { data: d, src: "official", officialError };
  } catch (e) {
    officialError = String((e as Error)?.message ?? e);
  }
  return { data: await getFeedRetry(() => feed("club.byTag", CLUB)), src: "brawltime", officialError };
}

function compactPlayer(d: any) {
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
    let me: any = null;
    for (const team of x.teams ?? []) for (const pl of team) if (strip(pl.tag) === ME) me = pl;
    return {
      t: new Date(x.timestamp).toISOString(), mode: x.event?.mode ?? null, map: x.event?.map ?? null,
      result: x.result ?? null, win: typeof x.victory === "boolean" ? x.victory : null,
      tc: x.trophyChange ?? null, brawler: me?.brawler ?? null, ranked: !!x.ranked, event_id: x.event?.id ?? null,
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
function patchMyRow(club: any, myTrophies: number) {
  const row = club.members.find((m: any[]) => m[0] === ME);
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
async function clubFull(): Promise<any> {
  const saved = await getSetting("club_full");
  if (saved) return JSON.parse(saved);
  const { data, error } = await sb.from("readings").select("club, club_upd").or("club.not.is.null,club_upd.not.is.null")
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
async function brawlersFull(): Promise<Record<string, unknown>> {
  const saved = await getSetting("brawlers_full");
  if (saved) return JSON.parse(saved);
  const { data, error } = await sb.from("readings").select("brawlers").not("brawlers", "is", null)
    .order("ts", { ascending: true }).order("id", { ascending: true });
  if (error) throw error;
  const full: Record<string, unknown> = {};
  for (const r of data ?? []) Object.assign(full, r.brawlers);
  return full;
}

async function refresh(src: string) {
  const { data: lastRows, error: lastErr } = await sb.from("readings")
    .select("id, ts, checked, nb, trophies, club_trophies, player")
    .order("ts", { ascending: false }).order("id", { ascending: false }).limit(1);
  if (lastErr) throw lastErr;
  const last = lastRows?.[0] ?? null;
  const lastSeen = last ? Math.max(ms(last.ts), ms(last.checked)) : 0;
  if (last && Date.now() - lastSeen < MIN_GAP_MS) {
    return { ok: true, skipped: true, ts: new Date(lastSeen).toISOString() };
  }
  const [pr, cr] = await Promise.allSettled([
    getFeedRetry(() => feed("player.byTag", ME)),
    getClub(),
  ]);
  if (pr.status === "rejected" && cr.status === "rejected") throw new Error(String(pr.reason?.message ?? pr.reason));

  const now = new Date().toISOString();
  const row: Record<string, unknown> = { src, ts: now };
  let saved = 0, stale = false, newFull: Record<string, unknown> | null = null, fullNow: Record<string, any> | null = null;
  if (pr.status === "fulfilled") {
    const { player, brawlers, battles } = compactPlayer(pr.value);
    if (battles.length) {
      // Re-saving known battles is harmless (same data) and fills in details added later, like the map's id.
      const { error } = await sb.from("battles").upsert(battles, { onConflict: "t" });
      if (error) throw error;
      saved = battles.length;
    }
    const nb = battles.length ? battles.reduce((m: string, b: any) => (b.t > m ? b.t : m), battles[0].t) : null;
    // A delayed feed (older newest battle than what's saved) must not overwrite newer player data.
    const { data: maxRow } = await sb.from("readings").select("nb").not("nb", "is", null).order("nb", { ascending: false }).limit(1);
    stale = nb != null && ms(nb) < ms(maxRow?.[0]?.nb);
    if (!stale) {
      row.nb = nb;
      row.trophies = player.trophies;
      row.player = player;
      const full = await brawlersFull();
      const delta: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(brawlers)) if (stable(full[k]) !== stable(v)) delta[k] = v;
      if (Object.keys(delta).length) { row.brawlers = delta; newFull = { ...full, ...delta }; }
      fullNow = (newFull ?? full) as Record<string, any>;
    }
  }
  let patched = false, live = 0, newClub: any = null, prevClub: any = null;
  if (cr.status === "fulfilled") {
    const club = compactClub(cr.value.data, cr.value.src);
    prevClub = await clubFull();
    const fresh = await liveMembers(club, prevClub);
    live = fresh.size;
    if (!fresh.has(ME) && typeof row.trophies === "number") patched = patchMyRow(club, row.trophies as number);
    row.club_trophies = club.trophies;
    const change = clubChange(prevClub, club);
    if (change) { if (change.d) row.club_upd = change; else row.club = change; newClub = club; }
  }
  let activity: unknown = null;
  if (cr.status === "fulfilled") {
    try { activity = await trackActivity((newClub ?? prevClub)?.members?.map((m: any[]) => m[0]) ?? []); }
    catch (e) { activity = { error: String((e as Error)?.message ?? e) }; }
  }
  const result = {
    activity,
    ok: true, ts: now, trophies: (row.trophies as number) ?? null, club_trophies: (row.club_trophies as number) ?? null,
    battles_seen: saved, stored_brawlers: "brawlers" in row, stored_club: "club" in row ? "full" : "club_upd" in row ? "update" : false,
    club_source: cr.status === "fulfilled" ? cr.value.src : null, club_live_members: live, club_patched: patched,
    official_error: cr.status === "fulfilled" ? cr.value.officialError : null,
    player_error: pr.status === "rejected" ? String(pr.reason?.message ?? pr.reason) : null,
    club_error: cr.status === "rejected" ? String(cr.reason?.message ?? cr.reason) : null,
  };
  // Nothing moved since the last reading: mark that reading as confirmed now instead of adding a copy.
  const unchanged = !!last && pr.status === "fulfilled" && cr.status === "fulfilled" && !stale &&
    !("brawlers" in row) && !newClub && row.trophies === last.trophies && row.club_trophies === last.club_trophies &&
    ms(row.nb) === ms(last.nb) && stable(row.player) === stable(last.player);
  if (unchanged) {
    const { error } = await sb.from("readings").update({ checked: now }).eq("id", last!.id);
    if (error) throw error;
    return { ...result, unchanged: true };
  }
  const { error } = await sb.from("readings").insert(row);
  if (error) throw error;
  if (newFull) {
    const { error: setErr } = await sb.from("settings").upsert({ key: "brawlers_full", value: JSON.stringify(newFull) });
    if (setErr) throw setErr;
  }
  if (newClub) {
    const { error: setErr } = await sb.from("settings").upsert({ key: "club_full", value: JSON.stringify(newClub) });
    if (setErr) throw setErr;
  }
  let notified = 0;
  try {
    notified = await checkEvents({
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
async function trackActivity(tags: string[]) {
  if (!Deno.env.get("BS_API_KEY") || !tags.length) return null;
  const at = Number(await getSetting("activity_at")) || 0;
  if (Date.now() - at < ACTIVITY_EVERY_MS) return { skipped: true };
  await setSetting("activity_at", String(Date.now()));
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
      for (const r of rows) (r.id ? updates : inserts).push({ ...r, updated_at: new Date().toISOString() });
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
async function notify(kind: string, payload: unknown) {
  const { data, error } = await sb.from("push_subs").select("*");
  if (error) throw error;
  return pushTo((data ?? []).filter((s: any) => s.prefs?.[kind] !== false), payload);
}
const fmtN = (n: number) => Math.round(n).toLocaleString("en-US");
const sgnN = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "") + fmtN(Math.abs(n));
const titleCase = (s: string) => String(s ?? "").toLowerCase().replace(/(^|[\s-])\S/g, (c) => c.toUpperCase());

// Goals reached, trophy milestones and roster changes since the last refresh. The first run only records
// where things stand, so nothing old is announced.
async function checkEvents(cur: { trophies: number | null; club: number | null; elo: number | null; brawlers: Record<string, any> | null; prevClub: any; newClub: any }) {
  const raw = await getSetting("notify_state");
  const first = !raw;
  const st = raw ? JSON.parse(raw) : {};
  const out: { kind: string; payload: unknown }[] = [];
  if (cur.trophies != null) {
    const m = Math.floor(cur.trophies / STEP_ME) * STEP_ME;
    if (st.me == null) st.me = m;
    else if (m > st.me) {
      out.push({ kind: "milestones", payload: { title: "🏆 " + fmtN(m) + " trophies", body: "You just passed " + fmtN(m) + ". Now at " + fmtN(cur.trophies) + ".", tag: "me-milestone", url: "./#me" } });
      st.me = m;
    }
  }
  if (cur.club != null) {
    const m = Math.floor(cur.club / STEP_CLUB) * STEP_CLUB;
    if (st.club == null) st.club = m;
    else if (m > st.club) {
      out.push({ kind: "milestones", payload: { title: "⭐ Stargazers passed " + fmtN(m), body: "The club is at " + fmtN(cur.club) + " trophies.", tag: "club-milestone", url: "./#club" } });
      st.club = m;
    }
  }
  const { data: goals } = await sb.from("goals").select("*");
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
    out.push({ kind: "goals", payload: { title: "🎯 Goal reached", body: name + ". Now at " + fmtN(v) + ".", tag: "goal-" + g.id, url: "./#goals" } });
  }
  st.goals = st.goals.filter((id: string) => (goals ?? []).some((g: any) => g.id === id));
  if (!first && cur.prevClub?.members && cur.newClub?.members) {
    const before = new Map(cur.prevClub.members.map((m: any[]) => [m[0], m[1]]));
    const after = new Map(cur.newClub.members.map((m: any[]) => [m[0], m[1]]));
    const joined = [...after].filter(([t]) => !before.has(t)).map(([, n]) => n);
    const left = [...before].filter(([t]) => !after.has(t)).map(([, n]) => n);
    const list = (a: string[]) => (a.length <= 2 ? a.join(" and ") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]);
    if (joined.length || left.length) {
      const parts = [joined.length ? list(joined) + " joined" : "", left.length ? list(left) + " left" : ""].filter(Boolean);
      out.push({ kind: "roster", payload: { title: "👋 Stargazers members", body: parts.join(". ") + ". The club has " + after.size + "/30.", tag: "roster", url: "./#club" } });
    }
  }
  await setSetting("notify_state", st);
  let sent = 0;
  for (const o of out) sent += await notify(o.kind, o.payload);
  return sent;
}

// Nightly summary of today's battles and club change, in the TZ time zone.
async function recap() {
  const now = new Date();
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(now).map((x) => [x.type, x.value]));
  const today = `${p.year}-${p.month}-${p.day}`;
  const offset = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(now.getTime() / 60000) * 60000;
  const midnight = new Date(Date.UTC(+p.year, +p.month - 1, +p.day) - offset).toISOString();
  const st = JSON.parse((await getSetting("notify_state")) ?? "{}");
  if (st.recap === today) return { ok: true, skipped: "already sent today" };
  const { data: bs, error } = await sb.from("battles").select("win, tc").gte("t", midnight);
  if (error) throw error;
  const n = bs?.length ?? 0, w = (bs ?? []).filter((b: any) => b.win === true).length, l = (bs ?? []).filter((b: any) => b.win === false).length;
  const net = (bs ?? []).reduce((a: number, b: any) => a + (b.tc ?? 0), 0);
  const at = async (col: string, before: boolean) => {
    let q = sb.from("readings").select(col).not(col, "is", null);
    q = before ? q.lte("ts", midnight).order("ts", { ascending: false }) : q.order("ts", { ascending: false });
    const { data } = await q.limit(1);
    return (data?.[0] as any)?.[col] ?? null;
  };
  const [club0, club1, me1] = await Promise.all([at("club_trophies", true), at("club_trophies", false), at("trophies", false)]);
  const clubDelta = club0 != null && club1 != null ? club1 - club0 : 0;
  st.recap = today;
  await setSetting("notify_state", st);
  if (!n && !clubDelta) return { ok: true, skipped: "nothing happened today" };
  const body = (n ? n + (n === 1 ? " battle" : " battles") + " · " + sgnN(net) + " trophies" + (w + l ? " · " + Math.round((w / (w + l)) * 100) + "% wins" : "") : "No battles today")
    + (me1 != null ? " · now " + fmtN(me1) : "") + (clubDelta ? ". Club " + sgnN(clubDelta) + " today." : ".");
  const sent = await notify("recap", { title: "🌙 Today in Brawl Stars", body, tag: "recap", url: "./#me" });
  return { ok: true, sent };
}

const PREF_KEYS = ["goals", "milestones", "roster", "recap"];
const cleanPrefs = (p: any) => Object.fromEntries(PREF_KEYS.map((k) => [k, p?.[k] !== false]));
function cleanSub(sub: any) {
  const endpoint = String(sub?.endpoint ?? ""), p256dh = String(sub?.keys?.p256dh ?? ""), auth = String(sub?.keys?.auth ?? "");
  if (!/^https:\/\//.test(endpoint) || !p256dh || !auth || endpoint.length > 1000) return null;
  return { endpoint, p256dh, auth };
}

async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function codeOk(code: unknown) {
  if (typeof code !== "string" || !code.trim()) return false;
  const { data } = await sb.from("settings").select("value").eq("key", "owner_code_sha256").maybeSingle();
  const ok = !!data && data.value === (await sha256(code.trim().toUpperCase()));
  if (!ok) await new Promise((r) => setTimeout(r, 800)); // slow down guessing
  return ok;
}

async function currentValue(kind: string, brawler?: string) {
  if (kind === "club") {
    const { data } = await sb.from("readings").select("club_trophies").not("club_trophies", "is", null).order("ts", { ascending: false }).limit(1);
    return data?.[0]?.club_trophies ?? null;
  }
  const { data } = await sb.from("readings").select("player").not("player", "is", null)
    .order("nb", { ascending: false, nullsFirst: false }).order("ts", { ascending: false }).limit(1);
  const p = data?.[0]?.player;
  if (kind === "player") return p?.trophies ?? null;
  if (kind === "elo") return p?.elo ?? null;
  if (kind === "brawler" && brawler) {
    const v = (await brawlersFull())[brawler];
    return Array.isArray(v) ? v[0] : null;
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "Use POST" }, 405);
  let body: any = {};
  try { body = await req.json(); } catch { /* empty body */ }
  try {
    switch (body.action) {
      case "refresh":
        return json(await refresh(body.src === "live" ? "live" : "auto"));
      case "check_code":
        return json({ ok: await codeOk(body.code) });
      case "goal_add": {
        if (!(await codeOk(body.code))) return json({ ok: false, error: "wrong_code" }, 403);
        const kind = String(body.kind);
        const target = Math.round(Number(body.target));
        if (!["player", "club", "brawler", "elo"].includes(kind) || !(target > 0)) return json({ ok: false, error: "bad_goal" }, 400);
        const brawler = kind === "brawler" ? String(body.brawler ?? "") : null;
        if (kind === "brawler" && !brawler) return json({ ok: false, error: "bad_goal" }, 400);
        const start = await currentValue(kind, brawler ?? undefined);
        const { data, error } = await sb.from("goals").insert({ kind, target, brawler, start }).select().single();
        if (error) throw error;
        return json({ ok: true, goal: data });
      }
      case "goal_delete": {
        if (!(await codeOk(body.code))) return json({ ok: false, error: "wrong_code" }, 403);
        const { error } = await sb.from("goals").delete().eq("id", String(body.id));
        if (error) throw error;
        return json({ ok: true });
      }
      case "push_key":
        return json({ ok: true, key: (await vapid()).publicKey });
      case "push_subscribe": {
        if (!(await codeOk(body.code))) return json({ ok: false, error: "wrong_code" }, 403);
        const sub = cleanSub(body.sub);
        if (!sub) return json({ ok: false, error: "bad_subscription" }, 400);
        const { error } = await sb.from("push_subs").upsert({ ...sub, prefs: cleanPrefs(body.prefs) });
        if (error) throw error;
        return json({ ok: true });
      }
      case "push_prefs": {
        if (!(await codeOk(body.code))) return json({ ok: false, error: "wrong_code" }, 403);
        const { error } = await sb.from("push_subs").update({ prefs: cleanPrefs(body.prefs) }).eq("endpoint", String(body.endpoint ?? ""));
        if (error) throw error;
        return json({ ok: true });
      }
      case "push_unsubscribe": {
        const { error } = await sb.from("push_subs").delete().eq("endpoint", String(body.endpoint ?? ""));
        if (error) throw error;
        return json({ ok: true });
      }
      case "push_test": {
        if (!(await codeOk(body.code))) return json({ ok: false, error: "wrong_code" }, 403);
        const { data } = await sb.from("push_subs").select("*").eq("endpoint", String(body.endpoint ?? ""));
        if (!data?.length) return json({ ok: false, error: "not_subscribed" }, 404);
        const sent = await pushTo(data, { title: "✅ Notifications are on", body: "You'll hear about goals, milestones, club changes and get a nightly recap.", tag: "test", url: "./#goals" });
        return json({ ok: sent > 0, sent, error: sent ? null : "push_failed" });
      }
      case "push_selftest": {
        // Builds (but doesn't send) an encrypted push for a test subscription, to check the crypto works here.
        if (!(await codeOk(body.code))) return json({ ok: false, error: "wrong_code" }, 403);
        const sub = cleanSub(body.sub);
        if (!sub) return json({ ok: false, error: "bad_subscription" }, 400);
        const v = await vapid();
        const d = webpush.generateRequestDetails({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify({ title: "selftest" }),
          { vapidDetails: { subject: v.subject, publicKey: v.publicKey, privateKey: v.privateKey }, TTL: 60 });
        const bodyB64 = btoa(String.fromCharCode(...new Uint8Array(d.body)));
        return json({ ok: true, publicKey: v.publicKey, headers: d.headers, body: bodyB64 });
      }
      case "recap":
        return json(await recap());
      default:
        return json({ ok: false, error: "unknown_action" }, 400);
    }
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message ?? e) }, 502);
  }
});
