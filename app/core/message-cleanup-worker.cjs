'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const {parentPort,workerData}=require('node:worker_threads');
const {validateState}=require('./store.cjs'),{operate}=require('./message-cleanup-operation.cjs');
const MAX_BYTES=512*1024*1024;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function progress(value){parentPort.postMessage({type:'progress',...value});}
let temporary;
try{
  const {file,accountId,action,payload,jobId}=workerData;
  if(!/^[a-f0-9]{32}$/.test(jobId)||path.basename(file)!=='account-'+hash(accountId)+'.json')throw Error('本地数据任务路径无效。');
  progress({phase:'reading',processed:null,total:null});
  if(fs.statSync(file).size>MAX_BYTES)throw Error('本地账号文件超过 512 MiB 上限。');
  const bytes=fs.readFileSync(file),baseHash=hash(bytes);
  progress({phase:'validating',processed:null,total:null});
  const state=validateState(JSON.parse(bytes.toString('utf8')),accountId);
  progress({phase:'planning',processed:null,total:null});
  const {result,changed}=operate(state,action,payload,{onProgress:progress});
  if(!changed){parentPort.postMessage({type:'done',result,changed:false});}
  else{
    progress({phase:'validating',processed:null,total:null});
    const normalized=validateState(state,accountId),serialized=Buffer.from(JSON.stringify(normalized));
    if(serialized.length>MAX_BYTES)throw Error('本地账号数据超过 512 MiB 保存上限；未写入更改。');
    temporary=file+'.cleanup-'+jobId+'.tmp';
    const fd=fs.openSync(temporary,'wx',0o600);
    try{
      let offset=0;progress({phase:'writing',processed:0,total:serialized.length,unit:'bytes'});
      while(offset<serialized.length){offset+=fs.writeSync(fd,serialized,offset,Math.min(1024*1024,serialized.length-offset));progress({phase:'writing',processed:offset,total:serialized.length,unit:'bytes'});}
      fs.fsyncSync(fd);
    }finally{fs.closeSync(fd);}
    parentPort.postMessage({type:'prepared',temporary,baseHash,sha256:hash(serialized),bytes:serialized.length,result});
    temporary=undefined;
  }
}catch(error){
  // Only this task's never-committed temporary file is eligible for cleanup.
  // The account JSON is never renamed or removed inside the worker.
  if(temporary)try{fs.unlinkSync(temporary);}catch{}
  const message=typeof error.message==='string'&&/^[\u4e00-\u9fff]/.test(error.message)&&!/[A-Za-z]:\\|account-[a-f0-9]{64}/.test(error.message)?error.message:'本地数据处理失败；原账号文件未修改。';
  parentPort.postMessage({type:'failure',message});
}
