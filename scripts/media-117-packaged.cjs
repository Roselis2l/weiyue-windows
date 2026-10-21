'use strict';
// Runs the real app/EXE unchanged, in a temporary import account. Runtime mocks
// replace network and Save As dialogs before importing entirely synthetic media.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),args=process.argv.slice(2),arg=name=>args.find(v=>v.startsWith(name+'='))?.slice(name.length+1)||(args.includes(name)?args[args.indexOf(name)+1]:null);
const requested=arg('--exe'),packaged=!!requested,exe=path.resolve(requested||path.join(root,'vendor/runtime/electron.exe'));
const appRoot=packaged?path.join(path.dirname(exe),'resources/app/app'):path.join(root,'app');
const harness=fs.mkdtempSync(path.join(os.tmpdir(),'weiyue-media117-')),dataDir=path.join(harness,'data');fs.mkdirSync(dataDir);
const output=path.resolve(arg('--output')||path.join(root,'artifacts/feature-1.1.17','media-acceptance-'+Date.now()));fs.mkdirSync(output,{recursive:true});
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const manifest=base=>Object.fromEntries(fs.readdirSync(base,{recursive:true}).filter(n=>fs.lstatSync(path.join(base,n)).isFile()).map(n=>[n.replace(/\\/g,'/'),hash(fs.readFileSync(path.join(base,n)))]));
const before=manifest(appRoot),exeHash=hash(fs.readFileSync(exe));
const {Store}=require(path.join(appRoot,'core/store.cjs')),store=new Store(path.join(dataDir,'accounts'));
const account='import-media117-bootstrap',group='9007199254741170001',ids=['9007199254741170101','9007199254741170102','9007199254741170103','9007199254741170104'];
store.ensureAccount({id:account,name:'媒体验收合成账号',kind:'import'});store.mergeMessages(account,[{id:group,name:'媒体验收合成群',selected:true}],[{id:'9007199254741170100',groupId:group,senderId:'117',senderName:'合成成员',time:1792530000000,text:'无远程资源启动记录'}],{history:true});store.update(account,s=>{s.settings.autoSyncEnabled=false;});fs.writeFileSync(path.join(dataDir,'preferences.json'),JSON.stringify({activeId:account}));
const checks=[],errors=[];let application,page,failure;
const check=(name,details)=>{checks.push({name,...(details?{details}:{})});console.log('PASS '+name);};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await pause(80);}throw Error(label);}
const api=(action,payload={})=>page.evaluate(({action,payload})=>window.api.call(action,payload),{action,payload});
function mocks({app,net,session,dialog,shell,BrowserWindow},f){
 const {EventEmitter}=process.getBuiltinModule('node:events'),{Readable}=process.getBuiltinModule('node:stream');
 const state=globalThis.__media117={requests:[],blocked:[],saves:[],saveQueue:[],links:[],failVideo:false};
 app.on('web-contents-created',(_,wc)=>wc.setAudioMuted(true));for(const w of BrowserWindow.getAllWindows())w.webContents.setAudioMuted(true);
 const nativeRequest=net.request.bind(net),nativeFetch=net.fetch.bind(net),png=Buffer.from(f.png,'base64'),video=Buffer.from(f.video,'base64'),zip=Buffer.from(f.zip,'base64');
 net.request=options=>{const url=String(typeof options==='string'?options:options.url);if(/^(app|file):/.test(url))return nativeRequest(options);
  const req=new EventEmitter();let aborted=false;req.setHeader=()=>{};req.abort=()=>{aborted=true;req.emit('abort');};req.end=()=>setImmediate(()=>{
   if(aborted)return;const u=new URL(url);let bytes,mime,status=200;
   if(u.origin==='https://wx1.sinaimg.cn'&&u.pathname==='/media117-synthetic.png'){bytes=png;mime='image/png';state.requests.push('image');}
   else if(u.origin==='https://upload.api.weibo.com'&&u.pathname==='/2/mss/msget'&&u.searchParams.get('fid')==='117001'){bytes=zip;mime='application/zip';state.requests.push('archive');}
   else if(u.origin==='https://upload.api.weibo.com'&&u.pathname==='/2/mss/msget'&&u.searchParams.get('fid')==='117002'){bytes=state.failVideo?Buffer.from('denied'):video;mime=state.failVideo?'text/plain':'video/mp4';status=state.failVideo?403:200;state.requests.push('video');}
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
(async()=>{
 const hevcFile=arg('--hevc');if(!hevcFile)throw Error('Supply --hevc with the separately generated, synthetic HEVC fixture.');
 const video=fs.readFileSync(path.resolve(hevcFile));assert.ok(require(path.join(appRoot,'core/video-decoder.cjs')).inspectHevcMp4(video),'SYNTHETIC_HEVC_INVALID');
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;require('./windows-runtime-check.cjs').assertWindowsRuntimeReadable(exe);
 application=await _electron.launch({executablePath:exe,args:[...(packaged?[]:[root]),'--data-dir='+dataDir],cwd:root,env,timeout:45000});page=await application.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
 await page.waitForFunction(()=>typeof window.api?.call==='function');const initial=await api('state');assert.equal(initial.account.id,account);assert.equal(initial.dataRoot,dataDir);assert.equal(initial.sessionReady,false);assert.equal(initial.credentials.ai,false);assert.equal(initial.credentials.notion,false);
 const launch=await application.evaluate(({app,BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0],p=w.webContents.getLastWebPreferences();return{packaged:app.isPackaged,version:app.getVersion(),exec:process.execPath,appPath:app.getAppPath(),sandbox:p.sandbox,contextIsolation:p.contextIsolation,nodeIntegration:p.nodeIntegration};});assert.equal(launch.packaged,packaged);assert.ok(launch.sandbox&&launch.contextIsolation&&!launch.nodeIntegration);check('Actual application starts isolated with no real credentials',launch);
 const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=128;c.height=72;const x=c.getContext('2d');x.fillStyle='#168c68';x.fillRect(0,0,128,72);x.fillStyle='#fff';x.fillRect(32,18,64,36);return c.toDataURL('image/png').split(',')[1];});
 const zip=Buffer.alloc(22);zip.writeUInt32LE(0x06054b50);const source=fid=>'https://upload.api.weibo.com/2/mss/msget?source=209678993&fid='+fid;
 const message=(i,text,extra)=>({id:ids[i],groupId:group,senderId:'117',senderName:'合成成员',time:1792530000000+i*60000,text,mediaVersion:1,attachmentVersion:1,referenceVersion:1,...extra});
 const fixture={groups:[{id:group,name:'媒体验收合成群',selected:true}],messages:[
  message(0,'合成压缩包，仅保存不执行',{attachments:[{kind:'archive',fid:'117001',state:'ready',name:'示例资料.zip',mime:'application/zip',url:source('117001'),size:zip.length}]}),
  message(1,'明确引用的微博配图',{references:[{kind:'post',relation:'repost',state:'ready',id:'117100',url:'https://m.weibo.cn/detail/117100',author:'合成原作者',text:'完全合成的引用内容',images:[{url:'https://wx1.sinaimg.cn/media117-synthetic.png',width:128,height:72}]}]}),
  message(2,'合成实况照片，保留原始文件',{attachments:[{kind:'video',fid:'117002',state:'ready',name:'合成实况照片.mp4',livePhoto:true,mime:'video/mp4',url:source('117002'),size:video.length}]}),
  message(3,'独立第二条视频预览入口',{attachments:[{kind:'video',fid:'117002',state:'ready',name:'第二个预览.mp4',mime:'video/mp4',url:source('117002'),size:video.length}]}),
 ]};const importFile=path.join(harness,'synthetic-media.json');fs.writeFileSync(importFile,JSON.stringify(fixture));
 await application.evaluate(mocks,{png,video:video.toString('base64'),zip:zip.toString('base64'),importFile});await page.locator('#import-button').click();await until(async()=>(await api('state')).account.id!==account,'IMPORT_NOT_ACTIVE');await page.locator('[data-group-id="'+group+'"]').click();
 const archive=page.locator('[data-message-id="'+ids[0]+'"] .attachment-open');await archive.click();await until(()=>application.evaluate(()=>globalThis.__media117.saves.length===1),'SAVE_DIALOG_CANCEL');assert.equal(fs.readdirSync(harness).some(n=>n.endsWith('.zip')),false);check('Archive cancel writes zero files');
 const archivePath=path.join(harness,'saved-synthetic.zip');await application.evaluate((_,file)=>{globalThis.__media117.saveQueue.push({canceled:false,filePath:file});},archivePath);await archive.click();await until(()=>fs.existsSync(archivePath)&&fs.statSync(archivePath).size===zip.length,'ARCHIVE_NOT_SAVED');assert.deepEqual(fs.readFileSync(archivePath),zip);check('Archive Save As uses exact validated original bytes');
 const ref=page.locator('[data-message-id="'+ids[1]+'"] .referenced-post');await ref.locator('.image-button').click();let w=await viewer('image');await w.waitForFunction(()=>{const i=document.getElementById('image');return i.complete&&i.naturalWidth===128;});check('Reference image opens actual full image viewer');await closeViewer(w);
 await ref.locator('.post-original-link').click();await until(()=>application.evaluate(()=>globalThis.__media117.links.length===1),'REFERENCE_NOT_OPENED');assert.deepEqual(await application.evaluate(()=>globalThis.__media117.links),['https://m.weibo.cn/detail/117100']);check('Reference post uses its own exact official link');
 const started=Date.now();await page.locator('[data-message-id="'+ids[2]+'"] .attachment-open').click();w=await viewer('attachment');await w.waitForFunction(()=>{const v=document.getElementById('video');return v.videoWidth>0&&v.readyState>=2&&!v.paused&&v.currentTime>0;},{},{timeout:120000});
 const state=await w.locator('#video').evaluate(v=>({width:v.videoWidth,height:v.videoHeight,duration:v.duration,paused:v.paused,controls:v.controls}));assert.ok(state.width>0&&!state.paused&&state.controls);check('Opening HEVC preview automatically converts and plays with real main IPC',{...state,elapsedMs:Date.now()-started});
 const audioMuted=await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().filter(w=>w.webContents.getURL()==='app://local/attachment-viewer.html').every(w=>w.webContents.isAudioMuted()));assert.equal(audioMuted,true);
 const readingBefore=await api('state');await pause(500);const playback=await w.locator('#video').evaluate(v=>{v.pause();return{time:v.currentTime,frames:v.getVideoPlaybackQuality().totalVideoFrames,paused:v.paused,error:v.error?.code||null};});assert.ok(playback.time>0&&playback.frames>0&&playback.paused);assert.equal(playback.error,null);check('Automatic playback advances decoded frames; explicit pause works; output pre-muted by test',playback);
 const savedVideo=path.join(harness,'saved-original.mp4');await application.evaluate((_,file)=>globalThis.__media117.saveQueue.push({canceled:false,filePath:file}),savedVideo);await w.locator('#save').click();await until(()=>fs.existsSync(savedVideo)&&fs.statSync(savedVideo).size===video.length,'ORIGINAL_NOT_SAVED');assert.deepEqual(fs.readFileSync(savedVideo),video);check('Save after conversion preserves exact original HEVC bytes');
 await application.evaluate(()=>{globalThis.__media117.failVideo=true;});await w.locator('#retry').evaluate(el=>el.click());await w.waitForFunction(()=>!document.getElementById('retry').hidden);assert.equal(await w.locator('#save').isDisabled(),true);check('Read retry failure disables unavailable original Save');await application.evaluate(()=>{globalThis.__media117.failVideo=false;});
 const next=(await api('messages.locate',{groupId:group,messageId:ids[3]})).message.attachments[0];await api('attachment.open',{source:next.src});await until(()=>w.isClosed(),'OLD_VIDEO_NOT_CLOSED');w=await viewer('attachment');await w.waitForFunction(()=>{const v=document.getElementById('video');return v.videoWidth>0&&!v.paused&&v.currentTime>0;},{},{timeout:120000});check('Switching video preview destroys the previous player and starts only the new one');
 await ref.locator('.image-button').click();await until(()=>w.isClosed(),'IMAGE_DID_NOT_CLOSE_VIDEO');w=await viewer('image');await w.waitForFunction(()=>document.getElementById('image').naturalWidth===128);check('Opening a reference image destroys the video preview');await closeViewer(w);
 const readingAfter=await api('state');assert.deepEqual(readingAfter.readPositions,readingBefore.readPositions);assert.deepEqual(readingAfter.readStates,readingBefore.readStates);check('Playback, save and preview switching preserve reading positions and unread counts');
 const audit=await application.evaluate(()=>globalThis.__media117);assert.deepEqual(audit.blocked,[]);assert.deepEqual(errors,[]);check('No external requests, real accounts, AI or Notion used',{mockRequests:audit.requests.length});
})().catch(error=>{failure={message:error.message,stack:error.stack};console.error(error.message);process.exitCode=1;}).finally(async()=>{
 try{await application?.close();}catch(error){failure||={message:error.message};process.exitCode=1;}
 const resourcesUnchanged=JSON.stringify(before)===JSON.stringify(manifest(appRoot)),executableUnchanged=exeHash===hash(fs.readFileSync(exe));if(!resourcesUnchanged||!executableUnchanged){failure||={message:'RESOURCES_CHANGED'};process.exitCode=1;}
 const result={passed:!failure,mode:packaged?'final-executable':'source-app',checks,failure,errors,resourcesUnchanged,executableUnchanged,harness,dataDir};fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:result.passed,checks:checks.length,output}));
});
