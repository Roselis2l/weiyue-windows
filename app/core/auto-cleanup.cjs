'use strict';
const {randomBytes}=require('node:crypto');
const DAY=86400000,OFFSET=8*3600000,INTERVAL=3600000;
const DEFAULT=Object.freeze({enabled:false,days:30,markUnreadAsRead:false,lastRun:null});
const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
function normalizePolicy(value=DEFAULT){
 if(!object(value)||Object.keys(value).some(k=>!['enabled','days','markUnreadAsRead','lastRun'].includes(k))||typeof value.enabled!=='boolean'||!Number.isInteger(value.days)||value.days<1||value.days>3650||typeof value.markUnreadAsRead!=='boolean'||(value.lastRun!==undefined&&value.lastRun!==null&&(!Number.isSafeInteger(value.lastRun)||value.lastRun<0)))throw Error('自动删除设置无效，请使用 1–3650 的整数天数。');
 return{enabled:value.enabled,days:value.days,markUnreadAsRead:value.markUnreadAsRead,lastRun:value.lastRun??null};
}
function normalizePolicies(raw,groupIds){
 if(raw===undefined)return undefined;
 if(!object(raw)||Object.keys(raw).length>10000)throw Error('自动删除设置无效。');
 const result={};for(const [id,p]of Object.entries(raw)){if(!groupIds.has(id))throw Error('自动删除所属群不存在。');Object.defineProperty(result,id,{value:normalizePolicy(p),enumerable:true,writable:true,configurable:true});}return result;
}
function policyOf(state,groupId){return normalizePolicy(state.settings.autoCleanup?.[groupId]??DEFAULT);}
function editable(p){return normalizePolicy({enabled:p.enabled,days:p.days,markUnreadAsRead:p.markUnreadAsRead});}
function signature(p){return JSON.stringify([p.enabled,p.days,p.markUnreadAsRead]);}
function cutoffFor(days,now){return Math.max(0,Math.floor((now+OFFSET)/DAY)*DAY-OFFSET-(days-1)*DAY);}
function minute(time){return new Date(time+OFFSET).toISOString().slice(0,16);}
function autoPreview(state,groupId,policy,now=Date.now(),options={}){
 const cutoff=cutoffFor(policy.days,now);
 const selection={groupId,startMinute:minute(0),endMinute:minute(Math.max(0,cutoff-60000)),mode:'permanent',retainSenderIds:[],retainSummaryRanges:true,markUnreadAsRead:policy.markUnreadAsRead};
 const plan=require('./message-cleanup.cjs').previewMessageCleanup(state,selection,options);
 return{...plan,...policy,config:policy,cutoff};
}
function autoApply(state,payload,{now=Date.now,onProgress}={}){
 const policy=policyOf(state,payload.groupId),at=now();
 if(!policy.enabled||signature(policy)!==payload.policySignature)return{result:{skipped:true,reason:'policy-changed'},changed:false};
 if(policy.lastRun!==null&&at-policy.lastRun<INTERVAL)return{result:{skipped:true,reason:'not-due'},changed:false};
 const plan=autoPreview(state,payload.groupId,policy,at,{onProgress});
 const result=require('./message-cleanup.cjs').applyMessageCleanup(state,plan.selection,plan.fingerprint,{now:()=>at,onProgress});
 state.settings.autoCleanup={...state.settings.autoCleanup,[payload.groupId]:{...policy,lastRun:at}};
 return{result:{...result,automatic:true,cutoff:plan.cutoff,lastRun:at},changed:true};
}
function createAutoCleanup({store,getContext,onChange=()=>{},now=Date.now,setIntervalFn=setInterval,clearIntervalFn=clearInterval}){
 let active=null,timer=null;const previews=new Map(),backoff=new Map();
 function ctx(p){const c=getContext();if(!p||p.accountId!==c.accountId||c.closing)throw Error('当前账号已变化，请重新打开设置。');const state=store.getSnapshot(c.accountId);if(!state.groups.some(g=>g.id===p.groupId))throw Error('请选择有效群聊。');return{...c,state};}
 function result(p,state){return{accountId:p.accountId,groupId:p.groupId,...policyOf(state,p.groupId)};}
 function prune(){for(const [key,p]of previews)if(p.expiresAt<=now())previews.delete(key);while(previews.size>=16)previews.delete(previews.keys().next().value);}
 function ready(c){if(c.busy||active)throw Error('当前操作进行中，请稍后重试。');}
 async function preview(p){const c=ctx(p);ready(c);const policy=editable(p);if(!policy.enabled)throw Error('请先选择启用自动删除。');
  const plan=await store.runCleanupTask(p.accountId,'autoPreview',{groupId:p.groupId,policy});
  const latest=ctx(p);if(latest.epoch!==c.epoch)throw Error('当前账号已变化，请重新预览。');
  prune();const token=randomBytes(32).toString('hex');previews.set(token,{accountId:p.accountId,groupId:p.groupId,epoch:c.epoch,signature:signature(policy),expiresAt:now()+300000});return{...plan,confirmationToken:token};
 }
 function save(p){const c=ctx(p);ready(c);const policy=editable(p);
  if(policy.enabled){const token=previews.get(p.confirmationToken);previews.delete(p.confirmationToken);if(p.confirmed!==true||!token||token.expiresAt<=now()||token.accountId!==p.accountId||token.groupId!==p.groupId||token.epoch!==c.epoch||token.signature!==signature(policy))throw Error('请预览并确认自动删除设置。');}
  store.update(p.accountId,state=>{state.settings.autoCleanup={...state.settings.autoCleanup,[p.groupId]:policy};});backoff.delete(p.accountId+'|'+p.groupId);onChange({settingsChanged:true,accountId:p.accountId,groupId:p.groupId});return result(p,store.getSnapshot(p.accountId));
 }
 async function tick(){
  const c=getContext();if(active||c.busy||c.closing||!c.accountId)return{skipped:true};
  const state=store.getSnapshot(c.accountId);const at=now();
  const group=state.groups.find(g=>{const p=policyOf(state,g.id);return p.enabled&&(p.lastRun===null||at-p.lastRun>=INTERVAL)&&(backoff.get(c.accountId+'|'+g.id)||0)<=at;});
  if(!group)return{skipped:true};
  const policy=policyOf(state,group.id),key=c.accountId+'|'+group.id;
  const operation=store.runCleanupTask(c.accountId,'autoApply',{groupId:group.id,policySignature:signature(policy)});active=operation;
  try{const r=await operation;onChange({...r,accountId:c.accountId,groupId:group.id});return r;}
  catch(error){backoff.set(key,now()+INTERVAL);return{failed:true,error:error.message};}
  finally{if(active===operation)active=null;}
 }
 return{get(p){const c=ctx(p);return result(p,c.state);},preview,save,tick,isBusy:()=>!!active,whenIdle:()=>active?active.then(()=>{},()=>{}):Promise.resolve(),clear(){previews.clear();},start(){if(!timer){timer=setIntervalFn(()=>{void tick().catch(()=>{});},60000);timer.unref?.();}},stop(){if(timer)clearIntervalFn(timer);timer=null;previews.clear();}};
}
module.exports={DEFAULT,INTERVAL,normalizePolicy,normalizePolicies,policyOf,signature,cutoffFor,autoPreview,autoApply,createAutoCleanup};
