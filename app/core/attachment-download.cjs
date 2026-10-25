'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { normalizeSource } = require('./attachment-viewer.cjs');
const { detectedAttachmentMime, MAX_ARCHIVE_BYTES, MAX_PDF_BYTES, MAX_VIDEO_BYTES,DOCUMENT_FORMATS,AUDIO_FORMATS,MAX_AUDIO_BYTES } = require('./attachments.cjs');

const FORMATS = Object.freeze({
  ...Object.fromEntries(Object.entries(DOCUMENT_FORMATS).map(([extension,value])=>[value.mime,Object.freeze({kind:'document',name:extension.toUpperCase()+' 文件',extensions:Object.freeze([extension]),limit:value.limit})])),
  ...Object.fromEntries(Object.entries(AUDIO_FORMATS).map(([extension,value])=>[value.mime,Object.freeze({kind:'audio',name:extension.toUpperCase()+' 音频',extensions:Object.freeze([extension]),limit:MAX_AUDIO_BYTES})])),
  'application/zip': Object.freeze({kind:'archive',name:'ZIP 压缩文件',extensions:Object.freeze(['zip']),limit:MAX_ARCHIVE_BYTES}),
  'application/vnd.rar': Object.freeze({kind:'archive',name:'RAR 压缩文件',extensions:Object.freeze(['rar']),limit:MAX_ARCHIVE_BYTES}),
  'application/x-7z-compressed': Object.freeze({kind:'archive',name:'7z 压缩文件',extensions:Object.freeze(['7z']),limit:MAX_ARCHIVE_BYTES}),
  'application/pdf': Object.freeze({kind:'pdf',name:'PDF 文档',extensions:Object.freeze(['pdf']),limit:MAX_PDF_BYTES}),
  'video/mp4': Object.freeze({kind:'video',name:'MP4 视频',extensions:Object.freeze(['mp4','m4v']),limit:MAX_VIDEO_BYTES}),
  'video/webm': Object.freeze({kind:'video',name:'WebM 视频',extensions:Object.freeze(['webm']),limit:MAX_VIDEO_BYTES}),
  'video/quicktime':Object.freeze({kind:'video',name:'MOV 实况视频',extensions:Object.freeze(['mov']),limit:MAX_VIDEO_BYTES}),
});
const ERRORS = Object.freeze({
  source:'附件下载地址无效，请返回消息重新操作。',
  expired:'账号或附件上下文已变化，请重新下载。',
  busy:'已有附件正在下载或保存，请完成后再试。',
  content:'附件内容或格式不支持下载。',
  timeout:'附件下载超时，请重试。',
  extension:'请选择与原文件格式相符的扩展名。',
  save:'附件保存失败，请检查所选文件夹的写入权限。',
});
const TRANSPORT_ERRORS = Object.freeze({
  ATTACHMENT_AUTH:'微博登录已失效，请在官方页面重新登录。',
  ATTACHMENT_DENIED:'微博拒绝本次附件读取，请在官方页面确认访问权限。',
  ATTACHMENT_RATE_LIMIT:'微博限制了本次读取，请稍后再试。',
  ATTACHMENT_REJECTED:'微博未允许本次附件读取。',
  ATTACHMENT_HTTP:'附件暂时无法读取。',
  ATTACHMENT_REDIRECT:'附件跳转地址不在允许范围内。',
  ATTACHMENT_NETWORK:'附件网络读取失败，请稍后再试。',
  ATTACHMENT_TIMEOUT:ERRORS.timeout,
  ATTACHMENT_ABORT:'附件下载已取消。',
  ATTACHMENT_TOO_LARGE:'附件超过读取/下载大小限制（XLSX/音频 20 MB，MD/CSV 5 MB，PDF 50 MB，视频及压缩文件 200 MB）。',
  ATTACHMENT_TYPE:'附件格式暂不支持。可下载 XLSX、MD、CSV、ZIP/RAR/7z、PDF、MP4/MOV/WebM 及受支持的语音。',
});

