(function(root,factory){'use strict';const helpers=factory();if(typeof module==='object'&&module.exports)module.exports=helpers;else root.WeiyueCleanupProgress=helpers;})(globalThis,function(){
  'use strict';
  const kinds={preview:'清理预览',recycle:'移入回收区',permanent:'永久删除',purge:'清空所选回收批次',restore:'恢复消息'};
  const phases={waiting:'等待当前同步结束','not-started':'尚未开始',submitting:'正在提交',reading:'正在读取本地数据',planning:'正在核对范围与保护规则',processing:'正在处理消息',validating:'正在校验结果',writing:'正在保存临时数据',committing:'正在原子提交',refreshing:'已完成，正在刷新当前消息',completed:'已完成',failed:'未完成',uncertain:'结果待核实'};
  function describe(status={}){
    const kind=kinds[status.kind]||'本地数据操作',phase=phases[status.phase]||'正在处理';
    const counted=Number.isSafeInteger(status.processed)&&status.processed>=0&&Number.isSafeInteger(status.total)&&status.total>=status.processed;
    return {label:kind+' · '+phase,detail:status.error||status.detail||(counted?`本阶段已处理 ${status.processed} / ${status.total} ${status.unit==='bytes'?'字节':'条'}`:''),running:status.running===true};
  }
  function unreadDetail(plan,completed=false){
    const values=[plan.unreadCount,plan.markedReadCount,plan.retainedUnreadCount];
    if(values.every(v=>v===undefined))return '';
    if(values.some(v=>!Number.isSafeInteger(v)||v<0)||values[1]+values[2]!==values[0]||values[1]>plan.deleteCount||values[2]>plan.retainedCount)throw new Error('未读处理数量无效，请重新预览。');
    return '所选范围未读 '+values[0]+' 条；'+(completed?'已':'将')+'标记已读并处理 '+values[1]+' 条；保留未读 '+values[2]+' 条。'+(completed?'阅读进度（高水位）未前移。':'');
  }
  function completionDetail(plan,kind){
    const count=plan.deleteCount,retained=plan.retainedCount;
    if(!Number.isSafeInteger(count)||count<0||!Number.isSafeInteger(retained)||retained<0)throw new Error('清理结果数量无效，请重新预览。');
    const action=kind==='purge'?'已从回收区永久删除 '+count+' 条消息。':kind==='permanent'?'已永久删除 '+count+' 条本地消息。':'已将 '+count+' 条消息移入本地回收区，可随时恢复。';
    const kept=retained>0?(kind==='purge'?'所选批次另有 '+retained+' 条按保留规则继续留在回收区。':'所选时段另有 '+retained+' 条按保留规则未被删除；保留消息仍按当前筛选条件显示。'):'所选范围内没有因保留规则留下的消息。';
    const reasons=Object.entries(plan.reasonCounts||{}).filter(([,n])=>Number.isSafeInteger(n)&&n>0).map(([key,n])=>(plan.reasonLabels?.[key]||'关联保护')+' '+n+' 条');
    return action+(kind==='purge'?'':unreadDetail(plan,true))+kept+(retained>0&&reasons.length?'保留原因：'+reasons.join('、')+'（原因可能重叠）。':'')+(kind==='purge'?'未选批次和消息列表不受影响。':'范围外消息不受影响。');
  }
  function matchesContext(operation,context){return !!operation&&operation.accountId===context.accountId&&operation.epoch===context.epoch&&!context.closing;}
  const COMPLETION_DISMISS_MS=10000;
  function canAutoDismiss(operation,context){
    return matchesContext(operation,context)&&!context.switching&&operation.running===false&&
      ['recycle','permanent','purge'].includes(operation.kind)&&!!operation.result&&
      operation.status?.phase==='completed'&&!operation.status.running&&!operation.status.error&&
      !operation.refreshError&&!operation.uncertain;
  }
  function createCompletionAutoDismiss({getCurrent,onDismiss,setTimer=setTimeout,clearTimer=clearTimeout,delay=COMPLETION_DISMISS_MS}){
    let pending=null,generation=0,disposed=false;
    function cancel(){generation++;if(pending)clearTimer(pending.timer);pending=null;}
    function update(){
      if(disposed)return;
      const {operation,context}=getCurrent();
      if(!canAutoDismiss(operation,context)){cancel();return;}
      if(pending?.operation===operation)return; // Re-rendering must not restart ten seconds.
      cancel();const ticket=generation;
      const expire=()=>{
        if(disposed||ticket!==generation||pending?.operation!==operation)return;
        const current=getCurrent();
        if(current.operation!==operation||!canAutoDismiss(operation,current.context)){cancel();return;}
        // Let a held reading gesture finish before changing the scroll viewport.
        // The ten-second deadline is not restarted while waiting for release.
        if(current.context.interacting){pending.timer=setTimer(expire,100);return;}
        pending=null;onDismiss(operation);
      };
      pending={operation,timer:setTimer(expire,delay)};
    }
    function dispose(){cancel();disposed=true;}
    return Object.freeze({update,cancel,dispose});
  }
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
  return Object.freeze({describe,unreadDetail,completionDetail,matchesContext,needsReadingRefresh,queryCleanedWindow,COMPLETION_DISMISS_MS,canAutoDismiss,createCompletionAutoDismiss});
});
