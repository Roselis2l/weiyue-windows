(function(root){
  'use strict';
  const minute=value=>new Date(value+8*3600000).toISOString().slice(0,16);
  const display=value=>minute(value).replace('T',' ');
  async function open(h){
    const {api,node,button,field,check,modal,closeModal,toast,filters,accountId,groups,isCurrent,performOperation}=h;
    let active=true,generation=0,saving=false,memberPicker,selectedGroup=groups.some(g=>g.id===h.groupId)?h.groupId:groups[0]?.id;
    let startMinute='',endMinute=minute(Date.now()),retainSenderIds=[],retainSummaryRanges=true,mode='recycle',info;
    function current(){return active&&isCurrent();}
    function close(){if(saving)return;active=false;generation++;memberPicker?.destroy();closeModal();}
    function guard(){if(!current())throw Error('当前账号或窗口已变化，请重新打开本地数据管理。');}
    function show(title,body,actions=[]){guard();const dialog=modal(title,body,actions,{onClose:close,closeLabel:'关闭'});dialog.dataset.context='message-cleanup';return dialog;}
    function busy(dialog,value){saving=value;dialog.querySelectorAll('button,input,select').forEach(e=>e.disabled=value);dialog.setAttribute('aria-busy',String(value));}
    async function submit(dialog,confirm,{action,groupId,kind,total,payload,success}){
      guard();if(saving||confirm.dataset.used==='true')return;
      confirm.dataset.used='true';busy(dialog,true);
      return performOperation({action,accountId,groupId,kind,total,payload,success,
        onStarted:()=>{saving=false;close();}});
    }
    function form(){
      guard();memberPicker?.destroy();
      const group=node('select',{id:'cleanup-group','aria-label':'清理群聊'},...groups.map(g=>node('option',{value:g.id,selected:g.id===selectedGroup},g.name)));
      const start=node('input',{id:'cleanup-start',type:'datetime-local',step:60,value:startMinute,'aria-label':'清理开始时间（北京时间）',oninput:e=>startMinute=e.target.value});
      const end=node('input',{id:'cleanup-end',type:'datetime-local',step:60,value:endMinute,'aria-label':'清理结束时间（含整分钟）',oninput:e=>endMinute=e.target.value});
      const members=node('div',{id:'cleanup-members'});
      const modeSelect=node('select',{id:'cleanup-mode','aria-label':'本地数据处理方式',onchange:e=>mode=e.target.value},
        node('option',{value:'recycle',selected:mode==='recycle'},'移入回收区（可恢复，默认）'),
        node('option',{value:'permanent',selected:mode==='permanent'},'直接永久删除（不可恢复）'));
      const status=node('p',{class:'caption',id:'cleanup-info'},'正在读取本地记录…');
      const oldest=button('最旧',()=>{if(info?.oldest!==null&&info?.oldest!==undefined){startMinute=minute(info.oldest);start.value=startMinute;}},'small',{id:'cleanup-oldest',disabled:true});
      const preview=button('预览筛选结果',async()=>{
        guard();if(!start.value||!end.value)throw Error('请选择完整的北京时间起止分钟。');
        filters.parseChinaMinuteRange(start.value,end.value);
        const ticket=++generation,selection={accountId,groupId:selectedGroup,startMinute:start.value,endMinute:end.value,retainSenderIds:[...retainSenderIds],retainSummaryRanges,mode};
        busy(dialog,true);
        try{const plan=await api('messages.cleanup.preview',selection);if(current()&&ticket===generation)showPreview(plan);}
        finally{if(current()&&dialog.contains(body))busy(dialog,false);else saving=false;}
      },'primary',{id:'cleanup-preview',disabled:true});
      const body=node('div',{class:'cleanup-form'},node('p',{class:'form-description'},'仅管理当前账号的本地消息。默认移入可恢复的回收区；也可选择不可恢复的永久删除。先预览，再确认，不删除微博服务端记录。'),
        field('群聊',group),status,field('处理方式',modeSelect),
        node('div',{class:'cleanup-range'},node('div',{},field('开始时间 · 北京时间',start),oldest),node('div',{},field('结束时间 · 包含完整一分钟',end),button('此刻',()=>{endMinute=minute(Date.now());end.value=endMinute;},'small',{id:'cleanup-now'}))),
        node('section',{class:'form-section'},node('h3',{},'保留特定成员'),node('p',{class:'caption'},'按成员 ID 选择；搜索或切换关键词不会清除勾选。'),members),
        check('保留已用于本地摘要或 AI 总结的完整时段',retainSummaryRanges,v=>retainSummaryRanges=v,{id:'cleanup-keep-summaries'}),
        node('p',{class:'source-note'},'收藏及摘要引用、导出关联、未读消息和阅读定位记录始终保留。来源范围不明的旧摘要或导出记录会保守保留，并在预览中解释。'),
        node('p',{class:'caption'},'回收保留恢复副本，不释放消息占用空间。永久删除会移除消息正文与媒体描述，仅保留阻止同步补回所需的最小消息标记；旧备份、媒体缓存及另存文件不随本操作删除。'));
      const dialog=show('本地数据管理',body,[button('查看本地回收区',trash,'',{id:'cleanup-trash'}),preview]);
      memberPicker=filters.createMemberPicker({container:members,members:[],emptyLabel:'不额外保留成员',selectionLabel:'保留成员',selectedIds:retainSenderIds,onChange:ids=>retainSenderIds=ids});
      members.querySelector('.member-picker-toggle')?.setAttribute('aria-label','选择要保留的成员');
      async function load(){
        const ticket=++generation,owner=selectedGroup;preview.disabled=true;oldest.disabled=true;
        const result=await api('messages.cleanup.info',{accountId,groupId:owner});
        if(!current()||ticket!==generation||!dialog.contains(body))return;
        info=result;status.textContent=`本群可见 ${result.activeCount} 条 · 回收区 ${result.deletedCount} 条`;
        if(!startMinute&&result.oldest!==null){startMinute=minute(result.oldest);start.value=startMinute;}
        memberPicker.setMembers(result.members);memberPicker.setSelected(retainSenderIds);
        oldest.disabled=result.oldest===null;preview.disabled=result.oldest===null;
      }
      group.addEventListener('change',()=>{selectedGroup=group.value;startMinute='';start.value='';retainSenderIds=[];memberPicker.setSelected([]);status.textContent='正在读取本地记录…';void load().catch(error=>{status.textContent=error.message;});});
      if(selectedGroup)void load().catch(error=>{status.textContent=error.message;});else status.textContent='当前账号没有本地群聊。';
    }
    function showPreview(plan){
      guard();saving=false;memberPicker?.destroy();
      const permanent=(plan.mode||plan.selection?.mode||mode)==='permanent',verb=permanent?'永久删除':'移入本地回收区';
      const body=node('div',{class:'cleanup-preview'},node('p',{},`${plan.groupName} · 北京时间 ${display(plan.range.start)} 至 ${display(plan.range.end-60000)}（含结束整分钟）`),
        node('div',{class:'warning'},`符合范围 ${plan.matchedCount} 条；保留 ${plan.retainedCount} 条；将${verb} ${plan.deleteCount} 条。`),
        node('ul',{},...Object.entries(plan.reasonCounts||{}).filter(([,n])=>n>0).map(([key,n])=>node('li',{},`${plan.reasonLabels?.[key]||'关联保护'}：${n} 条`))),
        node('p',{class:'caption'},plan.retentionNote||'同一消息可能符合多条保留规则，分类数量不可直接相加。'),
        ...(plan.warnings||[]).map(w=>node('p',{class:'warning'},w)),
        node('p',{class:permanent?'cleanup-irreversible':''},permanent?'永久删除不可恢复：上述消息不会进入回收区，正文及媒体描述会从当前账号移除。请核对范围与数量。':'确认后仅隐藏上述本地消息，可在本地回收区恢复。'),
        node('p',{},'聊天服务端、收藏、摘要和已经导出的 Notion 页面不受影响。'),
        node('p',{class:'caption'},permanent?(plan.permanentNote||plan.recycleNote||'仅保留阻止自动同步或导入补回所需的最小消息标记；旧备份、媒体缓存与外部下载文件不随本操作删除。'):(plan.recycleNote||'自动同步不会恢复已回收消息，不释放磁盘空间。')),
        node('p',{class:'caption'},permanent?'首次永久删除后请使用 1.1.25 或更新版本；降级需恢复删除前完整备份。':'首次回收后，请使用 1.1.17 或更新版本；若需降级，请使用回收前的完整备份。'),
        node('details',{class:'cleanup-samples'},node('summary',{},`查看筛选样例（${plan.sample?.length||0} 条${plan.sampleTruncated?'，其余省略':''}）`),
          ...(plan.sample||[]).map(m=>node('article',{class:'cleanup-sample'},node('strong',{},`${m.action==='retain'?'保留':permanent?'待永久删除':'待回收'} · ${display(m.time)} · ${m.senderName}`),node('p',{},m.text||'（媒体消息）'),m.reasons?.length?node('small',{},m.reasons.map(r=>plan.reasonLabels?.[r]||r).join('、')):null))));
      const confirm=button(`确认${permanent?'永久删除':'移入回收区'}（${plan.deleteCount} 条）`,()=>submit(dialog,confirm,{
        action:'messages.cleanup.apply',groupId:plan.groupId,kind:permanent?'permanent':'recycle',total:plan.deleteCount,
        payload:{accountId,groupId:plan.groupId,confirmationToken:plan.confirmationToken,confirmed:true},
        success:permanent?`已永久删除 ${plan.deleteCount} 条本地消息。`:`已将 ${plan.deleteCount} 条消息移入本地回收区，可随时恢复。`
      }),'danger',{id:'cleanup-confirm',disabled:plan.deleteCount===0});
      const dialog=show(permanent?'确认永久删除（不可恢复）':'确认本地消息回收',body,[button('返回修改筛选',form,'',{id:'cleanup-back'}),confirm]);
      dialog.querySelector('#modal-close')?.focus();
    }
    async function trash(){
      guard();const ticket=++generation,groupId=selectedGroup;
      const batches=await api('messages.trash.list',{accountId,groupId});if(!current()||ticket!==generation)return;
      memberPicker?.destroy();
      const selected=new Set(),body=node('div',{class:'cleanup-trash-list'},node('p',{},`${groups.find(g=>g.id===groupId)?.name||'当前群'} · 本地回收区`),node('p',{class:'caption'},'可恢复消息，或勾选批次后预览永久删除。永久删除不可恢复，仍保留当前关联与阅读保护；旧备份不随本操作删除。'));
      const available=batches.filter(b=>b.recoverableCount>0);
      const purge=button('预览永久删除所选批次',async()=>{
        guard();if(saving||!selected.size)return;const ticket=++generation;busy(dialog,true);
        try{const plan=await api('messages.trash.purge.preview',{accountId,groupId,batchIds:[...selected]});if(current()&&ticket===generation)showPurgePreview(plan,available.filter(b=>selected.has(b.id)));}
        finally{if(current()&&dialog.contains(body))busy(dialog,false);else saving=false;}
      },'danger',{id:'cleanup-purge-preview',disabled:true});
      if(!available.length)body.append(node('p',{class:'source-note'},'当前群没有待恢复的消息。'));
      for(const batch of available){
        const restore=button(`恢复 ${batch.recoverableCount} 条`,()=>submit(dialog,restore,{
          action:'messages.trash.restore',groupId,kind:'restore',total:batch.recoverableCount,
          payload:{accountId,groupId,batchId:batch.id},success:`已恢复 ${batch.recoverableCount} 条本地消息。`
        }),'small',{'data-restore-batch':batch.id});
        body.append(node('section',{class:'cleanup-trash-batch'},check(`选择此批次（${batch.recoverableCount} 条）`,false,checked=>{if(checked)selected.add(batch.id);else selected.delete(batch.id);purge.disabled=!selected.size;},{'data-purge-batch':batch.id}),node('div',{},node('strong',{},`回收于 ${display(batch.createdAt)}（北京时间）`),node('p',{class:'caption'},`${batch.selection?.startMinute?.replace('T',' ')||''} 至 ${batch.selection?.endMinute?.replace('T',' ')||''} · ${batch.recoverableCount} 条`)),restore));
      }
      const dialog=show('本地回收区',body,[button('返回筛选',form,'',{id:'cleanup-back'}),purge]);
    }
    function showPurgePreview(plan,batches){
      guard();saving=false;
      const body=node('div',{class:'cleanup-preview'},node('p',{},`${plan.groupName||groups.find(g=>g.id===plan.groupId)?.name||'当前群'} · 所选 ${batches.length} 个回收批次`),
        node('ul',{},...batches.map(batch=>node('li',{},`回收于 ${display(batch.createdAt)}；消息时段 ${batch.selection?.startMinute?.replace('T',' ')} 至 ${batch.selection?.endMinute?.replace('T',' ')}（北京时间，含结束分钟）`))),
        node('div',{class:'warning'},`所选 ${plan.matchedCount} 条；按保护规则保留 ${plan.retainedCount} 条；将永久删除 ${plan.deleteCount} 条。`),
        node('p',{class:'cleanup-irreversible'},'永久删除不可恢复：所选消息的正文及媒体描述将从本地回收区移除。此操作不删除微博服务端记录，也不删除旧备份。'),
        node('ul',{},...Object.entries(plan.reasonCounts||{}).filter(([,n])=>n>0).map(([reason,n])=>node('li',{},`${plan.reasonLabels?.[reason]||'关联保护'}：${n} 条`))),
        ...(plan.warnings||[]).map(w=>node('p',{class:'warning'},w)),
        node('p',{class:'caption'},plan.permanentNote||plan.recycleNote||'保留阻止同步或导入补回所需的最小消息标记；旧备份、媒体缓存与另存文件不清除。'),
        node('p',{class:'caption'},'首次永久删除后请使用 1.1.25 或更新版本；降级需恢复删除前的完整备份。'));
      const confirm=button(`确认永久删除（${plan.deleteCount} 条）`,()=>submit(dialog,confirm,{
        action:'messages.trash.purge.apply',groupId:plan.groupId,kind:'purge',total:plan.deleteCount,
        payload:{accountId,groupId:plan.groupId,confirmationToken:plan.confirmationToken,confirmed:true},success:`已从回收区永久删除 ${plan.deleteCount} 条消息。`
      }),'danger',{id:'cleanup-purge-confirm',disabled:plan.deleteCount===0});
      const dialog=show('永久删除所选回收批次（不可恢复）',body,[button('返回回收区',trash,'',{id:'cleanup-back'}),confirm]);
      dialog.querySelector('#modal-close')?.focus();
    }
    form();
  }
  root.WeiyueCleanup={open};
})(globalThis);
