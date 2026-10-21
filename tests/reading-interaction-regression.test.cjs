'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../app/renderer/app.js'),'utf8');
const reading=require('../app/renderer/reading-state.js');
const filters=require('../app/renderer/filter-controls.js');
// Exercise actual renderer handlers, timers, queued writes and background refresh.
// Only the DOM geometry, clock and IPC transport are faked. In particular neither
// scheduleRead nor flushReading is stubbed: their interaction caused the regression.
function section(start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a,`source section ${start}`);return source.slice(a,b);}
const extracted=section('function emptyFilters()','const model =')+
  section('function queryPayload()','async function loadReading(')+
  section('function hasFilters(','async function applyFilters(')+
  section('function updateMessageAvatar(','function noteText(')+
  section('async function refreshState(','function renderSidebar()')+
  section('function isCurrentReadingRendered()','function watchMessageSizes()')+
  section('function reconcileChildren(','function renderReading()')+
  section('function bindReadingInput(','function updateUnreadBadges()')+
  section("window.addEventListener('pointerup'","window.addEventListener('focus'");

function harness(){
  let now=0,next=1,queryBarrier=null,commitBarrier=null;
  const timers=new Map(),frames=new Map(),listeners={},windowListeners={},writes=[],events=[];
  const rows=new Map([['M1',{id:'M1',top:100,bottom:260,ready:true}],['M2',{id:'M2',top:270,bottom:520,ready:true}],['M3',{id:'M3',top:530,bottom:590,ready:true}]]);
  const initial=[{id:'M1',time:0},{id:'M2',time:1}];
  let backend=initial.slice();
  const model={view:'read',groupId:'group-a',accountEpoch:1,queryVersion:7,layoutVersion:0,intentVersion:0,
    state:{account:{id:'mock-account'},groups:[{id:'group-a',unreadCount:3}],readStates:{'group-a':{readThroughId:'M0'}},readPositions:{}},
    renderedReading:{accountId:'mock-account',epoch:1,groupId:'group-a',version:7,filtered:false},
    scrollTop:100,restoring:false,restoreFrame:null,pointerScrolling:false,touchY:null,readTimer:null,viewport:null,
    switching:false,readWrite:Promise.resolve(),lastReadPayload:'',messages:initial.slice(),messageSignatures:new Map(),
    pointerReading:null,readingActivity:null,readingCommits:new Map(),pendingReadingRefresh:null,pendingReadingTimer:null,
    offset:0,limit:160,total:2,refreshRunning:false,members:[],filters:null,
    searchEditor:null,filterReturn:null,readNavigation:null};
  const scroll={scrollTop:100,offsetWidth:100,clientWidth:90,clientHeight:400,scrollHeight:1000,childNodes:[],
    getBoundingClientRect:()=>({top:0,bottom:400,right:200}),addEventListener:(name,callback)=>listeners[name]=callback,
    querySelectorAll(selector){return this.childNodes.filter(n=>selector==='[data-message-id]'?n.dataset.messageId:selector==='[data-day]'?n.dataset.day:false);},
    insertBefore(child,cursor){const old=this.childNodes.indexOf(child);if(old>=0)this.childNodes.splice(old,1);const index=cursor?this.childNodes.indexOf(cursor):-1;if(index<0)this.childNodes.push(child);else this.childNodes.splice(index,0,child);}};
  Object.defineProperty(scroll,'firstChild',{get:()=>scroll.childNodes[0]||null});
  // Geometry-only cards have no decorative descendants. Execute the real avatar
  // hook; the dedicated avatar UI regression covers its actual DOM/load effects.
  function element(dataset={}){const classes=new Set();const el={dataset,style:{},querySelector:()=>null,classList:{contains:v=>classes.has(v),add:v=>classes.add(v)},
    getBoundingClientRect(){const r=rows.get(dataset.messageId)||{top:0,bottom:0};return{top:r.top-scroll.scrollTop,bottom:r.bottom-scroll.scrollTop,height:r.bottom-r.top};},
    remove(){const i=scroll.childNodes.indexOf(el);if(i>=0)scroll.childNodes.splice(i,1);}};
    Object.defineProperty(el,'nextSibling',{get:()=>scroll.childNodes[scroll.childNodes.indexOf(el)+1]||null});return el;}
  const space=element({});
  const card=m=>element({messageId:String(m.id)});
  scroll.childNodes=[...initial.map(card),space];
  initial.forEach(m=>model.messageSignatures.set(m.id,JSON.stringify(m)));
  const captureItems=()=>scroll.querySelectorAll('[data-message-id]').map(el=>({...rows.get(el.dataset.messageId),...el.getBoundingClientRect()}));
  const document={visibilityState:'visible',hasFocus:()=>true};
  const modal={open:false};
  const api=async(name,payload)=>{
    if(name==='read.set'){writes.push(JSON.parse(JSON.stringify(payload)));events.push({at:now,type:'read.set',payload:{...payload}});if(commitBarrier)await commitBarrier;return{readState:{readThroughId:payload.readThroughId||model.state.readStates[payload.groupId].readThroughId}};}
    if(name==='messages.locate')return{offset:0};
    if(name==='messages.query'){const messages=backend.slice();events.push({at:now,type:'query'});if(queryBarrier)await queryBarrier;return{messages,total:messages.length};}
    if(name==='state')return JSON.parse(JSON.stringify(model.state));
    if(name==='members.list')return[];
    throw Error('Unexpected fake IPC '+name);
  };
  const context=vm.createContext({model,reading,filters,readIntent:reading.createReadIntentGate(),document,api,
    $:id=>id==='message-scroll'?scroll:id==='reading-end-space'?space:id==='modal'?modal:null,
    performance:{now:()=>now},setTimeout:(callback,delay)=>{const id=next++;timers.set(id,{callback,due:now+delay});return id;},clearTimeout:id=>timers.delete(id),
    requestAnimationFrame:callback=>{const id=next++;frames.set(id,callback);return id;},cancelAnimationFrame:id=>frames.delete(id),
    getComputedStyle:()=>({paddingBottom:'0'}),measuredMessages:captureItems,
    findMessageElement:id=>scroll.childNodes.find(el=>el.dataset.messageId===id),
    watchMessageSizes:()=>{},updateReadChrome:()=>{},updateUnreadBadges:()=>{},enrichVisibleMessages:async()=>{},
    renderSidebar:()=>events.push({at:now,type:'sidebar'}),renderHeader:()=>events.push({at:now,type:'header'}),
    messageSignature:JSON.stringify,messageCard:card,node:(_tag,props)=>element(props?.['data-day']?{day:props['data-day']}:{}),
    dateLabel:()=>'',emptyState:()=>element(),locateReadBoundary:async()=>null,
    window:{addEventListener:(name,callback)=>windowListeners[name]=callback},scroll});
  vm.runInContext(extracted+';model.filters=emptyFilters();bindReadingInput(scroll);',context);
  const run=code=>vm.runInContext(code,context);
  async function settle(waitWrites=true){for(let i=0;i<16;i++)await Promise.resolve();if(waitWrites)await model.readWrite;}
  async function tick(ms,waitWrites=true){const target=now+ms;let iterations=0;for(;;){const due=[...timers].filter(([,t])=>t.due<=target).sort((a,b)=>a[1].due-b[1].due)[0];if(!due)break;assert.ok(iterations++<100,'deferred refresh must not spin');now=due[1].due;timers.delete(due[0]);due[1].callback();await settle(waitWrites);}now=target;await settle(waitWrites);}
  function snapshot(label){events.push({at:now,label,pointerScrolling:model.pointerScrolling,layoutVersion:model.layoutVersion,intentVersion:model.intentVersion,readTimerPending:timers.has(model.readTimer),readThroughId:model.state.readStates[model.groupId]?.readThroughId});}
  function down(trusted=true){listeners.pointerdown({button:0,target:scroll,clientX:195,isTrusted:trusted,pointerType:'mouse'});snapshot('pointerdown');}
  function move(top){scroll.scrollTop=top;run('handleReadingScroll()');snapshot('scroll-no-pointermove');}
  function frame(){const pending=[...frames.values()];frames.clear();for(const cb of pending)cb();snapshot('restore-frame');}
  async function refresh(waitWrites=true){await run('refreshReadingIncrementally()');frame();await settle(waitWrites);snapshot('same-group-refresh');}
  return{model,writes,events,rows,document,modal,run,tick,settle,down,move,frame,refresh,snapshot,
    release:()=>windowListeners.pointerup(),blur:()=>windowListeners.blur(),arrive:()=>backend.push({id:'M3',time:2}),
    blockQuery(){let release;queryBarrier=new Promise(r=>release=r);return()=>{queryBarrier=null;release();};},
    blockCommit(){let release;commitBarrier=new Promise(r=>release=r);return()=>{commitBarrier=null;release();};},
    readIds:()=>writes.filter(p=>p.readThroughId).map(p=>p.readThroughId)};
}
function scenario(name,body){test(name,async()=>{await body(harness());});}

