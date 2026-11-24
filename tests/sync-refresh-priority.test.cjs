'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('../app/core/store.cjs');
const {syncAccount}=require('../app/core/sync-service.cjs');
const message=(id,groupId='front')=>({id:String(id),groupId,senderId:'synthetic-member',senderName:'Synthetic',text:'synthetic refresh acceptance',time:1000+Number(id)});
function setup(t,ids=['front']){
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'weiyue-refresh-priority-'));
  t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const store=new Store(folder);store.ensureAccount({id:'synthetic-refresh',name:'Synthetic',kind:'weibo'});
  store.mergeMessages('synthetic-refresh',ids.map(id=>({id,name:'Synthetic '+id,selected:true,nextCursor:'50'})),ids.flatMap(id=>[message(100,id),message(400,id)]),{history:true});
  let clock=1700000000000;const sleeps=[],changes=[];
  return {store,folder,sleeps,changes,now:()=>clock,advance:ms=>{clock+=ms;},sleep:async ms=>{sleeps.push(ms);clock+=ms;},onChange:change=>changes.push(change)};
}
function pending(f,id,cursor='390'){
  f.store.update('synthetic-refresh',state=>{const g=state.groups.find(g=>g.id===id);g.latestPending={cursor,baselineId:'100',arrivalAfterId:'100'};g.syncNext='gap';});
}
function result(ids,id,extra={}){
  const messages=ids.map(value=>message(value,id));
  return {messages,nextCursor:ids.length?String(Math.min(...ids.map(Number))-1):null,reachedStop:false,coverage:{oldest:messages.length?Math.min(...messages.map(m=>m.time)):null,newest:messages.length?Math.max(...messages.map(m=>m.time)):null,complete:false,note:'Synthetic'},...extra};
}
function clientWith(make){
  const calls=[];return {calls,async syncGroup(id,options){const call={id,before:options.before,stopAtId:options.stopAtId};calls.push(call);const page=await make(call,calls.length);await options.onPage(page);return{pages:1};}};
}
function fixtureClient(){return clientWith(call=>call.before===undefined?result([400],call.id,{reachedStop:true}):result([Number(call.before),Number(call.before)-9],call.id));}
const run=(f,client,options={})=>syncAccount({...f,client,accountId:'synthetic-refresh',continuous:true,preferredGroupId:'front',headGroupIds:['front'],maxPages:8,timeBudgetMs:8000,pageDelayMs:1000,headEveryPages:4,...options});

test('current group head precedes its persisted gap and the oldest background head',async t=>{
  const f=setup(t,['background','front']);pending(f,'front');pending(f,'background');
  f.store.update('synthetic-refresh',s=>{s.groups[1].syncProgress={phase:'backfill',added:0,pages:0,scannedUntil:null,updatedAt:f.now(),reason:'Synthetic'};});
  const client=fixtureClient();await run(f,client,{maxPages:4,headGroupIds:['front','background']});
  assert.deepEqual(client.calls.map(c=>[c.id,c.before]),[['front',undefined],['front','390'],['background',undefined],['background','390']]);
  assert.deepEqual(f.changes.map(c=>c.kind),['head','gap','head','gap']);
  assert.deepEqual(f.sleeps,[1000,1000,1000]);
});

test('background head exclusions leave pending gaps eligible and do not issue its contact or head requests',async t=>{
  const f=setup(t,['background','front']);pending(f,'background');
  const client=fixtureClient();await run(f,client,{maxPages:4});
  assert.equal(client.calls[0].id,'front');assert.equal(client.calls[0].before,undefined);
  assert.ok(client.calls.slice(1).every(c=>c.id==='background'&&c.before!==undefined));
  assert.deepEqual(f.changes.filter(c=>c.kind==='head').map(c=>c.groupId),['front']);
  assert.equal(f.store.get('synthetic-refresh').groups.find(g=>g.id==='background').latestPending.cursor,'360');
});

test('no due head and no gap performs zero requests and leaves all stored state unchanged',async t=>{
  const f=setup(t,['front','background']),before=f.store.get('synthetic-refresh'),client=fixtureClient();
  const summary=await run(f,client,{headGroupIds:[]});
  assert.equal(summary.pages,0);assert.equal(summary.count,0);assert.equal(client.calls.length,0);assert.equal(f.changes.length,0);
  assert.deepEqual(f.store.get('synthetic-refresh'),before);
});

