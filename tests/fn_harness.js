// Runs the real server function (supabase/functions/brawl/index.ts) in Node against an in-memory database,
// a fake game API and a fake push service. Used by fn_security.js for the ownership and abuse tests.
const fs = require("fs");
const { transformSync } = require("esbuild");
const crypto = require("crypto");

function makeDb() {
  const T = { profiles: [], profile_codes: [], readings: [], battles: [], goals: [], sessions: [], settings: [], push_subs: [], device_keys: [], device_links: [], rate_hits: [], profile_adders: [], explore_cache: [], usage_counters: [] };
  const PK = { profiles: ["tag"], profile_codes: ["tag"], settings: ["key"], push_subs: ["endpoint", "tag"], device_keys: ["key_hash"], device_links: ["code_hash"], profile_adders: ["owner", "tag"], explore_cache: ["key"], usage_counters: ["key", "hour"], goals: ["id"], battles: ["tag", "t"] };
  const clock = { now: () => Date.now() };
  const cmp = (a, b) => (a == null && b == null ? 0 : a == null ? -1 : b == null ? 1 : a < b ? -1 : a > b ? 1 : 0);
  const val = (v) => (typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) ? Date.parse(v) : v);
  class Q {
    constructor(table) { this.t = table; this.f = []; this.op = "select"; this.ord = []; this.lim = null; this.one = null; this.opts = {}; this.ret = false; }
    select(cols, opts) { if (this.op === "select") this.opts = opts || {}; else this.ret = true; return this; }
    insert(rows) { this.op = "insert"; this.rows = [].concat(rows); return this; }
    update(v, opts) { this.op = "update"; this.vals = v; this.opts = opts || {}; return this; }
    upsert(rows, opts) { this.op = "upsert"; this.rows = [].concat(rows); this.conflict = (opts && opts.onConflict ? opts.onConflict.split(",") : PK[this.t]); return this; }
    delete() { this.op = "delete"; return this; }
    eq(c, v) { this.f.push((r) => r[c] === v || (r[c] != null && v != null && String(r[c]) === String(v))); return this; }
    neq(c, v) { this.f.push((r) => r[c] !== v); return this; }
    is(c, v) { this.f.push((r) => (r[c] ?? null) === v); return this; }
    gt(c, v) { this.f.push((r) => cmp(val(r[c]), val(v)) > 0); return this; }
    gte(c, v) { this.f.push((r) => cmp(val(r[c]), val(v)) >= 0); return this; }
    lt(c, v) { this.f.push((r) => cmp(val(r[c]), val(v)) < 0); return this; }
    lte(c, v) { this.f.push((r) => cmp(val(r[c]), val(v)) <= 0); return this; }
    not(c, op, v) { if (op === "is") this.f.push((r) => (r[c] ?? null) !== v); return this; }
    in(c, arr) { this.f.push((r) => arr.includes(r[c])); return this; }
    or() { return this; }
    filter() { return this; }
    order(c, o) { this.ord.push([c, !o || o.ascending !== false]); return this; }
    limit(n) { this.lim = n; return this; }
    range(a, b) { this.rng = [a, b]; return this; }
    maybeSingle() { this.one = "maybe"; return this; }
    single() { this.one = "single"; return this; }
    then(res, rej) { try { res(this.run()); } catch (e) { rej(e); } }
    run() {
      const rows = T[this.t];
      if (!rows) throw new Error("no table " + this.t);
      const match = (r) => this.f.every((fn) => fn(r));
      if (this.op === "insert" || this.op === "upsert") {
        const out = [];
        for (const raw of this.rows) {
          const r = { ...raw };
          if (this.t === "goals" && !r.id) { r.id = crypto.randomUUID(); r.created_at = r.created_at || new Date(clock.now()).toISOString(); }
          if (this.t === "profiles" && this.op === "insert") { r.active ??= true; r.keep ??= false; r.follow ??= true; r.created_at ??= new Date(clock.now()).toISOString(); r.last_open_at ??= r.created_at; }
          if (this.t === "device_keys") { r.created_at ??= new Date(clock.now()).toISOString(); r.last_seen_at ??= r.created_at; }
          const key = this.op === "upsert" ? this.conflict : PK[this.t];
          const hit = key ? rows.find((x) => key.every((k) => x[k] === r[k])) : null;
          if (hit) {
            if (this.op === "insert") return { data: null, error: { code: "23505", message: "duplicate key" } };
            Object.assign(hit, r); out.push(hit);
          } else { rows.push(r); out.push(r); }
        }
        return this.wrap(out);
      }
      if (this.op === "update") {
        const hits = rows.filter(match);
        for (const r of hits) Object.assign(r, this.vals);
        return { data: this.ret ? hits : null, error: null, count: this.opts.count ? hits.length : null };
      }
      if (this.op === "delete") {
        const keep = rows.filter((r) => !match(r)); const n = rows.length - keep.length;
        T[this.t] = keep; return { data: null, error: null, count: n };
      }
      let out = rows.filter(match);
      for (const [c, asc] of this.ord.slice().reverse()) out = out.slice().sort((a, b) => (asc ? 1 : -1) * cmp(val(a[c]), val(b[c])));
      if (this.rng) out = out.slice(this.rng[0], this.rng[1] + 1);
      if (this.lim != null) out = out.slice(0, this.lim);
      if (this.opts.head) return { data: null, error: null, count: out.length };
      return this.wrap(out.map((r) => ({ ...r })), this.opts.count ? out.length : null);
    }
    wrap(out, count = null) {
      if (this.one === "single") return out.length === 1 ? { data: out[0], error: null } : { data: null, error: { code: "PGRST116", message: "not one row" } };
      if (this.one === "maybe") return { data: out[0] ?? null, error: null };
      return { data: out, error: null, count };
    }
  }
  const fail = { rate_hit: false };
  const rpc = async (name, a) => {
    if (fail[name]) return { data: null, error: { message: "boom" } };
    if (name === "count_usage") {
      const hour = new Date(Math.floor(clock.now() / 3600e3) * 3600e3).toISOString();
      for (const k of a.p_keys) { let r = T.usage_counters.find((x) => x.key === k && x.hour === hour); if (!r) T.usage_counters.push((r = { key: k, hour, n: 0 })); r.n++; }
      return { data: null, error: null };
    }
    if (name === "claim_slot") { // same rules as the SQL function (which runs under a lock: no await in here)
      const cur = T.profiles.find((p) => p.tag === a.p_tag);
      if (cur && cur.active) return { data: { status: "exists" }, error: null };
      if (T.profiles.filter((p) => p.active).length >= a.p_max) return { data: { status: "full" }, error: null };
      if (a.p_owner) {
        const held = T.profile_adders.filter((x) => x.owner === a.p_owner && T.profiles.some((p) => p.tag === x.tag && p.active)).map((x) => x.tag);
        if (held.length >= a.p_per) return { data: { status: "phone_full", held }, error: null };
      }
      if (cur) Object.assign(cur, { active: true, last_open_at: new Date(clock.now()).toISOString() });
      else if (a.p_row) T.profiles.push({ follow: true, ...a.p_row, tag: a.p_tag, active: true, keep: false, created_at: new Date(clock.now()).toISOString(), last_open_at: new Date(clock.now()).toISOString() });
      else return { data: { status: "missing" }, error: null };
      if (a.p_owner && !T.profile_adders.some((x) => x.owner === a.p_owner && x.tag === a.p_tag)) T.profile_adders.push({ owner: a.p_owner, tag: a.p_tag, created_at: new Date(clock.now()).toISOString() });
      return { data: { status: "ok" }, error: null };
    }
    if (name !== "rate_hit") return { data: null, error: { message: "no rpc" } };
    const b = Math.floor(clock.now() / 1000 / Math.max(a.p_window, 1));
    let r = T.rate_hits.find((x) => x.key === a.p_key && x.bucket === b);
    if (!r) { r = { key: a.p_key, bucket: b, n: 0, at: new Date(clock.now()).toISOString() }; T.rate_hits.push(r); }
    r.n++;
    return { data: r.n <= a.p_max, error: null };
  };
  return { T, clock, fail, client: { from: (t) => new Q(t), rpc } };
}

