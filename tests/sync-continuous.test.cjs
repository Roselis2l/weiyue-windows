'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('../app/core/store.cjs');
const {syncAccount}=require('../app/core/sync-service.cjs');
const {WeiboClient}=require('../app/core/weibo.cjs');
const m=(id,groupId='g')=>({id:String(id),groupId,senderId:'u',senderName:'Synthetic',text:'synthetic',time:1000+Number(id)});
function setup(t,groups=['g']){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wy-continuous-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const store=new Store(root);store.ensureAccount({id:'w',name:'Synthetic',kind:'weibo'});
  store.mergeMessages('w',groups.map(id=>({id,name:'Synthetic',selected:true,nextCursor:'50'})),groups.map(id=>m(100,id)));
  let clock=1700000000000;const sleeps=[];
  return {root,store,sleeps,now:()=>clock,sleep:async ms=>{sleeps.push(ms);clock+=ms;}};
}
function page(ids,extra={}){const messages=ids.map(id=>m(id));return {messages,nextCursor:ids.length?String(Math.min(...ids.map(Number))-1):null,reachedStop:false,coverage:{oldest:messages.length?Math.min(...messages.map(m=>m.time)):null,newest:messages.length?Math.max(...messages.map(m=>m.time)):null,complete:false,note:'synthetic'},...extra};}
function queued(pages){const calls=[];return {calls,async syncGroup(id,options){calls.push({id,before:options.before,stopAtId:options.stopAtId});const next=pages.shift();if(next instanceof Error)throw next;assert.ok(next,'unexpected extra request');await options.onPage({...next,messages:next.messages.map(m=>({...m,groupId:id}))});return {pages:1};}};}
const run=(f,client,options={})=>syncAccount({...f,client,accountId:'w',continuous:true,maxPages:60,pageDelayMs:1000,...options});

test('continuous catch-up saves more than the old three-page budget and uses count20 with exact cursors',async t=>{
  const f=setup(t,['21']),calls=[],networkDelays=[];
  const client=new WeiboClient({sleep:async ms=>networkDelays.push(ms),fetch:async url=>{
    const u=new URL(url);calls.push(u);const top=Number(u.searchParams.get('max_mid')||240);
    const ids=Array.from({length:20},(_,i)=>top-i);
    return new Response(JSON.stringify({messages:ids.map(id=>({id:String(id),from_uid:'71',time:1700000000+id,content:'synthetic'})),has_more:1}));
  }});
  const result=await run(f,client,{maxPages:8});
  assert.equal(result.pages,8);assert.equal(result.count,159);assert.ok(calls.every(u=>u.searchParams.get('count')==='20'));
  assert.deepEqual(calls.map(u=>u.searchParams.get('max_mid')),[null,'220','200','180','160','140','120','100']);
  assert.deepEqual(f.sleeps,Array(7).fill(1000));assert.deepEqual(networkDelays,[]);
  assert.equal(f.store.get('w').groups[0].latestPending,null);assert.equal(f.store.get('w').groups[0].nextCursor,'50');
});

test('old pending remains independent when a new head creates another gap; restart retains both',async t=>{
  const f=setup(t);f.store.mergeMessages('w',[],[m(200)]);
  f.store.update('w',s=>{s.groups[0].latestPending={cursor:'190',baselineId:'100',arrivalAfterId:'100'};});
  const client=queued([page([300,290]),page([190,180])]);
  await run(f,client,{maxPages:2});
  const s=new Store(f.root).get('w'),g=s.groups[0];
  assert.deepEqual(client.calls,[{id:'g',before:undefined,stopAtId:'200'},{id:'g',before:'190',stopAtId:'100'}]);
  assert.deepEqual(g.latestPendingRanges.map(r=>[r.cursor,r.baselineId]),[['179','100'],['289','200']]);
  assert.equal(g.syncProgress.added,2);assert.equal(g.syncProgress.pages,1);assert.equal(g.syncProgress.phase,'backfill');
  assert.equal(g.nextCursor,'50');
});

