'use strict';
// Local synthetic accounts only; the packaged branch never modifies its runtime.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {assertWindowsRuntimeReadable}=require('./windows-runtime-check.cjs');
const {packagedInput,validatePackaged,closePackaged,networkSummary,verifyPackaged}=require('./lib/packaged-ui-support.cjs');
const packaged=packagedInput(),root=path.resolve(__dirname,'..');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'weiyue-themes-126-')),dataDir=path.join(temp,'data');
const evidence=path.resolve(process.env.WEIYUE_APPEARANCE_OUTPUT||path.join(root,'artifacts','feature-1.1.26','themes-'+Date.now()));
const appSource=packaged?.appSource||path.join(root,'app'),hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
fs.mkdirSync(dataDir);fs.mkdirSync(evidence,{recursive:true});
const sourceHashes=Object.fromEntries(['app.js','style.css','index.html','appearance.js','appearance-settings.js','interface-theme.js','interface-theme.css'].map(file=>[file,hash(path.join(appSource,'renderer',file))]));
if(!packaged){fs.cpSync(process.env.WEIYUE_TEST_RUNTIME||path.join(root,'vendor/runtime'),path.join(temp,'runtime'),{recursive:true});fs.cpSync(appSource,path.join(temp,'app'),{recursive:true});}
const executablePath=packaged?.executablePath||path.join(temp,'runtime','electron.exe');
const {Store}=require(path.join(appSource,'core/store.cjs')),appearance=require(path.join(appSource,'renderer/appearance.js'));
const accountA='appearance-synthetic-a',accountB='appearance-synthetic-b',accountC='appearance-synthetic-legacy',group='appearance-group',base=Date.parse('2026-10-21T00:00:00Z');
const legacy={chatBackground:'#eeeeee',memberName:'#222222',importantName:'#193e32',memberBubble:'#ffffff',importantBubble:'#fcd3d4',importantText:'#991122'};
const messages=Array.from({length:80},(_,i)=>({id:String(9007199254741990000n+BigInt(i)),groupId:group,senderId:i%2?'ordinary':'important',senderName:i%2?'普通示例':'重点示例',text:i===20?'两个':i===21?'好的 https://example.invalid/synthetic':`合成外观消息 ${i}。保留原生选字与阅读位置。`,time:base+i*60000,mediaVersion:1,attachmentVersion:1,referenceVersion:1,contextVersion:1}));
messages[22].text='系统通知合成示例。'+('长通知应可完整展开。'.repeat(15));messages[22].systemNotice={kind:'weibo-system',type:321,subType:101};messages[22].senderName='粉丝群';
messages[23].senderName='粉丝群';messages[23].text='普通成员对照，不是系统通知。';messages[23].attachments=[{kind:'archive',fid:'124001',state:'ready',name:'合成示例.zip',mime:'application/zip',url:'https://upload.api.weibo.com/2/mss/msget?source=209678993&fid=124001',size:22}];
const store=new Store(path.join(dataDir,'accounts'));
for(const id of [accountA,accountB,accountC]){
  store.ensureAccount({id,kind:'weibo',name:id===accountA?'外观账号 A · 示例数据':id===accountB?'外观账号 B · 示例数据':'旧配色账号 · 示例数据'});
  store.mergeMessages(id,[{id:group,name:'外观合成群 · 示例数据',selected:true}],messages,{history:true});
  store.update(id,s=>{s.settings.autoSyncEnabled=false;s.importantMembers=['important'];s.readPositions[group]=messages[20].id;s.readStates[group]={anchorId:messages[20].id,anchorOffset:0,readThroughId:messages[40].id,atBottom:false,unreadIds:messages.slice(41).map(m=>m.id),updatedAt:1000};});
  if(id===accountC)store.update(id,s=>{s.settings.appearance={...legacy};});
  store.bookmark(id,{groupId:group,messageIds:[messages[20].id,messages[21].id,messages[22].id],note:'外观合成收藏',tags:['示例']});
}
fs.writeFileSync(path.join(dataDir,'preferences.json'),JSON.stringify({activeId:accountA}));
function boot(){
  const {app,net,session,ipcMain}=require('electron'),info=globalThis.__appearanceAcceptance={network:[],calls:[],failNext:false,delayMs:0};
  const deny=async()=>{info.network.push('blocked-external');throw Error('No external service allowed');};globalThis.fetch=deny;
  const nativeFetch=net.fetch.bind(net);net.fetch=(url,options)=>/^(?:app|file):/i.test(String(url))?nativeFetch(url,options):deny();
  const attach=s=>{const fetch=s.fetch.bind(s);s.fetch=(url,options)=>/^(?:app|file):/i.test(String(url))?fetch(url,options):deny();s.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_d,cb)=>{info.network.push('blocked-web-request');cb({cancel:true});});};
  app.on('session-created',attach);app.whenReady().then(()=>attach(session.defaultSession));
  const handle=ipcMain.handle.bind(ipcMain);ipcMain.handle=(name,handler)=>handle(name,async(event,...args)=>{if(name==='weiyue:call'&&args[0]==='settings.appearance.save'){info.calls.push(args[1]);if(info.delayMs)await new Promise(r=>setTimeout(r,info.delayMs));if(info.failNext){info.failNext=false;throw Error('Synthetic appearance save failure');}}return handler(event,...args);});
  require('./app/main.cjs');
}
if(!packaged)fs.writeFileSync(path.join(temp,'boot.cjs'),'('+boot.toString()+')();');

