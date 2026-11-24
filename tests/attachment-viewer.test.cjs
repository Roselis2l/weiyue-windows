'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const path=require('node:path');
const fs=require('node:fs');
const {createAttachmentViewer,normalizeSource,validateAttachment,safeName,VIEWER_URL,CHANNEL,LIMITS,ERRORS}=require('../app/core/attachment-viewer.cjs');
const source='app://attachment/'+'a'.repeat(32)+'/group/123/0';
const pdf=Buffer.from('%PDF-1.7\nsynthetic bytes\n%%EOF');
function mp4(){const bytes=Buffer.alloc(24);bytes.writeUInt32BE(24);bytes.write('ftyp',4);bytes.write('mp42',8);bytes.write('isom',16);bytes.write('mp42',20);return bytes;}
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {resolve,promise};};
function fixture(options={}){
  const windows=[],handlers=new Map(),writes=[],dialogs=[];let owner='one|1',reads=0;
  class Window extends EventEmitter{
    constructor(config){super();this.config=config;this.destroyed=false;this.wc=new EventEmitter();this.wc.mainFrame={url:VIEWER_URL};this.wc.setWindowOpenHandler=h=>{this.openHandler=h;};windows.push(this);}
    get webContents(){return this.wc;}isDestroyed(){return this.destroyed;}isMinimized(){return false;}restore(){}focus(){this.focused=true;}
    async loadURL(url){this.url=url;}show(){this.shown=true;}close(){if(!this.destroyed){this.destroyed=true;this.emit('closed');}}
    isMaximized(){return !!this.maximized;}maximize(){this.maximized=true;}unmaximize(){this.maximized=false;}minimize(){this.minimized=true;}
  }
  const manager=createAttachmentViewer({BrowserWindow:Window,ipcMain:{handle:(c,h)=>handlers.set(c,h),removeHandler:c=>handlers.delete(c)},
    appRoot:path.resolve(__dirname,'../app'),getOwner:()=>owner,getSourceIdentity:options.identity,readTimeoutMs:options.timeout||120000,decodeVideo:options.decodeVideo,
    readAttachment:(src,opts)=>{reads++;return options.read?options.read(src,opts):{bytes:pdf,mime:'application/pdf',kind:'pdf',name:'test.pdf'};},
    dialog:{showSaveDialog:async(w,config)=>{dialogs.push(config);return options.dialog?options.dialog():{canceled:true};}},
    writeFile:async(file,bytes)=>writes.push({file,bytes:Buffer.from(bytes)})});
  return {manager,windows,handlers,writes,dialogs,reads:()=>reads,setOwner:v=>{owner=v;},
    call:(action,event)=>handlers.get(CHANNEL)(event||{sender:windows.at(-1).wc,senderFrame:windows.at(-1).wc.mainFrame},action)};
}
test('attachment source is limited to canonical account-bound app routes',()=>{
  assert.equal(normalizeSource(source),source);
  for(const bad of ['https://example.com/a.pdf','file:///C:/private.pdf','data:application/pdf,AA',source+'?url=x',source+'#x',
    source.replace('attachment','local'),source.replace('/0','/1000'),source.replace('/group','/%00'),source.replace('app://','app://user@')]){
    assert.equal(normalizeSource(bad),null,bad);
  }
});
test('attachment bytes, declared kind and MIME must agree; active formats are rejected',()=>{
  assert.deepEqual(validateAttachment({bytes:pdf,mime:'application/pdf',kind:'pdf',name:'x.pdf'}).bytes,pdf);
  assert.equal(validateAttachment({bytes:mp4(),mime:'video/mp4',kind:'video',name:'x.mp4'}).kind,'video');
  for(const value of [
    {bytes:pdf,mime:'application/pdf',kind:'video'},
    {bytes:pdf,mime:'video/mp4',kind:'video'},
    {bytes:Buffer.from('<html>login</html>'),mime:'application/pdf',kind:'pdf'},
    {bytes:new Uint8Array(pdf),mime:'application/pdf',kind:'pdf'},
    {bytes:Buffer.alloc(LIMITS.pdf+1),mime:'application/pdf',kind:'pdf'},
    {bytes:mp4(),mime:'text/html',kind:'video'},
  ])assert.throws(()=>validateAttachment(value),new RegExp(ERRORS.content));
  assert.throws(()=>validateAttachment({bytes:pdf,mime:'application/pdf',kind:'pdf'},'video'));
});
test('MP4 ftyp bounds and brands are checked before video rendering',()=>{
  const value=mp4();value.writeUInt32BE(4097);assert.throws(()=>validateAttachment({bytes:value,mime:'video/mp4',kind:'video'}));
  const heic=mp4();heic.write('heic',8);heic.write('mif1',16);heic.write('heic',20);
  assert.throws(()=>validateAttachment({bytes:heic,mime:'video/mp4',kind:'video'}));
});
test('filename suggestions cannot escape directories or disguise MIME',()=>{
  assert.equal(safeName('../../evil.exe','application/pdf'),'.._.._evil.pdf');
  assert.equal(safeName('CON','video/mp4'),'微阅附件.mp4');
  assert.equal(safeName('报告.pdf','application/pdf'),'报告.pdf');
  assert.equal(safeName('video.M4V','video/mp4'),'video.M4V');
});
test('opens an isolated sandboxed window and returns local bytes only',async()=>{
  const f=fixture();await f.manager.open({source,kind:'pdf',title:'<script>test</script>'});
  const w=f.windows[0];assert.equal(w.shown,true);assert.equal(w.url,VIEWER_URL);
  assert.equal(w.config.webPreferences.sandbox,true);assert.equal(w.config.webPreferences.contextIsolation,true);
  assert.equal(w.config.webPreferences.nodeIntegration,false);assert.equal(w.config.webPreferences.webSecurity,true);
  assert.deepEqual(w.openHandler(),{action:'deny'});
  let prevented=0;w.wc.emit('will-navigate',{preventDefault:()=>prevented++});w.wc.emit('will-attach-webview',{preventDefault:()=>prevented++});
  assert.equal(prevented,2);
  const result=await f.call('load');assert.equal(result.ok,true);assert.deepEqual(Buffer.from(result.value.bytes),pdf);
  assert.equal(result.value.title,'<script>test</script>');assert.equal('source' in result.value,false);
  f.manager.dispose();
});
test('duplicate opens reuse a valid window and different sources close the prior one',async()=>{
  const f=fixture();await f.manager.open({source,kind:'pdf'});await f.manager.open({source,kind:'pdf'});
  assert.equal(f.windows.length,1);assert.equal(f.windows[0].focused,true);
  await f.manager.open({source:source.replace('/123/','/124/'),kind:'pdf'});
  assert.equal(f.windows.length,2);assert.equal(f.windows[0].destroyed,true);f.manager.dispose();
});
test('untrusted sender, frame or document is rejected before reading data',async()=>{
  const f=fixture();await f.manager.open({source,kind:'pdf'});
  assert.equal((await f.call('load',{sender:{},senderFrame:{}})).error,ERRORS.sender);
  assert.equal((await f.call('load',{sender:f.windows[0].wc,senderFrame:{url:VIEWER_URL}})).error,ERRORS.sender);
  f.windows[0].wc.mainFrame.url='https://example.com';assert.equal((await f.call('load')).error,ERRORS.sender);
  assert.equal(f.reads(),0);f.manager.dispose();
});
test('account change invalidates load and save without revealing old content',async()=>{
  const f=fixture();await f.manager.open({source,kind:'pdf'});f.setOwner('two|2');
  assert.equal((await f.call('load')).error,ERRORS.expired);assert.equal(f.reads(),0);f.manager.dispose();
});
test('concurrent loads share one read; close aborts and rejects late delivery',async()=>{
  const gate=deferred();let signal;
  const f=fixture({read:(_s,o)=>{signal=o.signal;return gate.promise;}});await f.manager.open({source,kind:'pdf'});
  const a=f.call('load'),b=f.call('load');await Promise.resolve();assert.equal(f.reads(),1);
  f.manager.closeAll();assert.equal(signal.aborted,true);gate.resolve({bytes:pdf,mime:'application/pdf',kind:'pdf'});
  assert.equal((await a).error,ERRORS.expired);assert.equal((await b).error,ERRORS.expired);f.manager.dispose();
});
test('hanging attachment reads timeout with fixed errors and abort the transport',async()=>{
  let signal;const f=fixture({timeout:10,read:(_s,o)=>{signal=o.signal;return new Promise(()=>{});}});
  await f.manager.open({source,kind:'pdf'});assert.equal((await f.call('load')).error,ERRORS.timeout);
  assert.equal(signal.aborted,true);f.manager.dispose();
});
test('manual retry after failure does not expose transport details',async()=>{
  let fail=true;const f=fixture({read:()=>{if(fail){fail=false;throw new Error('Cookie secret private URL');}return {bytes:pdf,mime:'application/pdf',kind:'pdf'};}});
  await f.manager.open({source,kind:'pdf'});assert.equal((await f.call('load')).error,ERRORS.content);
  assert.equal((await f.call('retry')).ok,true);assert.equal(f.reads(),2);f.manager.dispose();
});
test('unresolved file kind accepts only validated PDF/video after metadata resolves',async()=>{
  const f=fixture();await f.manager.open({source,kind:'file'});assert.equal((await f.call('load')).value.kind,'pdf');f.manager.dispose();
});
test('known transport errors preserve fixed actionable messages without upstream details',async()=>{
  for(const [code,phrase] of [['ATTACHMENT_DENIED','拒绝'],['ATTACHMENT_AUTH','登录'],['ATTACHMENT_TOO_LARGE','大小限制'],['ATTACHMENT_TYPE','格式暂不支持']]){
    const f=fixture({read:()=>{throw Object.assign(new Error('Cookie secret private URL'),{code});}});
    await f.manager.open({source,kind:'file'});const result=await f.call('load');
    assert.equal(result.ok,false);assert.match(result.error,new RegExp(phrase));assert.doesNotMatch(result.error,/Cookie|secret|private/);f.manager.dispose();
  }
});
test('save keeps original bytes, confirms replacement through native dialog and enforces extension',async()=>{
  let filename=path.resolve('artifacts/synthetic-attachment.pdf');
  const f=fixture({dialog:()=>({canceled:false,filePath:filename})});await f.manager.open({source,kind:'pdf'});await f.call('load');
  assert.equal((await f.call('save')).value.saved,true);assert.deepEqual(f.writes[0].bytes,pdf);
  assert.equal(f.dialogs[0].properties.includes('showOverwriteConfirmation'),true);
  filename=path.resolve('artifacts/synthetic-attachment.exe');
  assert.equal((await f.call('save')).error,ERRORS.extension);assert.equal(f.writes.length,1);f.manager.dispose();
});
test('cancelled save writes nothing and owner change during dialog blocks writing',async()=>{
  const first=fixture();await first.manager.open({source,kind:'pdf'});await first.call('load');
  assert.deepEqual((await first.call('save')).value,{canceled:true});assert.equal(first.writes.length,0);first.manager.dispose();
  const gate=deferred(),f=fixture({dialog:()=>gate.promise});await f.manager.open({source,kind:'pdf'});await f.call('load');
  const saving=f.call('save');f.setOwner('two|2');gate.resolve({canceled:false,filePath:path.resolve('old.pdf')});
  assert.equal((await saving).error,ERRORS.expired);assert.equal(f.writes.length,0);f.manager.dispose();
});
test('viewer never instantiates PDF activities or enables automatic video playback',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../app/renderer/attachment-viewer.js'),'utf8');
  assert.match(source,/isEvalSupported:false/);assert.match(source,/enableXfa:false/);assert.match(source,/annotationMode:0/);
  assert.match(source,/video\.autoplay=false/);assert.doesNotMatch(source,/getJSActions|PDFScriptingManager|AnnotationLayer|innerHTML/);
  const html=fs.readFileSync(path.join(__dirname,'../app/renderer/attachment-viewer.html'),'utf8');
  assert.match(html,/object-src 'none'/);assert.match(html,/frame-src 'none'/);assert.doesNotMatch(html,/unsafe-eval|unsafe-inline/);
});


