const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {createAutoPager} = require('../app/renderer/auto-page.js');
const { captureViewport, restoredScrollTop, chooseWindow, mediaReadyForRead, trailingSpaceHeight, createReadIntentGate, recentGroupId, unreadLabel } = require('../app/renderer/reading-state.js');

function viewport(items, extra = {}) {
  return captureViewport({ items, viewportTop: 100, viewportHeight: 400,
    scrollTop: 200, scrollHeight: 1500, loadedAtEnd: true, ...extra });
}
// These focused input tests exercise read authorization, without a rendered
// account/list that could be eligible for automatic pagination.
function inactiveAutoPager() {
  return createAutoPager({snapshot:()=>({enabled:false}),load:()=>{throw new Error('No pageable list in this focused read test');},apply:()=>{throw new Error('No page should be applied');}});
}

test('partly visible anchor preserves negative offset and exact large string IDs', () => {
  const result = viewport([
    { id: '9007199254740993000', top: -50, bottom: 101 },
    { id: '9007199254740993001', top: 70, bottom: 240 },
    { id: '9007199254740993002', top: 250, bottom: 490 },
    { id: '9007199254740993003', top: 495, bottom: 620 }
  ]);
  assert.deepEqual(result, { anchorId: '9007199254740993001', anchorOffset: -30,
    atBottom: false, readThroughId: '9007199254740993002' });
  assert.equal(restoredScrollTop({ scrollTop: 200, itemTop: 70, viewportTop: 100, anchorOffset: -30 }), 200);
});

test('restoration compensates image expansion above the anchor without following the bottom', () => {
  const saved = viewport([{ id: '9007199254740993123', top: 60, bottom: 300 }]);
  // An earlier image grows by 260px after the original measurement.
  const corrected = restoredScrollTop({ scrollTop: 200, itemTop: 320,
    viewportTop: 100, anchorOffset: saved.anchorOffset });
  assert.equal(corrected, 460);
  assert.equal(320 - (corrected - 200) - 100, saved.anchorOffset);
  assert.equal(saved.atBottom, false);
});

test('a tall message remains the anchor but is not read until its bottom is visible', () => {
  assert.deepEqual(viewport([
    { id: 'old', top: -200, bottom: 80 },
    { id: 'tall', top: 90, bottom: 1100 }
  ]), { anchorId: 'tall', anchorOffset: -10, atBottom: false, readThroughId: null });
  assert.equal(viewport([{ id: 'not-read-yet', top: 120, bottom: 1100 }]).readThroughId, null);
});

test('viewport edges exclude hidden items and accept a one-pixel bottom rounding difference', () => {
  assert.deepEqual(viewport([
    { id: 'above', top: 0, bottom: 101 },
    { id: 'edge', top: 110, bottom: 501 },
    { id: 'below', top: 500, bottom: 600 }
  ]), { anchorId: 'edge', anchorOffset: 10, atBottom: false, readThroughId: 'edge' });
});

test('bottom means the latest loaded window, never the bottom of an old page', () => {
  const geometry = { scrollTop: 1068, scrollHeight: 1500 };
  assert.equal(viewport([], geometry).atBottom, true);
  assert.equal(viewport([], { ...geometry, scrollTop: 1067 }).atBottom, false);
  assert.equal(viewport([], { ...geometry, loadedAtEnd: false }).atBottom, false);
});

test('empty or invalid measurements return no fabricated ID and restore never scrolls negative', () => {
  assert.deepEqual(viewport([null, { id: 'bad', top: NaN, bottom: 300 }]), {
    anchorId: null, anchorOffset: 0, atBottom: false, readThroughId: null
  });
  assert.equal(restoredScrollTop({ scrollTop: 10, itemTop: 20, viewportTop: 100, anchorOffset: 0 }), 0);
});

test('only an explicit latest request chooses the newest window', () => {
  assert.deepEqual(chooseWindow({ total: 1000, latestRequested: true }), { offset: 840, limit: 160 });
  assert.deepEqual(chooseWindow({ total: 1012, latestRequested: true }), { offset: 852, limit: 160 });
  assert.deepEqual(chooseWindow({ total: 1000, anchorIndex: 450 }), { offset: 425, limit: 160 });
  assert.deepEqual(chooseWindow({ total: 1012, anchorIndex: 450 }), { offset: 425, limit: 160 });
  assert.deepEqual(chooseWindow({ total: 10, latestRequested: true }), { offset: 0, limit: 160 });
});

