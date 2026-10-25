'use strict';
// Explicit local media fixtures only. Real application/EXE, isolated import
// account, mocked network transport, muted output and zero screenshots.
// --fixtures is a JSON manifest containing {files:[{path,mime,extension,kind,
// sha256,livePhoto?}]}; file paths resolve relative to that external manifest.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),args=process.argv.slice(2),arg=name=>args.find(v=>v.startsWith(name+'='))?.slice(name.length+1)||(args.includes(name)?args[args.indexOf(name)+1]:null);
const requested=arg('--exe'),packaged=!!requested,exe=path.resolve(requested||arg('--runtime')||path.join(root,'vendor/runtime/electron.exe'));
const appRoot=packaged?path.join(path.dirname(exe),'resources/app/app'):path.join(root,'app');
const harness=fs.mkdtempSync(path.join(os.tmpdir(),'weiyue-media126-')),dataDir=path.join(harness,'data');fs.mkdirSync(dataDir);
const output=path.resolve(arg('--output')||path.join(root,'artifacts/media126-'+Date.now()));fs.mkdirSync(output,{recursive:true});
const hash=b=>crypto.createHash('sha256').update(b).digest('hex'),tree=base=>Object.fromEntries(fs.readdirSync(base,{recursive:true}).filter(n=>fs.lstatSync(path.join(base,n)).isFile()).map(n=>[n.replace(/\\/g,'/'),hash(fs.readFileSync(path.join(base,n)))]));
const before=tree(appRoot),exeHash=hash(fs.readFileSync(exe)),files=[];let application,page,failure;const checks=[],errors=[];
const pause=ms=>new Promise(r=>setTimeout(r,ms)),check=(name,detail={})=>{checks.push({name,passed:true,...detail});console.log('PASS '+name);};
async function until(fn,label,timeout=25000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await pause(80);}throw Error(label);}
const api=(action,payload={})=>page.evaluate(({action,payload})=>window.api.call(action,payload),{action,payload});
function mocks({app,net,session,dialog,shell,BrowserWindow},fixture){
 const {EventEmitter}=process.getBuiltinModule('node:events'),{Readable}=process.getBuiltinModule('node:stream');
 const state=globalThis.__media126={requests:[],blocked:[],saveQueue:[],saveCount:0,delayNext:0,decoderWindows:0};
 app.on('web-contents-created',(_,wc)=>wc.setAudioMuted(true));for(const w of BrowserWindow.getAllWindows())w.webContents.setAudioMuted(true);
 app.on('browser-window-created',(_,w)=>{w.webContents.on('did-finish-load',()=>{if(/^app:\/\/(audio|video)-decoder\//.test(w.webContents.getURL()))state.decoderWindows++;});});
 const nativeRequest=net.request.bind(net),nativeFetch=net.fetch.bind(net);
 net.request=options=>{
  const url=String(typeof options==='string'?options:options.url);if(/^(app|file):/.test(url))return nativeRequest(options);
  const req=new EventEmitter();let aborted=false;req.setHeader=()=>{};req.abort=()=>{aborted=true;req.emit('abort');};
  req.end=()=>{const delay=state.delayNext;state.delayNext=0;setTimeout(()=>{
   if(aborted)return;const u=new URL(url),index=fixture.findIndex((_,i)=>u.searchParams.get('fid')===String(126001+i));
   if(u.origin!=='https://upload.api.weibo.com'||index<0||!['/2/mss/meta_query.json','/2/mss/msget'].includes(u.pathname)){state.blocked.push('unexpected-request');req.emit('error',Error('TEST_NETWORK_BLOCKED'));return;}
   const f=fixture[index];let bytes,mime;
   if(u.pathname.endsWith('meta_query.json')){bytes=Buffer.from(JSON.stringify({fid:String(126001+index),fidstr:String(126001+index),extension:f.extension,filename:'local-fixture-'+index+'.'+f.extension,filesize:Buffer.from(f.bytes,'base64').length}));mime='application/json';state.requests.push({kind:'metadata',index});}
   else{bytes=Buffer.from(f.bytes,'base64');mime=f.mime;state.requests.push({kind:'bytes',index});}
   const response=Readable.from([bytes]);response.statusCode=200;response.headers={'content-type':[mime],'content-length':[String(bytes.length)]};req.emit('response',response);
  },delay);};return req;
 };
 net.fetch=(u,o)=>/^(app|file):/.test(String(u))?nativeFetch(u,o):(state.blocked.push('net-fetch'),Promise.reject(Error('TEST_NETWORK_BLOCKED')));
 globalThis.fetch=()=>{state.blocked.push('global-fetch');throw Error('TEST_NETWORK_BLOCKED');};
 const attach=s=>s.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_,cb)=>{state.blocked.push('external-request');cb({cancel:true});});attach(session.defaultSession);app.on('session-created',attach);
 dialog.showSaveDialog=async()=>{state.saveCount++;return state.saveQueue.shift()||{canceled:true};};dialog.showMessageBox=async()=>({response:0});shell.openExternal=async()=>{state.blocked.push('external-open');};
}
async function viewer(){await until(()=>application.windows().some(w=>w.url()==='app://local/attachment-viewer.html'),'VIEWER_NOT_OPEN');return application.windows().find(w=>w.url()==='app://local/attachment-viewer.html');}
const channel='weiyue:attachment-viewer';
async function openAt(index){const m=(await api('messages.locate',{groupId:'126group',messageId:String(126101+index)})).message;assert(m.attachments[0].src);await api('attachment.open',{source:m.attachments[0].src});return viewer();}
async function closeViewer(w){await w.locator('#close').click();await until(()=>w.isClosed(),'VIEWER_NOT_CLOSED');}
(async()=>{
 const fixtureFile=arg('--fixtures');assert(fixtureFile,'EXPLICIT_FIXTURES_REQUIRED');const manifestFile=path.resolve(fixtureFile),manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
 assert(Array.isArray(manifest.files)&&manifest.files.length===3);for(const f of manifest.files){assert(['audio','video'].includes(f.kind));assert(['amr','mov'].includes(f.extension));const file=path.resolve(path.dirname(manifestFile),f.path),bytes=fs.readFileSync(file);assert.equal(hash(bytes),f.sha256);assert(bytes.length<=20*1024*1024);files.push({...f,file,bytes});}
 assert.equal(files.filter(x=>x.kind==='video').length,1);assert.equal(files.filter(x=>x.kind==='audio').length,2);
 const {Store}=require(path.join(appRoot,'core/store.cjs')),store=new Store(path.join(dataDir,'accounts')),account='import-media126';store.ensureAccount({id:account,name:'本地媒体兼容验收',kind:'import'});
 store.mergeMessages(account,[{id:'126group',name:'合成媒体验收群',selected:true}],files.map((f,i)=>({id:String(126101+i),groupId:'126group',senderId:'126sender',senderName:'合成成员',time:1792800000000+i*60000,text:f.kind==='audio'?'分享语音':'实况照片',mediaVersion:1,referenceVersion:1,attachmentVersion:1,attachments:[{kind:f.kind,fid:String(126001+i),state:'needs-metadata',name:'本地兼容样本'+(i+1),...(f.livePhoto?{livePhoto:true}:{})}]})));
 fs.writeFileSync(path.join(dataDir,'preferences.json'),JSON.stringify({activeId:account}));
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;require('./windows-runtime-check.cjs').assertWindowsRuntimeReadable(exe);
 application=await _electron.launch({executablePath:exe,args:[...(packaged?[]:[root]),'--data-dir='+dataDir],cwd:root,env,timeout:45000});page=await application.firstWindow();page.setDefaultTimeout(25000);page.on('pageerror',e=>errors.push(e.message));await page.waitForFunction(()=>typeof window.api?.call==='function');
 const initial=await api('state');assert.equal(initial.account.id,account);assert.equal(initial.sessionReady,false);assert.equal(initial.credentials.ai,false);assert.equal(initial.credentials.notion,false);
 const launch=await application.evaluate(({app,BrowserWindow})=>{const p=BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();return {packaged:app.isPackaged,version:app.getVersion(),sandbox:p.sandbox,contextIsolation:p.contextIsolation,nodeIntegration:p.nodeIntegration};});assert.equal(launch.packaged,packaged);assert.equal(launch.version,JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version);assert(launch.sandbox&&launch.contextIsolation&&!launch.nodeIntegration);check('Actual app starts with isolated synthetic account and no credentials',launch);
 await application.evaluate(mocks,files.map(({bytes,mime,kind,extension})=>({bytes:bytes.toString('base64'),mime,kind,extension})));await page.locator('[data-group-id="126group"]').click();
 await page.waitForFunction(()=>document.querySelectorAll('.attachment-open').length===3);await pause(1400);const readingBefore=await api('state');
 for(let i=0;i<files.length;i++){
  // Trigger the real button handler without Playwright's automatic scrollIntoView,
  // which would itself change a reading anchor before a preview is opened.
  const f=files[i],element=f.kind==='audio'?'audio':'video',started=Date.now();await page.locator('[data-message-id="'+(126101+i)+'"] .attachment-open').evaluate(button=>button.click());let w=await viewer();
  await w.waitForFunction(id=>{const m=document.getElementById(id);return m.readyState>=2&&!m.paused&&m.currentTime>0&&(!('videoWidth' in m)||m.videoWidth>0);},element,{timeout:120000});
  const playback=await w.locator('#'+element).evaluate(m=>({time:m.currentTime,duration:m.duration,paused:m.paused,controls:m.controls,error:m.error?.code||null,...('videoWidth' in m?{width:m.videoWidth,height:m.videoHeight,frames:m.getVideoPlaybackQuality().totalVideoFrames}:{})}));assert.equal(playback.error,null);assert(playback.controls&&playback.time>0);if(f.kind==='video')assert(playback.frames>0);
  assert(await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().filter(w=>!w.isDestroyed()&&!w.webContents.isDestroyed()&&w.webContents.getURL()==='app://local/attachment-viewer.html').every(w=>w.webContents.isAudioMuted())));await w.locator('#'+element).evaluate(m=>m.pause());check('Local fixture '+(i+1)+' converts and autoplays with controls and muted output',{kind:f.kind,...playback,elapsedMs:Date.now()-started});
  const saveCount=await application.evaluate(()=>globalThis.__media126.saveCount);await w.locator('#save').click();await until(()=>application.evaluate((_,n)=>globalThis.__media126.saveCount===n+1,saveCount),'CANCEL_DIALOG_NOT_USED');
  const saved=path.join(harness,'saved-original-'+i+'.'+f.extension);assert(!fs.existsSync(saved));await application.evaluate((_,file)=>globalThis.__media126.saveQueue.push({canceled:false,filePath:file}),saved);await w.locator('#save').click();await until(()=>fs.existsSync(saved)&&fs.statSync(saved).size===f.bytes.length,'SAVE_ORIGINAL_FAILED');assert.equal(hash(fs.readFileSync(saved)),f.sha256);check('Local fixture '+(i+1)+' cancel writes nothing; converted Save As preserves original bytes');await closeViewer(w);
  assert.equal(await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().filter(w=>!w.isDestroyed()&&!w.webContents.isDestroyed()&&/^app:\/\/(audio|video)-decoder\//.test(w.webContents.getURL())).length),0);
 }
 const voiceIndex=files.findIndex(f=>f.kind==='audio'),liveIndex=files.findIndex(f=>f.kind==='video');let old=await openAt(voiceIndex);await old.waitForFunction(()=>document.getElementById('audio').currentTime>0&&!document.getElementById('audio').paused);
 let replacement=await openAt(liveIndex);await until(()=>old.isClosed(),'OLD_AUDIO_NOT_DESTROYED');await replacement.waitForFunction(()=>document.getElementById('video').currentTime>0&&!document.getElementById('video').paused,{},{timeout:120000});assert.equal(application.windows().filter(w=>w.url()==='app://local/attachment-viewer.html').length,1);check('Switching from voice to Live Photo destroys old player and leaves only one preview');await closeViewer(replacement);
 // Block a single mocked transport to verify close aborts a pending read. It
 // neither repeats a real request nor consumes any external service.
 await application.evaluate(()=>{globalThis.__media126.delayNext=1500;});old=await openAt(voiceIndex);await closeViewer(old);await pause(1800);assert.equal(application.windows().filter(w=>w.url()==='app://local/attachment-viewer.html').length,0);check('Closing a pending media read leaves no player or delayed reopened preview');
 const readingAfter=await api('state');assert.deepEqual(readingAfter.readPositions,readingBefore.readPositions);assert.deepEqual(readingAfter.readStates,readingBefore.readStates);check('Media playback, save and switching preserve reading state and unread');
 const audit=await application.evaluate(()=>globalThis.__media126);assert.deepEqual(audit.blocked,[]);assert.deepEqual(errors,[]);assert(audit.decoderWindows>=3);for(const f of files)assert.equal(hash(fs.readFileSync(f.file)),f.sha256);check('All transport mocked, source files unchanged, zero screenshots/AI/Notion',{mockRequests:audit.requests.length,decoderWindows:audit.decoderWindows});
})().catch(error=>{failure={message:error.message,stack:error.stack};console.error(error.message);process.exitCode=1;}).finally(async()=>{
 try{await application?.close();}catch(error){failure||={message:error.message};process.exitCode=1;}
 const resourcesUnchanged=JSON.stringify(before)===JSON.stringify(tree(appRoot)),executableUnchanged=exeHash===hash(fs.readFileSync(exe));if(!resourcesUnchanged||!executableUnchanged){failure||={message:'RESOURCES_CHANGED'};process.exitCode=1;}
 const result={passed:!failure,mode:packaged?'final-executable':'source-app',checks,failure,errors,resourcesUnchanged,executableUnchanged,harness,dataDir,screenshots:0};fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:result.passed,checks:checks.length,output}));
});