test('stable attachment identity survives unrelated content refresh and metadata resolution',async()=>{
 let identity='fid:123'; const f=fixture({identity:()=>identity});await f.manager.open({source,kind:'file'});
 assert.equal((await f.call('load')).ok,true); f.manager.closeInvalid();
 assert.equal(f.windows[0].destroyed,false);assert.equal((await f.call('load')).ok,true); assert.equal(f.reads(),1);f.manager.dispose();
});
test('source deletion or replacement invalidates cached attachment and closes only invalid window',async()=>{
 for(const next of [null,'fid:456']){let identity='fid:123';const f=fixture({identity:()=>identity});await f.manager.open({source,kind:'pdf'});await f.call('load');identity=next;
 assert.equal((await f.call('save')).error,ERRORS.expired);f.manager.closeInvalid();assert.equal(f.windows[0].destroyed,true);assert.equal(f.writes.length,0);f.manager.dispose();}
});
test('account epoch change closes attachment even when source identity matches',async()=>{
 const f=fixture({identity:()=> 'fid:123'});await f.manager.open({source,kind:'pdf'});f.setOwner('two|2');f.manager.closeInvalid();assert.equal(f.windows[0].destroyed,true);f.manager.dispose();
});
test('source invalidation aborts pending read and rejects late bytes',async()=>{
 let identity='fid:123',signal;const gate=deferred();const f=fixture({identity:()=>identity,read:(_s,o)=>{signal=o.signal;return gate.promise;}});await f.manager.open({source,kind:'pdf'});const result=f.call('load');await Promise.resolve();identity=null;f.manager.closeInvalid();assert.equal(signal.aborted,true);gate.resolve({bytes:pdf,mime:'application/pdf',kind:'pdf'});assert.equal((await result).error,ERRORS.expired);f.manager.dispose();
});
test('attachment main lifecycle binds ownership to account and validates visible source identity',()=>{
 const main=fs.readFileSync(path.join(__dirname,'../app/main.cjs'),'utf8');
 assert.ok(main.includes("getOwner:()=>activeId+'|'+accountEpoch,getSourceIdentity:attachmentIdentity"));
 assert.ok(main.includes('epoch!==accountEpoch||closing()'));
 assert.ok(main.includes('attachmentViewer?.closeInvalid()'));
 assert.ok(main.includes('avatars.clear();imageViewer?.closeAll();attachmentViewer?.closeAll()'));
 assert.ok(main.includes('store.getVisibleSnapshot(activeId).messages.find'));
});

