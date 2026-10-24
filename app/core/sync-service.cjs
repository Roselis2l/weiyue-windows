'use strict';
const {compareMessages}=require('./store.cjs');
const GAP_NOTE='平台返回不能证明记录完整；撤回、删除、权限变化或未抓取时段可能形成缺口。';
const activeStores=new WeakSet();
// Automatic batches yield after a short budget. Keep their next successful
// scheduling slot across yields without adding scheduling state to user data.
const scheduledStores=new WeakMap();
const snapshot=(store,id)=>store.getSnapshot?store.getSnapshot(id):store.get(id);
// Permanently removed rows remain only as stable identity/time markers. Include
// them in synchronization boundaries and duplicate counts, never in rendering.
const syncRows=(state,groupId)=>[...state.messages,...(state.messageTombstones||[])].filter(m=>m.groupId===groupId);
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
async function syncLegacy({store,accountId,client,groupId,history=false,maxPages=10,pageDelayMs=1000,signal,onChange}){
  checkAbort(signal);
  if(onChange!==undefined&&typeof onChange!=='function')throw new TypeError('同步通知必须是函数。');
  const state=snapshot(store,accountId);
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
    const initial=frontier(syncRows(state,g.id));
    const pending=!history?g.latestPending:null;
    const baselineId=pending?pending.baselineId:initial.baselineId;
    const arrivalAfterId=pending?pending.arrivalAfterId:initial.arrivalAfterId;
    const incremental=!history&&baselineId!==null;
    const before=history?g.nextCursor||undefined:pending?.cursor||undefined;
    let groupPages=0;
    const result=await client.syncGroup(g.id,{maxPages,pageDelayMs,before,stopAtId:incremental?baselineId:undefined,signal,onPage:async page=>{
      checkAbort(signal);
      const current=snapshot(store,accountId).groups.find(candidate=>candidate.id===g.id);
      if(!current)throw new Error('同步群聊已不存在，请重新选择群聊。');
      const target={...current};
      const ended=page.nextCursor===null;
      const reached=page.reachedStop===true;
      let progress;
      if(incremental){
        const ranges=pendingRanges(current),remaining=ranges.filter(range=>range.baselineId!==baselineId||range.arrivalAfterId!==arrivalAfterId);
        if(!reached)remaining.unshift({cursor:page.nextCursor??page.resumeCursor??before??null,baselineId,arrivalAfterId,status:ended?'unresolved':'pending'});
        setRanges(target,remaining);
        progress=reached?'最新消息已与本地记录衔接。':ended?'平台暂未返回衔接记录；待补区间仍保留。':'最新消息尚未补齐，将从已保存的位置继续读取。';
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
      if(onChange)await onChange({accountId,groupId:g.id,count,pages:pages+groupPages,history:!!history,kind:history?'history':pending?'gap':groupPages===1?'head':incremental?'gap':'initial'});
      checkAbort(signal);
    }});
    checkAbort(signal);
    pages+=result.pages;
  }
  return {count,pages};
}
function pendingRanges(group){return (group.latestPendingRanges??(group.latestPending?[group.latestPending]:[])).map(range=>({...range,status:range.status||'pending'}));}
function setRanges(group,ranges){
  group.latestPendingRanges=ranges;
  group.latestPending=ranges.length?{cursor:ranges[0].cursor,baselineId:ranges[0].baselineId,arrivalAfterId:ranges[0].arrivalAfterId}:null;
}
function compactRanges(ranges,messages){
  const distinct=[...new Map(ranges.map(range=>[`${range.cursor}:${range.baselineId}`,range])).values()];
  if(distinct.length<=32)return distinct;
  // Bound storage without dropping an interval. A wider rescan may revisit
  // already saved islands, but preserves every original lower boundary.
  const baselineId=distinct.reduce((id,r)=>BigInt(r.baselineId)<BigInt(id)?r.baselineId:id,distinct[0].baselineId);
  const cursor=distinct.some(r=>r.cursor===null)?null:distinct.reduce((id,r)=>BigInt(r.cursor)>BigInt(id)?r.cursor:id,distinct[0].cursor);
  const arrivals=distinct.map(r=>messages.find(m=>m.id===r.arrivalAfterId)).filter(Boolean).sort(compareMessages);
  return [{cursor,baselineId,arrivalAfterId:arrivals[0].id,status:'pending'}];
}
function delay(ms,signal){return new Promise((resolve,reject)=>{
  checkAbort(signal);const timer=setTimeout(done,ms);
  function done(){signal?.removeEventListener('abort',aborted);resolve();}
  function aborted(){clearTimeout(timer);signal?.removeEventListener('abort',aborted);try{checkAbort(signal);}catch(error){reject(error);}}
  signal?.addEventListener('abort',aborted,{once:true});
});}
const BLOCK_REASONS={AUTH_REQUIRED:'登录已失效，补扫已停止；请重新登录。',ACCESS_DENIED:'微博拒绝访问，补扫已停止；请在官方页面检查权限。',RATE_LIMIT:'微博暂时限流，本轮补扫已停止并等待服务器要求的时间。',API_REJECTED:'微博拒绝读取，补扫已停止；请在官方页面检查提示。',RISK_CONTROL:'微博要求验证，补扫已停止；请在官方页面处理。',RISK_REQUIRED:'微博要求验证，补扫已停止；请在官方页面处理。'};
async function syncContinuous({store,accountId,client,groupId,history=false,maxPages=60,timeBudgetMs=40000,pageDelayMs=600,headEveryPages=12,preferredGroupId,headGroupIds,retryUnresolvedGroupIds,signal,onChange,now=Date.now,sleep=delay}){
  if(!Number.isSafeInteger(maxPages)||maxPages<1||maxPages>200)throw new TypeError('每轮最多读取 1 到 200 页。');
  if(!Number.isSafeInteger(timeBudgetMs)||timeBudgetMs<1||timeBudgetMs>120000)throw new TypeError('补扫时间预算无效。');
  if(!Number.isSafeInteger(pageDelayMs)||pageDelayMs<500||pageDelayMs>5000)throw new TypeError('补扫请求间隔须为 500 到 5000 毫秒。');
  if(!Number.isSafeInteger(headEveryPages)||headEveryPages<1||headEveryPages>100)throw new TypeError('最新消息检查间隔无效。');
  if(typeof now!=='function'||typeof sleep!=='function')throw new TypeError('补扫时钟无效。');
  if(preferredGroupId!==undefined&&preferredGroupId!==null&&typeof preferredGroupId!=='string')throw new TypeError('优先群聊须使用稳定字符串 ID。');
  if(headGroupIds!==undefined&&(!Array.isArray(headGroupIds)||headGroupIds.some(id=>typeof id!=='string')))throw new TypeError('最新消息检查群聊须为字符串 ID 列表。');
  if(retryUnresolvedGroupIds!==undefined&&(!Array.isArray(retryUnresolvedGroupIds)||retryUnresolvedGroupIds.some(id=>typeof id!=='string')))throw new TypeError('未闭合区间检查群聊须为字符串 ID 列表。');
  const state=snapshot(store,accountId);
  if(state.account.kind!=='weibo')throw new Error('演示与导入账号不连接微博。');
  const selected=state.groups.filter(g=>g.selected&&(!groupId||g.id===groupId)).sort((a,b)=>(a.syncProgress?.updatedAt||0)-(b.syncProgress?.updatedAt||0));
  if(!selected.length)throw new Error('请先选择允许同步的群聊。');
  const start=now(),initial=new Map(selected.map(g=>[g.id,frontier(syncRows(state,g.id))]));
  const initialContinuations=new Set(),parked=new Set();
  let count=0,pages=0,initialIndex=0,headIndex=0,gapIndex=0,sinceHead=0,activeGroup=null;
  const withinBudget=()=>pages<maxPages&&now()-start<timeBudgetMs;
  const getGroup=id=>snapshot(store,accountId).groups.find(g=>g.id===id&&g.selected);
  const key=(id,range)=>`${id}:${range.baselineId}:${range.arrivalAfterId}`;
  // Automatic callers supply the due head groups; manual/default callers keep
  // the original scheduling behavior. Head eligibility never removes gap work.
  const scheduled=!history&&(preferredGroupId!==undefined||headGroupIds!==undefined||retryUnresolvedGroupIds!==undefined);
  const headSet=headGroupIds===undefined?null:new Set(headGroupIds);
  const unresolvedSet=retryUnresolvedGroupIds===undefined?null:new Set(retryUnresolvedGroupIds);
  const selectedIds=new Set(selected.map(g=>g.id));
  // The caller orders due heads by their last head refresh, independently of
  // recent gap writes. Fair gap rotation instead uses stable store group order.
  const heads=[...new Set(headGroupIds??selected.map(g=>g.id))].filter(id=>selectedIds.has(id));
  const preferred=selectedIds.has(preferredGroupId)?preferredGroupId:null;
  const fairIds=state.groups.filter(g=>selectedIds.has(g.id)).map(g=>g.id);
  const completedHeads=new Set(),retriedUnresolved=new Set();
  let schedules,schedule;
  if(scheduled){
    schedules=scheduledStores.get(store);if(!schedules){schedules=new Map();scheduledStores.set(store,schedules);}
    schedule=schedules.get(accountId)||{preferred:null,front:null,phase:'head',lastGapId:null,sincePreferred:0,idle:true};
    if(schedule.preferred!==preferred)schedule={...schedule,preferred,front:preferred?'head':null,sincePreferred:0};
  }
  const backgroundHeads=heads.filter(id=>id!==preferred);
  function makeHead(id){
    if(!getGroup(id))return null;
    return {id,kind:'head',before:undefined,...frontier(syncRows(snapshot(store,accountId),id))};
  }
  function makeGap(id){
    const g=getGroup(id);if(!g)return null;
    if(history||initialContinuations.has(id)){
      return !g.historyExhausted&&g.nextCursor?{id,kind:history?'history':'initial',before:g.nextCursor,arrivalAfterId:null,baselineId:null}:null;
    }
    const ranges=pendingRanges(g).filter(r=>!parked.has(key(id,r)));
    // An independently due unresolved retry gets one slot per group per batch;
    // a long ordinary pending range must not permanently hide it.
    const canRetry=!scheduled||((!unresolvedSet||unresolvedSet.has(id))&&!retriedUnresolved.has(id));
    const range=scheduled?(canRetry&&ranges.find(r=>r.status==='unresolved')||ranges.find(r=>r.status!=='unresolved')):ranges[0];
    return range?{id,kind:'gap',before:range.cursor,baselineId:range.baselineId,arrivalAfterId:range.arrivalAfterId,...(range.status==='unresolved'?{retriedUnresolved:true}:{})}:null;
  }
  function gapJob(){
    for(let i=0;i<selected.length;i++){
      const job=makeGap(selected[gapIndex++%selected.length].id);if(job)return job;
    }
    return null;
  }
  function dueHead(){
    for(const id of backgroundHeads){if(completedHeads.has(id))continue;const job=makeHead(id);if(job)return job;}
    return null;
  }
  function fairGap(lastId){
    const after=fairIds.indexOf(lastId);
    for(let i=1;i<=fairIds.length;i++){const job=makeGap(fairIds[(after+i)%fairIds.length]);if(job)return job;}
    return null;
  }
  function scheduledJob(){
    const next={...schedule,idle:false},canHead=preferred&&(!headSet||headSet.has(preferred));
    // A completed idle cycle refreshes the foreground first next time. A busy
    // cycle retains its owed slot even when only one slow page fits each batch.
    if(schedule.idle||(pages===0&&!next.front&&!dueHead()&&!fairGap(next.lastGapId)))next.front=canHead?'head':null;
    function chosen(job){
      if(job.kind==='head'&&job.id===preferred)next.sincePreferred=0;
      else next.sincePreferred++;
      return {job,next};
    }
    if(next.front==='head'){
      next.front='gap';const job=canHead?makeHead(preferred):null;if(job)return chosen(job);
    }
    if(next.front==='gap'){
      next.front=null;const job=makeGap(preferred);if(job)return chosen(job);
    }
    if(canHead&&next.sincePreferred>=headEveryPages){
      const job=makeHead(preferred);if(job){next.front='gap';return chosen(job);}
    }
    let job;
    if(next.phase==='head'){
      job=dueHead();if(job){next.phase='gap';return chosen(job);}
    }
    job=fairGap(next.lastGapId);
    if(job){next.lastGapId=job.id;next.phase='head';return chosen(job);}
    job=dueHead();if(job){next.phase='gap';return chosen(job);}
    return null;
  }
  try{
    while(withinBudget()){
      checkAbort(signal);
      let job,scheduledChoice;
      if(scheduled){
        scheduledChoice=scheduledJob();job=scheduledChoice?.job;
      }else if(!history&&initialIndex<selected.length){
        const id=selected[initialIndex++].id,g=getGroup(id);if(!g)continue;
        const pending=g.syncNext==='gap'?pendingRanges(g).find(r=>!parked.has(key(id,r))):null;
        if(pending)job={id,kind:'gap',before:pending.cursor,baselineId:pending.baselineId,arrivalAfterId:pending.arrivalAfterId};
        else{const local=frontier(syncRows(snapshot(store,accountId),id));job={id,kind:'head',before:undefined,...local};sinceHead=0;}
      }else if(!history&&sinceHead>=headEveryPages){
        const id=selected[headIndex++%selected.length].id,g=getGroup(id);if(!g)continue;
        const local=frontier(syncRows(snapshot(store,accountId),id));
        job={id,kind:'head',before:undefined,...local};sinceHead=0;
      }else job=gapJob();
      if(!job){if(scheduled){schedule={...schedule,idle:true};schedules.set(accountId,schedule);}break;}
      if(pages){await sleep(pageDelayMs,signal);checkAbort(signal);if(!withinBudget())break;}
      if(!getGroup(job.id))continue;
      activeGroup=job.id;
      await client.syncGroup(job.id,{maxPages:1,before:job.before??undefined,stopAtId:job.baselineId??undefined,signal,onPage:async page=>{
        checkAbort(signal);
        const currentState=snapshot(store,accountId),current=currentState.groups.find(g=>g.id===job.id&&g.selected);
        if(!current)throw new Error('同步群聊已不存在或已取消选择。');
        const messages=syncRows(currentState,job.id),known=new Set(messages.map(m=>m.id));
        const inserted=new Set(page.messages.filter(m=>!known.has(m.id)).map(m=>m.id)).size;
        const target={...current};let ranges=pendingRanges(current),unresolved=false;
        if(job.kind==='gap')ranges=ranges.filter(r=>key(job.id,r)!==key(job.id,job));
        if(job.baselineId!==null){
          if(page.reachedStop!==true){
            unresolved=page.nextCursor===null;
            const range={cursor:page.nextCursor??page.resumeCursor??job.before??null,baselineId:job.baselineId,arrivalAfterId:job.arrivalAfterId,status:unresolved?'unresolved':'pending'};
            if(job.kind==='gap'&&!(job.retriedUnresolved&&unresolved))ranges.unshift(range);else ranges.push(range);
            if(unresolved)parked.add(key(job.id,range));
          }
          ranges=compactRanges(ranges,messages);setRanges(target,ranges);
          // Persist a fair next-turn choice when a tiny time/page budget ends
          // before both head and gap work fit into this invocation.
          target.syncNext=job.kind==='head'&&ranges.length?'gap':'head';
        }else{
          target.nextCursor=page.nextCursor;target.historyExhausted=page.nextCursor===null;
          if(!history&&!target.historyExhausted&&initial.get(job.id).baselineId===null)initialContinuations.add(job.id);
        }
        const oldProgress=current.syncProgress;
        const continuing=oldProgress&&pendingRanges(current).length>0;
        const phase=ranges.some(r=>r.status==='pending')?'backfill':ranges.length?'unresolved':'joined';
        const reason=phase==='backfill'?'正在补齐离线期间的消息；已保存页可在重启后续传。':phase==='unresolved'?'平台暂未返回衔接记录，待补区间仍保留；可稍后重试。':'已与本地记录衔接；平台不可见或撤回的内容仍可能缺失。';
        const pageTimes=page.messages.map(m=>m.time).filter(Number.isFinite);
        target.syncProgress={phase,added:(continuing?oldProgress.added:0)+(job.kind==='gap'?inserted:0),pages:(continuing?oldProgress.pages:0)+(job.kind==='gap'?1:0),
          scannedUntil:job.kind==='gap'&&pageTimes.length?Math.min(...pageTimes):(continuing?oldProgress.scannedUntil:null),updatedAt:now(),reason};
        const combined=mergedCoverage(current.coverage,page.coverage,`${reason} ${GAP_NOTE}`);if(combined)target.coverage=combined;
        checkAbort(signal);
        count+=store.mergeMessages(accountId,[target],page.messages,{history:history||job.kind==='initial',arrivalAfter:{[job.id]:job.arrivalAfterId}});
        pages++;sinceHead++;
        if(scheduled){
          // Commit the slot only after the messages and cursor are durable.
          // Budget checks, selection changes and failed requests cannot spend it.
          schedule=scheduledChoice.next;schedules.set(accountId,schedule);
          if(job.kind==='head')completedHeads.add(job.id);
          if(job.retriedUnresolved)retriedUnresolved.add(job.id);
        }
        checkAbort(signal);
        if(onChange)await onChange({accountId,groupId:job.id,count,pages,history:!!history,kind:job.kind,...(job.retriedUnresolved?{retriedUnresolved:true}:{}),phase:target.syncProgress.phase,pendingRanges:ranges.length,progress:target.syncProgress});
        checkAbort(signal);
      }});
      checkAbort(signal);
    }
  }catch(error){
    // A status write is best effort. In particular a disk/observer failure must
    // never replace RATE_LIMIT/authorization metadata needed by the scheduler.
    try{
      if(activeGroup&&error?.code!=='ABORTED'){
        const group=getGroup(activeGroup);
        if(group&&pendingRanges(group).length){
          const reason=BLOCK_REASONS[error?.code]||'本轮补扫未完成，已保存的消息和待补区间仍保留。';
          const previous=group.syncProgress||{added:0,pages:0,scannedUntil:null};
          const progress={...previous,phase:'blocked',updatedAt:now(),reason};
          store.mergeMessages(accountId,[{...group,syncProgress:progress}],[]);
          if(onChange)try{await onChange({accountId,groupId:activeGroup,count,pages,history:!!history,phase:'blocked',pendingRanges:pendingRanges(group).length,progress});}catch{/* Preserve the original failure. */}
        }
      }
    }catch{/* Preserve the original request/persistence failure. */}
    throw error;
  }
  return {count,pages,pendingGroups:snapshot(store,accountId).groups.filter(g=>g.selected&&pendingRanges(g).length).length,budgetExhausted:!withinBudget()};
}
async function syncAccount(options){
  checkAbort(options.signal);
  if(options.onChange!==undefined&&typeof options.onChange!=='function')throw new TypeError('同步通知必须是函数。');
  if(activeStores.has(options.store)){const error=new Error('同步正在进行，请等待当前操作完成。');error.code='SYNC_BUSY';throw error;}
  activeStores.add(options.store);
  try{return await (options.continuous?syncContinuous(options):syncLegacy(options));}
  finally{activeStores.delete(options.store);}
}
module.exports={syncAccount,mergedCoverage};
