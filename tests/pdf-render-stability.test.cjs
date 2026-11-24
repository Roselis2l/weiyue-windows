'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../app/renderer/attachment-viewer.js'),'utf8');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture(){
 const elements=new Map(),listeners=new Map();let observer,reads=0,paints=0;
 function element(id){if(!elements.has(id))elements.set(id,{id,hidden:true,clientWidth:1000,clientHeight:700,style:{},value:'',disabled:false,textContent:'',children:[],addEventListener:(event,fn)=>listeners.set(id+':'+event,fn),replaceChildren(){},append(){},getContext:()=>({}),pause(){},load(){},removeAttribute(){}});return elements.get(id);}
 const page={getViewport:({scale})=>({width:600*scale,height:800*scale}),render:()=>{paints++;return{promise:Promise.resolve(),cancel(){}};},cleanup(){}};
 const context=vm.createContext({document:{getElementById:element,addEventListener:(event,fn)=>listeners.set('document:'+event,fn)},window:{addEventListener:(event,fn)=>listeners.set('window:'+event,fn)},ResizeObserver:class{constructor(fn){observer=this;this.callback=fn;this.disconnected=false;}observe(){}disconnect(){this.disconnected=true;}},HTMLInputElement:class{},devicePixelRatio:1,setTimeout,clearTimeout,Promise,Uint8Array,URL,Blob,queueMicrotask});
 vm.runInContext(source.replace(/void load\(\);\s*$/,' '),context);
 context.mockPdf={getPage:async()=>{reads++;return page;}};vm.runInContext('pdf=mockPdf;pageCount=2;epoch=1;',context);
 return{elements,listeners,context,observer:()=>observer,width(value){element('viewport').clientWidth=value;observer.callback([{target:element('viewport')}]);},notify(){observer.callback([{target:element('viewport')}]);},counts:()=>({reads,paints}),clean:()=>vm.runInContext('clean()',context)};
}
test('PDF fit ignores initial and height-only ResizeObserver deliveries',async()=>{
 const f=fixture();for(let i=0;i<12;i++){f.elements.get('viewport').clientHeight+=1;f.notify();}await sleep(160);assert.deepEqual(f.counts(),{reads:0,paints:0});await f.clean();
});
test('PDF fit coalesces changed width and ignores repeated geometry notifications after paint',async()=>{
 const f=fixture();f.width(980);f.width(920);f.width(900);await sleep(160);assert.deepEqual(f.counts(),{reads:1,paints:1});assert.equal(f.elements.get('page').style.width,'844px');
 for(let i=0;i<20;i++)f.notify();await sleep(160);assert.deepEqual(f.counts(),{reads:1,paints:1});assert.equal(f.elements.get('notice').hidden,true);await f.clean();
});
test('manual PDF zoom is retained when viewport width changes',async()=>{
 const f=fixture();vm.runInContext('fitted=false;scale=1.5;',f.context);f.width(820);await sleep(160);assert.deepEqual(f.counts(),{reads:0,paints:0});assert.equal(vm.runInContext('scale',f.context),1.5);await f.clean();
});
test('cleanup cancels pending resize work before a different preview can reuse the window',async()=>{
 const f=fixture();f.width(800);await f.clean();vm.runInContext('pdf=mockPdf;pageCount=2;',f.context);await sleep(160);assert.deepEqual(f.counts(),{reads:0,paints:0});await f.clean();
});
test('closing disconnects PDF geometry observer and cancels pending paint',async()=>{
 const f=fixture();f.width(800);f.listeners.get('window:beforeunload')();await sleep(160);assert(f.observer().disconnected);assert.deepEqual(f.counts(),{reads:0,paints:0});
});
