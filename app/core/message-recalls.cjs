'use strict';

// Official web chat replaces a withdrawn group message with type 344. History
// uses the generic template subtype 101; the live replacement uses 331.
// Neither free text, a missing page row, nor generic subtype 101 is evidence.
const NOTICE = '[消息已撤回；当前版本不显示撤回原文。]';
const MISSING = '[消息已撤回；本机未保存原文，无法恢复。]';
const keyOf = value => JSON.stringify([value.groupId, value.id]);
function recallOf(message) {
  if (message?.recall?.state === 'withdrawn') return normalizeRecall(message.recall);
  const context = message?.systemNotice;
  if (context?.kind === 'weibo-system' && context.type === 344 && [101, 331].includes(context.subType))
    return {state:'withdrawn',protocol:'weibo-group-344',observedAt:message.time};
  return null;
}
function normalizeRecall(value) {
  if (!value || typeof value !== 'object' || value.state !== 'withdrawn' || value.protocol !== 'weibo-group-344'
    || !Number.isSafeInteger(value.observedAt) || value.observedAt < 0 || value.observedAt > 8640000000000000)
    throw new Error('撤回标记格式无效；请保留原数据后检查。');
  return {state:'withdrawn',protocol:'weibo-group-344',observedAt:value.observedAt};
}
function canonicalNotice(previous, incoming) {
  const recall = recallOf(previous) || recallOf(incoming);
  if (!recall) return null;
  const identity = previous || incoming;
  // Stable identity/time protects pagination, anchors and unread accounting.
  const value = {id:identity.id,groupId:identity.groupId,senderId:identity.senderId,
    senderName:identity.senderName,time:identity.time,text:NOTICE,recall,
    contextVersion:1,systemNotice:{kind:'weibo-system',type:344,subType:331}};
  if (identity.senderAvatarUrl) value.senderAvatarUrl=identity.senderAvatarUrl;
  if (previous?.localDeletion) value.localDeletion=previous.localDeletion;
  if (previous?.editionData !== undefined) value.editionData=previous.editionData;
  return value;
}
function publicMessage(message) {
  if (!message) return message;
  const recalled=recallOf(message), value=recalled ? canonicalNotice(message,message) : {...message};
  delete value.editionData;
  if(recalled)value.recall={...recalled,originalAvailable:false};
  return value;
}
module.exports={NOTICE,MISSING,keyOf,recallOf,normalizeRecall,canonicalNotice,publicMessage};