test('invalid or deselected priority cannot issue a request outside the permitted selected groups',async t=>{
  const f=setup(t,['front','background']);f.store.update('synthetic-refresh',s=>{s.groups[0].selected=false;});
  const client=fixtureClient();await run(f,client,{headGroupIds:['front','not-selected'],maxPages:2});
  assert.equal(client.calls.length,0);
  await run(f,client,{preferredGroupId:'not-selected',headGroupIds:['background'],maxPages:1});
  assert.deepEqual(client.calls.map(c=>c.id),['background']);
});

test('many selected groups share short batches with both current and background gap progress',async t=>{
  const background=Array.from({length:20},(_,i)=>'background-'+i),f=setup(t,[...background,'front']);
  for(const id of [...background,'front'])pending(f,id);
  const client=fixtureClient(),headDone=new Set(),gaps=new Set();
  for(let cycle=0;cycle<9;cycle++){
    const before=client.calls.length;
    await run(f,client,{headGroupIds:['front',...background.filter(id=>!headDone.has(id))],onChange:change=>{
      f.changes.push(change);if(change.kind==='head')headDone.add(change.groupId);if(change.kind==='gap')gaps.add(change.groupId);
    }});
    const batch=client.calls.slice(before);assert.ok(batch.length<=8);
    // A short batch continues owed work instead of resetting to the front.
    assert.ok(batch.some(c=>c.id==='front'&&c.before===undefined));
  }
  for(const id of ['front',...background]){assert(headDone.has(id),'No head for '+id);assert(gaps.has(id),'No gap for '+id);}
  assert.ok(client.calls.some(c=>c.id==='front'&&Number(c.before)<380));
  assert.ok(f.store.get('synthetic-refresh').groups.every(g=>g.latestPending?.baselineId==='100'));
});

test('four non-head pages are followed by another current-group head while old cursors remain independent',async t=>{
  const f=setup(t,['front','background']);pending(f,'front');pending(f,'background');
  const client=fixtureClient();await run(f,client);
  assert.equal(client.calls.length,8);
  assert.deepEqual(f.changes.map(c=>c.kind),['head','gap','gap','gap','gap','head','gap','gap']);
  assert.ok(f.changes.filter(c=>c.kind==='head').every(c=>c.groupId==='front'));
  assert.ok(f.store.get('synthetic-refresh').groups.every(g=>g.latestPending?.baselineId==='100'));
});

test('overlapping and out-of-order gap pages preserve the read boundary, anchor and unread membership',async t=>{
  const f=setup(t);f.store.mergeMessages('synthetic-refresh',[],[message(190),message(180)],{history:true});
  f.store.setReadPosition('synthetic-refresh','front','100',{offset:17,followTail:false,seenId:'100'});pending(f,'front','190');
  const before=f.store.getReadStats('synthetic-refresh','front'),pages=[result([180,190,180],'front'),result([100,179],'front',{reachedStop:true})];
  const client=clientWith(()=>pages.shift());await run(f,client,{headGroupIds:[]});
  const after=f.store.getReadStats('synthetic-refresh','front'),state=new Store(f.folder).get('synthetic-refresh');
  assert.equal(client.calls.length,2);assert.deepEqual(client.calls.map(c=>c.before),['190','179']);
  assert.equal(state.groups[0].latestPending,null);assert.equal(state.groups[0].syncProgress.added,1);
  assert.equal(after.readThroughId,before.readThroughId);assert.equal(after.anchorId,before.anchorId);assert.equal(after.anchorOffset,17);
  assert.deepEqual(after.unreadIds,[...before.unreadIds,'179']);
  assert.equal(state.messages.filter(m=>m.id==='180').length,1);
});

test('priority page errors stop the batch without reporting a successful head completion',async t=>{
  for(const code of ['RATE_LIMIT','AUTH_REQUIRED','ACCESS_DENIED']){
    const f=setup(t);pending(f,'front');const error=Object.assign(new Error('Synthetic rejected content'),{code,retryAfter:'120'});
    const client=clientWith(()=>{throw error;});await assert.rejects(run(f,client),e=>e===error&&e.retryAfter==='120');
    assert.equal(client.calls.length,1);assert.equal(f.changes.filter(c=>c.kind==='head').length,0);
    assert.equal(f.store.get('synthetic-refresh').groups[0].latestPending.cursor,'390');
    assert.equal(f.changes.at(-1).phase,'blocked');assert.doesNotMatch(JSON.stringify(f.changes),/Synthetic rejected content/);
  }
});

