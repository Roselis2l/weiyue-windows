'use strict';
// Short HEVC clips are converted locally in a fresh sandbox and terminable
// Worker. The decoder receives bytes only, never paths, accounts or URLs.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{types}=require('node:util');
const MAX_BYTES=20*1024*1024,MAX_OUTPUT_BYTES=64*1024*1024,MAX_SECONDS=30,MAX_EDGE=4096,MAX_PIXELS=12000000,MAX_FRAMES=1800;
const TIMEOUT_MS=120000,QUEUE_LIMIT=1,PAGE='app://video-decoder/video.html';
const CSP="default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; img-src 'none'; style-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
const ASSETS=Object.freeze({
 '/video.html':['video.html','text/html; charset=utf-8'], '/video.js':['video.js','text/javascript; charset=utf-8'],
 '/video-worker.js':['video-worker.js','text/javascript; charset=utf-8'],
 '/ffmpeg/ffmpeg-core.js':['ffmpeg/ffmpeg-core.js','text/javascript; charset=utf-8'],
 '/ffmpeg/ffmpeg-core.wasm':['ffmpeg/ffmpeg-core.wasm','application/wasm'],
});
const CODES=new Set(['VIDEO_INVALID','VIDEO_LIMIT','VIDEO_DECODE','VIDEO_ABORT','VIDEO_TIMEOUT','VIDEO_BUSY']);
const typed=Object.getPrototypeOf(Uint8Array.prototype),lengthGet=Object.getOwnPropertyDescriptor(typed,'byteLength').get,
 offsetGet=Object.getOwnPropertyDescriptor(typed,'byteOffset').get,bufferGet=Object.getOwnPropertyDescriptor(typed,'buffer').get;
