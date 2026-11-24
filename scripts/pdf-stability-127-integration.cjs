'use strict';
// Isolated real app/EXE acceptance. Synthetic login and in-memory transport only.
// An optional authorized local PDF is never copied into source or screenshots.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {assertWindowsRuntimeReadable}=require('./windows-runtime-check.cjs');
const {packagedInput,validatePackaged,closePackaged,verifyPackaged}=require('./lib/packaged-ui-support.cjs');
const root=path.resolve(__dirname,'..'),packed=packagedInput(),appSource=packed?.appSource||path.join(root,'app');
const output=path.resolve(process.env.WEIYUE_PDF_OUTPUT||path.join(root,'artifacts','pdf-127-'+Date.now()));
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'weiyue-pdf127-')),dataDir=path.join(temp,'data');
fs.mkdirSync(output,{recursive:true});fs.mkdirSync(dataDir);assert(!fs.existsSync(path.join(output,'result.json')),'Use a new output directory');
function syntheticPdf(){
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Count 2 /Kids [3 0 R 5 0 R] >>'];
 for(const [width,height]of [[600,800],[1000,610]]){const id=objects.length+1,stream='0.2 0.5 0.3 rg 20 20 '+(width-40)+' '+(height-40)+' re f\n';objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 '+width+' '+height+'] /Resources << >> /Contents '+(id+1)+' 0 R >>','<< /Length '+Buffer.byteLength(stream)+' >>\nstream\n'+stream+'endstream');}
 let body='%PDF-1.7\n',offsets=[];for(const [i,o]of objects.entries()){offsets.push(Buffer.byteLength(body));body+=(i+1)+' 0 obj\n'+o+'\nendobj\n';}const xref=Buffer.byteLength(body);body+='xref\n0 '+(objects.length+1)+'\n0000000000 65535 f \n'+offsets.map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size '+(objects.length+1)+' /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF\n';return Buffer.from(body);
}
const privateOriginalUsed=!!process.env.WEIYUE_PDF_ORIGINAL,bytes=privateOriginalUsed?fs.readFileSync(process.env.WEIYUE_PDF_ORIGINAL):syntheticPdf();
assert(bytes.length<=50*1024*1024&&bytes.subarray(0,5).toString()==='%PDF-');
const {Store}=require(path.join(appSource,'core/store.cjs')),store=new Store(path.join(dataDir,'accounts'));
const identity='127999',account='weibo-'+identity,group='127998',fid='127997';
const messages=Array.from({length:90},(_,i)=>({id:String(9007199254741990000n+BigInt(i)),groupId:group,senderId:'127996',senderName:'合成测试成员',text:i===20?'合成 PDF 验收':'合成阅读记录 '+i,time:1793000000000+i*60000,mediaVersion:1,attachmentVersion:1,referenceVersion:1,contextVersion:1,
 ...(i===20?{attachments:[{kind:'pdf',fid,name:'local-validation.pdf',mime:'application/pdf',state:'ready',size:bytes.length,url:'https://upload.api.weibo.com/2/mss/msget?source=209678993&fid='+fid}]}:{})}));
