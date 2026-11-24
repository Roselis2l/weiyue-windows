'use strict';
const {createHash}=require('node:crypto');
const {recallOf,keyOf}=require('./message-recalls.cjs');
const HIDDEN='关联原文已撤回；当前版本隐藏这份内容，请重新选择可用消息生成。';
function contentEpoch(state) {
  const hash=createHash('sha256');
  for(const message of state.messages)if(recallOf(message))hash.update(JSON.stringify([message.groupId,message.id,message.recall?.observedAt||message.time,!!message.localDeletion]));
  return hash.digest('hex');
}
function projectAccount(state, projectMessage) {
  const messages=state.messages.map(projectMessage), blocked=new Set(messages.filter(m=>m.recall&&!m.recall.originalAvailable).map(keyOf));
  if(!blocked.size)return {...state,messages};
  const affectedSummary=new Set(), affectedBookmark=new Set();
  const summaries=state.summaries.map(summary=>{
    const affected=(summary.refs||[]).some(ref=>blocked.has(keyOf({groupId:ref.groupId||summary.groupId,id:ref.id||ref.messageId})))
      || (!Array.isArray(summary.refs)&&messages.some(m=>blocked.has(keyOf(m))&&m.groupId===summary.groupId&&m.time>=summary.start&&m.time<summary.end));
    if(!affected)return summary;
    affectedSummary.add(summary.id);
    // Whole-body suppression avoids leaking generated paraphrases/old excerpts.
    return {id:summary.id,groupId:summary.groupId,start:summary.start,end:summary.end,createdAt:summary.createdAt,
      mode:summary.mode,title:'包含已撤回原文的摘要',body:HIDDEN,refs:[],warning:HIDDEN,contentUnavailable:true};
  });
  const bookmarks=state.bookmarks.map(bookmark=>{
    if(!bookmark.messageIds.some(id=>blocked.has(keyOf({groupId:bookmark.groupId,id}))))return bookmark;
    affectedBookmark.add(bookmark.id);
    return {...bookmark,note:'关联消息已撤回，当前版本隐藏原文和可能包含摘录的备注。',tags:[],contentUnavailable:true};
  });
  const exports={};
  for(const [key,entry] of Object.entries(state.exports||{})){
    const affected=(!entry.summaryId&&!Array.isArray(entry.sourceIds))||affectedSummary.has(entry.summaryId)||(entry.sourceIds||[]).some(id=>affectedSummary.has(id)||affectedBookmark.has(id));
    // Preserve status/link for idempotence, omit arbitrary saved draft bodies.
    exports[key]=affected?Object.fromEntries(Object.entries(entry).filter(([name])=>!['draft','title','body','refs','blocks'].includes(name))):entry;
  }
  return {...state,messages,bookmarks,summaries,exports};
}
module.exports={projectAccount,contentEpoch,HIDDEN};
