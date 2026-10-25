'use strict';
// A decoder-only document: no user content, account session or remote access.
window.audioDecoderBridge.subscribe(value=>{
 let worker,done=false;
 const finish=result=>{if(done)return;done=true;worker?.terminate();window.audioDecoderBridge.complete({...result,id:value?.id});};
 try{
  if(!value||typeof value.id!=='string'||!(value.bytes instanceof Uint8Array)||!value.bytes.length||value.bytes.length>10*1024*1024)throw new Error();
  worker=new Worker('audio-worker.js');worker.onmessage=event=>{const message=event.data;
   if(message?.type==='progress'&&['worker-start','core-imported','wasm-fetched','core-ready','timeout-set','input-written','transcode-exit','option-error','memory-error','core-abort','exception-memory','exception-reference','exception-function','exception-property','exception-unreachable','exception-eval'].includes(message.stage)){window.audioDecoderBridge.complete({type:'progress',stage:message.stage,id:value.id});return;}
   if(message?.type==='result')finish({type:'result',mime:'audio/wav',bytes:message.bytes});
   else finish({type:'error',code:message?.code==='AUDIO_LIMIT'?'AUDIO_LIMIT':'AUDIO_DECODE'});
  };worker.onerror=event=>{event.preventDefault();finish({type:'error',code:'AUDIO_DECODE'});};
  const bytes=value.bytes.slice();worker.postMessage(bytes,[bytes.buffer]);
 }catch{finish({type:'error',code:'AUDIO_DECODE'});}
});
