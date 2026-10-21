'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('../app/core/store.cjs');
const {queryWindow}=require('../app/renderer/auto-page.js');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'weiyue-page-store-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const store=new Store(root);store.ensureAccount({id:'synthetic',name:'Synthetic',kind:'import'});
 const messages=Array.from({length:12},(_,i)=>({id:String(9007199254740993000n+BigInt(i)),time:1000+i*10,groupId:'g',senderId:i%2?'b':'a',senderName:'Synthetic',text:i%2?'other':'match'}));
 store.mergeMessages('synthetic',[{id:'g',name:'Synthetic group'},{id:'other',name:'Synthetic other'}],messages);
 return{store,messages,root,query:p=>store.queryMessages('synthetic',{groupId:'g',...p})};
}
test('stable local boundaries retain exact large string IDs and old offset-only query contract',t=>{
 const h=fixture(t),ids=h.messages.map(m=>m.id);
 assert.deepEqual(h.query({offset:1,limit:2}),{messages:h.store.get('synthetic').messages.slice(1,3),total:12});
 const next=h.query({afterId:ids[4],offset:999,limit:3});assert.equal(next.offset,5);assert.deepEqual(next.messages.map(m=>m.id),ids.slice(5,8));
 const first=h.query({startId:ids[4],limit:1});assert.equal(first.offset,4);assert.equal(first.messages[0].id,ids[4]);
 assert.deepEqual(h.query({afterId:ids.at(-1),limit:160}),{messages:[],total:12,offset:12});
});
test('history inserted before and within the loaded window never skips the stable next message',t=>{
 const h=fixture(t),last=h.messages[5];
 h.store.mergeMessages('synthetic',[],[{...last,id:'early',time:1},{...last,id:'inside',time:1025},{...last,id:'after',time:1055}],{history:true});
 const result=h.query({afterId:last.id,limit:2});assert.equal(result.offset,8);assert.deepEqual(result.messages.map(m=>m.id),['after',h.messages[6].id]);
});
test('boundaries operate inside keyword/member/date/important filters and their requested group only',t=>{
 const h=fixture(t),id=h.messages[4].id;
 h.store.mergeMessages('synthetic',[],[{...h.messages[0],groupId:'other',id}]);
 h.store.update('synthetic',s=>{s.importantMembers=['a'];});
 const result=h.query({afterId:id,keyword:'match',senderIds:['a'],start:1020,end:1090,importantOnly:true,limit:2});
 assert.equal(result.offset,2);assert.deepEqual(result.messages.map(m=>m.id),[h.messages[6].id,h.messages[8].id]);
 assert.throws(()=>h.query({afterId:h.messages[3].id,keyword:'match'}),error=>error.code==='PAGE_ANCHOR_MISSING');
});
test('mutually exclusive, malformed and missing boundaries fail without mutating local records',t=>{
 const h=fixture(t),before=JSON.stringify(h.store.get('synthetic')),id=h.messages[0].id;
 for(const p of [{startId:id,afterId:id},{afterId:1},{afterId:' '+id},{afterId:''},{startId:null},{afterId:{}},{afterId:id,limit:2001},{afterId:id,offset:-1},{afterId:id,groupId:undefined}])assert.throws(()=>h.query(p));
 h.store.update('synthetic',s=>{s.messages=s.messages.filter(m=>m.id!==id);});
 const deleted=JSON.stringify(h.store.get('synthetic'));assert.throws(()=>h.query({afterId:id}),error=>error.code==='PAGE_ANCHOR_MISSING');
 assert.equal(JSON.stringify(h.store.get('synthetic')),deleted);assert.notEqual(deleted,before);
});
test('same-time large IDs page by stored exact numeric ordering without precision loss',t=>{
 const h=fixture(t);h.store.update('synthetic',s=>{for(const m of s.messages)m.time=1000;});
 assert.deepEqual(h.query({afterId:h.messages[7].id,limit:2}).messages.map(m=>m.id),[h.messages[8].id,h.messages[9].id]);
});
test('window refresh keeps all appended rows, old trailing anchor and a consistent revision across bounded chunks',async()=>{
 const rows=Array.from({length:4600},(_,i)=>({id:String(i),time:i})),calls=[];
 const query=async p=>{calls.push(p);const index=p.startId!==undefined?rows.findIndex(m=>m.id===p.startId):p.afterId!==undefined?rows.findIndex(m=>m.id===p.afterId)+1:p.offset||0;return{messages:rows.slice(index,index+p.limit),offset:index,total:rows.length,revision:7};};
 const result=await queryWindow({query,payload:{groupId:'g',offset:0,limit:160},firstId:'10',lastId:'4310',count:4320});
 assert.equal(result.offset,10);assert.equal(result.messages.length,4320);assert.equal(result.messages.at(-1).id,'4329');
 assert.ok(calls.every(p=>p.limit<=2000));assert.equal(new Set(result.messages.map(m=>m.id)).size,4320);
 const inserted=await queryWindow({query,payload:{groupId:'g',offset:0,limit:160},firstId:'10',lastId:'350',count:320});
 assert.equal(inserted.messages.at(-1).id,'350');assert.equal(inserted.messages.length,341);
});
test('window refresh discards mixed revisions, changed totals, invalid contiguous offset and old context',async()=>{
 for(const mutate of [r=>({...r,revision:8}),r=>({...r,total:9999}),r=>({...r,offset:123})]){
  let calls=0;const query=async p=>{calls++;const offset=p.startId==='tail'?2100:p.afterId?2000:0;const result={messages:Array.from({length:p.limit},(_,i)=>({id:String(offset+i)})),offset,total:3000,revision:7};return calls===3?mutate(result):result;};
  await assert.rejects(queryWindow({query,payload:{groupId:'g',limit:160},firstId:'0',lastId:'tail',count:2200}),e=>e.code==='PAGE_CHANGED');
 }
 await assert.rejects(queryWindow({query:async()=>({messages:[],offset:0,total:0,revision:7}),payload:{limit:160},active:()=>false}),e=>e.code==='PAGE_CHANGED');
});
