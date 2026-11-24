'use strict';
// A decoder-only document: no user content, account session or remote access.
window.videoDecoderBridge.subscribe(value=>{
 let worker,done=false;const id=value?.id,extended=value?.extended===true;
 const finish=result=>{if(done)return;done=true;worker?.terminate();window.videoDecoderBridge.complete({...result,id});};
 try{
  if(!value||typeof value.id!=='string'||!(value.bytes instanceof Uint8Array)||!value.bytes.length||value.bytes.length>(extended?200*1024*1024:100*1024*1024))throw new Error();
  worker=new Worker('video-worker.js');worker.onmessage=event=>{const message=event.data;
   if(message?.type==='progress'&&['worker-start','core-imported','wasm-fetched','core-ready','timeout-set','input-written','transcode-exit','option-error','memory-error','core-abort','exception-memory','exception-reference','exception-function','exception-property','exception-unreachable','exception-eval'].includes(message.stage)){window.videoDecoderBridge.complete({type:'progress',stage:message.stage,id});return;}
   if(message?.type==='result')finish({type:'result',mime:'video/webm',bytes:message.bytes});
   else finish({type:'error',code:message?.code==='VIDEO_LIMIT'?'VIDEO_LIMIT':'VIDEO_DECODE'});
  };worker.onerror=event=>{event.preventDefault();finish({type:'error',code:'VIDEO_DECODE'});};
  let bytes=value.bytes;const expectedDuration=value.expectedDuration;if(bytes.byteOffset!==0||bytes.byteLength!==bytes.buffer.byteLength)bytes=bytes.slice();value=null;worker.postMessage({bytes,extended,expectedDuration},[bytes.buffer]);
 }catch{finish({type:'error',code:'VIDEO_DECODE'});}
});