function load(file, { player, fetch: customFetch } = {}) {
  const db = makeDb();
  const sent = [];
  let src = fs.readFileSync(file, "utf8")
    .replace(/^import \{ createClient \} from .*$/m, "const { createClient } = __mock;")
    .replace(/^import webpush from .*$/m, "const webpush = __webpush;");
  const js = transformSync(src + "\nglobalThis.__internals = { checkEvents, notify, thinReadings, foldDay, applyClub };", { loader: "ts", format: "cjs" }).code;
  let handler = null;
  const env = { SUPABASE_URL: "https://x.test", SUPABASE_SERVICE_ROLE_KEY: "svc", BS_API_KEY: "k" };
  const Deno = { env: { get: (k) => env[k] }, serve: (h) => { handler = h; } };
  const webpush = {
    generateVAPIDKeys: () => ({ publicKey: "PUB", privateKey: "PRIV" }),
    setVapidDetails() {},
    sendNotification: async (sub, payload) => { sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) }); },
    generateRequestDetails: () => ({ headers: {}, body: new Uint8Array([1, 2]) }),
  };
  const pl = player || { name: "Tester", tag: "#8YRJ090Q2", trophies: 1000, highestTrophies: 1200, icon: { id: 1 }, club: {}, brawlers: [] };
  const fakeFetch = async (url) => {
    const u = String(url);
    if (u.includes("/players/")) return new Response(JSON.stringify({ ...pl, tag: "#" + decodeURIComponent(u.split("/players/")[1]).replace("#", "") }), { status: 200 });
    if (u.includes("/battlelog")) return new Response(JSON.stringify({ items: [] }), { status: 200 });
    if (u.includes("player.byTag")) return new Response(JSON.stringify({ result: { data: { json: { ...pl, battles: [] } } } }), { status: 200 });
    return new Response("{}", { status: 404 });
  };
  const fastTimeout = (fn) => setImmediate(fn); // the server's deliberate delays would only slow the tests
  new Function("__mock", "__webpush", "Deno", "fetch", "require", "module", "exports", "setTimeout", js)({ createClient: () => db.client }, webpush, Deno, customFetch || fakeFetch, require, { exports: {} }, {}, fastTimeout);
  const call = async (body, ip = "203.0.113.1", headers = {}) => {
    const req = new Request("https://x.test/functions/v1/brawl", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip, "x-forwarded-for": ip, ...headers }, body: JSON.stringify(body) });
    const res = await handler(req);
    return { status: res.status, ...(await res.json()) };
  };
  return { db, call, sent, internals: globalThis.__internals };
}
module.exports = { load };