test('periodic heads are interleaved with old-gap pages and cannot erase an older baseline',async t=>{
  const f=setup(t);f.store.mergeMessages('w',[],[m(200)]);
  f.store.update('w',s=>{s.groups[0].latestPending={cursor:'190',baselineId:'100',arrivalAfterId:'100'};});
  const client=queued([page([210,200],{reachedStop:true}),page([190,180]),page([220,210],{reachedStop:true}),page([179,170]),page([230,220],{reachedStop:true})]);
  await run(f,client,{maxPages:5,headEveryPages:2});
  assert.deepEqual(client.calls.map(c=>c.before),[undefined,'190',undefined,'179',undefined]);
  assert.equal(f.store.get('w').groups[0].latestPending.baselineId,'100');
  assert.equal(f.store.get('w').groups[0].latestPending.cursor,'169');
  assert.ok(f.store.get('w').messages.some(m=>m.id==='230'));
});

test('head probes and backfill pages rotate fairly across groups under a global page budget',async t=>{
  const f=setup(t,['g','h','i']);
  const client=queued([page([200]),page([200]),page([200]),page([199]),page([199]),page([199])]);
  const result=await run(f,client,{maxPages:6});
  assert.deepEqual(client.calls.map(c=>c.id),['g','h','i','g','h','i']);assert.equal(result.pages,6);
  assert.equal(result.pendingGroups,3);assert.equal(result.budgetExhausted,true);
});

test('time budget is checked after throttling before another request; a later batch resumes',async t=>{
  const f=setup(t),client=queued([page([200]),page([199]),page([198])]);
  const result=await run(f,client,{timeBudgetMs:1500});
  assert.equal(result.pages,2);assert.equal(client.calls.length,2);assert.equal(result.budgetExhausted,true);
  assert.equal(new Store(f.root).get('w').groups[0].latestPending.cursor,'198');
});

test('already-imported overlapping pages still advance toward the original baseline, without inflating progress',async t=>{
  const f=setup(t);f.store.mergeMessages('w',[],[m(200),m(190),m(180)]);
  f.store.setReadPosition('w','g','100',{offset:17,followTail:false,seenId:'100'});
  f.store.update('w',s=>{s.groups[0].latestPending={cursor:'190',baselineId:'100',arrivalAfterId:'100'};});
  const before=f.store.getReadStats('w','g');
  const client=queued([page([200],{reachedStop:true}),page([190,180]),page([179,100],{reachedStop:true})]);
  await run(f,client);
  const g=f.store.get('w').groups[0],after=f.store.getReadStats('w','g');
  assert.equal(g.latestPending,null);assert.equal(g.syncProgress.added,1);assert.equal(g.syncProgress.pages,2);
  assert.equal(after.anchorId,before.anchorId);assert.equal(after.readThroughId,before.readThroughId);assert.equal(after.anchorOffset,17);
  assert.deepEqual(after.unreadIds,[...before.unreadIds,'179']);
});

test('premature empty and explicit-end pages retain unresolved ranges and original boundaries across restart',async t=>{
  for(const response of [page([],{resumeCursor:'190'}),page([190,180],{nextCursor:null,resumeCursor:'179'})]){
    const f=setup(t);f.store.mergeMessages('w',[],[m(200)]);
    f.store.update('w',s=>{s.groups[0].latestPending={cursor:'190',baselineId:'100',arrivalAfterId:'100'};});
    const client=queued([page([200],{reachedStop:true}),response]);
    await run(f,client);
    const g=new Store(f.root).get('w').groups[0];
    assert.equal(client.calls.length,2);assert.equal(g.latestPending.baselineId,'100');assert.equal(g.latestPending.cursor,response.resumeCursor);
    assert.equal(g.latestPendingRanges[0].status,'unresolved');assert.equal(g.syncProgress.phase,'unresolved');
    assert.equal(g.nextCursor,'50');assert.equal(g.historyExhausted,undefined);
  }
});

test('a first empty head has a restartable null cursor and cannot silently claim latest completion',async t=>{
  const f=setup(t);await run(f,queued([page([],{resumeCursor:null})]));
  const group=new Store(f.root).get('w').groups[0];
  assert.equal(group.latestPending.cursor,null);assert.equal(group.latestPending.baselineId,'100');
  assert.equal(group.syncProgress.phase,'unresolved');
});