scenario('control: held scrollbar without an old timer reads after 1600ms and real downward displacement',async h=>{
  h.down();await h.tick(1600);h.move(200);await h.tick(500);assert.deepEqual(h.readIds(),['M2']);
});
scenario('REGRESSION: pre-existing anchor-only timer must not revoke a held native scrollbar',async h=>{
  h.run('scheduleRead(null)');await h.tick(100);h.down();await h.tick(1500);h.snapshot('after-old-timer');
  assert.deepEqual(h.readIds(),[],'holding alone must not mark anything read');h.move(200);await h.tick(500);
  assert.deepEqual(h.readIds(),['M2'],'a trusted still-held drag must authorize its later native movement, with no DOM pointermove');
});
scenario('REGRESSION: background refresh during a hold must not make the next native movement unreadable',async h=>{
  h.down();await h.tick(100);h.arrive();await h.refresh();await h.tick(1500);h.move(200);await h.tick(500);
  assert.deepEqual(h.readIds(),['M2'],'the visible pre-refresh boundary must remain readable by the ongoing drag');
  assert.equal(h.events.filter(e=>e.type==='query').length,0,'hold must defer background query and layout');
  h.release();await h.tick(0);h.frame();
  assert.ok(h.model.messages.some(m=>m.id==='M3'),'release drains a fresh background query');
  assert.deepEqual(h.readIds(),['M2'],'new arrival cannot borrow the old drag');
});
scenario('REGRESSION: same-group refresh during dwell must preserve the authorized boundary without reading new arrival',async h=>{
  h.down();h.move(200);h.release();await h.tick(100);h.arrive();await h.refresh();await h.tick(700);
  assert.deepEqual(h.readIds(),['M2'],'the existing M2 dwell must complete; background M3 has no user authorization');
});
scenario('REGRESSION: refresh already awaiting IPC must recheck a newly started dwell before applying',async h=>{
  const resolve=h.blockQuery();const refreshing=h.run('refreshReadingIncrementally()');await h.settle();
  h.down();h.move(200);h.release();h.arrive();resolve();await refreshing;h.frame();await h.tick(700);
  assert.deepEqual(h.readIds(),['M2'],'an await-return race must not erase the new gesture or read newly arrived M3');
  assert.ok(h.events.filter(e=>e.type==='query').length>=2,'discarded IPC result must be re-queried after the dwell');
  assert.ok(h.model.messages.some(m=>m.id==='M3'),'fresh query must include the arrival omitted by the stale result');
});
scenario('guard: passive refresh and fully visible new content never mark messages read',async h=>{
  h.arrive();await h.refresh();h.move(200);await h.tick(1600);assert.deepEqual(h.readIds(),[]);
});
scenario('guard: pointer release before later passive movement does not renew expired permission',async h=>{
  h.down();h.release();await h.tick(1600);h.move(200);await h.tick(500);assert.deepEqual(h.readIds(),[]);
});
scenario('guard: blur cancels an already scheduled dwell before read.set',async h=>{
  h.down();h.move(200);h.blur();await h.tick(700);assert.deepEqual(h.readIds(),[]);
});
scenario('guard: pending media at flush cannot spend an old reading candidate',async h=>{
  h.down();h.move(200);h.rows.get('M2').ready=false;await h.tick(500);assert.deepEqual(h.readIds(),[]);
});
scenario('guard: a message no longer fully visible at flush cannot become read',async h=>{
  h.down();h.move(200);h.rows.get('M2').bottom=620;await h.tick(500);assert.deepEqual(h.readIds(),[]);
});
scenario('background state refresh during dwell does not rerender header or group controls',async h=>{
  h.down();h.move(200);h.release();await h.tick(100);
  await h.run('refreshState({background:true})');
  assert.equal(h.events.filter(e=>e.type==='header'||e.type==='sidebar').length,0);
  await h.tick(700);assert.deepEqual(h.readIds(),['M2']);
});
scenario('read IPC in flight defers background patch until commit completes',async h=>{
  const resolve=h.blockCommit();h.down();h.move(200);h.release();await h.tick(500,false);
  h.arrive();await h.refresh(false);assert.equal(h.events.filter(e=>e.type==='query').length,0);
  assert.equal(h.model.layoutVersion,0,'read commit must not race a programmatic layout restore');
  resolve();await h.settle();await h.tick(0);h.frame();
  assert.deepEqual(h.readIds(),['M2']);assert.ok(h.model.messages.some(m=>m.id==='M3'));
});
scenario('real layout restore cancels the candidate but preserves a physically held thumb for its next move',async h=>{
  h.down();h.move(200);await h.tick(100);
  h.run('restoreViewport(captureViewport())');h.frame();await h.tick(1500);
  assert.deepEqual(h.readIds(),[],'a layout restore cannot spend the old dwell');
  h.move(201);await h.tick(500);
  assert.deepEqual(h.readIds(),['M2'],'the still-held native thumb needs no extra DOM pointermove to continue');
});
scenario('real layout restore after pointer release cannot revive the canceled candidate',async h=>{
  h.down();h.move(200);h.release();await h.tick(100);
  h.run('restoreViewport(captureViewport())');h.frame();h.move(201);await h.tick(1500);
  assert.deepEqual(h.readIds(),[],'a passive move after restored layout has no held physical input');
});
