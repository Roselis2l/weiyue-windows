'use strict';
// Run only in an assigned GUI slot. All messages/accounts are synthetic; --exe
// launches an unchanged candidate with an external temporary profile.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {assertWindowsRuntimeReadable}=require('./windows-runtime-check.cjs');
const {packagedInput,validatePackaged,closePackaged,networkSummary,verifyPackaged}=require('./lib/packaged-ui-support.cjs');
const root=path.resolve(__dirname,'..'),packaged=packagedInput();
const harness=fs.mkdtempSync(path.join(os.tmpdir(),'weiyue-auto-page-121-')),dataDir=path.join(harness,'data');
const evidence=path.resolve(process.env.WEIYUE_AUTO_PAGE_OUTPUT||path.join(root,'artifacts','feature-1.1.21','auto-page-'+Date.now()));
const appSource=packaged?.appSource||path.join(root,'app'),hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
fs.mkdirSync(dataDir);fs.mkdirSync(evidence,{recursive:true});
const sourceHashes=Object.fromEntries(['renderer/app.js','renderer/index.html','renderer/style.css','renderer/drag-scroll.js','renderer/auto-page.js'].map(file=>[file,hash(path.join(appSource,file))]));
if(!packaged){fs.cpSync(path.join(root,'vendor/runtime'),path.join(harness,'runtime'),{recursive:true});fs.cpSync(appSource,path.join(harness,'app'),{recursive:true});}
const executablePath=packaged?.executablePath||path.join(harness,'runtime','electron.exe');
const {Store}=require(path.join(appSource,'core/store.cjs')),store=new Store(path.join(dataDir,'accounts'));
const accountId='auto-page-synthetic',base=Date.parse('2026-10-21T00:00:00Z');
const groups=[['primary',341,159],['burst',500,499],['drag',500,499],['short',3,2],['filtered',402,159],['important',180,89],['late-filter',321,320],['late-group',321,320],['failure',321,159]].map(([name,count,through],index)=>{
  const id='auto-page-'+name,first=9007199254743000000n+BigInt(index)*10000n;
  return{id,name:'自动续页 '+name+' · 示例数据',selected:true,through,messages:Array.from({length:count},(_,i)=>({id:String(first+BigInt(i)),groupId:id,senderId:name==='important'?(i%2?'synthetic-important-b':'synthetic-important-a'):'synthetic-member',senderName:name==='important'?(i%2?'合成重点成员 B':'合成重点成员 A'):'合成成员',text:(name==='filtered'?(i%2?'OTHER_TOKEN ':'MATCH_TOKEN '):(i===0?'single-filter-result ':''))+'合成分页消息 '+i+'；仅用于本地交互验收。',time:base+i*60000,mediaVersion:1,attachmentVersion:1,referenceVersion:1,contextVersion:1}))};
});
const group=name=>groups.find(item=>item.id==='auto-page-'+name),primary=group('primary');
store.ensureAccount({id:accountId,kind:'weibo',name:'自动续页验收 · 示例数据'});
store.mergeMessages(accountId,groups.map(({messages,through,...item})=>item),groups.flatMap(item=>item.messages),{history:true});
store.update(accountId,state=>{
  state.settings.autoSyncEnabled=false;
  state.importantMembers=['synthetic-important-a','synthetic-important-b'];
  for(const item of groups){state.readPositions[item.id]=item.messages[0].id;state.readStates[item.id]={anchorId:item.messages[0].id,anchorOffset:0,readThroughId:item.messages[item.through].id,atBottom:false,unreadIds:item.messages.slice(item.through+1).map(message=>message.id),updatedAt:1000};}
});
fs.writeFileSync(path.join(dataDir,'preferences.json'),JSON.stringify({activeId:accountId}));

