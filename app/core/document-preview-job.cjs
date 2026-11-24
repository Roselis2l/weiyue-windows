'use strict';
const {Worker}=require('node:worker_threads');
const {MIME,LIMITS}=require('./document-preview.cjs');
function previewDocument(value,{signal,timeoutMs=15000}={}){
 if(!Object.values(MIME).includes(value?.mime)||!Buffer.isBuffer(value?.bytes)||value.bytes.length>(value.mime===MIME.xlsx?LIMITS.xlsxBytes:LIMITS.textBytes))return Promise.reject(new Error('DOCUMENT_FORMAT'));
 if(signal?.aborted)return Promise.reject(new Error('DOCUMENT_ABORT'));
 return new Promise((resolve,reject)=>{
  const worker=new Worker(require.resolve('./document-preview-worker.cjs'),{workerData:{bytes:value.bytes,mime:value.mime},resourceLimits:{maxOldGenerationSizeMb:128,maxYoungGenerationSizeMb:16,stackSizeMb:4}});
  let settled=false;const finish=(error,data)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);void worker.terminate();error?reject(error):resolve(data);};
  const abort=()=>finish(new Error('DOCUMENT_ABORT'));const timer=setTimeout(()=>finish(new Error('DOCUMENT_TIMEOUT')),Math.max(1,Math.min(15000,timeoutMs)));
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  worker.once('message',result=>result?.ok?finish(null,result.value):finish(new Error(result?.error==='DOCUMENT_LIMIT'?'DOCUMENT_LIMIT':'DOCUMENT_FORMAT')));
  worker.once('error',()=>finish(new Error('DOCUMENT_FORMAT')));worker.once('exit',code=>{if(!settled)finish(new Error('DOCUMENT_FORMAT'));});
 });
}
module.exports={previewDocument};
