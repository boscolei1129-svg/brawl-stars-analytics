// Explore (no tracking), the shared cache, limits and their failure behaviour, and safe slot claims,
// run against the real server code (fn_harness.js).
// node fn_explore.js ../standalone/supabase/functions/brawl/index.ts
const { load } = require("./fn_harness");
const crypto = require("crypto");
const FILE = process.argv[2];
let fails = 0, n = 0;
const ok = (label, cond, extra) => { n++; if (!cond) { fails++; console.log("FAIL", label, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ""); } else console.log("ok  ", label); };
const dev = () => crypto.randomBytes(32).toString("base64url");
let ipN = 1; const freshIp = () => "198.18.0." + ipN++;

// A fake official API: two players, one club, call counts, and a switch to make it fail.
function api() {
  const calls = { player: 0, log: 0, club: 0, feed: 0 };
  const st = { down: false, slow: 0 };
  const bt = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, ".000Z");
  const now = Date.now();
  const log = [
    { battleTime: bt(new Date(now - 5 * 60e3)), event: { mode: "gemGrab", map: "Hard Rock Mine" }, battle: { mode: "gemGrab", type: "ranked", result: "victory", duration: 120, trophyChange: 8,
      starPlayer: { tag: "#2PPLYQ2C", name: "Nova" }, teams: [[{ tag: "#2PPLYQ2C", name: "Nova", brawler: { id: 16000000, name: "SHELLY", power: 11, trophies: 900 } }, { tag: "#AAA", name: "Mate" }, { tag: "#BBB", name: "Mate2" }], [{ tag: "#CCC", name: "Enemy" }]] } },
    { battleTime: bt(new Date(now - 9 * 60e3)), event: { mode: "soloShowdown", map: "Skull Creek" }, battle: { mode: "soloShowdown", type: "ranked", rank: 3, trophyChange: 5,
      players: [{ tag: "#2PPLYQ2C", name: "Nova", brawler: { id: 16000001, name: "COLT", power: 10, trophies: 700 } }, { tag: "#DDD", name: "Other" }] } },
    { battleTime: bt(new Date(now - 9 * 60e3)), event: { mode: "soloShowdown", map: "Skull Creek" }, battle: { mode: "soloShowdown", type: "ranked", rank: 3, trophyChange: 5, players: [{ tag: "#2PPLYQ2C", brawler: { id: 16000001, name: "COLT" } }] } }, // duplicate
    { battleTime: bt(new Date(now - 30 * 60e3)), event: { mode: "brawlBall", map: "Center Stage" }, battle: { mode: "brawlBall", type: "ranked", result: "draw", trophyChange: 0, teams: [[{ tag: "#2PPLYQ2C", brawler: { id: 16000000, name: "SHELLY" } }], [{ tag: "#EEE" }]] } },
  ];
  const player = { tag: "#2PPLYQ2C", name: "Nova", icon: { id: 28000010 }, trophies: 31210, highestTrophies: 31500, expLevel: 120, "3vs3Victories": 5000, soloVictories: 300, duoVictories: 200,
    club: { tag: "#2U0RP22G2", name: "Stargazers" }, brawlers: [{ id: 16000000, name: "SHELLY", power: 11, rank: 25, trophies: 900, highestTrophies: 950, gadgets: [{}, {}], starPowers: [{}], gears: [{}, {}] }, { id: 16000001, name: "COLT", power: 10, trophies: 700, highestTrophies: 720 }] };
  const club = { tag: "#2U0RP22G2", name: "Stargazers", description: "hi", type: "open", badgeId: 8000002, requiredTrophies: 30000, trophies: 900000,
    members: [{ tag: "#AAA", name: "Low", role: "member", trophies: 10000 }, { tag: "#BBB", name: "High", role: "president", trophies: 50000, icon: { id: 1 } }] };
  const fetch = async (url) => {
    const u = decodeURIComponent(String(url));
    await new Promise((r) => setTimeout(r, st.slow));
    if (u.includes("brawltime")) { calls.feed++; return new Response("{}", { status: 503 }); }
    if (st.down) return new Response("{}", { status: 503 });
    const m = /\/(players|clubs)\/#([A-Z0-9]+)(\/battlelog)?/.exec(u);
    if (!m) return new Response("{}", { status: 404 });
    if (m[1] === "clubs") { calls.club++; return m[2] === "2U0RP22G2" ? new Response(JSON.stringify(club)) : new Response("{}", { status: 404 }); }
    if (m[3]) { calls.log++; return m[2] === "2PPLYQ2C" ? new Response(JSON.stringify({ items: log })) : m[2] === "9GQRUJ2Y" ? new Response(JSON.stringify({ items: [] })) : new Response("{}", { status: 404 }); }
    calls.player++;
    if (m[2] === "2PPLYQ2C") return new Response(JSON.stringify(player));
    if (m[2] === "9GQRUJ2Y") return new Response(JSON.stringify({ ...player, tag: "#9GQRUJ2Y", name: "Quiet", club: null }));
    if (m[2] === "8QJ0P2LG") return new Response(JSON.stringify({ ...player, tag: "#8QJ0P2LG", name: "Third", club: null }));
    return new Response("{}", { status: 404 });
  };
  return { calls, st, fetch };
}

