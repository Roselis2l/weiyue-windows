'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../app/renderer/app.js'),'utf8');
const reading=require('../app/renderer/reading-state.js');
const filters=require('../app/renderer/filter-controls.js');
function section(start,end){
  const a=source.indexOf(start),b=source.indexOf(end,a);
  assert.ok(a>=0 && b>a,`renderer section ${start}`);return source.slice(a,b);
}
// Exercise the shipped event handlers, renderer reconciliation, load and read IPC
// logic. This fake DOM detects a detach/focus loss; real Chromium IME is tested
// separately by the Windows regression harness.
const extracted=section('function emptyFilters()','const model =')+
  section('async function run(','function updateBusy()')+
  section('async function setView(','function draftKey()')+
  section('function isCurrentReadingRendered()','function captureViewport()')+
  section('function readingBusy()','function queueReadingRefresh(')+
  section('function reconcileChildren(','function patchMessageList(')+
  section('async function refreshReadingIncrementally(','function searchOwner()')+
  section('function searchOwner()','function messageCard(')+
  section('async function flushReading(','function updateUnreadBadges()');

function harness(){
  let now=0,sequence=0,barrier=null,viewport={anchorId:'9007199254740993001',anchorOffset:-28};
  const timers=new Map(),queries=[],writes=[],errors=[],restores=[];
  const documentListeners={};
  const document={activeElement:null,visibilityState:'visible',hasFocus:()=>true,
    createElement:tag=>new Element(tag),
    createTextNode:text=>new Element('#text',{textContent:String(text)}),
    addEventListener:(name,callback)=>(documentListeners[name] ||= []).push(callback),
    removeEventListener:(name,callback)=>{documentListeners[name]=(documentListeners[name] || []).filter(fn=>fn!==callback);}};
  class Element {
    constructor(tag,props={}){
      this.tag=tag;this.childNodes=[];this.parentNode=null;this.listeners={};this.dataset={};this.value='';
      this.ownerDocument=document;this.attributes={};
      this.classList={add(){},contains(){return false;},toggle(){}};this.style={};
      for(const [key,value] of Object.entries(props)){
        if(key.startsWith('on'))this.addEventListener(key.slice(2),value);
        else if(key.startsWith('data-'))this.dataset[key.slice(5).replace(/-([a-z])/g,(_m,c)=>c.toUpperCase())]=String(value);
        else this[key]=value;
      }
    }
    get isConnected(){return this===host || !!this.parentNode?.isConnected;}
    get firstChild(){return this.childNodes[0] || null;}
    get nextSibling(){const list=this.parentNode?.childNodes || [];return list[list.indexOf(this)+1] || null;}
    contains(other){return this===other || this.childNodes.some(child=>child.contains(other));}
    remove(){
      if(document.activeElement && this.contains(document.activeElement))document.activeElement=null;
      const index=this.parentNode?.childNodes.indexOf(this);
      if(index>=0)this.parentNode.childNodes.splice(index,1);
      this.parentNode=null;
    }
    insertBefore(child,cursor){
      child.remove();const index=this.childNodes.indexOf(cursor);
      this.childNodes.splice(index<0?this.childNodes.length:index,0,child);child.parentNode=this;
    }
    append(...children){for(const child of children.flat(Infinity))if(child instanceof Element)this.insertBefore(child,null);}
    appendChild(child){this.append(child);return child;}
    replaceChildren(...children){for(const child of [...this.childNodes])child.remove();this.append(...children);}
    setAttribute(name,value){this.attributes[name]=String(value);if(name==='id')this.id=String(value);if(name==='class')this.className=String(value);}
    getAttribute(name){return this.attributes[name] ?? null;}
    addEventListener(name,callback){(this.listeners[name] ||= []).push(callback);}
    removeEventListener(name,callback){this.listeners[name]=(this.listeners[name] || []).filter(fn=>fn!==callback);}
    dispatch(name,props={}){const event={target:this,key:'',preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;},...props};for(const fn of this.listeners[name] || [])fn(event);return event;}
    querySelectorAll(selector){
      const matches=element=>selector[0]==='#'?element.id===selector.slice(1):
        selector[0]==='.'?(element.className || '').split(/\s+/).includes(selector.slice(1)):
        /^input\[type="[^"]+"\]$/.test(selector)?element.tag==='input' && element.type===selector.slice(12,-2):
        selector==='[data-message-id]'?!!element.dataset.messageId:false;
      return this.childNodes.flatMap(child=>[...(matches(child)?[child]:[]),...child.querySelectorAll(selector)]);
    }
    querySelector(selector){return this.querySelectorAll(selector)[0] || null;}
    focus(){document.activeElement=this;}
  }
  const host=new Element('main',{id:'workspace-content'});
  const node=(tag,props={},...children)=>{const element=new Element(tag,props);element.append(children);return element;};
  const $=id=>id===host.id?host:host.querySelector('#'+id);
  const model={
    state:{account:{id:'account-a'},groups:[{id:'group-a',unreadCount:7},{id:'group-b',unreadCount:8}],
      readStates:{'group-a':{anchorId:viewport.anchorId,anchorOffset:-28,readThroughId:'older',unreadCount:7}},readPositions:{}},
    accountEpoch:0,groupId:'group-a',view:'read',queryVersion:1,layoutVersion:0,intentVersion:0,
    filters:{keyword:'',senderIds:[],start:'',end:'',importantOnly:false},searchEditor:null,filterReturn:null,
    messages:[{id:viewport.anchorId,time:1}],members:[],offset:0,limit:160,total:400,advanced:false,
    selected:new Set(),messageSignatures:new Map(),pending:new Set(),busy:0,readingCommits:new Map(),
    readWrite:Promise.resolve(),lastReadPayload:'',viewport:{...viewport},renderedReading:null,
    readingActivity:null,switching:false,closing:false
  };
  const api=async(action,payload={})=>{
    if(action==='messages.locate')return{message:{id:String(payload.messageId)},offset:200};
    if(action==='members.list')return[{id:'member-a',name:'Member A'}];
    if(action==='messages.query'){
      queries.push(JSON.parse(JSON.stringify(payload)));const held=barrier;
      const result={messages:[{id:payload.keyword?`${payload.groupId}:${payload.keyword}`:model.state.readStates[payload.groupId]?.anchorId || 'normal-b',time:1}],total:payload.keyword?1:400};
      if(held)await held;return result;
    }
    if(action==='read.set'){writes.push(JSON.parse(JSON.stringify(payload)));return{readState:{readThroughId:'older',unreadCount:7}};}
    throw Error('Unexpected mock IPC '+action);
  };
  const context=vm.createContext({model,reading,filters,document,node,$,api,
    button:(text,fn,cls,props={})=>node('button',{...props,onclick:fn},text),
    field:(_label,input)=>node('label',{},input),
    check:(_label,checked,fn,props)=>node('label',{},node('input',{type:'checkbox',checked,...props,onchange:event=>fn(event.target.checked)})),
    emptyState:()=>node('div'),selectionBar:()=>node('div'),messageCard:message=>node('article',{'data-message-id':message.id}),
    messageSignature:JSON.stringify,dateLabel:()=>'',updateBusy(){},reportError:error=>errors.push(error),
    loadDemo(){},importData(){},jumpToLatest(){},jumpToLatestRead(){},handleReadingScroll(){},bindReadingInput(){},
    renderInspector(){},updateReadingSpace(){},updateReadChrome(){},updateUnreadBadges(){},
    renderSidebar(){},renderHeader(){},stashReadingDraft(){},restoreReadingDraft(){},
    loadBookmarks:async()=>host.replaceChildren(node('section')),
    renderSummaries(){},watchMessageSizes(){},scheduleRead(){},scheduleReadingRefresh(){},
    queueReadingRefresh:()=>model.queuedRefresh=(model.queuedRefresh || 0)+1,patchMessageList(){},
    readingOwner:()=>JSON.stringify([model.accountEpoch,model.state.account.id,model.groupId,model.queryVersion,model.view]),
    invalidateReadingIntent:()=>model.intentVersion++,resetReadCandidate:()=>model.intentVersion++,validReadCandidate:()=>false,
    captureViewport:()=>({...viewport}),locateReadBoundary:async()=>null,
    restoreViewport:anchor=>{restores.push(anchor && {...anchor});viewport=anchor?{...anchor}:{anchorId:model.messages[0]?.id,anchorOffset:0};model.viewport={...viewport};},
    findMessageElement:id=>$('message-scroll')?.querySelectorAll('[data-message-id]').find(element=>element.dataset.messageId===id),
    setTimeout:(callback,delay)=>{const id=++sequence;timers.set(id,{callback,due:now+delay});return id;},clearTimeout:id=>timers.delete(id)});
  vm.runInContext(extracted+';renderReading();',context);
  const run=code=>vm.runInContext(code,context);
  async function settle(){for(let i=0;i<35;i++)await Promise.resolve();assert.deepEqual(errors,[]);}
  async function tick(ms){const end=now+ms;for(;;){const next=[...timers].filter(([,v])=>v.due<=end).sort((a,b)=>a[1].due-b[1].due)[0];if(!next)break;now=next[1].due;timers.delete(next[0]);next[1].callback();await settle();}now=end;await settle();}
  const input=()=> $('message-search');
  function type(value,composing=false){input().value=value;input().dispatch('input',{isComposing:composing});}
  return{model,document,queries,writes,restores,run,tick,settle,input,type,
    start:()=>input().dispatch('compositionstart'),
    end:()=>input().dispatch('compositionend'),
    hold(){let release;barrier=new Promise(resolve=>release=resolve);return()=>{barrier=null;release();};}};
}