function safeDownloadName(value,mime) {
  const format=FORMATS[mime];
  if(!format)throw new Error(ERRORS.content);
  const fallback='微阅附件.'+format.extensions[0];
  // Remove path/ADS syntax and bidirectional controls from the suggested name.
  let name=typeof value==='string'?value.replace(/[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,'_').trim().replace(/[. ]+$/,'').slice(0,180):'';
  if(!name||/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])\s*(?:\.|$)/i.test(name))name=fallback;
  if(!format.extensions.includes(path.extname(name).slice(1).toLowerCase()))name=name.replace(/\.[^.]*$/,'')+'.'+format.extensions[0];
  return name;
}
function validateDownload(value) {
  const format=FORMATS[value?.mime];
  if(!format||value.kind!==format.kind||!Buffer.isBuffer(value.bytes)||(value.bytes.length===0&&format.kind!=='document')||
      value.bytes.length>format.limit||detectedAttachmentMime(value.bytes,value.mime)!==value.mime)throw new Error(ERRORS.content);
  return {bytes:value.bytes,mime:value.mime,kind:value.kind,name:safeDownloadName(value.name,value.mime)};
}

// Caller owns the trusted renderer IPC and translates a stored-message source
// into account-scoped transport. No arbitrary URL, extraction or process launch
// exists in this service. At most one buffer/native save dialog is live at once.
function createAttachmentDownload({dialog,getParent,getOwner,readAttachment,writeFile=fs.writeFile,readTimeoutMs=120000}={}) {
  if(typeof dialog?.showSaveDialog!=='function'||typeof getOwner!=='function'||typeof readAttachment!=='function'||
      typeof writeFile!=='function'||!Number.isSafeInteger(readTimeoutMs)||readTimeoutMs<1||readTimeoutMs>120000)throw new Error('附件下载配置无效。');
  let active=null,epoch=0,disposed=false;
  const current=r=>!disposed&&r.epoch===epoch&&r.owner===getOwner();
  const check=r=>{if(!current(r))throw new Error(ERRORS.expired);};
  function download({source}={}) {
    if(disposed)return Promise.reject(new Error(ERRORS.expired));
    const accepted=normalizeSource(source);
    if(!accepted)return Promise.reject(new Error(ERRORS.source));
    if(active){
      if(current(active)&&active.source===accepted)return active.promise;
      return Promise.reject(new Error(ERRORS.busy));
    }
    const r={source:accepted,owner:getOwner(),epoch,controller:new AbortController(),promise:null};
    active=r;
    r.promise=(async()=>{
      let timer;
      try{
        check(r);
        const loaded=await new Promise((resolve,reject)=>{
          timer=setTimeout(()=>{r.controller.abort();reject(new Error(ERRORS.timeout));},readTimeoutMs);
          r.controller.signal.addEventListener('abort',()=>reject(new Error(current(r)?ERRORS.timeout:ERRORS.expired)),{once:true});
          Promise.resolve().then(()=>{check(r);return readAttachment(r.source,{signal:r.controller.signal});}).then(resolve,reject);
        });
        clearTimeout(timer);check(r);
        const value=validateDownload(loaded),format=FORMATS[value.mime];
        const chosen=await dialog.showSaveDialog(getParent?.(),{title:'下载附件 — 选择保存位置',buttonLabel:'保存原文件',defaultPath:value.name,
          filters:[{name:format.name,extensions:[...format.extensions]}],properties:['showOverwriteConfirmation','dontAddToRecent']});
        if(chosen.canceled||!chosen.filePath)return {canceled:true};
        check(r);
        if(!path.isAbsolute(chosen.filePath))throw new Error(ERRORS.save);
        if(!format.extensions.includes(path.extname(chosen.filePath).slice(1).toLowerCase()))throw new Error(ERRORS.extension);
        try {await writeFile(chosen.filePath,value.bytes);}catch{throw new Error(ERRORS.save);}
        return {saved:true,name:path.basename(chosen.filePath),bytes:value.bytes.length,mime:value.mime,kind:value.kind};
      }catch(error){
        if(!current(r))throw new Error(ERRORS.expired);
        throw new Error(TRANSPORT_ERRORS[error?.code]||
          (Object.values(ERRORS).includes(error?.message)?error.message:ERRORS.content));
      }finally{clearTimeout(timer);if(active===r)active=null;}
    })();
    return r.promise;
  }
  function cancelAll(){epoch++;const prior=active;active=null;prior?.controller.abort();}
  function dispose(){disposed=true;cancelAll();}
  return {download,cancelAll,dispose};
}

module.exports={createAttachmentDownload,safeDownloadName,validateDownload,FORMATS,ERRORS,TRANSPORT_ERRORS};
