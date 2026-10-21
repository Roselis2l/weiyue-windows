'use strict';
// Offline, account-isolated merge. Never reads credentials or performs network/file I/O.
const assert=require('node:assert/strict');
const {normalizeMessage,compareMessages}=require('../../app/core/store.cjs');
const {normalizeAttachment}=require('../../app/core/attachments.cjs');
const clone=x=>JSON.parse(JSON.stringify(x));
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const messageKey=m=>JSON.stringify([m.groupId,m.id]);
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const set=(o,k,v)=>Object.defineProperty(o,k,{value:v,enumerable:true,writable:true,configurable:true});
function mergeAccount(primary,others){
 // This historical migration tool predates recyclable messages. It must not
 // normalize away local tombstones or guess how to merge recovery batches.
 for(const candidate of [primary,...others.map(item=>item.state)]){
  assert(candidate&&!(candidate.schemaVersion>=2)&&!(Array.isArray(candidate.messageTrash)&&candidate.messageTrash.length)&&
   !(Array.isArray(candidate.messages)&&candidate.messages.some(message=>message&&Object.prototype.hasOwnProperty.call(message,'localDeletion'))),
   'This historical offline merge tool does not support recyclable-message data; preserve the account and use a compatible migration tool.');
 }
 const state=clone(primary),conflicts=[],changes={addedMessages:0,addedBookmarks:0,addedSummaries:0,addedExports:0,addedUnread:0,groups:[]};
 const groupMap=new Map(state.groups.map(g=>[g.id,g])),messages=new Map(state.messages.map(m=>[messageKey(m),m]));
 const originalKeys=new Set(messages.keys()),newMessages=[];
 const addConflict=(kind,key,source,kept,incoming,fields)=>conflicts.push({kind,key,source,fields,displayPolicy:'destination retained; both original variants preserved',destination:clone(kept),incoming:clone(incoming)});
 function combineMedia(a,b){
  const out=clone(a);
  for(const k of ['text','senderName','senderAvatarUrl'])if(!out[k]&&b[k])out[k]=b[k];
  for(const k of ['mediaVersion','attachmentVersion'])if(out[k]===undefined&&b[k]!==undefined)out[k]=b[k];
  if(b.images){const images=new Map((a.images||[]).map(v=>[v.originalUrl||v.url,clone(v)]));for(const v of b.images){const k=v.originalUrl||v.url;if(!images.has(k))images.set(k,clone(v));}out.images=[...images.values()];}
  if(b.attachments){const attachments=new Map((a.attachments||[]).map(v=>[v.fid,clone(v)]));for(const raw of b.attachments){const v=normalizeAttachment(raw);assert(v,'Invalid recovered attachment');const previous=attachments.get(v.fid);if(!previous||(previous.state==='needs-metadata'&&v.state==='ready'))attachments.set(v.fid,v);}out.attachments=[...attachments.values()];}
  if(!a.sharedPost&&b.sharedPost)out.sharedPost=clone(b.sharedPost);
  return normalizeMessage(out);
 }
 function mergeSaved(name,items,source){
  const map=new Map(state[name].map(x=>[x.id,x]));
  for(const item of items){const previous=map.get(item.id);if(!previous){const same=name==='bookmarks'?state[name].find(x=>x.groupId===item.groupId&&equal([...x.messageIds].sort(),[...item.messageIds].sort())&&x.note===item.note&&equal([...x.tags].sort(),[...item.tags].sort())):null;if(same)continue;const value=clone(item);state[name].push(value);map.set(value.id,value);changes[name==='bookmarks'?'addedBookmarks':'addedSummaries']++;}else if(!equal(previous,item))addConflict(name,item.id,source,previous,item,Object.keys({...previous,...item}).filter(k=>!equal(previous[k],item[k])));}
 }
 for(const {label,state:incoming}of others){
  assert.equal(incoming.account.id,state.account.id,'Cross-account merge refused');assert.equal(incoming.account.kind,state.account.kind,'Account kind mismatch');
  for(const group of incoming.groups)if(!groupMap.has(group.id)){const g=clone(group);groupMap.set(g.id,g);state.groups.push(g);if(own(incoming.readPositions,group.id))set(state.readPositions,group.id,incoming.readPositions[group.id]);if(own(incoming.readStates||{},group.id))set(state.readStates,group.id,clone(incoming.readStates[group.id]));}
  for(const raw of incoming.messages){const m=normalizeMessage(raw),key=messageKey(m),previous=messages.get(key);if(!previous){messages.set(key,m);newMessages.push(m);changes.addedMessages++;continue;}
   const fields=Object.keys({...previous,...m}).filter(k=>!equal(previous[k],m[k]));
   if(fields.length)addConflict('message',key,label,previous,m,fields);
   // Identity/time disagreements are retained without attaching media to a possibly different sender.
   if(previous.senderId===m.senderId&&previous.time===m.time)messages.set(key,combineMedia(previous,m));
  }
  mergeSaved('bookmarks',incoming.bookmarks,label);mergeSaved('summaries',incoming.summaries,label);
  for(const [key,value]of Object.entries(incoming.exports||{})){if(!own(state.exports,key)){set(state.exports,key,clone(value));changes.addedExports++;}else if(!equal(state.exports[key],value))addConflict('export',key,label,state.exports[key],value,['journal']);}
  state.importantMembers=[...new Set([...state.importantMembers,...incoming.importantMembers])];
 }
 state.messages=[...messages.values()].sort(compareMessages);
 // Existing destination read position is authoritative. Only newly recovered IDs after
 // its high-water mark join unread; already-known IDs are never reclassified.
 for(const group of primary.groups){const before=primary.readStates[group.id],current=state.readStates[group.id];assert(before&&current,'Destination read state missing');const through=before.readThroughId===null?null:messages.get(messageKey({groupId:group.id,id:before.readThroughId}));const recovered=newMessages.filter(m=>m.groupId===group.id&&!originalKeys.has(messageKey(m))&&(!through||compareMessages(m,through)>0));const unread=new Set(before.unreadIds);for(const m of recovered)unread.add(m.id);current.unreadIds=[...unread];const added=current.unreadIds.length-before.unreadIds.length;changes.addedUnread+=added;changes.groups.push({groupId:group.id,addedMessages:newMessages.filter(m=>m.groupId===group.id).length,addedUnread:added,unreadBefore:before.unreadIds.length,unreadAfter:current.unreadIds.length,readPositionPreserved:equal({...before,unreadIds:[]},{...current,unreadIds:[]})});}
 assert(equal(state.settings,primary.settings),'Destination settings changed');assert(equal(state.account,primary.account),'Destination account metadata changed');
 return {state,conflicts,changes};
}
module.exports={mergeAccount,messageKey};
