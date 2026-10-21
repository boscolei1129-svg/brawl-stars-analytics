const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const source=fs.readFileSync(require('node:path').join(__dirname,'../sw.js'),'utf8');
function load(failInstall=false){
  const events={},deleted=[],fetches=[],entries=new Map();
  const cache={addAll:async requests=>{if(failInstall)throw Error('download failed');for(const r of requests)entries.set(r.url,new Response('installed '+r.url))},match:async key=>entries.get(key),keys:async()=>[],put:async()=>{throw Error('installed shell must not be refreshed per file')}};
  const scope='https://app.test/brawl-stars-analytics/';
  const self={registration:{scope},location:{origin:'https://app.test'},addEventListener:(name,fn)=>events[name]=fn,clients:{claim:async()=>{}},skipWaiting:()=>{throw Error('must wait for old clients')}};
  const caches={open:async()=>cache,keys:async()=>['brawl-stats-v1','brawl-stats-v2','brawl-art-v1','unrelated-app'],delete:async key=>deleted.push(key)};
  vm.runInNewContext(source,{self,caches,URL,Request,Response,fetch:async req=>{fetches.push(req);return new Response('network')}});
  return {events,deleted,fetches,entries,scope};
}
(async()=>{
  const broken=load(true);let failed;
  broken.events.install({waitUntil:promise=>failed=promise});await assert.rejects(failed,/download failed/);
  const good=load();let task;
  good.events.install({waitUntil:promise=>task=promise});await task;
  assert(good.entries.has(good.scope+'app.js'));
  good.events.activate({waitUntil:promise=>task=promise});await task;
  assert.deepEqual(good.deleted,['brawl-stats-v1']);
  const get=async(url,mode)=>{let response;good.events.fetch({request:{method:'GET',url,mode},respondWith:promise=>response=promise});return (await response).text()};
  assert.equal(await get(good.scope+'?p=PLAYER','navigate'),'installed '+good.scope);
  assert.equal(await get(good.scope+'app.js','cors'),'installed '+good.scope+'app.js');
  assert.equal(good.fetches.length,0);
  console.log('PASS: failed shell download rejects install; app.js included; release shell stays together; unrelated caches preserved');
})().catch(e=>{console.error(e);process.exitCode=1});