test('window boundaries use whole numbers, with bounded page sizes and known-anchor context', () => {
  assert.deepEqual(chooseWindow({ total: 500, anchorIndex: 10 }), { offset: 0, limit: 160 });
  assert.deepEqual(chooseWindow({ total: 500, anchorIndex: 0 }), { offset: 0, limit: 160 });
  assert.deepEqual(chooseWindow({ total: 500, anchorIndex: null }), { offset: 0, limit: 160 });
  assert.deepEqual(chooseWindow({ total: 500, limit: 0 }), { offset: 0, limit: 1 });
  assert.deepEqual(chooseWindow({ total: 5000, limit: 9000, latestRequested: true }), { offset: 3000, limit: 2000 });
  assert.deepEqual(chooseWindow({ total: 100.9, limit: 30.9, anchorIndex: 60.9 }), { offset: 35, limit: 30 });
  assert.deepEqual(chooseWindow(), { offset: 0, limit: 160 });
});

test('unread counts are empty at zero and capped without coercing invalid counts', () => {
  for (const count of [0, -1, null, undefined, NaN, Infinity, 1.2, '12']) assert.equal(unreadLabel(count), '');
  assert.equal(unreadLabel(1), '1');
  assert.equal(unreadLabel(999), '999');
  assert.equal(unreadLabel(1000), '999+');
  assert.equal(unreadLabel(12000), '999+');
});

test('browser script exposes only the frozen WeiyueReading helper', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('../app/renderer/reading-state.js'), 'utf8'), context);
  assert.deepEqual(Object.keys(context), ['WeiyueReading']);
  assert.equal(context.WeiyueReading.unreadLabel(7), '7');
  assert.equal(Object.isFrozen(context.WeiyueReading), true);
});


test('pending media blocks the high water before placeholders or later cards can become read', () => {
  const items = [{id:'ready',top:90,bottom:180,ready:true},
    {id:'pending',top:190,bottom:240,ready:false},{id:'later',top:250,bottom:350,ready:true}];
  assert.equal(viewport(items).readThroughId,'ready');
  assert.equal(viewport(items.map(item=>({...item,top:item.top-200,bottom:item.bottom-200}))).readThroughId,null);
  assert.equal(viewport(items.map(item=>({...item,ready:true}))).readThroughId,'later');
  assert.equal(viewport([{id:'tall',top:-600,bottom:450,ready:true}]).readThroughId,'tall');
});

test('trailing space lets short last messages reach top without a blank viewport', () => {
  for(const lastHeight of [20,200,400,900]) {
    const spacer=trailingSpaceHeight(400,lastHeight,18);
    assert.equal(spacer,Math.max(0,400-lastHeight-18));
    if(lastHeight<382)assert.equal(lastHeight+spacer+18,400);
  }
  assert.equal(trailingSpaceHeight(NaN,100),0);
});

test('legacy atBottom does not select latest or override an explicit saved anchor', () => {
  assert.deepEqual(chooseWindow({total:1000,anchorIndex:450,atBottom:true,followEnd:true}),{offset:425,limit:160});
});

test('read intent needs trusted input followed by downward displacement in the same context', () => {
  const gate=createReadIntentGate();
  assert.equal(gate.scroll('a',100,0,'M1'),null);
  gate.arm('a',100,0,false);assert.equal(gate.scroll('a',200,1,'M2'),null);
  gate.arm('a',100,0,true);
  assert.equal(gate.scroll('a',100,1,'M2'),null);
  assert.equal(gate.scroll('a',90,2,'M2'),null);
  assert.equal(gate.scroll('a',110,3,'M2'),null,'a reversal revokes the old downward gesture');
  gate.arm('a',110,4,true);
  assert.deepEqual(gate.scroll('a',120,5,'9007199254740993123'),{context:'a',kind:'scroll',readThroughId:'9007199254740993123'});
});

