// Player limits (50 in the app, 2 started per device, releasing, pausing) and the thinning of old readings,
// run against the real server code (fn_harness.js).
// node fn_limits.js ../standalone/supabase/functions/brawl/index.ts
const { load } = require("./fn_harness");
const crypto = require("crypto");
const FILE = process.argv[2];
let fails = 0, n = 0;
const ok = (label, cond, extra) => { n++; if (!cond) { fails++; console.log("FAIL", label, extra !== undefined ? JSON.stringify(extra) : ""); } else console.log("ok  ", label); };
const dev = () => crypto.randomBytes(32).toString("base64url");
const TAGS = ["2PPLYQ2C", "8QJ0P2LG", "9GQRUJ2Y", "YLQ2C0P8", "RJ2CGV9L", "C0UVPYQ2", "G9LQ2R8J"];
let ipN = 1; const freshIp = () => "198.51.100." + ipN++; // separate networks, so the add limit (6 an hour) doesn't get in the way

async function limits() {
  const { db, call } = load(FILE);
  db.T.profiles.push({ tag: "8YRJ090Q2", club: null, name: "bboscox", follow: true, active: true, keep: true });
  const A = dev(), B = dev(), C = dev();
  const add = (device, tag, ip = freshIp()) => call({ action: "profile_add", tag, device }, ip);
  const rel = (device, tag) => call({ action: "profile_release", tag, device }, freshIp());
  const active = (tag) => db.T.profiles.find((p) => p.tag === tag)?.active;

  ok("adding without a device is refused", (await call({ action: "profile_add", tag: TAGS[0] })).status === 401);
  ok("device A starts player 1", (await add(A, TAGS[0])).created === true);
  ok("device A starts player 2", (await add(A, TAGS[1])).created === true);
  const third = await add(A, TAGS[2]);
  ok("device A's third new player is refused (phone_full)", third.status === 409 && third.error === "phone_full", third);
  ok("...and the answer names the 2 it holds", JSON.stringify((third.held || []).sort()) === JSON.stringify([TAGS[0], TAGS[1]].sort()), third.held);
  ok("...and nothing was created", !db.T.profiles.some((p) => p.tag === TAGS[2]));
  ok("device A can still save a player someone else tracks", (await add(A, "8YRJ090Q2")).exists === true);
  const bSave = await add(B, TAGS[0]);
  ok("device B saving A's player doesn't use B's spots", bSave.exists === true && !db.T.profile_adders.some((r) => r.tag === TAGS[0] && r.owner !== db.T.profile_adders[0].owner));

  // Linked devices share one owner, so they share the 2 spots.
  const ownerA = db.T.device_keys[0].owner, A2 = dev();
  db.T.device_keys.push({ key_hash: crypto.createHash("sha256").update("device:" + A2).digest("hex"), owner: ownerA, created_at: new Date().toISOString(), last_seen_at: new Date().toISOString() });
  ok("a device linked to A shares A's limit", (await add(A2, TAGS[2])).error === "phone_full");

  ok("releasing a player A didn't start does nothing", (await rel(A, "8YRJ090Q2")).released === false && active("8YRJ090Q2") === true);
  const r1 = await rel(A, TAGS[0]);
  ok("A releasing player 1 frees the spot and pauses it (nobody else started it)", r1.released && r1.paused && active(TAGS[0]) === false, r1);
  ok("A can now start another player", (await add(A, TAGS[2])).created === true);
  ok("releasing twice is harmless", (await rel(A, TAGS[0])).released === false);

  // Opening a paused player wakes it while there's room.
  await call({ action: "refresh", tag: TAGS[0], src: "live", device: B }, freshIp());
  ok("opening paused player 1 wakes it (room in the app)", active(TAGS[0]) === true);

  // A paused player started again through the add form counts as that device's.
  await rel(A, TAGS[1]);
  ok("player 2 paused after release", active(TAGS[1]) === false);
  const cWake = await add(C, TAGS[1]);
  ok("device C re-adding paused player 2 wakes it and holds it", cWake.exists && active(TAGS[1]) === true && db.T.profile_adders.some((r) => r.tag === TAGS[1]), cWake);
  ok("a kept profile never pauses on release", (await rel(C, "8YRJ090Q2")).released === false && active("8YRJ090Q2"));

  // The app-wide cap.
  for (let i = db.T.profiles.filter((p) => p.active).length; i < 50; i++) db.T.profiles.push({ tag: "FILL" + i, active: true, keep: false });
  const full = await add(B, TAGS[3]);
  ok("with 50 active players a new one is refused (full)", full.status === 409 && full.error === "full", full);
  await rel(C, TAGS[1]); // pauses player 2 (now 49 active)
  db.T.profiles.push({ tag: "FILLX", active: true, keep: false }); // back to 50
  await call({ action: "refresh", tag: TAGS[1], src: "live", device: B }, freshIp());
  ok("opening a paused player when the app is full doesn't wake it", active(TAGS[1]) === false);
  const fullWake = await add(B, TAGS[1]);
  ok("re-adding a paused player when the app is full is refused", fullWake.error === "full", fullWake);
}

