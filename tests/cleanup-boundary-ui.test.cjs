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
async function setup({delayInfo=false,delayPreview=false,deletedCount=0,boundaryPlan,applyError=false,delayRecovery=false}={}){
 const calls=[],operations=[],info=deferred(),preview=deferred(),recovery=deferred();let dialog,closed=false,current=true;
 const node=(tag,attrs,...children)=>new Element(tag,attrs,children),button=(text,click,cls='',attrs={})=>node('button',{...attrs,click},text);
 const plan=selection=>({boundaryPlan,selection,groupId:'g',groupName:'Synthetic',range:{start:0,end:60000},mode:selection.mode,matchedCount:4,retainedCount:selection.markUnreadAsRead?1:3,deleteCount:selection.markUnreadAsRead?3:1,unreadCount:3,markedReadCount:selection.markUnreadAsRead?2:0,retainedUnreadCount:selection.markUnreadAsRead?1:3,confirmationToken:'token-'+calls.length});
 const h={node,button,field:(_label,e)=>e,check:(text,checked,change,attrs)=>node('input',{...attrs,type:'checkbox',checked,change},text),modal:(title,body,actions)=>dialog=node('dialog',{title},body,...actions),closeModal:()=>closed=true,toast:()=>{},accountId:'a',groupId:'g',groups:[{id:'g',name:'Synthetic'}],isCurrent:()=>current,
 api:async(action,payload)=>{calls.push({action,payload});if(action.endsWith('.info'))return delayInfo?info.promise:{oldest:0,activeCount:4,deletedCount,members:[]};if(action==='messages.historyRecovery.apply'){if(applyError)throw Error('保存失败');return delayRecovery?recovery.promise:{scheduled:true};}if(action==='messages.historyRecovery.preview')return {groupId:'g',range:{start:0,end:60000},tombstoneCount:2,confirmationToken:'recovery-token'};return delayPreview?preview.promise:plan(payload);},
 filters:{parseChinaMinuteRange(){},createMemberPicker:()=>({destroy(){},setMembers(){},setSelected(){}})},performOperation:async spec=>{operations.push(spec);spec.onStarted();}};
 const context=vm.createContext({window:{WeiyueCleanupProgress:progress},Date});vm.runInContext(source,context);await context.WeiyueCleanup.open(h);await tick();
 return{calls,operations,info,preview,recovery,plan,get:selector=>dialog.querySelector(selector),get closed(){return closed;},switchAccount:()=>current=false};
}

test('only permanent deletion is offered, legacy trash is hidden when empty',async()=>{
 const h=await setup();assert.equal(h.get('#cleanup-mode'),null);assert.equal(h.get('#cleanup-trash').hidden,true);await h.get('#cleanup-preview').click();assert.equal(h.calls.at(-1).payload.mode,'permanent');await h.get('#cleanup-confirm').click();assert.equal(h.operations[0].kind,'permanent');
});
test('legacy trash remains accessible only when records exist',async()=>{const h=await setup({deletedCount:3});assert.equal(h.get('#cleanup-trash').hidden,false);});
test('prefix deletion preview exposes precise next boundary and cancellation is read-only',async()=>{
 const h=await setup({boundaryPlan:{advances:true,newStart:Date.parse('2026-11-08T00:00:00+08:00')}});await h.get('#cleanup-preview').click();assert.match(h.get('#cleanup-boundary-plan').children.join(''),/2026-11-08 00:00/);await h.get('#cleanup-back').click();assert.equal(h.operations.length,0);
});
test('middle deletion explicitly leaves retained floor alone',async()=>{const h=await setup({boundaryPlan:{advances:false}});await h.get('#cleanup-preview').click();assert.match(h.get('#cleanup-boundary-plan').children.join(''),/不移动/);});
test('history recovery preview and return never apply',async()=>{const h=await setup();await h.get('#cleanup-recover-history').click();await h.get('#history-recovery-preview').click();assert.equal(h.calls.at(-1).action,'messages.historyRecovery.preview');await h.get('#history-recovery-back').click();assert.equal(h.calls.filter(c=>c.action.endsWith('.apply')).length,0);});
test('history recovery confirmation is account scoped and single-use during pending request',async()=>{const h=await setup({delayRecovery:true});await h.get('#cleanup-recover-history').click();await h.get('#history-recovery-preview').click();const confirm=h.get('#history-recovery-confirm'),pending=confirm.click();await confirm.click();assert.equal(h.calls.filter(c=>c.action==='messages.historyRecovery.apply').length,1);assert.deepEqual(JSON.parse(JSON.stringify(h.calls.at(-1).payload)),{accountId:'a',groupId:'g',confirmationToken:'recovery-token',confirmed:true});h.recovery.resolve({scheduled:true});await pending;assert.equal(h.closed,true);});
test('history recovery error stays open and cannot resubmit same token',async()=>{const h=await setup({applyError:true});await h.get('#cleanup-recover-history').click();await h.get('#history-recovery-preview').click();const confirm=h.get('#history-recovery-confirm');await confirm.click();assert.match(h.get('#history-recovery-result').textContent,/保存失败/);assert.equal(confirm.disabled,true);await confirm.click();assert.equal(h.calls.filter(c=>c.action==='messages.historyRecovery.apply').length,1);assert.equal(h.closed,false);});
test('account change blocks history recovery confirmation',async()=>{const h=await setup();await h.get('#cleanup-recover-history').click();await h.get('#history-recovery-preview').click();const confirm=h.get('#history-recovery-confirm');h.switchAccount();await assert.rejects(confirm.click(),/已变化/);assert.equal(h.calls.filter(c=>c.action==='messages.historyRecovery.apply').length,0);});

test('zero messages still allows explicitly previewed boundary advance',async()=>{const h=await setup({delayPreview:true});const pending=h.get('#cleanup-preview').click();h.preview.resolve({...h.plan(h.calls.at(-1).payload),deleteCount:0,boundaryPlan:{advances:true,newStart:Date.parse('2026-11-08T00:00:00+08:00')}});await pending;assert.equal(h.get('#cleanup-confirm').disabled,false);await h.get('#cleanup-confirm').click();assert.equal(h.operations.length,1);});
