(function(root,factory){'use strict';const helpers=factory();if(typeof module==='object'&&module.exports)module.exports=helpers;else root.WeiyueCleanupProgress=helpers;})(globalThis,function(){
  'use strict';
  const kinds={preview:'清理预览',recycle:'移入回收区',permanent:'永久删除',purge:'清空所选回收批次',restore:'恢复消息'};
  const phases={submitting:'正在提交',reading:'正在读取本地数据',planning:'正在核对范围与保护规则',processing:'正在处理消息',validating:'正在校验结果',writing:'正在保存临时数据',committing:'正在原子提交',refreshing:'已完成，正在刷新当前消息',completed:'已完成',failed:'未完成',uncertain:'结果待核实'};
  function describe(status={}){
    const kind=kinds[status.kind]||'本地数据操作',phase=phases[status.phase]||'正在处理';
    const counted=Number.isSafeInteger(status.processed)&&status.processed>=0&&Number.isSafeInteger(status.total)&&status.total>=status.processed;
    return {label:kind+' · '+phase,detail:status.error||status.detail||(counted?`本阶段已处理 ${status.processed} / ${status.total} ${status.unit==='bytes'?'字节':'条'}`:''),running:status.running===true};
  }
  function matchesContext(operation,context){return !!operation&&operation.accountId===context.accountId&&operation.epoch===context.epoch&&!context.closing;}
  function needsReadingRefresh(operation,context){return matchesContext(operation,context)&&context.view==='read'&&operation.groupId===context.groupId;}
  function isMissingAnchor(error){return error?.code==='PAGE_ANCHOR_MISSING'||String(error?.message||'').includes('分页位置已不在当前筛选结果中');}
  async function queryCleanedWindow({query,payload,anchor,candidates=[],active=()=>true}){
    const ensure=()=>{if(!active()){const error=new Error('阅读界面已变化，已忽略旧清理结果。');error.code='CLEANUP_VIEW_CHANGED';throw error;}};
    const base={...payload};delete base.startId;delete base.beforeId;delete base.afterId;
    const limit=Math.max(1,Math.min(2000,Number.isSafeInteger(base.limit)?base.limit:160));
    let found=null;
    // Try the actual viewport first, then nearby previously visible messages.
    // Never load the entire group merely to recover a deleted temporary anchor.
    const ids=[...new Set([anchor?.anchorId,...candidates].filter(id=>typeof id==='string'&&id))].slice(0,9);
    for(const id of ids){
      ensure();
      try{const result=await query({...base,offset:0,limit:1,startId:id});ensure();if(result.messages?.some(m=>String(m.id)===id)){found={id,offset:result.offset};break;}}
      catch(error){ensure();if(!isMissingAnchor(error))throw error;}
    }
    ensure();
    const first=await query({...base,offset:0,limit:1});ensure();
    const lastOffset=Math.max(0,first.total-limit);
    let offset=found?Math.max(0,Math.min(lastOffset,found.offset-Math.min(25,limit-1))):Math.max(0,Math.min(lastOffset,Number.isSafeInteger(base.offset)?base.offset:0));
    const result=await query({...base,offset,limit});ensure();
    if(result.total<offset){offset=Math.max(0,result.total-limit);const retry=await query({...base,offset,limit});ensure();return{...retry,offset:retry.offset??offset,anchor:null};}
    const survives=found&&result.messages.some(m=>String(m.id)===found.id);
    return{...result,offset:result.offset??offset,anchor:survives?{anchorId:found.id,anchorOffset:found.id===anchor?.anchorId?Number(anchor.anchorOffset)||0:0}:null};
  }
  return Object.freeze({describe,matchesContext,needsReadingRefresh,queryCleanedWindow});
});
