// Run only against a disposable LOCAL database named brawl_audit_test.
// PGTEST_PSQL=/path/to/psql PGTEST_PORT=55439 node tests/db_link.js
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const run = promisify(execFile);
const psql = process.env.PGTEST_PSQL || 'psql';
const prefixArgs = JSON.parse(process.env.PGTEST_PSQL_ARGS || '[]');
const port = process.env.PGTEST_PORT || '55439';
async function sql(query) {
  const { stdout } = await run(psql, [...prefixArgs, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', port, '-U', 'postgres', '-d', 'brawl_audit_test', '-c', query], { windowsHide: true });
  return stdout.trim();
}
const A='00000000-0000-4000-8000-000000000001', B='00000000-0000-4000-8000-000000000002';
let n=0;
const ok=(label,value)=>{ assert.ok(value,label); console.log('ok  ',label);n++; };
(async()=>{
  assert.equal(await sql('select current_database()'), 'brawl_audit_test');
  assert.equal(await sql("select count(*) from pg_tables where schemaname='public'"),'0','Use a fresh empty test database');
  await sql(`create role anon; create role authenticated; create role service_role bypassrls;
    create table public.device_keys(key_hash text primary key, owner uuid not null, created_at timestamptz default now(), last_seen_at timestamptz default now());
    create table public.device_links(code_hash text primary key, owner uuid not null, expires_at timestamptz not null, created_at timestamptz default now());
    create table public.goals(id uuid primary key default gen_random_uuid(), tag text, owner uuid, target integer check(target>0));
    create table public.push_subs(endpoint text, tag text, owner uuid, primary key(endpoint,tag));
    create table public.profile_adders(owner uuid not null,tag text not null,created_at timestamptz default now(),primary key(owner,tag));
    alter table public.device_keys enable row level security; alter table public.device_links enable row level security;
    alter table public.goals enable row level security; alter table public.push_subs enable row level security; alter table public.profile_adders enable row level security;
    grant usage on schema public to service_role; grant all on all tables in schema public to service_role;`);
  const migration=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261021090000_redeem_device_link.sql'),'utf8');
  await sql(migration);
  await sql(`insert into device_keys(key_hash,owner) values('issuer','${A}'); insert into goals(tag,owner,target) values('PLAYER','${A}',5000); insert into device_links(code_hash,owner,expires_at) values('race','${A}',now()+interval '10 minutes')`);
  const results=await Promise.all(['recipient1','recipient2'].map(key=>sql(`begin; set local role service_role; select public.redeem_device_link('race','${key}'); select pg_sleep(0.2); commit;`)));
  const answers=results.map(x=>JSON.parse(x.split('\n').find(line=>line.startsWith('{'))));
  ok('actual PostgreSQL concurrent sessions: exactly one winner',answers.filter(x=>x.status==='ok').length===1 && answers.filter(x=>x.status==='bad_link').length===1);
  ok('only the winning device receives the owner',await sql("select count(*) from device_keys where key_hash like 'recipient%' ")==='1');
  ok('consumed link is absent',await sql("select count(*) from device_links where code_hash='race'")==='0');
  await sql(`insert into device_links(code_hash,owner,expires_at) values('self','${A}',now()+interval '10 minutes'),('expired','${A}',now()-interval '1 minute')`);
  ok('same-device code remains usable',JSON.parse(await sql("select redeem_device_link('self','issuer')")).status==='same_device' && await sql("select count(*) from device_links where code_hash='self'")==='1');
  ok('expired code cannot create a device',JSON.parse(await sql("select redeem_device_link('expired','late')")).status==='bad_link' && await sql("select count(*) from device_keys where key_hash='late'")==='0');
  await sql(`insert into device_keys(key_hash,owner) values('source','${B}'),('source-linked','${B}');
    insert into goals(tag,owner,target) values('PLAYER','${B}',6000);
    insert into push_subs values('https://fcm.googleapis.com/token','PLAYER','${B}');
    insert into profile_adders(owner,tag) values('${A}','SHARED'),('${B}','SHARED'),('${B}','SECOND');
    insert into device_links(code_hash,owner,expires_at) values('source-code','${B}',now()+interval '10 minutes');`);
  const merge=JSON.parse(await sql("set role service_role; select redeem_device_link('self','source')"));
  ok('merge moves goal and linked devices',merge.moved===1 && await sql(`select count(*) from goals where owner='${A}'`)==='2' && await sql(`select count(*) from device_keys where owner='${B}'`)==='0');
  ok('merge moves notifications and deduplicates tracking holders',await sql(`select count(*) from push_subs where owner='${A}'`)==='1' && await sql(`select count(*) from profile_adders where owner='${A}'`)==='2');
  ok('former-owner outstanding links are invalidated',await sql("select count(*) from device_links where code_hash='source-code'")==='0');
  await sql(`insert into device_links(code_hash,owner,expires_at) values('rollback','${A}',now()+interval '10 minutes');
    alter table device_keys add constraint reject_test_key check(key_hash <> 'fail-insert');`);
  let failed=false;try{await sql("set role service_role; select redeem_device_link('rollback','fail-insert')")}catch{failed=true}
  ok('transaction failure rolls back code consumption',failed && await sql("select count(*) from device_links where code_hash='rollback'")==='1');
  ok('retry after a failed transaction succeeds',JSON.parse(await sql("set role service_role; select redeem_device_link('rollback','retry')")).status==='ok');
  // Hold the merge transaction open so issuance demonstrably waits behind it.
  const C='00000000-0000-4000-8000-000000000003';
  await sql(`insert into device_keys(key_hash,owner) values('issuing-source','${C}'); insert into device_links(code_hash,owner,expires_at) values('merge-while-issuing','${A}',now()+interval '10 minutes')`);
  const merging=sql("begin; set local application_name='brawl-merge-test'; set local role service_role; select redeem_device_link('merge-while-issuing','issuing-source'); select pg_sleep(2); commit;");
  let lockObserved=false;
  const deadline=Date.now()+10000;
  while(Date.now()<deadline) {
    if(await sql("select count(*) from pg_stat_activity where application_name='brawl-merge-test' and wait_event='PgSleep'")==='1') { lockObserved=true; break; }
  }
  assert.ok(lockObserved,'merge transaction must hold the lock before issuance');
  const issued=JSON.parse(await sql("set role service_role; select create_device_link('issued-after-merge','issuing-source',now()+interval '10 minutes')"));
  await merging;
  ok('issuance racing a merge resolves the current owner under the lock',issued.status==='ok' && await sql(`select count(*) from device_links where code_hash='issued-after-merge' and owner='${A}'`)==='1');
  await sql(`insert into device_links(code_hash,owner,expires_at) values('collision','${C}',now()+interval '10 minutes')`);
  let collision=false;try{await sql("set role service_role; select create_device_link('collision','issuer',now()+interval '10 minutes')")}catch(e){collision=/duplicate key/.test(e.stderr||'')}
  ok('issuance collision preserves the previous usable code',collision && await sql("select count(*) from device_links where code_hash='issued-after-merge'")==='1');
  ok('issuance for an unknown device fails closed',JSON.parse(await sql("set role service_role; select create_device_link('unknown','unknown-key',now()+interval '10 minutes')")).status==='no_device');
  for(const role of ['anon','authenticated']) {
    let rejected=false;try{await sql(`set role ${role}; select public.redeem_device_link('x','y')`)}catch(e){rejected=/permission denied/.test(e.stderr||'')}
    ok(role+' cannot execute the privileged operation',rejected);
    rejected=false;try{await sql(`set role ${role}; select public.create_device_link('x','y',now())`)}catch(e){rejected=/permission denied/.test(e.stderr||'')}
    ok(role+' cannot issue a link directly',rejected);
  }
  console.log(`All ${n} real PostgreSQL checks passed`);
})().catch(e=>{console.error(e);process.exitCode=1});