test('long IME composition preserves input identity/focus and submits only committed text once',async()=>{
  const h=harness(),input=h.input();input.focus();h.start();h.type('zhongwen',true);
  await h.tick(2300);assert.equal(h.queries.length,0);assert.equal(h.model.filters.keyword,'');
  h.run('renderReading()');assert.equal(h.input(),input);assert.equal(h.document.activeElement,input);
  h.type('\u4e2d\u6587',true);h.end();h.type('\u4e2d\u6587');await h.tick(350);
  assert.deepEqual(h.queries.map(query=>query.keyword),['\u4e2d\u6587']);
  assert.equal(h.input(),input);assert.equal(input.value,'\u4e2d\u6587');assert.equal(h.document.activeElement,input);
});
test('Enter during composition and compatibility keyCode 229 never prematurely submit',async()=>{
  const h=harness();h.start();h.type('zhong',true);
  h.input().dispatch('keydown',{key:'Enter',isComposing:true,keyCode:13});await h.tick(400);
  assert.equal(h.queries.length,0);
  h.type('\u4e2d',true);h.end();
  h.input().dispatch('keydown',{key:'Enter',isComposing:false,keyCode:229});await h.tick(120);
  assert.equal(h.queries.length,0);await h.tick(230);assert.equal(h.queries.length,1);
});
test('normal Enter replaces debounce and does not steal focus after awaiting IPC',async()=>{
  const h=harness();h.type('\u4e2d\u6587 English');const release=h.hold();
  const event=h.input().dispatch('keydown',{key:'Enter'});assert.equal(event.prevented,true);await h.settle();
  assert.equal(h.queries.length,1);h.document.activeElement=null;release();await h.settle();await h.tick(700);
  assert.equal(h.queries.length,1);assert.equal(h.document.activeElement,null);
});
test('an old query resolving during a new composition cannot replace results or editor',async()=>{
  const h=harness(),input=h.input();input.focus();const release=h.hold();h.type('old');await h.tick(350);
  const before=h.model.messages[0].id;h.start();h.type('xin',true);release();await h.settle();
  assert.equal(h.model.messages[0].id,before);assert.equal(h.input(),input);assert.equal(input.value,'xin');
  assert.equal(h.document.activeElement,input);h.type('\u65b0',true);h.end();h.type('\u65b0');await h.tick(350);
  assert.equal(h.model.messages[0].id,'group-a:\u65b0');
});
test('canceling composition after invalidating an in-flight query recovers a current readable pane',async()=>{
  const h=harness(),release=h.hold();h.type('committed');await h.tick(350);
  h.start();h.type('temporary pinyin',true);release();await h.settle();
  assert.equal(h.run('isCurrentReadingRendered()'),false);
  h.type('',true);h.end();await h.tick(350);
  assert.equal(h.run('isCurrentReadingRendered()'),true);assert.equal(h.run('searchEditing()'),false);
  assert.equal(h.model.filters.keyword,'');assert.equal(h.restores.at(-1).anchorId,'9007199254740993001');
});
test('background refresh defers during composition and rechecks composition after awaited IPC',async()=>{
  const h=harness(),input=h.input();input.focus();h.start();h.type('pinyin',true);
  await h.run('refreshReadingIncrementally(true)');assert.equal(h.queries.length,0);assert.equal(h.model.queuedRefresh,1);
  h.type('',true);h.end();await h.tick(350);
  const release=h.hold(),refresh=h.run('refreshReadingIncrementally(true)');await h.settle();
  const before=h.model.messages[0].id;h.start();h.type('new pinyin',true);release();await refresh;
  assert.equal(h.model.messages[0].id,before);assert.equal(h.input(),input);assert.equal(h.document.activeElement,input);
  assert.ok(h.model.queuedRefresh>=2);
});
test('continuous text, deletion, mixed-language paste and canceled composition use the final draft',async()=>{
  const h=harness();
  for(const value of ['\u4e2d','\u4e2d\u6587','\u4e2d\u6587 english']){h.type(value);await h.tick(100);}
  await h.tick(350);assert.deepEqual(h.queries.map(query=>query.keyword),['\u4e2d\u6587 english']);
  h.type('\u4e2d\u6587');await h.tick(350);
  h.start();h.type('cancel',true);h.type('\u4e2d\u6587',true);h.end();await h.tick(350);
  assert.equal(h.queries.at(-1).keyword,'\u4e2d\u6587');
  assert.equal(h.run('searchEditing()'),false);
});
test('clearing search restores the ordinary anchor and filtered panes never persist an anchor or unread advance',async()=>{
  const h=harness(),input=h.input();input.focus();
  h.type('\u641c\u7d22');await h.tick(350);
  const writes=h.writes.length;assert.equal(h.model.state.readStates['group-a'].anchorId,'9007199254740993001');
  await h.run('flushReading(false)');assert.equal(h.writes.length,writes);
  h.type('');await h.tick(350);
  assert.equal(h.input(),input);assert.equal(h.document.activeElement,input);
  assert.equal(h.restores.at(-1).anchorId,'9007199254740993001');assert.equal(h.restores.at(-1).anchorOffset,-28);
  assert.equal(h.model.state.readStates['group-a'].readThroughId,'older');
  assert.ok(h.writes.every(write=>!write.readThroughId));
});
test('clear-all resets other controls without replacing the connected search input',async()=>{
  const h=harness(),input=h.input();h.type('text');await h.tick(350);
  h.run("model.searchEditor.memberPicker.setSelected(['member-a']);model.searchEditor.filter.querySelector('#reading-start').value='2026-10-01T09:30'");
  await h.run("applyFilters({senderIds:['member-a'],start:'2026-10-01T09:30',importantOnly:true})");
  assert.deepEqual(h.queries.at(-1).senderIds,['member-a']);
  assert.equal(h.queries.at(-1).start,Date.parse('2026-10-01T09:30:00+08:00'));
  await h.run('clearReadingFilters()');assert.equal(h.input(),input);assert.equal(input.value,'');
  assert.deepEqual(JSON.parse(JSON.stringify(h.model.filters)),{keyword:'',senderIds:[],start:'',end:'',importantOnly:false});
  assert.equal(h.queries.at(-1).keyword,'');assert.deepEqual(h.queries.at(-1).senderIds,[]);
  assert.equal('start' in h.queries.at(-1),false);
  assert.equal('end' in h.queries.at(-1),false);
  assert.deepEqual(h.run('model.searchEditor.memberPicker.getSelected()'),[]);
  assert.equal(h.run("model.searchEditor.filter.querySelector('#reading-start').value"),'');
  assert.equal(h.run("model.searchEditor.filter.querySelector('#reading-end').value"),'');
});
test('switching group cancels a pending old draft and new queries remain group scoped',async()=>{
  const h=harness();h.type('old pending');await h.run("selectGroup('group-b')");await h.tick(700);
  assert.equal(h.queries.filter(query=>query.keyword==='old pending').length,0);
  h.type('\u65b0\u7fa4');await h.tick(350);assert.equal(h.queries.at(-1).groupId,'group-b');
  assert.equal(h.queries.at(-1).keyword,'\u65b0\u7fa4');
});
test('leaving the reading view cancels the draft timer and rejects a held old result',async()=>{
  const h=harness();h.type('pending');await h.run("setView('bookmarks')");await h.tick(700);assert.equal(h.queries.length,0);
  await h.run("setView('read')");const release=h.hold();h.type('held');await h.tick(350);
  await h.run("setView('bookmarks')");release();await h.settle();assert.equal(h.model.view,'bookmarks');assert.equal(h.input(),null);
});
test('account epoch and detached DOM independently invalidate a pending editor',async()=>{
  for(const change of ["model.accountEpoch++;model.state.account.id='account-b'","model.searchEditor.input.remove()"]){
    const h=harness();h.type('private draft');h.run(change);await h.tick(700);assert.equal(h.queries.length,0);
  }
});
test('a group changed by group selection settings can load despite the previous group editor',async()=>{
  const h=harness();h.run("model.groupId='group-b'");
  await h.run('loadReading(true)');assert.equal(h.model.renderedReading.groupId,'group-b');
  assert.equal(h.queries.at(-1).groupId,'group-b');assert.equal(h.run('isSearchEditorCurrent(model.searchEditor)'),true);
});
