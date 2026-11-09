'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('../app/core/store.cjs');
const {groupUpdateLabel}=require('../app/renderer/reading-state.js');
const {syncAccount}=require('../app/core/sync-service.cjs');
const floor=Date.parse('2026-11-08T00:00:00+08:00');
const message=(id,time,groupId='g')=>({id:String(id),time,groupId,senderId:'u',senderName:'Synthetic',text:'synthetic'});
const format=(time,short)=>{assert.equal(short,true);return new Date(time).toISOString();};
function setup(t,kind='import'){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'weiyue-sidebar-time-'));
 t.after(()=>{const resolved=fs.realpathSync(root);assert.equal(path.dirname(resolved).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());assert(path.basename(resolved).startsWith('weiyue-sidebar-time-'));fs.rmSync(resolved,{recursive:true,force:true});});
 const store=new Store(root);store.ensureAccount({id:'a',name:'Synthetic',kind});store.mergeMessages('a',[{id:'g',name:'G',selected:true},{id:'h',name:'H',selected:true}],[]);return{store,root};
}
const label=(store,id='g')=>groupUpdateLabel({...store.get('a').groups.find(g=>g.id===id),...store.getReadStats('a',id)},format);
const cleanup=(store,over={})=>{const p={groupId:'g',startMinute:'2026-01-01T00:00',endMinute:'2026-11-07T23:59',mode:'permanent',retainSenderIds:[],retainSummaryRanges:false,markUnreadAsRead:true,...over};const plan=store.previewMessageCleanup('a',p);return store.applyMessageCleanup('a',p,plan.fingerprint);};
test('a populated group without coverage displays latest available message before reading',t=>{
 const{store}=setup(t);store.mergeMessages('a',[],[message(10,floor),message(20,floor+2000)]);assert.equal(store.get('a').groups[0].coverage,undefined);assert.equal(store.getReadStats('a','g').latestMessageTime,floor+2000);assert.equal(label(store),format(floor+2000,true)+' 更新');
});
test('reading progress does not replace message freshness or change unread just for label',t=>{
 const{store}=setup(t);store.mergeMessages('a',[],[message(10,floor)]);store.mergeMessages('a',[],[message(20,floor+2000)]);const before=store.getReadStats('a','g').unreadIds;label(store);assert.deepEqual(store.getReadStats('a','g').unreadIds,before);store.setReadPosition('a','g','10',{seenId:'10'});assert.equal(store.getReadStats('a','g').latestMessageTime,floor+2000);assert.equal(label(store),format(floor+2000,true)+' 更新');
});
test('prefix deletion resetting coverage leaves retained messages with correct timestamp after restart',t=>{
 const{store,root}=setup(t);store.mergeMessages('a',[{id:'g',name:'G',selected:true,coverage:{oldest:floor-1000,newest:floor+2000,complete:false,note:''}}],[message(10,floor-1000),message(20,floor+2000)]);cleanup(store);const re=new Store(root);assert.equal(re.get('a').groups[0].coverage,undefined);assert.equal(label(re),format(floor+2000,true)+' 更新');
});
test('deleted newest message and tombstone cannot override latest retained time',t=>{
 const{store}=setup(t);store.mergeMessages('a',[],[message(10,floor),message(20,floor+60000)]);cleanup(store,{startMinute:'2026-11-08T00:01',endMinute:'2026-11-08T00:01'});assert.equal(store.get('a').messageTombstones.length,1);assert.equal(store.getReadStats('a','g').latestMessageTime,floor);assert.equal(label(store),format(floor,true)+' 更新');
});
test('empty and fully deleted groups show no messages even with old coverage or reading state',t=>{
 const{store}=setup(t);assert.equal(label(store),'暂无消息');store.mergeMessages('a',[],[message(10,floor)]);cleanup(store,{endMinute:'2026-11-08T23:59'});assert.equal(store.getReadStats('a','g').latestMessageTime,null);assert.equal(label(store),'暂无消息');
});
test('per-group stats stay independent and newest time is chronological, not largest ID',t=>{
 const{store}=setup(t);store.mergeMessages('a',[],[message(900,floor),message(10,floor+2000),message(30,floor+5000,'h')]);assert.equal(store.getReadStats('a','g').latestMessageId,'10');assert.equal(store.getReadStats('a','g').latestMessageTime,floor+2000);assert.equal(store.getReadStats('a','h').latestMessageTime,floor+5000);
});
test('retention date synchronization without page coverage still updates group timestamp',async t=>{
 const{store}=setup(t,'weibo');store.update('a',s=>{s.schemaVersion=5;s.groups[0].historyBoundary={start:floor,updatedAt:floor};s.groups[1].selected=false;});
 await syncAccount({store,accountId:'a',continuous:true,maxPages:1,pageDelayMs:500,timeBudgetMs:10000,sleep:async()=>{},client:{async syncGroup(id,o){await o.onPage({messages:[message(10,floor-1000),message(20,floor+2000)],nextCursor:null,coverage:{oldest:floor-1000,newest:floor+2000,complete:false,note:''}});return{pages:1};}}});
 assert.equal(store.get('a').groups[0].coverage,undefined);assert.equal(label(store),format(floor+2000,true)+' 更新');
});
test('label rejects absent or invalid values but accepts the epoch',()=>{
 for(const v of [undefined,null,NaN,Infinity,-1,1.2,'2026-11-08',8640000000000001])assert.equal(groupUpdateLabel({latestMessageTime:v,coverage:{newest:floor}},format),'暂无消息');assert.equal(groupUpdateLabel({latestMessageTime:0},format),'1970-01-01T00:00:00.000Z 更新');
});
test('reading stats are derived read-only and do not persist presentation timestamps',t=>{
 const{store,root}=setup(t);store.mergeMessages('a',[],[message(10,floor)]);const file=store._file('a'),bytes=fs.readFileSync(file);new Store(root).getReadStats('a');assert.deepEqual(fs.readFileSync(file),bytes);assert.equal(store.get('a').groups[0].latestMessageTime,undefined);
});
test('sidebar and background badge refresh share the timestamp helper',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../app/renderer/app.js'),'utf8');assert.equal((source.match(/reading\.groupUpdateLabel\(group,fmt\)/g)||[]).length,2);assert.doesNotMatch(source,/coverage\?\.newest\?fmt/);assert.match(source,/g\.latestMessageTime=stats\.latestMessageTime/);
});