test('time budget or selection changes during throttle cannot start the reserved follow-up page',async t=>{
  const f=setup(t);pending(f,'front');const client=fixtureClient();await run(f,client,{timeBudgetMs:1000});
  assert.equal(client.calls.length,1);assert.equal(f.store.get('synthetic-refresh').groups[0].latestPending.cursor,'390');
  const second=fixtureClient();await run(f,second,{sleep:async()=>f.store.update('synthetic-refresh',s=>{s.groups[0].selected=false;})});
  assert.equal(second.calls.length,1);assert.equal(second.calls[0].before,'390');
  assert.equal(f.store.get('synthetic-refresh').groups[0].latestPending.cursor,'380');
});

test('priority arguments reject malformed values before network work',async t=>{
  const f=setup(t);for(const options of [{preferredGroupId:1},{headGroupIds:'front'},{headGroupIds:[1]},{retryUnresolvedGroupIds:'front'},{retryUnresolvedGroupIds:[1]}]){
    const client=fixtureClient();await assert.rejects(run(f,client,options),TypeError);assert.equal(client.calls.length,0);
  }
});

test('new group initial continuation remains historical and never creates unread',async t=>{
  const f=setup(t);f.store.update('synthetic-refresh',s=>{s.messages=[];});
  const client=fixtureClient();await run(f,client,{maxPages:3});
  assert.deepEqual(f.changes.map(c=>c.kind),['head','initial','initial']);
  assert.equal(f.store.getReadStats('synthetic-refresh','front').unreadCount,0);
  assert.equal(client.calls[1].before,'399');
});

test('legacy initial multi-page notifications distinguish head from historical continuation',async t=>{
  const f=setup(t);f.store.update('synthetic-refresh',s=>{s.messages=[];});
  await syncAccount({...f,accountId:'synthetic-refresh',client:{async syncGroup(id,options){
    await options.onPage(result([400],id));await options.onPage(result([399],id));return{pages:2};
  }}});
  assert.deepEqual(f.changes.map(c=>c.kind),['head','initial']);
  assert.equal(f.store.getReadStats('synthetic-refresh','front').unreadCount,0);
});

test('unresolved ranges wait for their separate retry allowance while ordinary pending gaps continue',async t=>{
  const f=setup(t,['front','background']);pending(f,'front');pending(f,'background');
  f.store.update('synthetic-refresh',s=>{s.groups[0].latestPendingRanges=[{...s.groups[0].latestPending,status:'unresolved'}];});
  const client=fixtureClient();await run(f,client,{maxPages:4,retryUnresolvedGroupIds:[]});
  assert.equal(client.calls[0].before,undefined);assert.equal(client.calls[0].id,'front');
  assert.ok(client.calls.slice(1).every(c=>c.id==='background'&&c.before!==undefined));
  assert.equal(f.store.get('synthetic-refresh').groups.find(g=>g.id==='front').latestPending.cursor,'390');
  const retry=fixtureClient();await run(f,retry,{maxPages:2,retryUnresolvedGroupIds:['front']});
  assert.deepEqual(retry.calls.map(c=>[c.id,c.before]),[['front','390'],['front',undefined]]);
  assert.equal(f.changes.find(c=>c.retriedUnresolved)?.groupId,'front');
});

