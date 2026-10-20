const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('../app/core/store.cjs');const {syncAccount}=require('../app/core/sync-service.cjs');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'wy-sync-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const store=new Store(root);store.ensureAccount({id:'w',name:'mock',kind:'weibo'});store.mergeMessages('w',[{id:'g',name:'G',selected:true}],[]);return {store,root};}
const m=(id,time=1000+Number(id.slice(-3)))=>({id,groupId:'g',senderId:'u',senderName:'U',text:'mock',time});
const cov={oldest:1001,newest:2000,complete:false,note:'mock'};
test('page persisted cursor survives failure and restart, explicit end terminates history',async t=>{
  let {store,root}=fixture(t);
  await assert.rejects(syncAccount({store,accountId:'w',client:{async syncGroup(g,o){await o.onPage({messages:[m('9007199254740994')],nextCursor:'9007199254740993',coverage:cov});throw Error('offline');}}}),/offline/);
  store=new Store(root);assert.equal(store.get('w').groups[0].nextCursor,'9007199254740993');
  await syncAccount({store,accountId:'w',history:true,client:{async syncGroup(g,o){assert.equal(o.before,'9007199254740993');await o.onPage({messages:[],nextCursor:null,coverage:cov});return {pages:1,nextCursor:null,coverage:cov};}}});
  assert.equal(store.get('w').groups[0].historyExhausted,true);assert.equal(store.get('w').groups[0].nextCursor,null);
  await syncAccount({store,accountId:'w',history:true,client:{async syncGroup(){throw Error('must not fetch');}}});
});
test('initial scan retains history continuation without marking backlog unread; empty coverage safe',async t=>{
  const {store}=fixture(t);store.update('w',s=>{s.groups[0].nextCursor='5';});
  await syncAccount({store,accountId:'w',client:{async syncGroup(g,o){assert.equal(o.before,undefined);await o.onPage({messages:[m('100')],nextCursor:'99',coverage:cov});return {pages:1,nextCursor:'99',coverage:cov};}}});
  assert.equal(store.get('w').groups[0].nextCursor,'99');
  assert.equal(store.getReadStats('w','g').unreadCount,0);
  store.mergeMessages('w',[{id:'empty',name:'Empty',selected:true}],[]);
  await syncAccount({store,accountId:'w',groupId:'empty',client:{async syncGroup(g,o){const coverage={oldest:null,newest:null,complete:true,note:'empty'};await o.onPage({messages:[],nextCursor:null,coverage});return {pages:1,nextCursor:null,coverage};}}});
  assert.equal(store.get('w').groups.find(g=>g.id==='empty').coverage,undefined);
});

test('latest overlap uses numeric ID frontier and time-ordered arrival frontier while preserving history',async t=>{
  const {store}=fixture(t);
  // ID order and timestamp order need not agree: API pagination uses 110,
  // while unread arrivals must be compared against the later timestamp of 100.
  store.mergeMessages('w',[],[m('100',2000),m('110',1900)]);
  store.update('w',s=>{s.groups[0].nextCursor='80';s.groups[0].historyExhausted=true;});
  store.setReadPosition('w','g','100',{offset:17,followTail:false,seenId:'100'});
  let calls=0,changes=0;
  const result=await syncAccount({store,accountId:'w',client:{async syncGroup(g,o){
    calls++;assert.equal(o.before,undefined);assert.equal(o.stopAtId,'110');
    await o.onPage({messages:[m('130',2100),m('120',1950),m('110',1900)],nextCursor:'109',reachedStop:true,coverage:cov});
    return {pages:1,nextCursor:'109',reachedStop:true,coverage:cov};
  }},onChange:()=>{
    changes++;const group=store.get('w').groups[0];
    assert.equal(group.latestPending,null);assert.equal(store.getReadStats('w','g').unreadCount,1);
  }});
  assert.deepEqual(result,{count:2,pages:1});assert.equal(calls,1);assert.equal(changes,1);
  const group=store.get('w').groups[0],read=store.getReadStats('w','g');
  assert.equal(group.nextCursor,'80');assert.equal(group.historyExhausted,true);
  assert.equal(read.anchorId,'100');assert.equal(read.anchorOffset,17);assert.equal(read.atBottom,false);
  assert.deepEqual(read.unreadIds,['130']);
  assert.doesNotMatch(group.coverage.note,/只保存文字|未下载图片/);
});

