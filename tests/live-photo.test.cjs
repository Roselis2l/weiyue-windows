'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {normalizeAttachments,normalizeAttachment,normalizeAttachmentMetadata,mergeAttachments,fetchAttachment,sourceUrl}=require('../app/core/attachments.cjs');
const {Store}=require('../app/core/store.cjs');
const {normalizeMessages,parsePrecisionJson}=require('../app/core/weibo.cjs');
const {fetchImage}=require('../app/core/media.cjs');
const {validateImage}=require('../app/core/image-viewer.cjs');
const {animatedGif,animatedPng}=require('../scripts/lib/synthetic-animation.cjs');
const videoFid='9007199254740993991',imageFid='9007199254740993990';
const pending={kind:'video',fid:videoFid,state:'needs-metadata',name:'实况照片（Live Photo）',livePhoto:true};
const meta={fid:videoFid,extension:'mp4',filename:'synthetic-live-photo.mp4',filesize:24,videosize:'160*90',videotime:2};
const mp4=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(4),Buffer.from('isommp42')]);

test('explicit official Live Photo video FID yields separate pending video while image FID is not a video',()=>{
  assert.deepEqual(normalizeAttachments({media_type:2,fids:[imageFid],live_photo_video_fid:videoFid}),[pending]);
  assert.deepEqual(normalizeAttachments({media_type:2,fids:[imageFid]}),[]);
});
test('official message parser preserves long Live Photo FID from raw numeric JSON',()=>{
  const raw=parsePrecisionJson('{"messages":[{"id":9007199254740993992,"gid":2,"from_uid":3,"content":"分享图片","time":1000,"media_type":1,"fids":[9007199254740993990],"live_photo_video_fid":9007199254740993991}]}');
  const message=normalizeMessages(raw,'2')[0];assert.equal(message.id,'9007199254740993992');
  assert.deepEqual(message.attachments,[pending]);assert.equal(message.attachmentVersion,1);
});
test('unsafe, missing or display-only Live Photo hints cannot create a video',()=>{
  for(const value of [null,'',0,Number(videoFid),'-1','abc','1/2'])assert.deepEqual(normalizeAttachments({live_photo_video_fid:value}),[]);
  assert.deepEqual(normalizeAttachments({isLivePhoto:true,livePhotoVideoUrl:'https://evil.invalid/a.mp4'}),[]);
});
test('Live Photo marker survives normalization and resolved metadata',()=>{
  assert.deepEqual(normalizeAttachment(pending),pending);
  const resolved=normalizeAttachmentMetadata(pending,meta);assert.equal(resolved.livePhoto,true);assert.equal(resolved.kind,'video');
  assert.equal(resolved.url,sourceUrl(videoFid));assert.equal(normalizeAttachment(resolved).livePhoto,true);
});
test('Live Photo metadata must match video FID and must identify a supported video format',()=>{
  for(const value of [{...meta,fid:imageFid},{...meta,extension:'png'},{...meta,extension:'zip'},{...meta,extension:'avi'}])
    assert.throws(()=>normalizeAttachmentMetadata(pending,value));
});

test('official MOV Live Photo metadata keeps the original container type and association',()=>{
  const resolved=normalizeAttachmentMetadata(pending,{...meta,extension:'mov'});
  assert.equal(resolved.kind,'video');assert.equal(resolved.mime,'video/quicktime');assert.equal(resolved.livePhoto,true);
});
test('marker is a boolean video property only, not an arbitrary metadata carrier',()=>{
  assert.equal(normalizeAttachment({...pending,livePhoto:'true'}).livePhoto,undefined);
  assert.equal(normalizeAttachment({...pending,kind:'file'}).livePhoto,undefined);
});
test('explicit Live Photo field coexists with and deduplicates existing video descriptors',()=>{
  assert.deepEqual(normalizeAttachments({attachments:[{...pending,livePhoto:undefined}],live_photo_video_fid:videoFid}),[pending]);
  const other={kind:'file',fid:'100',state:'needs-metadata',name:'文件消息'};
  assert.deepEqual(normalizeAttachments({attachments:[other],live_photo_video_fid:videoFid}),[other,pending]);
});
test('resolving or enriching same video cannot lose a known Live Photo association',()=>{
  const ready=normalizeAttachmentMetadata(pending,meta),plain={...ready};delete plain.livePhoto;
  assert.equal(mergeAttachments([ready],[plain])[0].livePhoto,true);
  assert.equal(mergeAttachments([plain],[pending])[0].livePhoto,true);
  assert.equal(mergeAttachments([pending],[plain])[0].livePhoto,true);
  assert.equal(mergeAttachments([ready],[pending])[0].state,'ready');
});
test('same attachment endpoint validation and byte limits apply to Live Photo',async()=>{
  const ready=normalizeAttachmentMetadata(pending,meta),calls=[];
  const result=await fetchAttachment({attachment:ready,fetch:async(url,options)=>{calls.push({url,options});return new Response(mp4,{headers:{'content-type':'video/mpeg4'}});}});
  assert.deepEqual(result.bytes,mp4);assert.equal(result.kind,'video');assert.equal(result.mime,'video/mp4');
  assert.equal(calls.length,1);assert.equal(calls[0].url,sourceUrl(videoFid));assert.equal(calls[0].options.redirect,'manual');
  await assert.rejects(fetchAttachment({attachment:ready,fetch:async()=>new Response('private error',{headers:{'content-type':'video/mp4'}})}),{code:'ATTACHMENT_TYPE'});
});
test('Live Photo transport rejects permissions/rate limit and never retries automatically',async()=>{
  for(const [status,code] of [[401,'ATTACHMENT_AUTH'],[403,'ATTACHMENT_DENIED'],[429,'ATTACHMENT_RATE_LIMIT']]){
    let calls=0;await assert.rejects(fetchAttachment({attachment:normalizeAttachmentMetadata(pending,meta),fetch:async()=>{calls++;return new Response('',{status});}}),{code});
    assert.equal(calls,1);
  }
});
test('canonical message and restart retain Live Photo attachment independently of still-image media',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'weiyue-live-photo-test-'));
  try{
    const store=new Store(dir);store.ensureAccount({id:'synthetic-live',name:'示例账号',kind:'import'});
    store.mergeMessages('synthetic-live',[{id:'g',name:'合成群'}],[{id:'1',groupId:'g',senderId:'2',senderName:'示例成员',text:'',time:1,
      images:[{url:'https://wx1.sinaimg.cn/large/synthetic.jpg'}],attachments:[pending],mediaVersion:1,attachmentVersion:1}]);
    const value=new Store(dir).get('synthetic-live').messages[0];assert.equal(value.images.length,1);assert.deepEqual(value.attachments,[pending]);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('GIF and APNG bytes survive fetch and isolated viewer validation unchanged',async()=>{
  for(const [mime,bytes] of [['image/gif',animatedGif()],['image/png',animatedPng()]]){
    const result=await fetchImage({url:'https://wx1.sinaimg.cn/large/synthetic.png',fetch:async()=>new Response(bytes,{headers:{'content-type':mime}})});
    assert.equal(result.mime,mime);assert.deepEqual(validateImage(result).bytes,bytes);
  }
});
