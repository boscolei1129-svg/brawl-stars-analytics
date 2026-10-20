// Brawl Stars Analytics server function.
//   POST {action:"refresh", src?:"auto"|"live"}  fetch fresh stats, save a reading and new battles
//   POST {action:"check_code", code}              confirm the owner code (unlocks goal editing)
//   POST {action:"goal_add", code, kind, target, brawler?}
//   POST {action:"goal_delete", code, id}
import { createClient } from "jsr:@supabase/supabase-js@2";

const ME = "8YRJ090Q2";
const CLUB = "2U0RP22G2";
const MIN_GAP_MS = 60_000; // refreshes closer together than this reuse the last reading

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

// BrawlTime refreshes club lists only now and then (up to about an hour behind the game). With an official
// Brawl Stars API key in the BS_API_KEY secret, the club comes straight from Supercell instead. Supercell keys
// only work from fixed addresses, so requests go through RoyaleAPI's proxy (allow 45.79.218.79 on the key).
async function getOfficialClub() {
  const key = Deno.env.get("BS_API_KEY");
  if (!key) return null;
  const r = await fetch(`https://bsproxy.royaleapi.dev/v1/clubs/${encodeURIComponent("#" + CLUB)}`, {
    headers: { Authorization: `Bearer ${key.trim()}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`Brawl Stars API answered ${r.status}`);
  const d = await r.json();
  if (!d || !Array.isArray(d.members)) throw new Error("Brawl Stars API returned no club");
  return d;
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
  };
  const brawlers: Record<string, unknown[]> = {};
  for (const [k, v] of Object.entries<any>(d.brawlers ?? {})) {
    brawlers[k] = [v.trophies, v.highestTrophies, v.power, v.name, v.prestigeLevel ?? 0, v.maxWinStreak ?? 0, v.currentWinStreak ?? 0];
  }
  const battles = (d.battles ?? []).map((x: any) => {
    let me: any = null;
    for (const team of x.teams ?? []) for (const pl of team) if (strip(pl.tag) === ME) me = pl;
    return {
      t: new Date(x.timestamp).toISOString(), mode: x.event?.mode ?? null, map: x.event?.map ?? null,
      result: x.result ?? null, win: typeof x.victory === "boolean" ? x.victory : null,
      tc: x.trophyChange ?? null, brawler: me?.brawler ?? null, ranked: !!x.ranked,
    };
  }).filter((b: any) => b.t && !b.t.startsWith("Invalid"));
  return { player, brawlers, battles };
}

function compactClub(c: any, src: string) {
  const members = (c.members ?? []).map((m: any) => [strip(m.tag), m.name, m.role, m.trophies]);
  return {
    name: c.name, tag: strip(c.tag), trophies: c.trophies, req: c.requiredTrophies, type: c.type, desc: c.description,
    members, src,
  };
}

// BrawlTime's club list lags; your own profile doesn't. Put your live trophies into your row and the total.
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

async function latest(column: "club") {
  const { data, error } = await sb.from("readings").select(`${column}, ts`).not(column, "is", null)
    .order("ts", { ascending: false }).order("id", { ascending: false }).limit(1);
  if (error) throw error;
  return data?.[0] ?? null;
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
  let saved = 0, stale = false, newFull: Record<string, unknown> | null = null;
  if (pr.status === "fulfilled") {
    const { player, brawlers, battles } = compactPlayer(pr.value);
    if (battles.length) {
      const { error } = await sb.from("battles").upsert(battles, { onConflict: "t", ignoreDuplicates: true });
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
    }
  }
  let patched = false;
  if (cr.status === "fulfilled") {
    const club = compactClub(cr.value.data, cr.value.src);
    if (club.src === "brawltime" && typeof row.trophies === "number") patched = patchMyRow(club, row.trophies as number);
    row.club_trophies = club.trophies;
    const prev = await latest("club");
    if (!prev || stable(prev.club) !== stable(club)) row.club = club;
  }
  const result = {
    ok: true, ts: now, trophies: (row.trophies as number) ?? null, club_trophies: (row.club_trophies as number) ?? null,
    battles_seen: saved, stored_brawlers: "brawlers" in row, stored_club: "club" in row,
    club_source: cr.status === "fulfilled" ? cr.value.src : null, club_patched: patched,
    official_error: cr.status === "fulfilled" ? cr.value.officialError : null,
    player_error: pr.status === "rejected" ? String(pr.reason?.message ?? pr.reason) : null,
    club_error: cr.status === "rejected" ? String(cr.reason?.message ?? cr.reason) : null,
  };
  // Nothing moved since the last reading: mark that reading as confirmed now instead of adding a copy.
  const unchanged = !!last && pr.status === "fulfilled" && cr.status === "fulfilled" && !stale &&
    !("brawlers" in row) && !("club" in row) && row.trophies === last.trophies && row.club_trophies === last.club_trophies &&
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
  return result;
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
      default:
        return json({ ok: false, error: "unknown_action" }, 400);
    }
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message ?? e) }, 502);
  }
});
