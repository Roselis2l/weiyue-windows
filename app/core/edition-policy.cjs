'use strict';
// Fixed policy shipped by the public build. No setting enables withdrawn text.
const {publicMessage}=require('./message-recalls.cjs');
const {projectAccount,contentEpoch}=require('./content-projection.cjs');
module.exports={
  mergeRecall(_previous,notice){return notice;},
  projectMessage:publicMessage,
  projectAccount(state){return projectAccount(state,publicMessage);},
  contentEpoch,
};