function longHevcFixture(seconds=120){
 const box=(type,...chunks)=>{const data=Buffer.concat(chunks),header=Buffer.alloc(8);header.writeUInt32BE(data.length+8);header.write(type,4);return Buffer.concat([header,data]);};
 const ftyp=box('ftyp',Buffer.from('mp42'),Buffer.alloc(4),Buffer.from('isommp42'));
 const mdhd=Buffer.alloc(24);mdhd.writeUInt32BE(1000,12);mdhd.writeUInt32BE(Math.round(seconds*1000),16);
 const entry=Buffer.alloc(86);entry.writeUInt32BE(86);entry.write('hvc1',4);entry.writeUInt16BE(640,32);entry.writeUInt16BE(360,34);
 const stsd=Buffer.alloc(8);stsd.writeUInt32BE(1,4);const stts=Buffer.alloc(16);stts.writeUInt32BE(1,4);stts.writeUInt32BE(1,8);stts.writeUInt32BE(Math.round(seconds*1000),12);const hdlr=Buffer.alloc(24);hdlr.write('vide',8);
 return Buffer.concat([ftyp,box('moov',box('trak',box('mdia',box('mdhd',mdhd),box('hdlr',hdlr),box('minf',box('stbl',box('stsd',stsd,entry),box('stts',stts))))))]);
}
const longValue=(seconds=120)=>({bytes:longHevcFixture(seconds),kind:'video',mime:'video/mp4',name:'synthetic.mp4'});
const longResult=()=>({bytes:Buffer.concat([Buffer.from([0x1a,0x45,0xdf,0xa3]),Buffer.alloc(20)]),kind:'video',mime:'video/webm',expectedDuration:120,extended:true});
test('long HEVC needs distinct explicit action and save still receives complete original bytes',async()=>{
 let calls=0,options;const original=longValue();const f=fixture({read:()=>original,decodeVideo:async(v,o)=>{calls++;options=o;assert.deepEqual(v.bytes,original.bytes);return longResult();},dialog:async()=>({canceled:false,filePath:path.resolve('synthetic-saved.mp4')})});
 await f.manager.open({source,kind:'video'});const initial=await f.call('load');assert.equal(initial.value.canConvert,false);assert.equal(initial.value.canConvertLong,true);assert.equal(calls,0);
 assert.equal((await f.call('convert')).ok,false);assert.equal(calls,0);
 const result=await f.call('convert-long');assert.equal(result.ok,true);assert.equal(calls,1);assert.equal(options.allowExtended,true);assert.equal(result.value.extendedPreview,true);assert.equal(result.value.expectedDuration,120);assert.equal(result.value.canConvertLong,false);
 await f.call('save');assert.equal(f.writes.length,1);assert.deepEqual(f.writes[0].bytes,original.bytes);f.manager.dispose();
});
test('long conversion refuses out-of-envelope clips and preserves original saving',async()=>{
 let calls=0;const f=fixture({read:()=>longValue(300.001),decodeVideo:async()=>{calls++;return longResult();}});await f.manager.open({source,kind:'video'});const loaded=await f.call('load');assert.equal(loaded.value.canConvertLong,false);assert.equal((await f.call('convert-long')).ok,false);assert.equal(calls,0);assert.equal((await f.call('save')).ok,true);f.manager.dispose();
});
test('duplicate manual clicks share a single conversion; closing aborts and rejects late result',async()=>{
 const gate=deferred();let calls=0,signal;const f=fixture({read:()=>longValue(),decodeVideo:async(v,o)=>{calls++;signal=o.signal;return gate.promise;}});await f.manager.open({source,kind:'video'});await f.call('load');const a=f.call('convert-long'),b=f.call('convert-long');await Promise.resolve();await Promise.resolve();assert.equal(calls,1);f.manager.closeAll();assert.equal(signal.aborted,true);gate.resolve(longResult());assert.equal((await a).ok,false);assert.equal((await b).ok,false);f.manager.dispose();
});
test('memory refusal uses a fixed actionable message with no internal errors or paths',async()=>{
 const f=fixture({read:()=>longValue(),decodeVideo:async()=>{throw Object.assign(Error('private path and token'),{code:'VIDEO_MEMORY'});}});await f.manager.open({source,kind:'video'});await f.call('load');const result=await f.call('convert-long');assert.equal(result.ok,false);assert.match(result.error,/可用内存不足/);assert.doesNotMatch(result.error,/private|token|path/);f.manager.dispose();
});
test('a long conversion without validated duration metadata is rejected',async()=>{
 for(const expectedDuration of [undefined,NaN,0,300.01]){const f=fixture({read:()=>longValue(),decodeVideo:async()=>({...longResult(),expectedDuration})});await f.manager.open({source,kind:'video'});await f.call('load');assert.equal((await f.call('convert-long')).ok,false);f.manager.dispose();}
});

