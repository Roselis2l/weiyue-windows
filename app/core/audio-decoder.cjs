'use strict';
// AMR speech is converted locally in a fresh sandbox and terminable
// Worker. The decoder receives bytes only, never paths, accounts or URLs.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{types}=require('node:util');
const MAX_BYTES=10*1024*1024,MAX_OUTPUT_BYTES=10*1024*1024,MAX_SECONDS=300,MAX_FRAMES=15000;
const TIMEOUT_MS=120000,QUEUE_LIMIT=1,PAGE='app://audio-decoder/audio.html';
const CSP="default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; img-src 'none'; style-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
const ASSETS=Object.freeze({
 '/audio.html':['audio.html','text/html; charset=utf-8'], '/audio.js':['audio.js','text/javascript; charset=utf-8'],
 '/audio-worker.js':['audio-worker.js','text/javascript; charset=utf-8'],
 '/ffmpeg/ffmpeg-core.js':['ffmpeg/ffmpeg-core.js','text/javascript; charset=utf-8'],
 '/ffmpeg/ffmpeg-core.wasm':['ffmpeg/ffmpeg-core.wasm','application/wasm'],
});
const CODES=new Set(['AUDIO_INVALID','AUDIO_LIMIT','AUDIO_DECODE','AUDIO_ABORT','AUDIO_TIMEOUT','AUDIO_BUSY']);
const typed=Object.getPrototypeOf(Uint8Array.prototype),lengthGet=Object.getOwnPropertyDescriptor(typed,'byteLength').get,
 offsetGet=Object.getOwnPropertyDescriptor(typed,'byteOffset').get,bufferGet=Object.getOwnPropertyDescriptor(typed,'buffer').get;