test('native smooth wheel fractional tail retains a completed reading candidate', () => {
  // Measured Chromium smooth-scroll positions: the final 0.6667px frame used to
  // replace the preceding valid dwell candidate with an anchor-only save.
  const positions=[3038,3041.333251953125,3048,3057.333251953125,
    3069.333251953125,3083.333251953125,3100,3118.666748046875,
    3137.333251953125,3156.666748046875,3174.666748046875,
    3191.333251953125,3205.333251953125,3216.666748046875,
    3226,3232,3236,3236.666748046875];
  const gate=createReadIntentGate();gate.arm('focused-group',3036.666748046875,0,true);
  let scheduled=null;
  for(const [index,top] of positions.entries()) {
    scheduled=gate.scroll('focused-group',top,(index+1)*9,'9007199254740993123');
    assert.ok(scheduled,`positive frame ${index+1} must not clear the dwell candidate`);
  }
  assert.equal(scheduled.readThroughId,'9007199254740993123');
  const tiny=createReadIntentGate();tiny.arm('fractional',10,0,true);
  assert.equal(tiny.scroll('fractional',10.001,1,'M1')?.readThroughId,'M1',
    'reading permission must not depend on a one-pixel movement threshold');
});

test('zero displacement retains only the same existing candidate and never reads a new arrival', () => {
  const gate=createReadIntentGate();
  assert.equal(gate.scroll('a',100,0,'M1'),null,'passive scrolling has no gesture');
  gate.arm('a',100,1,true);
  assert.equal(gate.scroll('a',100,2,'M1'),null,'an unmoved gesture has no candidate');
  const candidate=gate.scroll('a',100.25,3,'M1');
  assert.equal(candidate?.readThroughId,'M1');
  assert.deepEqual(gate.scroll('a',100.25,4,'M1'),candidate,'a redundant tail frame keeps the same snapshot');
  assert.equal(gate.scroll('a',100.25,5,'M2'),null,'a new visible message needs new downward displacement');
  gate.arm('a',100.25,6,true);
  assert.equal(gate.scroll('a',100.25,7,'M1'),null,'a new unmoved gesture cannot revive an earlier snapshot');
  gate.arm('a',100.25,8,false);
  assert.equal(gate.scroll('a',101,9,'M1'),null,'untrusted input cannot authorize the next scroll');
});

test('fractional reversal reset expiry and context changes revoke retained candidates', () => {
  const establish=()=>{const gate=createReadIntentGate();gate.arm('a',100,0,true);
    assert.ok(gate.scroll('a',100.5,1,'M1'));return gate;};
  const reverse=establish();
  assert.equal(reverse.scroll('a',100.25,2,'M1'),null);
  assert.equal(reverse.scroll('a',101,3,'M1'),null,'forward motion after reversal needs a fresh gesture');
  const reset=establish();reset.reset();
  assert.equal(reset.scroll('a',100.5,2,'M1'),null);
  assert.equal(reset.scroll('a',101,3,'M1'),null);
  const expired=establish();
  assert.equal(expired.scroll('a',100.5,1201,'M1'),null);
  assert.equal(expired.scroll('a',101,1202,'M1'),null);
  const changed=establish();
  assert.equal(changed.scroll('b',100.5,2,'M1'),null);
  assert.equal(changed.scroll('a',101,3,'M1'),null,'returning to the old context cannot revive its gesture');
});

test('restore, layout changes, navigation and expired gestures cannot spend old read intent', () => {
  const gate=createReadIntentGate();
  gate.arm('a:g:q:layout1',0,0,true);
  assert.equal(gate.scroll('a:g:q:layout2',50,10,'M1'),null);
  gate.arm('a',0,0,true);gate.reset();assert.equal(gate.scroll('a',100,10,'M1'),null);
  gate.arm('a',0,0,true);assert.equal(gate.scroll('b',100,10,'M1'),null);
  gate.arm('a',0,0,true);assert.equal(gate.scroll('a',100,1201,'M1'),null);
  gate.arm('a',0,0,true);assert.equal(gate.scroll('a',100,10,null),null);
});

