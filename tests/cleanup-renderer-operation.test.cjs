'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const progress=require('../app/renderer/cleanup-progress.js');
const renderer=fs.readFileSync(require.resolve('../app/renderer/app.js'),'utf8');
const start=renderer.indexOf('function cleanupWorkActive()'),end=renderer.indexOf('\nasync function showMessageCleanup()',start);
assert(start>=0&&end>start);
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};}
function setup(){
  const apply=deferred(),calls=[],intervals=new Set();let status={accountId:'a',groupId:'g',jobId:'job',kind:'permanent',phase:'processing',running:true,processed:1,total:2};
  const model={state:{account:{id:'a'},groups:[{id:'g',name:'Synthetic'}]},accountEpoch:3,groupId:'g',view:'bookmarks',queryVersion:0,closing:false,cleanupOperation:null};
  const context=vm.createContext({model,window:{WeiyueCleanupProgress:progress,api:{call:async(action,payload)=>{calls.push({action,payload});if(action==='messages.cleanup.status')return status;return apply.promise;}}},
    $:()=>null,flushReading:async()=>calls.push({action:'flush'}),invalidateReadingIntent:()=>{},autoPage:{reset(){}},renderSyncStatus:()=>{},scheduleReadingRefresh:()=>{},
    refreshState:async()=>calls.push({action:'refresh-state'}),renderSidebar:()=>calls.push({action:'sidebar'}),renderHeader:()=>calls.push({action:'header'}),
    setInterval:callback=>{intervals.add(callback);return callback;},clearInterval:callback=>intervals.delete(callback),setTimeout,
  });
  vm.runInContext(renderer.slice(start,end),context);
  const spec={action:'messages.cleanup.apply',accountId:'a',groupId:'g',kind:'permanent',total:2,payload:{accountId:'a',groupId:'g',confirmationToken:'synthetic',confirmed:true},success:'已永久删除 2 条本地消息。',onStarted:()=>calls.push({action:'close-modal'})};
  return{context,model,calls,apply,intervals,spec,run:()=>context.performCleanupOperation(spec),setStatus:value=>status=value};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const result={accountId:'a',groupId:'g',deleted:true,deletedCount:2,mode:'permanent'};
test('confirmed submission closes modal before awaiting, polls real stages, and completes only after result',async()=>{
  const h=setup(),pending=h.run();await tick();
  assert.equal(h.model.cleanupOperation.running,true);assert.equal(h.calls.filter(c=>c.action==='messages.cleanup.apply').length,1);
  assert(h.calls.findIndex(c=>c.action==='close-modal')<h.calls.findIndex(c=>c.action==='messages.cleanup.apply'));
  for(const poll of h.intervals)await poll();await tick();assert.equal(h.model.cleanupOperation.status.phase,'processing');
  assert.equal(h.calls.some(c=>c.action==='refresh-state'),false);
  h.apply.resolve(result);await pending;
  assert.equal(h.model.cleanupOperation.running,false);assert.equal(h.model.cleanupOperation.status.phase,'completed');assert.equal(h.intervals.size,0);
  assert.equal(h.calls.filter(c=>c.action==='refresh-state').length,1);
});
test('simultaneous callers cannot double-submit even during the initial reading flush',async()=>{
  const h=setup(),pending=h.run();await assert.rejects(h.run(),/正在进行/);await tick();h.apply.resolve(result);await pending;
  assert.equal(h.calls.filter(c=>c.action==='messages.cleanup.apply').length,1);
});
test('switching account during job preserves original lock and ignores result for current view',async()=>{
  const h=setup(),pending=h.run();await tick();h.model.state.account={id:'b'};h.model.accountEpoch++;
  assert.equal(h.context.cleanupWorkActive(),true);for(const poll of h.intervals)await poll();
  h.apply.resolve(result);await pending;
  assert.equal(h.model.cleanupOperation.status.phase,'completed');assert.equal(h.context.cleanupWorkActive(),false);
  assert.equal(h.calls.some(c=>c.action==='refresh-state'),false);assert.equal(h.model.state.account.id,'b');
});
test('switching group never returns to operation group and refreshes current account metadata only',async()=>{
  const h=setup(),pending=h.run();await tick();h.model.groupId='other';h.apply.resolve(result);await pending;
  assert.equal(h.model.groupId,'other');assert.equal(h.model.view,'bookmarks');assert.equal(h.calls.filter(c=>c.action==='refresh-state').length,1);
});
test('failure is claimed uncommitted only with matching confirmed commit state',async()=>{
  const h=setup(),pending=h.run();await tick();h.setStatus({accountId:'a',groupId:'g',kind:'permanent',phase:'failed',commitState:'not-committed',error:'保存临时数据失败'});
  h.apply.reject(Error('保存失败'));await pending;
  assert.match(h.model.cleanupOperation.status.detail,/未提交，原数据保持/);assert.equal(h.calls.some(c=>c.action==='refresh-state'),false);
});
test('unknown commit outcome is never reported as unchanged or retried',async()=>{
  const h=setup(),pending=h.run();await tick();h.setStatus({accountId:'a',groupId:'g',kind:'permanent',phase:'uncertain',commitState:'uncertain'});
  h.apply.reject(Error('提交结果待核实'));await pending;
  assert.match(h.model.cleanupOperation.status.detail,/结果尚待核实/);assert.doesNotMatch(h.model.cleanupOperation.status.detail,/原数据保持/);
  assert.equal(h.model.cleanupOperation.status.phase,'uncertain');
  assert.equal(h.calls.filter(c=>c.action==='messages.cleanup.apply').length,1);
});
test('leaving the view while completion refresh awaits never leaves a false running-refresh label',async()=>{
  const h=setup();h.context.refreshState=async()=>{h.model.groupId='new-group';};
  const pending=h.run();await tick();h.apply.resolve(result);await pending;
  assert.equal(h.model.groupId,'new-group');assert.equal(h.model.cleanupOperation.status.phase,'completed');
  assert.equal(h.model.cleanupOperation.running,false);assert.equal(h.calls.some(c=>c.action==='sidebar'),false);
});
test('wrong count or identity response is explicitly uncertain and never applied to display',async()=>{
  for(const patch of [{deletedCount:1},{accountId:'b'},{groupId:'other'},{deleted:false}]){
    const h=setup(),pending=h.run();await tick();h.apply.resolve({...result,...patch});await pending;
    assert.equal(h.model.cleanupOperation.uncertain,true);assert.equal(h.calls.some(c=>c.action==='refresh-state'),false);assert.match(h.model.cleanupOperation.status.detail,/待核实/);
  }
});
test('UI refresh failure remains a completed data operation and offers refresh-only retry',async()=>{
  const h=setup();h.context.refreshState=async()=>{throw Error('read failed');};const pending=h.run();await tick();h.apply.resolve(result);await pending;
  assert.equal(h.model.cleanupOperation.refreshError,true);assert.equal(h.model.cleanupOperation.status.phase,'completed');assert.match(h.model.cleanupOperation.status.detail,/数据操作已完成/);
  h.context.refreshState=async()=>{};await h.context.refreshCleanupOutcome(h.model.cleanupOperation);
  assert.equal(h.model.cleanupOperation.refreshError,false);assert.equal(h.calls.filter(c=>c.action==='messages.cleanup.apply').length,1);
});
