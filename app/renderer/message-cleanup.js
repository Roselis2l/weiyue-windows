(function(root){
  'use strict';
  const minute=value=>new Date(value+8*3600000).toISOString().slice(0,16);
  const display=value=>minute(value).replace('T',' ');
  async function open(h){
    const {api,node,button,field,check,modal,closeModal,toast,filters,accountId,groups,isCurrent,onChanged}=h;
    let active=true,generation=0,saving=false,memberPicker,selectedGroup=groups.some(g=>g.id===h.groupId)?h.groupId:groups[0]?.id;
    let startMinute='',endMinute=minute(Date.now()),retainSenderIds=[],retainSummaryRanges=true,info;
    function current(){return active&&isCurrent();}
    function close(){if(saving)return;active=false;generation++;memberPicker?.destroy();closeModal();}
    function guard(){if(!current())throw Error('当前账号或窗口已变化，请重新打开本地数据管理。');}
    function show(title,body,actions=[]){guard();const dialog=modal(title,body,actions,{onClose:close,closeLabel:'关闭'});dialog.dataset.context='message-cleanup';return dialog;}
    function busy(dialog,value){saving=value;dialog.querySelectorAll('button,input,select').forEach(e=>e.disabled=value);dialog.setAttribute('aria-busy',String(value));}
    function form(){
      guard();memberPicker?.destroy();
      const group=node('select',{id:'cleanup-group','aria-label':'清理群聊'},...groups.map(g=>node('option',{value:g.id,selected:g.id===selectedGroup},g.name)));
      const start=node('input',{id:'cleanup-start',type:'datetime-local',step:60,value:startMinute,'aria-label':'清理开始时间（北京时间）',oninput:e=>startMinute=e.target.value});
      const end=node('input',{id:'cleanup-end',type:'datetime-local',step:60,value:endMinute,'aria-label':'清理结束时间（含整分钟）',oninput:e=>endMinute=e.target.value});
      const members=node('div',{id:'cleanup-members'});
      const status=node('p',{class:'caption',id:'cleanup-info'},'正在读取本地记录…');
      const oldest=button('最旧',()=>{if(info?.oldest!==null&&info?.oldest!==undefined){startMinute=minute(info.oldest);start.value=startMinute;}},'small',{id:'cleanup-oldest',disabled:true});
      const preview=button('预览筛选结果',async()=>{
        guard();if(!start.value||!end.value)throw Error('请选择完整的北京时间起止分钟。');
        filters.parseChinaMinuteRange(start.value,end.value);
        const ticket=++generation,selection={accountId,groupId:selectedGroup,startMinute:start.value,endMinute:end.value,retainSenderIds:[...retainSenderIds],retainSummaryRanges};
        busy(dialog,true);
        try{const plan=await api('messages.cleanup.preview',selection);if(current()&&ticket===generation)showPreview(plan);}
        finally{if(current()&&dialog.contains(body))busy(dialog,false);else saving=false;}
      },'primary',{id:'cleanup-preview',disabled:true});
      const body=node('div',{class:'cleanup-form'},node('p',{class:'form-description'},'仅管理当前账号的本地消息。先预览，再确认移入可恢复的回收区；不会删除微博服务端记录。'),
        field('群聊',group),status,
        node('div',{class:'cleanup-range'},node('div',{},field('开始时间 · 北京时间',start),oldest),node('div',{},field('结束时间 · 包含完整一分钟',end),button('此刻',()=>{endMinute=minute(Date.now());end.value=endMinute;},'small',{id:'cleanup-now'}))),
        node('section',{class:'form-section'},node('h3',{},'保留特定成员'),node('p',{class:'caption'},'按成员 ID 选择；搜索或切换关键词不会清除勾选。'),members),
        check('保留已用于本地摘要或 AI 总结的完整时段',retainSummaryRanges,v=>retainSummaryRanges=v,{id:'cleanup-keep-summaries'}),
        node('p',{class:'source-note'},'收藏及摘要引用、导出关联、未读消息和阅读定位记录始终保留。来源范围不明的旧摘要或导出记录会保守保留，并在预览中解释。'),
        node('p',{class:'caption'},'回收区中的消息不再出现在阅读或新摘要里，自动同步不会恢复它们。此功能隐藏并保留恢复副本，不释放磁盘空间。'));
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
      const body=node('div',{class:'cleanup-preview'},node('p',{},`${plan.groupName} · 北京时间 ${display(plan.range.start)} 至 ${display(plan.range.end-60000)}（含结束整分钟）`),
        node('div',{class:'warning'},`符合范围 ${plan.matchedCount} 条；保留 ${plan.retainedCount} 条；将移入本地回收区 ${plan.deleteCount} 条。`),
        node('ul',{},...Object.entries(plan.reasonCounts||{}).filter(([,n])=>n>0).map(([key,n])=>node('li',{},`${plan.reasonLabels?.[key]||'关联保护'}：${n} 条`))),
        node('p',{class:'caption'},plan.retentionNote||'同一消息可能符合多条保留规则，分类数量不可直接相加。'),
        ...(plan.warnings||[]).map(w=>node('p',{class:'warning'},w)),
        node('p',{},'确认后仅隐藏上述本地消息，可在本地回收区恢复。聊天服务端、收藏、摘要和已经导出的 Notion 页面不受影响。'),
        node('p',{class:'caption'},plan.recycleNote||'自动同步不会恢复已回收消息，不释放磁盘空间。'),
        node('p',{class:'caption'},'首次回收后，请使用 1.1.17 或更新版本打开此账号数据；旧版无法读取。若需降级，请使用回收前的完整备份。'),
        node('details',{class:'cleanup-samples'},node('summary',{},`查看筛选样例（${plan.sample?.length||0} 条${plan.sampleTruncated?'，其余省略':''}）`),
          ...(plan.sample||[]).map(m=>node('article',{class:'cleanup-sample'},node('strong',{},`${m.action==='recycle'?'待回收':'保留'} · ${display(m.time)} · ${m.senderName}`),node('p',{},m.text||'（媒体消息）'),m.reasons?.length?node('small',{},m.reasons.map(r=>plan.reasonLabels?.[r]||r).join('、')):null))));
      const confirm=button(`确认移入回收区（${plan.deleteCount} 条）`,async()=>{
        guard();if(saving||confirm.dataset.used==='true')return;confirm.dataset.used='true';busy(dialog,true);
        try{
          const result=await api('messages.cleanup.apply',{accountId,groupId:plan.groupId,confirmationToken:plan.confirmationToken,confirmed:true});guard();
          if(result.accountId!==accountId||result.groupId!==plan.groupId||result.deleted!==true||result.deletedCount!==plan.deleteCount)throw Error('清理结果无法确认，请关闭后检查本地回收区，勿重复提交。');
          saving=false;close();await onChanged();toast(`已将 ${result.deletedCount} 条消息移入本地回收区，可随时恢复。`);
        }catch(error){busy(dialog,false);confirm.disabled=true;throw error;}
      },'danger',{id:'cleanup-confirm',disabled:plan.deleteCount===0});
      const dialog=show('确认本地消息回收',body,[button('返回修改筛选',form,'',{id:'cleanup-back'}),confirm]);
      dialog.querySelector('#modal-close')?.focus();
    }
    async function trash(){
      guard();const ticket=++generation,groupId=selectedGroup;
      const batches=await api('messages.trash.list',{accountId,groupId});if(!current()||ticket!==generation)return;
      memberPicker?.destroy();
      const body=node('div',{class:'cleanup-trash-list'},node('p',{},`${groups.find(g=>g.id===groupId)?.name||'当前群'} · 本地回收区`),node('p',{class:'caption'},'恢复会重新显示这批消息，不推进阅读位置，不更改当前未读标记。这里只提供恢复，不永久清空。'));
      const available=batches.filter(b=>b.recoverableCount>0);
      if(!available.length)body.append(node('p',{class:'source-note'},'当前群没有待恢复的消息。'));
      for(const batch of available){
        const restore=button(`恢复 ${batch.recoverableCount} 条`,async()=>{
          guard();if(saving)return;busy(dialog,true);
          try{const result=await api('messages.trash.restore',{accountId,groupId,batchId:batch.id});guard();if(result.accountId!==accountId||result.groupId!==groupId||!result.restored)throw Error('恢复结果无法确认，请重新打开回收区检查。');await onChanged();saving=false;await trash();toast(`已恢复 ${result.restoredCount} 条本地消息。`);}
          finally{if(current()&&dialog.contains(body))busy(dialog,false);else saving=false;}
        },'small',{'data-restore-batch':batch.id});
        body.append(node('section',{class:'cleanup-trash-batch'},node('div',{},node('strong',{},`回收于 ${display(batch.createdAt)}（北京时间）`),node('p',{class:'caption'},`${batch.selection?.startMinute?.replace('T',' ')||''} 至 ${batch.selection?.endMinute?.replace('T',' ')||''} · ${batch.recoverableCount} 条`)),restore));
      }
      const dialog=show('本地回收区',body,[button('返回筛选',form,'',{id:'cleanup-back'})]);
    }
    form();
  }
  root.WeiyueCleanup={open};
})(globalThis);
