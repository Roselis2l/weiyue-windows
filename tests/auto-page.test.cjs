'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createAutoPager,isAtTop,isAtBottom} = require('../app/renderer/auto-page.js');

function deferred() {
  let resolve,reject;
  const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
function harness(overrides={}) {
  let time=1000;
  const state={key:'account-a/group-a/query-1',enabled:true,blocked:false,atTop:false,atBottom:true,offset:20,count:4,total:100,pageSize:4,...overrides};
  const requests=[],applied=[],errors=[],states=[];
  const pager=createAutoPager({snapshot:()=>({...state}),now:()=>time,
    load(snapshot){const wait=deferred();requests.push({snapshot:{...snapshot},...wait});return wait.promise;},
    apply(result,snapshot){applied.push({result,snapshot});state.count+=result.added;if(snapshot.direction<0)state.offset-=result.added;},
    onState(status){states.push(status);},onError(error){errors.push(error);}});
  const settle=async()=>{for(let step=0;step<12;step++)await Promise.resolve();};
  return {state,pager,requests,applied,errors,states,settle,
    advance(ms){time+=ms;},
    wheel(extra={}){return pager.intent({trusted:true,kind:'wheel',direction:1,modified:false,...extra});},
    drag(gestureId,extra={}){return pager.intent({trusted:true,kind:'drag',direction:1,gestureId,modified:false,...extra});},
    key(gestureId,extra={}){return pager.intent({trusted:true,kind:'keyboard',direction:1,gestureId,modified:false,...extra});},
    async finish(index=0,result={added:4}){await settle();requests[index].resolve(result);await settle();},
    async fail(index=0,error=new Error('Synthetic local query failure')){await settle();requests[index].reject(error);await settle();return error;}
  };
}

test('bottom geometry requires a visible valid viewport and permits only the small bottom threshold',()=>{
  assert.equal(isAtBottom({scrollTop:598,scrollHeight:1000,clientHeight:400}),true);
  assert.equal(isAtBottom({scrollTop:597,scrollHeight:1000,clientHeight:400}),false);
  assert.equal(isAtBottom({scrollTop:0,scrollHeight:200,clientHeight:400}),true,'a short local page can be continued by a real gesture');
  for(const metrics of [
    {scrollTop:0,scrollHeight:0,clientHeight:0},
    {scrollTop:NaN,scrollHeight:1000,clientHeight:400},
    {scrollTop:600,scrollHeight:Infinity,clientHeight:400},
    {scrollTop:-1,scrollHeight:200,clientHeight:400},
    {scrollTop:0,scrollHeight:-1,clientHeight:400}
  ])assert.equal(isAtBottom(metrics),false);
});

test('passive observations, synthetic events, upward input away from top, modified wheel and keyboard without a gesture never load',async()=>{
  const h=harness();
  for(let count=0;count<5;count++)h.pager.observe();
  h.wheel({trusted:false});h.wheel({direction:-1});h.wheel({direction:0});h.wheel({modified:true});
  h.pager.intent({trusted:true,kind:'keyboard',direction:1});
  h.drag('synthetic',{trusted:false});
  await h.settle();assert.equal(h.requests.length,0);assert.equal(h.applied.length,0);
});

test('one wheel burst loads exactly one page even without a scroll event and never chains after append',async()=>{
  const h=harness();
  h.wheel();assert.equal(h.pager.status().loading,true);await h.settle();assert.equal(h.requests.length,1);
  for(let count=0;count<6;count++){h.advance(20);h.wheel();h.pager.observe();}
  assert.equal(h.requests.length,1,'input during a query is consumed, not queued');
  await h.finish();assert.equal(h.applied.length,1);assert.equal(h.pager.status().loading,false);
  h.pager.observe();h.advance(100);h.wheel();await h.settle();assert.equal(h.requests.length,1,'append and the same burst cannot chain another page');
  h.advance(251);h.wheel();await h.settle();assert.equal(h.requests.length,2);await h.finish(1);
});

test('a genuine downward gesture above the bottom loads only after its following bottom scroll',async()=>{
  const h=harness({atBottom:false});
  h.wheel();assert.equal(h.requests.length,0);
  h.advance(100);h.state.atBottom=true;h.pager.observe();await h.settle();assert.equal(h.requests.length,1);
  await h.finish();h.pager.observe();assert.equal(h.requests.length,1);
});

test('an expired old gesture cannot turn later programmatic geometry changes into a page load',async()=>{
  const h=harness({atBottom:false});
  h.wheel();h.advance(1201);h.state.atBottom=true;h.pager.observe();
  await h.settle();assert.equal(h.requests.length,0);
});

test('a short-lived reading block defers one valid gesture but an expired blocked gesture is discarded',async()=>{
  const h=harness({blocked:true});
  h.wheel();assert.equal(h.requests.length,0);
  h.advance(100);h.state.blocked=false;h.pager.observe();await h.settle();assert.equal(h.requests.length,1);await h.finish();
  h.advance(300);h.state.blocked=true;h.wheel();h.advance(1201);h.state.blocked=false;h.pager.observe();
  assert.equal(h.requests.length,1);
  h.advance(300);h.wheel();await h.settle();assert.equal(h.requests.length,2);await h.finish(1);
});

test('disabled contexts and the final local page do not issue queries',async()=>{
  for(const settings of [{enabled:false},{offset:20,count:4,total:24},{offset:20,count:4,total:23},{offset:0,count:0,total:0}]){
    const h=harness(settings);h.wheel();h.drag('one');h.pager.observe();await h.settle();assert.equal(h.requests.length,0);
  }
});

test('one held drag cannot repeatedly page while a distinct subsequent drag can',async()=>{
  const h=harness();
  h.drag('held-pointer-1');await h.settle();assert.equal(h.requests.length,1);await h.finish();
  for(let step=0;step<5;step++){h.advance(1300);h.drag('held-pointer-1');h.pager.observe();}
  assert.equal(h.requests.length,1,'one drag gesture keeps its consumption across time');
  h.drag('new-pointer-2');await h.settle();assert.equal(h.requests.length,2);await h.finish(1);
});

test('input received while a query is pending is not a queued follow-up gesture',async()=>{
  const h=harness();h.wheel();h.advance(400);h.wheel();h.drag('during-query');
  await h.settle();assert.equal(h.requests.length,1);await h.finish();h.pager.observe();h.drag('during-query');
  assert.equal(h.requests.length,1);h.drag('after-query');await h.settle();assert.equal(h.requests.length,2);await h.finish(1);
});

test('switching input kinds during a pending query cannot revive the already consumed wheel burst or held drag',async()=>{
  const wheelFirst=harness();wheelFirst.wheel();wheelFirst.drag('held-during-wheel');await wheelFirst.finish();
  wheelFirst.advance(100);wheelFirst.wheel();wheelFirst.drag('held-during-wheel');await wheelFirst.settle();
  assert.equal(wheelFirst.requests.length,1,'both the original wheel burst and the drag were consumed');
  const dragFirst=harness();dragFirst.drag('held-first');dragFirst.wheel();await dragFirst.finish();
  dragFirst.advance(100);dragFirst.drag('held-first');dragFirst.wheel();await dragFirst.settle();
  assert.equal(dragFirst.requests.length,1,'changing kind must not grant the original held drag a second page');
});

test('late results from another account, group or filter context never apply',async()=>{
  for(const nextKey of ['account-b/group-a/query-1','account-a/group-b/query-1','account-a/group-a/query-2']){
    const h=harness();h.wheel();h.state.key=nextKey;await h.finish();
    assert.equal(h.applied.length,0);assert.equal(h.errors.length,0);assert.equal(h.pager.status().loading,false);
    assert.notEqual(h.pager.status().state,'loading','discarded responses must also settle visible loading status');
    h.advance(300);h.wheel();await h.settle();assert.equal(h.requests.length,2);await h.finish(1);assert.equal(h.applied.length,1);
  }
});

test('background changes to either the loaded window start or count make an in-flight result stale',async()=>{
  for(const field of ['offset','count']){
    const h=harness();h.wheel();h.state[field]++;await h.finish();
    assert.equal(h.applied.length,0);assert.equal(h.errors.length,0);assert.notEqual(h.pager.status().state,'loading');
  }
});

test('closing or leaving reading while pending discards the successful response',async()=>{
  const h=harness();h.wheel();h.state.enabled=false;await h.finish();
  assert.equal(h.applied.length,0);assert.equal(h.pager.status().loading,false);assert.notEqual(h.pager.status().state,'loading');
});

test('a current failure is reported once and requires a fresh gesture before retry',async()=>{
  const h=harness();h.wheel();const failure=await h.fail();
  assert.equal(h.errors.length,1);assert.equal(h.errors[0],failure);assert.equal(h.applied.length,0);
  assert.equal(h.pager.status().state,'error');assert.equal(h.pager.status().loading,false);
  h.pager.observe();h.wheel();assert.equal(h.requests.length,1);
  h.advance(251);h.wheel();await h.settle();assert.equal(h.requests.length,2);await h.finish(1);assert.equal(h.applied.length,1);
});

test('a stale failure never surfaces in the new group or account',async()=>{
  const h=harness();h.wheel();h.state.key='account-b/group-new/query-1';await h.fail();
  assert.equal(h.errors.length,0);assert.equal(h.applied.length,0);assert.equal(h.pager.status().loading,false);assert.notEqual(h.pager.status().state,'loading');
});

test('reset cancels prior authorization and pending application without starting a concurrent query',async()=>{
  const h=harness();h.wheel();h.pager.reset();h.state.key='account-a/group-b/query-2';h.advance(300);h.wheel();
  await h.settle();assert.equal(h.requests.length,1,'reset cannot create concurrency while the old query is unresolved');
  await h.finish();assert.equal(h.applied.length,0);h.pager.observe();assert.equal(h.requests.length,1);
  h.advance(300);h.wheel();await h.settle();assert.equal(h.requests.length,2);await h.finish(1);assert.equal(h.applied.length,1);
});

test('passive layout cancellation drops an armed gesture but never revives a consumed held drag',async()=>{
  const h=harness({atBottom:false});h.wheel();h.pager.cancelIntent();h.state.atBottom=true;h.pager.observe();await h.settle();
  assert.equal(h.requests.length,0,'image resize or programmatic restoration must not use an old armed input');
  h.drag('held-drag');await h.finish();h.pager.cancelIntent();h.advance(1500);h.drag('held-drag');await h.settle();
  assert.equal(h.requests.length,1,'a passive resize cannot unspend the same held drag');
  h.drag('fresh-drag');await h.finish(1);assert.equal(h.applied.length,2);
});

test('upward reversal cancels an armed downward intent before a later passive bottom observation',async()=>{
  const h=harness({atBottom:false});h.wheel();h.advance(50);h.wheel({direction:-1});h.state.atBottom=true;h.pager.observe();
  await h.settle();assert.equal(h.requests.length,0);
});

test('top geometry uses a two-pixel tolerance and rejects invalid or hidden viewports',()=>{
  assert.equal(isAtTop({scrollTop:2,scrollHeight:1000,clientHeight:400}),true);
  assert.equal(isAtTop({scrollTop:2.1,scrollHeight:1000,clientHeight:400}),false);
  assert.equal(isAtTop({scrollTop:0,scrollHeight:200,clientHeight:400}),true);
  for(const metrics of [
    {scrollTop:0,scrollHeight:0,clientHeight:0},
    {scrollTop:NaN,scrollHeight:1000,clientHeight:400},
    {scrollTop:0,scrollHeight:Infinity,clientHeight:400},
    {scrollTop:-1,scrollHeight:1000,clientHeight:400},
    {scrollTop:0,scrollHeight:-1,clientHeight:400}
  ])assert.equal(isAtTop(metrics),false);
  assert.equal(isAtTop({scrollTop:0,scrollHeight:1000,clientHeight:400},-1),false);
});

test('upward wheel loads the preceding local page once and stops at the first local boundary',async()=>{
  const h=harness({offset:4,atTop:true,atBottom:false});
  h.wheel({direction:-20});await h.settle();
  assert.equal(h.requests.length,1);assert.equal(h.requests[0].snapshot.direction,-1);
  assert.equal(h.pager.status().direction,-1);assert.equal(h.pager.status().state,'loading');
  await h.finish();assert.equal(h.state.offset,0);assert.equal(h.state.count,8);
  assert.equal(h.applied[0].snapshot.direction,-1);
  assert.equal(h.pager.status().state,'end');assert.equal(h.pager.status().direction,-1);
  h.advance(300);h.wheel({direction:-1});h.key('up-at-first',{direction:-1});h.pager.observe();await h.settle();
  assert.equal(h.requests.length,1);
  h.state.atBottom=true;h.key('down-from-first');await h.settle();assert.equal(h.requests.length,2);
  assert.equal(h.requests[1].snapshot.direction,1);await h.finish(1);
});

test('an upward gesture requires its top boundary and does not react to the opposite boundary',async()=>{
  const h=harness({atTop:false,atBottom:true});h.wheel({direction:-1});h.pager.observe();await h.settle();
  assert.equal(h.requests.length,0);
  h.state.atTop=true;h.advance(100);h.pager.observe();await h.settle();assert.equal(h.requests.length,1);
  await h.finish();h.pager.observe();assert.equal(h.requests.length,1,'prepend cannot authorize another earlier page');
});

test('a keyboard press may reach a boundary through repeats but never loads another page until a new gesture',async()=>{
  for(const travel of [-1,1]){
    const h=harness({atTop:false,atBottom:false});
    h.key('held',{direction:travel});h.advance(500);h.key('held',{direction:travel});await h.settle();assert.equal(h.requests.length,0);
    h.state[travel<0?'atTop':'atBottom']=true;h.pager.observe();await h.settle();assert.equal(h.requests.length,1);
    assert.equal(h.requests[0].snapshot.direction,travel);
    h.advance(5000);h.key('held',{direction:travel});await h.finish();
    for(let i=0;i<6;i++){h.advance(2000);h.key('held',{direction:travel});h.pager.observe();}
    await h.settle();assert.equal(h.requests.length,1,'held repeat is not a fresh page gesture');
    h.key('new-press',{direction:travel});await h.settle();assert.equal(h.requests.length,2);await h.finish(1);
  }
});

test('wheel reversal starts a new directional burst without renewing a consumed held key',async()=>{
  const h=harness({atTop:true,atBottom:true});h.wheel();await h.finish();
  h.advance(20);h.wheel({direction:-1});await h.settle();assert.equal(h.requests.length,2);
  assert.equal(h.requests[1].snapshot.direction,-1);await h.finish(1);
  h.advance(20);h.wheel({direction:-1});await h.settle();assert.equal(h.requests.length,2);
  h.key('same-key',{direction:-1});await h.finish(2);
  h.key('same-key',{direction:1});await h.settle();assert.equal(h.requests.length,3,'direction cannot renew the same physical key press');
});

test('opposite-direction and mixed input while pending are consumed and never become queued pages',async()=>{
  const h=harness({atTop:true,atBottom:true});h.key('up-held',{direction:-1});await h.settle();
  h.key('down-during');h.wheel();h.drag('drag-during',{direction:-1});
  assert.equal(h.requests.length,1);await h.finish();h.pager.observe();
  h.key('down-during');h.wheel();h.drag('drag-during',{direction:-1});await h.settle();assert.equal(h.requests.length,1);
  h.key('after-query');await h.settle();assert.equal(h.requests.length,2);await h.finish(1);
});

test('reset and passive restoration do not renew a consumed keyboard press',async()=>{
  const h=harness({atTop:true,atBottom:false});h.key('up-held',{direction:-1});await h.finish();
  h.pager.reset();h.state.key='account-a/group-b/query-2';h.advance(3000);
  h.key('up-held',{direction:-1});h.pager.observe();await h.settle();assert.equal(h.requests.length,1);
  assert.equal(h.pager.status().direction,0);
  h.key('new-up',{direction:-1});await h.settle();assert.equal(h.requests.length,2);await h.finish(1);
});

test('earlier-page failures retain their direction and require a fresh gesture to retry',async()=>{
  const h=harness({atTop:true,atBottom:false});h.key('up-held',{direction:-1});await h.fail();
  assert.equal(h.pager.status().direction,-1);assert.equal(h.pager.status().state,'error');assert.equal(h.errors.length,1);
  h.key('up-held',{direction:-1});h.pager.observe();await h.settle();assert.equal(h.requests.length,1);
  h.key('up-retry',{direction:-1});await h.finish(1);assert.equal(h.applied.length,1);
});

test('earlier-page results from a switched filter are discarded while the pending lock stays single-flight',async()=>{
  const h=harness({atTop:true,atBottom:false});h.key('original',{direction:-1});await h.settle();
  h.pager.reset();h.state.key='account-a/group-a/query-2';h.key('during-switch',{direction:-1});await h.settle();
  assert.equal(h.requests.length,1);await h.finish();assert.equal(h.applied.length,0);assert.equal(h.errors.length,0);
  h.key('during-switch',{direction:-1});await h.settle();assert.equal(h.requests.length,1);
  h.key('after-switch',{direction:-1});await h.finish(1);assert.equal(h.applied.length,1);
});

test('missing direction preserves next-page compatibility and malformed held gestures cancel prior authorization',async()=>{
  const h=harness();h.pager.intent({trusted:true,kind:'keyboard',gestureId:'default-down'});await h.settle();
  assert.equal(h.requests[0].snapshot.direction,1);await h.finish();
  const invalid=harness({atBottom:false});
  for(const gestureId of [undefined,null,'',{},[],NaN,Infinity]){
    invalid.advance(300);invalid.wheel();invalid.key(gestureId);invalid.state.atBottom=true;invalid.pager.observe();await invalid.settle();
    assert.equal(invalid.requests.length,0);invalid.state.atBottom=false;
  }
});