test('security or rate-limit failures stop the whole batch, preserve cursor and expose fixed private-safe progress',async t=>{
  for(const code of ['AUTH_REQUIRED','ACCESS_DENIED','RATE_LIMIT','RISK_CONTROL']){
    const f=setup(t),error=Object.assign(new Error('secret-cookie-private'),{code});
    const client=queued([page([200]),error,page([190])]);
    await assert.rejects(run(f,client),e=>e===error);
    const g=f.store.get('w').groups[0];assert.equal(client.calls.length,2);assert.equal(g.latestPending.cursor,'199');
    assert.equal(g.syncProgress.phase,'blocked');assert.doesNotMatch(JSON.stringify(g.syncProgress),/secret-cookie-private/);
  }
});

test('single-account business operations cannot overlap even if another caller starts a different account',async t=>{
  const f=setup(t);let release;const pending=new Promise(r=>{release=r;});
  const first=run(f,{async syncGroup(id,o){await pending;await o.onPage(page([100],{reachedStop:true}));return {pages:1};}});
  await assert.rejects(run(f,queued([])),{code:'SYNC_BUSY'});release();await first;
  await run(f,queued([page([100],{reachedStop:true})]));
});

test('cancellation and failed page persistence stop before a later request or cursor advancement',async t=>{
  const f=setup(t),controller=new AbortController(),client=queued([page([200]),page([190])]);
  await assert.rejects(run(f,client,{signal:controller.signal,onChange:()=>controller.abort()}),{code:'ABORTED'});
  assert.equal(client.calls.length,1);assert.equal(f.store.get('w').groups[0].latestPending.cursor,'199');
  const g=setup(t),file=path.join(g.root,fs.readdirSync(g.root)[0]),before=fs.readFileSync(file);
  g.store._write=()=>{throw new Error('synthetic disk failure');};
  const failed=queued([page([200]),page([190])]);await assert.rejects(run(g,failed),/synthetic disk failure/);
  assert.equal(failed.calls.length,1);assert.deepEqual(fs.readFileSync(file),before);
});

test('range storage migrates legacy state, survives group refresh, validates references and never silently drops overflow',async t=>{
  const f=setup(t);const rows=Array.from({length:33},(_,i)=>m(200+i*10));f.store.mergeMessages('w',[],rows);
  const ranges=rows.slice(0,32).map(row=>({cursor:String(Number(row.id)+5),baselineId:row.id,arrivalAfterId:row.id,status:'pending'}));
  f.store.mergeMessages('w',[{id:'g',name:'Synthetic',latestPendingRanges:ranges}],[]);
  f.store.mergeMessages('w',[{id:'g',name:'Refreshed'}],[]);assert.equal(f.store.get('w').groups[0].latestPendingRanges.length,32);
  await run(f,queued([page([1000])]),{maxPages:1});
  const g=new Store(f.root).get('w').groups[0];assert.equal(g.latestPendingRanges.length,1);
  assert.equal(g.latestPending.baselineId,'200');assert.equal(g.latestPending.cursor,'999');
  const before=f.store.get('w');
  assert.throws(()=>f.store.mergeMessages('w',[{id:'g',name:'Synthetic',latestPendingRanges:[{cursor:'900',baselineId:'100',arrivalAfterId:'missing'}]}],[]),/同群消息不存在/);
  assert.deepEqual(f.store.get('w'),before);
});

test('one-page budgets alternate persisted head and gap work across restarts without starving either',async t=>{
  const f=setup(t);let store=f.store;
  const client=queued([page([200]),page([199,190]),page([210,200],{reachedStop:true}),page([189,180])]);
  for(let i=0;i<4;i++){await run({...f,store},client,{maxPages:1});store=new Store(f.root);}
  assert.deepEqual(client.calls.map(c=>c.before),[undefined,'199',undefined,'189']);
  assert.equal(store.get('w').groups[0].latestPending.cursor,'179');
  assert.equal(store.get('w').groups[0].latestPending.baselineId,'100');
});