// ---------- thinning ----------
// A random but realistic history: full club lists now and then, mostly member changes, brawler changes, some
// readings without player stats. The app's own way of adding readings up (derive in index.html) is copied here.
function applyClient(base, c) {
  if (!c || !c.d) return c;
  if (!base) return null;
  const upd = new Map((c.upd || []).map((u) => [u[0], u[1]]));
  return Object.assign({}, base, { trophies: c.trophies, members: base.members.map((m) => (upd.has(m[0]) ? [m[0], m[1], m[2], upd.get(m[0]), m[4]] : m)) });
}
function replay(rows) {
  const rs = rows.slice().sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts) || a.id - b.id);
  let B = null, C = null, P = null, T = null;
  for (const r of rs) {
    if (r.brawlers) B = Object.assign({}, B, r.brawlers);
    if (r.club || r.club_upd) C = applyClient(C, r.club || r.club_upd);
    if (r.player && (!P || Date.parse(r.nb) >= Date.parse(P.nb))) P = { nb: r.nb, p: r.player, t: r.trophies };
    if (r.club_trophies != null) T = r.club_trophies;
  }
  return JSON.stringify({ B, C, P, T });
}
function history(tag, days, perDay, seed) {
  let s = seed; const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const members = Array.from({ length: 27 }, (_, i) => ["M" + i, "Name" + i, "member", 20000 + i * 100, 28000000 + i]);
  const rows = []; let id = 1000 + seed * 10000, trophies = 40000, nb = Date.now() - (days + 35) * 86400e3;
  const fullClub = () => ({ name: "Club", tag: "CLUB", trophies: members.reduce((a, m) => a + m[3], 0), members: members.map((m) => m.slice()), src: "official" });
  for (let d = 0; d < days; d++) {
    for (let k = 0; k < perDay; k++) {
      const ts = new Date(Date.now() - (days + 33 - d) * 86400e3 + k * (20 * 3600e3 / perDay)).toISOString();
      const r = { id: id++, tag, ts, src: "auto" };
      const x = rnd();
      if (x < 0.85) { nb += 600e3; trophies += Math.round(rnd() * 20 - 8); Object.assign(r, { nb: new Date(nb).toISOString(), trophies, player: { trophies, name: "P" } }); }
      if (rnd() < 0.3) r.brawlers = { ["B" + Math.floor(rnd() * 9)]: [Math.round(rnd() * 1000), 1000, 11, "X", 0, 0, 0, 1] };
      const y = rnd();
      if (y < 0.08 || (d === 0 && k === 0)) { if (rnd() < 0.5) members[Math.floor(rnd() * 27)][2] = "senior"; r.club = fullClub(); }
      else if (y < 0.7) {
        const upd = []; for (let j = 0; j < 3; j++) { const m = members[Math.floor(rnd() * 27)]; m[3] += Math.round(rnd() * 30); upd.push([m[0], m[3]]); }
        r.club_upd = { d: 1, trophies: members.reduce((a, m) => a + m[3], 0), upd };
      }
      if (r.club || r.club_upd) r.club_trophies = members.reduce((a, m) => a + m[3], 0);
      rows.push(r);
    }
  }
  return rows;
}
const dayKey = (t) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));

