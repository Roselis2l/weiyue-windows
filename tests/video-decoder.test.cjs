'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),os=require('node:os'),crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const {createVideoDecoder,inspectHevcMp4,exactBytes,webmResult,allowedResource,MAX_BYTES,MAX_OUTPUT_BYTES,PAGE,CSP}=require('../app/core/video-decoder.cjs');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const box=(type,...parts)=>{const payload=Buffer.concat(parts),header=Buffer.alloc(8);header.writeUInt32BE(payload.length+8);header.write(type,4);return Buffer.concat([header,payload]);};
function mp4({codec='hvc1',width=1920,height=1080,seconds=2,frames=48,version=0}={}){
 const ftyp=box('ftyp',Buffer.from('mp42'),Buffer.alloc(4),Buffer.from('isommp42'));
 const mdhd=Buffer.alloc(version===1?32:24);mdhd[0]=version;mdhd.writeUInt32BE(120000,version===1?20:12);
 if(version===1)mdhd.writeBigUInt64BE(BigInt(Math.round(seconds*120000)),24);else mdhd.writeUInt32BE(Math.round(seconds*120000),16);
 const entry=Buffer.alloc(86);entry.writeUInt32BE(86);entry.write(codec,4);entry.writeUInt16BE(width,32);entry.writeUInt16BE(height,34);
 const stsdHeader=Buffer.alloc(8);stsdHeader.writeUInt32BE(1,4);const stts=Buffer.alloc(16);stts.writeUInt32BE(1,4);stts.writeUInt32BE(frames,8);stts.writeUInt32BE(Math.round(seconds*120000/Math.max(1,frames)),12);
 const hdlr=Buffer.alloc(24);hdlr.write('vide',8);
 return Buffer.concat([ftyp,box('moov',box('trak',box('mdia',box('mdhd',mdhd),box('hdlr',hdlr),box('minf',box('stbl',box('stsd',stsdHeader,entry),box('stts',stts))))))]);
}
const webm=()=>({bytes:Buffer.concat([Buffer.from([0x1a,0x45,0xdf,0xa3]),Buffer.alloc(20)]),mime:'video/webm'});
function harness({timeoutMs,appRoot=path.resolve('app')}={}){
 const windows=[],sessions=[],ipcMain=new EventEmitter();
 class Window extends EventEmitter{
  constructor(options){super();this.options=options;this.dead=false;this.webContents=new EventEmitter();this.webContents.mainFrame={url:PAGE};this.webContents.setWindowOpenHandler=fn=>{this.open=fn;};this.webContents.send=(channel,payload)=>{this.sent={channel,payload};};windows.push(this);}
  loadURL(url){this.url=url;return Promise.resolve();}isDestroyed(){return this.dead;}destroy(){this.dead=true;this.emit('closed');}
 }
 const session={fromPartition(name,options){const s=new EventEmitter();s.name=name;s.options=options;s.setPermissionRequestHandler=fn=>s.permission=fn;s.setPermissionCheckHandler=fn=>s.permissionCheck=fn;
  s.webRequest={onBeforeRequest:fn=>s.before=fn};s.protocol={handle:(_,fn)=>s.handler=fn};s.clearStorageData=()=>{s.cleared=(s.cleared||0)+1;return Promise.resolve();};sessions.push(s);return s;}};
 const service=createVideoDecoder({BrowserWindow:Window,ipcMain,session,appRoot,...(timeoutMs?{timeoutMs}:{})}),channel=ipcMain.eventNames()[0];
 const send=(w,p,event={})=>ipcMain.emit(channel,{sender:w.webContents,senderFrame:w.webContents.mainFrame,...event},p);
 const ready=(w=windows.at(-1))=>{send(w,{type:'ready'});return w.sent.payload;};
 const result=(w=windows.at(-1),value=webm())=>send(w,{type:'result',id:w.sent.payload.id,...value});
 return{windows,sessions,service,channel,ipcMain,send,ready,result};
}
test('HEVC admission uses structural video codec/dimensions/duration/frame count, not extension or embedded text',()=>{
 assert.deepEqual(inspectHevcMp4(mp4()),{codec:'hvc1',width:1920,height:1080,duration:2,frames:48});
 assert.equal(inspectHevcMp4(mp4({codec:'hev1',version:1})).codec,'hev1');
 for(const value of [Buffer.from('hvc1 mp42 private'),mp4({codec:'avc1'}),mp4({codec:'encv'}),mp4({codec:'av01'}),Buffer.concat([mp4(),box('moof')])])assert.equal(inspectHevcMp4(value),null);
});
test('conversion declines oversized, long, high-frame-count or invalid dimensions before any process is created',async()=>{
 for(const options of [{width:4097},{height:4097},{width:4096,height:4096},{width:0},{seconds:30.001},{seconds:0},{frames:1801},{frames:0},{seconds:.1,frames:48}])assert.equal(inspectHevcMp4(mp4(options)),null);
 assert.ok(inspectHevcMp4(mp4({seconds:30,frames:1800,width:4096,height:2160})));
 const h=harness();for(const value of [{bytes:mp4(),mime:'image/jpeg'},{bytes:mp4({codec:'avc1'}),mime:'video/mp4'},{bytes:Buffer.alloc(MAX_BYTES+1),mime:'video/mp4'}])await assert.rejects(h.service.decode(value));
 assert.equal(h.windows.length,0);h.service.dispose();
});
test('MP4 box length, extended size, nesting, track ambiguity and truncated metadata are bounded',()=>{
 const tooLong=mp4();tooLong.writeUInt32BE(tooLong.length+1,24);assert.equal(inspectHevcMp4(tooLong),null);
 for(let n=0;n<mp4().length;n+=7)assert.equal(inspectHevcMp4(mp4().subarray(0,n)),null);
 const ambiguous=Buffer.concat([mp4(),mp4().subarray(24)]);assert.equal(inspectHevcMp4(ambiguous),null);
 let nested=box('stbl');for(let i=0;i<10;i++)nested=box('moov',nested);assert.equal(inspectHevcMp4(Buffer.concat([mp4(),nested])),null);
});
test('QuickTime Live Photo allows auxiliary tracks and distinguishes mdia media handler from minf data handler',()=>{
 const base=mp4();base.write('qt  ',8);base.write('qt  ',16);
 const track=base.subarray(32); // first trak, excluding ftyp and moov headers
 const multiple=Buffer.concat([base.subarray(0,24),box('moov',track,track)]);
 assert.equal(inspectHevcMp4(multiple)?.width,1920);
 const alis=Buffer.alloc(24);alis.write('alis',8);
 const alias=box('hdlr',alis),at=base.indexOf(Buffer.from('stbl'))-4;
 const qt=Buffer.concat([base.subarray(0,at),alias,base.subarray(at)]);
 for(const type of ['moov','trak','mdia','minf']){const pos=qt.indexOf(Buffer.from(type))-4;qt.writeUInt32BE(qt.readUInt32BE(pos)+alias.length,pos);}
 assert.equal(inspectHevcMp4(qt)?.frames,48);
 const tooMany=Buffer.concat([base.subarray(0,24),box('moov',...Array(17).fill(track))]);assert.equal(inspectHevcMp4(tooMany),null);
 const encrypted=Buffer.from(track);encrypted.write('encv',encrypted.indexOf(Buffer.from('hvc1')));
 assert.equal(inspectHevcMp4(Buffer.concat([base.subarray(0,24),box('moov',track,encrypted)])),null);
});
test('QuickTime audio sample counts are independent of video frame bounds',()=>{
 const base=mp4();base.write('qt  ',8);base.write('qt  ',16);const audio=mp4({seconds:2,frames:96000,codec:'lpcm'}).subarray(32);audio.write('soun',audio.indexOf(Buffer.from('vide')));
 const value=Buffer.concat([base.subarray(0,24),box('moov',base.subarray(32),audio)]);assert.equal(inspectHevcMp4(value)?.frames,48);
});
test('exact byte views and result MIME/signature/size checks reject spoofed values',()=>{
 const wrapped=Buffer.from([9,1,2,8]);assert.deepEqual(exactBytes(wrapped.subarray(1,3)),Buffer.from([1,2]));
 for(const input of ['private',[],new Uint16Array([1]),Object.create(Uint8Array.prototype)])assert.throws(()=>exactBytes(input));
 assert.equal(webmResult(webm()).kind,'video');
 for(const output of [{...webm(),mime:'video/mp4'},{...webm(),bytes:Buffer.alloc(24)},{...webm(),bytes:Buffer.alloc(MAX_OUTPUT_BYTES+1)}])assert.throws(()=>webmResult(output));
});
test('video handler counts unknown codecs, and sample timing cannot contradict the duration declaration',()=>{
 const unknown=mp4({codec:'mp4v',width:65535,height:65535});
 assert.equal(inspectHevcMp4(Buffer.concat([unknown,mp4().subarray(24)])),null);
 const noHandler=mp4();noHandler.write('soun',noHandler.indexOf(Buffer.from('vide')));assert.equal(inspectHevcMp4(noHandler),null);
 const forged=mp4({seconds:1,frames:1}),stts=forged.indexOf(Buffer.from('stts'));forged.writeUInt32BE(120*120000,stts+16);
 assert.equal(inspectHevcMp4(forged),null);
 const noSamples=mp4();noSamples.writeUInt32BE(0,noSamples.indexOf(Buffer.from('stts'))+16);assert.equal(inspectHevcMp4(noSamples),null);
});
test('decoder command enforces decode pixels, allocation, duration, output frames and an independent execution timeout',()=>{
 const source=fs.readFileSync(path.resolve('app/decoder/video-worker.js'),'utf8');
 for(const flag of ["'-max_pixels','12000000'","'-max_alloc','67108864'","'-frames:v','720'","'-t','30'",'core.setTimeout(110000)',"'-c:a','libvorbis'"])assert.ok(source.includes(flag));
 assert.ok(!source.includes("'-c:a','libopus'"));
});
test('fixed decoder-only resource routes allow WASM but deny general script eval and every remote route',()=>{
 for(const url of [PAGE,'app://video-decoder/video-worker.js','app://video-decoder/ffmpeg/ffmpeg-core.wasm'])assert.equal(allowedResource(url),true);
 for(const url of ['https://example.invalid/a','file:///C:/private',PAGE+'?x=1',PAGE+'#x','app://video-decoder/ffmpeg/assets.json','app://local/index.html','app://user@video-decoder/video.html'])assert.equal(allowedResource(url),false);
 assert.ok(CSP.includes("'wasm-unsafe-eval'"));assert.ok(!CSP.includes("'unsafe-eval'"));
});
test('conversion creates an isolated ephemeral sandbox that denies downloads and permissions',async()=>{
 const h=harness(),promise=h.service.decode({bytes:mp4(),mime:'video/mp4'}),w=h.windows[0],s=h.sessions[0];
 assert.ok(!s.name.startsWith('persist:'));assert.equal(w.options.show,false);assert.equal(w.options.webPreferences.sandbox,true);assert.equal(w.options.webPreferences.nodeIntegration,false);assert.equal(w.options.webPreferences.contextIsolation,true);
 assert.equal(s.permissionCheck(),false);let allowed;s.permission(null,'camera',v=>allowed=v);assert.equal(allowed,false);let canceled;s.before({url:'https://example.invalid'},v=>canceled=v.cancel);assert.equal(canceled,true);
 let stopped=false;s.emit('will-download',{preventDefault(){stopped=true;}});assert.equal(stopped,true);
 h.ready();h.result();await promise;assert.equal(w.dead,true);assert.equal(s.cleared,1);h.service.dispose();
});
test('only the exact decoder main frame and job ID may receive bytes or complete work',async()=>{
 const h=harness(),promise=h.service.decode({bytes:mp4(),mime:'video/mp4'}),w=h.windows[0];
 h.send(w,{type:'ready'},{senderFrame:{url:PAGE}});assert.equal(w.sent,undefined);h.ready();const sent=w.sent;h.ready();assert.equal(w.sent,sent);
 h.send(w,{type:'result',id:'wrong',...webm()});assert.equal(w.dead,false);h.result();await promise;h.service.dispose();
});
test('one active plus one waiting conversion is the maximum; later jobs do not retain input buffers',async()=>{
 const h=harness(),a=h.service.decode({bytes:mp4(),mime:'video/mp4'}),b=h.service.decode({bytes:mp4(),mime:'video/mp4'});
 await assert.rejects(h.service.decode({bytes:mp4(),mime:'video/mp4'}),{code:'VIDEO_BUSY'});assert.equal(h.windows.length,1);
 h.ready();h.result();await a;await tick();assert.equal(h.windows.length,2);assert.equal(h.sessions.length,1);h.ready();h.result();await b;h.service.dispose();
});
test('abort and account close terminate active/queued windows and reject late output',async()=>{
 const h=harness(),abort=new AbortController(),a=h.service.decode({bytes:mp4(),mime:'video/mp4'},{signal:abort.signal}),b=h.service.decode({bytes:mp4(),mime:'video/mp4'});
 const rejected=[assert.rejects(a,{code:'VIDEO_ABORT'}),assert.rejects(b,{code:'VIDEO_ABORT'})];h.ready();abort.abort();h.service.close();await Promise.all(rejected);await tick();assert.equal(h.windows.length,1);assert.equal(h.windows[0].dead,true);
 const c=h.service.decode({bytes:mp4(),mime:'video/mp4'});h.ready();h.result();await c;h.service.dispose();await assert.rejects(h.service.decode({bytes:mp4(),mime:'video/mp4'}),{code:'VIDEO_ABORT'});assert.equal(h.ipcMain.listenerCount(h.channel),0);
});
test('absolute timeout bounds even a worker that never replies',async()=>{
 const h=harness({timeoutMs:10}),promise=h.service.decode({bytes:mp4(),mime:'video/mp4'});await assert.rejects(promise,{code:'VIDEO_TIMEOUT'});assert.equal(h.windows[0].dead,true);h.service.dispose();
});
test('wrong output and worker-provided private errors return fixed messages only',async()=>{
 for(const payload of [{type:'result',mime:'text/html',bytes:Buffer.from('private')},{type:'error',code:'private secret https://example.invalid'}]){
  const h=harness(),promise=h.service.decode({bytes:mp4(),mime:'video/mp4'}),w=h.windows[0];const data=h.ready();h.send(w,{id:data.id,...payload});await assert.rejects(promise,e=>e.code==='VIDEO_DECODE'&&!/private|secret|https:/.test(e.message));h.service.dispose();
 }
});
test('decoder assets require manifest size and SHA256 match before being served',async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'weiyue-video-assets-'));const assets=path.join(temp,'decoder','ffmpeg');fs.mkdirSync(assets,{recursive:true});
 const bytes=Buffer.from('local test module');fs.writeFileSync(path.join(assets,'ffmpeg-core.js'),bytes);fs.writeFileSync(path.join(assets,'assets.json'),JSON.stringify({files:[{path:'ffmpeg-core.js',bytes:bytes.length,sha256:'0'.repeat(64)}]}));
 const h=harness({appRoot:temp}),promise=h.service.decode({bytes:mp4(),mime:'video/mp4'});const handler=h.sessions[0].handler;
 assert.equal((await handler({url:'app://video-decoder/ffmpeg/ffmpeg-core.js',method:'GET'})).status,404);
 fs.writeFileSync(path.join(assets,'assets.json'),JSON.stringify({files:[{path:'ffmpeg-core.js',bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')}]}));
 const good=await handler({url:'app://video-decoder/ffmpeg/ffmpeg-core.js',method:'GET'});assert.equal(good.status,200);assert.equal(await good.text(),bytes.toString());
 assert.equal((await handler({url:PAGE,method:'POST'})).status,404);const rejected=assert.rejects(promise,{code:'VIDEO_ABORT'});h.service.dispose();await rejected;
 assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(temp,{recursive:true,force:true});
});
module.exports={mp4};
