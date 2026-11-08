'use strict';
// Acceptance harness only. Never retry a Store error without evidence that the
// separately running synthetic app replaced the file during this exact read.
const fs=require('node:fs');
const stamp=file=>{const s=fs.statSync(file,{bigint:true});return [s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');};
const genericReadError='无法读取本地账号数据；请保留原文件后检查或恢复备份';
async function readStableSynthetic({file,read,onRetry=()=>{},attempts=5,readStamp=stamp,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
 if(!Number.isSafeInteger(attempts)||attempts<1||attempts>5)throw Error('Invalid synthetic stable-read bound');
 for(let attempt=1;attempt<=attempts;attempt++){
  const before=readStamp(file);let value,error;
  try{value=read();}catch(caught){error=caught;}
  // A failed stat, malformed JSON with a stable stamp, invalid state, permission
  // failure, or any non-generic Store exception is a genuine test failure.
  const after=readStamp(file);
  if(error&&(error.message!==genericReadError||before===after))throw error;
  if(before===after)return value;
  if(attempt===attempts)throw error||Error('Synthetic account kept changing across bounded stable reads');
  onRetry({attempt,before,after,reason:error?'Store rejected concurrent replacement':'File replaced before snapshot returned'});
  await sleep(60);
 }
}
module.exports={readStableSynthetic,genericReadError};