function boot(){
  const {app,net,session,ipcMain}=require('electron');
  const info=globalThis.__autoPageAcceptance={network:[],calls:[],delayGroup:null,delayMs:0,failGroup:null,held:0,shortPages:true};
  const deny=async()=>{info.network.push('blocked-external');throw Error('External services are disabled during synthetic auto-page acceptance');};globalThis.fetch=deny;
  const nativeFetch=net.fetch.bind(net),nativeRequest=net.request.bind(net);
  net.fetch=(url,options)=>/^(?:app|file):/i.test(String(url))?nativeFetch(url,options):deny();
  net.request=options=>{const url=typeof options==='string'?options:options.url;if(/^https?:/i.test(String(url))){info.network.push('blocked-net-request');throw Error('No external request allowed');}return nativeRequest(options);};
  const attached=new WeakSet(),attach=s=>{if(attached.has(s))return;attached.add(s);const fetch=s.fetch.bind(s);s.fetch=(url,options)=>/^(?:app|file):/i.test(String(url))?fetch(url,options):deny();s.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,callback)=>{info.network.push('blocked-web-request');callback({cancel:true});});};
  app.on('session-created',attach);app.whenReady().then(()=>attach(session.defaultSession));
  const handle=ipcMain.handle.bind(ipcMain);ipcMain.handle=(name,handler)=>handle(name,async(event,...args)=>{
    if(name!=='weiyue:call')return handler(event,...args);
    const [action,payload={}]=args;info.calls.push({action,payload,time:Date.now()});
    if(action==='messages.query'&&payload.afterId&&payload.groupId===info.failGroup){info.failGroup=null;throw Error('Synthetic local page failure');}
    let result=await handler(event,...args);
    if(action==='messages.query'&&payload.groupId==='auto-page-short'&&info.shortPages&&result.ok)result={...result,value:{...result.value,messages:result.value.messages.slice(0,1)}};
    // Delay an already-computed response, preserving its original account/query.
    if(action==='messages.query'&&payload.afterId&&!payload.keyword&&payload.groupId===info.delayGroup){info.held++;try{await new Promise(resolve=>setTimeout(resolve,info.delayMs));}finally{info.held--;}}
    return result;
  });
  require('./app/main.cjs');
}
if(!packaged)fs.writeFileSync(path.join(harness,'boot.cjs'),'('+boot.toString()+')();');
const checks=[],samples=[],errors=[],skipped=[];let application,page,stage='prepare',failure=null,processResult={},instrumentation=null;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const pass=description=>{checks.push(description);console.log('PASS '+description);};
async function until(callback,message,timeout=10000){const end=Date.now()+timeout;while(Date.now()<end){if(await callback())return;await wait(60);}throw Error(message);}
const api=(action,payload={})=>page.evaluate(({action,payload})=>window.api.call(action,payload),{action,payload});
const count=()=>page.locator('#message-scroll article[data-message-id]').count();
const reading=async id=>(await api('state')).readStates[id];
const assertUnread=(actual,expected)=>{assert.equal(actual.readThroughId,expected.readThroughId);assert.equal(actual.unreadCount,expected.unreadCount);};
const scroll=()=>page.locator('#message-scroll');
const bottom=async()=>{await scroll().evaluate(el=>{el.scrollTop=el.scrollHeight;});await wait(700);};
const pointer=()=>scroll().evaluate(el=>{const r=el.getBoundingClientRect();return{x:r.right-36,y:r.top+el.clientHeight*.72};});
async function wheel(delta=60){const p=await pointer();await page.mouse.move(p.x,p.y);await page.mouse.wheel(0,delta);}
async function choose(name,expected=160){const item=group(name);await page.locator('#group-list [data-group-id="'+item.id+'"]').click();await until(async()=>await count()===expected&&await page.locator('#message-scroll [data-message-id="'+item.messages[0].id+'"]').count()===1,'Group '+name+' did not restore initial local page');await wait(650);return item;}
async function screenshot(name){await page.mouse.move(0,0);await page.locator('#toast').waitFor({state:'hidden'});await page.screenshot({path:path.join(evidence,name+'.png')});}
async function pageCalls(id){return application.evaluate((_electron,id)=>globalThis.__autoPageAcceptance.calls.filter(call=>call.action==='messages.query'&&call.payload.groupId===id),id);}
async function viewport(){return scroll().evaluate(el=>{const bounds=el.getBoundingClientRect(),rows=[...el.querySelectorAll('article[data-message-id]')],first=rows.find(row=>row.getBoundingClientRect().bottom>bounds.top+1);return{scrollTop:el.scrollTop,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight,anchorId:first?.dataset.messageId,anchorOffset:first?first.getBoundingClientRect().top-bounds.top:null,last:rows.at(-1)?.dataset.messageId,count:rows.length};});}