store.ensureAccount({id:account,name:'PDF 合成验收账号',kind:'weibo'});store.mergeMessages(account,[{id:group,name:'PDF 合成验收群',selected:true}],messages,{history:true});
store.update(account,s=>{s.settings.autoSyncEnabled=false;s.readPositions[group]=messages[20].id;s.readStates[group]={anchorId:messages[20].id,anchorOffset:0,readThroughId:messages[40].id,atBottom:false,unreadIds:messages.slice(41).map(m=>m.id),updatedAt:1000};});
fs.writeFileSync(path.join(dataDir,'preferences.json'),JSON.stringify({activeId:account}));
function installMock({app,net,session},fixture){
 const require=process.getBuiltinModule('node:module').createRequire(app.getAppPath()+'/package.json'),path=require('node:path');
 const {EventEmitter}=require('node:events'),{Readable}=require('node:stream'),{Vault}=require(path.join(app.getAppPath(),'app/core/security.cjs')),{WeiboClient,PATHS}=require(path.join(app.getAppPath(),'app/core/weibo.cjs'));
 const report=globalThis.__pdf127={reads:0,blocked:[],cycles:0,newMessages:0};let previous=fixture.last;
 const deny=()=>{report.blocked.push('external-denied');throw Error('Offline PDF acceptance forbids external requests');};
 globalThis.fetch=async()=>deny();const nativeFetch=net.fetch.bind(net),nativeRequest=net.request.bind(net);
 net.fetch=(url,options)=>/^(app|file):/.test(String(url))?nativeFetch(url,options):Promise.reject(deny());
 net.request=options=>{const url=String(typeof options==='string'?options:options.url);if(/^(app|file):/.test(url))return nativeRequest(options);const u=new URL(url);if(u.origin!=='https://upload.api.weibo.com'||u.pathname!=='/2/mss/msget'||u.searchParams.get('fid')!==fixture.fid)return deny();const request=new EventEmitter();let aborted=false;request.setHeader=()=>{};request.abort=()=>{aborted=true;request.emit('abort');};request.end=()=>setImmediate(()=>{if(aborted)return;report.reads++;const data=Buffer.from(fixture.bytes,'base64'),response=Readable.from([data]);response.statusCode=200;response.headers={'content-type':['application/pdf'],'content-length':[String(data.length)]};request.emit('response',response);});return request;};
 const attach=s=>{const original=s.fetch.bind(s);s.fetch=(url,options)=>/^(app|file):/.test(String(url))?original(url,options):Promise.reject(deny());s.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_,cb)=>{report.blocked.push('web-request-denied');cb({cancel:true});});};attach(session.defaultSession);app.on('session-created',attach);
 Vault.prototype.read=function(id){assertAccount(id);return{cookies:[{domain:'api.weibo.com',path:'/',name:'synthetic_pdf_fixture',value:'not-a-real-login',secure:true,httpOnly:true,hostOnly:true,sameSite:'unspecified'}]};};Vault.prototype.write=function(id){assertAccount(id);};
 function assertAccount(id){if(id!==fixture.account)throw Error('Unexpected synthetic account');}
 WeiboClient.prototype._request=async function(endpoint,parameters={}){
  if(endpoint===PATHS.identity){report.cycles++;return{profile:{id:fixture.identity,screen_name:'合成 PDF 账号'}};}
  if(endpoint!==PATHS.messages||parameters.id!==fixture.group||parameters.max_mid!=null)throw Error('Unexpected synthetic endpoint');
  const next={...previous,id:(BigInt(previous.id)+1n).toString(),time:previous.time+60000,text:'合成自动更新 '+report.cycles};report.newMessages++;
  const convert=m=>({id:m.id,gid:m.groupId,from_uid:m.senderId,from_user:{id:m.senderId,screen_name:m.senderName},text:m.text,time:m.time/1000});const result={messages:[convert(next),convert(previous)],has_more:true};previous=next;return result;
 };
}
const checks=[],errors=[],samples=[];let application,page,failure,runtime;
const delay=ms=>new Promise(r=>setTimeout(r,ms)),pass=name=>{checks.push(name);console.log('PASS '+name);};
async function until(fn,label,ms=20000){const deadline=Date.now()+ms;while(Date.now()<deadline){if(await fn())return;await delay(50);}throw Error(label);}
const api=(action,payload={})=>page.evaluate(({action,payload})=>window.api.call(action,payload),{action,payload});
async function ready(w){await w.waitForFunction(()=>!document.getElementById('pdf-stage').hidden&&document.getElementById('notice').hidden&&Number(document.getElementById('page-count').textContent)>1);await delay(350);}
async function observe(w){await w.evaluate(()=>{globalThis.__mutations={canvas:0,notice:0};globalThis.__observer?.disconnect();globalThis.__observer=new MutationObserver(records=>{for(const r of records){if(r.target.id==='page')__mutations.canvas++;else __mutations.notice++;}});__observer.observe(document.getElementById('page'),{attributes:true,attributeFilter:['width','height']});__observer.observe(document.getElementById('notice'),{attributes:true,attributeFilter:['hidden']});});}
async function stable(w,label,ms=900){await observe(w);await delay(ms);const result=await w.evaluate(()=>({...__mutations,hidden:document.getElementById('notice').hidden}));samples.push({label,...result});assert.equal(result.canvas,0,label+' cleared the canvas repeatedly');assert.equal(result.notice,0,label+' toggled status repeatedly');assert.equal(result.hidden,true);}
async function open(){const message=(await api('messages.query',{groupId:group,limit:200})).messages.find(m=>m.id===messages[20].id);await api('attachment.open',{source:message.attachments[0].src});await until(()=>application.windows().some(w=>w.url()==='app://local/attachment-viewer.html'),'Missing PDF preview');const w=application.windows().find(w=>w.url()==='app://local/attachment-viewer.html');w.on('pageerror',e=>errors.push(e.message));await ready(w);return w;}
const marks=s=>{const r=s.readStates[group];return{anchor:r.anchorId,readThrough:r.readThroughId,unread:r.unreadCount};};
(async()=>{try{
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const executablePath=packed?.executablePath||process.env.WEIYUE_TEST_RUNTIME_EXE||path.join(root,'vendor/runtime/electron.exe');
 assertWindowsRuntimeReadable(executablePath);
 application=await _electron.launch({executablePath,args:packed?['--data-dir='+dataDir]:[root,'--data-dir='+dataDir],cwd:packed?.installRoot||root,env,timeout:30000});if(packed)runtime=await validatePackaged(application,packed,dataDir);
 page=await application.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.waitForSelector('article[data-message-id]');await delay(1600);
 await application.evaluate(installMock,{identity,account,group,fid,last:messages.at(-1),bytes:bytes.toString('base64')});
 const before=marks(await api('state')),view=await page.locator('#message-scroll').evaluate(e=>e.scrollTop);let w=await open();await stable(w,'initial');pass('Actual PDF page paints once and remains stable at rest');
 await w.locator('#next').click();await ready(w);assert.equal(await w.locator('#page-number').inputValue(),'2');await stable(w,'next-page');await w.locator('#previous').click();await ready(w);assert.equal(await w.locator('#page-number').inputValue(),'1');
 const initialZoom=await w.locator('#zoom').innerText();await w.locator('#zoom-in').click();await ready(w);assert.notEqual(await w.locator('#zoom').innerText(),initialZoom);await stable(w,'manual-zoom');await w.locator('#fit').click();await ready(w);await stable(w,'fit-width');pass('Page navigation, manual zoom and fit-to-width settle without flicker');
 const bounds=await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()==='app://local/attachment-viewer.html').getBounds());
 await observe(w);await application.evaluate(({BrowserWindow},bounds)=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()==='app://local/attachment-viewer.html').setSize(bounds.width,bounds.height+70),bounds);await delay(600);assert.equal((await w.evaluate(()=>__mutations)).canvas,0);pass('Height-only native window resize does not repaint the PDF');
 await application.evaluate(({BrowserWindow},bounds)=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()==='app://local/attachment-viewer.html').setSize(bounds.width-110,bounds.height),bounds);await delay(700);await ready(w);await stable(w,'native-width-resize');
 await w.locator('#viewport').hover();await w.mouse.wheel(0,350);await delay(200);assert(await w.locator('#viewport').evaluate(e=>e.scrollTop)>0);await stable(w,'scrolled');pass('Width resizing settles; actual wheel scrolling preserves the rendered page');
 const beforeReads=await application.evaluate(()=>__pdf127.reads),original=w;w=await open();assert.equal(w,original);assert.equal(await application.evaluate(()=>__pdf127.reads),beforeReads);pass('Repeated open reuses one existing preview without a second attachment read');
 await observe(w);await api('sync.configure',{enabled:true});await until(async()=>{const s=await api('sync.status');return(await application.evaluate(()=>__pdf127.newMessages))>=2&&!s.running;},'Two wall-clock automatic updates did not finish',22000);await api('sync.configure',{enabled:false});await delay(300);
 const mutation=await w.evaluate(()=>__mutations);samples.push({label:'two-auto-sync-cycles',...mutation});assert.equal(mutation.canvas,0);assert.equal(mutation.notice,0);const after=marks(await api('state')),added=await application.evaluate(()=>__pdf127.newMessages);assert.equal(after.anchor,before.anchor);assert.equal(after.readThrough,before.readThrough);assert.equal(after.unread,before.unread+added);assert.equal(await page.locator('#message-scroll').evaluate(e=>e.scrollTop),view);pass('Two real 5-second scheduler cycles update synthetic unread without repainting the PDF or moving the reading position');
 for(let i=0;i<3;i++){await w.locator('#close').click();await until(()=>w.isClosed(),'Preview did not close');w=await open();await stable(w,'reopen-'+i,400);}await w.locator('#close').click();await until(()=>w.isClosed(),'Last preview did not close');pass('Three close/reopen cycles cleanly dispose and restore a stable preview');
 assert.deepEqual(await application.evaluate(()=>__pdf127.blocked),[]);assert.deepEqual(errors,[]);pass('All app tests use an isolated account and mock transport with no external network attempts or page errors');
 }catch(error){failure={message:error.message,stack:error.stack};console.error(error.stack);process.exitCode=1;}finally{
 try{if(application)await closePackaged(application);}catch(error){failure||={message:error.message};process.exitCode=1;}
 const unchanged=verifyPackaged(packed);if(unchanged&&(!unchanged.programUnchanged||!unchanged.installDataUnchanged)){failure||={message:'Package changed'};process.exitCode=1;}
 fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:!failure,mode:packed?'final-executable':'source-app',privateOriginalUsed,runtime,checks,samples,errors,failure,unchanged},null,2));console.log(JSON.stringify({passed:!failure,checks:checks.length,output}));
 }})();
