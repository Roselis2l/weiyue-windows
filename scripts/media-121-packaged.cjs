'use strict';
// Runs the unchanged app/EXE in a temporary import account. Network and Save As
// are mocked. --hevc is an explicitly supplied local compatibility fixture;
// optional --image is an authorized PNG sample (never copied into the package).
// HEIF uses the existing public upstream fixture; PDF and account data are synthetic.
// No screenshots are taken, including when authorized private media is provided.
// Navigation is explicit: preserve full reading state before it; verify protected
// high-water/unread values during it; then preserve exact settled state and DOM.
// --source-root optionally uses an immutable local source snapshot with app/docs.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),args=process.argv.slice(2),arg=name=>args.find(v=>v.startsWith(name+'='))?.slice(name.length+1)||(args.includes(name)?args[args.indexOf(name)+1]:null);
const sourceRoot=path.resolve(arg('--source-root')||root);
const requested=arg('--exe'),packaged=!!requested,exe=path.resolve(requested||arg('--runtime')||path.join(root,'vendor/runtime/electron.exe'));
const appRoot=packaged?path.join(path.dirname(exe),'resources/app/app'):path.join(sourceRoot,'app');
const harness=fs.mkdtempSync(path.join(os.tmpdir(),'weiyue-media121-')),dataDir=path.join(harness,'data');fs.mkdirSync(dataDir);
const output=path.resolve(arg('--output')||path.join(root,'artifacts/feature-1.1.21','media-acceptance-'+Date.now()));fs.mkdirSync(output,{recursive:true});
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const manifest=base=>Object.fromEntries(fs.readdirSync(base,{recursive:true}).filter(n=>fs.lstatSync(path.join(base,n)).isFile()).map(n=>[n.replace(/\\/g,'/'),hash(fs.readFileSync(path.join(base,n)))]));
const before=manifest(appRoot),exeHash=hash(fs.readFileSync(exe));
const {Store}=require(path.join(appRoot,'core/store.cjs')),store=new Store(path.join(dataDir,'accounts'));
const account='import-media121-bootstrap',group='9007199254741170001',ids=['9007199254741170101','9007199254741170102','9007199254741170103','9007199254741170104','9007199254741190105','9007199254741190106','9007199254741190107'];
store.ensureAccount({id:account,name:'媒体验收合成账号',kind:'import'});store.mergeMessages(account,[{id:group,name:'媒体验收合成群',selected:true}],[{id:'9007199254741170100',groupId:group,senderId:'117',senderName:'合成成员',time:1792530000000,text:'无远程资源启动记录'}],{history:true});store.update(account,s=>{s.settings.autoSyncEnabled=false;});fs.writeFileSync(path.join(dataDir,'preferences.json'),JSON.stringify({activeId:account}));
const checks=[],errors=[],traces=[];let application,page,failure;
const check=(name,details)=>{checks.push({name,...(details?{details}:{})});console.log('PASS '+name);};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await pause(80);}throw Error(label);}
const api=(action,payload={})=>page.evaluate(({action,payload})=>window.api.call(action,payload),{action,payload});
function mocks({app,net,session,dialog,shell,BrowserWindow},f){
 const {EventEmitter}=process.getBuiltinModule('node:events'),{Readable}=process.getBuiltinModule('node:stream');
 const state=globalThis.__media121={requests:[],blocked:[],saves:[],saveQueue:[],links:[],failVideo:false};
 app.on('web-contents-created',(_,wc)=>wc.setAudioMuted(true));for(const w of BrowserWindow.getAllWindows())w.webContents.setAudioMuted(true);
 const nativeRequest=net.request.bind(net),nativeFetch=net.fetch.bind(net),png=Buffer.from(f.png,'base64'),video=Buffer.from(f.video,'base64'),nativeVideo=Buffer.from(f.nativeVideo,'base64'),zip=Buffer.from(f.zip,'base64'),mislabeled=Buffer.from(f.mislabeled,'base64'),heic=Buffer.from(f.heic,'base64'),pdf=Buffer.from(f.pdf,'base64');
 net.request=options=>{const url=String(typeof options==='string'?options:options.url);if(/^(app|file):/.test(url))return nativeRequest(options);
  const req=new EventEmitter();let aborted=false;req.setHeader=()=>{};req.abort=()=>{aborted=true;req.emit('abort');};req.end=()=>setImmediate(()=>{
   if(aborted)return;const u=new URL(url);let bytes,mime,status=200;
   if(u.origin==='https://wx1.sinaimg.cn'&&u.pathname==='/media121-synthetic.png'){bytes=png;mime='image/png';state.requests.push('image');}
   else if(u.origin==='https://wx1.sinaimg.cn'&&u.pathname==='/media121-mislabeled.jpg'){bytes=mislabeled;mime='image/jpeg';state.requests.push('mislabeled-image');}
   else if(u.origin==='https://wx1.sinaimg.cn'&&u.pathname==='/media121-heic.jpg'){bytes=heic;mime='image/jpeg';state.requests.push('heic-image');}
   else if(u.origin==='https://upload.api.weibo.com'&&u.pathname==='/2/mss/msget'&&u.searchParams.get('fid')==='117001'){bytes=zip;mime='application/zip';state.requests.push('archive');}
   else if(u.origin==='https://upload.api.weibo.com'&&u.pathname==='/2/mss/msget'&&u.searchParams.get('fid')==='117002'){bytes=state.failVideo?Buffer.from('denied'):video;mime=state.failVideo?'text/plain':'video/mp4';status=state.failVideo?403:200;state.requests.push('video');}
   else if(u.origin==='https://upload.api.weibo.com'&&u.pathname==='/2/mss/msget'&&u.searchParams.get('fid')==='119003'){bytes=pdf;mime='application/pdf';state.requests.push('pdf');}
   else if(u.origin==='https://upload.api.weibo.com'&&u.pathname==='/2/mss/msget'&&u.searchParams.get('fid')==='119004'){bytes=nativeVideo;mime='video/webm';state.requests.push('native-webm');}
   else{state.blocked.push('unexpected-request');req.emit('error',Error('TEST_NETWORK_BLOCKED'));return;}
   const response=Readable.from([bytes]);response.statusCode=status;response.headers={'content-type':[mime],'content-length':[String(bytes.length)]};req.emit('response',response);
  });return req;};
 net.fetch=(u,o)=>/^(app|file):/.test(String(u))?nativeFetch(u,o):(state.blocked.push('net-fetch'),Promise.reject(Error('TEST_NETWORK_BLOCKED')));
 globalThis.fetch=()=>{state.blocked.push('global-fetch');throw Error('TEST_NETWORK_BLOCKED');};
 const attach=s=>{s.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_,cb)=>{state.blocked.push('external-request');cb({cancel:true});});};attach(session.defaultSession);app.on('session-created',attach);
 dialog.showOpenDialog=async()=>({canceled:false,filePaths:[f.importFile]});dialog.showSaveDialog=async(_,options)=>{state.saves.push({name:options.defaultPath,filters:options.filters});return state.saveQueue.shift()||{canceled:true};};
 dialog.showMessageBox=async()=>({response:0});shell.openExternal=async url=>{state.links.push(url);};
}
async function viewer(kind){await until(()=>application.windows().some(w=>w.url()==='app://local/'+kind+'-viewer.html'),'VIEWER_NOT_OPEN');const w=application.windows().find(w=>w.url()==='app://local/'+kind+'-viewer.html');w.setDefaultTimeout(20000);return w;}
async function closeViewer(w){await w.evaluate(()=>document.getElementById('close').click());await until(()=>w.isClosed(),'VIEWER_NOT_CLOSED');}


