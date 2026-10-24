'use strict';
const {randomBytes}=require('node:crypto');
const {operate}=require('./message-cleanup-operation.cjs');
const TTL_MS=5*60*1000,MAX_PREVIEWS=16;
const validId=value=>typeof value==='string'&&value.trim()===value&&value.length>0&&value.length<=256&&!/[\u0000-\u001f]/.test(value);
const copy=value=>JSON.parse(JSON.stringify(value));

// Confirmation capabilities remain captured-account/epoch bound and single use.
// Worker preparation cannot alter the account; the main process publishes once.
function createMessageCleanupController({store,getContext,onChange=()=>{},now=Date.now,asyncOperations=true,taskOptions={}}) {
  const previews=new Map();let active=null,pending=null;
  function context(p,mutation=false){
    const c=getContext();
    if(!p||!validId(p.accountId)||p.accountId!==c.accountId||c.closing)throw new Error('当前账号已变化或窗口正在关闭，请重新打开本地数据管理。');
    if((mutation&&c.busy)||active?.running)throw new Error('已有操作正在进行，请完成后再管理本地数据。');
    return c;
  }
  function group(p){if(!validId(p.groupId)||(!asyncOperations&&!store.getSnapshot(p.accountId).groups.some(g=>g.id===p.groupId)))throw new Error('请选择有效的本地群聊。');}
  function prune(){for(const [key,p]of previews)if(p.expiresAt<=now())previews.delete(key);}
  function changed(result){return !!(result?.deleted||result?.purged||result?.restored);}
  function run(p,action,payload,kind=action){
    if(!asyncOperations){
      let result;
      if(action==='apply')result=store.applyMessageCleanup(p.accountId,payload.selection,payload.fingerprint);
      else if(action==='purgeApply')result=store.applyMessagePurge(p.accountId,payload.selection,payload.fingerprint);
      else if(action==='restore'){
        if(!store.listMessageTrash(p.accountId,{groupId:p.groupId}).some(b=>b.id===payload.batchId))throw Error('这批回收记录不在当前群，请刷新后再试。');
        result=store.restoreMessageTrash(p.accountId,payload.batchId);
      }else result=operate(store.getSnapshot(p.accountId),action,payload,{now}).result;
      if(changed(result))onChange({...result,accountId:p.accountId,groupId:p.groupId});
      return result;
    }
    const jobId=randomBytes(16).toString('hex');
    const job={accountId:p.accountId,groupId:p.groupId,jobId,kind,phase:'reading',processed:null,total:null,unit:'messages',running:true,completed:false,error:null,commitState:'not-committed'};active=job;
    const operation=store.runCleanupTask(p.accountId,action,payload,{...taskOptions,jobId,onProgress:progress=>{
      if(active!==job||!job.running)return;
      job.phase=progress.phase;job.processed=Number.isSafeInteger(progress.processed)&&progress.processed>=0?progress.processed:null;
      job.total=Number.isSafeInteger(progress.total)&&progress.total>=0?progress.total:null;job.unit=progress.unit==='bytes'?'bytes':'messages';
    }}).then(result=>{
      const scoped=Array.isArray(result)?result:{...result,accountId:p.accountId,groupId:p.groupId};
      job.running=false;job.completed=true;job.phase='completed';job.error=null;
      job.commitState=changed(result)?'committed':'not-committed';
      const count=result?.purgedCount??result?.deletedCount??result?.restoredCount;
      job.processed=Number.isSafeInteger(count)?count:null;job.total=job.processed;job.unit='messages';
      job.result=Number.isSafeInteger(count)?{accountId:p.accountId,groupId:p.groupId,mode:result.mode||kind,count,deleted:!!result.deleted,purged:!!result.purged,restored:!!result.restored}:null;
      if(changed(result))try{onChange(scoped);}catch{job.notificationError=true;}
      return scoped;
    },error=>{job.running=false;job.completed=false;job.commitState=error.commitState||'not-committed';job.phase=job.commitState==='uncertain'?'uncertain':'failed';job.error=error.message;job.result=null;throw error;});
    pending=operation;
    operation.then(()=>{if(pending===operation)pending=null;},()=>{if(pending===operation)pending=null;});
    return operation;
  }
  function decoratePlan(p,c,plan,type){
    const current=getContext();if(current.accountId!==p.accountId||current.epoch!==c.epoch||current.closing)throw Error('当前账号已变化，清理预览已失效。');
    prune();while(previews.size>=MAX_PREVIEWS)previews.delete(previews.keys().next().value);
    const token=randomBytes(32).toString('hex');previews.set(token,{type,accountId:p.accountId,groupId:p.groupId,epoch:c.epoch,selection:plan.selection,fingerprint:plan.fingerprint,expiresAt:now()+TTL_MS});
    return{...plan,accountId:p.accountId,groupId:p.groupId,confirmationToken:token};
  }
  function preview(p,type){
    const c=context(p);group(p);const result=run(p,type==='purge'?'purgePreview':'preview',p,'preview');
    return result?.then?result.then(plan=>decoratePlan(p,c,plan,type)):decoratePlan(p,c,result,type);
  }
  function apply(p,type){
    const c=context(p,true);group(p);
    if(p.confirmed!==true||typeof p.confirmationToken!=='string'||!/^[a-f0-9]{64}$/.test(p.confirmationToken))throw new Error('请先预览筛选结果，再明确确认所选本地清理操作。');
    const plan=previews.get(p.confirmationToken);previews.delete(p.confirmationToken);prune();
    if(!plan||plan.type!==type||plan.expiresAt<=now()||plan.accountId!==p.accountId||plan.groupId!==p.groupId||plan.epoch!==c.epoch)throw new Error('清理预览已失效，请重新预览后确认。');
    const mode=type==='purge'?'purge':plan.selection.mode||'recycle';
    const result=run(p,type==='purge'?'purgeApply':'apply',{groupId:p.groupId,selection:plan.selection,fingerprint:plan.fingerprint},mode);
    const scope=value=>({...value,mode,accountId:p.accountId,groupId:p.groupId});
    return result?.then?result.then(scope):scope(result);
  }
  return {
    clear(){previews.clear();},
    isBusy(accountId){return !!active?.running&&(accountId===undefined||active.accountId===accountId);},
    whenIdle(){return pending?pending.then(()=>undefined,()=>undefined):Promise.resolve();},
    status(p={}){const c=getContext();if(!validId(p.accountId)||p.accountId!==c.accountId||active?.accountId!==p.accountId)return{accountId:p.accountId||null,running:false,completed:false,phase:'idle',processed:null,total:null,error:null};return copy(active);},
    info(p){context(p);group(p);return run(p,'info',p,'info');},
    preview(p){return preview(p,'cleanup');},
    apply(p){return apply(p,'cleanup');},
    purgePreview(p){return preview(p,'purge');},
    purgeApply(p){return apply(p,'purge');},
    list(p){context(p);group(p);return run(p,'list',p,'list');},
    restore(p){context(p,true);group(p);if(!validId(p.batchId))throw Error('这批回收记录不在当前群，请刷新后再试。');const result=run(p,'restore',p,'restore');const scope=value=>({...value,accountId:p.accountId,groupId:p.groupId});return result?.then?result.then(scope):scope(result);}
  };
}
module.exports={createMessageCleanupController,TTL_MS,MAX_PREVIEWS};