async function thinning() {
  const { db, internals } = load(FILE);
  const tags = ["8YRJ090Q2", "2UQUQV2PP", "9GQRUJ2Y"];
  const orig = {};
  tags.forEach((t, i) => { db.T.profiles.push({ tag: t, active: true }); const h = history(t, 6, 60 + i * 20, i + 1); orig[t] = h; db.T.readings.push(...h.map((r) => structuredClone(r))); });
  // Recent readings (inside the 30 days) must not be touched.
  db.T.readings.push({ id: 1, tag: tags[0], ts: new Date(Date.now() - 5 * 86400e3).toISOString(), trophies: 1, player: { trophies: 1 }, nb: new Date(Date.now() - 5 * 86400e3).toISOString() });
  db.T.readings.push({ id: 2, tag: tags[0], ts: new Date(Date.now() - 4 * 86400e3).toISOString(), trophies: 2, player: { trophies: 2 }, nb: new Date(Date.now() - 4 * 86400e3).toISOString() });
  const before = db.T.readings.length;
  const res = await internals.thinReadings(1000);
  const after = db.T.readings.length;
  ok("thinning folds whole days and removes the rest", res.removed === before - after && res.removed > 0, res);
  for (const t of tags) {
    const mine = db.T.readings.filter((r) => r.tag === t && r.id >= 1000);
    const byDay = new Map(); for (const r of orig[t]) byDay.set(dayKey(r.ts), (byDay.get(dayKey(r.ts)) || []).concat([r]));
    ok(t + ": one reading left per old day (plus the very first reading)", mine.length === byDay.size + 1 && mine.some((r) => r.id === orig[t][0].id), { left: mine.length, days: byDay.size });
    let same = true, sameEnd = true;
    for (const [k] of byDay) {
      const upto = (rows) => rows.filter((r) => dayKey(r.ts) <= k);
      if (replay(upto(orig[t])) !== replay(upto(mine))) same = false;
    }
    ok(t + ": end-of-day state identical for every folded day (brawlers, club list, player, club total)", same);
    ok(t + ": final state identical", replay(orig[t]) === replay(mine) && sameEnd);
    const sizeBefore = JSON.stringify(orig[t]).length, sizeAfter = JSON.stringify(mine).length;
    console.log("     ", t, "rows", orig[t].length, "->", mine.length, " bytes", sizeBefore, "->", sizeAfter, "(" + Math.round(100 - (100 * sizeAfter) / sizeBefore) + "% smaller)");
  }
  ok("readings inside 30 days untouched", db.T.readings.some((r) => r.id === 1) && db.T.readings.some((r) => r.id === 2));
  const again = await internals.thinReadings(1000);
  ok("running again changes nothing", again.removed === 0 && again.days === 0 && db.T.readings.length === after, again);

  // A fold that stops after updating the kept reading but before deleting the others gives the same state.
  const h = history("CRASH", 1, 50, 9);
  const day = h.slice(); const keep = day[day.length - 1];
  const half = day.slice(0, -1).concat([Object.assign({}, keep, internals.foldDay(day))]);
  ok("a fold interrupted halfway still adds up to the same state", replay(half) === replay(h));

  // Budget: a run stops after the given number of days.
  const { db: db2, internals: in2 } = load(FILE);
  db2.T.profiles.push({ tag: "8YRJ090Q2", active: true });
  db2.T.readings.push(...history("8YRJ090Q2", 5, 30, 4));
  const part = await in2.thinReadings(2);
  ok("a run folds at most its budget of days", part.days === 2, part);
  const rest = await in2.thinReadings(100);
  const nDays = new Set(history("8YRJ090Q2", 5, 30, 4).map((r) => dayKey(r.ts))).size;
  ok("the next run carries on where it stopped (one reading per day left, plus the first)", rest.days > 0 && db2.T.readings.length === nDays + 1, { rest, nDays, left: db2.T.readings.length });
}

(async () => {
  await limits();
  await thinning();
  console.log(fails ? `${fails} of ${n} FAILED` : `all ${n} passed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log("CRASH", e); process.exit(1); });