test('new messages in each due background group become unread without moving either view anchor',async t=>{
  const ids=['front','background-a','background-b'],f=setup(t,ids);
  for(const id of ids)f.store.setReadPosition('synthetic-refresh',id,'100',{offset:11,followTail:false,seenId:'100'});
  const before=Object.fromEntries(ids.map(id=>[id,f.store.getReadStats('synthetic-refresh',id)]));
  const client=clientWith(call=>result([410,400],call.id,{reachedStop:true}));
  await run(f,client);assert.deepEqual(client.calls.map(c=>c.id),['front']);
  assert.equal(f.store.getReadStats('synthetic-refresh','background-a').unreadCount,before['background-a'].unreadCount);
  f.advance(60000);await run(f,client,{headGroupIds:ids});
  for(const id of ids){const after=f.store.getReadStats('synthetic-refresh',id);assert.equal(after.anchorId,before[id].anchorId);assert.equal(after.anchorOffset,11);assert.equal(after.readThroughId,before[id].readThroughId);assert.deepEqual(after.unreadIds,[...before[id].unreadIds,'410']);}
  assert.deepEqual(client.calls.map(c=>c.id),['front','front','background-a','background-b']);
});

test('slow successful pages resume owed slots across batches instead of starving background heads or gaps',async t=>{
  for(const serviceMs of [3500,8100]){
    const ids=['front','background-a','background-b'],f=setup(t,ids),headDone=new Set();
    for(const id of ids)pending(f,id);
    const client=clientWith(call=>{f.advance(serviceMs);return call.before===undefined?result([400],call.id,{reachedStop:true}):result([Number(call.before),Number(call.before)-9],call.id);});
    const start=f.now();
    for(let cycle=0;cycle<10;cycle++){
      await run(f,client,{headGroupIds:['front',...ids.slice(1).filter(id=>!headDone.has(id))],onChange:c=>{f.changes.push(c);if(c.kind==='head')headDone.add(c.groupId);}});f.advance(5000);
    }
    assert.deepEqual(client.calls.slice(0,4).map(c=>[c.id,c.before===undefined?'head':'gap']),[['front','head'],['front','gap'],['background-a','head'],['front','gap']]);
    const heads=f.changes.filter(c=>c.kind==='head'&&c.groupId!=='front'),gaps=f.changes.filter(c=>c.kind==='gap'&&c.groupId!=='front');
    assert.ok(heads.length>0);assert.ok(gaps.length>0);
    for(const id of ids.slice(1)){assert(heads.some(c=>c.groupId===id));assert(gaps.some(c=>c.groupId===id));}
    console.log('SYNTHETIC_REFRESH_SLOW_10_BATCHES '+JSON.stringify({serviceMs,elapsedMs:f.now()-start,pages:client.calls.length,backgroundHeads:heads.length,backgroundGapPages:gaps.length,addedGapMessages:f.store.get('synthetic-refresh').messages.length-ids.length*2}));
  }
});

test('twenty background groups retain fair head and gap progress with one slow page per batch',async t=>{
  const background=Array.from({length:20},(_,i)=>'background-'+i),ids=['front',...background],f=setup(t,ids),lastHead=new Map(),headGroups=new Set(),gapGroups=new Set();
  f.store.mergeMessages('synthetic-refresh',[],ids.map(id=>message(10000,id)),{history:true});
  for(const id of ids){pending(f,id,'9990');f.store.setReadPosition('synthetic-refresh',id,'100',{offset:13,followTail:false,seenId:'100'});}
  const before=Object.fromEntries(ids.map(id=>[id,f.store.getReadStats('synthetic-refresh',id)]));
  const client=clientWith(call=>{f.advance(8100);return call.before===undefined?result([10010,10000],call.id,{reachedStop:true}):result([Number(call.before),Number(call.before)-1],call.id);});
  for(let cycle=0;cycle<90;cycle++){
    const due=background.filter(id=>!lastHead.has(id)||f.now()-lastHead.get(id)>=60000).sort((a,b)=>(lastHead.get(a)||0)-(lastHead.get(b)||0));
    const previous=client.calls.length;
    await run(f,client,{headGroupIds:['front',...due],onChange:c=>{if(c.kind==='head'){lastHead.set(c.groupId,f.now());headGroups.add(c.groupId);}if(c.kind==='gap')gapGroups.add(c.groupId);}});
    assert.equal(client.calls.length-previous,1);f.advance(5000);
  }
  for(const id of ids){
    assert(headGroups.has(id),'No head for '+id);assert(gapGroups.has(id),'No gap for '+id);
    const after=f.store.getReadStats('synthetic-refresh',id);assert.equal(after.anchorId,before[id].anchorId);assert.equal(after.anchorOffset,13);assert.equal(after.readThroughId,before[id].readThroughId);assert(after.unreadIds.includes('10010'));
  }
});

