'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('../app/core/store.cjs');
const {syncAccount}=require('../app/core/sync-service.cjs');
const {RefreshPlan}=require('../app/core/refresh-plan.cjs');
const {effectiveOfflineMessages,matchesOfflineScan}=require('../app/core/offline-messages.cjs');
const floor=Date.parse('2026-11-07T16:00:00Z');
const m=(id,time=floor+Number(id)*1000,groupId='g')=>({id,groupId,senderId:'u',senderName:'U',text:'mock',time});
function fixture(t,mode='auto') { const root=fs.mkdtempSync(path.join(os.tmpdir(),'wy-bound-sync-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true})); const store=new Store(root);store.ensureAccount({id:'w',name:'W',kind:'weibo'});store.mergeMessages('w',[{id:'g',name:'G',selected:true}],[]);store.update('w',s=>{s.schemaVersion=5;s.settings.offlineMessages={mode};s.groups[0].historyBoundary={start:floor,updatedAt:floor+1000};});return {store,root};}
const opt=(store,client,extra={})=>({store,accountId:'w',continuous:true,maxPages:8,pageDelayMs:500,timeBudgetMs:10000,sleep:async()=>{},client,...extra});
const page=(messages,nextCursor,reachedStop=false)=>({messages,nextCursor,reachedStop});
test('group effective floor is exact minute, max with date, unchanged none and other groups',()=>{
 const group={historyBoundary:{start:floor+60000}};const policy=effectiveOfflineMessages(group,{mode:'auto'});assert.equal(policy.cutoff,floor+60000);assert.equal(policy.date,'2026-11-08');assert.equal(matchesOfflineScan({date:'2026-11-08'},policy),false);assert.equal(matchesOfflineScan({date:'2026-11-08',cutoff:floor+60000},policy),true);assert.equal(effectiveOfflineMessages(group,{mode:'date',date:'2026-11-09'}).cutoff,floor+86400000);assert.equal(effectiveOfflineMessages(group,{mode:'none'}).mode,'none');assert.deepEqual(effectiveOfflineMessages({}, {mode:'auto'}),{mode:'auto'});
});
test('auto boundary rescans retained interval through mixed timestamps, persists and never resurrects old row',async t=>{
 const {store,root}=fixture(t);store.mergeMessages('w',[],[m('200')]);const calls=[];
 await syncAccount(opt(store,{async syncGroup(id,o){calls.push(o.before);await o.onPage(o.before===undefined?page([m('300'),m('200')],'199',true):o.before==='199'?page([m('100',floor),m('90',floor-1)],'89'):page([m('80',floor-2)],'79'));return {pages:1};}}));
 assert.deepEqual(calls,[undefined,'199','89']);const state=new Store(root).get('w');assert.deepEqual(state.messages.map(m=>m.id),['100','200','300']);assert.equal(state.groups[0].offlineDateScan.cutoff,floor);assert.equal(state.groups[0].offlineDateScan.complete,true);assert.deepEqual(state.groups[0].latestPendingRanges,[]);
});
test('none keeps new heads but auto re-entry still verifies boundary, unrelated group unaffected',async t=>{
 const {store}=fixture(t,'none');store.mergeMessages('w',[{id:'h',name:'H',selected:true}],[]);await syncAccount(opt(store,{async syncGroup(id,o){await o.onPage(page([m('100',floor-1,id),m('200',floor+1,id)],null));return {pages:1};}}));assert.equal(store.get('w').messages.filter(x=>x.groupId==='g').length,1);assert.equal(store.get('w').messages.filter(x=>x.groupId==='h').length,2);assert.equal(store.get('w').groups[0].offlineDateScan.complete,false);store.update('w',s=>{s.settings.offlineMessages={mode:'auto'};});const plan=new RefreshPlan({now:()=>1000});plan.recordHead('g');assert.equal(plan.plan([store.get('w').groups[0]],null,{mode:'auto'}).hasWork,true);
});
test('explicit older history advances mixed page then stops at deletion floor',async t=>{
 const {store}=fixture(t);store.mergeMessages('w',[],[m('300')]);store.update('w',s=>{s.groups[0].nextCursor='299';});const calls=[];
 await syncAccount(opt(store,{async syncGroup(id,o){calls.push(o.before);await o.onPage(o.before==='299'?page([m('200',floor),m('190',floor-1)],'189'):page([m('180',floor-2)],'179'));return {pages:1};}},{history:true}));assert.deepEqual(calls,['299','189']);assert.equal(store.get('w').groups[0].historyExhausted,true);assert.equal(store.get('w').groups[0].nextCursor,null);assert.deepEqual(store.get('w').messages.map(x=>x.id),['200','300']);
});
test('empty response before floor stays unresolved and planner observes retry cooldown',async t=>{
 const {store}=fixture(t);await syncAccount(opt(store,{async syncGroup(id,o){await o.onPage(page([m('200')],null));return {pages:1};}}));const group=store.get('w').groups[0];assert.equal(group.offlineDateScan.complete,false);assert.equal(group.offlineDateScan.unresolved,true);let now=1000;const plan=new RefreshPlan({now:()=>now});plan.recordHead('g');plan.recordUnresolvedAttempt('g');assert.equal(plan.plan([group],null,{mode:'auto'}).hasWork,false);now+=60000;assert.deepEqual(plan.plan([group],null,{mode:'auto'}).retryUnresolvedGroupIds,['g']);
});
test('recovery ignores offline none only for explicitly requested interval and survives restart',async t=>{
 let {store,root}=fixture(t,'none');const start=floor-86400000,end=floor;
 store.update('w',s=>{s.groups[0].historyRestoreRanges=[{start,end}];s.groups[0].historyRecovery={start,end,cursor:null,complete:false,unresolved:false};});
 await syncAccount(opt(store,{async syncGroup(id,o){await o.onPage(page([m('200',start+1000),m('300',end+1)],'199'));return {pages:1};}},{headGroupIds:[],maxPages:1}));store=new Store(root);assert.equal(store.get('w').groups[0].historyRecovery.cursor,'199');assert.deepEqual(store.get('w').messages.map(x=>x.id),['200']);
 await syncAccount(opt(store,{async syncGroup(id,o){assert.equal(o.before,'199');await o.onPage(page([m('100',start),m('90',start-1)],'89'));return {pages:1};}},{headGroupIds:[],maxPages:1}));
 await syncAccount(opt(store,{async syncGroup(id,o){assert.equal(o.before,'89');await o.onPage(page([m('80',start-2)],'79'));return {pages:1};}},{headGroupIds:[]}));const s=store.get('w');assert.equal(s.groups[0].historyRecovery.complete,true);assert.equal(s.groups[0].historyBoundary.start,floor);assert.deepEqual(s.messages.map(x=>x.id),['100','200']);assert.equal(s.readStates.g.unreadIds.length,0);
});
test('recovery empty page remains retryable at cooldown and does not mark range complete',async t=>{
 const {store}=fixture(t,'none'),start=floor-10000,end=floor;store.update('w',s=>{s.groups[0].historyRestoreRanges=[{start,end}];s.groups[0].historyRecovery={start,end,cursor:null,complete:false,unresolved:false};});await syncAccount(opt(store,{async syncGroup(id,o){await o.onPage(page([],null));return {pages:1};}},{headGroupIds:[]}));const g=store.get('w').groups[0];assert.equal(g.historyRecovery.complete,false);assert.equal(g.historyRecovery.unresolved,true);const planner=new RefreshPlan({now:()=>1000});assert.deepEqual(planner.plan([g],null,{mode:'none'}).retryUnresolvedGroupIds,['g']);planner.recordHead('g');planner.recordUnresolvedAttempt('g');assert.equal(planner.plan([g],null,{mode:'none'}).hasWork,false);
});

test('late response from old deletion revision cannot certify or advance new retained range',async t=>{
 const {store}=fixture(t);let calls=0;await syncAccount(opt(store,{async syncGroup(id,o){calls++;if(calls===1){store.update('w',s=>{s.groups[0].historyRevision=1;s.groups[0].historyBoundary.start=floor+60000;delete s.groups[0].offlineDateScan;});await o.onPage(page([m('100',floor-1)],'99'));assert.equal(store.get('w').groups[0].offlineDateScan,undefined);}else await o.onPage(page([m('300',floor+120000)],'299'));return {pages:1};}},{maxPages:1}));assert.equal(calls,2);const scan=store.get('w').groups[0].offlineDateScan;assert.equal(scan.complete,false);assert.equal(scan.cutoff,floor+60000);assert.equal(scan.cursor,'299');
});
test('head arrival after complete retained scan reopens independent gap without deep rescan',async t=>{
 const {store}=fixture(t);store.mergeMessages('w',[],[m('200')]);store.update('w',s=>{s.groups[0].offlineDateScan={date:'2026-11-08',cutoff:floor,cursor:'99',complete:true,reachedDate:true,unresolved:false,arrivalAfterId:'200',nextHead:false};});const calls=[];await syncAccount(opt(store,{async syncGroup(id,o){calls.push(o.before);await o.onPage(o.before===undefined?page([m('400')],'399'):page([m('300'),m('200')],'199',true));return {pages:1};}}));assert.deepEqual(calls,[undefined,'399']);assert.equal(store.get('w').groups[0].offlineDateScan.headPending,undefined);assert.equal(store.get('w').groups[0].offlineDateScan.complete,true);
});

test('none head checks retain disconnected intervals of a completed bounded scan across restart and auto resume',async t=>{
 let {store,root}=fixture(t);store.mergeMessages('w',[],[m('100')]);store.update('w',s=>{s.groups[0].offlineDateScan={date:'2026-11-08',cutoff:floor,cursor:'99',complete:true,reachedDate:true,unresolved:false,arrivalAfterId:'100',nextHead:false};s.settings.offlineMessages={mode:'none'};});
 const pausedCalls=[];let next=300;for(let i=0;i<2;i++){await syncAccount(opt(store,{async syncGroup(id,o){pausedCalls.push(o.before);await o.onPage(page([m(String(next))],String(next-1)));next+=100;return {pages:1};}}));}
 assert.deepEqual(pausedCalls,[undefined,undefined]);store=new Store(root);let scan=store.get('w').groups[0].offlineDateScan;assert.equal(scan.complete,true);assert.equal(scan.headPending.baselineId,'100');assert.equal(scan.headPending.arrivalAfterId,'100');assert.equal(scan.headPending.cursor,'399');
 store.update('w',s=>{s.settings.offlineMessages={mode:'auto'};});const calls=[];await syncAccount(opt(store,{async syncGroup(id,o){calls.push(o.before);await o.onPage(o.before==='399'?page([m('350'),m('300'),m('250')],'249'):page([m('200'),m('100')],'99',true));return {pages:1};}},{headGroupIds:[]}));
 assert.deepEqual(calls,['399','249']);assert.deepEqual(store.get('w').messages.map(x=>x.id),['100','200','250','300','350','400']);scan=store.get('w').groups[0].offlineDateScan;assert.equal(scan.headPending,undefined);assert.equal(scan.complete,true);
});
