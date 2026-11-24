'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('../app/core/store.cjs');
const {syncAccount}=require('../app/core/sync-service.cjs');
const {RefreshPlan}=require('../app/core/refresh-plan.cjs');
const {validateOfflineMessages,normalizeOfflineMessages,offlineCutoff,saveOfflineMessages}=require('../app/core/offline-messages.cjs');
const day={mode:'date',date:'2026-11-01'},cutoff=Date.parse('2026-10-31T16:00:00Z');
const m=(id,time=cutoff+Number(id)*1000)=>({id,groupId:'g',senderId:'u',senderName:'U',text:'mock',time});
function fixture(t,policy){const root=fs.mkdtempSync(path.join(os.tmpdir(),'wy-offline-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const store=new Store(root);store.ensureAccount({id:'w',name:'Mock',kind:'weibo'});store.mergeMessages('w',[{id:'g',name:'G',selected:true}],[]);if(policy)store.update('w',s=>{s.settings.offlineMessages=policy;});return {store,root};}
const options=(store,client,extra={})=>({store,accountId:'w',continuous:true,maxPages:8,pageDelayMs:500,timeBudgetMs:10000,sleep:async()=>{},client,...extra});
const page=(messages,nextCursor,reachedStop=false)=>({messages,nextCursor,reachedStop});
test('default auto and strict calendar validation with inclusive China midnight',()=>{
 assert.deepEqual(normalizeOfflineMessages(),{mode:'auto'});assert.equal(offlineCutoff(day),cutoff);
 for(const value of [null,[],{}, {mode:'bogus'},{mode:'auto',date:'2026-01-01'},{mode:'none',extra:true},...['2026-2-01','2026-02-29','2026-04-31','2026-00-01','2026-01-00','1969-12-31','2026-11-01T00:00:00Z'].map(date=>({mode:'date',date}))])assert.throws(()=>validateOfflineMessages(value));
 assert.deepEqual(validateOfflineMessages({mode:'date',date:'2024-02-29'}),{mode:'date',date:'2024-02-29'});
 assert.throws(()=>validateOfflineMessages(Object.defineProperty({},'mode',{get(){throw Error('must not run');},enumerable:true})),e=>e.code==='OFFLINE_INVALID');
});
test('account-bound save changes only policy, rejects stale, invalid, busy and disk failure atomically',t=>{
 const {store,root}=fixture(t);store.ensureAccount({id:'other',name:'Other',kind:'weibo'});store.update('w',s=>{s.settings.unrelated={keep:1};});
 let context={accountId:'w',epoch:1,busy:false,closing:false};const save=(offlineMessages,expectedOfflineMessages={mode:'auto'},accountId='w')=>saveOfflineMessages({store,getContext:()=>context,payload:{accountId,offlineMessages,expectedOfflineMessages}});
 save(day);assert.deepEqual(store.get('w').settings,{unrelated:{keep:1},offlineMessages:day});assert.deepEqual(normalizeOfflineMessages(store.get('other').settings.offlineMessages),{mode:'auto'});
 assert.throws(()=>save({mode:'none'}),e=>e.code==='OFFLINE_STALE');assert.throws(()=>save({mode:'none'},day,'other'),e=>e.code==='OFFLINE_ACCOUNT_CHANGED');
 context.busy=true;assert.throws(()=>save({mode:'none'},day),e=>e.code==='OFFLINE_BUSY');context.busy=false;
 const original=fs.renameSync;fs.renameSync=()=>{throw Error('disk failure');};try{assert.throws(()=>save({mode:'none'},day));}finally{fs.renameSync=original;}
 assert.deepEqual(new Store(root).get('w').settings.offlineMessages,day);
});
test('none still checks head, retains existing gaps and automatic switching resumes them',async t=>{
 const {store,root}=fixture(t,{mode:'none'});store.mergeMessages('w',[],[m('100'),m('200')]);store.update('w',s=>{s.groups[0].latestPendingRanges=[{cursor:'199',baselineId:'100',arrivalAfterId:'100',status:'pending'}];s.groups[0].syncNext='gap';});
 let calls=0;await syncAccount(options(store,{async syncGroup(id,o){calls++;assert.equal(o.before,undefined);await o.onPage(page([m('220')],'219'));return {pages:1};}}));
 assert.equal(calls,1);let state=store.get('w');assert.equal(state.groups[0].latestPendingRanges.length,2);assert.equal(state.groups[0].syncProgress.phase,'paused');
 const resumed=new Store(root);resumed.update('w',s=>{s.settings.offlineMessages={mode:'auto'};});await syncAccount(options(resumed,{async syncGroup(id,o){assert.equal(o.before,'199');await o.onPage(page([m('150'),m('100')],'99',true));return {pages:1};}},{maxPages:1}));
 assert.equal(resumed.get('w').groups[0].latestPendingRanges.length,1);
});
test('date traverses beyond local head, includes exact midnight and drops boundary-page older rows without next request',async t=>{
 const {store,root}=fixture(t,day);store.mergeMessages('w',[],[m('200')]);store.update('w',s=>{s.groups[0].nextCursor='150';});let calls=[];
 await syncAccount(options(store,{async syncGroup(id,o){calls.push(o.before);await o.onPage(o.before===undefined?page([m('300'),m('200')],'199',true):o.before==='199'?page([m('100',cutoff),m('90',cutoff-1)],'89'):page([m('80',cutoff-2)],'79'));return {pages:1};}}));
 assert.deepEqual(calls,[undefined,'199','89']);const state=new Store(root).get('w');assert.deepEqual(state.messages.map(m=>m.id),['100','200','300']);assert.equal(state.groups[0].offlineDateScan.reachedDate,true);assert.equal(state.groups[0].syncProgress.phase,'limited');assert.equal(state.groups[0].nextCursor,'150');
});
test('date continuation persists across batches and no-due-head restart, without touching saved pending ranges',async t=>{
 let {store,root}=fixture(t,day);store.mergeMessages('w',[],[m('100')]);store.update('w',s=>{s.groups[0].latestPendingRanges=[{cursor:'99',baselineId:'50',arrivalAfterId:'100',status:'unresolved'}];});
 await syncAccount(options(store,{async syncGroup(id,o){await o.onPage(page([m('200')],'199'));return {pages:1};}},{maxPages:1}));
 store=new Store(root);const before=store.get('w').groups[0].latestPendingRanges;
 await syncAccount(options(store,{async syncGroup(id,o){assert.ok(['199','139'].includes(o.before));assert.equal(o.stopAtId,undefined);await o.onPage(o.before==='199'?page([m('150',cutoff),m('140',cutoff-1)],'139'):page([m('130',cutoff-2)],'129'));return {pages:1};}},{headGroupIds:[]}));
 assert.deepEqual(store.get('w').groups[0].latestPendingRanges,before);
});
test('initial none retains history continuation, later auto resumes without marking initial backlog unread',async t=>{
 const {store}=fixture(t,{mode:'none'});let calls=0;
 await syncAccount(options(store,{async syncGroup(id,o){calls++;await o.onPage(page([m('200')],'199'));return {pages:1};}}));assert.equal(calls,1);assert.equal(store.get('w').groups[0].offlineInitialPending,true);
 store.update('w',s=>{s.settings.offlineMessages={mode:'auto'};});
 await syncAccount(options(store,{async syncGroup(id,o){assert.equal(o.before,'199');await o.onPage(page([m('100')],null));return {pages:1};}},{headGroupIds:[]}));
 assert.equal(store.getReadStats('w','g').unreadCount,0);assert.equal(store.get('w').groups[0].offlineInitialPending,false);
});
test('explicit older history ignores none/date policy and does not advance date scan',async t=>{
 for(const policy of [{mode:'none'},day]){const {store}=fixture(t,policy);store.mergeMessages('w',[],[m('200')]);store.update('w',s=>{s.groups[0].nextCursor='199';});await syncAccount(options(store,{async syncGroup(id,o){assert.equal(o.before,'199');await o.onPage(page([m('100',cutoff-1)],null));return {pages:1};}},{history:true,continuous:false}));assert.equal(store.get('w').messages.length,2);assert.equal(store.get('w').groups[0].offlineDateScan,undefined);}
});
test('platform end before selected date remains unresolved, never claims boundary was reached',async t=>{
 const {store}=fixture(t,day);await syncAccount(options(store,{async syncGroup(id,o){await o.onPage(page([m('200')],null));return {pages:1};}}));const g=store.get('w').groups[0];assert.equal(g.offlineDateScan.complete,false);assert.equal(g.offlineDateScan.unresolved,true);assert.equal(g.offlineDateScan.reachedDate,false);assert.equal(g.syncProgress.phase,'unresolved');
});
test('planner does not wake for paused gaps, but date work and initial auto continuation remain eligible',()=>{
 const plan=new RefreshPlan({now:()=>1000}),g={id:'g',selected:true,latestPendingRanges:[{status:'pending'}]};plan.recordHead('g');assert.equal(plan.plan([g],null,{mode:'none'}).hasWork,false);assert.equal(plan.plan([g],null,day).hasWork,true);assert.equal(plan.plan([{id:'g',selected:true,offlineInitialPending:true}],null).hasWork,true);
});

test('mixed page timestamps do not stop before following eligible records; auto recovers omitted overlap',async t=>{
 const {store}=fixture(t,day);store.mergeMessages('w',[],[m('100',cutoff-10)]);let calls=[];
 await syncAccount(options(store,{async syncGroup(id,o){calls.push(o.before);await o.onPage(o.before===undefined?page([m('300'),m('250',cutoff-1),m('100',cutoff-10)],'99',true):o.before==='99'?page([m('90',cutoff+1)],'89'):page([m('80',cutoff-20)],'79'));return {pages:1};}}));
 assert.deepEqual(calls,[undefined,'99','89']);assert.ok(store.get('w').messages.some(m=>m.id==='90'));assert.equal(store.get('w').groups[0].latestPendingRanges[0].cursor,null);
 store.update('w',s=>{s.settings.offlineMessages={mode:'auto'};});
 await syncAccount(options(store,{async syncGroup(id,o){assert.equal(o.before,undefined);assert.equal(o.stopAtId,'100');await o.onPage(page([m('300'),m('250',cutoff-1),m('100',cutoff-10)],'99',true));return {pages:1};}},{maxPages:1}));
 assert.ok(store.get('w').messages.some(m=>m.id==='250'));
});
test('date unresolved retry uses existing cooldown and resumes original cursor',async t=>{
 const {store}=fixture(t,day);let time=1000;const planner=new RefreshPlan({now:()=>time});
 store.update('w',s=>{s.groups[0].offlineDateScan={date:day.date,cursor:'199',arrivalAfterId:null,complete:false,unresolved:true};});planner.recordHead('g');planner.recordUnresolvedAttempt('g');assert.equal(planner.plan(store.get('w').groups,null,day).hasWork,false);
 await syncAccount(options(store,{async syncGroup(){throw Error('must not retry early');}},{headGroupIds:[],retryUnresolvedGroupIds:[]}));
 time+=60000;const plan=planner.plan(store.get('w').groups,null,day);assert.deepEqual(plan.retryUnresolvedGroupIds,['g']);
 await syncAccount(options(store,{async syncGroup(id,o){assert.equal(o.before,'199');await o.onPage(page([m('100',cutoff-1)],'99'));return {pages:1};}},{headGroupIds:[],retryUnresolvedGroupIds:plan.retryUnresolvedGroupIds}));assert.equal(store.get('w').groups[0].offlineDateScan.complete,true);
});
test('date initial mixed page can be recovered after switch to auto and invalid page cannot advance cursor',async t=>{
 const {store}=fixture(t,day);await syncAccount(options(store,{async syncGroup(id,o){await o.onPage(page([m('200'),m('100',cutoff-1)],'99'));return {pages:1};}},{maxPages:1}));assert.equal(store.get('w').groups[0].nextCursor,null);
 store.update('w',s=>{s.settings.offlineMessages={mode:'auto'};});await syncAccount(options(store,{async syncGroup(id,o){assert.equal(o.before,undefined);await o.onPage(page([m('200'),m('100',cutoff-1)],null));return {pages:1};}},{headGroupIds:[]}));assert.ok(store.get('w').messages.some(m=>m.id==='100'));
 store.update('w',s=>{s.settings.offlineMessages=day;});const before=store.get('w').groups[0].offlineDateScan;
 await assert.rejects(syncAccount(options(store,{async syncGroup(id,o){await o.onPage(page([m('300',NaN)],'299'));return {pages:1};}},{maxPages:1})),e=>e.code==='OFFLINE_INVALID_TIME');assert.deepEqual(store.get('w').groups[0].offlineDateScan,before);
});
test('future China calendar date is rejected at save without changing policy',t=>{
 const {store}=fixture(t);assert.throws(()=>saveOfflineMessages({store,getContext:()=>({accountId:'w',epoch:0}),now:()=>Date.parse('2026-10-30T16:00:00Z'),payload:{accountId:'w',offlineMessages:day,expectedOfflineMessages:{mode:'auto'}}}),e=>e.code==='OFFLINE_INVALID');assert.deepEqual(normalizeOfflineMessages(store.get('w').settings.offlineMessages),{mode:'auto'});
});

test('disconnected new head widens an unfinished date scan so newly missed interval is not stranded',async t=>{
 const {store}=fixture(t,day);store.mergeMessages('w',[],[m('200')]);store.update('w',s=>{s.groups[0].offlineDateScan={date:day.date,cursor:'150',complete:false,arrivalAfterId:'200'};});let calls=[];
 await syncAccount(options(store,{async syncGroup(id,o){calls.push(o.before);await o.onPage(o.before===undefined?page([m('400')],'399'):o.before==='399'?page([m('350'),m('200')],'199',true):page([m('100',cutoff-1)],'99'));return {pages:1};}}));
 assert.deepEqual(calls,[undefined,'150','399']);assert.ok(store.get('w').messages.some(m=>m.id==='350'));assert.equal(store.get('w').groups[0].offlineDateScan.complete,true);
});

test('date deep and head-gap cursors alternate across restarts under sustained new arrivals',async t=>{
 let {store,root}=fixture(t,day);store.mergeMessages('w',[],[m('200')]);store.update('w',s=>{s.groups[0].offlineDateScan={date:day.date,cursor:'150',complete:false,arrivalAfterId:'200'};});
 const before=[];let newest=400;
 for(let turn=0;turn<6;turn++){
   const step=turn;await syncAccount(options(store,{async syncGroup(id,o){before.push(o.before);if(o.before===undefined){await o.onPage(page([m(String(newest))],String(newest-1)));newest+=100;}else if(Number(o.before)<=150){await o.onPage(page([m(String(Number(o.before)-1))],String(Number(o.before)-2)));}else{await o.onPage(page([m(String(Number(o.before)-1))],String(Number(o.before)-2)));}return {pages:1};}},{maxPages:2,headEveryPages:100}));store=new Store(root);
 }
 const gaps=before.filter(v=>v!==undefined);assert.equal(gaps.length,6);assert.deepEqual(gaps.filter(v=>Number(v)<=150),['150','148','146']);assert.equal(gaps.filter(v=>Number(v)>150).length,3);
 const scan=store.get('w').groups[0].offlineDateScan;assert.equal(scan.cursor,'144');assert.equal(scan.headPending.baselineId,'200');
});
test('terminal API cursor zero and unknown timestamps cannot invalidate a valid boundary commit',async t=>{
 const {store}=fixture(t,day);await syncAccount(options(store,{async syncGroup(id,o){await o.onPage({...page([m('1',cutoff-1)],null),resumeCursor:'0'});return {pages:1};}}));assert.equal(store.get('w').groups[0].offlineDateScan.cursor,null);assert.equal(store.get('w').groups[0].offlineDateScan.complete,true);
});
test('preload bridge permits offline policy IPC while main enforces account and busy guard',async t=>{
 const vm=require('node:vm');let bridge,called;
 vm.runInNewContext(fs.readFileSync(require.resolve('../app/preload.cjs'),'utf8'),{require:id=>{assert.equal(id,'electron');return {contextBridge:{exposeInMainWorld:(name,value)=>{assert.equal(name,'api');bridge=value;}},ipcRenderer:{invoke:async(...args)=>{called=args;return {ok:true,value:'saved'};}}};}});
 const payload={accountId:'w',offlineMessages:{mode:'none'},expectedOfflineMessages:{mode:'auto'}};assert.equal(await bridge.call('sync.offline.configure',payload),'saved');assert.deepEqual(called,['weiyue:call','sync.offline.configure',payload]);await assert.rejects(bridge.call('unapproved.action'));
 const {store}=fixture(t),source=fs.readFileSync(require.resolve('../app/main.cjs'),'utf8');const handle=source.slice(source.indexOf('async function handle(action,p){'),source.indexOf('\nasync function start(){'));
 const context=vm.createContext({store,saveOfflineMessages,activeId:'w',accountEpoch:1,busy:false,activeSync:null,cleanupBusy:()=>false,enrichmentJobs:new Map(),closing:()=>false,revision:0,snapshot:()=>store.get('w')});vm.runInContext(handle+'\nglobalThis.handle=handle;',context);
 assert.equal((await context.handle('sync.offline.configure',payload)).settings.offlineMessages.mode,'none');context.activeSync={};await assert.rejects(context.handle('sync.offline.configure',{...payload,offlineMessages:{mode:'auto'},expectedOfflineMessages:{mode:'none'}}),e=>e.code==='OFFLINE_BUSY');context.activeSync=null;await assert.rejects(context.handle('sync.offline.configure',{...payload,accountId:'other'}),e=>e.code==='OFFLINE_ACCOUNT_CHANGED');
});

test('date re-entry invalidates derived checkpoint only; identical save preserves continuation',t=>{
 const {store}=fixture(t,day);store.mergeMessages('w',[],[m('100')]);store.update('w',s=>{s.groups[0].offlineDateScan={date:day.date,cursor:'99',complete:true,reachedDate:true,arrivalAfterId:'100'};s.groups[0].latestPendingRanges=[{cursor:'99',baselineId:'50',arrivalAfterId:'100',status:'pending'}];s.groups[0].nextCursor='90';});
 const save=(next,expected)=>saveOfflineMessages({store,payload:{accountId:'w',offlineMessages:next,expectedOfflineMessages:expected},getContext:()=>({accountId:'w',epoch:1})});const before=store.get('w');save(day,day);assert.deepEqual(store.get('w').groups[0].offlineDateScan,before.groups[0].offlineDateScan);save({mode:'none'},day);save(day,{mode:'none'});const after=store.get('w');assert.equal(after.groups[0].offlineDateScan,undefined);assert.deepEqual(after.messages,before.messages);assert.deepEqual(after.groups[0].latestPendingRanges,before.groups[0].latestPendingRanges);assert.equal(after.groups[0].nextCursor,'90');
});
test('two unresolved date cursors alternate across permitted cooldown retries',async t=>{
 const {store}=fixture(t,day);store.mergeMessages('w',[],[m('100')]);store.update('w',s=>{s.groups[0].offlineDateScan={date:day.date,cursor:'50',complete:false,unresolved:true,nextHead:true,arrivalAfterId:'100',headPending:{cursor:'200',baselineId:'100',arrivalAfterId:'100',status:'unresolved'}};});const cursors=[];
 for(let i=0;i<4;i++)await syncAccount(options(store,{async syncGroup(id,o){cursors.push(o.before);await o.onPage({...page([],null),resumeCursor:o.before});return {pages:1};}},{headGroupIds:[],retryUnresolvedGroupIds:['g']}));assert.deepEqual(cursors,['200','50','200','50']);
});
