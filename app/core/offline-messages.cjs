'use strict';
function fail(code,message){throw Object.assign(new Error(message),{code});}
function fields(value,allowed){
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('OFFLINE_INVALID','离线消息设置无效。');
 const ds=Object.getOwnPropertyDescriptors(value);
 if(Reflect.ownKeys(ds).some(k=>!allowed.includes(k)||!Object.hasOwn(ds[k],'value')||!ds[k].enumerable))fail('OFFLINE_INVALID','离线消息设置字段无效。');
 return value;
}
function validateOfflineMessages(value){
 fields(value,['mode','date']);
 if(!['auto','none','date'].includes(value.mode))fail('OFFLINE_INVALID','请选择离线消息补齐方式。');
 if(value.mode!=='date'){
  if(Object.hasOwn(value,'date'))fail('OFFLINE_INVALID','仅指定日期模式可以包含日期。');
  return {mode:value.mode};
 }
 if(typeof value.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value.date))fail('OFFLINE_INVALID','请选择有效日期（YYYY-MM-DD）。');
 const utc=Date.parse(value.date+'T00:00:00.000Z');
 if(!Number.isFinite(utc)||new Date(utc).toISOString().slice(0,10)!==value.date||value.date<'1970-01-01')fail('OFFLINE_INVALID','日期无效，请选择 1970 年起的有效日期。');
 return {mode:'date',date:value.date};
}
function normalizeOfflineMessages(value){return value===undefined?{mode:'auto'}:validateOfflineMessages(value);}
function offlineCutoff(value){return Date.parse(validateOfflineMessages(value).date+'T00:00:00+08:00');}
function saveOfflineMessages({store,payload,getContext,now=Date.now}){
 fields(payload,['accountId','offlineMessages','expectedOfflineMessages']);
 if(typeof payload.accountId!=='string'||!payload.accountId||!Object.hasOwn(payload,'expectedOfflineMessages'))fail('OFFLINE_INVALID','设置缺少账号或原补齐方式，请重新打开设置。');
 const next=validateOfflineMessages(payload.offlineMessages),expected=validateOfflineMessages(payload.expectedOfflineMessages),owner=getContext();
 if(next.mode==='date'&&next.date>new Date(now()+8*60*60*1000).toISOString().slice(0,10))fail('OFFLINE_INVALID','所选日期不能晚于今天（北京时间）。');
 const check=()=>{const c=getContext();if(payload.accountId!==owner.accountId||c.accountId!==owner.accountId||c.epoch!==owner.epoch)fail('OFFLINE_ACCOUNT_CHANGED','当前账号已变化，请重新打开设置。');if(c.busy||c.closing)fail('OFFLINE_BUSY','操作或同步正在进行，请完成后再保存。');};
 check();store.update(owner.accountId,s=>{check();if(JSON.stringify(normalizeOfflineMessages(s.settings.offlineMessages))!==JSON.stringify(expected))fail('OFFLINE_STALE','离线消息设置已变化，请重新打开设置。');if(next.mode==='date'&&JSON.stringify(next)!==JSON.stringify(expected))for(const group of s.groups)delete group.offlineDateScan;s.settings.offlineMessages=next;});
 return next;
}
// A deletion floor belongs to one group; it never rewrites the account preference.
function effectiveOfflineMessages(group,value){
 const policy=normalizeOfflineMessages(value),floor=group?.historyBoundary?.start;
 if(policy.mode==='none')return policy;
 const cutoff=Math.max(policy.mode==='date'?offlineCutoff(policy):0,Number.isFinite(floor)?floor:0);
 if(!cutoff)return policy;
 return {mode:'date',date:new Date(cutoff+8*3600000).toISOString().slice(0,10),cutoff};
}
function matchesOfflineScan(scan,policy){
 return !!scan&&policy.mode==='date'&&scan.date===policy.date&&(scan.cutoff??offlineCutoff({mode:'date',date:scan.date}))===(policy.cutoff??offlineCutoff(policy));
}
module.exports={validateOfflineMessages,normalizeOfflineMessages,offlineCutoff,saveOfflineMessages,effectiveOfflineMessages,matchesOfflineScan};
