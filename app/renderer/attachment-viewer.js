'use strict';
const $=id=>document.getElementById(id);
const viewport=$('viewport'),canvas=$('page'),video=$('video');
let documentTask=null,pdf=null,renderTask=null,renderChain=Promise.resolve(),blobUrl=null,epoch=0,renderEpoch=0;
let pageNumber=1,pageCount=0,scale=1,fitted=true,saving=false,converting=false,hasOriginal=false,toastTimer;
const pdfButtons=['previous','next','zoom-in','zoom-out','fit'].map($);
function toast(text){clearTimeout(toastTimer);$('toast').textContent=text;$('toast').hidden=false;toastTimer=setTimeout(()=>{$('toast').hidden=true;},6000);}
function showStatus(text,retry=false){$('notice').hidden=false;$('status').textContent=text;$('retry').hidden=!retry;$('convert').hidden=true;}
function controls(){
  $('previous').disabled=!pdf||pageNumber<=1;$('next').disabled=!pdf||pageNumber>=pageCount;
  $('zoom-in').disabled=!pdf||scale>=3;$('zoom-out').disabled=!pdf||scale<=.25;$('fit').disabled=!pdf;
  $('page-number').disabled=!pdf;$('page-number').value=String(pageNumber);$('page-number').max=String(pageCount);
  $('page-count').textContent=String(pageCount||'—');$('zoom').textContent=Math.round(scale*100)+'%';
}
async function clean(){
  renderEpoch++;renderTask?.cancel();renderTask=null;
  video.pause();video.removeAttribute('src');video.load();if(blobUrl){URL.revokeObjectURL(blobUrl);blobUrl=null;}
  const task=documentTask;documentTask=null;pdf=null;pageCount=0;
  if(task)try{await task.destroy();}catch{}
  $('pdf-stage').hidden=true;video.hidden=true;$('pdf-controls').hidden=true;controls();
}
function timeout(promise,ms,onTimeout){
  let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>{onTimeout?.();reject(new Error('timeout'));},ms);})]).finally(()=>clearTimeout(timer));
}
function requestRender(){
  const currentEpoch=epoch,currentRender=++renderEpoch;
  renderTask?.cancel();
  renderChain=renderChain.catch(()=>{}).then(async()=>{
    if(!pdf||currentEpoch!==epoch||currentRender!==renderEpoch)return;
    showStatus('正在渲染 PDF 页面…');
    try{
      const activePdf=pdf,activeLoadingTask=documentTask;
      const page=await timeout(activePdf.getPage(pageNumber),20000,()=>activeLoadingTask?.destroy());
      if(currentEpoch!==epoch||currentRender!==renderEpoch)return;
      const natural=page.getViewport({scale:1});
      if(!Number.isFinite(natural.width)||!Number.isFinite(natural.height)||natural.width<=0||natural.height<=0)throw new Error('dimensions');
      if(fitted)scale=Math.max(.25,Math.min(3,(viewport.clientWidth-56)/natural.width));
      const view=page.getViewport({scale});
      let ratio=Math.min(devicePixelRatio||1,2,8192/view.width,8192/view.height,Math.sqrt(16*1024*1024/(view.width*view.height)));
      if(!Number.isFinite(ratio)||ratio<=0)throw new Error('dimensions');
      const pixelWidth=Math.max(1,Math.floor(view.width*ratio)),pixelHeight=Math.max(1,Math.floor(view.height*ratio));
      canvas.width=pixelWidth;canvas.height=pixelHeight;canvas.style.width=Math.round(view.width)+'px';canvas.style.height=Math.round(view.height)+'px';
      $('pdf-stage').hidden=false;
      // Only page paint operators are used. No annotations, actions, scripting,
      // forms, attachment execution or links are instantiated from the PDF.
      const activeRenderTask=page.render({canvasContext:canvas.getContext('2d',{alpha:false}),viewport:view,
        transform:[ratio,0,0,ratio,0,0],annotationMode:0,background:'rgb(255,255,255)'});
      renderTask=activeRenderTask;
      try{await timeout(activeRenderTask.promise,20000,()=>activeRenderTask.cancel());}
      finally{if(renderTask===activeRenderTask)renderTask=null;}
      if(currentEpoch!==epoch||currentRender!==renderEpoch)return;
      page.cleanup();$('notice').hidden=true;controls();
      $('info').textContent='PDF · 本机预览 · 未执行文档活动内容';
    }catch(e){
      if(currentEpoch!==epoch||currentRender!==renderEpoch||e?.name==='RenderingCancelledException')return;
      $('pdf-stage').hidden=true;showStatus('此 PDF 页面无法预览或渲染超时。可另存原文件后查看。',true);
    }
  });
}
async function showPdf(bytes,currentEpoch){
  const lib=await import('./pdfjs/build/pdf.mjs');
  if(currentEpoch!==epoch)return;
  lib.GlobalWorkerOptions.workerSrc='app://local/pdfjs/build/pdf.worker.mjs';
  const activeLoadingTask=lib.getDocument({data:bytes,verbosity:0,isEvalSupported:false,enableXfa:false,
    useWasm:false,disableWorkerRendering:true,disableRange:true,disableStream:true,disableAutoFetch:true,
    stopAtErrors:true,maxImageSize:32*1024*1024,canvasMaxAreaInBytes:64*1024*1024,
    isImageDecoderSupported:false,disableFontFace:false,useSystemFonts:true,
    cMapUrl:'app://local/pdfjs/cmaps/',cMapPacked:true,standardFontDataUrl:'app://local/pdfjs/standard_fonts/',
    useWorkerFetch:true});
  documentTask=activeLoadingTask;
  activeLoadingTask.onPassword=()=>{activeLoadingTask.destroy();if(currentEpoch===epoch)showStatus('此 PDF 需要密码，暂不在应用内解密。可另存原文件后查看。');};
  try{
    const loaded=await timeout(activeLoadingTask.promise,30000,()=>activeLoadingTask.destroy());
    if(currentEpoch!==epoch)return;
    if(!Number.isSafeInteger(loaded.numPages)||loaded.numPages<1||loaded.numPages>2000){await activeLoadingTask.destroy();throw new Error('pages');}
    pdf=loaded;pageCount=pdf.numPages;pageNumber=1;scale=1;fitted=true;
    $('pdf-controls').hidden=false;controls();requestRender();
  }catch{if(currentEpoch===epoch)showStatus('此 PDF 暂时无法预览（文件损坏、加密或超过预览限制）。可另存原文件。',true);}
}
async function load(retry=false,convert=false){
  if(converting)return;if(convert)converting=true;
  if(!convert)hasOriginal=false;
  const currentEpoch=++epoch;await clean();if(currentEpoch!==epoch)return;
  $('save').disabled=true;showStatus(convert?'正在本机准备兼容预览；原文件保持不变。关闭窗口可取消。':'正在读取附件…');
  try{
    const value=await window.attachmentViewer.call(convert?'convert':retry?'retry':'load');
    if(currentEpoch!==epoch)return;
    if(!(value.bytes instanceof Uint8Array)||!['pdf','video'].includes(value.kind))throw new Error('invalid');
    hasOriginal=true;
    $('title').textContent=value.title||'附件预览';$('filename').textContent=value.name;
    $('info').textContent=(value.byteLength/1024/1024).toFixed(2)+' MB · 文件仅在本机预览';$('save').disabled=saving;
    if(value.kind==='pdf')await showPdf(value.bytes,currentEpoch);
    else{
      if(!['video/mp4','video/webm'].includes(value.mime))throw new Error('invalid');
      blobUrl=URL.createObjectURL(new Blob([value.bytes],{type:value.mime}));
      video.autoplay=false;video.muted=false;video.hidden=false;
      let fallbackStarted=false;
      const unsupported=()=>{
        if(currentEpoch!==epoch)return;video.pause();video.muted=true;video.hidden=true;
        if(value.canConvert&&!convert&&!fallbackStarted){
          fallbackStarted=true;showStatus('正在本机准备兼容预览，原文件保持不变。关闭窗口可取消。');
          queueMicrotask(()=>{if(currentEpoch===epoch&&!converting)void load(false,true);});return;
        }
        showStatus(value.canConvert?'此短视频使用 HEVC 编码。可在本机生成兼容预览，原文件保持不变。':'此视频暂时无法播放（编码不受支持或文件损坏）。可另存原文件后查看。',true);
        $('convert').hidden=!value.canConvert;$('convert').disabled=false;
      };
      video.onloadedmetadata=()=>{if(currentEpoch===epoch){if(!video.videoWidth||!video.videoHeight){unsupported();return;}$('notice').hidden=true;
        $('info').textContent=(value.converted?'本机兼容预览 · 另存为仍是原文件':'视频')+' · '+(value.byteLength/1024/1024).toFixed(2)+' MB';
        // Opening this preview is the user's play action. Wait for real video
        // dimensions so an unsupported HEVC track cannot autoplay audio only.
        // Keep browser playback policy and normal controls intact.
        Promise.resolve(video.play()).catch(()=>{if(currentEpoch===epoch&&!video.error)toast('自动播放未获允许，请点播放器中的播放按钮。');});
      }};
      video.onerror=unsupported;
      video.src=blobUrl;video.load();
    }
  }catch(e){if(currentEpoch===epoch)showStatus(e?.message==='invalid'?'附件数据格式无效。':e?.message||'附件加载失败，请重试。',true);}
  finally{if(convert)converting=false;if(currentEpoch===epoch)$('save').disabled=saving||!hasOriginal;}
}
function windowAction(action){window.attachmentViewer.call(action).catch(e=>toast(e.message));}
for(const action of ['close','minimize','maximize'])$(action).addEventListener('click',()=>windowAction(action));
$('retry').addEventListener('click',()=>load(true));
$('convert').addEventListener('click',()=>{if(!converting)void load(false,true);});
$('save').addEventListener('click',async()=>{
  if(saving)return;saving=true;$('save').disabled=true;
  try{const result=await window.attachmentViewer.call('save');if(result.saved)toast('已保存原文件：'+result.name);}
  catch(e){toast(e.message||'保存失败。');}finally{saving=false;$('save').disabled=false;}
});
function go(next){if(!pdf)return;pageNumber=Math.max(1,Math.min(pageCount,Math.floor(next)||1));controls();viewport.scrollTop=0;requestRender();}
$('previous').addEventListener('click',()=>go(pageNumber-1));$('next').addEventListener('click',()=>go(pageNumber+1));
$('page-number').addEventListener('change',event=>go(Number(event.target.value)));
function zoom(delta){if(!pdf)return;fitted=false;scale=Math.max(.25,Math.min(3,scale+delta));controls();requestRender();}
$('zoom-in').addEventListener('click',()=>zoom(.25));$('zoom-out').addEventListener('click',()=>zoom(-.25));
$('fit').addEventListener('click',()=>{fitted=true;requestRender();});
let resizeTimer;new ResizeObserver(()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(pdf&&fitted)requestRender();},120);}).observe(viewport);
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'){event.preventDefault();windowAction('close');}
  if(!pdf||event.target instanceof HTMLInputElement||event.ctrlKey||event.altKey||event.metaKey)return;
  if(event.key==='PageDown'){event.preventDefault();go(pageNumber+1);}
  if(event.key==='PageUp'){event.preventDefault();go(pageNumber-1);}
});
window.addEventListener('beforeunload',()=>{epoch++;void clean();});
void load();

