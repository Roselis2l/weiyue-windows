'use strict';
const {compareMessages}=require('./store.cjs');
const {normalizeOfflineMessages,offlineCutoff,effectiveOfflineMessages,matchesOfflineScan}=require('./offline-messages.cjs');
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
  const configuredOffline=normalizeOfflineMessages(state.settings.offlineMessages),offline=configuredOffline;
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
    const offline=effectiveOfflineMessages(g,configuredOffline);
    const recovery=g.historyRecovery;
    if(!history&&recovery&&!recovery.complete&&!parked.has('recovery:'+id)){
      const canRetry=!scheduled||((!unresolvedSet||unresolvedSet.has(id))&&!retriedUnresolved.has(id));
      if(!recovery.unresolved||canRetry)return {id,kind:'recovery',before:recovery.cursor,baselineId:null,arrivalAfterId:null,recoveryStart:recovery.start,recoveryEnd:recovery.end,...(recovery.unresolved?{retriedUnresolved:true}:{})};
    }
    if(!history&&offline.mode==='none')return null;
    if(!history&&offline.mode==='date'){
      const scan=g.offlineDateScan;
      if(parked.has('date:'+id))return null;
      const canDateRetry=!scheduled||((!unresolvedSet||unresolvedSet.has(id))&&!retriedUnresolved.has(id));
      const canDeep=!matchesOfflineScan(scan,offline)||(!scan.complete&&(!scan.unresolved||canDateRetry));
      if(matchesOfflineScan(scan,offline)&&scan.headPending&&(scan.nextHead||!canDeep)&&(scan.headPending.status!=='unresolved'||canDateRetry)){
        const pending=scan.headPending;return {id,kind:'date',dateHead:true,...(pending.status==='unresolved'?{retriedUnresolved:true}:{}),before:pending.cursor,baselineId:null,dateStopId:pending.baselineId,arrivalAfterId:pending.arrivalAfterId};
      }
      if(matchesOfflineScan(scan,offline)&&scan.complete)return null;
      if(parked.has('date:'+id))return null;
      if(matchesOfflineScan(scan,offline)&&scan.unresolved&&scheduled&&((unresolvedSet&&!unresolvedSet.has(id))||retriedUnresolved.has(id)))return null;
      return {id,kind:'date',...(matchesOfflineScan(scan,offline)&&scan.unresolved?{retriedUnresolved:true}:{}),before:matchesOfflineScan(scan,offline)?scan.cursor:undefined,baselineId:null,arrivalAfterId:matchesOfflineScan(scan,offline)?scan.arrivalAfterId:initial.get(id).arrivalAfterId};
    }
    if(history||initialContinuations.has(id)||g.offlineInitialPending){
      return !g.historyExhausted&&(g.nextCursor||g.offlineInitialPending)?{id,kind:history?'history':'initial',before:g.nextCursor,arrivalAfterId:null,baselineId:null}:null;
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
        const pending=effectiveOfflineMessages(g,configuredOffline).mode==='auto'&&g.syncNext==='gap'?pendingRanges(g).find(r=>!parked.has(key(id,r))):null;
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
      const requestHistoryRevision=getGroup(job.id).historyRevision??0;
      activeGroup=job.id;
      await client.syncGroup(job.id,{maxPages:1,before:job.before??undefined,stopAtId:job.dateStopId??job.baselineId??undefined,signal,onPage:async page=>{
        checkAbort(signal);
        const currentState=snapshot(store,accountId),current=currentState.groups.find(g=>g.id===job.id&&g.selected);
        if(!current)throw new Error('同步群聊已不存在或已取消选择。');
        // A deletion/recovery transaction invalidates an in-flight page's cursor
        // and completion claim, even when its returned content is all older.
        if((current.historyRevision??0)!==requestHistoryRevision)return;
        const offline=effectiveOfflineMessages(current,configuredOffline);
        const bounded=Number.isFinite(current.historyBoundary?.start);
        // Pausing backfill must still retain new head gaps for a later resume.
        const scanPolicy=offline.mode==='none'&&bounded?effectiveOfflineMessages(current,{mode:'auto'}):offline;
        const recoveryJob=job.kind==='recovery';
        if(recoveryJob&&(!current.historyRecovery||current.historyRecovery.start!==job.recoveryStart||current.historyRecovery.end!==job.recoveryEnd))return;
        const cutoff=recoveryJob?job.recoveryStart:history||offline.mode==='none'?(bounded?current.historyBoundary.start:null):offline.mode==='date'?(offline.cutoff??offlineCutoff(offline)):null;
        const rawMessages=page.messages;
        // The API is paged by descending ID, not guaranteed timestamp order.
        // A mixed page is never a date boundary. Stop on a wholly older page;
        // platform-hidden or arbitrarily reordered history remains unverified.
        const boundary=cutoff!==null&&rawMessages.length>0&&rawMessages.every(m=>Number.isFinite(m.time)&&m.time<cutoff);
        if(cutoff!==null&&rawMessages.some(m=>!Number.isFinite(m.time)))throw Object.assign(new TypeError('日期补齐返回了无效消息时间，本页未保存。'),{code:'OFFLINE_INVALID_TIME'});
        if(cutoff!==null)page={...page,messages:rawMessages.filter(m=>m.time>=cutoff&&(!recoveryJob||m.time<job.recoveryEnd)),coverage:undefined};
        const omitted=page.messages.length!==rawMessages.length;
        const messages=syncRows(currentState,job.id),known=new Set(messages.map(m=>m.id));
        const inserted=new Set(page.messages.filter(m=>!known.has(m.id)).map(m=>m.id)).size;
        const target={...current};let ranges=pendingRanges(current),unresolved=false,dateUnresolved=false;
        if(recoveryJob){
          target.historyRecovery={...current.historyRecovery,cursor:page.nextCursor??page.resumeCursor??job.before??null,complete:boundary,unresolved:!boundary&&page.nextCursor===null};
          if(target.historyRecovery.cursor==='0')target.historyRecovery.cursor=null;
          if(target.historyRecovery.unresolved){parked.add('recovery:'+job.id);dateUnresolved=true;}
        }else if(!history&&scanPolicy.mode==='date'){
          const oldScan=current.offlineDateScan;
          const safeCursor=value=>value==='0'?null:value;
          if(job.dateHead){
            const scan={...oldScan,nextHead:false};
            if(page.reachedStop||boundary)delete scan.headPending;
            else scan.headPending={...scan.headPending,cursor:safeCursor(page.nextCursor??page.resumeCursor??job.before??null),status:page.nextCursor===null?'unresolved':'pending'};
            target.offlineDateScan=scan;
            if(scan.headPending?.status==='unresolved'){dateUnresolved=true;parked.add('date:'+job.id);}
          }else if(job.kind==='head'&&matchesOfflineScan(oldScan,scanPolicy)&&job.baselineId!==null&&page.reachedStop!==true){
            // Retain the deeper continuation. A separate head interval alternates
            // with it, so frequent new arrivals cannot starve older date work.
            const prior=oldScan.headPending;
            target.offlineDateScan={...oldScan,headPending:{cursor:safeCursor(page.nextCursor??page.resumeCursor??null),baselineId:prior?.baselineId??job.baselineId,arrivalAfterId:prior?.arrivalAfterId??job.arrivalAfterId,status:page.nextCursor===null?'unresolved':'pending'}};
            if(target.offlineDateScan.headPending.status==='unresolved'){dateUnresolved=true;parked.add('date:'+job.id);}
          }else if(job.kind==='date'||!oldScan||!matchesOfflineScan(oldScan,scanPolicy)){
            target.offlineDateScan={...((matchesOfflineScan(oldScan,scanPolicy))?oldScan:{}),date:scanPolicy.date,...(bounded?{cutoff}:{}),cursor:safeCursor(page.nextCursor??page.resumeCursor??job.before??null),complete:boundary,reachedDate:boundary,unresolved:!boundary&&page.nextCursor===null,arrivalAfterId:job.arrivalAfterId,nextHead:true};
            dateUnresolved=target.offlineDateScan.unresolved;if(dateUnresolved)parked.add('date:'+job.id);
          }
        }
        if(!recoveryJob&&bounded&&!history)ranges=[];
        if(job.kind==='gap')ranges=ranges.filter(r=>key(job.id,r)!==key(job.id,job));
        if(!recoveryJob&&job.baselineId!==null&&!(bounded&&!history)){
          if(page.reachedStop!==true||omitted){
            unresolved=!omitted&&page.nextCursor===null;
            const range={cursor:omitted?(job.before??null):(page.nextCursor??page.resumeCursor??job.before??null),baselineId:job.baselineId,arrivalAfterId:job.arrivalAfterId,status:unresolved?'unresolved':'pending'};
            if(job.kind==='gap'&&!(job.retriedUnresolved&&unresolved))ranges.unshift(range);else ranges.push(range);
            if(unresolved)parked.add(key(job.id,range));
          }
          ranges=compactRanges(ranges,messages);setRanges(target,ranges);
          // Persist a fair next-turn choice when a tiny time/page budget ends
          // before both head and gap work fit into this invocation.
          target.syncNext=job.kind==='head'&&ranges.length?'gap':'head';
        }else if(!recoveryJob&&job.kind!=='date'&&!(bounded&&!history)){
          // Do not replace a retained initial/history continuation on head refresh.
          if(!(job.kind==='head'&&current.offlineInitialPending)){
            target.nextCursor=history&&bounded?(boundary?null:page.nextCursor):omitted?(job.before??null):page.nextCursor;target.historyExhausted=(history&&bounded&&boundary)||(!omitted&&page.nextCursor===null);
          }
          target.offlineInitialPending=!history&&!target.historyExhausted;
          if(history)target.offlineInitialPending=false;
          if(!history&&offline.mode==='auto'&&!target.historyExhausted&&initial.get(job.id).baselineId===null)initialContinuations.add(job.id);
        }
        if(!recoveryJob&&bounded&&!history)setRanges(target,[]);
        const oldProgress=current.syncProgress;
        const continuing=oldProgress&&(pendingRanges(current).length>0||
          (matchesOfflineScan(current.offlineDateScan,scanPolicy)&&(!current.offlineDateScan.complete||current.offlineDateScan.headPending))||
          (recoveryJob&&current.historyRecovery&&!current.historyRecovery.complete));
        const progressPage=job.kind==='gap'||job.kind==='date'||recoveryJob;
        const phase=recoveryJob?(target.historyRecovery.complete?'joined':target.historyRecovery.unresolved?'unresolved':'backfill'):!history&&offline.mode==='none'?'paused':!history&&offline.mode==='date'?(target.offlineDateScan?.complete&&!target.offlineDateScan.headPending?'limited':(target.offlineDateScan?.unresolved||target.offlineDateScan?.headPending?.status==='unresolved')?'unresolved':'backfill'):ranges.some(r=>r.status==='pending')?'backfill':ranges.length?'unresolved':'joined';
        const reason=recoveryJob?(target.historyRecovery.complete?'已完成所选时段的重新获取。':target.historyRecovery.unresolved?'平台暂未返回所选时段起点，重新获取进度已保留。':'正在重新获取所选时段。'):phase==='paused'?'已选择不补齐；仍检查最新消息，原有待补区间已保留。':phase==='limited'?'已补齐至所选日期（北京时间）；更早消息未补齐，平台不可见记录仍可能缺失。':phase==='backfill'?'正在补齐离线期间的消息；已保存页可在重启后续传。':phase==='unresolved'?'平台暂未返回衔接记录，待补区间仍保留；可稍后重试。':'已与本地记录衔接；平台不可见或撤回的内容仍可能缺失。';
        const pageTimes=page.messages.map(m=>m.time).filter(Number.isFinite);
        target.syncProgress={phase,added:(continuing?oldProgress.added:0)+(progressPage?inserted:0),pages:(continuing?oldProgress.pages:0)+(progressPage?1:0),
          scannedUntil:progressPage&&!job.dateHead&&pageTimes.length?Math.min(...pageTimes,...(continuing&&Number.isFinite(oldProgress.scannedUntil)?[oldProgress.scannedUntil]:[])):(continuing?oldProgress.scannedUntil:null),updatedAt:now(),reason};
        const combined=mergedCoverage(current.coverage,page.coverage,`${reason} ${GAP_NOTE}`);if(combined)target.coverage=combined;
        checkAbort(signal);
        count+=store.mergeMessages(accountId,[target],page.messages,{history:history||job.kind==='initial'||recoveryJob,arrivalAfter:{[job.id]:job.arrivalAfterId}});
        pages++;sinceHead++;
        if(scheduled){
          // Commit the slot only after the messages and cursor are durable.
          // Budget checks, selection changes and failed requests cannot spend it.
          schedule=scheduledChoice.next;schedules.set(accountId,schedule);
          if(job.kind==='head')completedHeads.add(job.id);
          if(job.retriedUnresolved||dateUnresolved)retriedUnresolved.add(job.id);
        }
        checkAbort(signal);
        if(onChange)await onChange({accountId,groupId:job.id,count,pages,history:!!history,kind:job.kind,...(job.retriedUnresolved||dateUnresolved?{retriedUnresolved:true}:{}),phase:target.syncProgress.phase,pendingRanges:ranges.length,progress:target.syncProgress});
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
        if(group&&(pendingRanges(group).length||group.offlineDateScan&&(!group.offlineDateScan.complete||group.offlineDateScan.headPending)||group.historyRecovery&&!group.historyRecovery.complete)){
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
  return {count,pages,pendingGroups:snapshot(store,accountId).groups.filter(g=>{if(!g.selected)return false;const policy=effectiveOfflineMessages(g,configuredOffline);return (g.historyRecovery&&!g.historyRecovery.complete)||(policy.mode==='date'?(!matchesOfflineScan(g.offlineDateScan,policy)||!g.offlineDateScan.complete||!!g.offlineDateScan.headPending):pendingRanges(g).length>0);}).length,budgetExhausted:!withinBudget()};
}
async function syncAccount(options){
  checkAbort(options.signal);
  if(options.onChange!==undefined&&typeof options.onChange!=='function')throw new TypeError('同步通知必须是函数。');
  if(activeStores.has(options.store)){const error=new Error('同步正在进行，请等待当前操作完成。');error.code='SYNC_BUSY';throw error;}
  activeStores.add(options.store);
  try{
    const policy=normalizeOfflineMessages(snapshot(options.store,options.accountId).settings.offlineMessages);
    return await (options.continuous||snapshot(options.store,options.accountId).groups.some(g=>g.selected&&(g.historyBoundary||g.historyRecovery))||(!options.history&&policy.mode!=='auto')?syncContinuous(options):syncLegacy(options));
  }
  finally{activeStores.delete(options.store);}
}
module.exports={syncAccount,mergedCoverage};
