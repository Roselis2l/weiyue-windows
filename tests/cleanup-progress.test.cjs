'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {describe,matchesContext,needsReadingRefresh,queryCleanedWindow}=require('../app/renderer/cleanup-progress.js');
const message=id=>({id:String(id),groupId:'g',text:'synthetic'});
const operation={accountId:'a',epoch:7,groupId:'g'};
const context={accountId:'a',epoch:7,groupId:'g',view:'read',closing:false};
function queryFixture(ids){
  const calls=[],messages=ids.map(message);
  const query=async p=>{calls.push({...p});let offset=p.offset||0;if(p.startId){offset=messages.findIndex(m=>m.id===p.startId);if(offset<0){const e=Error('missing');e.code='PAGE_ANCHOR_MISSING';throw e;}}return{messages:messages.slice(offset,offset+p.limit),offset,total:messages.length,revision:10};};
  return{query,calls};
}
test('progress uses actual stage counts and never a made-up percentage',()=>{
  assert.deepEqual(describe({kind:'permanent',phase:'processing',processed:37,total:91,running:true}),{label:'永久删除 · 正在处理消息',detail:'本阶段已处理 37 / 91 条',running:true});
  for(const values of [{processed:null,total:null},{processed:100,total:50},{processed:NaN,total:1},{processed:1.5,total:10}])assert.equal(describe({phase:'writing',...values}).detail,'');
  assert.equal(describe({phase:'writing'}).label,'本地数据操作 · 正在保存临时数据');
  assert.doesNotMatch(describe({phase:'processing',processed:1,total:2}).detail,/%/);
  assert.equal(describe({phase:'writing',processed:1024,total:4096,unit:'bytes'}).detail,'本阶段已处理 1024 / 4096 字节');
});
test('failure and completed-refresh detail remain distinct from processing',()=>{
  assert.equal(describe({kind:'purge',phase:'failed',error:'未提交'}).detail,'未提交');
  assert.equal(describe({kind:'recycle',phase:'completed',detail:'已保存，界面待刷新'}).detail,'已保存，界面待刷新');
  assert.match(describe({kind:'restore',phase:'committing'}).label,/恢复消息.*原子提交/);
});
test('context binding distinguishes account, epoch, group and view',()=>{
  assert.equal(matchesContext(operation,context),true);assert.equal(needsReadingRefresh(operation,context),true);
  for(const patch of [{accountId:'b'},{epoch:8},{closing:true}])assert.equal(matchesContext(operation,{...context,...patch}),false);
  for(const patch of [{groupId:'other'},{view:'bookmarks'}]){assert.equal(matchesContext(operation,{...context,...patch}),true);assert.equal(needsReadingRefresh(operation,{...context,...patch}),false);}
});
test('cleanup refresh preserves an existing viewport anchor and all filter arguments',async()=>{
  const f=queryFixture(Array.from({length:300},(_,i)=>i+1)),payload={groupId:'g',limit:160,offset:70,keyword:'keep',senderIds:['stable-id'],start:1,end:9,importantOnly:true};
  const result=await queryCleanedWindow({...f,payload,anchor:{anchorId:'100',anchorOffset:-12.25},candidates:['101']});
  assert.equal(result.offset,74);assert.deepEqual(result.anchor,{anchorId:'100',anchorOffset:-12.25});
  assert.equal(result.messages.length,160);
  for(const call of f.calls){assert.equal(call.groupId,'g');assert.equal(call.keyword,'keep');assert.deepEqual(call.senderIds,['stable-id']);assert.equal(call.start,1);assert.equal(call.end,9);assert.equal(call.importantOnly,true);assert.ok(call.limit<=160);}
});
test('deleted temporary anchor selects a surviving neighbor without marking anything read',async()=>{
  const f=queryFixture(['1','2','5','6','7']);
  const result=await queryCleanedWindow({...f,payload:{groupId:'g',limit:3,offset:99},anchor:{anchorId:'3',anchorOffset:14},candidates:['4','5','2']});
  assert.deepEqual(result.anchor,{anchorId:'5',anchorOffset:0});assert.equal(result.offset,0);
  assert.deepEqual(f.calls.slice(0,3).map(p=>p.startId),['3','4','5']);
  assert.ok(f.calls.every(p=>!Object.hasOwn(p,'readThroughId')));
});
test('when every old anchor is gone, offset clamps to the remaining page',async()=>{
  const f=queryFixture(['21','22','23']);
  const result=await queryCleanedWindow({...f,payload:{groupId:'g',limit:2,offset:999},anchor:{anchorId:'9'},candidates:['10','11']});
  assert.equal(result.offset,1);assert.equal(result.total,3);assert.equal(result.anchor,null);assert.deepEqual(result.messages.map(m=>m.id),['22','23']);
});
test('empty group returns a zero total and empty page rather than stale old rows',async()=>{
  const f=queryFixture([]),result=await queryCleanedWindow({...f,payload:{groupId:'g',limit:160,offset:200},anchor:{anchorId:'old'}});
  assert.deepEqual(result.messages,[]);assert.equal(result.total,0);assert.equal(result.offset,0);assert.equal(result.anchor,null);
});
test('anchor probes are bounded even for a large previously rendered window',async()=>{
  const f=queryFixture(['new']);
  const result=await queryCleanedWindow({...f,payload:{groupId:'g',limit:160,offset:0},anchor:{anchorId:'old'},candidates:Array.from({length:50000},(_,i)=>String(i))});
  assert.equal(result.total,1);assert.equal(f.calls.filter(p=>p.startId).length,9);assert.equal(f.calls.length,11);
});
test('non-anchor errors fail visibly instead of silently presenting an empty group',async()=>{
  const problem=Error('disk unavailable');let calls=0;
  await assert.rejects(queryCleanedWindow({query:async()=>{calls++;throw problem;},payload:{groupId:'g',limit:160},anchor:{anchorId:'1'}}),problem);
  assert.equal(calls,1);
});
test('stale account/group/filter return stops all later refresh requests',async()=>{
  let active=true,calls=0;
  await assert.rejects(queryCleanedWindow({query:async()=>{calls++;active=false;return{messages:[message('1')],total:1,offset:0};},payload:{groupId:'g',limit:160},anchor:{anchorId:'1'},active:()=>active}),e=>e.code==='CLEANUP_VIEW_CHANGED');
  assert.equal(calls,1);
});
test('initially stale result never issues a query',async()=>{
  let calls=0;await assert.rejects(queryCleanedWindow({query:async()=>{calls++;},payload:{},active:()=>false}),/已变化/);assert.equal(calls,0);
});
