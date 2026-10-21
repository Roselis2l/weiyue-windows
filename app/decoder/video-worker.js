'use strict';
for(const key of ['log','info','warn','error','debug','trace'])console[key]=()=>{};
let used=false;
self.onmessage=async event=>{
 if(used)return;used=true;let core;
 const stage=value=>self.postMessage({type:'progress',stage:value});
 try{
  stage('worker-start');
  const bytes=event.data;if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>20*1024*1024)throw new Error('VIDEO_LIMIT');
  importScripts('ffmpeg/ffmpeg-core.js');
  stage('core-imported');
  const wasmResponse=await fetch('ffmpeg/ffmpeg-core.wasm',{credentials:'omit',cache:'no-store'});if(!wasmResponse.ok)throw new Error();
  const wasmBinary=new Uint8Array(await wasmResponse.arrayBuffer());if(!wasmBinary.length||wasmBinary.length>64*1024*1024)throw new Error();
  stage('wasm-fetched');
  core=await createFFmpegCore({wasmBinary,print(){},printErr(){},locateFile:name=>'ffmpeg/'+name});
  stage('core-ready');
  core.setLogger?.(({message})=>{for(const [pattern,label] of [[/Unrecognized option|Option not found/,'option-error'],[/Cannot allocate|out of memory/i,'memory-error'],[/Aborted/i,'core-abort']])if(pattern.test(message))stage(label);});core.setProgress?.(()=>{});core.setTimeout(110000);stage('timeout-set');core.FS.writeFile('/input.mp4',bytes);stage('input-written');
  // max_alloc limits each allocation, not total memory. The verified upstream
  // single-thread core has a 2 GiB WASM linear-memory maximum. The outer helper
  // is independently terminated at 120 seconds (including initialization).
  const exit=core.exec('-hide_banner','-loglevel','error','-nostdin','-max_alloc','67108864','-protocol_whitelist','file','-max_pixels','12000000','-threads','1','-t','30','-i','/input.mp4',
   '-map','0:v:0','-map','0:a:0?','-sn','-dn','-map_metadata','-1','-threads','1',
   '-vf','fps=24,scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p',
   '-c:v','libvpx','-deadline','realtime','-cpu-used','8','-crf','16','-b:v','1200k','-threads','1',
   '-c:a','libvorbis','-q:a','3','-t','30','-frames:v','720','-fs',String(64*1024*1024),'-f','webm','/output.webm');
  stage('transcode-exit');if(exit!==0)throw new Error();const output=core.FS.readFile('/output.webm');
  if(!(output instanceof Uint8Array)||!output.length||output.length>=64*1024*1024)throw new Error('VIDEO_LIMIT');
  const result=output.slice();self.postMessage({type:'result',mime:'video/webm',bytes:result},[result.buffer]);
 }catch(error){for(const [pattern,label] of [[/memory access out of bounds/i,'exception-memory'],[/not defined/i,'exception-reference'],[/not a function/i,'exception-function'],[/Cannot read properties/i,'exception-property'],[/unreachable/i,'exception-unreachable'],[/eval|unsafe/i,'exception-eval']])if(pattern.test(error?.message||''))stage(label);self.postMessage({type:'error',code:error?.message==='VIDEO_LIMIT'?'VIDEO_LIMIT':'VIDEO_DECODE'});}
 finally{try{core?.FS.unlink('/input.mp4');core?.FS.unlink('/output.webm');}catch{}self.close();}
};
