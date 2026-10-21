'use strict';
// Real Electron acceptance using a generated two-page PDF and silent WebM.
// Never reads accounts, credentials, user attachments or external resources.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const output=path.resolve(process.env.WEIYUE_ATTACHMENT_TEST_OUTPUT||path.join(root,'artifacts/feature-1.1.12/attachment-viewer-integration'));
if(!process.versions.electron){
  const exe=path.resolve(process.env.WEIYUE_ELECTRON||path.join(root,'vendor/runtime/electron.exe'));
  fs.mkdirSync(output,{recursive:true});
  const result=require('node:child_process').spawnSync(exe,[__filename],{env:{...process.env,WEIYUE_ATTACHMENT_TEST_OUTPUT:output},windowsHide:true,stdio:'inherit',timeout:90000});
  if(result.error)throw result.error;process.exitCode=result.status??1;
}else{
  const {app,BrowserWindow,ipcMain,protocol,net,session}=require('electron');
  const {pathToFileURL}=require('node:url');
  const {createAttachmentViewer}=require('../app/core/attachment-viewer.cjs');
  fs.mkdirSync(output,{recursive:true});app.setPath('userData',path.join(output,'isolated-profile'));
  protocol.registerSchemesAsPrivileged([{scheme:'app',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
  app.on('window-all-closed',()=>{});
  const records=[],record=(name,details={})=>records.push({name,passed:true,...details});
  const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  async function wait(fn,label){for(let i=0;i<300;i++){if(await fn())return;await sleep(30);}throw new Error(label);}
  function makePdf(){
    const objects=[
      '<< /Type /Catalog /Pages 2 0 R /OpenAction 7 0 R >>',
      '<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 320] /Resources << >> /Contents 5 0 R >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 320] /Resources << >> /Contents 6 0 R >>',
      '<< /Length 29 >>\nstream\n1 0 0 rg 20 20 160 240 re f\nendstream',
      '<< /Length 29 >>\nstream\n0 0 1 rg 20 20 160 240 re f\nendstream',
      "<< /S /JavaScript /JS (globalThis.pdfActivityExecuted=true) >>"
    ];let body='%PDF-1.7\n',offsets=[0];objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(body));body+=(i+1)+' 0 obj\n'+o+'\nendobj\n';});
    const start=Buffer.byteLength(body);body+='xref\n0 '+(objects.length+1)+'\n0000000000 65535 f \n';
    for(const n of offsets.slice(1))body+=String(n).padStart(10,'0')+' 00000 n \n';
    body+='trailer\n<< /Size '+(objects.length+1)+' /Root 1 0 R >>\nstartxref\n'+start+'\n%%EOF\n';return Buffer.from(body);
  }
  let manager,externalRequests=0,owner='synthetic|1',kind='pdf',videoBytes,saveTarget,consoleErrors=[];
  const timer=setTimeout(()=>app.exit(2),80000);
  app.whenReady().then(async()=>{
    const assetManifest=JSON.parse(fs.readFileSync(path.join(root,'app/pdfjs/assets.json'),'utf8'));
    const pdfFiles=new Map(assetManifest.files.map(x=>['/pdfjs/'+x.path,path.join(root,'app/pdfjs',x.path)]));
    protocol.handle('app',request=>{
      const u=new URL(request.url);if(u.host!=='local')return new Response('Not found',{status:404});
      let file;if(['/attachment-viewer.html','/attachment-viewer.js','/attachment-viewer.css'].includes(u.pathname))file=path.join(root,'app/renderer',u.pathname.slice(1));
      else file=pdfFiles.get(u.pathname);
      if(!file)return new Response('Not found',{status:404});
      const type=/\.m?js$/.test(file)?'text/javascript':file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'application/octet-stream';
      return new Response(fs.readFileSync(file),{headers:{'Content-Type':type,'X-Content-Type-Options':'nosniff'}});
    });
    session.defaultSession.setPermissionRequestHandler((_w,_p,cb)=>cb(false));session.defaultSession.setPermissionCheckHandler(()=>false);
    session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_d,cb)=>{externalRequests++;cb({cancel:true});});
    const producer=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true}});
    await producer.loadURL('data:text/html,<html><body>Generated silent WebM</body></html>');
    const base64=await producer.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
      const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;const context=canvas.getContext('2d');
      const stream=canvas.captureStream(10);const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'});const chunks=[];
      recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
      recorder.onerror=()=>reject(new Error('Synthetic recorder failed'));recorder.onstop=async()=>{stream.getTracks().forEach(t=>t.stop());const b=new Uint8Array(await new Blob(chunks).arrayBuffer());let s='';for(const n of b)s+=String.fromCharCode(n);resolve(btoa(s));};
      let frame=0;const interval=setInterval(()=>{context.fillStyle=frame++%2?'#547f6e':'#a4c6b5';context.fillRect(0,0,320,180);},100);
      recorder.start();setTimeout(()=>{clearInterval(interval);recorder.stop();},1200);
    })`,true);videoBytes=Buffer.from(base64,'base64');producer.close();
    const pdfBytes=makePdf();
    manager=createAttachmentViewer({BrowserWindow,ipcMain,appRoot:path.join(root,'app'),getOwner:()=>owner,
      readAttachment:async()=>kind==='pdf'?{bytes:pdfBytes,mime:'application/pdf',kind,name:'合成两页.pdf'}:{bytes:videoBytes,mime:'video/webm',kind,name:'合成静音视频.webm'},
      dialog:{showSaveDialog:async()=>({canceled:false,filePath:saveTarget})}});
    const source='app://attachment/'+'a'.repeat(32)+'/synthetic/1/0';
    await manager.open({source,title:'合成 PDF 预览',kind:'pdf'});
    let w=BrowserWindow.getAllWindows().find(x=>!x.isDestroyed()),wc=w.webContents;
    wc.on('console-message',(_e,_level,message)=>{consoleErrors.push(message);});
    const run=code=>wc.executeJavaScript(code,true);
    await wait(()=>run('document.getElementById("page-count").textContent==="2" && document.getElementById("notice").hidden'),'PDF did not render');
    const first=await run('document.getElementById("page").toDataURL()');
    assert.equal(await run('typeof require'),'undefined');assert.equal(await run('globalThis.pdfActivityExecuted'),undefined);
    const prefs=wc.getLastWebPreferences();assert.equal(prefs.sandbox,true);assert.equal(prefs.nodeIntegration,false);assert.equal(prefs.webSecurity,true);
    record('sandboxed PDF preview renders first page without executing PDF OpenAction',{pageCount:2});
    await run('document.getElementById("next").click()');
    await wait(()=>run('document.getElementById("page-number").value==="2" && document.getElementById("notice").hidden'),'Second page did not render');
    const second=await run('document.getElementById("page").toDataURL()');assert.notEqual(hash(first),hash(second));
    await run('document.getElementById("previous").click()');
    await wait(()=>run('document.getElementById("page-number").value==="1" && document.getElementById("notice").hidden'),'Previous page failed');
    record('PDF previous and next controls change rendered page');
    const beforeZoom=await run('document.getElementById("zoom").textContent');
    await run('document.getElementById("zoom-out").click()');
    await wait(()=>run('document.getElementById("notice").hidden'),'Zoom did not complete');
    assert.notEqual(await run('document.getElementById("zoom").textContent'),beforeZoom);record('PDF zoom controls render at changed scale');
    saveTarget=path.join(output,'saved-synthetic.pdf');await run('document.getElementById("save").click()');
    await wait(()=>fs.existsSync(saveTarget),'PDF save failed');assert.equal(hash(fs.readFileSync(saveTarget)),hash(pdfBytes));record('PDF original bytes saved unchanged');
    const screenshot=await wc.capturePage();fs.writeFileSync(path.join(output,'synthetic-pdf-preview.png'),screenshot.toPNG());
    kind='video';await manager.open({source:source.replace('/1/','/2/'),title:'合成视频播放',kind:'video'});
    w=BrowserWindow.getAllWindows().find(x=>!x.isDestroyed());wc=w.webContents;
    await wait(()=>run('document.getElementById("video").readyState>=1'),'Video metadata did not load');
    assert.equal(await run('document.getElementById("video").paused'),true);assert.equal(await run('document.getElementById("video").autoplay'),false);
    assert.equal(await run('document.getElementById("video").controls'),true);
    record('video loads metadata with controls and never autoplays',{bytes:videoBytes.length});
    await run('document.getElementById("video").play()');await sleep(250);
    assert.ok(await run('document.getElementById("video").currentTime>0'));
    await run('document.getElementById("video").pause()');record('video plays and pauses on explicit control');
    saveTarget=path.join(output,'saved-synthetic.webm');await run('document.getElementById("save").click()');
    await wait(()=>fs.existsSync(saveTarget),'Video save failed');assert.equal(hash(fs.readFileSync(saveTarget)),hash(videoBytes));record('video original bytes saved unchanged');
    owner='synthetic|2';assert.equal(await run('window.attachmentViewer.call("load").then(()=>false,()=>true)'),true);
    record('account owner change invalidates previous attachment');
    assert.equal(externalRequests,0);record('all preview and playback work offline with zero external requests');
    manager.dispose();clearTimeout(timer);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,checks:records,externalRequests,consoleErrors},null,2));
    console.log(JSON.stringify({passed:true,checks:records.length,output}));app.quit();
  }).catch(error=>{
    manager?.dispose();clearTimeout(timer);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:false,checks:records,error:error.message,externalRequests,consoleErrors},null,2));
    console.error(error.message);app.exit(1);
  });
}
