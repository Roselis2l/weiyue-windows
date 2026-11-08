'use strict';
const {createHash}=require('node:crypto');
const MAX_TIME=8640000000000000;
const validTime=n=>Number.isSafeInteger(n)&&n>=0&&n<=MAX_TIME;
const cmp=(a,b)=>a.time-b.time || (/^\d+$/.test(a.id)&&/^\d+$/.test(b.id)?(BigInt(a.id)<BigInt(b.id)?-1:BigInt(a.id)>BigInt(b.id)?1:0):a.id.localeCompare(b.id));
function normalizeRanges(raw=[]){
 if(!Array.isArray(raw)||raw.length>10000)throw Error('历史时段无效。');
 const sorted=raw.map(r=>{if(!r||!validTime(r.start)||!validTime(r.end)||r.start>=r.end)throw Error('历史时段无效。');return{start:r.start,end:r.end};}).sort((a,b)=>a.start-b.start);
 const result=[];for(const r of sorted){const last=result.at(-1);if(last&&r.start<=last.end)last.end=Math.max(last.end,r.end);else result.push(r);}return result;
}
const contains=(ranges,time)=>(ranges||[]).some(r=>time>=r.start&&time<r.end);
function subtract(ranges,cut){return normalizeRanges((ranges||[]).flatMap(r=>r.end<=cut.start||r.start>=cut.end?[r]:[...(r.start<cut.start?[{start:r.start,end:cut.start}]:[]),...(r.end>cut.end?[{start:cut.end,end:r.end}]:[])]));}
function normalizeBoundary(value){if(!value||!validTime(value.start)||!validTime(value.updatedAt))throw Error('群历史保留起点无效。');return{start:value.start,updatedAt:value.updatedAt};}
function normalizeRecovery(value){if(!value||!validTime(value.start)||!validTime(value.end)||value.start>=value.end||!(value.cursor===null||typeof value.cursor==='string'&&/^[1-9]\d*$/.test(value.cursor))||typeof value.complete!=='boolean'||typeof value.unresolved!=='boolean')throw Error('重新获取时段状态无效。');return{start:value.start,end:value.end,cursor:value.cursor,complete:value.complete,unresolved:value.unresolved};}
function suppress(group,message){if(contains(group.historyRestoreRanges,message.time))return false;return (group.historyBoundary&&message.time<group.historyBoundary.start)||contains(group.historyDeletedRanges,message.time);}
function boundaryPlan(state,groupId,range){
 const group=state.groups.find(g=>g.id===groupId),previousStart=group.historyBoundary?.start??null;
 const rows=state.messages.filter(m=>m.groupId===groupId&&!m.localDeletion&&(previousStart===null||m.time>=previousStart));
 const oldest=rows.reduce((n,m)=>n===null?m.time:Math.min(n,m.time),null)??previousStart;
 const prefix=oldest!==null&&range.start<=oldest&&range.end>oldest;
 const newStart=prefix?Math.max(previousStart??0,range.end):previousStart;
 return{previousStart,newStart,advances:newStart!==previousStart};
}
function resetScan(group,now){
 group.latestPendingRanges=[];group.latestPending=null;group.nextCursor=null;group.historyExhausted=false;
 delete group.offlineDateScan;delete group.offlineInitialPending;
 group.syncNext='head';group.syncProgress={phase:'backfill',added:0,pages:0,scannedUntil:null,updatedAt:now,reason:'正在核验保留起点之后的记录。'};
 delete group.coverage;
 group.historyRevision=(group.historyRevision||0)+1;
}
function relocateRead(state,groupId,removed,now){
 const kept=state.messages.filter(m=>m.groupId===groupId&&!m.localDeletion&&!removed.has(m.id)).sort(cmp);
 const before=state.messages.filter(m=>m.groupId===groupId),map=new Map(before.map(m=>[m.id,m]));
 const nextAnchor=id=>{const old=map.get(id);return old?(kept.find(m=>cmp(m,old)>0)||kept.at(-1))?.id??null:null;};
 const read=state.readStates?.[groupId];
 if(read){
  if(removed.has(read.anchorId)){read.anchorId=nextAnchor(read.anchorId);read.anchorOffset=0;read.atBottom=false;}
  if(removed.has(read.readThroughId)){
   const old=map.get(read.readThroughId);read.readThroughId=kept.filter(m=>cmp(m,old)<=0&&!read.unreadIds.includes(m.id)).at(-1)?.id??null;
  }
  read.unreadIds=read.unreadIds.filter(id=>!removed.has(id));read.updatedAt=now;
 }
 if(removed.has(state.readPositions?.[groupId])){const next=nextAnchor(state.readPositions[groupId]);if(next)state.readPositions[groupId]=next;else delete state.readPositions[groupId];}
}
function applyDeletionBoundary(state,groupId,range,plan,now){
 const group=state.groups.find(g=>g.id===groupId);
 group.historyDeletedRanges=normalizeRanges([...(group.historyDeletedRanges||[]),range]);
 group.historyRestoreRanges=subtract(group.historyRestoreRanges,range);
 if(plan.advances){group.historyBoundary={start:plan.newStart,updatedAt:now};resetScan(group,now);}
 else group.historyRevision=(group.historyRevision||0)+1;
 if(group.historyRecovery&&!group.historyRecovery.complete&&range.start<group.historyRecovery.end&&range.end>group.historyRecovery.start)delete group.historyRecovery;
 state.schemaVersion=Math.max(5,state.schemaVersion||1);
}
function recoveryPreview(state,input){
 const {parseChinaMinuteRange}=require('../renderer/filter-controls.js');
 const group=state.groups.find(g=>g.id===input.groupId);if(!group)throw Error('群聊不存在。');
 const range=parseChinaMinuteRange(input.startMinute,input.endMinute);if(!validTime(range.start)||!validTime(range.end)||range.start>=range.end)throw Error('重新获取时段无效。');
 if(group.historyRecovery&&!group.historyRecovery.complete)throw Error('此群已有重新获取任务，请先完成原任务。');
 const tombstoneCount=(state.messageTombstones||[]).filter(m=>m.groupId===group.id&&m.time>=range.start&&m.time<range.end).length;
 const selection={groupId:input.groupId,startMinute:input.startMinute,endMinute:input.endMinute};
 const fingerprint=createHash('sha256').update(JSON.stringify({groupId:group.id,historyRevision:group.historyRevision||0,historyBoundary:group.historyBoundary,historyDeletedRanges:group.historyDeletedRanges,historyRestoreRanges:group.historyRestoreRanges,historyRecovery:group.historyRecovery,markers:(state.messageTombstones||[]).filter(m=>m.groupId===group.id&&m.time>=range.start&&m.time<range.end),selection})).digest('hex');
 return{accountId:state.account.id,groupId:group.id,groupName:group.name,selection,range,tombstoneCount,historyBoundary:group.historyBoundary??null,fingerprint};
}
function recoveryApply(state,input,expected,{now=Date.now}={}){
 const plan=recoveryPreview(state,input);if(plan.fingerprint!==expected)throw Error('群历史状态已变化，请重新预览。');
 const group=state.groups.find(g=>g.id===input.groupId),range=plan.range;
 // Keep identity/time until fetched content replaces it, so any existing cursor remains valid.
 group.historyRestoreRanges=normalizeRanges([...(group.historyRestoreRanges||[]),range]);
 group.historyDeletedRanges=subtract(group.historyDeletedRanges,range);
 group.historyRecovery={...range,cursor:null,complete:false,unresolved:false};
 group.historyRevision=(group.historyRevision||0)+1;
 state.schemaVersion=Math.max(5,state.schemaVersion||1);
 return{recoveryQueued:true,groupId:group.id,range,tombstoneCount:plan.tombstoneCount,createdAt:now()};
}
module.exports={contains,normalizeRanges,normalizeBoundary,normalizeRecovery,suppress,boundaryPlan,resetScan,relocateRead,applyDeletionBoundary,recoveryPreview,recoveryApply};
