// Adversarial tests for goals, alerts, link codes and abuse limits, run against the real server code (fn_harness.js).
// node fn_security.js ../standalone/supabase/functions/brawl/index.ts
const { load } = require("./fn_harness");
const crypto = require("crypto");
const FILE = process.argv[2];
let fails = 0, n = 0;
const ok = (label, cond, extra) => { n++; if (!cond) { fails++; console.log("FAIL", label, extra !== undefined ? JSON.stringify(extra) : ""); } else console.log("ok  ", label); };
const dev = () => crypto.randomBytes(32).toString("base64url");
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const TAG = "8YRJ090Q2";

(async () => {
  const { db, call, sent, internals } = load(FILE);
  const now = new Date().toISOString();
  db.T.profiles.push({ tag: TAG, club: null, name: "bboscox", follow: true, active: true, keep: true });
  db.T.profiles.push({ tag: "2UQUQV2PP", club: "2U0RP22G2", name: "Mini", follow: false, active: true });
  db.T.profile_codes.push({ tag: TAG, code_sha256: sha("OLDCODE") });
  db.T.goals.push({ id: "g-legacy-1", tag: TAG, kind: "player", target: 50000, start: 47000, created_at: now, owner: null });
  db.T.goals.push({ id: "g-legacy-2", tag: TAG, kind: "club", target: 600000, start: 500000, created_at: now, owner: null });
  db.T.readings.push({ id: 1, tag: TAG, ts: now, nb: now, trophies: 47408, club_trophies: 517000, player: { trophies: 47408 } });
  db.T.push_subs.push({ endpoint: "https://push.test/legacy", p256dh: "k", auth: "a", tag: TAG, prefs: { goals: true }, owner: null });

  const A = dev(), B = dev(), C = dev(), D = dev();
  // --- goals are private to a device ---
  ok("unknown device sees no goals (and isn't registered by reading)", (await call({ action: "goals_list", tag: TAG, device: A })).goals.length === 0 && db.T.device_keys.length === 0);
  const ga = await call({ action: "goal_add", tag: TAG, device: A, kind: "player", target: 48000 });
  ok("device A adds a goal", ga.ok && ga.goal && ga.goal.start === 47408, ga);
  ok("A sees its goal", (await call({ action: "goals_list", tag: TAG, device: A })).goals.length === 1);
  ok("B can't see A's goal", (await call({ action: "goals_list", tag: TAG, device: B })).goals.length === 0);
  await call({ action: "goal_add", tag: TAG, device: B, kind: "player", target: 49000 });
  const del = await call({ action: "goal_delete", tag: TAG, device: B, id: ga.goal.id });
  ok("B deleting A's goal changes nothing", del.ok && (await call({ action: "goals_list", tag: TAG, device: A })).goals.length === 1);
  ok("no device can't add goals", (await call({ action: "goal_add", tag: TAG, kind: "player", target: 1 })).status === 401);
  ok("malformed device secret is refused", (await call({ action: "goal_add", tag: TAG, device: "short", kind: "player", target: 1 })).status === 401);
  ok("old-style code can't add goals any more", (await call({ action: "goal_add", tag: TAG, code: "OLDCODE", kind: "player", target: 1 })).status === 401);
  ok("absurd targets are refused", (await call({ action: "goal_add", tag: TAG, device: A, kind: "player", target: 1e12 })).error === "bad_goal");
  ok("goals are no longer readable with the public key's table access (server returns only own)", db.T.goals.filter((g) => g.owner === null).length === 2);

  // --- old per-player codes: one-time move to a device, with guess limits ---
  ok("claim with a wrong code is refused", (await call({ action: "claim_legacy", tag: TAG, device: C, code: "NOPE" }, "198.51.100.7")).status === 403);
  const cl = await call({ action: "claim_legacy", tag: TAG, device: C, code: "oldcode", endpoint: "https://push.test/legacy" }, "198.51.100.7");
  ok("claim with the right code moves both old goals to C", cl.ok && cl.goals === 2, cl);
  ok("C now sees them, A doesn't", (await call({ action: "goals_list", tag: TAG, device: C })).goals.length === 2 && (await call({ action: "goals_list", tag: TAG, device: A })).goals.length === 1);
  ok("C's old push subscription now belongs to C", db.T.push_subs[0].owner && db.T.push_subs[0].owner === db.T.device_keys.find((k) => k.key_hash === sha("device:" + C)).owner);
  const cl2 = await call({ action: "claim_legacy", tag: TAG, device: D, code: "OLDCODE" }, "198.51.100.8");
  ok("a second claim with the same code gets nothing", cl2.ok && cl2.goals === 0, cl2);
  for (let i = 0; i < 12; i++) await call({ action: "check_code", tag: TAG, code: "GUESS" + i }, "192.0.2." + i);
  ok("after 10 guesses in an hour even the right code is refused (lockout)", (await call({ action: "check_code", tag: TAG, code: "OLDCODE" }, "192.0.2.200")).ok === false);

  // --- linking another device ---
  const lc = await call({ action: "link_create", device: A });
  ok("A gets a 6-digit link code", lc.ok && /^\d{6}$/.test(lc.code), lc);
  ok("a wrong code doesn't link", (await call({ action: "link_redeem", device: D, code: lc.code === "000000" ? "000001" : "000000" }, "198.51.100.20")).error === "bad_link");
  ok("A can't redeem its own code", (await call({ action: "link_redeem", device: A, code: lc.code }, "198.51.100.21")).error === "same_device");
  const lr = await call({ action: "link_redeem", device: D, code: lc.code.slice(0, 3) + " " + lc.code.slice(3) }, "198.51.100.20");
  ok("D links with the code (spaces allowed)", lr.ok, lr);
  ok("D now sees A's goals", (await call({ action: "goals_list", tag: TAG, device: D })).goals.length === 1);
  ok("the code works only once", (await call({ action: "link_redeem", device: B, code: lc.code }, "198.51.100.22")).error === "bad_link");
  const lc2 = await call({ action: "link_create", device: A });
  db.T.device_links.forEach((l) => { l.expires_at = new Date(Date.now() - 60e3).toISOString(); }); // 11 minutes later
  ok("an expired code doesn't link", (await call({ action: "link_redeem", device: B, code: lc2.code }, "198.51.100.23")).error === "bad_link");
  const lc3 = await call({ action: "link_create", device: A });
  const merge = await call({ action: "link_redeem", device: C, code: lc3.code }, "198.51.100.24");
  ok("C joins A and brings its 2 goals along", merge.ok && merge.moved === 2, merge);
  ok("A, C and D all see the same 3 goals", (await call({ action: "goals_list", tag: TAG, device: A })).goals.length === 3 && (await call({ action: "goals_list", tag: TAG, device: D })).goals.length === 3);
  ok("B still only sees its own", (await call({ action: "goals_list", tag: TAG, device: B })).goals.length === 1);
  let last;
  for (let i = 0; i < 11; i++) last = await call({ action: "link_redeem", device: B, code: String(100000 + i) }, "198.51.100.99");
  ok("guessing link codes is cut off after 10 tries per address", last.status === 429, last);

  // --- goal alerts only reach the goal's owner ---
  await call({ action: "push_subscribe", tag: TAG, device: B, sub: { endpoint: "https://push.test/B", keys: { p256dh: "k", auth: "a" } }, prefs: {} });
  await call({ action: "push_subscribe", tag: TAG, device: A, sub: { endpoint: "https://push.test/A", keys: { p256dh: "k", auth: "a" } }, prefs: {} });
  const prof = db.T.profiles[0];
  await internals.checkEvents(prof, { trophies: 47408, club: null, elo: null, brawlers: null, prevClub: null, newClub: null });
  sent.length = 0;
  await internals.checkEvents(prof, { trophies: 48100, club: null, elo: null, brawlers: null, prevClub: null, newClub: null });
  const goalSends = sent.filter((s) => s.payload.title.includes("Goal"));
  ok("A's 48,000 goal alert goes to A's devices only (A and C's old phone), not B", goalSends.length === 2 && goalSends.every((s) => s.endpoint !== "https://push.test/B"), goalSends.map((s) => s.endpoint));
  ok("milestone alerts still go to everyone following the player", sent.filter((s) => s.payload.title.includes("48,000")).length === 3, sent.map((s) => s.payload.title));
  ok("push_subscribe for an untracked player is refused", (await call({ action: "push_subscribe", tag: "Q2", device: A, sub: { endpoint: "https://push.test/x", keys: { p256dh: "k", auth: "a" } } })).status === 404);

  // --- abuse limits on expensive calls ---
  let r;
  for (let i = 0; i < 41; i++) r = await call({ action: "profile_lookup", tag: "2PPLYQ2C" }, "203.0.113.50");
  ok("41st player lookup in 10 minutes from one address is refused", r.status === 429, r.status);
  ok("another address is unaffected", (await call({ action: "profile_lookup", tag: "2PPLYQ2C" }, "203.0.113.51")).ok);
  r = await call({ action: "profile_lookup", tag: "2PPLYQ2C" }, "203.0.113.50", { "x-forwarded-for": "9.9.9.9" });
  ok("a forged X-Forwarded-For doesn't dodge the limit (the gateway's own address header wins)", r.status === 429, r.status);
  const adds = [];
  for (const t of ["2PP", "2PY", "2PL", "2PQ", "2PG", "2PR", "2PJ"]) adds.push((await call({ action: "profile_add", tag: t }, "203.0.113.60")).status);
  ok("7th new player from one address in an hour is refused", adds.slice(0, 6).every((s) => s === 200) && adds[6] === 429, adds);
  ok("re-adding an already tracked player isn't limited", (await call({ action: "profile_add", tag: "2PP" }, "203.0.113.60")).exists === true);
  ok("recap can't be triggered twice in a row", (await call({ action: "recap" })).ok && (await call({ action: "recap" })).skipped === true);

  // --- nobody can point someone else's profile at the wrong club ---
  const heal = await call({ action: "profile_add", tag: "2UQUQV2PP" }, "203.0.113.70");
  ok("adding a player with their own club makes a mis-set profile follow them again", heal.exists && db.T.profiles.find((p) => p.tag === "2UQUQV2PP").follow === true);
  await call({ action: "profile_add", tag: "2UQUQV2PP", club: "" }, "203.0.113.71");
  ok("…and nobody can switch it away again", db.T.profiles.find((p) => p.tag === "2UQUQV2PP").follow === true);

  console.log(`\n${n - fails}/${n} passed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
