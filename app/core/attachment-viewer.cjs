'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const {inspectHevcMp4}=require('./video-decoder.cjs');
const VIEWER_URL = 'app://local/attachment-viewer.html';
const CHANNEL = 'weiyue:attachment-viewer';
const LIMITS = Object.freeze({ pdf: 50 * 1024 * 1024, video: 200 * 1024 * 1024 });
const FORMATS = Object.freeze({
  'application/pdf': { kind: 'pdf', name: 'PDF 文档', extensions: ['pdf'] },
  'video/mp4': { kind: 'video', name: 'MP4 视频', extensions: ['mp4', 'm4v'] },
  'video/webm': { kind: 'video', name: 'WebM 视频', extensions: ['webm'] },
});
const ERRORS = Object.freeze({
  source: '附件地址无效，请返回群聊重新打开。',
  expired: '账号或附件上下文已变化，请重新打开。',
  content: '附件加载失败、超出大小限制或格式暂不支持。',
  busy: '附件正在处理中，请稍后重试。',
  save: '保存失败，请检查所选文件夹的写入权限。',
  extension: '请使用与原文件格式相符的扩展名。',
  sender: '附件窗口来源不可信。',
  timeout: '附件读取超时，请重试。',
  action: '不支持的附件操作。',
});
const TRANSPORT_ERRORS=Object.freeze({
  ATTACHMENT_AUTH:'微博登录已失效，请在官方页面重新登录。',
  ATTACHMENT_DENIED:'微博拒绝本次附件读取，请在官方页面确认访问权限。',
  ATTACHMENT_RATE_LIMIT:'微博限制了本次读取，请稍后重试。',
  ATTACHMENT_REJECTED:'微博未允许本次附件读取。',
  ATTACHMENT_HTTP:'附件暂时无法读取。',
  ATTACHMENT_REDIRECT:'附件跳转地址不在允许范围内。',
  ATTACHMENT_NETWORK:'附件网络读取失败，请稍后重试。',
  ATTACHMENT_TIMEOUT:ERRORS.timeout,
  ATTACHMENT_ABORT:'附件读取已取消。',
  ATTACHMENT_TOO_LARGE:'附件超过本地预览大小限制（PDF 50 MB，视频 200 MB）。',
  ATTACHMENT_TYPE:'附件内容或格式暂不支持。当前可预览 PDF、MP4 和 WebM。',
});
function normalizeSource(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\s\\\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== 'app:' || u.host !== 'attachment' || u.username || u.password || u.port || u.search || u.hash) return null;
    const parts = u.pathname.slice(1).split('/').map(decodeURIComponent);
    if (parts.length !== 4 || !/^[a-f0-9]{32}$/.test(parts[0]) || !/^\d{1,3}$/.test(parts[3]) ||
        parts.slice(1,3).some(x => !x || x.length > 256 || /[\u0000-\u001f\u007f]/.test(x))) return null;
    return u.href;
  } catch { return null; }
}
function actualMime(bytes) {
  if (bytes.length >= 8 && /^%PDF-[12]\.\d/.test(bytes.subarray(0, 8).toString('ascii'))) return 'application/pdf';
  if (bytes.length >= 16 && bytes.toString('ascii', 4, 8) === 'ftyp') {
    const size=bytes.readUInt32BE(0);
    if (size < 16 || size > bytes.length || size > 4096 || (size-16)%4) return null;
    const brands = [bytes.toString('ascii',8,12)];
    for (let i=16;i<size;i+=4) brands.push(bytes.toString('ascii',i,i+4));
    if (brands.some(x=>['isom','iso2','iso3','iso4','iso5','iso6','mp41','mp42','avc1','M4V ','dash'].includes(x))) return 'video/mp4';
  }
  if (bytes.length >= 4 && bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))) return 'video/webm';
  return null;
}
function safeName(value,mime) {
  const fallback='微阅附件.'+FORMATS[mime].extensions[0];
  let name=typeof value==='string'?value.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g,'_').replace(/[. ]+$/,'').slice(0,180):'';
  if(!name || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) name=fallback;
  if(!FORMATS[mime].extensions.includes(path.extname(name).slice(1).toLowerCase())) name=name.replace(/\.[^.]*$/,'')+'.'+FORMATS[mime].extensions[0];
  return name;
}
function validateAttachment(value,expectedKind) {
  const format=FORMATS[value?.mime];
  if(!format || value.kind!==format.kind || (expectedKind&&value.kind!==expectedKind) ||
      !Buffer.isBuffer(value.bytes) || !value.bytes.length || value.bytes.length>LIMITS[format.kind] ||
      actualMime(value.bytes)!==value.mime) throw new Error(ERRORS.content);
  return {bytes:Buffer.from(value.bytes),mime:value.mime,kind:format.kind,name:safeName(value.name,value.mime)};
}
function createAttachmentViewer({BrowserWindow,ipcMain,dialog,appRoot,getParent,getOwner,readAttachment,decodeVideo,writeFile=fs.writeFile,readTimeoutMs=120000}={}) {
  if(typeof BrowserWindow!=='function'||typeof ipcMain?.handle!=='function'||typeof dialog?.showSaveDialog!=='function'||
      typeof appRoot!=='string'||typeof getOwner!=='function'||typeof readAttachment!=='function'||
      !Number.isSafeInteger(readTimeoutMs)||readTimeoutMs<1||readTimeoutMs>120000) throw new Error('附件查看器配置无效。');
  const records=new Map();let disposed=false;
  const current=r=>!disposed&&!r.window.isDestroyed()&&records.get(r.webContents)===r&&r.owner===getOwner();
  const check=r=>{if(!current(r))throw new Error(ERRORS.expired);};
  async function load(r,retry) {
    check(r);if(r.conversion)throw new Error(ERRORS.busy);if(r.pending)return r.pending;if(r.attachment&&!retry)return r.attachment;
    r.attachment=null;r.displayAttachment=null;
    r.pending=(async()=>{
      const controller=new AbortController();r.controller=controller;let timer;
      try{
        const wait=new Promise((resolve,reject)=>{
          timer=setTimeout(()=>{controller.abort();reject(new Error(ERRORS.timeout));},readTimeoutMs);
          controller.signal.addEventListener('abort',()=>reject(new Error(current(r)?ERRORS.timeout:ERRORS.expired)),{once:true});
          Promise.resolve().then(()=>{check(r);return readAttachment(r.source,{signal:controller.signal});}).then(resolve,reject);
        });
        const value=await wait;check(r);
        r.attachment=validateAttachment(value,r.kind==='file'?undefined:r.kind);return r.attachment;
      }catch(e){if(!current(r))throw new Error(ERRORS.expired);throw new Error(TRANSPORT_ERRORS[e?.code]||(e?.message===ERRORS.timeout?ERRORS.timeout:ERRORS.content));}
      finally{clearTimeout(timer);r.controller=null;r.pending=null;}
    })();
    return r.pending;
  }
  async function convert(r){
    check(r);if(r.pending||r.saving)throw new Error(ERRORS.busy);if(r.conversion)return r.conversion;
    if(r.displayAttachment)return r.displayAttachment;
    if(typeof decodeVideo!=='function'||r.attachment?.mime!=='video/mp4'||!inspectHevcMp4(r.attachment.bytes))throw new Error(ERRORS.content);
    const controller=new AbortController();r.convertController=controller;
    r.conversion=Promise.resolve().then(async()=>{
      check(r);const value=await decodeVideo({bytes:r.attachment.bytes,mime:r.attachment.mime},{signal:controller.signal});check(r);
      r.displayAttachment=validateAttachment({...value,name:r.attachment.name},'video');return r.displayAttachment;
    }).catch(error=>{
      if(!current(r))throw new Error(ERRORS.expired);
      throw new Error(error?.code==='VIDEO_TIMEOUT'?'本机视频转换超时，可另存原文件。':error?.code==='VIDEO_ABORT'?'本机视频转换已取消。':'本机视频转换失败，可另存原文件后查看。');
    }).finally(()=>{r.convertController=null;r.conversion=null;});
    return r.conversion;
  }
  async function save(r) {
    check(r);if(r.pending||r.conversion||r.saving||!r.attachment)throw new Error(ERRORS.busy);r.saving=true;
    try{
      const value=r.attachment,format=FORMATS[value.mime];
      const chosen=await dialog.showSaveDialog(r.window,{title:'附件另存为',buttonLabel:'保存原文件',defaultPath:value.name,
        filters:[{name:format.name,extensions:[...format.extensions]}],properties:['showOverwriteConfirmation','dontAddToRecent']});
      if(chosen.canceled||!chosen.filePath)return {canceled:true};check(r);
      if(!path.isAbsolute(chosen.filePath))throw new Error(ERRORS.save);
      if(!format.extensions.includes(path.extname(chosen.filePath).slice(1).toLowerCase()))throw new Error(ERRORS.extension);
      await writeFile(chosen.filePath,value.bytes);return {saved:true,name:path.basename(chosen.filePath),bytes:value.bytes.length,mime:value.mime};
    }catch(e){if(!current(r))throw new Error(ERRORS.expired);throw new Error(e?.message===ERRORS.extension?ERRORS.extension:ERRORS.save);}
    finally{r.saving=false;}
  }
  async function route(event,action) {
    const r=records.get(event.sender);
    if(!r||r.window.isDestroyed()||event.senderFrame!==r.webContents.mainFrame||event.senderFrame?.url!==VIEWER_URL)return {ok:false,error:ERRORS.sender};
    try{
      check(r);if(!['load','retry','convert','save','close','maximize','minimize'].includes(action))throw new Error(ERRORS.action);
      if(action==='close'){r.window.close();return {ok:true,value:true};}
      if(action==='maximize'){r.window.isMaximized()?r.window.unmaximize():r.window.maximize();return {ok:true,value:true};}
      if(action==='minimize'){r.window.minimize();return {ok:true,value:true};}
      if(action==='save')return {ok:true,value:await save(r)};
      if(r.saving)throw new Error(ERRORS.busy);
      if(action==='convert')await convert(r);else await load(r,action==='retry');check(r);
      const value=r.displayAttachment||r.attachment;
      return {ok:true,value:{title:r.title,name:r.attachment.name,kind:value.kind,mime:value.mime,byteLength:value.bytes.length,bytes:Uint8Array.from(value.bytes),
        converted:!!r.displayAttachment,canConvert:!r.displayAttachment&&typeof decodeVideo==='function'&&r.attachment.mime==='video/mp4'&&!!inspectHevcMp4(r.attachment.bytes)}};
    }catch(e){return {ok:false,error:[...Object.values(ERRORS),...Object.values(TRANSPORT_ERRORS),'本机视频转换超时，可另存原文件。','本机视频转换已取消。','本机视频转换失败，可另存原文件后查看。'].includes(e?.message)?e.message:ERRORS.content};}
  }
  ipcMain.handle(CHANNEL,route);
  async function open({source,title,kind}={}) {
    if(disposed)throw new Error(ERRORS.expired);
    const accepted=normalizeSource(source);
    if(!accepted||!['file','pdf','video'].includes(kind))throw new Error(ERRORS.source);
    for(const r of records.values())if(current(r)&&r.source===accepted){if(r.window.isMinimized())r.window.restore();r.window.focus();return {opened:true};}
    closeAll();
    const window=new BrowserWindow({width:1180,height:860,minWidth:720,minHeight:520,frame:false,resizable:true,show:false,
      parent:getParent?.(),title:kind==='video'?'视频播放 — 微阅':'文件预览 — 微阅',backgroundColor:'#15191c',autoHideMenuBar:true,
      webPreferences:{preload:path.join(appRoot,'attachment-viewer-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,spellcheck:false}});
    const wc=window.webContents;
    const r={window,webContents:wc,owner:getOwner(),source:accepted,kind,title:typeof title==='string'?title.replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,180):'附件预览',attachment:null,displayAttachment:null,pending:null,conversion:null,convertController:null,saving:false,controller:null};
    records.set(wc,r);wc.setWindowOpenHandler(()=>({action:'deny'}));
    wc.on('will-navigate',e=>e.preventDefault());wc.on('will-attach-webview',e=>e.preventDefault());
    wc.on('before-input-event',(event,input)=>{if(input.type==='keyDown'&&input.key==='Escape'){event.preventDefault();window.close();}});
    window.on('closed',()=>{records.delete(wc);r.controller?.abort();r.convertController?.abort();r.attachment=null;r.displayAttachment=null;});
    try{await window.loadURL(VIEWER_URL);check(r);window.show();return {opened:true};}
    catch{if(!window.isDestroyed())window.close();throw new Error(ERRORS.content);}
  }
  function closeAll(){for(const r of [...records.values()]){records.delete(r.webContents);r.controller?.abort();r.convertController?.abort();r.attachment=null;r.displayAttachment=null;if(!r.window.isDestroyed())r.window.close();}}
  function dispose(){closeAll();disposed=true;ipcMain.removeHandler?.(CHANNEL);}
  return {open,closeAll,dispose};
}
module.exports={createAttachmentViewer,normalizeSource,validateAttachment,actualMime,safeName,VIEWER_URL,CHANNEL,LIMITS,FORMATS,ERRORS};
