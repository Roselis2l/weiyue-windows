'use strict';
const cleanup=require('./message-cleanup.cjs');

// This dispatcher owns no IO. Worker and unit-test execution share the same
// selection and validation behavior, without passing account content over IPC.
function operate(state,action,payload,{now=Date.now,onProgress=()=>{}}={}){
  if(!state.groups.some(g=>g.id===payload.groupId))throw Error('请选择有效的本地群聊。');
  let result,changed=false;
  if(action==='info'){
    let oldest=null,newest=null,activeCount=0,deletedCount=0;const members=new Map();
    for(const m of state.messages){if(m.groupId!==payload.groupId)continue;members.set(m.senderId,m.senderName);if(m.localDeletion){deletedCount++;continue;}activeCount++;oldest=oldest===null?m.time:Math.min(oldest,m.time);newest=newest===null?m.time:Math.max(newest,m.time);}
    result={accountId:state.account.id,groupId:payload.groupId,oldest,newest,activeCount,deletedCount,
      permanentCount:(state.messageTombstones||[]).filter(m=>m.groupId===payload.groupId).length,members:[...members].map(([id,name])=>({id,name})),now:now()};
  }else if(action==='preview')result=cleanup.previewMessageCleanup(state,payload,{onProgress});
  else if(action==='purgePreview')result=cleanup.previewMessagePurge(state,payload,{onProgress});
  else if(action==='list')result=cleanup.listMessageTrash(state,payload);
  else if(action==='apply'){result=cleanup.applyMessageCleanup(state,payload.selection,payload.fingerprint,{now,onProgress});changed=result.deleted;}
  else if(action==='purgeApply'){result=cleanup.applyMessagePurge(state,payload.selection,payload.fingerprint,{now,onProgress});changed=result.purged;}
  else if(action==='restore'){
    if(!cleanup.listMessageTrash(state,{groupId:payload.groupId}).some(b=>b.id===payload.batchId))throw Error('这批回收记录不在当前群，请刷新后再试。');
    result=cleanup.restoreMessageTrash(state,payload.batchId,{now,onProgress});changed=result.restored;
  }else throw Error('不支持的本地清理操作。');
  return{result,changed:!!changed};
}
module.exports={operate};
