'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const a=require('../app/core/attachments.cjs');
const make=(status,body='secret opaque transport text')=>new Response(body,{status,headers:{'content-type':'application/json'}});
const pending={kind:'video',fid:'7',state:'needs-metadata',name:'mock'};
const ready=a.normalizeAttachmentMetadata(pending,{fid:'7',extension:'mp4',filename:'mock.mp4',filesize:20});
const renderer=fs.readFileSync(path.join(__dirname,'../app/renderer/attachment-viewer.js'),'utf8');
const canRetry=vm.runInNewContext(renderer.match(/function canRetryTransport[\s\S]*?\n}/)[0]+'\ncanRetryTransport;');
test('metadata failure retains safe stage and 404, never upstream data',async()=>{
 await assert.rejects(a.resolveAttachment(pending,{fetch:async()=>make(404)}),e=>{
  const msg=a.describeAttachmentHttp(e);assert.equal(msg,'读取附件信息失败：源站未提供此资源（HTTP 404）。');assert.equal(canRetry(msg),false);
  assert.doesNotMatch(msg,/secret|http:|fid/i);return true;
 });
});
test('byte phase isolates missing, generic and transient HTTP results',async()=>{
 for(const [status,reason,retry] of [[400,'源站未返回可用数据',false],[408,'源站请求超时',true],[410,'源站未提供此资源',false],[416,'源站未返回可用数据',false],[500,'源站服务暂时出错',true],[503,'源站服务暂时出错',true]]){
  await assert.rejects(a.fetchAttachment({attachment:ready,fetch:async()=>make(status)}),e=>{
   const msg=a.describeAttachmentHttp(e);assert.equal(msg,'读取附件原文件失败：'+reason+'（HTTP '+status+'）。');assert.equal(canRetry(msg),retry);return true;
  });
 }
});
test('real authorization, rate limit, and explicit deletion retain existing meaning',async()=>{
 for(const [status,body,code,retry] of [[401,'x','ATTACHMENT_AUTH',false],[403,'x','ATTACHMENT_DENIED',false],[429,'x','ATTACHMENT_RATE_LIMIT',true],[400,'{"error_code":20367,"error":"文件已删除"}','ATTACHMENT_DELETED',false]]){
  await assert.rejects(a.fetchAttachment({attachment:ready,fetch:async()=>make(status,body)}),e=>{
   assert.equal(e.code,code);assert.equal(a.describeAttachmentHttp(e),null);assert.equal(canRetry(e.message),retry);return true;
  });
 }
});
test('a lookalike or non-integer status cannot add arbitrary diagnostic context',()=>{
 assert.equal(a.describeAttachmentHttp({code:'ATTACHMENT_HTTP',phase:'content',httpStatus:404,message:'secret'}),null);
 assert.equal(a.describeAttachmentHttp(new a.AttachmentError('ATTACHMENT_HTTP',{phase:'private URL',status:404})),null);
 assert.equal(a.describeAttachmentHttp(new a.AttachmentError('ATTACHMENT_HTTP',{phase:'content',status:'404'})),null);
});
