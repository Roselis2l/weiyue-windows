'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),os=require('node:os'),crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const {createAudioDecoder,inspectAmr,exactBytes,wavResult,allowedResource,MAX_BYTES,MAX_OUTPUT_BYTES,PAGE,CSP}=require('../app/core/audio-decoder.cjs');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function amr({wide=false,frames=50,type=wide?0:7,payloadBytes=wide?17:31}={}){return Buffer.concat([Buffer.from(wide?'#!AMR-WB\n':'#!AMR\n'),...Array.from({length:frames},()=>Buffer.concat([Buffer.from([(type<<3)|4]),Buffer.alloc(payloadBytes)]))]);}
function wav(){const b=Buffer.alloc(364);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);return {bytes:b,mime:'audio/wav'};}
function harness({timeoutMs,appRoot=path.resolve('app')}={}){
 const windows=[],sessions=[],ipcMain=new EventEmitter();
 class Window extends EventEmitter{
  constructor(options){super();this.options=options;this.dead=false;this.webContents=new EventEmitter();this.webContents.mainFrame={url:PAGE};this.webContents.setWindowOpenHandler=fn=>{this.open=fn;};this.webContents.send=(channel,payload)=>{this.sent={channel,payload};};windows.push(this);}
  loadURL(url){this.url=url;return Promise.resolve();}isDestroyed(){return this.dead;}destroy(){this.dead=true;this.emit('closed');}
 }
 const session={fromPartition(name,options){const s=new EventEmitter();s.name=name;s.options=options;s.setPermissionRequestHandler=fn=>s.permission=fn;s.setPermissionCheckHandler=fn=>s.permissionCheck=fn;
  s.webRequest={onBeforeRequest:fn=>s.before=fn};s.protocol={handle:(_,fn)=>s.handler=fn};s.clearStorageData=()=>{s.cleared=(s.cleared||0)+1;return Promise.resolve();};sessions.push(s);return s;}};
 const service=createAudioDecoder({BrowserWindow:Window,ipcMain,session,appRoot,...(timeoutMs?{timeoutMs}:{})}),channel=ipcMain.eventNames()[0];
 const send=(w,p,event={})=>ipcMain.emit(channel,{sender:w.webContents,senderFrame:w.webContents.mainFrame,...event},p);
 const ready=(w=windows.at(-1))=>{send(w,{type:'ready'});return w.sent.payload;};
 const result=(w=windows.at(-1),value=wav())=>send(w,{type:'result',id:w.sent.payload.id,...value});
 return{windows,sessions,service,channel,ipcMain,send,ready,result};
}
test('AMR NB/WB consumes exact frames and derives duration with a five-minute limit',()=>{
 assert.deepEqual(inspectAmr(amr()),{codec:'amr_nb',duration:1,frames:50,channels:1,sampleRate:8000});
 assert.equal(inspectAmr(amr({wide:true})).codec,'amr_wb');
 // RFC 4867 §5.3: receive-side padding bits MUST be ignored.
 const padding=amr({frames:1});padding[6]|=0x83;assert.equal(inspectAmr(padding).frames,1);
 assert.equal(inspectAmr(amr({frames:15000})).duration,300);
 for(const b of [amr({frames:15001}),amr({frames:0}),amr({type:9}),amr({wide:true,type:10}),amr().subarray(0,-1),Buffer.concat([Buffer.from('prefix'),amr()]),Buffer.alloc(MAX_BYTES+1)])assert.equal(inspectAmr(b),null);
});
test('malformed AMR and MIME reject without creating a sandbox',async()=>{
 const h=harness();for(const value of [{bytes:amr(),mime:'video/mp4'},{bytes:Buffer.from('#!AMR\n'),mime:'audio/amr'},{bytes:amr({type:12}),mime:'audio/amr'}])await assert.rejects(h.service.decode(value));assert.equal(h.windows.length,0);h.service.dispose();
});
test('PCM output is fixed-rate mono and validates every RIFF boundary',()=>{
 assert.equal(wavResult(wav()).kind,'audio');const bad=[];for(const [offset,value,size] of [[4,20,4],[22,2,2],[24,48000,4],[32,4,2],[34,24,2],[40,321,4]]){const b=Buffer.from(wav().bytes);size===2?b.writeUInt16LE(value,offset):b.writeUInt32LE(value,offset);bad.push(b);}for(const bytes of bad)assert.throws(()=>wavResult({bytes,mime:'audio/wav'}));assert.throws(()=>wavResult({...wav(),mime:'audio/amr'}));
});
test('worker and CSP bound audio-only file conversion and avoid remote resources',()=>{
 const source=fs.readFileSync(path.resolve('app/decoder/audio-worker.js'),'utf8');for(const text of ["'-protocol_whitelist','file'","'-map','0:a:0'","'-vn','-sn','-dn'","'-t','300'","'-ac','1','-ar','16000'",'core.setTimeout(110000)'])assert(source.includes(text));
 assert(allowedResource(PAGE));assert(allowedResource('app://audio-decoder/audio-worker.js'));assert(!allowedResource('https://example.invalid/private'));assert(!allowedResource('app://audio-decoder/../../secret'));assert(CSP.includes("'wasm-unsafe-eval'"));assert(!CSP.includes("'unsafe-eval'"));
});
test('conversion creates an isolated ephemeral sandbox that denies downloads and permissions',async()=>{
 const h=harness(),promise=h.service.decode({bytes:amr(),mime:'audio/amr'}),w=h.windows[0],s=h.sessions[0];
 assert.ok(!s.name.startsWith('persist:'));assert.equal(w.options.show,false);assert.equal(w.options.webPreferences.sandbox,true);assert.equal(w.options.webPreferences.nodeIntegration,false);assert.equal(w.options.webPreferences.contextIsolation,true);
 assert.equal(s.permissionCheck(),false);let allowed;s.permission(null,'camera',v=>allowed=v);assert.equal(allowed,false);let canceled;s.before({url:'https://example.invalid'},v=>canceled=v.cancel);assert.equal(canceled,true);
 let stopped=false;s.emit('will-download',{preventDefault(){stopped=true;}});assert.equal(stopped,true);
 h.ready();h.result();await promise;assert.equal(w.dead,true);assert.equal(s.cleared,1);h.service.dispose();
});
test('only the exact decoder main frame and job ID may receive bytes or complete work',async()=>{
 const h=harness(),promise=h.service.decode({bytes:amr(),mime:'audio/amr'}),w=h.windows[0];
 h.send(w,{type:'ready'},{senderFrame:{url:PAGE}});assert.equal(w.sent,undefined);h.ready();const sent=w.sent;h.ready();assert.equal(w.sent,sent);
 h.send(w,{type:'result',id:'wrong',...wav()});assert.equal(w.dead,false);h.result();await promise;h.service.dispose();
});
test('one active plus one waiting conversion is the maximum; later jobs do not retain input buffers',async()=>{
 const h=harness(),a=h.service.decode({bytes:amr(),mime:'audio/amr'}),b=h.service.decode({bytes:amr(),mime:'audio/amr'});
 await assert.rejects(h.service.decode({bytes:amr(),mime:'audio/amr'}),{code:'AUDIO_BUSY'});assert.equal(h.windows.length,1);
 h.ready();h.result();await a;await tick();assert.equal(h.windows.length,2);assert.equal(h.sessions.length,1);h.ready();h.result();await b;h.service.dispose();
});
test('abort and account close terminate active/queued windows and reject late output',async()=>{
 const h=harness(),abort=new AbortController(),a=h.service.decode({bytes:amr(),mime:'audio/amr'},{signal:abort.signal}),b=h.service.decode({bytes:amr(),mime:'audio/amr'});
 const rejected=[assert.rejects(a,{code:'AUDIO_ABORT'}),assert.rejects(b,{code:'AUDIO_ABORT'})];h.ready();abort.abort();h.service.close();await Promise.all(rejected);await tick();assert.equal(h.windows.length,1);assert.equal(h.windows[0].dead,true);
 const c=h.service.decode({bytes:amr(),mime:'audio/amr'});h.ready();h.result();await c;h.service.dispose();await assert.rejects(h.service.decode({bytes:amr(),mime:'audio/amr'}),{code:'AUDIO_ABORT'});assert.equal(h.ipcMain.listenerCount(h.channel),0);
});
test('absolute timeout bounds even a worker that never replies',async()=>{
 const h=harness({timeoutMs:10}),promise=h.service.decode({bytes:amr(),mime:'audio/amr'});await assert.rejects(promise,{code:'AUDIO_TIMEOUT'});assert.equal(h.windows[0].dead,true);h.service.dispose();
});
test('wrong output and worker-provided private errors return fixed messages only',async()=>{
 for(const payload of [{type:'result',mime:'text/html',bytes:Buffer.from('private')},{type:'error',code:'private secret https://example.invalid'}]){
  const h=harness(),promise=h.service.decode({bytes:amr(),mime:'audio/amr'}),w=h.windows[0];const data=h.ready();h.send(w,{id:data.id,...payload});await assert.rejects(promise,e=>e.code==='AUDIO_DECODE'&&!/private|secret|https:/.test(e.message));h.service.dispose();
 }
});
test('decoder assets require manifest size and SHA256 match before being served',async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'weiyue-audio-assets-'));const assets=path.join(temp,'decoder','ffmpeg');fs.mkdirSync(assets,{recursive:true});
 const bytes=Buffer.from('local test module');fs.writeFileSync(path.join(assets,'ffmpeg-core.js'),bytes);fs.writeFileSync(path.join(assets,'assets.json'),JSON.stringify({files:[{path:'ffmpeg-core.js',bytes:bytes.length,sha256:'0'.repeat(64)}]}));
 const h=harness({appRoot:temp}),promise=h.service.decode({bytes:amr(),mime:'audio/amr'});const handler=h.sessions[0].handler;
 assert.equal((await handler({url:'app://audio-decoder/ffmpeg/ffmpeg-core.js',method:'GET'})).status,404);
 fs.writeFileSync(path.join(assets,'assets.json'),JSON.stringify({files:[{path:'ffmpeg-core.js',bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')}]}));
 const good=await handler({url:'app://audio-decoder/ffmpeg/ffmpeg-core.js',method:'GET'});assert.equal(good.status,200);assert.equal(await good.text(),bytes.toString());
 assert.equal((await handler({url:PAGE,method:'POST'})).status,404);const rejected=assert.rejects(promise,{code:'AUDIO_ABORT'});h.service.dispose();await rejected;
 assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(temp,{recursive:true,force:true});
});