test('a dwell candidate is an immutable snapshot, never the next incoming message', () => {
  const gate=createReadIntentGate();gate.arm('a',0,0,true);
  const first=gate.scroll('a',100,1,'M1');
  assert.equal(Object.isFrozen(first),true);
  gate.scroll('a',200,2,'M2');gate.reset();
  assert.equal(first.readThroughId,'M1');
});

test('restart chooses the latest selected group, stable fallback excludes hidden groups', () => {
  const groups=[{id:'a'},{id:'b'},{id:'hidden',selected:false}];
  assert.equal(recentGroupId(groups,{a:{updatedAt:10},b:{updatedAt:20},hidden:{updatedAt:100}}),'b');
  assert.equal(recentGroupId(groups,{a:{updatedAt:'2026-10-20T10:00:00Z'},b:{updatedAt:'2026-10-20T09:00:00Z'}}),'a');
  assert.equal(recentGroupId(groups,{}),'a');assert.equal(recentGroupId([{id:'hidden',selected:false}],{}),null);
});


test('old read context images do not block reading but skipped unread images do', () => {
  assert.equal(mediaReadyForRead({loaded:false,alreadyRead:true}),true);
  assert.equal(mediaReadyForRead({loaded:false,aboveViewport:true,unread:false}),false);
  assert.equal(mediaReadyForRead({loaded:false,aboveViewport:true,unread:true}),false);
  assert.equal(mediaReadyForRead({loaded:false,aboveViewport:true}),false);
  assert.equal(mediaReadyForRead({loaded:false,aboveViewport:false,unread:false}),false);
  assert.equal(mediaReadyForRead({loaded:true,unread:true}),true);
});


test('renderer rejects an old account, group or query DOM while new reading data is loading', () => {
  const source=fs.readFileSync(require.resolve('../app/renderer/app.js'),'utf8');
  const start=source.indexOf('function isCurrentReadingRendered()');
  const end=source.indexOf('function captureViewport()',start);
  const model={view:'read',state:{account:{id:'account-a'}},accountEpoch:1,groupId:'group-a',queryVersion:7,
    renderedReading:{accountId:'account-a',epoch:1,groupId:'group-a',version:7}};
  const context=vm.createContext({model});vm.runInContext(source.slice(start,end),context);
  const matches=()=>vm.runInContext('isCurrentReadingRendered()',context);
  assert.equal(matches(),true);
  for(const [field,value] of [['groupId','group-b'],['queryVersion',8],['accountEpoch',2],['view','bookmarks']]) {
    const before=model[field];model[field]=value;assert.equal(matches(),false,field);model[field]=before;
  }
  model.state.account.id='account-b';assert.equal(matches(),false);
  model.state.account.id='account-a';model.renderedReading=null;assert.equal(matches(),false);
});


test('trusted passive wheel still grants reading when the compositor has already moved the DOM', () => {
  const source=fs.readFileSync(require.resolve('../app/renderer/app.js'),'utf8');
  const start=source.indexOf('function bindReadingInput('),end=source.indexOf('function handleReadingScroll()',start);
  const listeners={},scroll={scrollTop:170,addEventListener:(name,callback)=>listeners[name]=callback};
  const gate=createReadIntentGate(),model={scrollTop:100,restoring:true,restoreFrame:1};
  const context=vm.createContext({model,readIntent:gate,autoPage:inactiveAutoPager(),canAdvanceRead:()=>true,hasFilters:()=>false,
    readingContext:()=> 'current',readingOwner:()=> 'current',scheduleRead:()=>{},clearTimeout:()=>{},
    performance:{now:()=>10},setTimeout:()=>1,requestAnimationFrame:()=>1,cancelAnimationFrame:()=>{},invalidateReadingIntent:()=>gate.reset(),window:{},scroll});
  vm.runInContext(source.slice(start,end)+';bindReadingInput(scroll);',context);
  listeners.wheel({deltaY:70,isTrusted:true});
  assert.deepEqual(gate.scroll('current',170,10,'M4'),{context:'current',kind:'scroll',readThroughId:'M4'});
  assert.equal(model.restoring,false);
  gate.reset();listeners.wheel({deltaY:70,isTrusted:false});assert.equal(gate.scroll('current',240,20,'M5'),null);
  model.scrollTop=170;listeners.wheel({deltaY:70,isTrusted:true});assert.equal(gate.scroll('current',170,20,'M5'),null);
});

