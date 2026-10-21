// Verify response lifetime and concurrent reads without wall-clock performance assertions.
const assert = require('node:assert/strict');
const { load } = require('./fn_harness');
const FILE = process.argv[2];
(async () => {
  let finishCounter, captured, counterStarted = false;
  const pending = new Promise(resolve => { finishCounter = resolve; });
  const app = load(FILE, { edgeRuntime: { waitUntil: task => { captured = task; } } });
  const rpc = app.db.client.rpc;
  app.db.client.rpc = (name, args) => {
    if (name === 'count_usage') { counterStarted = true; return pending.then(() => rpc(name, args)); }
    return rpc(name, args);
  };
  let lookupStarted = false, profileStarted = false, release;
  const both = new Promise(resolve => { release = resolve; });
  const from = app.db.client.from;
  app.db.client.from = table => {
    const q = from(table), then = q.then.bind(q);
    if (table === 'explore_cache' || table === 'profiles') q.then = (resolve, reject) => {
      if (table === 'explore_cache') lookupStarted = true; else profileStarted = true;
      if (lookupStarted && profileStarted) release();
      both.then(() => then(resolve, reject), reject);
    };
    return q;
  };
  const request = new Request('https://x.test/functions/v1/brawl', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'explore_player', tag: '8YRJ090Q2' }) });
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Response blocked on independent reads or usage counter')), 3000); });
  const response = await Promise.race([app.handler(request), timeout]); clearTimeout(timer);
  assert.equal(response.status, 200);
  assert(lookupStarted && profileStarted, 'lookup/profile work both started before either finished');
  assert(counterStarted && captured, 'counter registered with waitUntil');
  assert.match(response.headers.get('Server-Timing'), /rate;dur=\d/);
  assert.match(response.headers.get('Server-Timing'), /lookup;dur=\d/);
  assert.match(response.headers.get('Server-Timing'), /profile;dur=\d/);
  assert.equal(response.headers.get('Access-Control-Expose-Headers'), 'Server-Timing');
  finishCounter(); await captured;
  assert(app.db.T.usage_counters.length > 0, 'background counter still saved');
  console.log('PASS: parallel lookup/profile reads, nonblocking retained counter, three stage timings and exposed header');
})().catch(e => { console.error(e); process.exitCode = 1; });
