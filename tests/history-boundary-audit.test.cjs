'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('../app/core/store.cjs'),{syncAccount}=require('../app/core/sync-service.cjs'),{saveOfflineMessages}=require('../app/core/offline-messages.cjs'),{groupStatus}=require('../app/renderer/sync-status.js');
const floor=Date.parse('2026-11-07T16:00:00Z'),m=id=>({id,groupId:'g',senderId:'u',senderName:'U',text:'synthetic',time:floor+Number(id)*1000});
test('audit: completed scan then none-mode head then auto must recover the missed retained interval',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'wy-audit-modes-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const store=new Store(root);store.ensureAccount({id:'w',name:'W',kind:'weibo'});store.mergeMessages('w',[{id:'g',name:'G',selected:true}],[m('200')]);
 store.update('w',s=>{s.schemaVersion=5;s.settings.offlineMessages={mode:'auto'};Object.assign(s.groups[0],{historyBoundary:{start:floor,updatedAt:floor},offlineDateScan:{date:'2026-11-08',cutoff:floor,cursor:'99',complete:true,reachedDate:true,unresolved:false,arrivalAfterId:'200',nextHead:false}});});
 const save=(prev,next)=>saveOfflineMessages({store,payload:{accountId:'w',expectedOfflineMessages:{mode:prev},offlineMessages:{mode:next}},getContext:()=>({accountId:'w',epoch:1,busy:false,closing:false})});
 const opts={store,accountId:'w',continuous:true,maxPages:8,pageDelayMs:500,timeBudgetMs:10000,sleep:async()=>{}};
 save('auto','none');
 await syncAccount({...opts,client:{async syncGroup(_id,o){await o.onPage({messages:[m('400')],nextCursor:'399',reachedStop:false});return{pages:1};}}});
 save('none','auto');
 await syncAccount({...opts,client:{async syncGroup(_id,o){await o.onPage(o.before===undefined?{messages:[m('400')],nextCursor:'399',reachedStop:true}:o.before==='399'?{messages:[m('300'),m('200')],nextCursor:'199',reachedStop:true}:{messages:[{...m('100'),time:floor-1}],nextCursor:'99',reachedStop:false});return{pages:1};}}});
 assert(store.get('w').messages.some(x=>x.id==='300'),'retained-range message300 must not be lost after none→auto');
});
test('audit: middle-deletion history and recovery have status even without a retained floor',()=>{
 const status=groupStatus({id:'g',historyDeletedRanges:[{start:floor,end:floor+1000}],historyRecovery:{start:floor,end:floor+1000,cursor:null,complete:false,unresolved:false}}, {offlineMessages:{mode:'none'}});
 assert.match(status.text,/主动删除/);assert.match(status.text,/重新获取/);assert.equal(status.needsBackfill,true);
});


test('audit: unrelated head progress does not expire recovery preview; deletion-policy revision does',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'wy-audit-token-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const store=new Store(root);store.ensureAccount({id:'w',name:'W',kind:'weibo'});store.mergeMessages('w',[{id:'g',name:'G',selected:true}],[m('200')]);
 store.update('w',s=>{s.schemaVersion=5;Object.assign(s.groups[0],{historyBoundary:{start:floor,updatedAt:floor},historyRevision:1});});
 const history=require('../app/core/history-boundary.cjs'),sel={groupId:'g',startMinute:'2026-11-06T00:00',endMinute:'2026-11-06T23:59'};
 const plan=history.recoveryPreview(store.get('w'),sel);
 store.update('w',s=>{s.groups[0].syncProgress={phase:'joined',added:0,pages:1,scannedUntil:null,updatedAt:floor+5000,reason:'new head'};});
 assert.equal(history.recoveryPreview(store.get('w'),sel).fingerprint,plan.fingerprint);
 const staged=store.get('w');assert.equal(history.recoveryApply(staged,sel,plan.fingerprint).recoveryQueued,true);
 store.update('w',s=>{s.groups[0].historyRevision=2;s.groups[0].historyDeletedRanges=[{start:floor-86400000,end:floor}];});
 assert.throws(()=>store.applyHistoryRecovery('w',sel,plan.fingerprint),/状态已变化/);
});

