// Handler regressions. RPC behavior here is a stub; db_link.js tests the real SQL.
const { load, pushKeys } = require('./fn_harness');
const { randomBytes, createHash } = require('crypto');
const assert = require('node:assert/strict');
const FILE = process.argv[2];
const dev = () => randomBytes(32).toString('base64url');
const hash = s => createHash('sha256').update(s).digest('hex');
let n = 0;
const check = (label, condition) => { assert.ok(condition, label); console.log('ok  ', label); n++; };
(async () => {
  const { db, call, sent, internals } = load(FILE);
  const tag = '8YRJ090Q2', a = dev(), b = dev(), c = dev();
  db.T.profiles.push({ tag, active: true, follow: true });
  await call({ action: 'goal_add', tag, device: a, kind: 'player', target: 5000 });
  const link = await call({ action: 'link_create', device: a });
  const results = await Promise.all([b, c].map((device, i) => call({ action: 'link_redeem', device, code: link.code }, '198.51.100.' + i)));
  check('simultaneous redeemers: one success, one bad_link', results.filter(r => r.ok).length === 1 && results.filter(r => r.error === 'bad_link').length === 1);
  const loser = results[0].ok ? c : b;
  check('losing redeemer cannot read the original goal', (await call({ action: 'goals_list', tag, device: loser })).goals.length === 0);
  const retry = await call({ action: 'link_create', device: a });
  db.fail.redeem_device_link = true;
  check('database failure fails closed', !(await call({ action: 'link_redeem', device: loser, code: retry.code }, '198.51.100.9')).ok);
  check('database failure leaves code and owner intact', db.T.device_links.some(x => x.code_hash === hash('link:' + retry.code)) && !db.T.device_keys.some(x => x.key_hash === hash('device:' + loser)));
  db.fail.redeem_device_link = false;
  check('retry after database recovery succeeds', (await call({ action: 'link_redeem', device: loser, code: retry.code }, '198.51.100.9')).ok);
  const previous = await call({ action: 'link_create', device: a });
  db.fail.create_device_link = true;
  check('failed code issuance fails closed', !(await call({ action: 'link_create', device: a })).ok);
  check('failed code issuance preserves the previous code', db.T.device_links.some(x => x.code_hash === hash('link:' + previous.code)));
  db.fail.create_device_link = false;
  const originalRpc = db.client.rpc;
  let collisions = 0;
  db.client.rpc = (name, args) => {
    if (name === 'create_device_link' && collisions++ === 0) return Promise.resolve({ data: null, error: { code: '23505' } });
    return originalRpc(name, args);
  };
  check('code collision retries issuance successfully', (await call({ action: 'link_create', device: a })).ok && collisions === 2);
  db.client.rpc = originalRpc;

  // Pause at the new issuance boundary, after ownerOf read the original owner.
  // Merge through the real handler before allowing issuance to reach the RPC.
  // SQL-level lock ordering is covered separately by db_link.js.
  const race = load(FILE), issuer = dev(), joining = dev(), recipient = dev();
  race.db.T.profiles.push({ tag, active: true, follow: true });
  await race.call({ action: 'goal_add', tag, device: issuer, kind: 'player', target: 5000 });
  await race.call({ action: 'goal_add', tag, device: joining, kind: 'player', target: 6000 });
  const mergeLink = await race.call({ action: 'link_create', device: issuer });
  const raceRpc = race.db.client.rpc;
  let mergedDuringIssuance = false;
  race.db.client.rpc = async (name, args) => {
    if (name === 'create_device_link' && !mergedDuringIssuance) {
      mergedDuringIssuance = true;
      assert.ok((await race.call({ action: 'link_redeem', device: joining, code: mergeLink.code }, '198.51.100.101')).ok);
    }
    return raceRpc(name, args);
  };
  const issuedAfterMerge = await race.call({ action: 'link_create', device: joining });
  check('issuance resolves ownership after a concurrent merge', mergedDuringIssuance && issuedAfterMerge.ok);
  const third = await race.call({ action: 'link_redeem', device: recipient, code: issuedAfterMerge.code }, '198.51.100.102');
  check('code issued during a merge links to the merged goals', third.ok && (await race.call({ action: 'goals_list', tag, device: recipient })).goals.length === 2);

  const keys = pushKeys();
  const endpoints = ['https://example.com/x', 'https://127.0.0.1/x', 'https://169.254.169.254/latest/meta-data', 'https://[::1]/x', 'http://fcm.googleapis.com/x', 'https://fcm.googleapis.com.evil.test/x', 'https://user:pass@fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'https://fcm.googleapis.com/x#fragment', 'https://fcm.googleapis.com/'];
  for (const endpoint of endpoints) {
    const r = await call({ action: 'push_subscribe', tag, device: a, sub: { endpoint, keys } });
    check('reject unsafe endpoint ' + endpoint, !r.ok);
  }
  for (const host of ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com', 'wns2-par02p.notify.windows.com']) {
    const r = await call({ action: 'push_subscribe', tag, device: a, sub: { endpoint: 'https://' + host + '/test-token', keys } });
    check('accept supported provider ' + host, r.ok);
  }
  for (const invalid of [{ ...keys, p256dh: 'bad' }, { ...keys, auth: 'bad' }, { ...keys, p256dh: Buffer.alloc(65).toString('base64url') }]) {
    check('reject malformed subscription key', !(await call({ action: 'push_subscribe', tag, device: a, sub: { endpoint: 'https://fcm.googleapis.com/token', keys: invalid } })).ok);
  }
  const owner = db.T.device_keys.find(k => k.key_hash === hash('device:' + a)).owner;
  db.T.push_subs.push({ endpoint: 'https://127.0.0.1/old-sub', ...keys, owner, tag, prefs: { goals: true } });
  await internals.checkEvents(db.T.profiles[0], { trophies: 4900, club: null, elo: null, brawlers: null, prevClub: null, newClub: null });
  await internals.checkEvents(db.T.profiles[0], { trophies: 5100, club: null, elo: null, brawlers: null, prevClub: null, newClub: null });
  check('legacy unsafe subscriptions never reach the push transport', !sent.some(s => s.endpoint.includes('127.0.0.1')));
  check('valid subscriptions still receive goal notifications', sent.some(s => s.payload.title.includes('Goal')));
  console.log(`All ${n} audit regression checks passed`);
})().catch(e => { console.error(e); process.exitCode = 1; });