const checks=[],errors=[],runs=[],samples=[];let app,page,stage='prepare',failure=null;
const wait=ms=>new Promise(r=>setTimeout(r,ms)),pass=t=>{checks.push(t);console.log('PASS '+t);};
const api=(action,payload={})=>page.evaluate(({action,payload})=>window.api.call(action,payload),{action,payload});
const read=async()=>(await api('state')).readStates[group],colors=async()=>(await api('state')).settings.appearance;
const rgb=hex=>'rgb('+[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)).join(', ')+')';
function sameRead(a,b,{restored=false}={}){for(const key of ['anchorId','readThroughId','unreadCount','atBottom'])assert.deepEqual(a[key],b[key],key);assert.deepEqual(a.unreadIds,b.unreadIds);if(restored){const delta=(a.anchorOffset||0)-(b.anchorOffset||0);assert.ok(Math.abs(delta)<0.5,'Only subpixel rounding is allowed during native view restoration');samples.push({restoredAnchorOffsetBefore:b.anchorOffset,restoredAnchorOffsetAfter:a.anchorOffset,delta});}else assert.deepEqual(a.anchorOffset,b.anchorOffset,'anchorOffset');}
async function launch(){
 const run={preflight:assertWindowsRuntimeReadable(executablePath),netLog:path.join(evidence,'native-net-'+runs.length+'.json')};runs.push(run);
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 app=await _electron.launch({executablePath,args:packaged?['--data-dir='+dataDir,'--log-net-log='+run.netLog,'--net-log-capture-mode=Default']:[path.join(temp,'boot.cjs'),'--data-dir='+dataDir],cwd:packaged?.installRoot||temp,env,timeout:30000});
 run.pid=app.process().pid;app.process().once('exit',(code,signal)=>Object.assign(run,{code,signal}));
 if(packaged){run.runtime=await validatePackaged(app,packaged,dataDir);assert.equal(run.runtime.version,'1.1.26');}
 page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));await page.waitForSelector('article[data-message-id]');await wait(650);
}
async function close(){if(!app)return;const run=runs.at(-1);if(packaged){await closePackaged(app);run.network=networkSummary(run.netLog);}else{run.instrumentation=await app.evaluate(()=>globalThis.__appearanceAcceptance);await app.close();}app=null;}
const open=async()=>{await page.locator('#settings-button').click();await page.locator('#configure-appearance').click();await page.locator('#save-appearance').waitFor();};
const cancel=async()=>{await page.locator('#modal-close').click();await page.locator('#configure-appearance').waitFor();await page.locator('#modal-close').click();};
const save=async()=>{await page.locator('#save-appearance').click();await page.locator('#configure-appearance').waitFor();await page.locator('#modal-close').click();await wait(180);};
const setText=async value=>{await open();await page.locator('#appearance-memberText-hex').fill(value);await save();};
const ordinary=()=>page.locator('article[data-message-id="'+messages[21].id+'"]');
const computed=()=>page.evaluate(({ordinaryId,importantId})=>{
 const c=el=>getComputedStyle(el),normal=document.querySelector('[data-message-id="'+ordinaryId+'"]'),important=document.querySelector('[data-message-id="'+importantId+'"]'),system=document.querySelector('article.message-system'),attachment=document.querySelector('.attachment-card');
 return {ordinary:c(normal.querySelector('.message-text')).color,important:c(important.querySelector('.message-text')).color,
 normalName:c(normal.querySelector('.sender-name')).color,importantName:c(important.querySelector('.sender-name')).color,link:c(normal.querySelector('.message-link')).color,
 system:c(system.querySelector('.system-notice-toggle')).color,systemTime:c(system.querySelector('.message-time')).color,
 attachment:c(attachment).color,attachmentButton:c(attachment.querySelector('.attachment-open')).color,attachmentBackground:c(attachment).backgroundColor,
 chat:c(document.getElementById('message-scroll')).backgroundColor,sidebar:c(document.querySelector('.sidebar')).backgroundColor};
},{ordinaryId:messages[21].id,importantId:messages[20].id});
const unchangedSemantic=(actual,before)=>{for(const key of ['important','normalName','importantName','link','system','systemTime','attachment','attachmentButton','attachmentBackground','chat','sidebar'])assert.equal(actual[key],before[key],key+' must not inherit ordinary body color');};
(async()=>{try{
 await launch();const initialRead=await read(),initialColors=await colors(),initialComputed=await computed();
 assert.equal(await page.locator('.brand-tagline').count(),0);assert.equal(await page.locator('.brand-name').innerText(),'微阅');
 assert.equal(await page.locator('body').getAttribute('data-interface-theme'),'cool-grey');
 const oldRaw=JSON.stringify(new Store(path.join(dataDir,'accounts')).get(accountA));
 await open();assert.equal(await page.locator('#interface-theme-cool-grey').isChecked(),true);await cancel();
 assert.equal(JSON.stringify(new Store(path.join(dataDir,'accounts')).get(accountA)),oldRaw);
 pass('Legacy account reads Cool Grey without rewriting data; only requested slogan is removed');
 stage='repeat-preview-cancel';await open();
 for(const id of ['pink','viridian','violet','cool-grey','violet']){
  await page.locator('#interface-theme-'+id).check();assert.equal(await page.locator('#interface-theme-preview').getAttribute('data-interface-theme'),id);
  assert.equal(await page.locator('body').getAttribute('data-interface-theme'),'cool-grey');assert.deepEqual(await computed(),initialComputed);
 }
 await cancel();assert.equal(JSON.stringify(new Store(path.join(dataDir,'accounts')).get(accountA)),oldRaw);sameRead(await read(),initialRead);
 pass('Repeated draft theme changes affect only synthetic chrome preview; Cancel leaves message colors, persisted bytes and reading marks unchanged');
 stage='four-saves';
 const custom={...appearance.DEFAULTS,memberText:'#163c69',importantText:'#7b1536',memberName:'#264d41',importantName:'#7b1536',chatBackground:'#e8eef4',memberBubble:'#ffffff',importantBubble:'#f8e4ef'};
 await open();for(const [key,value]of Object.entries(custom))await page.locator('#appearance-'+key+'-hex').fill(value);await save();
 const customComputed=await computed();await page.evaluate(()=>{window.__themeNode=document.querySelector('article[data-message-id]');window.__themeTop=document.getElementById('message-scroll').scrollTop;});
 for(const id of ['cool-grey','viridian','pink','violet']){
  await open();await page.locator('#interface-theme-'+id).check();await save();
  assert.equal(await page.locator('body').getAttribute('data-interface-theme'),id);assert.equal((await api('state')).settings.interfaceTheme,id);assert.deepEqual(await colors(),custom);
  const actual=await computed();for(const key of Object.keys(actual).filter(k=>k!=='sidebar'))assert.equal(actual[key],customComputed[key],key+' independent under '+id);
  sameRead(await read(),initialRead);assert.equal(await page.evaluate(()=>window.__themeNode===document.querySelector('article[data-message-id]')),true);assert.equal(await page.evaluate(()=>window.__themeTop===document.getElementById('message-scroll').scrollTop),true);
  const t=await page.evaluate(()=>{const s=getComputedStyle(document.body),c=el=>getComputedStyle(el);return{id:document.body.dataset.interfaceTheme,sidebar:c(document.querySelector('.sidebar')).backgroundColor,accent:s.getPropertyValue('--ui-accent'),muted:s.getPropertyValue('--ui-muted'),panel:s.getPropertyValue('--ui-panel')};});samples.push(t);
  assert.ok(appearance.contrastRatio(t.muted.trim(),t.panel.trim())>=4.5);await page.locator('#toast').waitFor({state:'hidden'});await page.screenshot({path:path.join(evidence,'synthetic-theme-'+id+'.png')});
 }
 pass('All four saved themes recolor chrome while preserving seven explicit message colors, links/system/media semantics, same DOM, scroll and unread/high-water');
 stage='reset-independence';await open();await page.locator('#interface-theme-reset').click();assert.equal(await page.locator('#interface-theme-cool-grey').isChecked(),true);for(const[key,value]of Object.entries(custom))assert.equal(await page.locator('#appearance-'+key+'-hex').inputValue(),value);await cancel();assert.equal((await api('state')).settings.interfaceTheme,'violet');
 await open();await page.locator('#appearance-reset').click();assert.equal(await page.locator('#interface-theme-violet').isChecked(),true);await cancel();assert.deepEqual(await colors(),custom);
 pass('Restore theme preserves message color draft; Restore message colors preserves theme; cancelling either writes nothing');
 stage='narrow';await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1000,680));await wait(180);await open();
 for(const id of ['cool-grey','viridian','pink','violet']){await page.locator('#interface-theme-'+id).check();assert.equal(await page.locator('#interface-theme-'+id).isVisible(),true);}
 await page.locator('#interface-theme-pink').focus();assert.equal(await page.locator('#interface-theme-pink').evaluate(el=>document.activeElement===el),true);
 const geometry=await page.locator('#modal').evaluate(el=>{const r=el.getBoundingClientRect(),footer=el.querySelector('.modal-footer').getBoundingClientRect();return{top:r.top,bottom:r.bottom,viewport:innerHeight,scroll:el.scrollHeight,client:el.clientHeight,footerBottom:footer.bottom};});
 assert.ok(geometry.top>=0&&geometry.bottom<=geometry.viewport+1);assert.equal(geometry.scroll,geometry.client);assert.ok(geometry.footerBottom<=geometry.viewport+1);samples.push({geometry});await page.screenshot({path:path.join(evidence,'synthetic-theme-settings.png')});await cancel();
 pass('Theme radio controls have visible keyboard focus and remain usable in narrow scrollable settings with footer visible');
 stage='account-isolation';await page.locator('#account-select').selectOption(accountB);await wait(250);assert.equal(await page.locator('body').getAttribute('data-interface-theme'),'cool-grey');assert.deepEqual(await colors(),initialColors);
 await page.locator('#account-select').selectOption(accountA);await wait(250);assert.equal(await page.locator('body').getAttribute('data-interface-theme'),'violet');assert.deepEqual(await colors(),custom);sameRead(await read(),initialRead,{restored:true});
 pass('Account switches restore only that account theme and colors without leaking prior selection');
 stage='restart';const beforeRestart=await read();await close();await launch();assert.equal(await page.locator('body').getAttribute('data-interface-theme'),'violet');assert.deepEqual(await colors(),custom);sameRead(await read(),beforeRestart,{restored:true});
 await open();assert.equal(await page.locator('#interface-theme-violet').isChecked(),true);await page.locator('#interface-theme-reset').click();await save();assert.equal((await api('state')).settings.interfaceTheme,'cool-grey');assert.deepEqual(await colors(),custom);
 pass('Normal close/restart persists exact theme/custom colors/read marks; saving default theme leaves seven colors intact');
 stage='complete';
}catch(error){failure=String(error.stack||error);console.error(failure);}finally{
 try{await close();}catch(error){failure||=String(error);}
 const unchanged=Object.entries(sourceHashes).every(([file,value])=>hash(path.join(appSource,'renderer',file))===value),program=verifyPackaged(packaged);
 const external=runs.some(run=>run.network?.externalUrlObservations>0||run.instrumentation?.network.length),passed=!failure&&!errors.length&&!external&&unchanged&&runs.every(run=>run.code===0)&&(!program||(program.programUnchanged&&program.installDataUnchanged));
 fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({passed,stage,failure,checks,errors,runs,samples,sourceHashes,sourceStillMatches:unchanged,program,dataDir,executablePath,scope:'Only isolated synthetic accounts; no D, real Weibo/AI/Notion, credential writes, or real-message deletion'},null,2));
 console.log(JSON.stringify({passed,checks:checks.length,report:path.join(evidence,'result.json')}));if(!passed)process.exitCode=1;
}})();