test('due background heads follow planner order even when recent gap writes reorder group timestamps',async t=>{
  const f=setup(t,['background-a','front','background-b']);pending(f,'front');
  f.store.update('synthetic-refresh',s=>{for(const [i,g] of s.groups.entries())g.syncProgress={phase:'joined',added:0,pages:0,scannedUntil:null,updatedAt:f.now()+i,reason:'Synthetic'};});
  const client=fixtureClient();await run(f,client,{headGroupIds:['front','background-b','background-a'],maxPages:6});
  assert.deepEqual(client.calls.filter(c=>c.before===undefined&&c.id!=='front').map(c=>c.id),['background-b','background-a']);
});

test('failed requests and throttle budget exhaustion do not consume owed fair slots',async t=>{
  const f=setup(t,['front','background']);pending(f,'front');pending(f,'background');
  await run(f,fixtureClient(),{maxPages:2,headGroupIds:['front','background']});
  const failing=clientWith(()=>{throw Object.assign(new Error('Synthetic unavailable'),{code:'NETWORK_ERROR'});});
  await assert.rejects(run(f,failing,{headGroupIds:['front','background']}),/Synthetic unavailable/);
  assert.deepEqual(failing.calls.map(c=>[c.id,c.before]),[['background',undefined]]);
  const retry=fixtureClient();await run(f,retry,{headGroupIds:['front','background'],timeBudgetMs:1000});
  assert.deepEqual(retry.calls.map(c=>[c.id,c.before]),[['background',undefined]]);
  const resumed=fixtureClient();await run(f,resumed,{headGroupIds:['front'],maxPages:1});
  assert.equal(resumed.calls[0].before,'380');assert.equal(resumed.calls[0].id,'front');
});

test('failed page persistence keeps the same scheduled slot for the next successful batch',async t=>{
  const f=setup(t,['front','background']);pending(f,'front');pending(f,'background');
  await run(f,fixtureClient(),{maxPages:2,headGroupIds:['front','background']});
  const merge=f.store.mergeMessages.bind(f.store),failure=new Error('Synthetic disk write failure');
  f.store.mergeMessages=(accountId,groups,messages,options)=>{if(messages.length&&groups.some(g=>g.id==='background'))throw failure;return merge(accountId,groups,messages,options);};
  const failing=fixtureClient();await assert.rejects(run(f,failing,{headGroupIds:['front','background']}),e=>e===failure);
  f.store.mergeMessages=merge;
  const retry=fixtureClient();await run(f,retry,{headGroupIds:['front','background'],maxPages:1});
  assert.deepEqual(failing.calls.map(c=>[c.id,c.before]),[['background',undefined]]);
  assert.deepEqual(retry.calls.map(c=>[c.id,c.before]),[['background',undefined]]);
  assert.equal(f.changes.filter(c=>c.groupId==='background'&&c.kind==='head').length,1);
});

test('switching the foreground inserts its refresh but preserves the background gap cursor',async t=>{
  const f=setup(t,['front','background-a','background-b']);for(const id of ['front','background-a','background-b'])pending(f,id);
  const client=fixtureClient();await run(f,client,{headGroupIds:['front'],maxPages:4});
  // Fair rotation has visited front and background-a; switching must not reset it.
  const before=client.calls.length;await run(f,client,{preferredGroupId:'background-a',headGroupIds:['background-a'],maxPages:3});
  assert.deepEqual(client.calls.slice(before).map(c=>[c.id,c.before===undefined?'head':'gap']),[['background-a','head'],['background-a','gap'],['background-b','gap']]);
});