test('discarding a rejected long preview retains original bytes and requires a new explicit conversion',async()=>{let calls=0;const original=longValue(),f=fixture({read:()=>original,decodeVideo:async()=>{calls++;return longResult();}});await f.manager.open({source,kind:'video'});await f.call('load');await f.call('convert-long');assert.equal(calls,1);assert.equal((await f.call('discard-preview')).value.discarded,true);const loaded=await f.call('load');assert.deepEqual(Buffer.from(loaded.value.bytes),original.bytes);assert.equal(loaded.value.canConvertLong,true);assert.equal(f.reads(),1);assert.equal((await f.call('convert')).ok,false);await f.call('convert-long');assert.equal(calls,2);assert.equal(f.reads(),1);f.manager.dispose();});

test('viewer renders only the sanitized staged HTTP error through IPC',async()=>{
 const {AttachmentError}=require('../app/core/attachments.cjs');
 const f=fixture({read:()=>{const e=new AttachmentError('ATTACHMENT_HTTP',{phase:'content',status:503});e.message='secret; upstream URL';throw e;}});
 await f.manager.open({source,kind:'file'});
 assert.deepEqual(await f.call('load'),{ok:false,error:'读取附件原文件失败：源站服务暂时出错（HTTP 503）。'});
 assert.equal((await f.call('save')).ok,false);f.manager.dispose();
});
