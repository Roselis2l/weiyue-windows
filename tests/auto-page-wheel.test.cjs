'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const paging=require('../app/renderer/auto-page.js');
const source=fs.readFileSync(require.resolve('../app/renderer/app.js'),'utf8');
const start=source.indexOf('function bindReadingInput('),end=source.indexOf('function canAdvanceRead()',start);
function harness(){
 let now=0,sequence=0,count=160,loads=0,applied=0,current=true;const listeners={},timers=new Map();
 const scroll={scrollTop:520,scrollHeight:1000,clientHeight:400,addEventListener:(name,fn)=>listeners[name]=fn};
 const model={scrollTop:520,layoutVersion:0,restoring:false,filters:{},viewport:null};
 const autoPage=paging.createAutoPager({snapshot:()=>({key:'same',enabled:current,blocked:false,atBottom:paging.isAtBottom(scroll),offset:0,count,total:500}),
  load:async()=>{loads++;return 160;},apply:()=>{applied++;count+=160;},now:()=>now});
 const context=vm.createContext({model,autoPage,window:{},scroll,performance:{now:()=>now},canAdvanceRead:()=>false,hasFilters:()=>false,
  isCurrentReadingRendered:()=>current,readingOwner:()=> 'same',readingContext:()=> 'same',readIntent:{arm(){},reset(){},scroll(){return null;}},
  scheduleRead(){},updateReadChrome(){},invalidateReadingIntent(){autoPage.cancelIntent();model.pagingWheel=null;},
  captureViewport:()=>({anchorId:'last',readThroughId:'last'}),$:(id)=>id==='message-scroll'?scroll:null,
  clearTimeout:id=>timers.delete(id),setTimeout:(fn,delay)=>{const id=++sequence;timers.set(id,{fn,due:now+delay});return id;},cancelAnimationFrame(){}});
 vm.runInContext(source.slice(start,end)+';bindReadingInput(scroll);',context);
 return{scroll,model,autoPage,get loads(){return loads;},get applied(){return applied;},wheel:()=>listeners.wheel({isTrusted:true,deltaY:100}),
  move(top,time){now=time;scroll.scrollTop=top;vm.runInContext('handleReadingScroll()',context);},
  tick(time){now=time;for(const[id,value]of [...timers])if(value.due<=now){timers.delete(id);value.fn();}},
  settle:async()=>{for(let i=0;i<12;i++)await Promise.resolve();}};
}
test('one genuine wheel reaches the bottom over native smooth frames and appends exactly once',async()=>{
 const h=harness();h.wheel();h.move(521.3,16);await h.settle();assert.equal(h.loads,0);
 for(const[top,time]of [[531,32],[551,64],[572,96],[590,128],[600,160]]){h.move(top,time);await h.settle();}
 assert.equal(h.loads,1);assert.equal(h.applied,1);h.move(600,180);h.tick(260);await h.settle();assert.equal(h.loads,1);
});
test('passive geometry changes before ResizeObserver runs cannot consume a previous wheel',async()=>{
 for(const field of ['scrollHeight','clientHeight']){
  const h=harness();h.wheel();h.move(521.3,16);h.scroll[field]+=field==='scrollHeight'?-40:40;h.move(560,64);await h.settle();
  assert.equal(h.loads,0);assert.equal(h.model.pagingWheel,null);
 }
});
test('expired, layout-changed, upward and unarmed movements cannot load a local page',async()=>{
 const h=harness();h.move(600,20);await h.settle();assert.equal(h.loads,0);
 h.scroll.scrollTop=520;h.model.scrollTop=520;h.wheel();h.tick(300);h.move(600,320);await h.settle();assert.equal(h.loads,0);
 h.scroll.scrollTop=520;h.model.scrollTop=520;h.wheel();h.model.layoutVersion++;h.move(600,330);await h.settle();assert.equal(h.loads,0);
});
