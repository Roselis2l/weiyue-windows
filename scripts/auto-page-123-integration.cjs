'use strict';
// Assigned GUI slot only. Native Electron key events and Playwright pointer
// events operate a real window. All account/message data is synthetic.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {assertWindowsRuntimeReadable}=require('./windows-runtime-check.cjs');
const {packagedInput,validatePackaged,closePackaged,networkSummary,verifyPackaged}=require('./lib/packaged-ui-support.cjs');
const root=path.resolve(__dirname,'..'),packaged=packagedInput();
const harness=fs.mkdtempSync(path.join(os.tmpdir(),'weiyue-paging-123-')),dataDir=path.join(harness,'data');
const evidence=path.resolve(process.env.WEIYUE_AUTO_PAGE_OUTPUT||path.join(root,'artifacts','feature-1.1.23','paging-'+Date.now()));
const appSource=packaged?.appSource||path.join(root,'app'),hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
fs.mkdirSync(dataDir);fs.mkdirSync(evidence,{recursive:true});
const sourceHashes=Object.fromEntries(['main.cjs','core/store.cjs','core/auto-sync.cjs','core/sync-service.cjs','renderer/app.js','renderer/auto-page.js','renderer/drag-scroll.js','renderer/style.css'].map(file=>[file,hash(path.join(appSource,file))]));
if(!packaged){
  const runtime=process.env.WEIYUE_RUNTIME||[path.join(root,'vendor/runtime'),path.resolve(root,'../../vendor/runtime')].find(dir=>fs.existsSync(path.join(dir,'electron.exe')));
  assert(runtime,'A previously verified Electron runtime is required');
  fs.cpSync(runtime,path.join(harness,'runtime'),{recursive:true});fs.cpSync(appSource,path.join(harness,'app'),{recursive:true});fs.copyFileSync(path.join(root,'package.json'),path.join(harness,'package.json'));
}
const executablePath=packaged?.executablePath||path.join(harness,'runtime','electron.exe');
const {Store}=require(path.join(appSource,'core/store.cjs')),store=new Store(path.join(dataDir,'accounts'));
const accountId='paging-123-synthetic',base=Date.parse('2026-10-22T00:00:00Z');
const groups=['up','down','wheel','drag','guards','filtered','late-filter','late-group','failure','small'].map((name,index)=>{
  const id='paging-'+name,total=name==='small'?3:name==='filtered'?1000:800,first=9007199254744000000n+BigInt(index)*10000n;
  return{id,name:'翻页验收 '+name+' · 示例数据',selected:true,messages:Array.from({length:total},(_,i)=>({id:String(first+BigInt(i)),groupId:id,senderId:'synthetic-member',senderName:'合成成员',text:(name==='filtered'?(i%2?'OTHER_TOKEN ':'MATCH_TOKEN '):i===0?'single-filter-result ':'')+'合成阅读消息 '+i+'。仅用于本地键鼠验收。',time:base+i*60000,mediaVersion:1,attachmentVersion:1,referenceVersion:1,contextVersion:1}))};
});
const group=name=>groups.find(g=>g.id==='paging-'+name);
store.ensureAccount({id:accountId,kind:'weibo',name:'翻页验收 · 示例数据'});
store.mergeMessages(accountId,groups.map(({messages,...g})=>g),groups.flatMap(g=>g.messages),{history:true});
store.update(accountId,state=>{state.settings.autoSyncEnabled=false;for(const g of groups){const anchor=g.messages[Math.min(345,g.messages.length-1)],through=g.messages[Math.min(639,g.messages.length-1)];state.readPositions[g.id]=anchor.id;state.readStates[g.id]={anchorId:anchor.id,anchorOffset:0,readThroughId:through.id,atBottom:false,unreadIds:g.messages.filter(m=>BigInt(m.id)>BigInt(through.id)).map(m=>m.id),updatedAt:1000};}});
fs.writeFileSync(path.join(dataDir,'preferences.json'),JSON.stringify({activeId:accountId}));
function boot(){
  const {app,net,session,ipcMain}=require('electron');
  const info=globalThis.__paging123={network:[],calls:[],delayGroup:null,delayMs:0,failGroup:null,held:0};
  const deny=async()=>{info.network.push('external-blocked');throw Error('External services disabled during synthetic acceptance');};globalThis.fetch=deny;
  const nf=net.fetch.bind(net),nr=net.request.bind(net);net.fetch=(url,options)=>/^(?:app|file):/i.test(String(url))?nf(url,options):deny();
  net.request=options=>{const url=typeof options==='string'?options:options.url;if(/^https?:/i.test(String(url))){info.network.push('net-request-blocked');throw Error('External services disabled');}return nr(options);};
  const attached=new WeakSet(),attach=s=>{if(attached.has(s))return;attached.add(s);const fetch=s.fetch.bind(s);s.fetch=(url,options)=>/^(?:app|file):/i.test(String(url))?fetch(url,options):deny();s.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,callback)=>{info.network.push('web-request-blocked');callback({cancel:true});});};
  app.on('session-created',attach);app.whenReady().then(()=>attach(session.defaultSession));
  const handle=ipcMain.handle.bind(ipcMain);ipcMain.handle=(name,handler)=>handle(name,async(event,...args)=>{
    if(name!=='weiyue:call')return handler(event,...args);const [action,payload={}]=args;info.calls.push({action,payload,at:Date.now()});
    const paging=action==='messages.query'&&(payload.beforeId||payload.afterId);
    if(paging&&payload.groupId===info.failGroup){info.failGroup=null;throw Error('Synthetic local page failure');}
    const result=await handler(event,...args);
    if(paging&&payload.groupId===info.delayGroup){info.held++;try{await new Promise(resolve=>setTimeout(resolve,info.delayMs));}finally{info.held--;}}
    return result;
  });
  require('./app/main.cjs');
}
if(!packaged)fs.writeFileSync(path.join(harness,'boot.cjs'),'('+boot.toString()+')();');
const checks=[],samples=[],errors=[],skipped=[];let application,page,stage='prepare',failure=null,processResult={},instrumentation=null;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),pass=label=>{checks.push(label);console.log('PASS '+label);};
async function until(callback,message,timeout=10000){const end=Date.now()+timeout;while(Date.now()<end){if(await callback())return;await wait(60);}throw Error(message);}
const api=(action,payload={})=>page.evaluate(({action,payload})=>window.api.call(action,payload),{action,payload});
const scroll=()=>page.locator('#message-scroll'),rows=()=>page.locator('#message-scroll article[data-message-id]'),count=()=>rows().count();
const reading=async g=>(await api('state')).readStates[g.id];
function sameRead(before,after){assert.equal(after.readThroughId,before.readThroughId);assert.equal(after.unreadCount,before.unreadCount);}
async function viewport(){return scroll().evaluate(el=>{const r=el.getBoundingClientRect(),rows=[...el.querySelectorAll('article[data-message-id]')],first=rows.find(row=>row.getBoundingClientRect().bottom>r.top+1);return{anchorId:first?.dataset.messageId,offset:first?first.getBoundingClientRect().top-r.top:null,positions:Object.fromEntries(rows.map(row=>[row.dataset.messageId,row.getBoundingClientRect().top-r.top])),scrollTop:el.scrollTop,clientHeight:el.clientHeight,scrollHeight:el.scrollHeight,first:rows[0]?.dataset.messageId,last:rows.at(-1)?.dataset.messageId,count:rows.length};});}
// Prepending can legitimately reveal a sliver of the new previous neighbour in
// the old leading day-divider space. Measure the original visible node itself.
const sameViewport=(a,b)=>{samples.push({pixelAnchor:a.anchorId,before:a.offset,after:b.positions[a.anchorId],firstVisibleAfter:b.anchorId});assert.ok(Number.isFinite(b.positions[a.anchorId])&&Math.abs(b.positions[a.anchorId]-a.offset)<=2,'Visible message pixel offset changed');};
async function edge(direction,inset=0){await scroll().evaluate((el,{direction,inset})=>{el.scrollTop=direction<0?inset:el.scrollHeight-el.clientHeight-inset;},{direction,inset});await wait(650);}
async function pointer(){return scroll().evaluate(el=>{const r=el.getBoundingClientRect();return{x:r.right-36,y:r.top+el.clientHeight*.65};});}
async function wheel(delta){const p=await pointer();await page.mouse.move(p.x,p.y);await page.mouse.wheel(0,delta);}
async function focusList(){await scroll().evaluate(el=>el.focus({preventScroll:true}));}
// sendInputEvent delivers Chromium's trusted native input, not dispatchEvent.
async function key(type,key,repeat=false){await application.evaluate(({BrowserWindow},{type,key,repeat})=>{const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()==='app://local/index.html');win.webContents.sendInputEvent({type,keyCode:({ArrowUp:'Up',ArrowDown:'Down'})[key]||key,modifiers:repeat?['isAutoRepeat']:[]});},{type,key,repeat});await wait(40);}
async function press(name){await key('keyDown',name);await key('keyUp',name);}
async function choose(name){const g=group(name);await page.locator('#group-list [data-group-id="'+g.id+'"]').click();await until(async()=>await count()===(name==='small'?3:160)&&await page.locator('#message-scroll [data-message-id="'+g.messages[name==='small'?0:320].id+'"]').count()===1,'Group '+name+' initial page not restored');await wait(650);return g;}
async function pageCalls(id){return application.evaluate((_electron,id)=>globalThis.__paging123.calls.filter(c=>c.action==='messages.query'&&c.payload.groupId===id&&(c.payload.beforeId||c.payload.afterId)),id);}
async function screenshot(name){await page.mouse.move(0,0);await page.screenshot({path:path.join(evidence,name+'.png')});}