let fixedVisual;
function protectedRead(states){return Object.fromEntries(Object.entries(states).map(([id,s])=>[id,{readThroughId:s.readThroughId,unreadCount:s.unreadCount,firstUnreadId:s.firstUnreadId,latestMessageId:s.latestMessageId,messageCount:s.messageCount}]));}
function stableVisual(t){return{scrollTop:t.visual.scrollTop,scrollHeight:t.visual.scrollHeight,clientHeight:t.visual.clientHeight,scroll:t.visual.scroll,reference:t.visual.reference,referenceButton:t.visual.referenceButton,cards:t.visual.cards,images:t.visual.images};}

async function trace(stage){
 const visual=await page.evaluate(refId=>{
  const scroll=document.getElementById('message-scroll'),ref=document.querySelector('[data-message-id="'+refId+'"]'),image=ref?.querySelector('.image-button'),rect=el=>{if(!el)return null;const r=el.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height};};
  return{now:performance.now(),scrollTop:scroll.scrollTop,scrollHeight:scroll.scrollHeight,clientHeight:scroll.clientHeight,scroll:rect(scroll),reference:rect(ref),referenceButton:rect(image),cards:[...scroll.querySelectorAll('[data-message-id]')].map(el=>({id:el.dataset.messageId,rect:rect(el)})),images:[...scroll.querySelectorAll('.message-image')].map(el=>({complete:el.complete,natural:[el.naturalWidth,el.naturalHeight],rect:rect(el)})),scrollEvents:globalThis.__mediaDiagScrolls||[]};
 },ids[1]);
 const state=await api('state');traces.push({stage,visual,readPositions:state.readPositions,readStates:state.readStates});console.log('TRACE '+stage+' top='+visual.scrollTop+' referenceButton='+JSON.stringify(visual.referenceButton));
}

