'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {Store,validateState}=require('../app/core/store.cjs'),history=require('../app/core/history-boundary.cjs');
const t0=Date.parse('2026-11-07T00:00:00+08:00'),end=t0+86400000;
const msg=(id,time,groupId='g')=>({id:String(id),groupId,time,text:'synthetic '+id,senderId:'u',senderName:'合成'});
function setup(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'weiyue-boundary-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const store=new Store(root);store.ensureAccount({id:'a',name:'合成',kind:'import'});store.mergeMessages('a',[{id:'g',name:'示例群',selected:true},{id:'h',name:'另一群'}],[msg('10',t0-86400000),msg('20',t0+1000),msg('30',end+1000),msg('40',end+2000),msg('50',end+3000),msg('60',t0,'h')]);return{store,root};}
const selection=(over={})=>({groupId:'g',startMinute:'2026-01-01T00:00',endMinute:'2026-11-07T23:59',mode:'permanent',retainSenderIds:[],retainSummaryRanges:false,markUnreadAsRead:true,...over});
function apply(store,sel=selection()){const p=store.previewMessageCleanup('a',sel);return store.applyMessageCleanup('a',sel,p.fingerprint);}
test('prefix deletion removes old continuation body, advances group only, persists schema5 and blocks stale sync',t=>{
 const{store,root}=setup(t);store.update('a',s=>{s.groups[0].latestPendingRanges=[{cursor:'29',baselineId:'10',arrivalAfterId:'10',status:'pending'}];s.groups[0].nextCursor='9';s.readStates.g={anchorId:'20',anchorOffset:18,atBottom:false,readThroughId:'20',unreadIds:['30','40'],updatedAt:1};s.readPositions.g='20';});
 const stale=store.get('a').groups[0],p=store.previewMessageCleanup('a',selection());assert.equal(p.deleteCount,2);assert.equal(p.boundaryPlan.newStart,end);
 apply(store);let s=store.get('a');assert.equal(s.groups[0].historyBoundary.start,end);assert.equal(s.groups[1].historyBoundary,undefined);assert.equal(s.groups[0].latestPendingRanges.length,0);assert.equal(s.readStates.g.anchorId,'30');assert.equal(s.readStates.g.readThroughId,null);assert.deepEqual(s.readStates.g.unreadIds,['30','40']);assert.equal(s.schemaVersion,5);
 store.mergeMessages('a',[stale],[msg('10',t0-86400000),msg('21',t0+2000),msg('70',end+4000)],{arrivalAfter:{g:'20'}});
 s=new Store(root).get('a');assert.equal(s.groups[0].historyBoundary.start,end);assert.deepEqual(s.groups[0].latestPendingRanges,[]);assert(!s.messages.some(m=>m.id==='10'||m.id==='21'));assert(s.messages.some(m=>m.id==='70'));assert.equal(s.groups[0].nextCursor,null);
});
test('middle deletion keeps group boundary and suppresses unseen same-window messages',t=>{
 const{store}=setup(t);apply(store,selection({startMinute:'2026-11-07T00:00'}));const s=store.get('a');assert.equal(s.groups[0].historyBoundary,undefined);assert(s.messages.some(m=>m.id==='10'));store.mergeMessages('a',[],[msg('22',t0+5000)]);assert(!store.get('a').messages.some(m=>m.id==='22'));
});
test('unread retained unless selected while old reading and sync anchors can move',t=>{
 const{store}=setup(t);store.update('a',s=>{s.readStates.g={anchorId:'10',anchorOffset:0,atBottom:false,readThroughId:'10',unreadIds:['20','30'],updatedAt:1};});
 apply(store,selection({markUnreadAsRead:false}));const s=store.get('a');assert(s.messages.some(m=>m.id==='20'));assert.deepEqual(s.readStates.g.unreadIds,['20','30']);assert.equal(s.readStates.g.anchorId,'20');assert.equal(s.readStates.g.readThroughId,null);
});
test('all removed leaves null read pointers and a finite floor not history exhausted',t=>{
 const{store}=setup(t);store.update('a',s=>{s.readStates.g.anchorId='50';s.readStates.g.readThroughId='50';s.readPositions.g='50';});
 apply(store,selection({endMinute:'2026-11-08T23:59'}));const s=store.get('a');assert.equal(s.readStates.g.anchorId,null);assert.equal(s.readStates.g.readThroughId,null);assert.equal(s.readPositions.g,undefined);assert.equal(s.groups[0].historyExhausted,false);assert(s.groups[0].historyBoundary.start>end);
});
test('protected bookmark retained below floor does not prevent later prefix advance',t=>{
 const{store}=setup(t);store.bookmark('a',{groupId:'g',messageIds:['10'],note:'keep',tags:[]});apply(store);assert(store.get('a').messages.some(m=>m.id==='10'));const p=store.previewMessageCleanup('a',selection({startMinute:'2026-11-08T00:00',endMinute:'2026-11-08T00:00'}));assert(p.boundaryPlan.advances);
});
test('explicit recovery only clears selected markers, keeps floor and requires valid fingerprint',t=>{
 const{store}=setup(t);apply(store);const sel={groupId:'g',startMinute:'2026-11-07T00:00',endMinute:'2026-11-07T23:59'},p=history.recoveryPreview(store.get('a'),sel);assert.equal(p.tombstoneCount,1);assert.throws(()=>store.applyHistoryRecovery('a',sel,'bad'));
 store.applyHistoryRecovery('a',sel,p.fingerprint);const s=store.get('a');assert.equal(s.groups[0].historyBoundary.start,end);assert(s.messageTombstones.some(m=>m.id==='10'));assert(s.messageTombstones.some(m=>m.id==='20'));assert.equal(s.groups[0].historyRecovery.complete,false);
 store.mergeMessages('a',[],[msg('20',t0+1000),msg('21',t0+2000),msg('9',t0-5000)],{history:true});assert.deepEqual(store.get('a').messages.filter(m=>m.groupId==='g').map(m=>m.id),['20','21','30','40','50']);assert.throws(()=>history.recoveryPreview(store.get('a'),sel),/已有/);
});
test('redelete cancels overlapping pending recovery and revokes allowed interval',t=>{
 const{store}=setup(t);apply(store);const sel={groupId:'g',startMinute:'2026-11-07T00:00',endMinute:'2026-11-07T23:59'},p=history.recoveryPreview(store.get('a'),sel);store.applyHistoryRecovery('a',sel,p.fingerprint);store.mergeMessages('a',[],[msg('20',t0+1000)],{history:true});apply(store,selection({startMinute:'2026-11-07T00:00'}));const g=store.get('a').groups[0];assert.equal(g.historyRecovery,undefined);assert.deepEqual(g.historyRestoreRanges,[]);store.mergeMessages('a',[],[msg('21',t0+2000)]);assert(!store.get('a').messages.some(m=>m.id==='21'));
});
test('old schema cannot carry boundary; malformed states rejected',t=>{
 const{store}=setup(t);const s=store.get('a');s.groups[0].historyBoundary={start:end,updatedAt:1};assert.throws(()=>validateState(s,'a'),/版本/);s.schemaVersion=5;s.groups[0].historyBoundary.start='bad';assert.throws(()=>validateState(s,'a'));
});


test('real-worker recovery uses single-use account-bound confirmation and persists queue',async t=>{
 const{store,root}=setup(t);apply(store);
 const {createMessageCleanupController}=require('../app/core/message-cleanup-controller.cjs');
 let context={accountId:'a',epoch:1,busy:false,closing:false};const c=createMessageCleanupController({store,getContext:()=>context});
 const input={accountId:'a',groupId:'g',startMinute:'2026-11-07T00:00',endMinute:'2026-11-07T23:59'};
 const before=fs.readFileSync(store._file('a')),plan=await c.recoveryPreview(input);assert.deepEqual(fs.readFileSync(store._file('a')),before);
 await assert.rejects(async()=>c.recoveryApply({...input,confirmationToken:plan.confirmationToken,confirmed:false}));
 const plan2=await c.recoveryPreview(input);const result=await c.recoveryApply({...input,confirmationToken:plan2.confirmationToken,confirmed:true});assert.equal(result.recoveryQueued,true);assert.equal(result.commitState,'committed');
 await assert.rejects(async()=>c.recoveryApply({...input,confirmationToken:plan2.confirmationToken,confirmed:true}));assert.equal(new Store(root).get('a').groups[0].historyRecovery.complete,false);
});
test('failed recovery persistence leaves deletion policy and tombstones untouched',async t=>{
 const{store}=setup(t);apply(store);const {createMessageCleanupController}=require('../app/core/message-cleanup-controller.cjs');
 const c=createMessageCleanupController({store,getContext:()=>({accountId:'a',epoch:1,busy:false,closing:false}),taskOptions:{rename:async()=>{throw Error('synthetic');}}});
 const plan=await c.recoveryPreview({accountId:'a',groupId:'g',startMinute:'2026-11-07T00:00',endMinute:'2026-11-07T23:59'}),before=fs.readFileSync(store._file('a'));
 await assert.rejects(c.recoveryApply({accountId:'a',groupId:'g',confirmationToken:plan.confirmationToken,confirmed:true}));assert.deepEqual(fs.readFileSync(store._file('a')),before);
});