(async()=>{try{
  stage='launch';const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const netLog=path.join(evidence,'native-net.json');processResult={preflight:assertWindowsRuntimeReadable(executablePath),netLog};
  application=await _electron.launch({executablePath,args:[...(packaged?[]:[path.join(harness,'boot.cjs')]),'--data-dir='+dataDir,'--log-net-log='+netLog,'--net-log-capture-mode=Default'],cwd:packaged?.installRoot||harness,env,timeout:30000});
  const proc=application.process();processResult.pid=proc.pid;proc.once('exit',(code,signal)=>Object.assign(processResult,{code,signal}));
  if(packaged){processResult.runtime=await validatePackaged(application,packaged,dataDir);assert.equal(processResult.runtime.version,'1.1.23');}
  page=await application.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.waitForSelector('#message-scroll article[data-message-id]');
  await application.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()==='app://local/index.html');w.setSize(1440,930);w.focus();});await wait(700);
  await page.evaluate(()=>{window.__pagingKeys=[];document.addEventListener('keydown',event=>{window.__pagingKeys.push({key:event.key,trusted:event.isTrusted,repeat:event.repeat,target:event.target.id,prevented:event.defaultPrevented});});});
  assert.equal(path.resolve((await api('state')).dataRoot),dataDir);const status=await api('sync.status');assert.equal(status.enabled,false);assert.equal(status.intervalMs,5000);assert.equal(status.backgroundIntervalMs,60000);samples.push({refreshPolicy:status});
  pass('Real window uses only the external synthetic profile and retains 5-second foreground / 60-second background refresh policy');

  stage='passive-and-prepend';const up=group('up'),upRead=await reading(up);await edge(-1);assert.equal(await count(),160);sameRead(upRead,await reading(up));
  await edge(1);await edge(-1);assert.equal(await count(),160);sameRead(upRead,await reading(up));
  const firstOld=page.locator('[data-message-id="'+up.messages[320].id+'"]');await firstOld.locator('.avatar').hover();await firstOld.locator('.message-check').check();await edge(-1);
  const text=await firstOld.locator('.message-text').boundingBox();await page.mouse.move(text.x+3,text.y+8);await page.mouse.down();await page.mouse.move(text.x+110,text.y+8,{steps:6});await page.mouse.up();assert.ok((await page.evaluate(()=>getSelection().toString())).length);
  await page.evaluate(()=>{window.__pagingNodes=[...document.querySelectorAll('#message-scroll article[data-message-id]')];window.__pagingSelection=getSelection().toString();});await focusList();const beforeUp=await viewport();
  await key('keyDown','PageUp');await until(async()=>await count()===320,'PageUp at the top did not prepend');await wait(700);const afterUp=await viewport();sameViewport(beforeUp,afterUp);sameRead(upRead,await reading(up));
  assert.equal(afterUp.first,up.messages[160].id);assert.equal(await page.evaluate(()=>window.__pagingNodes.every(n=>n.isConnected&&document.querySelector('[data-message-id="'+n.dataset.messageId+'"]')===n)),true);assert.equal(await firstOld.locator('.message-check').isChecked(),true);assert.equal(await page.evaluate(()=>getSelection().toString()===window.__pagingSelection),true);
  samples.push({beforeUp,afterUp});pass('PageUp at an existing top prepends 160 prior IDs while preserving DOM nodes, selected IDs, text selection, visible pixels and read high-water');
  stage='key-repeat';await edge(-1);for(let i=0;i<4;i++)await key('keyDown','PageUp',true);await wait(700);assert.equal(await count(),320);await key('keyUp','PageUp');
  await edge(-1,10);await press('ArrowUp');await until(async()=>await count()===480,'ArrowUp reaching the top did not prepend');await wait(650);assert.equal((await viewport()).first,up.messages[0].id);sameRead(upRead,await reading(up));await edge(-1);await press('PageUp');await press('ArrowUp');await wait(650);assert.equal(await count(),480);assert.equal(await page.locator('#previous-page').isDisabled(),true);
  const upEvents=await page.evaluate(()=>window.__pagingKeys.filter(e=>e.key==='PageUp'||e.key==='ArrowUp'));assert.ok(upEvents.some(e=>e.trusted&&e.repeat));assert.ok(upEvents.every(e=>e.trusted));pass('Held native PageUp repeats cannot chain pages; a fresh ArrowUp reaching the top loads the previous page and both keys stop at the true first ID');

  stage='down-keys';const down=await choose('down'),downRead=await reading(down);await edge(1,60);await focusList();await press('PageDown');await until(async()=>await count()===320,'PageDown reaching the bottom did not append');await wait(700);sameRead(downRead,await reading(down));
  await edge(1);const beforeDown=await viewport();await press('ArrowDown');await until(async()=>await count()===480,'ArrowDown already at the bottom did not append');await wait(700);const afterDown=await viewport();sameViewport(beforeDown,afterDown);sameRead(downRead,await reading(down));assert.equal(afterDown.last,down.messages.at(-1).id);assert.equal(await page.locator('#next-page').isDisabled(),true);
  await edge(1);await press('PageDown');await press('ArrowDown');await wait(650);assert.equal(await count(),480);samples.push({beforeDown,afterDown});pass('PageDown reaching bottom and ArrowDown already at bottom each append one local page without consuming unseen unread; both stop at the last ID');

  stage='wheel-both';const wh=await choose('wheel'),whRead=await reading(wh);await edge(-1,40);await wheel(-180);await until(async()=>await count()===320,'Wheel reaching top did not prepend');await wait(650);sameRead(whRead,await reading(wh));
  await edge(1);for(let i=0;i<5;i++){await wheel(100000);await wait(20);}await wait(750);assert.equal(await count(),480,'Continuous wheel burst chained multiple pages');assert.equal((await viewport()).last,wh.messages[639].id);sameRead(whRead,await reading(wh));
  await edge(1);await wheel(60);await until(async()=>await count()===640,'Distinct downward wheel failed');await wait(650);assert.equal((await viewport()).last,wh.messages[799].id);pass('Real upward wheel reaches and prepends at top; continuous downward bursts request one page and a separate gesture may append again');

  stage='drag-top';const drag=await choose('drag'),dragRead=await reading(drag);await edge(-1,40);await scroll().evaluate(el=>{window.__dragClicks=0;el.addEventListener('click',()=>window.__dragClicks++);});const p=await pointer();await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x,p.y+90,{steps:6});await wait(1300);assert.equal(await count(),160);assert.equal(await scroll().evaluate(el=>el.classList.contains('is-dragging')),true);const release=await viewport();assert.ok(release.scrollTop<=2);await page.mouse.up();await until(async()=>await count()===320,'Blank-area upward drag release failed to prepend');await wait(650);sameViewport(release,await viewport());sameRead(dragRead,await reading(drag));assert.equal(await page.evaluate(()=>window.__dragClicks),0);pass('A blank-area drag held at the top defers prepend until release, preserves pixels/high-water, and suppresses its trailing click');

  stage='focus-guards';const guards=await choose('guards'),guardsRead=await reading(guards);await edge(-1);await page.locator('#message-search').focus();for(const name of ['PageUp','PageDown','ArrowUp','ArrowDown'])await press(name);await wait(650);assert.equal(await count(),160);
  await page.evaluate(()=>{const host=document.createElement('div');host.id='synthetic-controls';host.style.cssText='position:fixed;top:170px;left:330px;z-index:100;background:white;padding:4px;display:grid;max-width:250px';host.innerHTML='<input id="guard-input" aria-label="synthetic input"><textarea id="guard-edit" aria-label="synthetic edit"></textarea><select id="guard-select" aria-label="synthetic select"><option>A</option><option>B</option></select><input id="guard-date" type="datetime-local" aria-label="synthetic date"><div id="guard-rich" contenteditable="true">editable fixture</div><video id="guard-media" controls tabindex="0"></video><button id="guard-button">fixture</button><a id="guard-link" href="#">fixture</a>';document.querySelector('#message-scroll').append(host);});
  for(const id of ['guard-input','guard-edit','guard-select','guard-date','guard-rich','guard-media','guard-button','guard-link']){await page.locator('#'+id).focus();await press('PageUp');await press('ArrowDown');assert.equal(await count(),160,'Paging hijacked '+id);}
  const guardedKeys=await page.evaluate(()=>window.__pagingKeys.filter(e=>e.target.startsWith('guard-')||e.target==='message-search'));assert.ok(guardedKeys.length>=20);assert.ok(guardedKeys.every(e=>e.trusted&&!e.prevented),'App prevented a protected control key');await page.locator('#synthetic-controls').evaluate(el=>el.remove());
  await page.locator('#settings-button').click();await page.locator('#modal-close').focus();for(const name of ['PageUp','PageDown','ArrowUp','ArrowDown'])await press(name);await wait(500);assert.equal(await count(),160);await page.locator('#modal-close').click();
  await page.locator('#group-list').evaluate(el=>{el.tabIndex=0;el.focus();});await press('PageDown');await press('ArrowUp');await wait(500);assert.equal(await count(),160);sameRead(guardsRead,await reading(guards));
  pass('Search, inputs, edits, selects, date controls, contenteditable, media, buttons, links, real modal and other column retain their own native keys without message paging');

  stage='mouse-context';await page.evaluate(()=>document.activeElement?.blur());await edge(-1);const ctx=await pointer();await page.mouse.move(ctx.x,ctx.y);await press('ArrowUp');await until(async()=>await count()===320,'Mouse context with body focus did not permit ArrowUp');await wait(650);sameRead(guardsRead,await reading(guards));pass('Unfocused body with pointer over the message list permits native arrow paging, while protected focus does not');

  stage='filtered';const filtered=await choose('filtered'),filterRead=await reading(filtered);await page.locator('#message-search').fill('MATCH_TOKEN');await page.locator('#message-search').press('Enter');await until(async()=>await count()===160&&(await rows().first().getAttribute('data-message-id'))===filtered.messages[0].id,'Filter did not settle');await page.locator('#next-page').click();await until(async()=>(await rows().first().getAttribute('data-message-id'))===filtered.messages[320].id,'Filtered second page missing');await wait(650);await edge(-1);await focusList();await press('PageUp');await until(async()=>await count()===320,'Filtered prepend failed');await wait(650);assert.deepEqual(await rows().evaluateAll(nodes=>nodes.map(n=>n.dataset.messageId)),filtered.messages.filter((_,i)=>i%2===0).slice(0,320).map(m=>m.id));sameRead(filterRead,await reading(filtered));assert.equal((await reading(filtered)).anchorId,filterRead.anchorId);pass('Filtered previous-page cursor yields only matching stable IDs in order and preserves the ordinary reading anchor and unread state');

  stage='small-last';const small=await choose('small');await edge(-1);await focusList();await press('PageUp');await press('ArrowUp');await edge(1);await press('PageDown');await press('ArrowDown');await wheel(-500);await wait(650);assert.equal(await count(),3);assert.equal(await page.locator('#previous-page').isDisabled(),true);assert.equal(await page.locator('#next-page').isDisabled(),true);pass('A short final page does not cascade empty requests from either boundary');

  if(!packaged){
    stage='late-filter';const late=await choose('late-filter');await edge(-1);await focusList();await application.evaluate((_e,id)=>Object.assign(globalThis.__paging123,{delayGroup:id,delayMs:1200}),late.id);await press('PageUp');await until(()=>application.evaluate(()=>globalThis.__paging123.held===1),'Delayed prepend not in flight');await page.locator('#message-search').fill('single-filter-result');await page.locator('#message-search').press('Enter');await until(async()=>await count()===1,'New search did not settle');await wait(1300);assert.equal(await count(),1);assert.equal(await rows().first().getAttribute('data-message-id'),late.messages[0].id);pass('Source-only delayed prepend is discarded after a filter change');
    stage='late-group';const lateGroup=await choose('late-group');await edge(-1);await focusList();await application.evaluate((_e,id)=>Object.assign(globalThis.__paging123,{delayGroup:id,delayMs:1200}),lateGroup.id);await press('PageUp');await until(()=>application.evaluate(()=>globalThis.__paging123.held===1),'Delayed second prepend missing');await choose('small');await wait(1300);assert.equal(await count(),3);assert.equal(await rows().first().getAttribute('data-message-id'),small.messages[0].id);assert.equal((await pageCalls(lateGroup.id)).length,1);pass('Source-only delayed prepend is discarded after switching groups with no concurrent duplicate query');
    stage='failure';const failed=await choose('failure'),failRead=await reading(failed);await edge(-1);await focusList();await application.evaluate((_e,id)=>Object.assign(globalThis.__paging123,{delayGroup:null,failGroup:id}),failed.id);await press('ArrowUp');await until(async()=>await scroll().getAttribute('data-auto-page-state')==='error','Failed prepend did not expose retry state');assert.equal(await count(),160);sameRead(failRead,await reading(failed));assert.equal(await page.locator('#previous-page').isEnabled(),true);await page.locator('#previous-page').click();await until(async()=>await rows().first().getAttribute('data-message-id')===failed.messages[160].id,'Manual previous-page retry failed');assert.equal(await count(),160);sameRead(failRead,await reading(failed));pass('Source-only local read failure preserves existing page/read state and manual previous-page retry opens the exact preceding 160 IDs');
  }else skipped.push('Delayed and failed local response injection runs only against the copied source harness, never against packaged IPC or resources.');
  stage='complete';samples.push({nativeKeys:await page.evaluate(()=>window.__pagingKeys)});await screenshot('synthetic-bidirectional-paging');
}catch(error){failure=String(error.stack||error);console.error(failure);}finally{
  if(application){try{if(!packaged)instrumentation=await application.evaluate(()=>globalThis.__paging123);await closePackaged(application);processResult.network=networkSummary(processResult.netLog);}catch(error){failure||=String(error.stack||error);}}
  const sourceStillMatches=Object.entries(sourceHashes).every(([file,value])=>hash(path.join(appSource,file))===value),program=verifyPackaged(packaged);
  const passed=!failure&&!errors.length&&!processResult.network?.externalUrlObservations&&!(instrumentation?.network.length)&&sourceStillMatches&&processResult.code===0&&(!program||(program.programUnchanged&&program.installDataUnchanged));
  const report={passed,stage,failure,checks,skipped,errors,samples,processResult,instrumentation,sourceHashes,sourceStillMatches,program,harness,dataDir,executablePath,scope:packaged?'Unmodified packaged Windows EXE; external temporary synthetic account; trusted native input; no IPC patch':'Copied source/runtime; external synthetic account; trusted native input; local response delay/failure only'};
  fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed,checks:checks.length,report:path.join(evidence,'result.json')}));if(!passed)process.exitCode=1;
}})();
