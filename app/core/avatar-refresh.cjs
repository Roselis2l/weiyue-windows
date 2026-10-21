'use strict';
const {avatarGroupUpdates}=require('./avatar.cjs');

// Metadata is optional. Known transport failures must not stop a usable
// message sync; authentication, refusal, risk and unknown failures still stop.
async function refreshGroupAvatars({client,store,accountId,groups,groupId,signal,onChange}){
  const check=()=>{if(signal?.aborted)throw Object.assign(new Error('同步已取消。'),{code:'ABORTED'});};
  check();let fresh;
  try{fresh=await client.groups({signal});}
  catch(error){
    check();
    if(['NETWORK','TIMEOUT','SERVER_ERROR'].includes(error.code))return {updated:0,deferred:true};
    throw error;
  }
  check();
  const updates=avatarGroupUpdates(groups,fresh,groupId);
  if(updates.length){store.mergeMessages(accountId,updates,[],{history:true});onChange?.();}
  return {updated:updates.length,deferred:false};
}
module.exports={refreshGroupAvatars};