test('legacy multi-page latest scans replace the same range and clear it only after original overlap',async t=>{
  const f=setup(t);
  await syncAccount({store:f.store,accountId:'w',client:{async syncGroup(id,o){
    await o.onPage(page([200]));await o.onPage(page([199]));
    assert.equal(f.store.get('w').groups[0].latestPendingRanges.length,1);
    await o.onPage(page([100],{reachedStop:true}));return {pages:3};
  }}});
  assert.deepEqual(f.store.get('w').groups[0].latestPendingRanges,[]);
});

test('initial multi-page loading never creates unread and preserves a usable older-history cursor',async t=>{
  const f=setup(t);f.store.update('w',s=>{s.messages=[];});
  const client=queued([page([200]),page([199]),page([198])]);await run(f,client,{maxPages:3});
  assert.deepEqual(client.calls.map(c=>c.before),[undefined,'199','198']);
  assert.equal(f.store.getReadStats('w','g').unreadCount,0);assert.equal(f.store.get('w').groups[0].nextCursor,'197');
});

test('actual client early-end metadata keeps last safe resumeCursor and does not prove incremental coverage',async()=>{
  for(const messages of [[],[{id:'190',from_uid:'71',time:1700000000,content:'synthetic'}]]){
    const client=new WeiboClient({fetch:async()=>new Response(JSON.stringify({messages,has_more:0}))});
    const saved=[];const result=await client.syncGroup('21',{before:'190',stopAtId:'100',onPage:p=>saved.push(p)});
    assert.equal(result.unresolved,true);assert.equal(result.reachedStop,false);assert.equal(result.coverage.complete,false);
    assert.equal(result.resumeCursor,messages.length?'189':'190');assert.equal(saved[0].resumeCursor,result.resumeCursor);
  }
});

test('manual120-page option is accepted and invalid budgets never issue a request',async t=>{
  const f=setup(t);await run(f,queued([page([100],{reachedStop:true})]),{maxPages:120,timeBudgetMs:90000});
  for(const options of [{maxPages:201},{pageDelayMs:499},{timeBudgetMs:120001},{headEveryPages:0}]){
    const client=queued([]);await assert.rejects(run(f,client,options));assert.equal(client.calls.length,0);
  }
});

test('a group deselected while its request is pending cannot archive the late page or advance its cursor',async t=>{
  const f=setup(t);let release;const pending=new Promise(r=>{release=r;});
  const work=run(f,{async syncGroup(id,o){await pending;await o.onPage(page([200]));return {pages:1};}});
  f.store.update('w',s=>{s.groups[0].selected=false;});release();await assert.rejects(work,/取消选择/);
  const state=f.store.get('w');assert.equal(state.messages.length,1);assert.equal(state.groups[0].nextCursor,'50');
  assert.equal(state.groups[0].latestPending,undefined);
});

test('blocked progress is reported after the final saved page without forwarding the rejected service content',async t=>{
  const f=setup(t),changes=[],error=Object.assign(new Error('private server content'),{code:'RATE_LIMIT'});
  await assert.rejects(run(f,queued([page([200]),error]),{onChange:p=>changes.push(p)}),{code:'RATE_LIMIT'});
  assert.deepEqual(changes.map(p=>p.phase),['backfill','blocked']);assert.equal(changes[1].pages,1);
  assert.doesNotMatch(JSON.stringify(changes),/private server content/);
});

test('failed blocked-status persistence never masks rate-limit or authorization metadata',async t=>{
  for(const code of ['RATE_LIMIT','AUTH_REQUIRED']){
    const f=setup(t),error=Object.assign(new Error('synthetic'),{code,retryAfter:'1800'});
    f.store.mergeMessages('w',[],[m(200)]);f.store.update('w',s=>{s.groups[0].latestPending={cursor:'190',baselineId:'100',arrivalAfterId:'100'};});
    const before=f.store.get('w');f.store.mergeMessages=()=>{throw new Error('synthetic status disk failure');};
    await assert.rejects(run(f,queued([error])),e=>e===error&&e.retryAfter==='1800');
    assert.deepEqual(f.store.get('w'),before);
  }
});

test('selection revoked during throttle prevents the queued request itself',async t=>{
  const f=setup(t),client=queued([page([200])]);
  await run({...f,sleep:async()=>f.store.update('w',s=>{s.groups[0].selected=false;})},client);
  assert.equal(client.calls.length,1);
});
