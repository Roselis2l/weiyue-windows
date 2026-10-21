'use strict';

// Routes and FID metadata flow verified against the official public chat app:
// https://h5.sinaimg.cn/m/pcweibochat/js/app.48f8ddda.js (2026-10-20).
// No credentials are read here; the caller injects its account-scoped transport.
const {types} = require('node:util');
const typedPrototype=Object.getPrototypeOf(Uint8Array.prototype);
const typedBuffer=Object.getOwnPropertyDescriptor(typedPrototype,'buffer').get;
const typedOffset=Object.getOwnPropertyDescriptor(typedPrototype,'byteOffset').get;
const typedLength=Object.getOwnPropertyDescriptor(typedPrototype,'byteLength').get;
const ORIGIN = 'https://upload.api.weibo.com';
const META_PATH = '/2/mss/meta_query.json', MEDIA_PATH = '/2/mss/msget';
const SOURCE = '209678993', CALLBACK = 'weiyueAttachmentMetadata';
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_PDF_BYTES = 50 * 1024 * 1024, MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const MESSAGES = Object.freeze({
  ATTACHMENT_INVALID: '附件信息无效。',
  ATTACHMENT_URL: '附件地址不在允许范围内。',
  ATTACHMENT_CONFIG: '附件加载配置无效。',
  ATTACHMENT_AUTH: '微博登录已失效，请在官方页面重新登录。',
  ATTACHMENT_DENIED: '微博拒绝本次附件读取，请在官方页面确认访问权限。',
  ATTACHMENT_RATE_LIMIT: '微博限制了本次读取，请稍后再试。',
  ATTACHMENT_REJECTED: '微博未允许本次附件读取。',
  ATTACHMENT_HTTP: '附件暂时无法读取。',
  ATTACHMENT_REDIRECT: '附件跳转地址不在允许范围内。',
  ATTACHMENT_NETWORK: '附件网络读取失败，请稍后再试。',
  ATTACHMENT_TIMEOUT: '附件读取超时。',
  ATTACHMENT_ABORT: '附件读取已取消。',
  ATTACHMENT_TOO_LARGE: '附件超过本地预览大小限制。',
  ATTACHMENT_TYPE: '附件内容或格式暂不支持。',
});
class AttachmentError extends Error {
  constructor(code) { super(MESSAGES[code] || MESSAGES.ATTACHMENT_INVALID); this.code=code; }
}
const fail=code=>{throw new AttachmentError(code);};
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
function fidValue(value) {
  if(typeof value==='number'&&!Number.isSafeInteger(value))return null;
  const fid=typeof value==='string'?value.trim():typeof value==='number'?String(value):'';
  return /^[1-9]\d{0,127}$/.test(fid)?fid:null;
}
function text(value,fallback='',max=240) {
  return typeof value==='string'&&value.trim()?value.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max):fallback;
}
function sourceUrl(fid) {
  fid=fidValue(fid);if(!fid)fail('ATTACHMENT_INVALID');
  const url=new URL(MEDIA_PATH,ORIGIN);url.searchParams.set('source',SOURCE);url.searchParams.set('fid',fid);
  return url.href;
}
function metadataUrl(fid,{replace=false}={}) {
  fid=fidValue(fid);if(!fid||typeof replace!=='boolean')fail('ATTACHMENT_INVALID');
  const url=new URL(META_PATH,ORIGIN);url.searchParams.set('source',SOURCE);url.searchParams.set('fid',fid);
  url.searchParams.set('replace',String(replace));url.searchParams.set('callback',CALLBACK);return url.href;
}
function safeAttachmentUrl(value) {
  if(typeof value!=='string'||value.length>4096||/[\s\u0000-\u001f\u007f\\]/.test(value))return null;
  // Inspect raw authority before WHATWG URL normalizes an explicit :443.
  if(!/^https:\/\/upload\.api\.weibo\.com\//.test(value))return null;
  try{
    const u=new URL(value);
    if(u.origin!==ORIGIN||u.username||u.password||u.port||u.hash||u.pathname!==MEDIA_PATH)return null;
    if([...u.searchParams.keys()].some(k=>!['source','fid'].includes(k))||
       u.searchParams.getAll('source').length!==1||u.searchParams.get('source')!==SOURCE||
       u.searchParams.getAll('fid').length!==1||!fidValue(u.searchParams.get('fid'))||
       fidValue(u.searchParams.get('fid'))!==u.searchParams.get('fid'))return null;
    // Canonicalize ordering only; do not strip unknown or signed parameters.
    return sourceUrl(u.searchParams.get('fid'));
  }catch{return null;}
}
function normalizeAttachment(value) {
  if(!object(value)||!['file','pdf','video'].includes(value.kind))return null;
  const fid=fidValue(value.fid);if(!fid)return null;
  if(value.state==='needs-metadata'){
    if(!['file','video'].includes(value.kind))return null;
    return {kind:value.kind,fid,state:'needs-metadata',name:text(value.name,value.kind==='video'?'分享视频':'文件消息')};
  }
  if(value.state!=='ready'||!['pdf','video'].includes(value.kind))return null;
  const mime=value.kind==='pdf'?'application/pdf':value.mime;
  if(value.kind==='video'&&!['video/mp4','video/webm'].includes(mime))return null;
  const url=safeAttachmentUrl(value.url);
  if(!url||new URL(url).searchParams.get('fid')!==fid)return null;
  const result={kind:value.kind,fid,state:'ready',name:text(value.name,value.kind==='pdf'?'文件.pdf':'视频.mp4'),mime,url};
  for(const key of ['size','width','height'])if(Number.isSafeInteger(value[key])&&value[key]>0&&value[key]<=
    (key==='size'?MAX_VIDEO_BYTES:32768))result[key]=value[key];
  if(Number.isFinite(value.duration)&&value.duration>0&&value.duration<=86400)result.duration=value.duration;
  return result;
}
function normalizeAttachments(message) {
  if(!object(message))return [];
  if(Array.isArray(message.attachments))return message.attachments.slice(0,20).map(normalizeAttachment).filter(Boolean);
  const kind=message.media_type===5||message.media_type==='5'?'file':
    message.media_type===10||message.media_type==='10'?'video':null;
  if(!kind)return [];
  const values=Array.isArray(message.fids)?message.fids:typeof message.fids==='string'?message.fids.split(','):[message.fids];
  const fids=[...new Set(values.slice(0,20).map(fidValue).filter(Boolean))];
  return fids.map(fid=>({kind,fid,state:'needs-metadata',name:kind==='video'?'分享视频':'文件消息'}));
}
function attachmentSearchText(attachments) {
  return (Array.isArray(attachments)?attachments:[]).map(normalizeAttachment).filter(Boolean).map(a=>a.name).join('\n');
}
function parseMetadata(textValue) {
  if(typeof textValue!=='string'||Buffer.byteLength(textValue)>MAX_METADATA_BYTES)fail('ATTACHMENT_TOO_LARGE');
  let raw=textValue.trim();
  // JSONP is data only: unwrap one exact callback name; never eval or execute.
  if(raw.startsWith(CALLBACK+'(')){
    raw=raw.slice(CALLBACK.length+1).trim();
    if(raw.endsWith(';'))raw=raw.slice(0,-1).trim();
    if(!raw.endsWith(')'))fail('ATTACHMENT_TYPE');
    raw=raw.slice(0,-1);
  }
  let data;try{data=require('./weibo.cjs').parsePrecisionJson(raw);}catch{fail('ATTACHMENT_TYPE');}
  if(!object(data))fail('ATTACHMENT_TYPE');
  if((data.error_code!==undefined&&!['','0'].includes(String(data.error_code)))||data.error||
     data.result===false||data.ok===0||data.ok==='0')fail('ATTACHMENT_REJECTED');
  return data;
}
async function requestBytes({url,fetch:request,signal,maxBytes,timeoutMs,accept}) {
  if(typeof request!=='function'||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>MAX_VIDEO_BYTES||
    !Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000)fail('ATTACHMENT_CONFIG');
  if(signal&&typeof signal.addEventListener!=='function')fail('ATTACHMENT_CONFIG');
  if(signal?.aborted)fail('ATTACHMENT_ABORT');
  const controller=new AbortController();let error,rejectInterrupt,response,reader;
  const interrupted=new Promise((_,reject)=>{rejectInterrupt=reject;});interrupted.catch(()=>{});
  const interrupt=code=>{if(error)return;error=new AttachmentError(code);controller.abort();rejectInterrupt(error);};
  const onAbort=()=>interrupt('ATTACHMENT_ABORT');signal?.addEventListener('abort',onAbort,{once:true});
  if(signal?.aborted)onAbort();
  const timer=setTimeout(()=>interrupt('ATTACHMENT_TIMEOUT'),timeoutMs);
  const wait=operation=>{if(error)throw error;return Promise.race([Promise.resolve().then(operation),interrupted]);};
  try {
    response=await wait(()=>request(url,{method:'GET',credentials:'include',redirect:'manual',cache:'no-store',
      headers:{Referer:'https://api.weibo.com/',Accept:accept},signal:controller.signal}));
    if(!response||typeof response.status!=='number'||typeof response.headers?.get!=='function')fail('ATTACHMENT_NETWORK');
    if(response.status===401)fail('ATTACHMENT_AUTH');
    if(response.status===403)fail('ATTACHMENT_DENIED');
    if(response.status===429)fail('ATTACHMENT_RATE_LIMIT');
    if(response.redirected||[301,302,303,307,308].includes(response.status))fail('ATTACHMENT_REDIRECT');
    if(response.status<200||response.status>=300)fail('ATTACHMENT_HTTP');
    if(response.url&&response.url!==url)fail('ATTACHMENT_REDIRECT');
    const length=response.headers.get('content-length');
    if(length!==null&&/^\d+$/.test(length)&&BigInt(length)>BigInt(maxBytes))fail('ATTACHMENT_TOO_LARGE');
    if(!response.body?.getReader)fail('ATTACHMENT_TYPE');
    reader=response.body.getReader();const chunks=[];let size=0;
    for(;;){const part=await wait(()=>reader.read());if(part.done)break;
      if(!types.isUint8Array(part.value))fail('ATTACHMENT_TYPE');
      const view=new Uint8Array(Reflect.apply(typedBuffer,part.value,[]),Reflect.apply(typedOffset,part.value,[]),Reflect.apply(typedLength,part.value,[]));
      const bytes=Buffer.from(view);size+=bytes.length;if(size>maxBytes)fail('ATTACHMENT_TOO_LARGE');chunks.push(bytes);}
    return {bytes:Buffer.concat(chunks,size),headers:response.headers};
  }catch(caught){if(error)throw error;if(caught instanceof AttachmentError)throw caught;fail('ATTACHMENT_NETWORK');}
  finally{
    clearTimeout(timer);signal?.removeEventListener('abort',onAbort);
    try{if(reader){Promise.resolve(reader.cancel()).catch(()=>{});reader.releaseLock();}
      else if(response?.body?.cancel)Promise.resolve(response.body.cancel()).catch(()=>{});}catch{}
  }
}
async function fetchAttachmentMetadata({fid,replace=false,fetch,signal,timeoutMs=15000}={}) {
  const result=await requestBytes({url:metadataUrl(fid,{replace}),fetch,signal,timeoutMs,maxBytes:MAX_METADATA_BYTES,
    accept:'application/json, text/javascript'});
  return parseMetadata(result.bytes.toString('utf8'));
}
function normalizeAttachmentMetadata(descriptor,metadata) {
  const pending=normalizeAttachment(descriptor);
  if(!pending||!object(metadata))fail('ATTACHMENT_INVALID');
  if(metadata.is_outofdate===true)fail('ATTACHMENT_REJECTED');
  const aliases=[metadata.fid,metadata.fidstr].filter(v=>v!==undefined&&v!==null);
  if(!aliases.length||aliases.some(v=>fidValue(v)!==pending.fid))fail('ATTACHMENT_INVALID');
  const extension=typeof metadata.extension==='string'?metadata.extension.toLowerCase():'';
  const kind=extension==='pdf'?'pdf':['mp4','webm'].includes(extension)?'video':null;
  if(!kind||(pending.kind==='video'&&kind!=='video'))fail('ATTACHMENT_TYPE');
  let name=text(metadata.filename,kind==='pdf'?'文件.pdf':'视频.'+extension);
  if(/%[a-f0-9]{2}/i.test(name)){try{name=text(decodeURIComponent(name),name);}catch{}}
  const value={kind,fid:pending.fid,state:'ready',name,mime:kind==='pdf'?'application/pdf':'video/'+extension,url:sourceUrl(pending.fid)};
  const size=Number(metadata.filesize);
  if(Number.isSafeInteger(size)&&size>0){
    if(size>(kind==='pdf'?MAX_PDF_BYTES:MAX_VIDEO_BYTES))fail('ATTACHMENT_TOO_LARGE');
    value.size=size;
  }
  const dimensions=typeof metadata.videosize==='string'?metadata.videosize.match(/^(\d{1,5})\*(\d{1,5})$/):null;
  if(dimensions){value.width=Number(dimensions[1]);value.height=Number(dimensions[2]);}
  const duration=Number(metadata.videotime);if(Number.isFinite(duration)&&duration>0)value.duration=duration;
  return normalizeAttachment(value);
}
async function resolveAttachment(descriptor,{fetch,signal}={}) {
  const value=normalizeAttachment(descriptor);if(!value)fail('ATTACHMENT_INVALID');
  if(value.state==='ready')return value;
  const metadata=await fetchAttachmentMetadata({fid:value.fid,fetch,signal});
  return normalizeAttachmentMetadata(value,metadata);
}
function detectedAttachmentMime(bytes) {
  if(!Buffer.isBuffer(bytes))return null;
  if(bytes.length>=8&&/^%PDF-[12]\.\d/.test(bytes.subarray(0,8).toString('ascii')))return 'application/pdf';
  if(bytes.length>=4&&bytes[0]===0x1a&&bytes[1]===0x45&&bytes[2]===0xdf&&bytes[3]===0xa3)return 'video/webm';
  if(bytes.length>=16&&bytes.subarray(4,8).toString('ascii')==='ftyp'){
    const size=bytes.readUInt32BE(0),brands=new Set(['isom','iso2','iso3','iso4','iso5','iso6','mp41','mp42','avc1','M4V ','MSNV']);
    if(size>=16&&size<=bytes.length&&size<=4096&&(size-16)%4===0){
      const declared=[bytes.subarray(8,12).toString('ascii')];
      for(let i=16;i<size;i+=4)declared.push(bytes.subarray(i,i+4).toString('ascii'));
      if(declared.some(b=>brands.has(b))&&!declared.some(b=>['avif','avis','heic','heix','mif1','msf1'].includes(b)))return 'video/mp4';
    }
  }
  return null;
}
function mergeAttachments(previous=[],incoming=[]) {
  const values=new Map();
  for(const raw of [...previous,...incoming]){
    const item=normalizeAttachment(raw);if(!item)continue;
    const old=values.get(item.fid);
    if(old?.state==='ready'&&item.state!=='ready')continue;
    values.set(item.fid,item);
  }
  return [...values.values()].slice(0,20);
}
async function fetchAttachment({attachment,fetch,signal,timeoutMs=120000}={}) {
  const value=normalizeAttachment(attachment);if(!value||value.state!=='ready')fail('ATTACHMENT_INVALID');
  const maxBytes=value.kind==='pdf'?MAX_PDF_BYTES:MAX_VIDEO_BYTES;
  const result=await requestBytes({url:value.url,fetch,signal,timeoutMs,maxBytes,accept:value.mime+', application/octet-stream'});
  const declared=String(result.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
  // The official MSS endpoint also returns MP4 as video/mpeg4. Keep the alias
  // limited to resolved MP4 metadata and require the same strict file signature.
  const acceptedMime=[value.mime,'application/octet-stream','binary/octet-stream'].includes(declared)||
    (value.kind==='video'&&value.mime==='video/mp4'&&declared==='video/mpeg4');
  if(!acceptedMime||detectedAttachmentMime(result.bytes)!==value.mime)fail('ATTACHMENT_TYPE');
  return {bytes:result.bytes,mime:value.mime,name:value.name,kind:value.kind};
}
module.exports={AttachmentError,normalizeAttachment,normalizeAttachments,attachmentSearchText,safeAttachmentUrl,
  normalizeMessageAttachments:normalizeAttachments,mergeAttachments,
  normalizeAttachmentMetadata,resolveAttachment,
  fidValue,sourceUrl,metadataUrl,parseMetadata,fetchAttachmentMetadata,fetchAttachment,detectedAttachmentMime,
  MAX_METADATA_BYTES,MAX_PDF_BYTES,MAX_VIDEO_BYTES,ORIGIN,META_PATH,MEDIA_PATH,CALLBACK};
