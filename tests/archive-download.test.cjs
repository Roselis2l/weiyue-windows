'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const a=require('../app/core/attachments.cjs');
const d=require('../app/core/attachment-download.cjs');
const os=require('node:os'),{Store}=require('../app/core/store.cjs');
const FID='900719925474099312345',source='app://attachment/'+'b'.repeat(32)+'/synthetic-group/synthetic-message/0';
function zip(){const b=Buffer.alloc(22);b.writeUInt32LE(0x06054b50);return b;}
function rar(version=5){return Buffer.concat([Buffer.from(version===5?[0x52,0x61,0x72,0x21,0x1a,0x07,0x01,0]:[0x52,0x61,0x72,0x21,0x1a,0x07,0]),Buffer.alloc(7)]);}
function seven(){const b=Buffer.alloc(32);Buffer.from([0x37,0x7a,0xbc,0xaf,0x27,0x1c]).copy(b);return b;}
const samples=[['zip','application/zip',zip],['rar','application/vnd.rar',rar],['7z','application/x-7z-compressed',seven]];
const pending={kind:'file',fid:FID,state:'needs-metadata',name:'文件消息'};
const descriptor=(extension='zip')=>a.normalizeAttachmentMetadata(pending,{fid:FID,extension,filename:'测试.'+extension,filesize:100});
const value=()=>({bytes:zip(),mime:'application/zip',kind:'archive',name:'测试.zip'});
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {resolve,promise};};
function fixture(options={}){
 let owner='account-a:epoch1',reads=0;const dialogs=[],writes=[];
 const service=d.createAttachmentDownload({getOwner:()=>owner,getParent:()=>({synthetic:true}),readTimeoutMs:options.timeout||120000,
   readAttachment:(src,opts)=>{reads++;return options.read?options.read(src,opts):value();},
   dialog:{showSaveDialog:async(parent,config)=>{dialogs.push({parent,config});return options.dialog?options.dialog():{canceled:false,filePath:path.resolve('artifacts/synthetic.zip')};}},
   writeFile:async(file,bytes)=>{if(options.write)await options.write(file,bytes);writes.push({file,bytes:Buffer.from(bytes)});}});
 return {service,dialogs,writes,reads:()=>reads,setOwner:x=>{owner=x;}};
}
test('official file metadata resolves ZIP/RAR/7z to distinct archive descriptors without guessing from filename',()=>{
 for(const[ext,mime]of samples){const item=descriptor(ext);assert.equal(item.kind,'archive');assert.equal(item.mime,mime);assert.equal(item.fid,FID);assert.equal(item.url,a.sourceUrl(FID));}
 assert.throws(()=>a.normalizeAttachmentMetadata(pending,{fid:FID,extension:'exe',filename:'pretend.zip'}),{code:'ATTACHMENT_TYPE'});
 assert.throws(()=>a.normalizeAttachmentMetadata({...pending,kind:'video'},{fid:FID,extension:'zip'}),{code:'ATTACHMENT_TYPE'});
 assert.throws(()=>a.normalizeAttachmentMetadata(pending,{fid:'77',extension:'zip'}),{code:'ATTACHMENT_INVALID'});
 assert.equal(descriptor('ZIP').mime,'application/zip');
 assert.throws(()=>a.normalizeAttachmentMetadata(pending,{fid:FID,extension:'__proto__'}),{code:'ATTACHMENT_TYPE'});
});
test('archive normalization persists only matching MIME, kind and validated official FID route',()=>{
 const item=descriptor();assert.deepEqual(a.normalizeAttachment(item),item);
 for(const patch of [{mime:'text/html'},{kind:'video'},{url:a.sourceUrl('77')},{fid:Number(FID)},{state:'needs-metadata'}])assert.equal(a.normalizeAttachment({...item,...patch}),null);
 assert.deepEqual(a.mergeAttachments([item],[pending]),[item]);
 assert.equal(a.attachmentSearchText([item]),'测试.zip');
});
test('archive resolution survives restart and duplicate synchronization without changing unread or account isolation',t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'weiyue-archive-test-'));
 t.after(()=>{assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('weiyue-archive-test-'));fs.rmSync(directory,{recursive:true,force:true});});
 const store=new Store(directory);for(const id of ['synthetic-a','synthetic-b'])store.ensureAccount({id,name:id,kind:'import'});
 const message={id:'100',groupId:'g',senderId:'u',senderName:'示例成员',text:'文件消息',time:1000,attachmentVersion:1,attachments:[pending]};
 for(const id of ['synthetic-a','synthetic-b'])store.mergeMessages(id,[{id:'g',name:'示例群'}],[message,{...message,id:'101',time:2000,attachments:[]}]);
 store.setReadPosition('synthetic-a','g','100',{offset:12,seenId:'100',followTail:false});
 const before=store.get('synthetic-a'),unread=store.getReadStats('synthetic-a','g');
 store.mergeMessages('synthetic-a',[],[{...message,attachments:[descriptor('rar')]}],{history:true});
 store.mergeMessages('synthetic-a',[],[message],{history:true});
 const reopened=new Store(directory);
 assert.equal(reopened.get('synthetic-a').messages[0].attachments[0].kind,'archive');
 assert.equal(reopened.get('synthetic-a').messages[0].attachments[0].mime,'application/vnd.rar');
 assert.equal(reopened.get('synthetic-b').messages[0].attachments[0].state,'needs-metadata');
 assert.deepEqual(reopened.get('synthetic-a').readPositions,before.readPositions);
 assert.deepEqual(reopened.getReadStats('synthetic-a','g'),unread);
 assert.equal(reopened.queryMessages('synthetic-a',{groupId:'g',keyword:'测试.rar'}).total,1);
});
test('archive signatures require complete fixed header at offset zero, excluding executable SFX',()=>{
 for(const[ext,mime,make]of samples){const bytes=make();assert.equal(a.detectedAttachmentMime(bytes),mime,ext);
  assert.equal(a.detectedAttachmentMime(bytes.subarray(0,5)),null);assert.equal(a.detectedAttachmentMime(Buffer.concat([Buffer.from('MZ'),bytes])),null);}
 assert.equal(a.detectedAttachmentMime(rar(4)),'application/vnd.rar');
 const local=Buffer.alloc(33);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(3,26);assert.equal(a.detectedAttachmentMime(local),'application/zip');
 local.writeUInt16LE(4,26);assert.equal(a.detectedAttachmentMime(local),null);
 const empty=zip();empty.writeUInt16LE(1,20);assert.equal(a.detectedAttachmentMime(empty),null);
});
test('download preserves original archive bytes and honors canonical MIME, recognized aliases or octet-stream',async()=>{
 for(const[ext,mime,make]of samples){const bytes=make();
  for(const declared of [mime,'application/octet-stream','binary/octet-stream',...a.ARCHIVE_FORMATS[ext].aliases]){
   let called=0;const fetched=await a.fetchAttachment({attachment:descriptor(ext),fetch:async(url,init)=>{
    called++;assert.equal(url,a.sourceUrl(FID));assert.equal(init.redirect,'manual');assert.equal(init.credentials,'include');assert.equal('Cookie'in init.headers,false);
    return new Response(bytes,{headers:{'content-type':declared}});
   }});assert.equal(called,1);assert.equal(fetched.mime,mime);assert.deepEqual(fetched.bytes,bytes);
  }
 }
});
test('HTML, scripts, unknown declarations and mismatched archive magic never pass through',async()=>{
 for(const[bytes,mime]of [[Buffer.from('<html>login</html>'),'application/zip'],[rar(),'application/zip'],[zip(),'text/plain'],[zip(),'application/javascript'],[zip(),'application/x-rar-compressed']]){
  await assert.rejects(a.fetchAttachment({attachment:descriptor(),fetch:async()=>new Response(bytes,{headers:{'content-type':mime}})}),{code:'ATTACHMENT_TYPE'});
 }
});
test('archive metadata and actual transport length enforce 200 MiB bound',async()=>{
 assert.equal(a.MAX_ARCHIVE_BYTES,200*1024*1024);
 assert.throws(()=>a.normalizeAttachmentMetadata(pending,{fid:FID,extension:'zip',filesize:a.MAX_ARCHIVE_BYTES+1}),{code:'ATTACHMENT_TOO_LARGE'});
 await assert.rejects(a.fetchAttachment({attachment:descriptor(),fetch:async()=>new Response(zip(),{headers:{'content-type':'application/zip','content-length':String(a.MAX_ARCHIVE_BYTES+1)}})}),{code:'ATTACHMENT_TOO_LARGE'});
});
test('archive auth/access/rate responses stop after one request without saving content',async()=>{
 for(const[status,code]of [[401,'ATTACHMENT_AUTH'],[403,'ATTACHMENT_DENIED'],[429,'ATTACHMENT_RATE_LIMIT']]){
  let count=0;await assert.rejects(a.fetchAttachment({attachment:descriptor(),fetch:async()=>{count++;return new Response('denied',{status});}}),{code});assert.equal(count,1);
 }
});
test('suggested filename removes traversal/ADS/bidi disguises and cannot suggest an executable extension',()=>{
 assert.equal(d.safeDownloadName('../../x.exe','application/zip'),'.._.._x.zip');
 assert.equal(d.safeDownloadName('CON .zip','application/zip'),'微阅附件.zip');
 assert.equal(d.safeDownloadName('file.zip:evil.exe','application/zip'),'file.zip_evil.zip');
 assert.equal(d.safeDownloadName('文档\u202eexe.zip','application/zip'),'文档_exe.zip');
 assert.equal(d.safeDownloadName('normal.RAR','application/vnd.rar'),'normal.RAR');
 assert.equal(d.safeDownloadName('','application/x-7z-compressed'),'微阅附件.7z');
});
test('download only opens a native Save As dialog and writes exact original bytes after explicit path selection',async()=>{
 const f=fixture(),result=await f.service.download({source});assert.equal(result.saved,true);assert.equal(result.mime,'application/zip');
 assert.equal(f.dialogs.length,1);assert.equal(f.dialogs[0].config.defaultPath,'测试.zip');assert.deepEqual(f.dialogs[0].config.filters,[{name:'ZIP 压缩文件',extensions:['zip']}]);
 assert.ok(f.dialogs[0].config.properties.includes('showOverwriteConfirmation'));assert.ok(f.dialogs[0].config.properties.includes('dontAddToRecent'));
 assert.deepEqual(f.writes[0].bytes,zip());assert.equal(result.name,'synthetic.zip');assert.equal('filePath'in result,false);f.service.dispose();
});
test('canceling the save dialog writes zero files',async()=>{
 const f=fixture({dialog:()=>({canceled:true})});assert.deepEqual(await f.service.download({source}),{canceled:true});assert.equal(f.writes.length,0);f.service.dispose();
});
test('untrusted source, fake byte type and mismatching kind are rejected before a save dialog',async()=>{
 const f=fixture();for(const bad of ['https://example.test/archive.zip','file:///C:/x.zip',source+'?url=evil',source.replace('/0','/1000')])await assert.rejects(f.service.download({source:bad}),new RegExp(d.ERRORS.source));
 assert.equal(f.reads(),0);f.service.dispose();
 for(const patch of [{bytes:new Uint8Array(zip())},{mime:'application/zip',bytes:rar()},{kind:'pdf'},{mime:'text/html'}]){
  const g=fixture({read:()=>({...value(),...patch})});await assert.rejects(g.service.download({source}),new RegExp(d.ERRORS.content));assert.equal(g.dialogs.length,0);g.service.dispose();
 }
});
test('same-source duplicate clicks coalesce; unrelated concurrent file is refused with bounded memory',async()=>{
 const gate=deferred(),f=fixture({read:()=>gate.promise});const a1=f.service.download({source}),a2=f.service.download({source});assert.equal(a1,a2);
 await assert.rejects(f.service.download({source:source.replace('/0','/1')}),new RegExp(d.ERRORS.busy));
 gate.resolve(value());await Promise.all([a1,a2]);assert.equal(f.reads(),1);assert.equal(f.dialogs.length,1);assert.equal(f.writes.length,1);f.service.dispose();
});
test('account change during network or native dialog blocks old-account file writes',async()=>{
 const readGate=deferred(),f=fixture({read:()=>readGate.promise});const loading=f.service.download({source});f.setOwner('account-b');readGate.resolve(value());
 await assert.rejects(loading,new RegExp(d.ERRORS.expired));assert.equal(f.dialogs.length,0);assert.equal(f.writes.length,0);f.service.dispose();
 const dialogGate=deferred(),g=fixture({dialog:()=>dialogGate.promise});const saving=g.service.download({source});
 while(!g.dialogs.length)await new Promise(r=>setImmediate(r));g.setOwner('account-b');dialogGate.resolve({canceled:false,filePath:path.resolve('artifacts/synthetic.zip')});
 await assert.rejects(saving,new RegExp(d.ERRORS.expired));assert.equal(g.writes.length,0);g.service.dispose();
});
test('cancelAll aborts stalled transport, cannot save late data, and permits a new account download',async()=>{
 let captured;const gate=deferred(),f=fixture({read:(_s,opts)=>{captured=opts.signal;return gate.promise;}});
 const loading=f.service.download({source});await Promise.resolve();f.service.cancelAll();assert.equal(captured.aborted,true);
 gate.resolve(value());await assert.rejects(loading,new RegExp(d.ERRORS.expired));assert.equal(f.writes.length,0);
 assert.equal((await f.service.download({source})).saved,true);assert.equal(f.writes.length,1);f.service.dispose();
});
test('download timeout aborts upstream and error messages never include arbitrary transport details',async()=>{
 let signal;const f=fixture({timeout:10,read:(_s,opts)=>{signal=opts.signal;return new Promise(()=>{});}});
 await assert.rejects(f.service.download({source}),new RegExp(d.ERRORS.timeout));assert.equal(signal.aborted,true);f.service.dispose();
 for(const error of [new Error('Cookie private-secret'),Object.assign(new Error('private token'),{code:'ATTACHMENT_DENIED'})]){
  const g=fixture({read:()=>{throw error;}});await assert.rejects(g.service.download({source}),e=>!e.message.includes('private')&&/附件|拒绝/.test(e.message));g.service.dispose();
 }
});
test('chosen path must be absolute and format-compatible; failed writes never report success',async()=>{
 for(const filename of ['relative.zip',path.resolve('artifacts/archive.exe')]){
  const f=fixture({dialog:()=>({canceled:false,filePath:filename})});await assert.rejects(f.service.download({source}));assert.equal(f.writes.length,0);f.service.dispose();
 }
 const f=fixture({write:()=>{throw new Error('private path');}});await assert.rejects(f.service.download({source}),new RegExp(d.ERRORS.save));assert.equal(f.writes.length,0);f.service.dispose();
});
test('PDF and video downloads retain strict existing limits without expanding preview capabilities',async()=>{
 const pdf=Buffer.from('%PDF-1.7\n%%EOF');assert.equal(d.validateDownload({bytes:pdf,mime:'application/pdf',kind:'pdf',name:'a.pdf'}).name,'a.pdf');
 const src=fs.readFileSync(path.join(__dirname,'../app/core/attachment-download.cjs'),'utf8');
 assert.doesNotMatch(src,/child_process|execFile|spawn\(|shell\.open|extract\(|unzip\(/);
});
