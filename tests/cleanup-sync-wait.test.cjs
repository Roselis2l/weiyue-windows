'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createMessageCleanupController,TTL_MS}=require('../app/core/message-cleanup-controller.cjs');
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function fixture(){
  const context={accountId:'a',epoch:1,busy:false,closing:false},writes=[],sleeps=[];let clock=1000,changed=false;
  const store={runCleanupTask:async(account,action,payload)=>{
    if(action==='preview'||action==='purgePreview')return {selection:{groupId:'g',mode:payload.mode||'recycle'},fingerprint:'original'};
    if(changed)throw Error('范围已变化，请重新预览');
    writes.push({account,action,payload});return {deleted:action==='apply',purged:action==='purgeApply',restored:action==='restore',deletedCount:2,purgedCount:2,restoredCount:2};
  }};
  const controller=createMessageCleanupController({store,getContext:()=>context,waitForIdle:true,waitTimeoutMs:500,now:()=>clock,sleep:()=>{const wait=deferred();sleeps.push(wait);return wait.promise;}});
  const p={accountId:'a',groupId:'g'};
  return {controller,context,writes,p,sleeps,advance:ms=>clock+=ms,change:()=>changed=true,wake:()=>sleeps.shift().resolve(),
    confirm:async(mode='recycle')=>({...p,mode,confirmed:true,requestId:'req',confirmationToken:(await controller.preview({...p,mode})).confirmationToken})};
}
for(const mode of ['recycle','permanent'])test(mode+' waits for existing synchronization, reserves priority, then uses original selection once',async()=>{
  const f=fixture(),p=await f.confirm(mode);f.context.busy=true;
  const pending=f.controller.apply({...p,mode:'tampered',groupId:'g'});
  assert.equal(f.writes.length,0);assert.equal(f.controller.isBusy(),true);
  assert.equal(f.controller.status(p).phase,'waiting');
  assert.throws(()=>f.controller.apply(p),/已提交/);
  assert.throws(()=>f.controller.apply({...p,requestId:'duplicate'}),/已有操作/);
  assert.equal(f.controller.status({...p,requestId:'duplicate'}).phase,'not-started');
  assert.equal(f.controller.status(p).phase,'waiting');
  assert.throws(()=>f.controller.preview(f.p),/已有操作/);
  let idle=false;const stopped=f.controller.whenIdle().then(()=>idle=true);await Promise.resolve();assert.equal(idle,false);
  f.context.busy=false;f.wake();await pending;await stopped;
  assert.equal(f.writes.length,1);assert.equal(f.writes[0].payload.selection.mode,mode);assert.equal(f.writes[0].payload.fingerprint,'original');
  assert.equal(f.controller.status(p).phase,'completed');assert.equal(f.controller.isBusy(),false);
  assert.throws(()=>f.controller.apply({...p,requestId:'replay'}),/失效/);
});
for(const change of ['account','epoch','closing','clear','timeout','expiry'])test('queued mutation cancels without writes on '+change,async()=>{
  const f=fixture(),p=await f.confirm('permanent');f.context.busy=true;const pending=f.controller.apply(p);
  if(change==='account')f.context.accountId='b';if(change==='epoch')f.context.epoch++;
  if(change==='closing')f.context.closing=true;if(change==='clear')f.controller.clear();
  if(change==='timeout')f.advance(500);if(change==='expiry')f.advance(TTL_MS);
  f.context.busy=false;f.wake();await assert.rejects(pending,/变化|关闭|超时|失效/);
  assert.equal(f.writes.length,0);assert.equal(f.controller.isBusy(),false);
  f.context.accountId='a';assert.equal(f.controller.status(p).phase,'not-started');
  assert.equal(f.controller.status(p).commitState,'not-committed');
});
test('fingerprint remains authoritative after sync changes protection state',async()=>{
  const f=fixture(),p=await f.confirm();f.context.busy=true;const pending=f.controller.apply(p);
  f.change();f.context.busy=false;f.wake();await assert.rejects(pending,/重新预览/);
  assert.equal(f.writes.length,0);assert.equal(f.controller.status(p).phase,'failed');
  assert.equal(f.controller.status(p).commitState,'not-committed');
});
test('missing or stale confirmation gives a request-scoped not-started state, not prior preview success',async()=>{
  const f=fixture(),p=await f.confirm();
  assert.throws(()=>f.controller.apply({...p,confirmed:false}),/预览/);
  assert.equal(f.controller.status(p).phase,'not-started');assert.equal(f.writes.length,0);
  assert.equal(f.controller.status({...p,requestId:'other'}).phase,'idle');
});
for(const kind of ['purge','restore'])test(kind+' also waits for sync without bypassing single-flight',async()=>{
  const f=fixture(),p={...f.p,requestId:'req',confirmed:true,batchId:'batch'};
  if(kind==='purge')p.confirmationToken=(await f.controller.purgePreview(f.p)).confirmationToken;
  f.context.busy=true;const pending=kind==='purge'?f.controller.purgeApply(p):f.controller.restore(p);
  assert.equal(f.controller.status(p).phase,'waiting');assert.equal(f.writes.length,0);
  f.context.busy=false;f.wake();await pending;assert.equal(f.writes.length,1);assert.equal(f.controller.isBusy(),false);
});

for(const mode of ['recycle','permanent'])test('real worker '+mode+' waits then commits only the captured synthetic range',async t=>{
  const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{Store}=require('../app/core/store.cjs');
  const base=path.resolve(os.tmpdir()),root=fs.mkdtempSync(path.join(base,'weiyue-sync-wait-'));
  t.after(()=>{assert.equal(path.dirname(root),base);assert(path.basename(root).startsWith('weiyue-sync-wait-'));fs.rmSync(root,{recursive:true,force:true});});
  const store=new Store(root);store.ensureAccount({id:'synthetic',name:'Synthetic',kind:'import'});
  const start=Date.parse('2026-10-21T09:00:00+08:00');
  store.mergeMessages('synthetic',[{id:'g',name:'Synthetic'}],[0,1,2].map(i=>({id:String(i+1),groupId:'g',senderId:'u',senderName:'Synthetic',text:'Synthetic '+i,time:start+i*60000})));
  const context={accountId:'synthetic',epoch:1,busy:false,closing:false},wait=deferred();let changes=0;
  const controller=createMessageCleanupController({store,getContext:()=>context,waitForIdle:true,sleep:()=>wait.promise,onChange:()=>changes++});
  const p={accountId:'synthetic',groupId:'g',mode,startMinute:'2026-10-21T09:00',endMinute:'2026-10-21T09:01'};
  const plan=await controller.preview(p),before=fs.readFileSync(store._file('synthetic'));context.busy=true;
  const pending=controller.apply({...p,requestId:'real-'+mode,confirmationToken:plan.confirmationToken,confirmed:true});
  assert.deepEqual(fs.readFileSync(store._file('synthetic')),before);
  context.busy=false;wait.resolve();const result=await pending;
  assert.equal(result.deletedCount,2);assert.equal(result.mode,mode);assert.equal(changes,1);
  assert.equal(new Store(root).queryMessages('synthetic',{groupId:'g'}).total,1);
  assert.equal(controller.isBusy(),false);
});