(async () => {
  // ---- looking things up writes nothing about the visitor or the player ----
  {
    const A = api();
    const { db, call } = load(FILE, { fetch: A.fetch });
    const r = await call({ action: "explore_player", tag: "#2pplyq2c" }, freshIp());
    ok("explore_player answers without any device or saved player", r.ok && r.player.name === "Nova" && r.source === "live" && r.tracked === false, r);
    ok("nothing is tracked: no profiles, devices, holders, readings or battles written",
      !db.T.profiles.length && !db.T.device_keys.length && !db.T.profile_adders.length && !db.T.readings.length && !db.T.battles.length);
    ok("one shared cache entry is written", db.T.explore_cache.length === 1 && db.T.explore_cache[0].key === "p:2PPLYQ2C");
    const b = r.player.battles;
    ok("battle log: duplicates removed, newest first, actual count kept (3, not 25)", b.length === 3 && b[0].t > b[1].t, b && b.length);
    ok("battle log: wins, draws and showdown ranks kept as the game gives them", b[0].result === "victory" && b[1].rank === 3 && b[1].result === null && b[2].result === "draw");
    ok("battle log: the player's own brawler and star player", b[0].br.name === "SHELLY" && b[0].star === true && b[0].team === 3);
    ok("other players' names and tags are not passed on", !JSON.stringify(r.player.battles).includes("Mate") && !JSON.stringify(r.player.battles).includes("#CCC") && !JSON.stringify(r.player.battles).includes("Enemy"));
    ok("brawlers: power, rank and gear counts", r.player.brawlers[0].power === 11 && r.player.brawlers[0].g === 2 && r.player.brawlers[0].gear === 2);
    const before = { ...A.calls };
    const r2 = await call({ action: "explore_player", tag: "2PPLYQ2C" }, freshIp());
    ok("a second lookup within 2 minutes is served from the cache (no API call)", r2.source === "cache" && A.calls.player === before.player && A.calls.log === before.log, { r2: r2.source, calls: A.calls });
    // A fresh server (new isolate) still finds the shared copy.
    const { call: call2, db: db2 } = load(FILE, { fetch: A.fetch });
    db2.T.explore_cache.push(...db.T.explore_cache);
    const r3 = await call2({ action: "explore_player", tag: "2PPLYQ2C" }, freshIp());
    ok("another server instance uses the shared cache table", r3.source === "cache" && A.calls.player === before.player);
    // Same player looked up by many at once: one fetch.
    const C = api();
    const { call: c3 } = load(FILE, { fetch: C.fetch });
    C.st.slow = 30;
    const many = await Promise.all(Array.from({ length: 6 }, () => c3({ action: "explore_player", tag: "2PPLYQ2C" }, freshIp())));
    ok("6 simultaneous lookups of one player make one API fetch", many.every((x) => x.ok) && C.calls.player === 1 && C.calls.log === 1, C.calls);
    // A quiet player: empty battle log stays empty, not invented.
    const q = await call({ action: "explore_player", tag: "9GQRUJ2Y" }, freshIp());
    ok("a player with no recent battles shows 0 battles", q.ok && Array.isArray(q.player.battles) && q.player.battles.length === 0);
    // Not found, and not asked again for a while.
    const nf1 = await call({ action: "explore_player", tag: "2PP" }, freshIp());
    const pc = A.calls.player;
    const nf2 = await call({ action: "explore_player", tag: "2PP" }, freshIp());
    ok("unknown tag: 404, and asking again doesn't call the API", nf1.status === 404 && nf1.error === "player_not_found" && nf2.status === 404 && A.calls.player === pc);
    ok("bad tag is refused before anything else", (await call({ action: "explore_player", tag: "hello!" }, freshIp())).error === "bad_tag");
    ok("missing tag is refused (doesn't fall back to the first profile)", (await call({ action: "explore_player" }, freshIp())).error === "bad_tag");
    // Club scout.
    const club = await call({ action: "explore_club", tag: "2u0rp22g2" }, freshIp());
    ok("explore_club: members sorted by trophies, no tracking", club.ok && club.club.members[0][1] === "High" && club.club.members.length === 2 && !db.T.profiles.length, club);
    ok("explore_club: unknown club is a 404", (await call({ action: "explore_club", tag: "99999" }, freshIp())).error === "club_not_found");
    // Usage counts.
    const u = Object.fromEntries(db.T.usage_counters.map((x) => [x.key, x.n]));
    ok("usage is counted per hour without identifiers", u["explore:player"] >= 5 && u["explore:miss"] >= 2 && u["explore:hit"] >= 1 && u["explore:club"] === 2 && !db.T.usage_counters.some((x) => /\d+\.\d+\.\d+/.test(x.key)), u);
  }
  // ---- when the game's API is down ----
  {
    const A = api();
    const { db, call, clock } = load(FILE, { fetch: A.fetch });
    await call({ action: "explore_player", tag: "2PPLYQ2C" }, freshIp());
    db.T.explore_cache[0].fetched_at = new Date(Date.now() - 10 * 60e3).toISOString(); // older than 2 minutes
    const { call: callB, db: dbB } = load(FILE, { fetch: A.fetch }); // a fresh instance (empty memory)
    dbB.T.explore_cache.push(...db.T.explore_cache);
    A.st.down = true;
    const r = await callB({ action: "explore_player", tag: "2PPLYQ2C" }, freshIp());
    ok("API down: a copy up to a day old is shown, labelled stale with its time", r.ok && r.source === "stale" && Date.now() - Date.parse(r.fetched_at) > 9 * 60e3, r);
    const r2 = await callB({ action: "explore_player", tag: "9GQRUJ2Y" }, freshIp());
    ok("API down and nothing cached: a clear error, not a crash", r2.status === 502 && r2.error === "upstream_unavailable", r2);
  }
  // ---- limits ----
  {
    const A = api();
    const { db, call } = load(FILE, { fetch: A.fetch });
    const res = [];
    for (let i = 0; i < 61; i++) res.push((await call({ action: "explore_player", tag: "2PPLYQ2C" }, "203.0.113.9")).status);
    ok("61st lookup from one network in 10 minutes is refused", res.slice(0, 60).every((s) => s === 200) && res[60] === 429, res.slice(55));
    ok("another network is unaffected", (await call({ action: "explore_player", tag: "2PPLYQ2C" }, "203.0.113.10")).status === 200);
    ok("limits hit are counted", db.T.usage_counters.some((x) => x.key === "limited:ex" && x.n === 1));
    // The app-wide budget for fresh fetches: once spent, cached/stale copies only.
    const bucket = Math.floor(Date.now() / 1000 / 3600), hit = db.T.rate_hits.find((x) => x.key === "exmiss" && x.bucket === bucket);
    if (hit) hit.n = 1000; else db.T.rate_hits.push({ key: "exmiss", bucket, n: 1000, at: new Date().toISOString() });
    const apiBefore = A.calls.player;
    const b = await call({ action: "explore_player", tag: "9GQRUJ2Y" }, freshIp());
    ok("budget spent and no copy: 429 instead of calling the API", b.status === 429 && A.calls.player === apiBefore, b);
    const c = await call({ action: "explore_player", tag: "2PPLYQ2C" }, freshIp());
    ok("budget spent: cached players still load", c.ok);
  }
  // ---- what happens when the limit counter itself fails ----
  {
    const A = api();
    const { db, call } = load(FILE, { fetch: A.fetch });
    db.T.profiles.push({ tag: "8YRJ090Q2", active: true, keep: true });
    db.T.readings.push({ id: 1, tag: "8YRJ090Q2", ts: new Date().toISOString(), trophies: 1, player: { trophies: 1 } });
    const D = dev();
    await call({ action: "goal_add", tag: "8YRJ090Q2", device: D, kind: "player", target: 4 }, freshIp()); // this device is known
    db.fail.rate_hit = true;
    const ex = await call({ action: "explore_player", tag: "2PPLYQ2C" }, freshIp());
    ok("counter down: Explore lookups are refused (they cost API calls)", ex.status === 429 && A.calls.player === 0, ex);
    const add = await call({ action: "profile_add", tag: "2PPLYQ2C", device: dev() }, freshIp());
    ok("counter down: adding players is refused", add.status === 429 && db.T.profiles.length === 1, add);
    const g = await call({ action: "goal_add", tag: "8YRJ090Q2", device: D, kind: "player", target: 5 }, freshIp());
    ok("counter down: goals still work on a known device (no API cost)", g.ok, g);
    ok("counter failures are counted", db.T.usage_counters.some((x) => x.key === "limit_error:closed") && db.T.usage_counters.some((x) => x.key === "limit_error:open"));
  }
  // ---- which way people come to tracking (Explore or the home screen) ----
  {
    const A = api();
    const { db, call } = load(FILE, { fetch: A.fetch });
    const n1 = await call({ action: "profile_add", tag: "2PPLYQ2C", device: dev(), from: "explore" }, freshIp());
    const s1 = await call({ action: "profile_add", tag: "2PPLYQ2C", device: dev() }, freshIp());
    const n2 = await call({ action: "profile_add", tag: "9GQRUJ2Y", device: dev(), from: "<script>" }, freshIp());
    const u = Object.fromEntries(db.T.usage_counters.map((x) => [x.key, x.n]));
    ok("adds are counted by where they started, nothing else (unknown sources count as home)", n1.created && s1.exists && n2.created && u["track:new:explore"] === 1 && u["track:save:home"] === 1 && u["track:new:home"] === 1 && !Object.keys(u).some((k) => /2PPLYQ2C|9GQRUJ2Y|script/.test(k)), u);
  }
  // ---- two adds at the same moment can't both take the last spot ----
  {
    const A = api();
    const { db, call } = load(FILE, { fetch: A.fetch });
    for (let i = 0; i < 49; i++) db.T.profiles.push({ tag: "FILL" + i, active: true, keep: false });
    A.st.slow = 20;
    const D1 = dev(), D2 = dev();
    const [a, b] = await Promise.all([
      call({ action: "profile_add", tag: "2PPLYQ2C", device: D1 }, freshIp()),
      call({ action: "profile_add", tag: "9GQRUJ2Y", device: D2 }, freshIp()),
    ]);
    ok("two devices racing for the last spot: one gets it, the other is told it's full", db.T.profiles.filter((p) => p.active).length === 50 && [a, b].filter((x) => x.created).length === 1 && [a, b].filter((x) => x.error === "full").length === 1, [a.error || a.created, b.error || b.created]);
    const D3 = dev();
    const { db: dbP, call: callP } = load(FILE, { fetch: A.fetch });
    const [x, y, z] = await Promise.all(["2PPLYQ2C", "9GQRUJ2Y", "8QJ0P2LG"].map((t) => callP({ action: "profile_add", tag: t, device: D3 }, freshIp())));
    ok("one device adding 3 at once ends up with 2", dbP.T.profile_adders.length === 2 && [x, y, z].filter((r) => r.error === "phone_full").length === 1 && [x, y, z].filter((r) => r.created).length === 2, [x, y, z].map((r) => r.error || r.created));
  }
  console.log(fails ? `${fails} of ${n} FAILED` : `all ${n} passed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log("CRASH", e); process.exit(1); });
