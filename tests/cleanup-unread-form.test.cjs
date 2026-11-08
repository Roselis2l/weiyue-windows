'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const progress=require('../app/renderer/cleanup-progress.js');
const source=fs.readFileSync(require.resolve('../app/renderer/message-cleanup.js'),'utf8');
class Element{
 constructor(tag,attrs={},children=[]){this.tag=tag;Object.assign(this,attrs);this.dataset={};this.children=children.flat(Infinity).filter(x=>x!==null&&x!==undefined);this.disabled=!!attrs.disabled;this.listeners={};}
 setAttribute(k,v){this[k]=v;}addEventListener(k,f){this.listeners[k]=f;}focus(){this.focused=true;}
 contains(e){return this===e||this.children.some(c=>c instanceof Element&&c.contains(e));}
 querySelectorAll(selector){const terms=selector.split(',');return this.children.flatMap(c=>c instanceof Element?[...(terms.includes(c.tag)?[c]:[]),...c.querySelectorAll(selector)]:[]);}
 querySelector(selector){if(!selector.startsWith('#'))return null;const id=selector.slice(1);return this.children.flatMap(c=>c instanceof Element?[c,...c.querySelectorAll('input,button,select,p,div,section')]:[]).find(c=>c.id===id)||null;}
}
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return{resolve,promise};}
const tick=()=>new Promise(r=>setImmediate(r));
async function setup({delayInfo=false,delayPreview=false}={}){
 const calls=[],operations=[],info=deferred(),preview=deferred();let dialog,closed=false,current=true;
 const node=(tag,attrs,...children)=>new Element(tag,attrs,children),button=(text,click,cls='',attrs={})=>node('button',{...attrs,click},text);
 const plan=selection=>({selection,groupId:'g',groupName:'Synthetic',range:{start:0,end:60000},mode:selection.mode,matchedCount:4,retainedCount:selection.markUnreadAsRead?1:3,deleteCount:selection.markUnreadAsRead?3:1,unreadCount:3,markedReadCount:selection.markUnreadAsRead?2:0,retainedUnreadCount:selection.markUnreadAsRead?1:3,confirmationToken:'token-'+calls.length});
 const h={node,button,field:(_label,e)=>e,check:(text,checked,change,attrs)=>node('input',{...attrs,type:'checkbox',checked,change},text),modal:(title,body,actions)=>dialog=node('dialog',{},body,...actions),closeModal:()=>closed=true,toast:()=>{},accountId:'a',groupId:'g',groups:[{id:'g',name:'Synthetic'}],isCurrent:()=>current,
 api:async(action,payload)=>{calls.push({action,payload});if(action.endsWith('.info'))return delayInfo?info.promise:{oldest:0,activeCount:4,deletedCount:0,members:[]};return delayPreview?preview.promise:plan(payload);},
 filters:{parseChinaMinuteRange(){},createMemberPicker:()=>({destroy(){},setMembers(){},setSelected(){}})},performOperation:async spec=>{operations.push(spec);spec.onStarted();}};
 const context=vm.createContext({window:{WeiyueCleanupProgress:progress},Date});vm.runInContext(source,context);await context.WeiyueCleanup.open(h);await tick();
 return{calls,operations,info,preview,plan,get:selector=>dialog.querySelector(selector),get closed(){return closed;},switchAccount:()=>current=false};
}
test('checkbox defaults off; preview and cancellation do not submit a write',async()=>{
 const h=await setup();assert.equal(h.get('#cleanup-mark-unread').checked,false);await h.get('#cleanup-preview').click();assert.equal(h.calls.at(-1).payload.markUnreadAsRead,false);assert.match(h.get('#cleanup-unread-counts').children.join(''),/保留未读 3 条/);assert.equal(h.operations.length,0);
});
test('back and toggle must obtain a new preview, then only submit the reviewed token once',async()=>{
 const h=await setup();h.get('#cleanup-mark-unread').change(true);await h.get('#cleanup-preview').click();assert.equal(h.calls.at(-1).payload.markUnreadAsRead,true);assert.match(h.get('#cleanup-confirm').children.join(''),/标记已读 2 条/);
 await h.get('#cleanup-back').click();await tick();assert.equal(h.get('#cleanup-mark-unread').checked,true);h.get('#cleanup-mark-unread').change(false);await h.get('#cleanup-preview').click();assert.equal(h.calls.at(-1).payload.markUnreadAsRead,false);const confirm=h.get('#cleanup-confirm');await confirm.click();await assert.rejects(confirm.click(),/已变化/);assert.equal(h.operations.length,1);assert.equal(h.operations[0].expectedMarkedReadCount,0);assert.equal(h.closed,true);
});
test('changing checkbox while info loads cannot strand preview disabled',async()=>{
 const h=await setup({delayInfo:true});h.get('#cleanup-mark-unread').change(true);h.info.resolve({oldest:0,activeCount:4,deletedCount:0,members:[]});await tick();assert.equal(h.get('#cleanup-preview').disabled,false);await h.get('#cleanup-preview').click();assert.equal(h.calls.at(-1).payload.markUnreadAsRead,true);
});
test('late preview after option change or account switch cannot expose confirmation',async()=>{
 for(const change of [h=>h.get('#cleanup-mark-unread').change(true),h=>h.switchAccount()]){const h=await setup({delayPreview:true}),pending=h.get('#cleanup-preview').click();const selection=h.calls.at(-1).payload;change(h);h.preview.resolve(h.plan(selection));await pending;assert.equal(h.get('#cleanup-confirm'),null);assert.equal(h.operations.length,0);}
});
