'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const a=require('../app/core/attachments.cjs');
const FID='9007199254740993123';
const pdf=Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
function mp4(){
 const b=Buffer.alloc(28);b.writeUInt32BE(24);b.write('ftyp',4);b.write('isom',8);b.write('mp42',16);b.write('isom',20);
 return b;
}
const ready=(kind='pdf')=>({kind,fid:FID,state:'ready',name:kind==='pdf'?'中文附件.pdf':'中文视频.mp4',
 mime:kind==='pdf'?'application/pdf':'video/mp4',url:a.sourceUrl(FID)});
const response=(bytes,mime='application/pdf')=>new Response(bytes,{headers:{'content-type':mime}});
test('only official file/video media types become pending descriptors with lexical FIDs',()=>{
 assert.deepEqual(a.normalizeMessageAttachments({media_type:5,fids:[FID]}),[{kind:'file',fid:FID,state:'needs-metadata',name:'文件消息'}]);
 assert.equal(a.normalizeMessageAttachments({media_type:'10',fids:[FID]})[0].kind,'video');
 for(const type of [0,1,17,'unknown'])assert.deepEqual(a.normalizeMessageAttachments({media_type:type,fids:[FID]}),[]);
 assert.equal(a.normalizeMessageAttachments({media_type:5,fids:[FID,FID,Number(FID),'0','1e3','bad']}).length,1);
});
test('safe download URL never strips extra signature or accepts foreign authority',()=>{
 assert.equal(a.safeAttachmentUrl(a.sourceUrl(FID)),a.sourceUrl(FID));
 for(const url of ['http://upload.api.weibo.com/2/mss/msget?source=209678993&fid=1',
  'https://upload.api.weibo.com.evil.test/2/mss/msget?source=209678993&fid=1',
  'https://upload.api.weibo.com:443/2/mss/msget?source=209678993&fid=1',
  a.sourceUrl(FID)+'&token=secret',a.sourceUrl(FID)+'&imageType=origin',
  a.sourceUrl(FID)+'&fid=2',a.sourceUrl(FID)+'#fragment',
  a.sourceUrl(FID).replace(FID,FID+'%20'),a.sourceUrl(FID).replace('/msget?','/meta_query.json?')])
  assert.equal(a.safeAttachmentUrl(url),null,url);
});
test('ready descriptors validate kind mime fid and download identity',()=>{
 assert.equal(a.normalizeAttachment(ready()).name,'中文附件.pdf');
 for(const patch of [{kind:'html'},{fid:Number(FID)},{url:a.sourceUrl('22')},{state:'broken'}])
 assert.equal(a.normalizeAttachment({...ready(),...patch}),null);
 assert.equal(a.normalizeAttachment({...ready('video'),mime:'text/html'}),null);
 assert.equal(a.normalizeAttachment({...ready(),name:'\n标题\u0000.pdf'}).name,'标题 .pdf');
 assert.equal(a.normalizeAttachment({...ready(),size:Infinity}).size,undefined);
});
test('merge keeps successfully resolved attachment when newer sync only has a FID',()=>{
 const pending=a.normalizeMessageAttachments({media_type:5,fids:[FID]});
 assert.deepEqual(a.mergeAttachments([ready()],pending),[ready()]);
 assert.deepEqual(a.mergeAttachments(pending,[ready()]),[ready()]);
 assert.equal(a.attachmentSearchText([ready()]),'中文附件.pdf');
 assert.equal(a.attachmentSearchText([ready()]).includes(FID),false);
});
test('metadata URL follows reviewed source/replace/callback contract',()=>{
 const u=new URL(a.metadataUrl(FID));
 assert.equal(u.origin,'https://upload.api.weibo.com');
 assert.equal(u.pathname,'/2/mss/meta_query.json');
 assert.equal(u.searchParams.get('fid'),FID);
 assert.equal(u.searchParams.get('replace'),'false');
 assert.equal(u.searchParams.get('callback'),a.CALLBACK);
 assert.throws(()=>a.metadataUrl(Number(FID)),{code:'ATTACHMENT_INVALID'});
});
test('metadata parses exact JSONP as data, preserving lexical IDs, without executing suffixes',()=>{
 const value={fid:FID,filename:'文件.pdf',extension:'pdf'};
 assert.deepEqual(a.parseMetadata(JSON.stringify(value)),value);
 assert.deepEqual(a.parseMetadata(a.CALLBACK+'('+JSON.stringify(value)+');'),value);
 assert.equal(a.parseMetadata('{"fid":'+FID+'}').fid,FID);
 for(const raw of ['evil({});',a.CALLBACK+'({});globalThis.pwned=1;',a.CALLBACK+'(function(){})','<html>error</html>'])
  assert.throws(()=>a.parseMetadata(raw),{code:'ATTACHMENT_TYPE'});
 for(const raw of [{error_code:21301},{error:'private token'},{ok:'0'},{result:false}])
  assert.throws(()=>a.parseMetadata(JSON.stringify(raw)),{code:'ATTACHMENT_REJECTED'});
});
test('metadata transport uses official origin referer, fixed URL and injected account transport once',async()=>{
 let count=0;
 const result=await a.fetchAttachmentMetadata({fid:FID,fetch:async(url,init)=>{
  count++;assert.equal(url,a.metadataUrl(FID));assert.equal(init.redirect,'manual');assert.equal(init.credentials,'include');
  assert.equal(init.headers.Referer,'https://api.weibo.com/');assert.equal('Cookie'in init.headers,false);
  return response(a.CALLBACK+'({"fid":"'+FID+'","extension":"pdf"});','application/javascript');
 }});
 assert.equal(result.fid,FID);assert.equal(count,1);
});
test('metadata resolves actual PDF and MP4 fields only after exact FID alias matching',()=>{
 const pending=a.normalizeMessageAttachments({media_type:5,fids:[FID]})[0];
 const resolved=a.normalizeAttachmentMetadata(pending,{fid:FID,fidstr:FID,extension:'pdf',filename:'%E4%B8%AD%E6%96%87.pdf',filesize:1507147,is_outofdate:false});
 assert.equal(resolved.kind,'pdf');assert.equal(resolved.name,'中文.pdf');assert.equal(resolved.size,1507147);
 const video=a.normalizeAttachmentMetadata({...pending,kind:'video'},{fid:FID,extension:'mp4',filename:'test.mp4',filesize:28227935,videosize:'720*1280',videotime:'218'});
 assert.equal(video.width,720);assert.equal(video.height,1280);assert.equal(video.duration,218);
 for(const patch of [{fidstr:'77'},{is_outofdate:true},{extension:'exe'},{filesize:a.MAX_PDF_BYTES+1}])
 assert.throws(()=>a.normalizeAttachmentMetadata(pending,{fid:FID,extension:'pdf',...patch}));
});
test('resolve fetches pending metadata exactly once and returns existing ready without network',async()=>{
 let count=0;const fetch=async()=>{count++;return response(JSON.stringify({fid:FID,extension:'pdf',filename:'file.pdf'}),'application/json');};
 const pending=a.normalizeMessageAttachments({media_type:5,fids:[FID]})[0];
 const result=await a.resolveAttachment(pending,{fetch});assert.equal(result.kind,'pdf');assert.equal(count,1);
 assert.deepEqual(await a.resolveAttachment(result,{fetch}),result);assert.equal(count,1);
});
test('PDF and MP4 originals remain byte-exact after validation',async()=>{
 for(const[kind,bytes,mime]of[['pdf',pdf,'application/pdf'],['video',mp4(),'video/mp4']]){
  const value=await a.fetchAttachment({attachment:ready(kind),fetch:async()=>response(bytes,mime)});
  assert.equal(value.kind,kind);assert.equal(value.mime,mime);assert.deepEqual(value.bytes,bytes);
 }
});
test('octet-stream permitted only when actual signature matches resolved attachment',async()=>{
 const value=await a.fetchAttachment({attachment:ready(),fetch:async()=>response(pdf,'application/octet-stream')});
 assert.deepEqual(value.bytes,pdf);
 for(const[bytes,mime]of[[pdf,'text/html'],[Buffer.from('<html>private</html>'),'application/pdf'],[mp4(),'application/pdf']])
 await assert.rejects(a.fetchAttachment({attachment:ready(),fetch:async()=>response(bytes,mime)}),{code:'ATTACHMENT_TYPE'});
});
test('official video/mpeg4 alias accepts only metadata-resolved MP4 with strict MP4 bytes',async()=>{
 const bytes=mp4();
 const value=await a.fetchAttachment({attachment:ready('video'),fetch:async()=>response(bytes,'video/mpeg4;charset=utf-8')});
 assert.equal(value.kind,'video');assert.equal(value.mime,'video/mp4');assert.deepEqual(value.bytes,bytes);
 for(const bad of [pdf,Buffer.from('<html>denied</html>'),Buffer.from('{"error":true}'),Buffer.from([0x1a,0x45,0xdf,0xa3])])
  await assert.rejects(a.fetchAttachment({attachment:ready('video'),fetch:async()=>response(bad,'video/mpeg4')}),{code:'ATTACHMENT_TYPE'});
 await assert.rejects(a.fetchAttachment({attachment:ready(),fetch:async()=>response(pdf,'video/mpeg4')}),{code:'ATTACHMENT_TYPE'});
 const webm={...ready('video'),mime:'video/webm',name:'video.webm'};
 await assert.rejects(a.fetchAttachment({attachment:webm,fetch:async()=>response(Buffer.from([0x1a,0x45,0xdf,0xa3]),'video/mpeg4')}),{code:'ATTACHMENT_TYPE'});
 for(const unknown of ['application/mp4','video/x-m4v','application/x-download','text/plain'])
  await assert.rejects(a.fetchAttachment({attachment:ready('video'),fetch:async()=>response(bytes,unknown)}),{code:'ATTACHMENT_TYPE'});
});
test('HEIF image container cannot be treated as MP4 video',()=>{
 const b=mp4();b.write('heic',8);
 assert.equal(a.detectedAttachmentMime(b),null);
 b.write('avif',8);assert.equal(a.detectedAttachmentMime(b),null);
});
test('authentication, access, rate, redirect and server failures never retry',async()=>{
 for(const[status,code]of[[401,'ATTACHMENT_AUTH'],[403,'ATTACHMENT_DENIED'],[429,'ATTACHMENT_RATE_LIMIT'],
 [302,'ATTACHMENT_REDIRECT'],[503,'ATTACHMENT_HTTP']]){
  let count=0;
  await assert.rejects(a.fetchAttachment({attachment:ready(),fetch:async()=>{count++;return new Response('private',{status});}}),{code});
  assert.equal(count,1);
 }
});
test('metadata declared and streaming size limits prevent oversized parsing',async()=>{
 for(const result of [()=>new Response('{}',{headers:{'content-length':String(a.MAX_METADATA_BYTES+1)}}),
 ()=>new Response(Buffer.alloc(a.MAX_METADATA_BYTES+1))]){
 await assert.rejects(a.fetchAttachmentMetadata({fid:FID,fetch:async()=>result()}),{code:'ATTACHMENT_TOO_LARGE'});
 }
});
test('PDF and video declared lengths enforce separate limits',async()=>{
 for(const[kind,max]of[['pdf',a.MAX_PDF_BYTES],['video',a.MAX_VIDEO_BYTES]])
 await assert.rejects(a.fetchAttachment({attachment:ready(kind),fetch:async()=>new Response(null,{headers:{'content-length':String(max+1)}})}),{code:'ATTACHMENT_TOO_LARGE'});
});
test('cross-realm offset streams preserve only view bytes',async()=>{
 const other=vm.runInNewContext('new Uint8Array(Uint8Array.from([1,2,...input,3,4]).buffer,2,input.length)',{input:[...pdf]});
 const value=await a.fetchAttachment({attachment:ready(),fetch:async()=>({status:200,headers:new Headers({'content-type':'application/pdf'}),
 body:new ReadableStream({start(c){c.enqueue(other);c.close();}})})});
 assert.deepEqual(value.bytes,pdf);
});
test('shadowed typed-array fields cannot replace or expose adjacent bytes',async()=>{
 const value=Uint8Array.from(pdf);
 for(const key of ['buffer','byteOffset','byteLength','length'])Object.defineProperty(value,key,{get(){throw Error('private');}});
 const got=await a.fetchAttachment({attachment:ready(),fetch:async()=>({status:200,headers:new Headers({'content-type':'application/pdf'}),
 body:new ReadableStream({start(c){c.enqueue(value);c.close();}})})});
 assert.deepEqual(got.bytes,pdf);
});
test('abort before request makes no transport call',async()=>{
 const c=new AbortController();c.abort();let called=0;
 await assert.rejects(a.fetchAttachment({attachment:ready(),signal:c.signal,fetch:()=>called++}),{code:'ATTACHMENT_ABORT'});
 assert.equal(called,0);
});
test('timeout cancels hanging body and does not expose errors or response content',async()=>{
 let cancelled=false;
 await assert.rejects(a.fetchAttachmentMetadata({fid:FID,timeoutMs:20,fetch:async()=>new Response(new ReadableStream({start(){},cancel(){cancelled=true;}}))}),{code:'ATTACHMENT_TIMEOUT'});
 assert.equal(cancelled,true);
 await assert.rejects(a.fetchAttachmentMetadata({fid:FID,fetch:async()=>{throw Error('Cookie private-secret');}}),
 e=>e.code==='ATTACHMENT_NETWORK'&&!e.message.includes('private-secret'));
});