function upstreamHeic(){
 const base=packaged?path.join(path.dirname(appRoot),'docs'):path.join(sourceRoot,'docs');
 const tar=require('node:zlib').gunzipSync(fs.readFileSync(path.join(base,'HEIF/sources/libheif-1.23.5-413e2a8.tar.gz')),{maxOutputLength:100*1024*1024});
 for(let offset=0;offset+512<=tar.length;){const header=tar.subarray(offset,offset+512);if(header.every(v=>!v))break;const name=header.subarray(0,100).toString().split('\0')[0],size=parseInt(header.subarray(124,136).toString().replace(/\0.*$/,''),8);assert(Number.isSafeInteger(size)&&size>=0&&offset+512+size<=tar.length,'INVALID_UPSTREAM_ARCHIVE');if(name.endsWith('/examples/example.heic'))return Buffer.from(tar.subarray(offset+512,offset+512+size));offset+=512+Math.ceil(size/512)*512;}
 throw Error('UPSTREAM_HEIC_FIXTURE_MISSING');
}
function syntheticPdf(){
 const streams=['1 0 0 rg 20 20 160 240 re f\n','0 0 1 rg 20 20 160 240 re f\n'];
 const objects=['<< /Type /Catalog /Pages 2 0 R /OpenAction 7 0 R >>','<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 320] /Resources << >> /Contents 5 0 R >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 320] /Resources << >> /Contents 6 0 R >>',...streams.map(s=>'<< /Length '+Buffer.byteLength(s)+' >>\nstream\n'+s+'endstream'),"<< /S /JavaScript /JS (globalThis.pdfActivityExecuted=true) >>"];
 let body='%PDF-1.7\n',offsets=[0];objects.forEach((value,i)=>{offsets.push(Buffer.byteLength(body));body+=(i+1)+' 0 obj\n'+value+'\nendobj\n';});const start=Buffer.byteLength(body);body+='xref\n0 '+(objects.length+1)+'\n0000000000 65535 f \n';for(const offset of offsets.slice(1))body+=String(offset).padStart(10,'0')+' 00000 n \n';body+='trailer\n<< /Size '+(objects.length+1)+' /Root 1 0 R >>\nstartxref\n'+start+'\n%%EOF\n';return Buffer.from(body);
}
(async()=>{
 const hevcFile=arg('--hevc');if(!hevcFile)throw Error('Supply --hevc with an explicitly authorized local HEVC fixture.');
 const video=fs.readFileSync(path.resolve(hevcFile));assert.ok(require(path.join(appRoot,'core/video-decoder.cjs')).inspectHevcMp4(video),'LOCAL_HEVC_INVALID');
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;require(path.join(root,'scripts/windows-runtime-check.cjs')).assertWindowsRuntimeReadable(exe);
 application=await _electron.launch({executablePath:exe,args:[...(packaged?[]:[sourceRoot]),'--data-dir='+dataDir],cwd:sourceRoot,env,timeout:45000});page=await application.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
 await page.waitForFunction(()=>typeof window.api?.call==='function');const initial=await api('state');assert.equal(initial.account.id,account);assert.equal(initial.dataRoot,dataDir);assert.equal(initial.sessionReady,false);assert.equal(initial.credentials.ai,false);assert.equal(initial.credentials.notion,false);
 const launch=await application.evaluate(({app,BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0],p=w.webContents.getLastWebPreferences();return{packaged:app.isPackaged,version:app.getVersion(),exec:process.execPath,appPath:app.getAppPath(),sandbox:p.sandbox,contextIsolation:p.contextIsolation,nodeIntegration:p.nodeIntegration};});assert.equal(launch.packaged,packaged);assert.equal(launch.version,JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version,'APPLICATION_VERSION_MISMATCH');assert.ok(launch.sandbox&&launch.contextIsolation&&!launch.nodeIntegration);check('Actual application starts isolated with no real credentials',launch);
 const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=128;c.height=72;const x=c.getContext('2d');x.fillStyle='#168c68';x.fillRect(0,0,128,72);x.fillStyle='#fff';x.fillRect(32,18,64,36);return c.toDataURL('image/png').split(',')[1];});
 const nativeVideo=await page.evaluate(()=>new Promise((resolve,reject)=>{
  const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;const context=canvas.getContext('2d'),stream=canvas.captureStream(10),recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'}),chunks=[];let frame=0;
  const paint=()=>{context.fillStyle=frame++%2?'#547f6e':'#a4c6b5';context.fillRect(0,0,320,180);};paint();const interval=setInterval(paint,100);
  recorder.ondataavailable=event=>{if(event.data.size)chunks.push(event.data);};recorder.onerror=()=>{clearInterval(interval);stream.getTracks().forEach(track=>track.stop());reject(Error('SYNTHETIC_WEBM_FAILED'));};
  recorder.onstop=async()=>{clearInterval(interval);stream.getTracks().forEach(track=>track.stop());const bytes=new Uint8Array(await new Blob(chunks).arrayBuffer());let text='';for(const value of bytes)text+=String.fromCharCode(value);resolve(btoa(text));};recorder.start();setTimeout(()=>recorder.stop(),1200);
 }));
 const localImage=arg('--image'),mislabeled=localImage?fs.readFileSync(path.resolve(localImage)):Buffer.from(png,'base64'),heic=upstreamHeic(),pdf=syntheticPdf();
 assert(mislabeled.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'LOCAL_IMAGE_MUST_BE_PNG');
 const imageWidth=mislabeled.readUInt32BE(16),imageHeight=mislabeled.readUInt32BE(20);
 check('Local fixture roles are explicit; no private fixture is bundled',{image:localImage?'authorized-local-sample':'synthetic-canvas',imageBytes:mislabeled.length,imageSha256:hash(mislabeled),heif:'existing-public-upstream-example',heifBytes:heic.length,heifSha256:hash(heic),video:'explicit-authorized-local-fixture',videoBytes:video.length,videoSha256:hash(video),screenshots:0});
 const zip=Buffer.alloc(22);zip.writeUInt32LE(0x06054b50);const source=fid=>'https://upload.api.weibo.com/2/mss/msget?source=209678993&fid='+fid;
 const message=(i,text,extra)=>({id:ids[i],groupId:group,senderId:'117',senderName:'合成成员',time:1792530000000+i*60000,text,mediaVersion:1,attachmentVersion:1,referenceVersion:1,...extra});
 const fixture={groups:[{id:group,name:'媒体验收合成群',selected:true}],messages:[
  message(0,'合成压缩包，仅保存不执行',{attachments:[{kind:'archive',fid:'117001',state:'ready',name:'示例资料.zip',mime:'application/zip',url:source('117001'),size:zip.length}]}),
  message(1,'明确引用的微博配图',{references:[{kind:'post',relation:'repost',state:'ready',id:'117100',url:'https://m.weibo.cn/detail/117100',author:'合成原作者',text:'完全合成的引用内容',images:[{url:'https://wx1.sinaimg.cn/media121-synthetic.png',width:128,height:72}]}]}),
  message(2,'合成实况照片，保留原始文件',{attachments:[{kind:'video',fid:'117002',state:'ready',name:'合成实况照片.mp4',livePhoto:true,mime:'video/mp4',url:source('117002'),size:video.length}]}),
  message(3,'完全合成的原生静音视频',{attachments:[{kind:'video',fid:'119004',state:'ready',name:'合成原生视频.webm',mime:'video/webm',url:source('119004'),size:Buffer.from(nativeVideo,'base64').length}]}),
  message(4,'响应类型与真实签名不同的图片测试',{images:[{url:'https://wx1.sinaimg.cn/media121-mislabeled.jpg',width:imageWidth,height:imageHeight}]}),
  message(5,'公开上游 HEIF 兼容测试',{images:[{url:'https://wx1.sinaimg.cn/media121-heic.jpg'}]}),
  message(6,'完全合成的两页 PDF',{attachments:[{kind:'pdf',fid:'119003',state:'ready',name:'合成两页.pdf',mime:'application/pdf',url:source('119003'),size:pdf.length}]}),
 ]};const importFile=path.join(harness,'synthetic-media.json');fs.writeFileSync(importFile,JSON.stringify(fixture));
 await application.evaluate(mocks,{png,video:video.toString('base64'),nativeVideo,zip:zip.toString('base64'),mislabeled:mislabeled.toString('base64'),heic:heic.toString('base64'),pdf:pdf.toString('base64'),importFile});await page.locator('#import-button').click();await until(async()=>(await api('state')).account.id!==account,'IMPORT_NOT_ACTIVE');await page.locator('[data-group-id="'+group+'"]').click();
 const archive=page.locator('[data-message-id="'+ids[0]+'"] .attachment-open');await archive.click();await until(()=>application.evaluate(()=>globalThis.__media121.saves.length===1),'SAVE_DIALOG_CANCEL');assert.equal(fs.readdirSync(harness).some(n=>n.endsWith('.zip')),false);check('Archive cancel writes zero files');
 const archivePath=path.join(harness,'saved-synthetic.zip');await application.evaluate((_,file)=>{globalThis.__media121.saveQueue.push({canceled:false,filePath:file});},archivePath);await archive.click();await until(()=>fs.existsSync(archivePath)&&fs.statSync(archivePath).size===zip.length,'ARCHIVE_NOT_SAVED');assert.deepEqual(fs.readFileSync(archivePath),zip);check('Archive Save As uses exact validated original bytes');
 const ref=page.locator('[data-message-id="'+ids[1]+'"] .referenced-post');await ref.locator('.image-button').click();let w=await viewer('image');await w.waitForFunction(()=>{const i=document.getElementById('image');return i.complete&&i.naturalWidth===128;});check('Reference image opens actual full image viewer');await closeViewer(w);
 await ref.locator('.post-original-link').click();await until(()=>application.evaluate(()=>globalThis.__media121.links.length===1),'REFERENCE_NOT_OPENED');assert.deepEqual(await application.evaluate(()=>globalThis.__media121.links),['https://m.weibo.cn/detail/117100']);check('Reference post uses its own exact official link');
 const started=Date.now();await page.locator('[data-message-id="'+ids[2]+'"] .attachment-open').click();w=await viewer('attachment');await w.waitForFunction(()=>{const v=document.getElementById('video');return v.videoWidth>0&&v.readyState>=2&&!v.paused&&v.currentTime>0;},{},{timeout:120000});
 const state=await w.locator('#video').evaluate(v=>({width:v.videoWidth,height:v.videoHeight,duration:v.duration,paused:v.paused,controls:v.controls}));assert.ok(state.width>0&&!state.paused&&state.controls);check('Opening HEVC preview automatically converts and plays with real main IPC',{...state,elapsedMs:Date.now()-started});
 const audioMuted=await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().filter(w=>w.webContents.getURL()==='app://local/attachment-viewer.html').every(w=>w.webContents.isAudioMuted()));assert.equal(audioMuted,true);
 await page.evaluate(()=>{globalThis.__mediaDiagScrolls=[];document.getElementById('message-scroll').addEventListener('scroll',()=>{const s=document.getElementById('message-scroll');globalThis.__mediaDiagScrolls.push({time:performance.now(),top:s.scrollTop,height:s.scrollHeight});});});await trace('baseline-before-reading');let readingBefore=await api('state');await pause(500);const playback=await w.locator('#video').evaluate(v=>{v.pause();return{time:v.currentTime,frames:v.getVideoPlaybackQuality().totalVideoFrames,paused:v.paused,error:v.error?.code||null};});assert.ok(playback.time>0&&playback.frames>0&&playback.paused);assert.equal(playback.error,null);check('Automatic playback advances decoded frames; explicit pause works; output pre-muted by test',playback);
 const savedVideo=path.join(harness,'saved-original.mp4');await application.evaluate((_,file)=>globalThis.__media121.saveQueue.push({canceled:false,filePath:file}),savedVideo);await w.locator('#save').click();await until(()=>fs.existsSync(savedVideo)&&fs.statSync(savedVideo).size===video.length,'ORIGINAL_NOT_SAVED');assert.deepEqual(fs.readFileSync(savedVideo),video);check('Save after conversion preserves exact original HEVC bytes');
 await application.evaluate(()=>{globalThis.__media121.failVideo=true;});await w.locator('#retry').evaluate(el=>el.click());await w.waitForFunction(()=>!document.getElementById('retry').hidden);assert.equal(await w.locator('#save').isDisabled(),true);check('Read retry failure disables unavailable original Save');await application.evaluate(()=>{globalThis.__media121.failVideo=false;});
 const next=(await api('messages.locate',{groupId:group,messageId:ids[3]})).message.attachments[0];await api('attachment.open',{source:next.src});await until(()=>w.isClosed(),'OLD_VIDEO_NOT_CLOSED');w=await viewer('attachment');await w.waitForFunction(()=>{const v=document.getElementById('video');return v.videoWidth===320&&v.videoHeight===180&&!v.paused&&v.currentTime>0;});const nativePlayback=await w.locator('#video').evaluate(v=>({width:v.videoWidth,height:v.videoHeight,paused:v.paused,time:v.currentTime,frames:v.getVideoPlaybackQuality().totalVideoFrames}));assert(nativePlayback.frames>0);assert.equal(await w.locator('#convert').isVisible(),false);check('Switching to synthetic native WebM stops HEVC player and automatically plays only the new video',nativePlayback);

 await trace('before-explicit-reference-navigation');
 const beforeNavigation=traces.at(-1),initialTrace=traces.find(t=>t.stage==='baseline-before-reading');
 assert.deepEqual(beforeNavigation.readStates,readingBefore.readStates,'PRE_NAVIGATION_READ_STATE_CHANGED');
 assert.deepEqual(stableVisual(beforeNavigation),stableVisual(initialTrace),'PRE_NAVIGATION_VIEWPORT_CHANGED');
 check('HEVC, pause, original save, failed retry and native playback preserve full initial reading state and viewport');
 await ref.locator('.image-button').scrollIntoViewIfNeeded();
 await trace('after-explicit-reference-scroll');
 const afterScroll=traces.at(-1);
 assert.deepEqual(protectedRead(afterScroll.readStates),protectedRead(beforeNavigation.readStates),'NAVIGATION_ADVANCED_READ');
 assert.equal(afterScroll.visual.scrollHeight,beforeNavigation.visual.scrollHeight,'NAVIGATION_LAYOUT_CHANGED');
 assert(afterScroll.visual.referenceButton.top>=afterScroll.visual.scroll.top-1&&afterScroll.visual.referenceButton.bottom<=afterScroll.visual.scroll.bottom+1,'REFERENCE_NOT_VISIBLE');
 await ref.locator('.image-button').click();
 await trace('after-visible-reference-click');
 assert.deepEqual(stableVisual(traces.at(-1)),stableVisual(afterScroll),'VISIBLE_MEDIA_CLICK_MOVED_VIEWPORT');
 await until(()=>w.isClosed(),'IMAGE_DID_NOT_CLOSE_VIDEO');w=await viewer('image');await w.waitForFunction(()=>document.getElementById('image').naturalWidth===128);
 const targetOffset=afterScroll.visual.reference.top-afterScroll.visual.scroll.top;
 await until(async()=>{const s=(await api('state')).readStates[group];return s.anchorId===ids[1]&&Math.abs(s.anchorOffset-targetOffset)<.01;},'NAVIGATION_NOT_PERSISTED');
 await trace('fixed-baseline-after-explicit-navigation');
 const fixed=traces.at(-1);assert.deepEqual(protectedRead(fixed.readStates),protectedRead(beforeNavigation.readStates),'NAVIGATION_PERSISTENCE_ADVANCED_READ');
 fixedVisual=stableVisual(fixed);readingBefore=await api('state');
 check('Explicit navigation persists its intended anchor only; high-water and unread remain unchanged',{scrollTopBefore:beforeNavigation.visual.scrollTop,scrollTopAfter:fixed.visual.scrollTop,anchorOffsetBefore:beforeNavigation.readStates[group].anchorOffset,anchorOffsetAfter:fixed.readStates[group].anchorOffset});
 check('Opening a reference image destroys the video preview');await closeViewer(w);

 const wrongType=(await api('messages.locate',{groupId:group,messageId:ids[4]})).message.images[0];await api('image.open',{source:wrongType.originalSrc});w=await viewer('image');await w.waitForFunction(({width,height})=>{const image=document.getElementById('image');return!image.hidden&&image.naturalWidth===width&&image.naturalHeight===height;},{width:imageWidth,height:imageHeight});
 check('Actual main image protocol and viewer display PNG mislabeled as JPEG',{width:imageWidth,height:imageHeight});
 const savedPng=path.join(harness,'saved-format-corrected.png');await application.evaluate((_,file)=>globalThis.__media121.saveQueue.push({canceled:false,filePath:file}),savedPng);await w.locator('#save').click();await until(()=>fs.existsSync(savedPng)&&fs.statSync(savedPng).size===mislabeled.length,'CORRECTED_ORIGINAL_NOT_SAVED');assert.deepEqual(fs.readFileSync(savedPng),mislabeled);const pngSave=await application.evaluate(()=>globalThis.__media121.saves.at(-1));assert(pngSave.name.endsWith('.png'));check('Corrected image Save As uses PNG and preserves exact original including trailing bytes');await closeViewer(w);
 const heifImage=(await api('messages.locate',{groupId:group,messageId:ids[5]})).message.images[0];await api('image.open',{source:heifImage.originalSrc});w=await viewer('image');await w.waitForFunction(()=>{const image=document.getElementById('image');return!image.hidden&&image.naturalWidth>0&&image.naturalHeight>0;},{},{timeout:60000});const heifSize=await w.locator('#image').evaluate(i=>({width:i.naturalWidth,height:i.naturalHeight}));check('Actual main HEIF decoder still displays public upstream sample',heifSize);
 const savedHeic=path.join(harness,'saved-public-upstream.heic');await application.evaluate((_,file)=>globalThis.__media121.saveQueue.push({canceled:false,filePath:file}),savedHeic);await w.locator('#save').click();await until(()=>fs.existsSync(savedHeic)&&fs.statSync(savedHeic).size===heic.length,'HEIC_ORIGINAL_NOT_SAVED');assert.deepEqual(fs.readFileSync(savedHeic),heic);assert((await application.evaluate(()=>globalThis.__media121.saves.at(-1))).name.endsWith('.heic'));check('HEIF preview Save As retains original HEIC bytes and extension');await closeViewer(w);
 const pdfAttachment=(await api('messages.locate',{groupId:group,messageId:ids[6]})).message.attachments[0];await api('attachment.open',{source:pdfAttachment.src});w=await viewer('attachment');await w.waitForFunction(()=>document.getElementById('page-count').textContent==='2'&&!document.getElementById('pdf-stage').hidden&&document.getElementById('notice').hidden);
 const pagePixel=async()=>w.locator('#page').evaluate(c=>[...c.getContext('2d').getImageData(Math.floor(c.width/2),Math.floor(c.height/2),1,1).data]);let pixel=await pagePixel();assert(pixel[0]>200&&pixel[1]<30&&pixel[2]<30);assert.equal(await w.evaluate(()=>globalThis.pdfActivityExecuted===true),false);check('Packaged PDF.js renders synthetic first page and does not execute OpenAction JavaScript');
 await w.locator('#next').click();await w.waitForFunction(()=>document.getElementById('page-number').value==='2'&&document.getElementById('notice').hidden);pixel=await pagePixel();assert(pixel[2]>200&&pixel[0]<30&&pixel[1]<30);
 const zoomBefore=await w.locator('#zoom').innerText();await w.locator('#zoom-out').click();await w.waitForFunction(value=>document.getElementById('notice').hidden&&document.getElementById('zoom').textContent!==value,zoomBefore);await w.locator('#zoom-in').click();await w.waitForFunction(()=>document.getElementById('notice').hidden);check('PDF page navigation and zoom still render in actual EXE');
 const savedPdf=path.join(harness,'saved-synthetic.pdf');await application.evaluate((_,file)=>globalThis.__media121.saveQueue.push({canceled:false,filePath:file}),savedPdf);await w.locator('#save').click();await until(()=>fs.existsSync(savedPdf)&&fs.statSync(savedPdf).size===pdf.length,'PDF_ORIGINAL_NOT_SAVED');assert.deepEqual(fs.readFileSync(savedPdf),pdf);check('PDF Save As preserves original synthetic document bytes');await closeViewer(w);
 await trace('end-before-reading-assert');assert.deepEqual(stableVisual(traces.at(-1)),fixedVisual,'POST_NAVIGATION_VIEWPORT_CHANGED');check('All post-navigation media operations preserve exact scrollTop and anchor DOM geometry');const readingAfter=await api('state');assert.deepEqual(readingAfter.readPositions,readingBefore.readPositions);assert.deepEqual(readingAfter.readStates,readingBefore.readStates);check('Playback, save and preview switching preserve reading positions and unread counts');
 const audit=await application.evaluate(()=>globalThis.__media121);assert.deepEqual(audit.blocked,[]);assert.deepEqual(errors,[]);check('No external requests, real accounts, AI or Notion used',{mockRequests:audit.requests.length});
 assert.equal(hash(fs.readFileSync(path.resolve(hevcFile))),hash(video));if(localImage)assert.equal(hash(fs.readFileSync(path.resolve(localImage))),hash(mislabeled));check('Explicit local input files remain byte-identical; no screenshots taken');
})().catch(error=>{failure={message:error.message,stack:error.stack};console.error(error.message);process.exitCode=1;}).finally(async()=>{
 try{if(page&&!page.isClosed())await trace('finally-before-close');}catch{}
 try{await application?.close();}catch(error){failure||={message:error.message};process.exitCode=1;}
 const resourcesUnchanged=JSON.stringify(before)===JSON.stringify(manifest(appRoot)),executableUnchanged=exeHash===hash(fs.readFileSync(exe));if(!resourcesUnchanged||!executableUnchanged){failure||={message:'RESOURCES_CHANGED'};process.exitCode=1;}
 const result={passed:!failure,mode:packaged?'final-executable':'source-app',checks,traces,failure,errors,resourcesUnchanged,executableUnchanged,harness,dataDir};fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:result.passed,checks:checks.length,output}));
});