const sessions=new WeakMap();
class VideoDecodeError extends Error{
 constructor(code){super(code==='VIDEO_TIMEOUT'?'本机视频转换超时。':code==='VIDEO_ABORT'?'本机视频转换已取消。':
  code==='VIDEO_LIMIT'?'本机转换仅支持 20 MB、30 秒以内，尺寸不超过 4096 像素的短片。':
  code==='VIDEO_BUSY'?'本机视频转换正在进行，请稍后重试。':'此视频暂时无法在本机转换。可另存原文件后查看。');this.name='VideoDecodeError';this.code=CODES.has(code)?code:'VIDEO_DECODE';}
}
function exactBytes(value,max=MAX_BYTES){
 if(!types.isUint8Array(value))throw new VideoDecodeError('VIDEO_INVALID');
 const length=Reflect.apply(lengthGet,value,[]);if(!length||length>max)throw new VideoDecodeError('VIDEO_LIMIT');
 return Buffer.from(new Uint8Array(Reflect.apply(bufferGet,value,[]),Reflect.apply(offsetGet,value,[]),length));
}
// Parse only bounded ISO BMFF structural fields. No EXIF, names or arbitrary
// metadata strings are exposed. ISO MP4 retains the single-video restriction.
// QuickTime permits bounded auxiliary video tracks: only its first video track
// is selected, matching the worker's explicit -map 0:v:0. QuickTime has a media
// handler under mdia and a separate data handler under minf; these are distinct.
// https://developer.apple.com/documentation/quicktime-file-format/handler_reference_atom
function inspectHevcMp4(input){
 if(!Buffer.isBuffer(input)||input.length<24||input.length>MAX_BYTES)return null;
 const b=input,tracks=[];let boxes=0,brand=false,quicktime=false,fragmented=false;
 function duration(at,end){if(at+20>end)return null;const version=b[at];if(![0,1].includes(version))return null;
  const p=at+(version===1?20:12);if(p+(version===1?12:8)>end)return null;const scale=b.readUInt32BE(p),ticks=version===1?Number(b.readBigUInt64BE(p+4)):b.readUInt32BE(p+4);
  return scale&&Number.isSafeInteger(ticks)&&ticks>0?{seconds:ticks/scale,scale,ticks}:null;}
 function walk(start,end,depth,track,parent=''){
  if(depth>6)throw new Error();
  for(let at=start;at<end;){
   if(++boxes>2048||at+8>end)throw new Error();let size=b.readUInt32BE(at),header=8;const type=b.toString('ascii',at+4,at+8);
   if(size===1){if(at+16>end)throw new Error();const n=b.readBigUInt64BE(at+8);if(n>BigInt(end-at))throw new Error();size=Number(n);header=16;}
   if(size===0)size=end-at;if(size<header||at+size>end)throw new Error();const p=at+header,stop=at+size;
   if(type==='ftyp'&&depth===0){if(size>4096||stop-p<8||(stop-p-8)%4)throw new Error();const brands=[b.toString('ascii',p,p+4)];for(let x=p+8;x<stop;x+=4)brands.push(b.toString('ascii',x,x+4));
    quicktime=brands[0]==='qt  ';brand=(quicktime||brands.some(x=>['mp42','mp41','isom','iso2','iso3','iso4','iso5','iso6','M4V '].includes(x)))&&!brands.some(x=>['heic','heix','mif1','msf1','avif','avis'].includes(x));}
   if(type==='moof')fragmented=true;
   if(type==='trak'){if(tracks.length>=16||parent!=='moov')throw new Error();const current={codecs:[],duration:null,frames:0,sampleTicks:0,handler:null};tracks.push(current);walk(p,stop,depth+1,current,type);}
   else if(['moov','mdia','minf','stbl'].includes(type))walk(p,stop,depth+1,track,type);
   else if(track&&type==='mdhd'&&parent==='mdia'){if(track.duration)throw new Error();track.duration=duration(p,stop);}
   else if(track&&type==='hdlr'&&parent==='mdia'){if(p+12>stop||track.handler)throw new Error();track.handler=b.toString('ascii',p+8,p+12);}
   else if(track&&type==='stts'){
    if(p+8>stop)throw new Error();const count=b.readUInt32BE(p+4);if(count>MAX_FRAMES||p+8+count*8>stop)throw new Error();
    for(let x=0;x<count;x++){const samples=b.readUInt32BE(p+8+x*8),delta=b.readUInt32BE(p+12+x*8);if(!samples||!delta)throw new Error();track.frames+=samples;track.sampleTicks+=samples*delta;if(!Number.isSafeInteger(track.sampleTicks)||track.frames>10000000)throw new Error();}
   }else if(track&&type==='stsd'){
    if(p+8>stop)throw new Error();const count=b.readUInt32BE(p+4);if(count>16)throw new Error();let x=p+8;
    for(let i=0;i<count;i++){if(x+8>stop)throw new Error();const n=b.readUInt32BE(x),codec=b.toString('ascii',x+4,x+8);if(n<8||x+n>stop)throw new Error();
     track.codecs.push(codec);if(n>=86){track.width=b.readUInt16BE(x+32);track.height=b.readUInt16BE(x+34);}x+=n;
    }
   }at=stop;
  }
 }
 try{walk(0,b.length,0,null);}catch{return null;}
 const videos=tracks.filter(x=>x.handler==='vide');if(!brand||fragmented||!videos.length||(!quicktime&&videos.length!==1)||tracks.some(x=>!x.handler||x.codecs.some(c=>['encv','enca'].includes(c))))return null;const v=videos[0];
 const seconds=v.duration?.seconds,sampleSeconds=v.duration?.scale?v.sampleTicks/v.duration.scale:NaN;
 if(v.codecs.length!==1||!['hvc1','hev1'].includes(v.codecs[0])||!v.width||!v.height||v.width>MAX_EDGE||v.height>MAX_EDGE||v.width*v.height>MAX_PIXELS||
  !Number.isFinite(seconds)||seconds<=0||seconds>MAX_SECONDS||!Number.isFinite(sampleSeconds)||sampleSeconds<=0||sampleSeconds>MAX_SECONDS||Math.abs(sampleSeconds-seconds)>Math.max(.002,1/v.duration.scale)||v.frames<1||v.frames>MAX_FRAMES||v.frames/seconds>120)return null;
 return {codec:v.codecs[0],width:v.width,height:v.height,duration:seconds,frames:v.frames};
}
function webmResult(payload){
 if(!payload||payload.mime!=='video/webm')throw new VideoDecodeError('VIDEO_DECODE');const bytes=exactBytes(payload.bytes,MAX_OUTPUT_BYTES);
 if(bytes.length<16||!bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])))throw new VideoDecodeError('VIDEO_DECODE');
 return {bytes,mime:'video/webm',kind:'video'};
}
function allowedResource(value){try{const u=new URL(value);return u.protocol==='app:'&&u.host==='video-decoder'&&!u.username&&!u.password&&!u.port&&!u.search&&!u.hash&&Object.hasOwn(ASSETS,u.pathname);}catch{return false;}}
function decoderSession(session,appRoot){
 let roots=sessions.get(session);if(!roots){roots=new Map();sessions.set(session,roots);}const root=path.resolve(appRoot);if(roots.has(root))return roots.get(root);
 const decoder=session.fromPartition('weiyue-video-offline-'+crypto.createHash('sha256').update(root).digest('hex').slice(0,16),{cache:false});
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
function createVideoDecoder({BrowserWindow,ipcMain,session,appRoot,timeoutMs=TIMEOUT_MS}={}){
 if(typeof BrowserWindow!=='function'||typeof ipcMain?.on!=='function'||typeof ipcMain?.removeListener!=='function'||typeof appRoot!=='string'||!path.isAbsolute(appRoot)||
  !Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>TIMEOUT_MS)throw new VideoDecodeError('VIDEO_INVALID');
 session ||= require('electron').session;if(typeof session?.fromPartition!=='function')throw new VideoDecodeError('VIDEO_INVALID');
 const channel='weiyue:video:'+crypto.randomUUID(),queue=[];let active,disposed=false;
 function finish(job,error,value){if(job.settled)return;job.settled=true;clearTimeout(job.timer);job.signal?.removeEventListener('abort',job.onAbort);
  const i=queue.indexOf(job);if(i>=0)queue.splice(i,1);job.bytes=null;if(job.window&&!job.window.isDestroyed())job.window.destroy();
  try{Promise.resolve(job.session?.clearStorageData()).catch(()=>{});}catch{}if(active===job)active=null;error?job.reject(error):job.resolve(value);queueMicrotask(startNext);}
 function startNext(){if(disposed||active||!queue.length)return;const job=queue.shift();if(job.settled){queueMicrotask(startNext);return;}active=job;
  if(job.signal?.aborted){finish(job,new VideoDecodeError('VIDEO_ABORT'));return;}
  try{
   job.session=decoderSession(session,appRoot);const window=new BrowserWindow({show:false,width:32,height:32,skipTaskbar:true,webPreferences:{
    session:job.session,preload:path.join(appRoot,'video-decoder-preload.cjs'),additionalArguments:['--weiyue-video-channel='+channel],contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,backgroundThrottling:false,devTools:false,spellcheck:false}});
   job.window=window;const wc=window.webContents;wc.setWindowOpenHandler(()=>({action:'deny'}));wc.on('will-navigate',e=>e.preventDefault());wc.on('will-attach-webview',e=>e.preventDefault());
   wc.on('render-process-gone',()=>finish(job,new VideoDecodeError('VIDEO_DECODE')));window.on('closed',()=>finish(job,new VideoDecodeError('VIDEO_ABORT')));
   Promise.resolve(window.loadURL(PAGE)).catch(()=>finish(job,new VideoDecodeError('VIDEO_DECODE')));
  }catch{finish(job,new VideoDecodeError('VIDEO_DECODE'));}
 }
 const receive=(event,payload)=>{const job=active;if(!job||job.settled||!job.window||event.sender!==job.window.webContents||event.senderFrame!==event.sender.mainFrame||event.senderFrame?.url!==PAGE||!payload||typeof payload!=='object')return;
  if(payload.type==='ready'){if(job.sent)return;job.sent=true;try{event.sender.send(channel,{id:job.id,bytes:job.bytes});}catch{finish(job,new VideoDecodeError('VIDEO_DECODE'));}return;}
  if(!job.sent||payload.id!==job.id)return;
  if(payload.type==='error')finish(job,new VideoDecodeError(CODES.has(payload.code)?payload.code:'VIDEO_DECODE'));
  else if(payload.type==='result'){try{finish(job,null,webmResult(payload));}catch{finish(job,new VideoDecodeError('VIDEO_DECODE'));}}
 };
 ipcMain.on(channel,receive);
 function decode(value,{signal}={}){
  if(disposed||signal?.aborted)return Promise.reject(new VideoDecodeError('VIDEO_ABORT'));
  if(signal&&(typeof signal.addEventListener!=='function'||typeof signal.removeEventListener!=='function'))return Promise.reject(new VideoDecodeError('VIDEO_INVALID'));
  if(queue.length>=QUEUE_LIMIT)return Promise.reject(new VideoDecodeError('VIDEO_BUSY'));
  let bytes;try{if(!['video/mp4','video/quicktime'].includes(value?.mime))throw new VideoDecodeError('VIDEO_INVALID');bytes=exactBytes(value.bytes);if(!inspectHevcMp4(bytes))throw new VideoDecodeError('VIDEO_LIMIT');}catch(error){return Promise.reject(error);}
  return new Promise((resolve,reject)=>{const job={id:crypto.randomUUID(),bytes,signal,resolve,reject,settled:false};job.onAbort=()=>finish(job,new VideoDecodeError('VIDEO_ABORT'));
   job.timer=setTimeout(()=>finish(job,new VideoDecodeError('VIDEO_TIMEOUT')),timeoutMs);signal?.addEventListener('abort',job.onAbort,{once:true});queue.push(job);if(signal?.aborted)job.onAbort();else startNext();});
 }
 function close(){const all=[...queue];if(active)all.push(active);for(const job of all)finish(job,new VideoDecodeError('VIDEO_ABORT'));}
 return {decode,close,closeAll:close,dispose(){disposed=true;close();ipcMain.removeListener(channel,receive);}};
}
module.exports={createVideoDecoder,VideoDecodeError,inspectHevcMp4,exactBytes,webmResult,allowedResource,MAX_BYTES,MAX_OUTPUT_BYTES,MAX_SECONDS,MAX_EDGE,MAX_PIXELS,MAX_FRAMES,TIMEOUT_MS,QUEUE_LIMIT,PAGE,CSP};
