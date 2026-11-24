'use strict';
// Isolated actual application/EXE layout acceptance. All account, image, video,
// PDF and archive fixtures are generated locally. No private data or screenshots.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),args=process.argv.slice(2),arg=name=>args.find(v=>v.startsWith(name+'='))?.slice(name.length+1)||(args.includes(name)?args[args.indexOf(name)+1]:null);
const packaged=!!arg('--exe'),exe=path.resolve(arg('--exe')||arg('--runtime')||path.join(root,'vendor/runtime/electron.exe')),sourceRoot=path.resolve(arg('--source-root')||root);
const appRoot=packaged?path.join(path.dirname(exe),'resources/app/app'):path.join(sourceRoot,'app');
const harness=fs.mkdtempSync(path.join(os.tmpdir(),'weiyue-bubble-media120-')),dataDir=path.join(harness,'data');fs.mkdirSync(dataDir);
const output=path.resolve(arg('--output')||path.join(root,'artifacts/feature-1.1.20/bubble-media-'+Date.now()));fs.mkdirSync(output,{recursive:true});
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const manifest=base=>Object.fromEntries(fs.readdirSync(base,{recursive:true}).filter(n=>fs.lstatSync(path.join(base,n)).isFile()).map(n=>[n.replace(/\\/g,'/'),hash(fs.readFileSync(path.join(base,n)))]));
const before=manifest(appRoot),exeHash=hash(fs.readFileSync(exe));
const {Store}=require(path.join(appRoot,'core/store.cjs')),store=new Store(path.join(dataDir,'accounts'));
const account='import-bubble120-bootstrap',group='9007199254741200001';
store.ensureAccount({id:account,name:'气泡媒体合成账号',kind:'import'});store.mergeMessages(account,[{id:group,name:'气泡媒体合成群',selected:true}],[{id:'9007199254741200100',groupId:group,senderId:'1200',senderName:'合成成员',time:1792530000000,text:'本地合成启动记录'}],{history:true});store.update(account,s=>{s.settings.autoSyncEnabled=false;});fs.writeFileSync(path.join(dataDir,'preferences.json'),JSON.stringify({activeId:account}));
const checks=[],errors=[],geometry=[];let application,page,failure;
const check=(name,details)=>{checks.push({name,...(details?{details}:{})});console.log('PASS '+name);};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await pause(70);}throw Error(label);}
const api=(action,payload={})=>page.evaluate(({action,payload})=>window.api.call(action,payload),{action,payload});
function mocks({app,net,session,dialog,shell,BrowserWindow},f){
 const {EventEmitter}=process.getBuiltinModule('node:events'),{Readable}=process.getBuiltinModule('node:stream');
 const state=globalThis.__bubbleMedia120={requests:[],blocked:[],saves:[],links:[]};
 app.on('web-contents-created',(_,wc)=>wc.setAudioMuted(true));for(const w of BrowserWindow.getAllWindows())w.webContents.setAudioMuted(true);
 const nativeRequest=net.request.bind(net),nativeFetch=net.fetch.bind(net),fixtures=Object.fromEntries(Object.entries(f.assets).map(([url,v])=>[url,{...v,bytes:Buffer.from(v.bytes,'base64')}]));
 net.request=options=>{const url=String(typeof options==='string'?options:options.url);if(/^(app|file):/.test(url))return nativeRequest(options);
  const req=new EventEmitter();let aborted=false;req.setHeader=()=>{};req.abort=()=>{aborted=true;req.emit('abort');};req.end=()=>setImmediate(()=>{
   if(aborted)return;const fixture=fixtures[url];if(!fixture){state.blocked.push('unexpected-request');req.emit('error',Error('TEST_NETWORK_BLOCKED'));return;}
   state.requests.push(fixture.kind);const response=Readable.from([fixture.bytes]);response.statusCode=200;response.headers={'content-type':[fixture.mime],'content-length':[String(fixture.bytes.length)]};req.emit('response',response);
  });return req;};
 net.fetch=(u,o)=>/^(app|file):/.test(String(u))?nativeFetch(u,o):(state.blocked.push('net-fetch'),Promise.reject(Error('TEST_NETWORK_BLOCKED')));
 globalThis.fetch=()=>{state.blocked.push('global-fetch');throw Error('TEST_NETWORK_BLOCKED');};
 const attach=s=>{s.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_,cb)=>{state.blocked.push('external-request');cb({cancel:true});});};attach(session.defaultSession);app.on('session-created',attach);
 dialog.showOpenDialog=async()=>({canceled:false,filePaths:[f.importFile]});dialog.showSaveDialog=async(_,options)=>{state.saves.push(options.defaultPath);return{canceled:true};};dialog.showMessageBox=async()=>({response:0});shell.openExternal=async url=>{state.links.push(url);};
}
async function viewer(kind){await until(()=>application.windows().some(w=>w.url()==='app://local/'+kind+'-viewer.html'),'VIEWER_NOT_OPEN');const w=application.windows().find(w=>w.url()==='app://local/'+kind+'-viewer.html');w.setDefaultTimeout(15000);return w;}
async function closeViewer(w){await w.locator('#close').click();await until(()=>w.isClosed(),'VIEWER_NOT_CLOSED');}
function syntheticPdf(){
 const stream='0 0 1 rg 20 20 160 240 re f\n',objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Count 1 /Kids [3 0 R] >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 320] /Resources << >> /Contents 4 0 R >>','<< /Length '+Buffer.byteLength(stream)+' >>\nstream\n'+stream+'endstream'];
 let body='%PDF-1.7\n',offsets=[0];objects.forEach((value,i)=>{offsets.push(Buffer.byteLength(body));body+=(i+1)+' 0 obj\n'+value+'\nendobj\n';});const start=Buffer.byteLength(body);body+='xref\n0 '+(objects.length+1)+'\n0000000000 65535 f \n';for(const offset of offsets.slice(1))body+=String(offset).padStart(10,'0')+' 00000 n \n';return Buffer.from(body+'trailer\n<< /Size '+(objects.length+1)+' /Root 1 0 R >>\nstartxref\n'+start+'\n%%EOF\n');
}
async function inspectBubble(fixture,width){
 const card=page.locator('[data-message-id="'+fixture.id+'"]');await card.scrollIntoViewIfNeeded();
 await card.locator('img.message-image').evaluateAll(images=>Promise.all(images.map(i=>i.complete?null:new Promise(resolve=>{i.addEventListener('load',resolve,{once:true});i.addEventListener('error',resolve,{once:true});}))));
 const result=await card.evaluate(card=>{
  const bubble=card.querySelector('.message-content'),top=card.querySelector('.message-top'),avatar=card.querySelector('.avatar'),scroll=document.getElementById('message-scroll');
  const b=bubble.getBoundingClientRect(),r=card.getBoundingClientRect(),t=top.getBoundingClientRect(),a=avatar.getBoundingClientRect(),style=getComputedStyle(bubble),round=n=>Math.round(n*100)/100;
  const boxes=[...bubble.querySelectorAll('.message-media,.image-cell,.image-button,.message-image,.shared-post,.attachment-card,.attachment-copy,.attachment-open,.post-original-link')].map(el=>{const q=el.getBoundingClientRect();return{class:el.className,width:round(q.width),height:round(q.height),inside:q.left>=b.left-1&&q.right<=b.right+1,noOverflow:el.scrollWidth<=el.clientWidth+1,image:el.tagName==='IMG'?{complete:el.complete,naturalWidth:el.naturalWidth}:null};});
  return{width:round(b.width),height:round(b.height),background:style.backgroundColor,bubbleInside:b.left>=r.left-1&&b.right<=r.right+1,memberOutside:t.bottom<=b.top+1&&a.right<=b.left+1,scrollNoOverflow:scroll.scrollWidth<=scroll.clientWidth+1,boxes};
 });
 assert(result.width>=88&&result.height>=63,'BUBBLE_COLLAPSED '+fixture.kind);assert(result.bubbleInside&&result.memberOutside&&result.scrollNoOverflow,'BUBBLE_LAYOUT '+fixture.kind);
 assert.equal(result.background,fixture.important?'rgb(36, 79, 66)':'rgb(255, 255, 255)','BUBBLE_TONE');
 for(const box of result.boxes){assert(box.inside&&box.noOverflow,'MEDIA_OVERFLOW '+fixture.kind+' '+JSON.stringify(box));if(box.image)assert(box.width>=40&&box.height>=15&&box.image.complete&&box.image.naturalWidth>0,'IMAGE_COLLAPSED '+JSON.stringify(box));}
 geometry.push({viewport:width,kind:fixture.kind,important:fixture.important,...result});return card;
}
(async()=>{
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;require('./windows-runtime-check.cjs').assertWindowsRuntimeReadable(exe);
 application=await _electron.launch({executablePath:exe,args:[...(packaged?[]:[sourceRoot]),'--data-dir='+dataDir],cwd:sourceRoot,env,timeout:45000});page=await application.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
 await page.waitForFunction(()=>typeof window.api?.call==='function');const initial=await api('state');assert.equal(initial.account.id,account);assert.equal(initial.dataRoot,dataDir);assert.equal(initial.sessionReady,false);assert.equal(initial.credentials.ai,false);assert.equal(initial.credentials.notion,false);
 const launch=await application.evaluate(({app,BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0],p=w.webContents.getLastWebPreferences();return{packaged:app.isPackaged,version:app.getVersion(),exec:process.execPath,sandbox:p.sandbox,contextIsolation:p.contextIsolation,nodeIntegration:p.nodeIntegration};});assert.equal(launch.packaged,packaged);assert.equal(launch.version,JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version);assert(launch.sandbox&&launch.contextIsolation&&!launch.nodeIntegration);check('Isolated actual application with generated fixtures only',launch);
 const pngs=await page.evaluate(()=>[[128,72],[120,480]].map(([w,h])=>{const c=document.createElement('canvas');c.width=w;c.height=h;const x=c.getContext('2d');x.fillStyle='#168c68';x.fillRect(0,0,w,h);x.fillStyle='#fff';x.fillRect(w/4,h/4,w/2,h/2);return c.toDataURL('image/png').split(',')[1];}));
 const webm=await page.evaluate(()=>new Promise((resolve,reject)=>{const c=document.createElement('canvas');c.width=320;c.height=180;const x=c.getContext('2d'),stream=c.captureStream(10),recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'}),chunks=[];let n=0;const paint=()=>{x.fillStyle=n++%2?'#547f6e':'#a4c6b5';x.fillRect(0,0,320,180);};paint();const timer=setInterval(paint,100);recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};recorder.onerror=()=>reject(Error('WEBM_GENERATION'));recorder.onstop=async()=>{clearInterval(timer);stream.getTracks().forEach(t=>t.stop());const b=new Uint8Array(await new Blob(chunks).arrayBuffer());let s='';for(const v of b)s+=String.fromCharCode(v);resolve(btoa(s));};recorder.start();setTimeout(()=>recorder.stop(),1200);}));
 const zip=Buffer.alloc(22);zip.writeUInt32LE(0x06054b50);const pdf=syntheticPdf(),source=fid=>'https://upload.api.weibo.com/2/mss/msget?source=209678993&fid='+fid;
 const imageUrl='https://wx1.sinaimg.cn/bubble120-synthetic.png',tallUrl='https://wx1.sinaimg.cn/bubble120-tall.png';
 const assets={ [imageUrl]:{kind:'image',bytes:pngs[0],mime:'image/png'},[tallUrl]:{kind:'tall-image',bytes:pngs[1],mime:'image/png'},[source('120001')]:{kind:'archive',bytes:zip.toString('base64'),mime:'application/zip'},[source('120002')]:{kind:'video',bytes:webm,mime:'video/webm'},[source('120003')]:{kind:'pdf',bytes:pdf.toString('base64'),mime:'application/pdf'}};
 const short={url:imageUrl,width:128,height:72},tall={url:tallUrl,width:120,height:480},cases=[];
 for(const important of [false,true])for(const kind of ['image','tall','gallery','reference','video','pdf','archive']){
  const id=String(9007199254741200101n+BigInt(cases.length)),text=kind==='image'?'图':kind==='tall'?'':kind==='reference'?'引用图片':'合成'+kind;
  let extra={};if(kind==='image'||kind==='tall'||kind==='gallery')extra.images=kind==='image'?[short]:kind==='tall'?[tall]:[short,tall];
  if(kind==='reference')extra.references=[{kind:'post',relation:'repost',state:'ready',id:'120100',url:'https://m.weibo.cn/detail/120100',author:'合成原作者',text:'合成引用 '+('较长引用内容 '.repeat(15)),images:[short]}];
  if(['video','pdf','archive'].includes(kind)){const fid=kind==='video'?'120002':kind==='pdf'?'120003':'120001',asset=assets[source(fid)],ext=kind==='video'?'webm':kind==='pdf'?'pdf':'zip';extra.attachments=[{kind,fid,state:'ready',name:('合成较长文件名'.repeat(12))+'.'+ext,mime:asset.mime,url:source(fid),size:Buffer.from(asset.bytes,'base64').length}];}
  cases.push({id,kind,important,message:{id,groupId:group,senderId:important?'1201':'1200',senderName:important?'合成重点成员':'合成普通成员',time:1792530000000+cases.length*60000,text,mediaVersion:1,attachmentVersion:1,referenceVersion:1,contextVersion:1,...extra}});
 }
 const importFile=path.join(harness,'synthetic-bubble-media.json');fs.writeFileSync(importFile,JSON.stringify({groups:[{id:group,name:'气泡媒体合成群',selected:true}],messages:cases.map(c=>c.message)}));
 await application.evaluate(mocks,{assets,importFile});await page.locator('#import-button').click();await until(async()=>(await api('state')).account.id!==account,'IMPORT_NOT_ACTIVE');await page.locator('[data-group-id="'+group+'"]').click();
 const importantCard=page.locator('[data-message-id="'+cases.find(c=>c.important).id+'"]');await importantCard.locator('.avatar').hover();await importantCard.locator('[data-action="important-member"]').click();await until(()=>importantCard.evaluate(el=>el.classList.contains('is-important')),'PRIORITY_NOT_RENDERED');
 const stable=await api('state');await page.evaluate(()=>{globalThis.__bubble120DragStarts=0;const scroll=document.getElementById('message-scroll');new MutationObserver(()=>{if(scroll.classList.contains('is-dragging'))globalThis.__bubble120DragStarts++;}).observe(scroll,{attributes:true,attributeFilter:['class']});});
 for(const width of [1440,1000]){
  const windowSize=await application.evaluate(({BrowserWindow},width)=>{const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()==='app://local/index.html');w.setSize(width,900);return{outer:w.getSize(),content:w.getContentSize(),minimum:w.getMinimumSize()};},width);await pause(220);
  const viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));assert(Math.abs(windowSize.outer[0]-width)<=2,'REQUESTED_WIDTH_WAS_CLAMPED '+JSON.stringify(windowSize));check('Actual reachable window width '+width,{...windowSize,viewport,dpiRoundingTolerance:2});
  for(const fixture of cases){
   const card=await inspectBubble(fixture,width);
   if(['image','tall','gallery','reference'].includes(fixture.kind)){
    await card.locator('.image-button').first().click();const w=await viewer('image');await w.waitForFunction(()=>{const i=document.getElementById('image');return !i.hidden&&i.complete&&i.naturalWidth>0;});assert.equal(await w.locator('#image').evaluate(i=>i.naturalWidth),fixture.kind==='tall'?120:128);await closeViewer(w);
    if(fixture.kind==='reference'){const old=await application.evaluate(()=>globalThis.__bubbleMedia120.links.length);await card.locator('.post-original-link').click();await until(async()=>(await application.evaluate(()=>globalThis.__bubbleMedia120.links.length))>old,'REFERENCE_LINK');assert.equal(await application.evaluate(()=>globalThis.__bubbleMedia120.links.at(-1)),'https://m.weibo.cn/detail/120100');}
   }else if(fixture.kind==='archive'){
    const old=await application.evaluate(()=>globalThis.__bubbleMedia120.saves.length);await card.locator('.attachment-open').click();await until(async()=>(await application.evaluate(()=>globalThis.__bubbleMedia120.saves.length))===old+1,'ARCHIVE_CLICK');
   }else{
    await card.locator('.attachment-open').click();const w=await viewer('attachment');if(fixture.kind==='video')await w.waitForFunction(()=>{const v=document.getElementById('video');return v.videoWidth===320&&!v.paused&&v.currentTime>0;});else await w.waitForFunction(()=>document.getElementById('page-count').textContent==='1'&&!document.getElementById('pdf-stage').hidden&&document.getElementById('notice').hidden);await closeViewer(w);
   }
   assert.equal(await page.evaluate(()=>globalThis.__bubble120DragStarts),0,'MEDIA_CLICK_STARTED_DRAG');assert.equal(await card.locator('.message-check').isChecked(),false,'MEDIA_CLICK_SELECTED_MESSAGE');
   check(width+'px '+(fixture.important?'dark':'white')+' '+fixture.kind+' fits and its actual control opens correctly');
  }
 }
 const after=await api('state');const highWater=state=>Object.fromEntries(Object.entries(state.readStates||{}).map(([id,v])=>[id,{readThroughId:v.readThroughId,unreadIds:v.unreadIds}]));assert.deepEqual(highWater(after),highWater(stable));check('Media controls neither start drag nor advance read high-water');
 const audit=await application.evaluate(()=>globalThis.__bubbleMedia120);assert.deepEqual(audit.blocked,[]);assert.deepEqual(errors,[]);assert.equal(fs.readdirSync(harness).some(n=>n.endsWith('.zip')),false);check('Zero external requests, canceled archive writes, private data and screenshots',{mockRequests:audit.requests.length});
})().catch(error=>{failure={message:error.message,stack:error.stack};console.error(error.message);process.exitCode=1;}).finally(async()=>{
 try{await application?.close();}catch(error){failure||={message:error.message};process.exitCode=1;}
 const resourcesUnchanged=JSON.stringify(before)===JSON.stringify(manifest(appRoot)),executableUnchanged=exeHash===hash(fs.readFileSync(exe));if(!resourcesUnchanged||!executableUnchanged){failure||={message:'RESOURCES_CHANGED'};process.exitCode=1;}
 fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:!failure,mode:packaged?'final-executable':'source-app',checks,geometry,failure,errors,resourcesUnchanged,executableUnchanged,harness,dataDir},null,2));console.log(JSON.stringify({passed:!failure,checks:checks.length,output}));
});