test('budget and network interruptions resume the same baseline without losing unread on later pages',async t=>{
  let {store,root}=fixture(t);
  store.mergeMessages('w',[],[m('100')]);
  store.update('w',s=>{s.groups[0].nextCursor='50';s.groups[0].historyExhausted=true;});
  await syncAccount({store,accountId:'w',maxPages:1,client:{async syncGroup(g,o){
    assert.equal(o.maxPages,1);assert.equal(o.stopAtId,'100');assert.equal(o.before,undefined);
    await o.onPage({messages:[m('150'),m('140')],nextCursor:'139',reachedStop:false,coverage:cov});
    return {pages:1,nextCursor:'139',reachedStop:false,coverage:cov};
  }}});
  store=new Store(root);
  assert.deepEqual(store.get('w').groups[0].latestPending,{cursor:'139',baselineId:'100',arrivalAfterId:'100'});
  const limited=Object.assign(new Error('simulated rate limit'),{code:'RATE_LIMIT'});
  await assert.rejects(syncAccount({store,accountId:'w',maxPages:2,client:{async syncGroup(g,o){
    assert.equal(o.before,'139');assert.equal(o.stopAtId,'100');
    await o.onPage({messages:[m('130'),m('120')],nextCursor:'119',reachedStop:false,coverage:cov});
    throw limited;
  }}}),error=>error===limited);
  store=new Store(root);
  assert.deepEqual(store.get('w').groups[0].latestPending,{cursor:'119',baselineId:'100',arrivalAfterId:'100'});
  assert.equal(store.getReadStats('w','g').unreadCount,4);
  await syncAccount({store,accountId:'w',client:{async syncGroup(g,o){
    assert.equal(o.before,'119');assert.equal(o.stopAtId,'100');
    await o.onPage({messages:[m('110'),m('100')],nextCursor:'99',reachedStop:true,coverage:cov});
    return {pages:1,nextCursor:'99',reachedStop:true,coverage:cov};
  }}});
  const group=store.get('w').groups[0];
  assert.equal(group.latestPending,null);assert.equal(group.nextCursor,'50');assert.equal(group.historyExhausted,true);
  assert.equal(store.getReadStats('w','g').unreadCount,5);
  assert.deepEqual(store.get('w').messages.map(message=>message.id),['100','110','120','130','140','150']);
  await syncAccount({store,accountId:'w',client:{async syncGroup(g,o){
    assert.equal(o.before,undefined);assert.equal(o.stopAtId,'150');
    await o.onPage({messages:[m('160'),m('150')],nextCursor:'149',reachedStop:true,coverage:cov});
    return {pages:1,nextCursor:'149',reachedStop:true,coverage:cov};
  }}});
  assert.equal(store.getReadStats('w','g').unreadCount,6);
});

test('history adds no unread and preserves read position and the separate latest continuation',async t=>{
  const {store}=fixture(t);
  store.mergeMessages('w',[],[m('90'),m('100')]);
  store.setReadPosition('w','g','90',{offset:23,followTail:false,seenId:'90'});
  store.update('w',s=>{s.groups[0].nextCursor='80';});
  await syncAccount({store,accountId:'w',maxPages:1,client:{async syncGroup(g,o){
    await o.onPage({messages:[m('110')],nextCursor:'109',reachedStop:false,coverage:cov});
    return {pages:1,nextCursor:'109',reachedStop:false,coverage:cov};
  }}});
  const beforeRead=store.getReadStats('w','g'),pending=store.get('w').groups[0].latestPending;
  await syncAccount({store,accountId:'w',history:true,client:{async syncGroup(g,o){
    assert.equal(o.before,'80');assert.equal(o.stopAtId,undefined);
    await o.onPage({messages:[m('70'),m('60')],nextCursor:null,reachedStop:false,coverage:cov});
    return {pages:1,nextCursor:null,coverage:cov};
  }}});
  const afterRead=store.getReadStats('w','g'),group=store.get('w').groups[0];
  for(const field of ['anchorId','anchorOffset','atBottom','readThroughId','unreadCount','firstUnreadId'])assert.equal(afterRead[field],beforeRead[field]);
  assert.deepEqual(afterRead.unreadIds,['110']);assert.deepEqual(group.latestPending,pending);
  assert.equal(group.nextCursor,null);assert.equal(group.historyExhausted,true);
});

test('cancelled late pages never persist; cancellation after a committed page retains only that page',async t=>{
  const {store}=fixture(t);store.mergeMessages('w',[],[m('100')]);
  const original=store.get('w');const controller=new AbortController();let notified=0;
  await assert.rejects(syncAccount({store,accountId:'w',signal:controller.signal,onChange:()=>notified++,client:{async syncGroup(g,o){
    assert.equal(o.signal,controller.signal);controller.abort(new Error('private cancellation reason'));
    await o.onPage({messages:[m('120')],nextCursor:'119',coverage:cov});
    assert.fail('late page must be rejected');
  }}}),error=>error.code==='ABORTED'&&!error.message.includes('private'));
  assert.deepEqual(store.get('w'),original);assert.equal(notified,0);
  const second=new AbortController();
  await assert.rejects(syncAccount({store,accountId:'w',signal:second.signal,onChange:()=>{notified++;second.abort();},client:{async syncGroup(g,o){
    await o.onPage({messages:[m('120')],nextCursor:'119',coverage:cov});
    assert.fail('post-commit abort must stop before another page');
  }}}),error=>error.code==='ABORTED');
  assert.equal(notified,1);assert.deepEqual(store.get('w').messages.map(message=>message.id),['100','120']);
  assert.deepEqual(store.get('w').groups[0].latestPending,{cursor:'119',baselineId:'100',arrivalAfterId:'100'});
});
test('unselected group and demo data cannot trigger requests',async t=>{
  const {store}=fixture(t);store.update('w',s=>{s.groups[0].selected=false;});
  await assert.rejects(syncAccount({store,accountId:'w',client:{}}),/选择/);
  const demo=store.seedDemo();await assert.rejects(syncAccount({store,accountId:demo.id,client:{}}),/不连接/);
});