test('multiple unresolved ranges rotate before ordinary pending work and each group retries once per batch',async t=>{
  const f=setup(t);f.store.mergeMessages('synthetic-refresh',[],[message(180),message(280)],{history:true});
  f.store.update('synthetic-refresh',s=>{s.groups[0].latestPendingRanges=[
    {cursor:'390',baselineId:'100',arrivalAfterId:'100',status:'pending'},
    {cursor:'290',baselineId:'180',arrivalAfterId:'180',status:'unresolved'},
    {cursor:'370',baselineId:'280',arrivalAfterId:'280',status:'unresolved'}
  ];});
  const client=clientWith(call=>call.stopAtId==='180'||call.stopAtId==='280'?result([],call.id,{resumeCursor:call.before}):call.before===undefined?result([400],call.id,{reachedStop:true}):result([Number(call.before),Number(call.before)-1],call.id));
  await run(f,client,{maxPages:4,retryUnresolvedGroupIds:['front']});
  assert.deepEqual(client.calls.filter(c=>['180','280'].includes(c.stopAtId)).map(c=>c.stopAtId),['180']);
  assert.ok(client.calls.some(c=>c.stopAtId==='100'));
  assert.equal(f.changes.filter(c=>c.retriedUnresolved).length,1);
  const first=client.calls.length;await run(f,client,{maxPages:3,retryUnresolvedGroupIds:[]});
  assert.ok(client.calls.slice(first).every(c=>!['180','280'].includes(c.stopAtId)));
  f.advance(60000);await run(f,client,{maxPages:4,retryUnresolvedGroupIds:['front']});
  assert.deepEqual(client.calls.filter(c=>['180','280'].includes(c.stopAtId)).map(c=>c.stopAtId),['180','280']);
  assert.equal(f.changes.filter(c=>c.retriedUnresolved).length,2);
  assert.ok(f.store.get('synthetic-refresh').groups[0].latestPendingRanges.some(r=>r.status==='pending'));
  assert.deepEqual(f.store.get('synthetic-refresh').groups[0].latestPendingRanges.filter(r=>r.status==='unresolved').map(r=>r.baselineId),['180','280']);
});

test('bounded clock models measure effective added-gap throughput at fast and slow request speeds',async t=>{
  const duration=180000,results=[];
  for(const requestServiceMs of [100,3500,8100])for(const fast of [false,true]){
    const ids=['front','background-a','background-b'],f=setup(t,ids),lastHead=new Map();
    f.store.mergeMessages('synthetic-refresh',[],ids.map(id=>message(10000,id)),{history:true});
    for(const id of ids)pending(f,id,'9990');
    const countBefore=f.store.get('synthetic-refresh').messages.length,start=f.now(),end=start+duration;
    let gapPages=0,headPages=0,gapAdded=0;
    const client=clientWith(call=>{
      f.advance(requestServiceMs); // Identical response cost for both policies.
      if(call.before===undefined)return result([10000],call.id,{reachedStop:true});
      const ids=Array.from({length:20},(_,i)=>Number(call.before)-i),known=new Set(f.store.get('synthetic-refresh').messages.filter(m=>m.groupId===call.id).map(m=>m.id));
      gapAdded+=ids.filter(id=>!known.has(String(id))).length;return result(ids,call.id);
    });
    while(f.now()<end){
      const remaining=end-f.now();if(remaining<requestServiceMs)break;
      const headGroupIds=fast?ids.filter(id=>id==='front'||!lastHead.has(id)||f.now()-lastHead.get(id)>=60000):undefined;
      await syncAccount({...f,client,sleep:async ms=>f.advance(Math.min(ms,Math.max(0,end-f.now()))),accountId:'synthetic-refresh',continuous:true,maxPages:fast?8:60,timeBudgetMs:Math.min(fast?8000:40000,remaining-requestServiceMs+1),pageDelayMs:1000,headEveryPages:fast?4:12,
        ...(fast?{preferredGroupId:'front',headGroupIds}:{}),onChange:c=>{if(c.kind==='head'){headPages++;lastHead.set(c.groupId,f.now());}else if(c.kind==='gap')gapPages++;}});
      f.advance(Math.min(fast?5000:60000,Math.max(0,end-f.now())));
    }
    const added=f.store.get('synthetic-refresh').messages.length-countBefore;
    assert.equal(added,gapAdded,'Repeated heads must not count as added gap messages');
    assert.ok(f.now()<=end);
    results.push({policy:fast?'5s-after-completion-8pages-8s':'60s-after-completion-60pages-40s',durationMs:duration,requestServiceMs,headPages,gapPages,addedGapMessages:added});
  }
  console.log('SYNTHETIC_REFRESH_THROUGHPUT '+JSON.stringify(results));
  for(let i=0;i<results.length;i+=2)assert.ok(results[i+1].addedGapMessages>=results[i].addedGapMessages,JSON.stringify(results.slice(i,i+2)));
});
