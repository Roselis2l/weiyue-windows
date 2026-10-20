'use strict';
const {compareMessages}=require('./store.cjs');
const GAP_NOTE='平台返回不能证明记录完整；撤回、删除、权限变化或未抓取时段可能形成缺口。';
function mergedCoverage(previous,next,note){
  const pairs=[previous,next].filter(c=>c&&Number.isFinite(c.oldest)&&Number.isFinite(c.newest));
  if(!pairs.length)return undefined;
  return {oldest:Math.min(...pairs.map(c=>c.oldest)),newest:Math.max(...pairs.map(c=>c.newest)),complete:false,note};
}
function checkAbort(signal){
  if(signal?.aborted){const error=new Error('同步已取消，已保存的页面仍保留。');error.code='ABORTED';throw error;}
}
function frontier(messages){
  let arrival=null,baseline=null;
  for(const message of messages){
    if(!arrival||compareMessages(message,arrival)>0)arrival=message;
    if(/^[1-9][0-9]*$/.test(message.id)&&(!baseline||BigInt(message.id)>BigInt(baseline)))baseline=message.id;
  }
  return {arrivalAfterId:arrival?.id||null,baselineId:baseline};
}
async function syncAccount({store,accountId,client,groupId,history=false,maxPages=10,signal,onChange}){
  checkAbort(signal);
  if(onChange!==undefined&&typeof onChange!=='function')throw new TypeError('同步通知必须是函数。');
  const state=store.get(accountId);
  if(state.account.kind!=='weibo')throw new Error('演示与导入账号不连接微博。');
  const selected=state.groups.filter(g=>g.selected&&(!groupId||g.id===groupId));
  if(!selected.length)throw new Error('请先选择允许同步的群聊。');
  let count=0,pages=0;
  for(const g of selected){
    checkAbort(signal);
    if(history&&g.historyExhausted)continue;
    // Freeze both boundaries for the whole group, including future invocations
    // that resume a page-limited latest scan. Sorting by time defines unread;
    // the greatest numeric ID defines the API's descending pagination boundary.
    const initial=frontier(state.messages.filter(message=>message.groupId===g.id));
    const pending=!history?g.latestPending:null;
    const baselineId=pending?pending.baselineId:initial.baselineId;
    const arrivalAfterId=pending?pending.arrivalAfterId:initial.arrivalAfterId;
    const incremental=!history&&baselineId!==null;
    const before=history?g.nextCursor||undefined:pending?.cursor||undefined;
    let groupPages=0;
    const result=await client.syncGroup(g.id,{maxPages,before,stopAtId:incremental?baselineId:undefined,signal,onPage:async page=>{
      checkAbort(signal);
      const current=store.get(accountId).groups.find(candidate=>candidate.id===g.id);
      if(!current)throw new Error('同步群聊已不存在，请重新选择群聊。');
      const target={...current};
      const ended=page.nextCursor===null;
      const reached=page.reachedStop===true;
      let progress;
      if(incremental){
        target.latestPending=reached||ended?null:{cursor:page.nextCursor,baselineId,arrivalAfterId};
        progress=reached?'最新消息已与本地记录衔接。':ended?'已到达本次可返回记录的边界。':'最新消息尚未补齐，将从已保存的位置继续读取。';
      }else{
        // Initial loading establishes the history continuation but never turns
        // existing backlog into unread. Explicit history never affects latestPending.
        target.nextCursor=page.nextCursor;
        target.historyExhausted=ended;
        progress=ended?'已到达本次可返回历史的起点。':'已保存当前记录，可继续读取更早记录。';
      }
      const combined=mergedCoverage(current.coverage,page.coverage,[progress,page.coverage?.note||'',GAP_NOTE].filter(Boolean).join(' '));
      if(combined)target.coverage=combined;
      checkAbort(signal);
      // Message insertion, unread accounting and cursor advancement are one
      // atomic store transaction. Failure cannot advance past an unsaved page.
      count+=store.mergeMessages(accountId,[target],page.messages,{history:!!history,arrivalAfter:{[g.id]:arrivalAfterId}});
      groupPages++;
      checkAbort(signal);
      if(onChange)await onChange({accountId,groupId:g.id,count,pages:pages+groupPages,history:!!history});
      checkAbort(signal);
    }});
    checkAbort(signal);
    pages+=result.pages;
  }
  return {count,pages};
}
module.exports={syncAccount,mergedCoverage};
