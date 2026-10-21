'use strict';
// UI acceptance uses an isolated copy and synthetic data. It never reads the
// installed data directory or contacts Weibo, AI, Notion, or any other server.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {assertWindowsRuntimeReadable}=require('./windows-runtime-check.cjs');
const {packagedInput,validatePackaged,closePackaged,networkSummary,verifyPackaged}=require('./lib/packaged-ui-support.cjs');
const packaged=packagedInput();
const root=path.resolve(__dirname,'..'),harness=fs.mkdtempSync(path.join(os.tmpdir(),'weiyue-layout-118-'));
const evidence=path.resolve(process.env.WEIYUE_LAYOUT_OUTPUT||path.join(root,'artifacts','feature-1.1.18','layout-'+Date.now()));
const appSource=packaged?.appSource||path.resolve(process.env.WEIYUE_LAYOUT_APP||path.join(root,'app'));
const dataDir=path.join(harness,'data'),runtime=path.join(harness,'runtime'),hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
fs.mkdirSync(dataDir);fs.mkdirSync(evidence,{recursive:true});
if(!packaged){fs.cpSync(path.join(root,'vendor/runtime'),runtime,{recursive:true});fs.cpSync(appSource,path.join(harness,'app'),{recursive:true});}
const executablePath=packaged?.executablePath||path.join(runtime,'electron.exe');
const sourceHashes=Object.fromEntries(['renderer/app.js','renderer/style.css'].map(file=>[file,hash(path.join(appSource,file))]));
const fixture={accountId:'weibo-layout-synthetic',groupId:'layout-synthetic-a',secondGroupId:'layout-synthetic-b'};
const base=Date.parse('2026-10-21T00:00:00Z');
const messages=Array.from({length:420},(_,i)=>({id:String(9007199254741300000n+BigInt(i)),groupId:fixture.groupId,senderId:i%2?'member-b':'member-a',senderName:'同名合成成员',text:`合成消息 ${i}，用于布局与阅读位置验证。${i===50?'\n这是多行正文。\n图标应在头像下方。':''}`,time:base+i*60000,mediaVersion:1,attachmentVersion:1}));
const {Store}=require(path.join(packaged?appSource:path.join(harness,'app'),'core/store.cjs'));
const store=new Store(path.join(dataDir,'accounts'));
store.ensureAccount({id:fixture.accountId,kind:'weibo',name:'布局验收 · 示例数据'});
store.mergeMessages(fixture.accountId,[{id:fixture.groupId,name:'阅读布局群 · 示例数据',selected:true},{id:fixture.secondGroupId,name:'独立第二群 · 示例数据',selected:true}],messages.concat({id:'second-1',groupId:fixture.secondGroupId,senderId:'member-a',senderName:'同名合成成员',text:'第二群合成数据',time:base,mediaVersion:1,attachmentVersion:1}),{history:true});
store.update(fixture.accountId,s=>{s.settings.autoSyncEnabled=false;s.importantMembers=['member-a'];s.readPositions[fixture.groupId]=messages[50].id;s.readStates[fixture.groupId]={anchorId:messages[50].id,anchorOffset:0,readThroughId:messages[200].id,atBottom:false,unreadIds:messages.slice(201).map(m=>m.id),updatedAt:1000};});
store.bookmark(fixture.accountId,{groupId:fixture.groupId,messageIds:[messages[50].id,messages[51].id],note:'合成收藏',tags:['布局']});
fs.writeFileSync(path.join(dataDir,'preferences.json'),JSON.stringify({activeId:fixture.accountId}));
function boot(){
  const {app,net,session,ipcMain}=require('electron');
  const info=globalThis.__layoutAcceptance={network:[],calls:[]};
  const deny=async()=>{info.network.push('blocked-external');throw Error('No external service is allowed in layout acceptance');};
  globalThis.fetch=deny;
  const nativeFetch=net.fetch.bind(net),nativeRequest=net.request.bind(net);
  net.fetch=(url,options)=>/^(?:app|file):/i.test(String(url))?nativeFetch(url,options):deny();
  net.request=options=>{const url=typeof options==='string'?options:options.url;if(/^https?:/i.test(String(url))){info.network.push('blocked-net-request');throw Error('No external request allowed');}return nativeRequest(options);};
  const attached=new WeakSet(),attach=s=>{if(attached.has(s))return;attached.add(s);const fetch=s.fetch.bind(s);s.fetch=(url,options)=>/^(?:app|file):/i.test(String(url))?fetch(url,options):deny();s.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,callback)=>{info.network.push('blocked-web-request');callback({cancel:true});});};
  app.on('session-created',attach);app.whenReady().then(()=>attach(session.defaultSession));
  const handle=ipcMain.handle.bind(ipcMain);ipcMain.handle=(name,handler)=>handle(name,async(event,...args)=>{if(name==='weiyue:call')info.calls.push({action:args[0],payload:args[1]});return handler(event,...args);});
  require('./app/main.cjs');
}
if(!packaged)fs.writeFileSync(path.join(harness,'boot.cjs'),'('+boot.toString()+')();');
const checks=[],samples=[],errors=[];let application,page,stage='prepare',failure=null,blocked=[],calls=[],processResult={};
const pass=text=>{checks.push(text);console.log('PASS '+text);};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(callback,message){for(let i=0;i<90;i++){if(await callback())return;await delay(100);}throw Error(message);}
const api=(action,payload={})=>page.evaluate(({action,payload})=>window.api.call(action,payload),{action,payload});
const read=async()=>(await api('state')).readStates[fixture.groupId];
const assertRead=(a,b)=>{assert.equal(a.readThroughId,b.readThroughId);assert.equal(a.unreadCount,b.unreadCount);};
async function resize(width,height){await application.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows()[0].setSize(...size),[width,height]);await delay(500);}
async function geometry(){return page.evaluate(()=>{const rect=selector=>{const el=document.querySelector(selector),r=el.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,scrollWidth:el.scrollWidth,clientWidth:el.clientWidth};};return {viewport:{width:innerWidth,height:innerHeight},header:rect('#workspace-header'),scroll:rect('#message-scroll'),footer:rect('.reading-footer'),previous:rect('#previous-page'),next:rect('#next-page'),range:rect('#page-position'),latest:rect('#jump-latest'),read:rect('#jump-latest-read')};});}
function assertGeometry(g){assert.ok(g.scroll.height>200,'Reading area too short');assert.ok(g.footer.y>=g.scroll.bottom-1,'Footer obscures messages');for(const key of ['previous','next','range','latest','read']){assert.ok(g[key].x>=g.footer.x-1&&g[key].right<=g.footer.right+1,key+' outside footer');assert.ok(g[key].bottom<=g.footer.bottom+1,key+' overlaps outside footer');}assert.ok(g.latest.right<=g.previous.x+1&&g.next.right<=g.read.x+1,'Pagination must sit between both navigation actions');assert.ok(g.footer.scrollWidth<=g.footer.clientWidth+1,'Footer overflows');}
const controls=card=>card.evaluate(el=>{const check=el.querySelector('.message-check'),tools=el.querySelector('.message-tools');return {checkOpacity:getComputedStyle(check).opacity,toolsOpacity:getComputedStyle(tools).opacity,checkPointer:getComputedStyle(check).pointerEvents,toolsPointer:getComputedStyle(tools).pointerEvents,checked:check.checked,height:el.getBoundingClientRect().height,background:getComputedStyle(el).backgroundColor};});
async function assertControls(card,shown){const value=await controls(card);assert.equal(value.checkOpacity,shown?'1':'0');assert.equal(value.toolsOpacity,shown?'1':'0');assert.equal(value.checkPointer,shown?'auto':'none');assert.equal(value.toolsPointer,shown?'auto':'none');return value;}
const hoverAvatar=card=>card.locator('.avatar').hover();
async function hideMouseControls(card){await card.locator('.message-text').hover();await assertControls(card,false);}
(async()=>{try{
  stage='launch';const preflight=assertWindowsRuntimeReadable(executablePath),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const netLog=path.join(evidence,'native-net.json');
  application=await _electron.launch({executablePath,args:packaged?['--data-dir='+dataDir,'--log-net-log='+netLog,'--net-log-capture-mode=Default']:[path.join(harness,'boot.cjs'),'--data-dir='+dataDir],cwd:packaged?.installRoot||harness,env,timeout:30000});
  const nativeProcess=application.process();processResult={pid:nativeProcess.pid,preflight,...(packaged?{netLog,runtime:await validatePackaged(application,packaged,dataDir)}:{})};nativeProcess.once('exit',(code,signal)=>Object.assign(processResult,{code,signal}));
  page=await application.firstWindow();page.on('pageerror',e=>errors.push(e.message));
  await page.waitForSelector('article[data-message-id]');await resize(1440,930);await delay(500);
  const initial=await read();assert.equal(initial.readThroughId,messages[200].id);assert.equal(initial.unreadCount,219);
  assert.equal(path.resolve((await api('state')).dataRoot),dataDir);
  assert.equal(await page.locator('#workspace-header h1').count(),0);
  for(const id of ['auto-sync-toggle','sync-latest','sync-history'])assert.ok(await page.locator('#'+id).isVisible());
  assert.ok(await page.locator('#sync-status-line').textContent());
  const wide=await geometry();assertGeometry(wide);samples.push({wide});
  assert.ok(wide.header.height<=60,'Header still consumes a redundant title row');
  pass('Real isolated Windows app retains synchronization controls/status with no duplicate middle title; pagination sits between latest and latest-read outside the scrolling area');

  stage='rail-and-highlight';
  // The restored anchor intentionally keeps its independent target highlight.
  // Compare two adjacent ordinary rows so that A styling is measured alone.
  const card=page.locator('[data-message-id="'+messages[52].id+'"]'),other=page.locator('[data-message-id="'+messages[51].id+'"]');
  const look=await card.evaluate(el=>{const rail=el.querySelector('.message-rail').getBoundingClientRect(),avatar=el.querySelector('.avatar').getBoundingClientRect(),tools=el.querySelector('.message-tools').getBoundingClientRect(),copy=el.querySelector('.message-copy').getBoundingClientRect();return{rail:{right:rail.right},avatar:{bottom:avatar.bottom},tools:{top:tools.top,right:tools.right},copy:{x:copy.x},font:getComputedStyle(el.querySelector('.sender-name')).fontWeight,color:getComputedStyle(el.querySelector('.sender-name')).color,bar:getComputedStyle(el,'::before').content,background:getComputedStyle(el).backgroundColor};});
  assert.ok(look.tools.top>=look.avatar.bottom&&look.tools.right<look.copy.x);assert.equal(await card.locator('.message-copy .message-tools').count(),0);assert.ok(Number(look.font)>=700);assert.equal(look.bar,'none');
  assert.ok(await card.evaluate(el=>el.classList.contains('is-important')));assert.ok(!await other.evaluate(el=>el.classList.contains('is-important')));
  assert.equal(look.background,'rgb(237, 244, 238)');assert.notEqual(look.background,await other.evaluate(el=>getComputedStyle(el).backgroundColor));
  for(const control of await card.locator('.message-icon').all()){assert.ok(await control.getAttribute('aria-label'));assert.ok(await control.getAttribute('title'));assert.ok(['true','false'].includes(await control.getAttribute('aria-pressed')));}
  assertRead(await read(),initial);pass('Important messages use a pale full-row background and bold theme nickname with no left accent, while same-name other IDs remain ordinary');

  stage='avatar-only-hover';await page.locator('#message-search').click();await page.mouse.move(0,0);
  const idle=await assertControls(card,false);await hideMouseControls(card);
  const hiddenCheck=await card.locator('.message-check').boundingBox();await page.mouse.click(hiddenCheck.x+hiddenCheck.width/2,hiddenCheck.y+hiddenCheck.height/2);
  assert.equal((await controls(card)).checked,false,'An invisible checkbox intercepted a click');await assertControls(card,false);
  await hoverAvatar(card);await assertControls(card,true);
  const toolsBox=await card.locator('.message-tools').boundingBox();await page.mouse.move(toolsBox.x+toolsBox.width/2,toolsBox.y+toolsBox.height/2,{steps:12});await assertControls(card,true);
  await page.mouse.move(hiddenCheck.x+hiddenCheck.width/2,hiddenCheck.y+hiddenCheck.height/2,{steps:12});await assertControls(card,true);
  assert.equal((await controls(card)).height,idle.height);await hideMouseControls(card);assert.equal((await controls(card)).height,idle.height);
  pass('Only avatar entry reveals mouse controls; travelling across avatar, buttons and checkbox stays open, body hover and invisible-control clicks do nothing, and row height never changes');

  stage='mouse-selection';await hoverAvatar(card);await card.locator('.message-check').click();assert.equal((await controls(card)).checked,true);await hideMouseControls(card);
  assert.ok((await card.getAttribute('class')).includes('chosen'));assert.notEqual((await controls(card)).background,look.background);
  await hoverAvatar(other);await other.locator('.message-check').click();await hideMouseControls(other);
  assert.match(await page.locator('#selection-bar').textContent(),/2/);assert.equal((await controls(card)).checked,true);assert.equal((await controls(other)).checked,true);
  await hoverAvatar(other);await other.locator('.message-check').click();await hideMouseControls(other);
  await hoverAvatar(card);await card.locator('.message-check').click();await hideMouseControls(card);
  assert.equal((await controls(card)).checked,false);assert.equal((await controls(card)).background,look.background);
  assert.equal(await page.locator('#selection-bar').isVisible(),false);assertRead(await read(),initial);
  pass('Mouse-selected controls hide again outside the avatar region; selected row and batch count remain clear, and re-hover allows exact multi-selection cancellation');

  stage='keyboard-reveal';await card.locator('.message-check').focus();await page.keyboard.press('Tab');
  assert.equal(await card.locator('[data-action="bookmark-message"]').evaluate(el=>el===document.activeElement&&el.matches(':focus-visible')),true);await assertControls(card,true);
  await page.keyboard.press('Shift+Tab');assert.equal(await card.locator('.message-check').evaluate(el=>el===document.activeElement&&el.matches(':focus-visible')),true);
  await page.keyboard.press('Space');assert.equal((await controls(card)).checked,true);await assertControls(card,true);
  await page.keyboard.press('Space');assert.equal((await controls(card)).checked,false);
  await page.keyboard.press('Tab');await page.keyboard.press('Tab');
  assert.equal(await card.locator('[data-action="important-member"]').evaluate(el=>el===document.activeElement&&el.matches(':focus-visible')),true);await assertControls(card,true);
  pass('Keyboard Tab and Shift+Tab reveal controls with focus outline; Space selects and cancels without requiring mouse hover');

  stage='keyboard-toggle';
  const priority=card.locator('[data-action="important-member"]');await priority.focus();
  assert.ok(await priority.evaluate(el=>getComputedStyle(el).outlineStyle!=='none'),'Keyboard focus invisible');
  await priority.press('Enter');await until(async()=>!(await api('state')).importantMembers.includes('member-a'),'Important member did not clear');
  await until(()=>card.getAttribute('class').then(value=>!value.includes('is-important')),'Important style did not clear');
  assert.equal(await page.locator('.message.is-important[data-sender-id="member-a"]').count(),0);
  const cleared=await card.evaluate(el=>({font:getComputedStyle(el.querySelector('.sender-name')).fontWeight,color:getComputedStyle(el.querySelector('.sender-name')).color,bar:getComputedStyle(el,'::before').content,background:getComputedStyle(el).backgroundColor}));
  assert.ok(Number(cleared.font)<Number(look.font));assert.notEqual(cleared.color,look.color);assert.equal(cleared.bar,'none');assert.notEqual(cleared.background,look.background);
  await until(()=>card.locator('[data-action="important-member"]').evaluate(el=>el===document.activeElement&&el.matches(':focus-visible')),'Keyboard toggle lost focus during message update');await assertControls(card,true);
  assert.equal(await card.locator('[data-action="important-member"]').getAttribute('aria-pressed'),'false');
  await card.locator('[data-action="important-member"]').focus();await card.locator('[data-action="important-member"]').press('Enter');
  await until(()=>card.getAttribute('class').then(value=>value.includes('is-important')),'Important style did not restore');
  assert.equal(await page.locator('.message.is-important[data-sender-id="member-a"]').count(),await page.locator('.message[data-sender-id="member-a"]').count());
  assert.equal(await page.locator('.message.is-important[data-sender-id="member-b"]').count(),0);
  assert.equal((await read()).anchorId,initial.anchorId);
  assertRead(await read(),initial);pass('Keyboard activation and cancellation immediately update all same-ID visible messages without advancing high-water or unread state');

  stage='mouse-priority';await hoverAvatar(card);await card.locator('[data-action="important-member"]').click();
  await until(()=>card.getAttribute('class').then(value=>!value.includes('is-important')),'Mouse toggle did not clear important style');
  await until(()=>card.locator('.message-affordance').getAttribute('class').then(value=>value.includes('is-expanded')),'Mouse toggle lost its still-hovered region during replacement');await assertControls(card,true);assert.notEqual((await controls(card)).background,look.background);
  assert.equal(await page.locator('.message.is-important[data-sender-id="member-a"]').count(),0);
  // No fresh avatar hover: the pointer stays over the same action through redraw.
  await card.locator('[data-action="important-member"]').click();
  await until(()=>card.getAttribute('class').then(value=>value.includes('is-important')),'Mouse toggle did not restore important style');
  await until(()=>card.locator('.message-affordance').getAttribute('class').then(value=>value.includes('is-expanded')),'Repeated mouse toggle lost its active region');await assertControls(card,true);
  await hideMouseControls(card);assert.equal((await controls(card)).background,look.background);assertRead(await read(),initial);
  await card.locator('.message-check').focus();await page.keyboard.press('Space');await assertControls(card,true);assert.equal((await controls(card)).checked,true);
  await hoverAvatar(card);await card.locator('.message-check').click();assert.equal((await controls(card)).checked,false);await hideMouseControls(card);
  await page.keyboard.press('Tab');await assertControls(card,true);assert.equal(await card.locator('[data-action="bookmark-message"]').evaluate(el=>el===document.activeElement&&el.matches(':focus-visible')),true);
  await page.locator('#message-search').click();await hideMouseControls(card);
  pass('Keyboard-to-mouse controls hide after leaving; repeated mouse priority toggles stay clickable through redraw, and keyboard Tab subsequently reveals the controls again');

  stage='search-style';await page.locator('#message-search').fill('合成消息 52，');await page.locator('#message-search').press('Enter');
  await until(()=>page.locator('article[data-message-id]').count().then(count=>count===1),'Search did not return the exact synthetic message');
  assert.ok(await card.isVisible());assert.equal((await controls(card)).background,look.background);await hideMouseControls(card);await hoverAvatar(card);await assertControls(card,true);await hideMouseControls(card);
  assertRead(await read(),initial);assert.equal((await read()).anchorId,initial.anchorId);
  await page.locator('#message-search').fill('');await page.locator('#message-search').press('Enter');
  await until(()=>other.isVisible(),'Clearing search did not restore ordinary reading');
  assertRead(await read(),initial);assert.equal((await read()).anchorId,initial.anchorId);
  pass('Keyword results retain the important background and avatar-only controls; searching and clearing preserve the original reading anchor and unread count');

  stage='bookmark-selection';
  const savedBefore=await api('bookmark.list');assert.equal(savedBefore.length,1);
  const alreadySaved=page.locator('[data-message-id="'+messages[50].id+'"] [data-action="bookmark-message"]');
  assert.equal(await alreadySaved.getAttribute('aria-pressed'),'false');assert.doesNotMatch(await alreadySaved.getAttribute('title'),/已选择/);
  await hoverAvatar(card);await card.locator('[data-action="bookmark-message"]').click();await page.locator('#bookmark-note').waitFor();
  assert.equal(await card.locator('[data-action="bookmark-message"]').getAttribute('aria-pressed'),'true');
  assert.match(await card.locator('[data-action="bookmark-message"]').getAttribute('title'),/已选择/);
  assert.deepEqual(await api('bookmark.list'),savedBefore,'Selection alone must not create a saved bookmark');
  await page.locator('#selection-bar').getByRole('button',{name:'取消',exact:true}).click();
  assert.equal(await card.locator('[data-action="bookmark-message"]').getAttribute('aria-pressed'),'false');
  assert.deepEqual(await api('bookmark.list'),savedBefore);
  await hoverAvatar(card);await card.locator('[data-action="bookmark-message"]').click();await page.locator('#bookmark-note').fill('实际点击保存的合成收藏');await page.locator('#save-bookmark').click();
  await until(()=>api('bookmark.list').then(items=>items.length===2),'Explicit save did not persist bookmark');
  await until(()=>card.locator('[data-action="bookmark-message"]').getAttribute('aria-pressed').then(value=>value==='false'),'Saved bookmark left selection toggle pressed');
  assert.equal((await api('bookmark.list')).filter(item=>item.messageIds.includes(messages[52].id)).length,1);
  assertRead(await read(),initial);assert.equal((await read()).anchorId,initial.anchorId);
  pass('Bookmark icon shows selection rather than saved status: selection/cancel make no bookmark writes, explicit Save persists one exact message, then clears selection');

  stage='narrow';await resize(1000,680);const narrow=await geometry();assertGeometry(narrow);samples.push({narrow});
  await page.locator('#toast').waitFor({state:'hidden'});await hoverAvatar(card);await assertControls(card,true);await page.screenshot({path:path.join(evidence,'synthetic-narrow-hover.png')});await hideMouseControls(card);
  await page.locator('#toast').waitFor({state:'hidden'});await page.screenshot({path:path.join(evidence,'synthetic-narrow.png')});assertRead(await read(),initial);
  pass('Reachable minimum Windows window (1000×680) keeps all footer actions inside its independent area and over 200px of message viewport');

  stage='bookmarks-view';await page.locator('[data-view="bookmarks"]').click();await page.locator('.bookmark-message').first().waitFor();
  assert.equal(await page.locator('#workspace-header h1').count(),0);
  assert.equal(await page.locator('.bookmark-message.is-important[data-sender-id="member-a"]').count(),2);
  assert.equal(await page.locator('.bookmark-message.is-important[data-sender-id="member-b"]').count(),0);
  const bookmarkStyle=await page.locator('.bookmark-message.is-important').first().evaluate(el=>({background:getComputedStyle(el).backgroundColor,left:getComputedStyle(el).borderLeftColor}));assert.equal(bookmarkStyle.background,look.background);assert.equal(bookmarkStyle.left,'rgba(0, 0, 0, 0)');
  assert.ok(await page.locator('#export-bookmarks-md').isVisible());assert.ok(await page.locator('#export-bookmarks-notion').isVisible());
  await page.screenshot({path:path.join(evidence,'synthetic-bookmarks.png')});assertRead(await read(),initial);
  pass('Bookmark view has no redundant title, retains export actions, and highlights only the actual important member ID');

  stage='summaries-view';await api('summary.local',{groupId:fixture.groupId,start:base,end:base+60000*3});
  await page.locator('[data-view="summaries"]').click();await page.locator('.summary-list-card').first().waitFor();
  assert.equal(await page.locator('#workspace-header h1').count(),0);assert.ok(await page.locator('.summary-delete').first().isVisible());
  await page.locator('.summary-open').first().click();await page.locator('.summary-document').waitFor();assert.ok(await page.locator('#export-summary').isVisible());
  assert.equal(await page.locator('#workspace-header h1').count(),0);assertRead(await read(),initial);
  pass('Summary list and detail retain open/delete/export controls after redundant title removal; all summary data is synthetic and local');

  stage='latest-read';await resize(1440,930);await page.locator('[data-view="read"]').click();await page.locator('#jump-latest-read').click();
  await until(()=>page.evaluate(id=>{const scroll=document.getElementById('message-scroll'),card=document.querySelector('[data-message-id="'+id+'"]');return !!card&&Math.abs(card.getBoundingClientRect().top-scroll.getBoundingClientRect().top)<=2;},messages[200].id),'Latest-read target not positioned');await delay(650);
  assertRead(await read(),initial);assert.equal((await read()).anchorId,messages[200].id);await page.locator('#toast').waitFor({state:'hidden'});await page.screenshot({path:path.join(evidence,'synthetic-wide.png')});
  assert.notEqual(await page.locator('[data-message-id="'+messages[200].id+'"]').evaluate(el=>getComputedStyle(el).backgroundColor),look.background,'Important styling overrode the read target highlight');
  pass('Latest-read button still loads the exact prior high-water message without consuming later unread messages');
  stage='complete';
}catch(error){failure=String(error.stack||error);console.error(failure);}finally{
  if(application){if(packaged){await closePackaged(application).catch(error=>failure||=String(error));try{processResult.network=networkSummary(processResult.netLog);blocked=processResult.network.externalHosts;}catch(error){failure||=String(error);}}else{const result=await application.evaluate(()=>globalThis.__layoutAcceptance).catch(()=>({network:['unavailable'],calls:[]}));blocked=result.network;calls=result.calls;await application.close().catch(error=>failure||=String(error));}}
  const unchanged=Object.entries(sourceHashes).every(([file,value])=>hash(path.join(appSource,file))===value);
  const program=verifyPackaged(packaged),passed=!failure&&!errors.length&&!blocked.length&&processResult.code===0&&unchanged&&(!program||(program.programUnchanged&&program.installDataUnchanged));
  const report={passed,stage,failure,checks,samples,errors,blocked,calls,processResult,sourceHashes,sourceStillMatches:unchanged,program,harness,dataDir,executablePath,scope:packaged?'Unmodified actual packaged EXE/resources, synthetic data, native network logs, no boot shim or API instrumentation':'Isolated Windows Electron process, synthetic local account, no real AI/Notion/network'};
  fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed,checks:checks.length,report:path.join(evidence,'result.json')}));if(!passed)process.exitCode=1;
}})();
