'use strict';
// Local synthetic accounts only; the packaged branch never modifies its runtime.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {assertWindowsRuntimeReadable}=require('./windows-runtime-check.cjs');
const {packagedInput,validatePackaged,closePackaged,networkSummary,verifyPackaged}=require('./lib/packaged-ui-support.cjs');
const packaged=packagedInput(),root=path.resolve(__dirname,'..');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'weiyue-appearance-124-')),dataDir=path.join(temp,'data');
const evidence=path.resolve(process.env.WEIYUE_APPEARANCE_OUTPUT||path.join(root,'artifacts','feature-1.1.24','appearance-'+Date.now()));
const appSource=packaged?.appSource||path.join(root,'app'),hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
fs.mkdirSync(dataDir);fs.mkdirSync(evidence,{recursive:true});
const sourceHashes=Object.fromEntries(['app.js','style.css','index.html','appearance.js','appearance-settings.js'].map(file=>[file,hash(path.join(appSource,'renderer',file))]));
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
 if(packaged){run.runtime=await validatePackaged(app,packaged,dataDir);assert.equal(run.runtime.version,'1.1.24');}
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
 await launch();let initialRead=await read();const initialColors=await colors(),initialComputed=await computed();
 assert.deepEqual(initialColors,appearance.DEFAULTS);assert.equal(initialColors.memberText,'#000000');assert.equal(initialComputed.ordinary,'rgb(0, 0, 0)');assert.equal(initialComputed.important,rgb(appearance.DEFAULTS.importantText));
 await open();assert.equal(await page.locator('#appearance-memberText-hex').inputValue(),'#000000');assert.equal(await page.locator('#appearance-memberText-color').inputValue(),'#000000');assert.equal(await page.locator('#appearance-memberText-hex').getAttribute('aria-label'),'普通成员消息文字颜色 HEX');await cancel();
 pass('Default ordinary body is black with separate picker/HEX field; important body retains its independent default');
 stage='legacy';
 await page.locator('#account-select').selectOption(accountC);await wait(350);const rawLegacy=JSON.stringify(new Store(path.join(dataDir,'accounts')).get(accountC).settings.appearance);
 assert.deepEqual(await colors(),{...legacy,memberText:'#000000'});const legacyComputed=await computed();assert.equal(legacyComputed.ordinary,'rgb(0, 0, 0)');assert.equal(legacyComputed.important,rgb(legacy.importantText));
 await open();assert.equal(await page.locator('#appearance-memberText-hex').inputValue(),'#000000');await cancel();assert.equal(JSON.stringify(new Store(path.join(dataDir,'accounts')).get(accountC).settings.appearance),rawLegacy);
 await page.locator('#account-select').selectOption(accountA);await wait(350);sameRead(await read(),initialRead,{restored:true});initialRead=await read();
 pass('Old six-field settings gain black only in memory, retain all existing colors and remain stored unchanged after cancel');
 stage='draft-cancel';
 await page.evaluate(()=>{window.__memberTextNode=document.querySelector('article[data-message-id]');window.__memberTextTop=document.getElementById('message-scroll').scrollTop;});
 await open();await page.locator('#appearance-memberText-color').fill('#224466');assert.equal(await page.locator('#appearance-memberText-hex').inputValue(),'#224466');
 assert.equal(await page.locator('.appearance-example:not(.is-important) .appearance-example-bubble').evaluate(el=>getComputedStyle(el).color),'rgb(34, 68, 102)');
 await page.locator('#appearance-memberText-hex').fill('#ABC');assert.equal(await page.locator('#appearance-memberText-color').inputValue(),'#aabbcc');assert.equal(await page.locator('.appearance-example:not(.is-important) .appearance-example-bubble').evaluate(el=>getComputedStyle(el).color),'rgb(170, 187, 204)');
 await page.locator('#appearance-memberText-hex').fill('url(x)');assert.equal(await page.locator('#save-appearance').isDisabled(),true);assert.equal(await page.locator('#appearance-memberText-hex').getAttribute('aria-invalid'),'true');
 assert.deepEqual(await computed(),initialComputed);await cancel();assert.deepEqual(await colors(),initialColors);sameRead(await read(),initialRead);assert.deepEqual(await computed(),initialComputed);
 pass('Picker and short HEX update only synthetic preview; invalid HEX blocks Save and Cancel preserves live colors/read state');
 stage='save-custom';
 await setText('#123ABC');const custom={...appearance.DEFAULTS,memberText:'#123abc'};assert.deepEqual(await colors(),custom);sameRead(await read(),initialRead);
 const after=await computed();assert.equal(after.ordinary,'rgb(18, 58, 188)');unchangedSemantic(after,initialComputed);
 assert.equal(await page.evaluate(()=>window.__memberTextNode===document.querySelector('article[data-message-id]')),true);assert.equal(await page.evaluate(()=>window.__memberTextTop===document.getElementById('message-scroll').scrollTop),true);samples.push({initial:initialComputed,custom:after});
 pass('Saving applies only ordinary body text, preserving DOM/scroll/read state and nickname, important, system, links and attachment controls');
 stage='contrast-and-default-cancel';
 await open();await page.locator('#appearance-memberText-hex').fill('#ffffff');assert.equal(await page.locator('#appearance-warnings').isVisible(),true);assert.equal(await page.locator('.appearance-example:not(.is-important) .appearance-example-bubble').evaluate(el=>getComputedStyle(el).color),'rgb(255, 255, 255)');await save();
 assert.equal((await colors()).memberText,'#ffffff');assert.equal((await computed()).ordinary,'rgb(255, 255, 255)');assert.equal((await computed()).link,initialComputed.link);
 await open();await page.locator('#appearance-reset').click();assert.equal(await page.locator('#appearance-memberText-hex').inputValue(),'#000000');assert.equal((await colors()).memberText,'#ffffff');await cancel();assert.equal((await colors()).memberText,'#ffffff');await setText('#123abc');
 pass('Explicit low contrast is warned but retained; Reset affects the draft only until Save, and cancel preserves the saved color');
 stage='identity-switch';
 await ordinary().locator('.avatar').hover();await ordinary().locator('[data-action="important-member"]').click();await page.waitForFunction(id=>document.querySelector('[data-message-id="'+id+'"]').classList.contains('is-important'),messages[21].id);
 assert.equal(await ordinary().locator('.message-text').evaluate(el=>getComputedStyle(el).color),rgb(appearance.DEFAULTS.importantText));
 await ordinary().locator('.avatar').hover();await ordinary().locator('[data-action="important-member"]').click();await page.waitForFunction(id=>!document.querySelector('[data-message-id="'+id+'"]').classList.contains('is-important'),messages[21].id);
 assert.equal(await ordinary().locator('.message-text').evaluate(el=>getComputedStyle(el).color),'rgb(18, 58, 188)');sameRead(await read(),initialRead);unchangedSemantic(await computed(),initialComputed);
 pass('Toggling the same sender important then ordinary switches independent text colors immediately without changing reading state');
 stage='bookmarks-account-isolation';
 await page.locator('[data-view="bookmarks"]').click();await page.locator('.bookmark-message').first().waitFor();
 assert.equal(await page.locator('.bookmark-message:not(.is-important):not(.message-system) .message-text').first().evaluate(el=>getComputedStyle(el).color),'rgb(18, 58, 188)');
 assert.equal(await page.locator('.bookmark-message.is-important:not(.message-system) .message-text').first().evaluate(el=>getComputedStyle(el).color),rgb(appearance.DEFAULTS.importantText));
 assert.notEqual(await page.locator('.bookmark-message.message-system .message-text').evaluate(el=>getComputedStyle(el).color),'rgb(18, 58, 188)');
 await page.locator('[data-view="read"]').click();await page.waitForSelector('article[data-message-id]');
 await page.locator('#account-select').selectOption(accountB);await wait(350);assert.equal((await colors()).memberText,'#000000');assert.equal((await computed()).ordinary,'rgb(0, 0, 0)');
 await page.locator('#account-select').selectOption(accountA);await wait(350);assert.deepEqual(await colors(),custom);sameRead(await read(),initialRead,{restored:true});initialRead=await read();
 pass('Collections use matching body colors and preserve system semantics; another account retains default black');
 stage='narrow';
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1000,680));await wait(250);await open();
 const geometry=await page.locator('#modal').evaluate(el=>{const r=el.getBoundingClientRect(),footer=el.querySelector('.modal-footer').getBoundingClientRect();return{top:r.top,bottom:r.bottom,viewport:innerHeight,scroll:el.scrollHeight,client:el.clientHeight,footerBottom:footer.bottom};});
 assert.ok(geometry.top>=0&&geometry.bottom<=geometry.viewport+1);assert.equal(geometry.scroll,geometry.client);assert.ok(geometry.footerBottom<=geometry.viewport+1);await page.locator('#appearance-memberText-hex').scrollIntoViewIfNeeded();await page.locator('#toast').waitFor({state:'hidden'});await page.screenshot({path:path.join(evidence,'synthetic-member-text-settings.png')});await cancel();samples.push({geometry});
 pass('The additional color field remains reachable in a narrow window with accessible controls and footer');
 stage='restart';
 const beforeRestart=await read();await close();await launch();assert.deepEqual(await colors(),custom);assert.equal((await computed()).ordinary,'rgb(18, 58, 188)');sameRead(await read(),beforeRestart,{restored:true});
 pass('Normal close and restart restore the exact saved ordinary color, independent important color and reading marks');
 stage='default-save';
 const beforeReset=await read();await open();await page.locator('#appearance-reset').click();await save();assert.deepEqual(await colors(),appearance.DEFAULTS);assert.equal((await computed()).ordinary,'rgb(0, 0, 0)');sameRead(await read(),beforeReset);
 await page.locator('#toast').waitFor({state:'hidden'});await page.screenshot({path:path.join(evidence,'synthetic-default-black.png')});
 pass('Explicitly saving Restore defaults returns ordinary text to black while retaining message/read state');
 stage='complete';
}catch(error){failure=String(error.stack||error);console.error(failure);}finally{
 try{await close();}catch(error){failure||=String(error);}
 const unchanged=Object.entries(sourceHashes).every(([file,value])=>hash(path.join(appSource,'renderer',file))===value),program=verifyPackaged(packaged);
 const external=runs.some(run=>run.network?.externalUrlObservations>0||run.instrumentation?.network.length),passed=!failure&&!errors.length&&!external&&unchanged&&runs.every(run=>run.code===0)&&(!program||(program.programUnchanged&&program.installDataUnchanged));
 fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({passed,stage,failure,checks,errors,runs,samples,sourceHashes,sourceStillMatches:unchanged,program,dataDir,executablePath,scope:'Only isolated synthetic accounts; no D, real Weibo/AI/Notion, credential writes, or real-message deletion'},null,2));
 console.log(JSON.stringify({passed,checks:checks.length,report:path.join(evidence,'result.json')}));if(!passed)process.exitCode=1;
}})();