(async()=>{try{
  stage='launch';const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const netLog=path.join(evidence,'native-net.json');processResult={preflight:assertWindowsRuntimeReadable(executablePath),netLog};
  application=await _electron.launch({executablePath,args:packaged?['--data-dir='+dataDir,'--log-net-log='+netLog,'--net-log-capture-mode=Default']:[path.join(harness,'boot.cjs'),'--data-dir='+dataDir],cwd:packaged?.installRoot||harness,env,timeout:30000});
  const nativeProcess=application.process();processResult.pid=nativeProcess.pid;nativeProcess.once('exit',(code,signal)=>Object.assign(processResult,{code,signal}));if(packaged){processResult.runtime=await validatePackaged(application,packaged,dataDir);assert.equal(processResult.runtime.version,'1.1.21');}
  page=await application.firstWindow();page.on('pageerror',error=>errors.push(error.message));await page.waitForSelector('#message-scroll article[data-message-id]');
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1440,930));await wait(700);
  assert.equal(path.resolve((await api('state')).dataRoot),dataDir);assert.equal(await count(),160);
  const initialRead=await reading(primary.id);assert.equal(initialRead.readThroughId,primary.messages[159].id);assert.equal(initialRead.unreadCount,181);
  stage='passive-position';await bottom();assert.equal(await count(),160);assertUnread(await reading(primary.id),initialRead);
  pass('Opening and programmatically reaching the bottom of a 341-message local group do not append or consume unread messages');

  stage='append-preserve';
  const lastOld=page.locator('[data-message-id="'+primary.messages[159].id+'"]');
  await lastOld.locator('.avatar').hover();await lastOld.locator('.message-check').check();
  await bottom();const text=await lastOld.locator('.message-text').boundingBox();
  await page.mouse.move(text.x+3,text.y+9);await page.mouse.down();await page.mouse.move(text.x+115,text.y+9,{steps:8});await page.mouse.up();
  assert.ok((await page.evaluate(()=>getSelection().toString())).length>0);
  await page.evaluate(()=>{window.__autoPageNodes=[...document.querySelectorAll('#message-scroll article[data-message-id]')];window.__autoPageSelection=getSelection().toString();});
  const beforeAppend=await viewport();await wheel(40);await until(async()=>await count()===320,'A genuine wheel at the local-page bottom did not append exactly one page');await wait(750);
  const afterAppend=await viewport();samples.push({beforeAppend,afterAppend});
  assert.equal(await page.evaluate(()=>window.__autoPageNodes.every(node=>node.isConnected&&document.querySelector('[data-message-id="'+node.dataset.messageId+'"]')===node)),true);
  assert.equal(await page.evaluate(()=>getSelection().toString()===window.__autoPageSelection),true);
  assert.equal(await lastOld.locator('.message-check').isChecked(),true);
  assert.equal(afterAppend.anchorId,beforeAppend.anchorId);assert.ok(Math.abs(afterAppend.anchorOffset-beforeAppend.anchorOffset)<=2,'Append moved the existing visible anchor');
  assertUnread(await reading(primary.id),initialRead);assert.equal(await count(),320);
  pass('Wheel appends 160 local messages without replacing old nodes, text selection, selected IDs or viewport; appended unread messages remain unread');

  stage='fresh-reading';await page.evaluate(()=>getSelection().removeAllRanges());await wheel(230);
  await until(async()=>Number((await reading(primary.id)).unreadCount)<initialRead.unreadCount,'Fresh movement plus dwell did not acknowledge genuinely visible appended messages');
  const afterRead=await reading(primary.id),visible=await scroll().evaluate(el=>{const r=el.getBoundingClientRect();return[...el.querySelectorAll('article[data-message-id]')].filter(row=>{const b=row.getBoundingClientRect();return b.bottom>r.top+1&&b.bottom<=r.top+el.clientHeight+1;}).at(-1)?.dataset.messageId;});
  const advanced=primary.messages.findIndex(message=>message.id===afterRead.readThroughId)-159;
  assert.ok(advanced>0&&advanced<181);assert.equal(afterRead.readThroughId,visible,'Unblocked synthetic text must acknowledge exactly the settled fully visible boundary');assert.equal(afterRead.unreadCount,181-advanced);
  samples.push({afterRead,visible,advanced});pass('Only a separate real downward movement and settled visibility advances the read high-water, decrementing exactly those stable IDs');

  stage='passive-layout';await bottom();const passiveRead=await reading(primary.id);assert.equal(await count(),320);
  await page.evaluate(()=>{const el=document.querySelector('#message-scroll article:last-of-type .message-content');const canvas=document.createElement('canvas');canvas.id='synthetic-resizing-media';canvas.width=24;canvas.height=24;canvas.style.cssText='display:block;width:24px;height:24px';el.append(canvas);});
  await wait(200);await page.locator('#synthetic-resizing-media').evaluate(el=>{el.height=130;el.style.height='130px';});await wait(700);
  await page.locator('#settings-button').click();await page.locator('#configure-appearance').click();await page.locator('#appearance-memberBubble-hex').fill('#eee');await wait(650);
  assert.equal(await count(),320);assertUnread(await reading(primary.id),passiveRead);await page.locator('#modal-close').click();await page.locator('#modal-close').click();
  await page.locator('#synthetic-resizing-media').evaluate(el=>el.remove());await wait(700);assert.equal(await count(),320);assertUnread(await reading(primary.id),passiveRead);
  pass('Synthetic media size changes, passive repositioning and local appearance preview cannot trigger another page or acknowledge unread messages');

  stage='last-page';await scroll().evaluate(el=>{el.scrollTop=el.scrollHeight-el.clientHeight-60;});await wait(700);assert.equal(await count(),320);await wheel(180);await until(async()=>await count()===341,'One real wheel from 60px above the bottom did not append the final partial page');await wait(700);
  assert.equal(await page.locator('#next-page').isDisabled(),true);assert.equal((await viewport()).last,primary.messages.at(-1).id);
  const atEndRead=await reading(primary.id);await wheel(100000);await wait(700);assert.equal(await count(),341);assert.ok(Number((await reading(primary.id)).unreadCount)<=atEndRead.unreadCount);
  await screenshot('synthetic-appended-last-page');pass('A single wheel from 60px above the bottom reaches the edge and appends the final 21-message page without duplication, then disables paging at the true local end');

  stage='wheel-burst';const burst=await choose('burst');await bottom();const burstCalls=packaged?null:(await pageCalls(burst.id)).filter(call=>call.payload.afterId).length;
  for(let i=0;i<5;i++){await wheel(100000);await wait(25);}await wait(850);
  assert.equal(await count(),320,'One continuous wheel burst loaded multiple pages');
  if(!packaged)assert.equal((await pageCalls(burst.id)).filter(call=>call.payload.afterId).length-burstCalls,1);
  await wheel(100000);await until(async()=>await count()===480,'A later wheel gesture did not append its next page');
  pass('A large continuous wheel burst requests at most one local page; a later distinct wheel gesture can append the next page');

  stage='drag';const dragging=await choose('drag');await scroll().evaluate(el=>{el.scrollTop=el.scrollHeight-el.clientHeight-40;});await wait(700);
  const dragRead=await reading(dragging.id);await scroll().evaluate(el=>{window.__autoPageDragClicks=0;el.addEventListener('click',()=>window.__autoPageDragClicks++);});
  const p=await pointer();await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x,p.y-70,{steps:6});
  assert.equal(await scroll().evaluate(el=>el.classList.contains('is-dragging')),true);await wait(1350);
  assert.equal(await count(),160,'Held drag must not replace its scroll geometry before release');
  await page.mouse.move(p.x,p.y-200,{steps:6});await wait(100);assert.equal(await count(),160);
  const releaseAnchor=await viewport();assert.ok(releaseAnchor.scrollHeight-releaseAnchor.clientHeight-releaseAnchor.scrollTop<=2,'Fixture drag must reach the old page bottom');
  await page.mouse.up();await until(async()=>await count()===320,'Released blank-area drag did not append exactly one page');await wait(700);
  const appendedAnchor=await viewport();assert.equal(appendedAnchor.anchorId,releaseAnchor.anchorId);assert.ok(Math.abs(appendedAnchor.anchorOffset-releaseAnchor.anchorOffset)<=2);assertUnread(await reading(dragging.id),dragRead);
  assert.equal(await scroll().evaluate(el=>el.classList.contains('is-dragging')),false);assert.equal(await page.evaluate(()=>window.__autoPageDragClicks),0,'Trailing drag click was not suppressed');
  const afterRelease=await pointer();await page.mouse.move(afterRelease.x,afterRelease.y+20,{steps:4});await wait(300);assert.equal(await count(),320);
  await page.mouse.click(afterRelease.x,afterRelease.y);assert.equal(await page.evaluate(()=>window.__autoPageDragClicks),1,'The next deliberate background click was suppressed');
  samples.push({releaseAnchor,appendedAnchor});pass('A drag held at the bottom beyond 1.2 seconds appends exactly once on release, preserves anchor/high-water and suppresses only its trailing click');

  stage='short-page';const small=await choose('short',packaged?3:1);const shortRead=await reading(small.id),shortGeometry=await scroll().evaluate(el=>{const rows=[...el.querySelectorAll('article[data-message-id]')];return{contentHeight:rows.at(-1).getBoundingClientRect().bottom-rows[0].getBoundingClientRect().top,clientHeight:el.clientHeight,scrollHeight:el.scrollHeight};});assert.ok(shortGeometry.contentHeight<shortGeometry.clientHeight,'Short message content must fit within one viewport; the existing read-anchor tail spacer is allowed');samples.push({shortGeometry});
  await wait(700);assert.equal(await count(),packaged?3:1);
  if(packaged){await wheel(200);await wait(700);assert.equal(await count(),3);assert.equal(await page.locator('#next-page').isDisabled(),true);pass('An underscreen final local page remains stable and cannot spin into repeated empty page requests');}
  else{await wheel(100);await until(async()=>await count()===2,'An underscreen page did not respond to a real wheel intent');await wait(800);assert.equal(await count(),2,'Underscreen append chained another request without new input');await wheel(100);await until(async()=>await count()===3,'Second deliberate short-page gesture failed');assert.equal(await page.locator('#next-page').isDisabled(),true);pass('Source-only short-response simulation appends one underscreen item per gesture and stops exactly at the final page');}
  assertUnread(await reading(small.id),shortRead);

  stage='filtered-append';const filtered=await choose('filtered'),ordinaryRead=await reading(filtered.id),ordinaryViewport=await viewport();
  await page.locator('#message-search').fill('MATCH_TOKEN');await page.locator('#message-search').press('Enter');
  await until(async()=>await count()===160&&(await page.locator('#message-scroll .message-text').first().textContent()).includes('MATCH_TOKEN'),'Filtered first local page did not settle');
  await bottom();assert.equal(await count(),160);assertUnread(await reading(filtered.id),ordinaryRead);
  await wheel(50);await until(async()=>await count()===201,'Filtered local paging did not append the remaining 41 matching records');await wait(700);
  const matchedIds=await page.locator('#message-scroll article[data-message-id]').evaluateAll(rows=>rows.map(row=>row.dataset.messageId));
  assert.deepEqual(matchedIds,filtered.messages.filter((_,index)=>index%2===0).map(message=>message.id));assert.equal(new Set(matchedIds).size,201);
  assert.equal(await page.locator('#message-search').inputValue(),'MATCH_TOKEN');assert.equal(await page.locator('#next-page').isDisabled(),true);
  const afterFiltered=await reading(filtered.id);assertUnread(afterFiltered,ordinaryRead);assert.equal(afterFiltered.anchorId,ordinaryRead.anchorId);assert.equal(afterFiltered.anchorOffset,ordinaryRead.anchorOffset);
  await page.locator('#message-search').fill('');await page.locator('#message-search').press('Enter');await until(async()=>await count()===160,'Clearing filter did not restore the ordinary page');await wait(700);
  const restoredViewport=await viewport();assert.equal(restoredViewport.anchorId,ordinaryViewport.anchorId);assert.ok(Math.abs(restoredViewport.anchorOffset-ordinaryViewport.anchorOffset)<=2);assertUnread(await reading(filtered.id),ordinaryRead);
  pass('Filtered automatic paging appends exactly 201 matching IDs in order without duplicates, preserves keyword/unread/ordinary anchor, and clearing restores ordinary reading');

  stage='important-only-removal';const important=await choose('important'),beforeImportantRead=await reading(important.id);
  if(!await page.locator('#important-filter').isVisible())await page.locator('#filter-toggle').click();
  await page.locator('#important-filter').check();await until(async()=>await count()===160&&await page.locator('#important-filter').isChecked(),'Important-only results did not settle');await wait(400);
  const senderA=page.locator('#message-scroll article[data-sender-id="synthetic-important-a"]').first();await senderA.locator('.avatar').hover();
  assert.equal(await senderA.locator('[data-action="important-member"]').getAttribute('aria-pressed'),'true');await senderA.locator('[data-action="important-member"]').click();
  await until(async()=>await count()===90&&await page.locator('#message-scroll article[data-sender-id="synthetic-important-a"]').count()===0,'Removing a current important sender did not reload the remaining filtered members');await wait(650);
  const remainingImportant=await page.locator('#message-scroll article[data-message-id]').evaluateAll(rows=>rows.map(row=>row.dataset.messageId));
  assert.deepEqual(remainingImportant,important.messages.filter((_,index)=>index%2===1).map(message=>message.id));assert.equal(new Set(remainingImportant).size,90);
  assert.equal(await page.locator('#important-filter').isChecked(),true);assert.equal(await page.locator('#next-page').isDisabled(),true);assertUnread(await reading(important.id),beforeImportantRead);
  assert.equal((await api('state')).importantMembers.includes('synthetic-important-a'),false);assert.equal((await api('state')).importantMembers.includes('synthetic-important-b'),true);
  await page.locator('#important-filter').uncheck();await until(async()=>await count()===160&&await page.locator('#message-scroll article[data-sender-id="synthetic-important-a"]').count()===80,'Removing the importance filter did not restore ordinary results');await wait(650);
  assert.deepEqual(await page.locator('#message-scroll article[data-message-id]').evaluateAll(rows=>rows.map(row=>row.dataset.messageId)),important.messages.slice(0,160).map(message=>message.id));assertUnread(await reading(important.id),beforeImportantRead);
  pass('Cancelling sender A through its real message action while Important-only is checked reloads exactly 90 sender-B records; clearing the filter restores ordinary IDs without false unread acknowledgement');

  if(!packaged){
    stage='late-filter';const lateFilter=await choose('late-filter');await bottom();
    await application.evaluate((_electron,id)=>{Object.assign(globalThis.__autoPageAcceptance,{delayGroup:id,delayMs:1000});},lateFilter.id);await wheel(40);await until(()=>application.evaluate(()=>globalThis.__autoPageAcceptance.held===1),'Delayed local page was not in flight');
    await page.locator('#message-search').fill('single-filter-result');await page.locator('#message-search').press('Enter');await until(async()=>await count()===1,'Search did not produce its isolated one-message result');await wait(1200);
    assert.equal(await count(),1);assert.equal(await page.locator('#message-scroll article').first().getAttribute('data-message-id'),lateFilter.messages[0].id);assert.equal((await reading(lateFilter.id)).unreadCount,0);
    pass('A delayed response from the previous unfiltered page cannot append into newer filtered results (source-only response delay)');
    stage='late-group';const lateGroup=await choose('late-group');await bottom();
    await application.evaluate((_electron,id)=>{Object.assign(globalThis.__autoPageAcceptance,{delayGroup:id,delayMs:1000});},lateGroup.id);await wheel(40);await until(()=>application.evaluate(()=>globalThis.__autoPageAcceptance.held===1),'Second delayed page was not in flight');
    await page.locator('#group-list [data-group-id="'+small.id+'"]').click();await until(async()=>await page.locator('#message-scroll [data-message-id="'+small.messages[0].id+'"]').count()===1,'New group did not render');const nextGroupIds=await page.locator('#message-scroll article').evaluateAll(rows=>rows.map(row=>row.dataset.messageId));await wait(1200);
    assert.deepEqual(await page.locator('#message-scroll article').evaluateAll(rows=>rows.map(row=>row.dataset.messageId)),nextGroupIds);assert.equal((await reading(lateGroup.id)).unreadCount,0);
    pass('A late local-page response cannot insert its messages into another selected group (source-only response delay)');
    stage='failure-retry';const failedGroup=await choose('failure');await bottom();
    const beforeFailure=await viewport(),beforeFailureRead=await reading(failedGroup.id);await application.evaluate((_electron,id)=>{Object.assign(globalThis.__autoPageAcceptance,{delayGroup:null,delayMs:0,failGroup:id});},failedGroup.id);await wheel(40);
    await until(async()=>await page.locator('#next-page').isEnabled()&&await scroll().getAttribute('data-auto-page-state')==='error','Failed append did not expose its retry state');await wait(750);
    assert.ok((await pageCalls(failedGroup.id)).some(call=>call.payload.afterId===failedGroup.messages[159].id));assert.ok((await page.locator('#next-page').getAttribute('title'))?.length,'Page-read error needs a visible retry explanation');
    assert.equal(await count(),160);assert.equal((await viewport()).anchorId,beforeFailure.anchorId);assertUnread(await reading(failedGroup.id),beforeFailureRead);
    await page.locator('#next-page').click();await until(async()=>await page.locator('#message-scroll article').first().getAttribute('data-message-id')===failedGroup.messages[160].id,'Manual recovery did not open the failed next local page');await wait(700);
    const recoveredIds=await page.locator('#message-scroll article[data-message-id]').evaluateAll(rows=>rows.map(row=>row.dataset.messageId));
    assert.deepEqual(recoveredIds,failedGroup.messages.slice(160,320).map(message=>message.id));assert.equal(new Set(recoveredIds).size,160);assertUnread(await reading(failedGroup.id),beforeFailureRead);
    pass('A failed automatic append preserves its old page/anchor; manual More recovers exactly the next 160 IDs using normal page replacement, with no duplicate, skipped ID or unread acknowledgement');
  }else skipped.push('Failure and delayed-response injection are source-only; packaged resources and IPC are never patched.');
  stage='complete';await screenshot('synthetic-auto-page-complete');
}catch(error){failure=String(error.stack||error);console.error(failure);}finally{
  if(application){try{if(packaged){await closePackaged(application);processResult.network=networkSummary(processResult.netLog);}else{instrumentation=await application.evaluate(()=>globalThis.__autoPageAcceptance);await application.close();}}catch(error){failure||=String(error.stack||error);}}
  const sourceStillMatches=Object.entries(sourceHashes).every(([file,value])=>hash(path.join(appSource,file))===value),program=verifyPackaged(packaged);
  const external=packaged?processResult.network?.externalUrlObservations:instrumentation?.network.length;
  const passed=!failure&&!errors.length&&!external&&sourceStillMatches&&processResult.code===0&&(!program||(program.programUnchanged&&program.installDataUnchanged));
  const report={passed,stage,failure,checks,skipped,errors,samples,processResult,instrumentation,sourceHashes,sourceStillMatches,program,harness,dataDir,executablePath,scope:packaged?'Unmodified packaged Windows EXE; external temporary synthetic profile; native network log; no IPC injection':'Copied source/runtime with isolated synthetic data; only local page results delayed/failed/shortened; no external service'};
  fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed,checks:checks.length,report:path.join(evidence,'result.json')}));if(!passed)process.exitCode=1;
}})();
