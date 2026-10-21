'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {fetchImage}=require('../app/core/media.cjs');
const url='https://upload.api.weibo.com/2/mss/msget?fid=119001&source=209678993&imageType=origin';
const formats=new Map([
 ['image/jpeg',Buffer.from([255,216,255,224,0,2,255,217])],
 ['image/png',Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0])],
 ['image/gif',Buffer.from('GIF89a')],
 ['image/webp',Buffer.concat([Buffer.from('RIFF'),Buffer.from([4,0,0,0]),Buffer.from('WEBP')])],
]);
const response=(bytes,mime,headers={})=>new Response(bytes,{headers:{'content-type':mime,...headers}});
const run=(bytes,mime,options={})=>fetchImage({url,fetch:async()=>response(bytes,mime),...options});
const rejects=code=>error=>{assert.equal(error.code,code);assert.doesNotMatch(JSON.stringify(error),/fixture-secret|https?:\/\/|Cookie|Bearer/);return true;};

test('chat opt-in corrects supported raster MIME from actual signature and preserves all bytes',async()=>{
 for(const [actual,bytes] of formats)for(const declared of formats.keys()){
  const value=await run(bytes,declared,{allowRasterMimeCorrection:true});
  assert.equal(value.mime,actual);assert.deepEqual(value.bytes,bytes);
 }
});
test('default and explicit false remain strict for every differing supported MIME pair',async()=>{
 for(const [actual,bytes] of formats)for(const declared of formats.keys())if(declared!==actual){
  await assert.rejects(run(bytes,declared),rejects('MEDIA_TYPE'));
  await assert.rejects(run(bytes,declared,{allowRasterMimeCorrection:false}),rejects('MEDIA_TYPE'));
 }
});
test('opt-in never accepts HTML, SVG, absent, generic binary or HEIF declarations as raster',async()=>{
 for(const mime of ['text/html','image/svg+xml','application/octet-stream','','image/heic','image/heif']){
  await assert.rejects(run(formats.get('image/png'),mime,{allowRasterMimeCorrection:true,allowHeif:true}),rejects('MEDIA_TYPE'));
 }
});
test('opt-in still rejects error payloads and unknown signatures labeled as an image',async()=>{
 for(const text of ['<html>fixture-secret</html>','<svg>fixture-secret</svg>','{"error":"fixture-secret"}','RIFFxxxxFAKE','']){
  for(const mime of formats.keys())await assert.rejects(run(Buffer.from(text),mime,{allowRasterMimeCorrection:true}),rejects('MEDIA_TYPE'));
 }
});
test('cross-realm chunked PNG under JPEG declaration corrects type without dropping trailing bytes',async()=>{
 const bytes=Buffer.concat([formats.get('image/png'),Buffer.from('synthetic-trailing-data')]);
 const chunks=[bytes.subarray(0,2),bytes.subarray(2,8),bytes.subarray(8)];
 const body=new ReadableStream({start(controller){for(const chunk of chunks)controller.enqueue(vm.runInNewContext('new Uint8Array(bytes)',{bytes:[...chunk]}));controller.close();}});
 const result=await fetchImage({url,fetch:async()=>response(body,'IMAGE/JPEG; charset=binary'),allowRasterMimeCorrection:true});
 assert.equal(result.mime,'image/png');assert.deepEqual(result.bytes,bytes);
});
test('MIME correction still enforces streamed and declared size limits',async()=>{
 const bytes=formats.get('image/png');
 await assert.rejects(run(bytes,'image/jpeg',{allowRasterMimeCorrection:true,maxBytes:bytes.length-1}),rejects('MEDIA_TOO_LARGE'));
 await assert.rejects(fetchImage({url,allowRasterMimeCorrection:true,maxBytes:bytes.length,fetch:async()=>response(bytes,'image/jpeg',{'content-length':'99999999999999999'})}),rejects('MEDIA_TOO_LARGE'));
});
test('MIME correction option is boolean and invalid options make no request',async()=>{
 for(const value of [null,1,'true',{},[]]){
  let requests=0;
  await assert.rejects(fetchImage({url,allowRasterMimeCorrection:value,fetch:async()=>{requests++;return response(formats.get('image/png'),'image/jpeg');}}),rejects('MEDIA_CONFIG'));
  assert.equal(requests,0);
 }
});
test('MIME correction never retries denied HTTP status or follows an untrusted redirect',async()=>{
 for(const status of [401,403,429]){
  let requests=0;
  await assert.rejects(fetchImage({url,allowRasterMimeCorrection:true,fetch:async()=>{requests++;return new Response('fixture-secret',{status,headers:{'content-type':'image/jpeg'}});}}),rejects('MEDIA_HTTP'));
  assert.equal(requests,1);
 }
 let requests=0;
 await assert.rejects(fetchImage({url,allowRasterMimeCorrection:true,fetch:async()=>{requests++;return new Response(null,{status:302,headers:{location:'https://invalid.example/private'}});}}),rejects('MEDIA_REDIRECT'));
 assert.equal(requests,1);
});
test('raster correction and HEIF opt-in remain independent and preserve the HEIC gate',async()=>{
 const heic=Buffer.alloc(20);heic.writeUInt32BE(20);heic.write('ftyp',4);heic.write('heic',8);heic.write('mif1',16);
 const value=await run(heic,'image/jpeg',{allowHeif:true,allowRasterMimeCorrection:true});
 assert.equal(value.mime,'image/heic');assert.deepEqual(value.bytes,heic);
 await assert.rejects(run(heic,'image/jpeg',{allowRasterMimeCorrection:true}),rejects('MEDIA_TYPE'));
 for(const mime of ['image/png','image/gif'])await assert.rejects(run(heic,mime,{allowHeif:true,allowRasterMimeCorrection:true}),rejects('MEDIA_TYPE'));
});