const sessions=new WeakMap();
class AudioDecodeError extends Error{
 constructor(code){super(code==='AUDIO_TIMEOUT'?'本机语音转换超时。':code==='AUDIO_ABORT'?'本机语音转换已取消。':
  code==='AUDIO_LIMIT'?'本机转换仅支持 10 MB、5 分钟以内的 AMR 语音。':
  code==='AUDIO_BUSY'?'本机语音转换正在进行，请稍后重试。':'此语音暂时无法在本机转换。可另存原文件后查看。');this.name='AudioDecodeError';this.code=CODES.has(code)?code:'AUDIO_DECODE';}
}
function exactBytes(value,max=MAX_BYTES){
 if(!types.isUint8Array(value))throw new AudioDecodeError('AUDIO_INVALID');
 const length=Reflect.apply(lengthGet,value,[]);if(!length||length>max)throw new AudioDecodeError('AUDIO_LIMIT');
 return Buffer.from(new Uint8Array(Reflect.apply(bufferGet,value,[]),Reflect.apply(offsetGet,value,[]),length));
}
// RFC 4867 section 5: single-channel storage with one 20 ms frame per TOC.
// https://www.rfc-editor.org/rfc/rfc4867.html#section-5
// Do not accept a file merely because it contains the magic text: consume all
// declared frames and reject reserved frame types, truncation and excess time.
function inspectAmr(input){
 if(!Buffer.isBuffer(input)||!input.length||input.length>MAX_BYTES)return null;
 const wb=input.subarray(0,9).equals(Buffer.from('#!AMR-WB\n')),nb=input.subarray(0,6).equals(Buffer.from('#!AMR\n'));
 if(!wb&&!nb)return null;
 const sizes=wb?[17,23,32,36,40,46,50,58,60,5,null,null,null,null,0,0]:[12,13,15,17,19,20,26,31,5,null,null,null,null,null,null,0];
 let frames=0,at=wb?9:6;
 while(at<input.length){const header=input[at++],size=sizes[(header>>3)&15];
  if(size===null||size===undefined||at+size>input.length||++frames>MAX_FRAMES)return null;
  at+=size;
 }
 return frames?{codec:wb?'amr_wb':'amr_nb',duration:frames/50,frames,channels:1,sampleRate:wb?16000:8000}:null;
}
function wavResult(payload){
 if(!payload||payload.mime!=='audio/wav')throw new AudioDecodeError('AUDIO_DECODE');const bytes=exactBytes(payload.bytes,MAX_OUTPUT_BYTES);
 if(bytes.length<44||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE'||bytes.readUInt32LE(4)!==bytes.length-8)throw new AudioDecodeError('AUDIO_DECODE');
 let at=12,fmt=false,data=0,chunks=0;
 while(at<bytes.length){if(at+8>bytes.length||++chunks>32)throw new AudioDecodeError('AUDIO_DECODE');const kind=bytes.toString('ascii',at,at+4),size=bytes.readUInt32LE(at+4),p=at+8;if(p+size>bytes.length)throw new AudioDecodeError('AUDIO_DECODE');
  if(kind==='fmt '){if(fmt||size<16||bytes.readUInt16LE(p)!==1||bytes.readUInt16LE(p+2)!==1||bytes.readUInt32LE(p+4)!==16000||bytes.readUInt32LE(p+8)!==32000||bytes.readUInt16LE(p+12)!==2||bytes.readUInt16LE(p+14)!==16)throw new AudioDecodeError('AUDIO_DECODE');fmt=true;}
  if(kind==='data'){if(data||!size||size%2||size>MAX_SECONDS*32000)throw new AudioDecodeError('AUDIO_DECODE');data=size;}
  at=p+size+(size%2);
 }
 if(!fmt||!data||at!==bytes.length)throw new AudioDecodeError('AUDIO_DECODE');
 return {bytes,mime:'audio/wav',kind:'audio'};
}
function allowedResource(value){try{const u=new URL(value);return u.protocol==='app:'&&u.host==='audio-decoder'&&!u.username&&!u.password&&!u.port&&!u.search&&!u.hash&&Object.hasOwn(ASSETS,u.pathname);}catch{return false;}}
function decoderSession(session,appRoot){
 let roots=sessions.get(session);if(!roots){roots=new Map();sessions.set(session,roots);}const root=path.resolve(appRoot);if(roots.has(root))return roots.get(root);
 const decoder=session.fromPartition('weiyue-audio-offline-'+crypto.createHash('sha256').update(root).digest('hex').slice(0,16),{cache:false});
 decoder.setPermissionRequestHandler((_,__,cb)=>cb(false));decoder.setPermissionCheckHandler(()=>false);decoder.on('will-download',e=>e.preventDefault());
 decoder.webRequest.onBeforeRequest((details,cb)=>cb({cancel:!allowedResource(details.url)}));
 const verified=new Map();
 decoder.protocol.handle('app',request=>{
  if(request.method!=='GET'||!allowedResource(request.url))return new Response('',{status:404});const asset=ASSETS[new URL(request.url).pathname];
  try{
   let bytes=verified.get(asset[0]);
   if(!bytes){bytes=fs.readFileSync(path.join(root,'decoder',asset[0]));
    if(asset[0].startsWith('ffmpeg/')){
     const manifest=JSON.parse(fs.readFileSync(path.join(root,'decoder/ffmpeg/assets.json'),'utf8'));
     const item=manifest.files?.find(x=>x.path===path.basename(asset[0]));
     if(!item||item.bytes!==bytes.length||item.sha256!==crypto.createHash('sha256').update(bytes).digest('hex'))throw new Error();
    }verified.set(asset[0],bytes);
   }
   return new Response(bytes,{headers:{'Content-Type':asset[1],'Content-Security-Policy':CSP,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'}});
  }catch{return new Response('',{status:404});}
 });roots.set(root,decoder);return decoder;
}
function createAudioDecoder({BrowserWindow,ipcMain,session,appRoot,timeoutMs=TIMEOUT_MS}={}){
 if(typeof BrowserWindow!=='function'||typeof ipcMain?.on!=='function'||typeof ipcMain?.removeListener!=='function'||typeof appRoot!=='string'||!path.isAbsolute(appRoot)||
  !Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>TIMEOUT_MS)throw new AudioDecodeError('AUDIO_INVALID');
 session ||= require('electron').session;if(typeof session?.fromPartition!=='function')throw new AudioDecodeError('AUDIO_INVALID');
 const channel='weiyue:audio:'+crypto.randomUUID(),queue=[];let active,disposed=false;
 function finish(job,error,value){if(job.settled)return;job.settled=true;clearTimeout(job.timer);job.signal?.removeEventListener('abort',job.onAbort);
  const i=queue.indexOf(job);if(i>=0)queue.splice(i,1);job.bytes=null;if(job.window&&!job.window.isDestroyed())job.window.destroy();
  try{Promise.resolve(job.session?.clearStorageData()).catch(()=>{});}catch{}if(active===job)active=null;error?job.reject(error):job.resolve(value);queueMicrotask(startNext);}
 function startNext(){if(disposed||active||!queue.length)return;const job=queue.shift();if(job.settled){queueMicrotask(startNext);return;}active=job;
  if(job.signal?.aborted){finish(job,new AudioDecodeError('AUDIO_ABORT'));return;}
  try{
   job.session=decoderSession(session,appRoot);const window=new BrowserWindow({show:false,width:32,height:32,skipTaskbar:true,webPreferences:{
    session:job.session,preload:path.join(appRoot,'audio-decoder-preload.cjs'),additionalArguments:['--weiyue-audio-channel='+channel],contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,backgroundThrottling:false,devTools:false,spellcheck:false}});
   job.window=window;const wc=window.webContents;wc.setWindowOpenHandler(()=>({action:'deny'}));wc.on('will-navigate',e=>e.preventDefault());wc.on('will-attach-webview',e=>e.preventDefault());
   wc.on('render-process-gone',()=>finish(job,new AudioDecodeError('AUDIO_DECODE')));window.on('closed',()=>finish(job,new AudioDecodeError('AUDIO_ABORT')));
   Promise.resolve(window.loadURL(PAGE)).catch(()=>finish(job,new AudioDecodeError('AUDIO_DECODE')));
  }catch{finish(job,new AudioDecodeError('AUDIO_DECODE'));}
 }
 const receive=(event,payload)=>{const job=active;if(!job||job.settled||!job.window||event.sender!==job.window.webContents||event.senderFrame!==event.sender.mainFrame||event.senderFrame?.url!==PAGE||!payload||typeof payload!=='object')return;
  if(payload.type==='ready'){if(job.sent)return;job.sent=true;try{event.sender.send(channel,{id:job.id,bytes:job.bytes});}catch{finish(job,new AudioDecodeError('AUDIO_DECODE'));}return;}
  if(!job.sent||payload.id!==job.id)return;
  if(payload.type==='error')finish(job,new AudioDecodeError(CODES.has(payload.code)?payload.code:'AUDIO_DECODE'));
  else if(payload.type==='result'){try{finish(job,null,wavResult(payload));}catch{finish(job,new AudioDecodeError('AUDIO_DECODE'));}}
 };
 ipcMain.on(channel,receive);
 function decode(value,{signal}={}){
  if(disposed||signal?.aborted)return Promise.reject(new AudioDecodeError('AUDIO_ABORT'));
  if(signal&&(typeof signal.addEventListener!=='function'||typeof signal.removeEventListener!=='function'))return Promise.reject(new AudioDecodeError('AUDIO_INVALID'));
  if(queue.length>=QUEUE_LIMIT)return Promise.reject(new AudioDecodeError('AUDIO_BUSY'));
  let bytes;try{if(!['audio/amr','audio/amr-wb'].includes(value?.mime))throw new AudioDecodeError('AUDIO_INVALID');bytes=exactBytes(value.bytes);if(!inspectAmr(bytes))throw new AudioDecodeError('AUDIO_LIMIT');}catch(error){return Promise.reject(error);}
  return new Promise((resolve,reject)=>{const job={id:crypto.randomUUID(),bytes,signal,resolve,reject,settled:false};job.onAbort=()=>finish(job,new AudioDecodeError('AUDIO_ABORT'));
   job.timer=setTimeout(()=>finish(job,new AudioDecodeError('AUDIO_TIMEOUT')),timeoutMs);signal?.addEventListener('abort',job.onAbort,{once:true});queue.push(job);if(signal?.aborted)job.onAbort();else startNext();});
 }
 function close(){const all=[...queue];if(active)all.push(active);for(const job of all)finish(job,new AudioDecodeError('AUDIO_ABORT'));}
 return {decode,close,closeAll:close,dispose(){disposed=true;close();ipcMain.removeListener(channel,receive);}};
}
module.exports={createAudioDecoder,AudioDecodeError,inspectAmr,exactBytes,wavResult,allowedResource,MAX_BYTES,MAX_OUTPUT_BYTES,MAX_SECONDS,MAX_FRAMES,TIMEOUT_MS,QUEUE_LIMIT,PAGE,CSP};