test('held native scrollbar renews only accepted movement and release or cancellation stops renewal', () => {
  const source=fs.readFileSync(require.resolve('../app/renderer/app.js'),'utf8');
  const start=source.indexOf('function bindReadingInput('),end=source.indexOf('function canAdvanceRead()',start);
  const resetStart=source.indexOf('function resetReadCandidate()'),resetEnd=source.indexOf('function updateReadingSpace()',resetStart);
  const releaseStart=source.indexOf("window.addEventListener('pointerup'"),releaseEnd=source.indexOf("window.addEventListener('focus'",releaseStart);
  assert.ok(start>=0 && end>start && resetStart>=0 && resetEnd>resetStart && releaseStart>=0 && releaseEnd>releaseStart);
  const listeners={},windowListeners={},scheduled=[],gate=createReadIntentGate();
  let now=0,eligible=true,filtered=false,rendered=true;
  const scroll={scrollTop:100,offsetWidth:100,clientWidth:90,
    getBoundingClientRect:()=>({right:200}),addEventListener:(name,callback)=>listeners[name]=callback};
  const model={scrollTop:100,restoring:false,restoreFrame:1,intentVersion:0,pointerScrolling:false};
  const context=vm.createContext({model,readIntent:gate,autoPage:inactiveAutoPager(),canAdvanceRead:()=>eligible,hasFilters:()=>filtered,
    isCurrentReadingRendered:()=>rendered,readingContext:()=>`current:${model.intentVersion}`,readingOwner:()=> 'current',
    scheduleReadingRefresh:()=>{},
    performance:{now:()=>now},cancelAnimationFrame:()=>{},clearTimeout:()=>{},
    $:id=>id==='message-scroll'?scroll:null,captureViewport:()=>({anchorId:'M1',readThroughId:'M1'}),
    updateReadChrome:()=>{},scheduleRead:candidate=>scheduled.push(candidate),flushReading:async()=>{},
    window:{addEventListener:(name,callback)=>windowListeners[name]=callback},scroll});
  vm.runInContext(source.slice(resetStart,resetEnd)+source.slice(start,end)+source.slice(releaseStart,releaseEnd)+';bindReadingInput(scroll);',context);
  const down=(trusted=true)=>listeners.pointerdown({button:0,target:scroll,clientX:195,isTrusted:trusted,pointerType:'mouse'});
  const move=(top,time)=>{scroll.scrollTop=top;now=time;vm.runInContext('handleReadingScroll()',context);return scheduled.at(-1);};

  down(false);assert.equal(model.pointerScrolling,false);assert.equal(move(101,1500),null);
  down();assert.equal(model.pointerScrolling,true);
  assert.equal(move(101.5,3001)?.readThroughId,'M1','holding for 1500ms does not require a DOM pointermove');
  assert.equal(move(101.5,3010)?.readThroughId,'M1','a zero-motion tail must not renew away its accepted candidate');
  windowListeners.pointerup();assert.equal(model.pointerScrolling,false);
  assert.equal(move(102,4500),null,'a released pointer cannot renew permission for a later passive scroll');

  for(const cancel of [()=>windowListeners.pointercancel(),()=>windowListeners.blur(),
    ()=>vm.runInContext('invalidateReadingIntent()',context)]) {
    down();assert.equal(model.pointerScrolling,true);cancel();
    assert.equal(model.pointerScrolling,false);
    assert.equal(move(scroll.scrollTop+1,now+10),null,'canceled or restored layout cannot acquire read permission');
  }
  eligible=false;down();assert.equal(model.pointerScrolling,false);assert.equal(move(110,5000),null);
  eligible=true;filtered=true;down();assert.equal(model.pointerScrolling,false);assert.equal(move(111,5010),null);
  filtered=false;rendered=false;
  const calls=scheduled.length;move(112,5020);assert.equal(scheduled.length,calls,'a stale group DOM cannot schedule any write');
});
