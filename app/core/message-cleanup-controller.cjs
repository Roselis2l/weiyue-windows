'use strict';
const {randomBytes}=require('node:crypto');
const TTL_MS=5*60*1000,MAX_PREVIEWS=16;
const validId=value=>typeof value==='string'&&value.trim()===value&&value.length>0&&value.length<=256&&!/[\u0000-\u001f]/.test(value);

// Confirmation capabilities remain in the main process, are account/epoch bound,
// and are consumed before the atomic store operation (including on failure).
function createMessageCleanupController({store,getContext,onChange=()=>{},now=Date.now}) {
  const previews=new Map();
  function context(p,mutation=false){
    const c=getContext();
    if(!p||!validId(p.accountId)||p.accountId!==c.accountId||c.closing)throw new Error('当前账号已变化或窗口正在关闭，请重新打开本地数据管理。');
    if(mutation&&c.busy)throw new Error('已有操作正在进行，请完成后再管理本地数据。');
    return c;
  }
  function group(p){
    if(!validId(p.groupId)||!store.get(p.accountId).groups.some(g=>g.id===p.groupId))throw new Error('请选择有效的本地群聊。');
  }
  function prune(){for(const [key,p] of previews)if(p.expiresAt<=now())previews.delete(key);}
  return {
    clear(){previews.clear();},
    info(p){
      context(p);group(p);
      const records=store.get(p.accountId).messages.filter(m=>m.groupId===p.groupId),members=new Map();
      let oldest=null,newest=null,activeCount=0,deletedCount=0;
      for(const m of records){members.set(m.senderId,m.senderName);if(m.localDeletion){deletedCount++;continue;}activeCount++;oldest=oldest===null?m.time:Math.min(oldest,m.time);newest=newest===null?m.time:Math.max(newest,m.time);}
      return {accountId:p.accountId,groupId:p.groupId,activeCount,deletedCount,oldest,newest,members:[...members].map(([id,name])=>({id,name})),now:now()};
    },
    preview(p){
      const c=context(p);group(p);prune();
      const plan=store.previewMessageCleanup(p.accountId,p);
      while(previews.size>=MAX_PREVIEWS)previews.delete(previews.keys().next().value);
      const token=randomBytes(32).toString('hex');
      previews.set(token,{accountId:p.accountId,groupId:p.groupId,epoch:c.epoch,selection:plan.selection,fingerprint:plan.fingerprint,expiresAt:now()+TTL_MS});
      return {...plan,accountId:p.accountId,groupId:p.groupId,confirmationToken:token};
    },
    apply(p){
      const c=context(p,true);group(p);
      if(p.confirmed!==true||typeof p.confirmationToken!=='string'||!/^[a-f0-9]{64}$/.test(p.confirmationToken))throw new Error('请先预览筛选结果，再明确确认移入本地回收区。');
      const preview=previews.get(p.confirmationToken);previews.delete(p.confirmationToken);prune();
      if(!preview||preview.expiresAt<=now()||preview.accountId!==p.accountId||preview.groupId!==p.groupId||preview.epoch!==c.epoch)throw new Error('清理预览已失效，请重新预览后确认。');
      const result=store.applyMessageCleanup(p.accountId,preview.selection,preview.fingerprint);if(result.deleted)onChange();
      return {...result,accountId:p.accountId,groupId:p.groupId};
    },
    list(p){context(p);group(p);return store.listMessageTrash(p.accountId,{groupId:p.groupId});},
    restore(p){
      context(p,true);group(p);
      if(!validId(p.batchId)||!store.listMessageTrash(p.accountId,{groupId:p.groupId}).some(b=>b.id===p.batchId))throw new Error('这批回收记录不在当前群，请刷新后再试。');
      const result=store.restoreMessageTrash(p.accountId,p.batchId);if(result.restored)onChange();
      return {...result,accountId:p.accountId,groupId:p.groupId};
    }
  };
}
module.exports={createMessageCleanupController,TTL_MS,MAX_PREVIEWS};
