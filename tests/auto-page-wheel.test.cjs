'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const paging=require('../app/renderer/auto-page.js');
const source=fs.readFileSync(require.resolve('../app/renderer/app.js'),'utf8');
const start=source.indexOf('function bindReadingInput('),end=source.indexOf('function canAdvanceRead()',start);
class Surface {
 constructor(){this.listeners=new Map();}
 addEventListener(name,fn){const items=this.listeners.get(name)||[];items.push(fn);this.listeners.set(name,items);}
 removeEventListener(name,fn){this.listeners.set(name,(this.listeners.get(name)||[]).filter(value=>value!==fn));}
 emit(name,event={}){for(const fn of this.listeners.get(name)||[])fn(event);}
}
class Element extends Surface {
 constructor(interactive=false){super();this.interactive=interactive;}
 closest(){return this.interactive?this:null;}
}
function harness({offset=160,top=520}={}){
 let now=0,sequence=0,count=160,current=true,owner='same',barrier=null;const loads=[],timers=new Map();
 const scroll=Object.assign(new Element(),{scrollTop:top,scrollHeight:1000,clientHeight:400,clientWidth:480,offsetWidth:500,getBoundingClientRect:()=>({right:500})});
 const body=new Element(),document=Object.assign(new Surface(),{body,documentElement:new Element(),activeElement:scroll,visibilityState:'visible',hasFocus:()=>true});
 const win=new Surface(),modal={open:false};
 const model={scrollTop:top,layoutVersion:0,restoring:false,filters:{},viewport:null,pagingGestureSequence:0};
 const autoPage=paging.createAutoPager({snapshot:()=>({key:owner,enabled:current&&!modal.open,blocked:false,atTop:paging.isAtTop(scroll),atBottom:paging.isAtBottom(scroll),offset,count,total:800}),
  load:async snapshot=>{loads.push(snapshot.direction);if(barrier)await barrier;return snapshot.direction;},apply:direction=>{count+=160;if(direction<0)offset=Math.max(0,offset-160);},now:()=>now});
 const context=vm.createContext({model,autoPage,window:win,document,Element,scroll,performance:{now:()=>now},canAdvanceRead:()=>false,hasFilters:()=>false,
  isCurrentReadingRendered:()=>current,readingOwner:()=>owner,readingContext:()=>owner,readIntent:{arm(){},reset(){},scroll(){return null;}},
  scheduleRead(){},scheduleReadingRefresh(){},resetReadCandidate(){},updateReadChrome(){},invalidateReadingIntent(){autoPage.cancelIntent();model.pagingWheel=null;},
  captureViewport:()=>({anchorId:'last',readThroughId:'last'}),$:(id)=>id==='message-scroll'?scroll:id==='modal'?modal:null,
  clearTimeout:id=>timers.delete(id),setTimeout:(fn,delay)=>{const id=++sequence;timers.set(id,{fn,due:now+delay});return id;},cancelAnimationFrame(){}});
 const run=code=>vm.runInContext(code,context);run(source.slice(start,end)+';bindReadingInput(scroll);');
 const event=overrides=>({isTrusted:true,target:document.activeElement,preventDefault(){this.defaultPrevented=true;},...overrides});
 return{scroll,model,autoPage,document,win,modal,loads,run,
  wheel:deltaY=>scroll.emit('wheel',event({target:scroll,deltaY:deltaY??100})),
  key:(key,options={})=>{const value=event({key,...options});document.emit('keydown',value);return value;},
  up:key=>document.emit('keyup',event({key})),hover:()=>scroll.emit('pointerenter',event({target:scroll})),
  move(top,time){now=time;scroll.scrollTop=top;run('handleReadingScroll()');},
  tick(time){now=time;for(const[id,value]of [...timers])if(value.due<=now){timers.delete(id);value.fn();}},
  block(){let release;barrier=new Promise(r=>release=r);return()=>{barrier=null;release();};},
  changeOwner(){owner='new';},settle:async()=>{for(let i=0;i<12;i++)await Promise.resolve();}};
}
test('one genuine wheel reaches the bottom over native smooth frames and appends exactly once',async()=>{
 const h=harness();h.wheel();h.move(521.3,16);await h.settle();assert.equal(h.loads.length,0);
 for(const[top,time]of [[531,32],[551,64],[572,96],[590,128],[600,160]]){h.move(top,time);await h.settle();}
 assert.deepEqual(h.loads,[1]);h.move(600,180);h.tick(260);await h.settle();assert.equal(h.loads.length,1);
});
test('one upward wheel can prepend only after genuine movement reaches the top',async()=>{
 const h=harness({top:70});h.wheel(-100);h.move(45,16);await h.settle();assert.equal(h.loads.length,0);
 h.move(0,160);await h.settle();assert.deepEqual(h.loads,[-1]);h.wheel(-100);await h.settle();assert.equal(h.loads.length,1);
});
test('passive geometry changes before ResizeObserver runs cannot consume a previous wheel in either direction',async()=>{
 for(const direction of [-1,1])for(const field of ['scrollHeight','clientHeight']){
  const h=harness({top:direction>0?520:80});h.wheel(direction*100);h.move(direction>0?521.3:78.7,16);
  h.scroll[field]+=field==='scrollHeight'?-40:40;h.move(direction>0?560:0,64);await h.settle();
  assert.equal(h.loads.length,0);assert.equal(h.model.pagingWheel,null);
 }
});
test('expired, layout-changed, wrong-direction and unarmed movements cannot load',async()=>{
 const h=harness();h.move(600,20);await h.settle();assert.equal(h.loads.length,0);
 h.scroll.scrollTop=520;h.model.scrollTop=520;h.wheel();h.tick(300);h.move(600,320);await h.settle();assert.equal(h.loads.length,0);
 h.scroll.scrollTop=520;h.model.scrollTop=520;h.wheel();h.model.layoutVersion++;h.move(600,330);await h.settle();assert.equal(h.loads.length,0);
 h.scroll.scrollTop=70;h.model.scrollTop=70;h.wheel(100);h.move(0,340);await h.settle();assert.equal(h.loads.length,0);
});
test('Page and Arrow keys reach each boundary and an already-boundary press loads the matching page',async()=>{
 for(const[key,direction,top]of [['PageUp',-1,300],['ArrowUp',-1,30],['PageDown',1,300],['ArrowDown',1,570],['PageUp',-1,0],['ArrowDown',1,600]]){
  const h=harness({top});assert.equal(h.key(key).defaultPrevented,true);await h.settle();assert.deepEqual(h.loads,[direction],key);
 }
});
test('held key and pending repeats grant at most one page until a fresh keyup/keydown',async()=>{
 const h=harness({top:600});const release=h.block();h.key('PageDown');h.key('PageDown',{repeat:true});await h.settle();assert.deepEqual(h.loads,[1]);
 release();await h.settle();h.key('PageDown',{repeat:true});await h.settle();assert.deepEqual(h.loads,[1]);
 h.model.readingInput.cancel();h.key('PageDown',{repeat:true});await h.settle();assert.deepEqual(h.loads,[1]);
 h.up('PageDown');h.key('PageDown');await h.settle();assert.deepEqual(h.loads,[1,1]);
});
test('keyboard leaves controls, modifiers, composition, modal and other-pane focus alone',async()=>{
 for(const props of [{ctrlKey:true},{metaKey:true},{altKey:true},{shiftKey:true},{isComposing:true},{keyCode:229},{isTrusted:false},{defaultPrevented:true}]){
  const h=harness({top:600});h.key('PageDown',props);await h.settle();assert.deepEqual(h.loads,[]);assert.equal(h.scroll.scrollTop,600);
 }
 for(const focus of [new Element(true),new Element()]){
  const h=harness({top:600});h.document.activeElement=focus;h.hover();assert.equal(h.key('ArrowDown').defaultPrevented,undefined);await h.settle();assert.deepEqual(h.loads,[]);
 }
 const h=harness({top:600});h.modal.open=true;assert.equal(h.key('PageDown').defaultPrevented,undefined);await h.settle();assert.deepEqual(h.loads,[]);
});
test('safe body focus needs pointer context; leave and window blur revoke it',async()=>{
 const h=harness({top:600});h.document.activeElement=h.document.body;assert.equal(h.key('PageDown').defaultPrevented,undefined);
 h.hover();assert.equal(h.key('PageDown').defaultPrevented,true);await h.settle();assert.deepEqual(h.loads,[1]);
 h.up('PageDown');h.scroll.emit('pointerleave',{});assert.equal(h.key('PageDown').defaultPrevented,undefined);
 h.hover();h.win.emit('blur',{});assert.equal(h.key('PageDown').defaultPrevented,undefined);
});
test('rebind disposes previous global input listeners; stale owner cannot reuse a held gesture',async()=>{
 const h=harness({top:600});h.run('bindReadingInput(scroll)');assert.equal(h.document.listeners.get('keydown').length,1);assert.equal(h.win.listeners.get('pointerup').length,1);
 h.key('PageDown');await h.settle();h.changeOwner();h.key('PageDown',{repeat:true});await h.settle();assert.deepEqual(h.loads,[1]);
});
test('native scrollbar upward release loads once, geometry changes prevent a false page',async()=>{
 for(const resized of [false,true]){
  const h=harness({top:70});h.scroll.emit('pointerdown',{isTrusted:true,button:0,target:h.scroll,clientX:499});
  if(resized)h.scroll.scrollHeight+=20;h.move(0,20);await h.settle();assert.deepEqual(h.loads,[]);
  h.win.emit('pointerup',{isTrusted:true});h.win.emit('mouseup',{isTrusted:true});await h.settle();assert.deepEqual(h.loads,resized?[]:[-1]);
 }
});
