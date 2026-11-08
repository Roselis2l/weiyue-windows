'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('../app/core/store.cjs');
const cleanup=require('../app/core/message-cleanup.cjs');
const {createMessageCleanupController}=require('../app/core/message-cleanup-controller.cjs');
const START=Date.parse('2026-10-21T09:00:00+08:00');
const selection=(extra={})=>({accountId:'alice',groupId:'g',startMinute:'2026-10-21T09:00',endMinute:'2026-10-21T09:08',markUnreadAsRead:true,...extra});
function setup(t,taskOptions={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'weiyue-unread-cleanup-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const store=new Store(root);
 for(const accountId of ['alice','bob']){
  store.ensureAccount({id:accountId,name:'Synthetic',kind:'import'});
  store.mergeMessages(accountId,[{id:'g',name:'G'},{id:'other',name:'Other'}],['g','other'].flatMap(groupId=>Array.from({length:11},(_,i)=>({id:String(i),groupId,senderId:i===4?'retained':'member',senderName:'Synthetic',text:'Synthetic '+i,time:START+i*60000}))));
  store.update(accountId,state=>{for(const groupId of ['g','other'])state.readStates[groupId]={anchorId:'2',anchorOffset:12,atBottom:false,readThroughId:'0',unreadIds:['1','2','3','4','5','6','7','8','9','10'],updatedAt:0};state.groups[0].latestPendingRanges=[{arrivalAfterId:'5',baselineId:'0',cursor:'1'}];});
  store.bookmark(accountId,{groupId:'g',messageIds:['3'],note:'Synthetic',tags:[]});
 }
 let context={accountId:'alice',epoch:1,busy:false,closing:false};
 const controller=createMessageCleanupController({store,getContext:()=>context,taskOptions});
 return {store,root,controller,file:store._file('alice'),switchAccount:()=>{context={...context,accountId:'bob',epoch:2};}};
}
const request=plan=>({accountId:'alice',groupId:'g',confirmationToken:plan.confirmationToken,confirmed:true});
test('option is strict boolean, defaults false and legacy batch validation does not migrate field',t=>{
 const {store}=setup(t);assert.equal(cleanup.normalizeSelection(selection({markUnreadAsRead:undefined})).markUnreadAsRead,false);
 for(const value of [null,0,1,'true',[],{}])assert.throws(()=>cleanup.normalizeSelection(selection({markUnreadAsRead:value})));
 const plan=store.previewMessageCleanup('alice',selection({markUnreadAsRead:false}));assert.equal(plan.markedReadCount,0);assert.equal(plan.unreadCount,8);assert.equal(plan.retainedUnreadCount,8);
});
for(const mode of ['recycle','permanent'])test(mode+' marks only deleted unread; preserves protected/out-of-range/group/account and high-water',async t=>{
 const {store,root,controller,file}=setup(t);const before=store.get('alice'),bob=fs.readFileSync(store._file('bob')),bytes=fs.readFileSync(file);
 const plan=await controller.preview(selection({mode,retainSenderIds:['retained']}));
 const marked=mode==='permanent'?6:4,deleted=mode==='permanent'?7:4;
 assert.equal(plan.unreadCount,8);assert.equal(plan.markedReadCount,marked);assert.equal(plan.retainedUnreadCount,8-marked);assert.equal(plan.deleteCount,deleted);assert.deepEqual(fs.readFileSync(file),bytes);
 assert.equal(plan.sample.find(row=>row.id==='1').markAsRead,true);assert.equal(plan.sample.find(row=>row.id==='3').markAsRead,false);
 const result=await controller.apply(request(plan));assert.equal(result.markedReadCount,marked);assert.equal(result.deletedCount,deleted);assert.equal(controller.status({accountId:'alice'}).result.markedReadCount,marked);
 const after=new Store(root).get('alice');assert.deepEqual(after.readStates.g.unreadIds,mode==='permanent'?['3','4','9','10']:['2','3','4','5','9','10']);
 if(mode==='recycle'){for(const key of ['anchorId','anchorOffset','atBottom','readThroughId'])assert.deepEqual(after.readStates.g[key],before.readStates.g[key]);}else{assert.equal(after.readStates.g.anchorId,'3');assert.equal(after.readStates.g.anchorOffset,0);assert.equal(after.readStates.g.readThroughId,null);}
 assert.deepEqual(after.readStates.other,before.readStates.other);if(mode==='recycle')assert.deepEqual(after.groups,before.groups);else{assert.equal(after.groups[0].historyBoundary.start,START+9*60000);assert.deepEqual(after.groups[1],before.groups[1]);}assert.deepEqual(fs.readFileSync(store._file('bob')),bob);
 if(mode==='recycle'){await controller.restore({accountId:'alice',groupId:'g',batchId:result.batchId});assert.deepEqual(store.get('alice').readStates.g.unreadIds,after.readStates.g.unreadIds);assert.equal(store.listMessageTrash('alice')[0].selection.markUnreadAsRead,true);}
});
for(const mode of ['recycle','permanent'])test(mode+' unread-only change invalidates opted-in preview without write',async t=>{
 const {store,controller,file}=setup(t);const plan=await controller.preview(selection({mode}));
 store.update('alice',state=>{state.readStates.g.unreadIds=state.readStates.g.unreadIds.filter(id=>id!=='1');});const bytes=fs.readFileSync(file);
 await assert.rejects(controller.apply(request(plan)));assert.deepEqual(fs.readFileSync(file),bytes);await assert.rejects(async()=>controller.apply(request(plan)));
});
for(const mode of ['recycle','permanent'])test(mode+' worker persistence failure rolls back marking and deletion together',async t=>{
 const {store,controller,file}=setup(t,{rename:async()=>{throw Error('Synthetic failure');}});const plan=await controller.preview(selection({mode})),bytes=fs.readFileSync(file),cached=store.getSnapshot('alice');
 await assert.rejects(controller.apply(request(plan)));assert.deepEqual(fs.readFileSync(file),bytes);assert.strictEqual(store.getSnapshot('alice'),cached);assert.equal(store.isWriteLocked('alice'),false);
});
test('cross-account confirmation cannot apply unread choice',async t=>{
 const {controller,file,switchAccount}=setup(t);const plan=await controller.preview(selection()),bytes=fs.readFileSync(file);switchAccount();await assert.rejects(async()=>controller.apply(request(plan)));assert.deepEqual(fs.readFileSync(file),bytes);
});
test('purge does not inherit permission to mark a subsequently unread recycled row',t=>{
 const {store}=setup(t);const state=store.get('alice'),input=selection();const plan=cleanup.previewMessageCleanup(state,input),result=cleanup.applyMessageCleanup(state,input,plan.fingerprint);
 state.readStates.g.unreadIds.push('1');const purge=cleanup.previewMessagePurge(state,{groupId:'g',batchIds:[result.batchId]});assert.equal(purge.reasonCounts.unread,1);assert.equal(purge.sample.find(row=>row.id==='1').action,'retain');
});
for(const mode of ['recycle','permanent'])test(mode+' processing error leaves core state and unread snapshot unchanged',t=>{
 const {store}=setup(t);const state=store.get('alice'),before=structuredClone(state),input=selection({mode}),plan=cleanup.previewMessageCleanup(state,input);
 assert.throws(()=>cleanup.applyMessageCleanup(state,input,plan.fingerprint,{onProgress:p=>{if(p.phase==='processing'&&p.processed>0)throw Error('Synthetic callback failure');}}));assert.deepEqual(state,before);
});
test('worker lock prevents competing read-state write while atomic candidate is prepared',async t=>{
 let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);
 const {store,controller,file}=setup(t,{rename:async(from,to)=>{entered();await gate;return fs.promises.rename(from,to);}});
 const plan=await controller.preview(selection()),bytes=fs.readFileSync(file),running=controller.apply(request(plan));await ready;
 try{assert.throws(()=>store.update('alice',state=>{state.readStates.g.unreadIds=[];}));assert.deepEqual(fs.readFileSync(file),bytes);}finally{release();}
 assert.equal((await running).markedReadCount,5);assert.deepEqual(store.get('alice').readStates.g.unreadIds,['2','3','5','9','10']);
});
test('legacy batches stay absent-field compatible, and enabling option changes fingerprint',t=>{
 const {store}=setup(t);const state=store.get('alice'),input=selection({markUnreadAsRead:false,startMinute:'2026-10-21T09:09',endMinute:'2026-10-21T09:10'});
 state.readStates.g.unreadIds=[];const plan=cleanup.previewMessageCleanup(state,input);const enabled=cleanup.previewMessageCleanup(state,{...input,markUnreadAsRead:true});assert.notEqual(plan.fingerprint,enabled.fingerprint);
 cleanup.applyMessageCleanup(state,input,plan.fingerprint);delete state.messageTrash[0].selection.markUnreadAsRead;
 const normalized=cleanup.validateMessageTrash(state.messageTrash,state.messages,state.groups);assert.equal(Object.hasOwn(normalized[0].selection,'markUnreadAsRead'),false);
});
test('zero eligible unread does not mark protected rows or write a no-op',async t=>{
 const {store,controller,file}=setup(t);const plan=await controller.preview(selection({startMinute:'2026-10-21T09:02',endMinute:'2026-10-21T09:03'}));assert.equal(plan.unreadCount,2);assert.equal(plan.markedReadCount,0);assert.equal(plan.retainedUnreadCount,2);
 const bytes=fs.readFileSync(file),result=await controller.apply(request(plan));assert.equal(result.deleted,false);assert.equal(result.markedReadCount,0);assert.deepEqual(fs.readFileSync(file),bytes);
});
test('unread opt-in preserves summary citations, ranges and uncertain provenance',t=>{
 const {store}=setup(t);const state=store.get('alice');state.summaries=[{id:'s',groupId:'g',start:START+60000,end:START+8*60000,refs:[{id:'1',groupId:'g',time:START+60000}]}];
 let plan=cleanup.previewMessageCleanup(state,selection());assert.equal(plan.sample.find(row=>row.id==='1').action,'retain');assert.equal(plan.sample.find(row=>row.id==='6').action,'retain');
 plan=cleanup.previewMessageCleanup(state,selection({retainSummaryRanges:false}));assert.equal(plan.sample.find(row=>row.id==='1').action,'retain');assert.equal(plan.sample.find(row=>row.id==='6').markAsRead,true);
 state.summaries[0].refs=null;plan=cleanup.previewMessageCleanup(state,selection());assert.equal(plan.markedReadCount,0);assert.equal(plan.deleteCount,0);assert.equal(plan.retainedUnreadCount,8);
});
