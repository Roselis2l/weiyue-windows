'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
test('actual local IPC query preserves stable boundary fields and exposes one data revision without syncing',async()=>{
 const source=read('app/main.cjs'),a=source.indexOf('async function handle(action,p){'),b=source.indexOf('async function start(){',a),calls=[];
 const scope={activeId:'synthetic',busy:false,revision:17,store:{queryMessages:(id,p)=>{calls.push({id,p});return{messages:[{id:'9007199254740993999'}],offset:42,total:100};}},decorateMessage:(m,id)=>({...m,decorated:id})};
 vm.createContext(scope);vm.runInContext(source.slice(a,b)+';globalThis.dispatch=handle;',scope);
 for(const boundary of ['afterId','beforeId']){
  calls.length=0;const payload={groupId:'g',[boundary]:'9007199254740993998',keyword:'text',senderIds:['a'],limit:160};
  const result=await scope.dispatch('messages.query',payload);
  assert.deepEqual(calls,[{id:'synthetic',p:payload}]);assert.equal(result.revision,17);assert.equal(result.offset,42);assert.equal(result.messages[0].decorated,'synthetic');assert.equal(scope.revision,17);
 }
});
test('actual local IPC validates beforeId in the active account and preserves read state and revision',async t=>{
 const {Store}=require('../app/core/store.cjs'),os=require('node:os');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'weiyue-before-ipc-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const store=new Store(root);for(const id of ['synthetic-a','synthetic-b'])store.ensureAccount({id,name:'Synthetic',kind:'import'});
 const rows=Array.from({length:8},(_,i)=>({id:String(9007199254740993000n+BigInt(i)),time:1000+i,groupId:'g',senderId:i%2?'b':'a',senderName:'Synthetic',text:'Synthetic only'}));
 store.mergeMessages('synthetic-a',[{id:'g',name:'Synthetic'}],rows);
 store.mergeMessages('synthetic-b',[{id:'g',name:'Synthetic'}],[{...rows[0],id:'other-account-only'}]);
 store.setReadPosition('synthetic-a','g',rows[3].id,{offset:19,seenId:rows[5].id,followTail:false});
 const before=store.get('synthetic-a'),bytes=fs.readFileSync(store._file('synthetic-a'));
 const source=read('app/main.cjs'),a=source.indexOf('async function handle(action,p){'),b=source.indexOf('async function start(){',a);
 const scope={activeId:'synthetic-a',busy:false,revision:23,store,decorateMessage:(m,id)=>({...m,decorated:id})};
 vm.createContext(scope);vm.runInContext(source.slice(a,b)+';globalThis.dispatch=handle;',scope);
 const p={groupId:'g',beforeId:rows[5].id,limit:2},result=await scope.dispatch('messages.query',p);
 assert.equal(result.offset,3);assert.equal(result.total,8);assert.equal(result.revision,23);assert.deepEqual(Array.from(result.messages,m=>m.id),[rows[3].id,rows[4].id]);
 assert.ok(result.messages.every(m=>m.decorated==='synthetic-a'));
 for(const payload of [{...p,afterId:rows[4].id},{...p,startId:rows[5].id},{...p,beforeId:9007199254740993000},{...p,limit:0},{...p,groupId:undefined}])await assert.rejects(scope.dispatch('messages.query',payload));
 await assert.rejects(scope.dispatch('messages.query',{...p,senderIds:['a']}),e=>e.code==='PAGE_ANCHOR_MISSING');
 scope.activeId='synthetic-b';await assert.rejects(scope.dispatch('messages.query',p),e=>e.code==='PAGE_ANCHOR_MISSING');
 assert.equal(scope.revision,23);assert.deepEqual(store.get('synthetic-a'),before);assert.ok(fs.readFileSync(store._file('synthetic-a')).equals(bytes));
});
test('paging helper is loaded before app and explicitly allowed through the app protocol',()=>{
 const html=read('app/renderer/index.html'),main=read('app/main.cjs');assert.ok(html.indexOf('src="auto-page.js"')<html.indexOf('src="app.js"'));
 assert.match(main,/\['\/auto-page\.js',/);
});
test('renderer uses stable local append and refresh without rebuilding or silently shrinking the loaded window',()=>{
 const source=read('app/renderer/app.js');
 const append=source.slice(source.indexOf('function appendLocalPage('),source.indexOf('function updateAutoPageChrome('));
 assert.ok(!/renderReading\(|loadReading\(|readThroughId/.test(append));assert.match(append,/insertBefore/);assert.match(append,/captureViewport\(\)/);assert.match(append,/restoreViewport\(anchor\)/);
 const load=source.slice(source.indexOf('async function loadNextLocalPage('),source.indexOf('function appendLocalPage('));assert.match(load,/api\('messages.query'/);assert.match(load,/afterId:String\(last.id\)/);assert.ok(!/sync\(/.test(load));
 assert.match(source,/model\.offset\+=model\.messages\.length \|\| model\.limit/);assert.match(source,/count:model\.messages\.length,active/);
 assert.match(source,/autoPage\.cancelIntent\(\);/);assert.match(source,/token\.height===scroll\.scrollHeight/);assert.match(source,/else if\(direction===token\.direction\)autoPage\.observe\(\)/);
});
test('actual important-member handler resets an explicitly changed important-only list when its first or last member disappears',async()=>{
 const {Store}=require('../app/core/store.cjs'),os=require('node:os');
 const source=read('app/renderer/app.js'),start=source.indexOf("const priority=messageIconButton('important',async event=>{"),end=source.indexOf("},{'data-action':'important-member'",start);
 assert.ok(start>=0&&end>start);const handler=source.slice(start+"const priority=messageIconButton('important',".length,end+1);
 for(const sender of ['first','last']){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'weiyue-important-page-'));
  try{
   const store=new Store(root);store.ensureAccount({id:'synthetic',name:'Synthetic',kind:'import'});
   const rows=['first','middle','last'].map((senderId,i)=>({id:String(9007199254740993000n+BigInt(i)),time:i,groupId:'g',senderId,senderName:'Synthetic',text:'Synthetic only'}));
   store.mergeMessages('synthetic',[{id:'g',name:'Synthetic'}],rows);for(const id of ['first','middle','last'])store.setImportant('synthetic',id,true);
   const model={offset:160,filters:{importantOnly:true},messages:rows},events=[];
   const scope={model,m:rows.find(m=>m.senderId===sender),important:true,priority:{matches:()=>false},affordance:{classList:{contains:()=>false}},findMessageElement:()=>null,
    api:async(action,p)=>{assert.equal(action,'important.set');store.setImportant('synthetic',p.senderId,p.enabled);},refreshState:async()=>{},
    loadReading:async()=>{events.push('reload');model.messages=store.queryMessages('synthetic',{groupId:'g',importantOnly:true,offset:model.offset,limit:160}).messages;},
    refreshReadingIncrementally:async()=>{events.push('incremental');}};
   vm.createContext(scope);vm.runInContext('globalThis.handler='+handler,scope);await scope.handler({detail:1});
   assert.equal(model.offset,0);assert.deepEqual(events,['reload']);assert.deepEqual(model.messages.map(m=>m.senderId),rows.filter(m=>m.senderId!==sender).map(m=>m.senderId));
   model.filters.importantOnly=false;model.offset=120;events.length=0;await scope.handler({detail:1});assert.deepEqual(events,['incremental']);assert.equal(model.offset,120);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
 }
});
