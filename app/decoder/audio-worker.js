'use strict';
for(const key of ['log','info','warn','error','debug','trace'])console[key]=()=>{};
let used=false;
self.onmessage=async event=>{
 if(used)return;used=true;let core;
 try{
  const bytes=event.data;if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>10*1024*1024)throw new Error('AUDIO_LIMIT');
  importScripts('ffmpeg/ffmpeg-core.js');
  const response=await fetch('ffmpeg/ffmpeg-core.wasm',{credentials:'omit',cache:'no-store'});if(!response.ok)throw new Error();
  const wasmBinary=new Uint8Array(await response.arrayBuffer());if(!wasmBinary.length||wasmBinary.length>64*1024*1024)throw new Error();
  core=await createFFmpegCore({wasmBinary,print(){},printErr(){},locateFile:name=>'ffmpeg/'+name});
  core.setLogger?.(()=>{});core.setProgress?.(()=>{});core.setTimeout(110000);core.FS.writeFile('/input.amr',bytes);
  // No remote protocols, attachments, metadata or cover art; fixed PCM output.
  // max_alloc is per allocation, while the outer isolated worker is terminated
  // after 120 seconds. The audited WASM memory cap is unchanged at 2 GiB.
  const exit=core.exec('-hide_banner','-loglevel','error','-nostdin','-max_alloc','16777216','-protocol_whitelist','file',
   '-threads','1','-t','300','-f','amr','-i','/input.amr','-map','0:a:0','-vn','-sn','-dn','-map_metadata','-1',
   '-threads','1','-c:a','pcm_s16le','-ac','1','-ar','16000','-t','300','-fs','10485760','-f','wav','/output.wav');
  if(exit!==0)throw new Error();const output=core.FS.readFile('/output.wav');
  if(!(output instanceof Uint8Array)||!output.length||output.length>=10*1024*1024)throw new Error('AUDIO_LIMIT');
  const result=output.slice();self.postMessage({type:'result',mime:'audio/wav',bytes:result},[result.buffer]);
 }catch(error){self.postMessage({type:'error',code:error?.message==='AUDIO_LIMIT'?'AUDIO_LIMIT':'AUDIO_DECODE'});}
 finally{try{core?.FS.unlink('/input.amr');core?.FS.unlink('/output.wav');}catch{}self.close();}
};
