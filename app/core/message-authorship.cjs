'use strict';

const {recallOf}=require('./message-recalls.cjs');

// Only use the visible edition projection. Never inspect editionData, quote
// authors, forwarded-post authors, member names or the wording of a notice.
// A notice's top-level sender ID can be an associated member, not its author.
function stableSenderId(value) {
  if(typeof value!=='string'||!value||value!==value.trim()||value.length>256
    ||/[\u0000-\u001f]/.test(value)||value==='0'||value.startsWith('unknown:'))return null;
  return value;
}

function classifyMessageAuthorship(message) {
  const associatedSenderId=stableSenderId(message?.senderId);
  let withdrawn=false,validRecall=false;
  try { validRecall=!!recallOf(message);withdrawn=validRecall; }
  catch { withdrawn=message?.recall?.state==='withdrawn'; }
  const recallNotice=message?.systemNotice?.kind==='weibo-system'
    &&message.systemNotice.type===344&&[101,331].includes(message.systemNotice.subType);
  // originalAvailable is produced by the edition projection. A raw stored
  // withdrawal or a local deletion never qualifies, even if it keeps an ID.
  const originalAvailable=withdrawn&&validRecall&&message?.recall?.originalAvailable===true
    &&!recallNotice&&!message?.localDeletion&&!message?.contentUnavailable;
  const messageType=withdrawn&&!originalAvailable?'withdrawn-unavailable'
    :message?.systemNotice?'system-notice':'member-message';
  const authored=messageType==='member-message'&&!!associatedSenderId
    &&!message?.localDeletion&&!message?.contentUnavailable;
  return {messageType,senderId:authored?associatedSenderId:null,
    associatedSenderId:authored?null:associatedSenderId,withdrawn,originalAvailable,authored};
}

function authoredSenderId(message) {return classifyMessageAuthorship(message).senderId;}
function isMemberAuthoredMessage(message) {return classifyMessageAuthorship(message).authored;}

module.exports={stableSenderId,classifyMessageAuthorship,authoredSenderId,isMemberAuthoredMessage};
