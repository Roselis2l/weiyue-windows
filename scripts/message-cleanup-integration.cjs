'use strict';
// Independent synthetic Windows acceptance. No installed application, real
// account, service credential, network request, AI or Notion write is used.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {assertWindowsRuntimeReadable}=require('./windows-runtime-check.cjs');
const {packagedInput,validatePackaged,closePackaged,networkSummary,verifyPackaged}=require('./lib/packaged-ui-support.cjs');
const packaged=packagedInput();
const root=path.resolve(__dirname,'..'),harness=fs.mkdtempSync(path.join(os.tmpdir(),'weiyue-cleanup-ui-'));
const evidence=path.resolve(process.env.WEIYUE_CLEANUP_OUTPUT||path.join(root,'artifacts','feature-1.1.17','cleanup-ui-'+Date.now()));
const appSource=packaged?.appSource||path.resolve(process.env.WEIYUE_CLEANUP_APP||path.join(root,'app'));
const dataDir=path.join(harness,'data'),runtime=path.join(harness,'runtime');
fs.mkdirSync(dataDir);fs.mkdirSync(evidence,{recursive:true});if(!packaged){fs.cpSync(path.join(root,'vendor/runtime'),runtime,{recursive:true});fs.cpSync(appSource,path.join(harness,'app'),{recursive:true});}
const testApp=packaged?appSource:path.join(harness,'app');
const executablePath=packaged?.executablePath||path.join(runtime,'electron.exe'),hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const files=['main.cjs','preload.cjs','core/store.cjs','core/message-cleanup.cjs','core/message-cleanup-controller.cjs','renderer/app.js','renderer/index.html','renderer/message-cleanup.js','renderer/message-cleanup.css','renderer/filter-controls.js'];
const sourceHashes=Object.fromEntries(files.map(file=>[file,hash(path.join(testApp,file))]));
const fixture={accountId:'synthetic-cleanup-a',otherAccountId:'synthetic-cleanup-b',groupId:'synthetic-group-a',otherGroupId:'synthetic-group-b'};
const base=Date.parse('2026-10-21T09:00:00+08:00');
const messages=Array.from({length:24},(_,i)=>({id:String(9007199254741600000n+BigInt(i)),groupId:fixture.groupId,senderId:[12,13].includes(i)?'retain-id':i===3?'same-name-other':'ordinary-id',senderName:[3,12,13].includes(i)?'同名合成成员':'其他合成成员',text:i===3?'<script>不得执行的合成文本</script>':`合成原文 ${i}`,time:i===0?base-1:i===1?base:i===2?base+59999:base+(i-2)*60000,mediaVersion:1,attachmentVersion:1}));
const otherMessages=Array.from({length:5},(_,i)=>({id:'B'+i,groupId:fixture.otherGroupId,senderId:'other-group-member',senderName:'其他群合成成员',text:'独立群合成原文 '+i,time:base+i*60000,mediaVersion:1,attachmentVersion:1}));
const {Store}=require(path.join(testApp,'core/store.cjs'));
const {prepareSummary,localSummary}=require(path.join(testApp,'core/summary.cjs'));
const store=new Store(path.join(dataDir,'accounts'));
const groups=[{id:fixture.groupId,name:'清理验证甲群 · 示例数据',selected:true},{id:fixture.otherGroupId,name:'清理验证乙群 · 示例数据',selected:true}];
store.ensureAccount({id:fixture.accountId,name:'本地清理验收甲 · 示例数据',kind:'import'});store.mergeMessages(fixture.accountId,groups,messages.concat(otherMessages),{history:true});
store.ensureAccount({id:fixture.otherAccountId,name:'本地清理验收乙 · 示例数据',kind:'import'});store.mergeMessages(fixture.otherAccountId,groups,messages.slice(0,5),{history:true});
const saved=store.bookmark(fixture.accountId,{groupId:fixture.groupId,messageIds:[messages[4].id],note:'必须保留的合成备注',tags:['合成标签']});
const summary=localSummary(prepareSummary({messages:[messages[14],messages[15]],group:groups[0],start:base+12*60000,end:base+15*60000}));
const syntheticAi={...localSummary(prepareSummary({messages:[messages[17]],group:groups[0],start:base+15*60000,end:base+16*60000})),mode:'ai',title:'完全合成的 AI 来源记录（从未请求 AI）'};
store.update(fixture.accountId,s=>{
  s.settings.autoSyncEnabled=false;s.importantMembers=['retain-id'];s.summaries=[summary,syntheticAi,{id:'legacy-b',groupId:fixture.otherGroupId,title:'缺少范围的合成旧摘要',body:'不能推断来源范围',refs:[]}];
  s.exports={synthetic:{summaryId:summary.id,sourceType:'summary',sourceIds:[summary.id],status:'completed',pageId:'synthetic-page'}};
  s.readPositions[fixture.groupId]=messages[6].id;s.readStates[fixture.groupId]={anchorId:messages[6].id,anchorOffset:0,readThroughId:messages[8].id,atBottom:false,unreadIds:[messages[20].id,messages[21].id],updatedAt:1000};
  s.groups[0].latestPendingRanges=[{cursor:messages[18].id,baselineId:messages[10].id,arrivalAfterId:messages[10].id,status:'pending'}];
});
store.update(fixture.otherAccountId,s=>{s.settings.autoSyncEnabled=false;});
fs.writeFileSync(path.join(dataDir,'preferences.json'),JSON.stringify({activeId:fixture.accountId}));
function boot(){
  const {app,net,session,ipcMain}=require('electron');
  const {Store}=require('./app/core/store.cjs');
  const info=globalThis.__cleanupAcceptance={network:[],calls:[],previews:[],failWrite:false,holdApply:false,held:false,release:null};
  const originalWrite=Store.prototype._write;
  Store.prototype._write=function(id,state){if(info.failWrite&&state.messages.some(m=>m.localDeletion)){info.failWrite=false;throw Error('模拟保存失败：原文件未改动');}return originalWrite.call(this,id,state);};
  const deny=async()=>{info.network.push('blocked-external');throw Error('EXTERNAL_DISABLED_FOR_SYNTHETIC_ACCEPTANCE');};
  globalThis.fetch=deny;
  const nativeFetch=net.fetch.bind(net),nativeRequest=net.request.bind(net);
  net.fetch=(url,options)=>/^(?:app|file):/i.test(String(url))?nativeFetch(url,options):deny();
  net.request=options=>{const url=typeof options==='string'?options:options.url;if(/^https?:/i.test(String(url))){info.network.push('blocked-net-request');throw Error('EXTERNAL_DISABLED');}return nativeRequest(options);};
  const attached=new WeakSet(),attach=s=>{if(attached.has(s))return;attached.add(s);const fetch=s.fetch.bind(s);s.fetch=(url,options)=>/^(?:app|file):/i.test(String(url))?fetch(url,options):deny();s.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,callback)=>{info.network.push('blocked-web-request');callback({cancel:true});});};
  app.on('session-created',attach);app.whenReady().then(()=>attach(session.defaultSession));
  const handle=ipcMain.handle.bind(ipcMain);
  ipcMain.handle=(channel,handler)=>handle(channel,async(event,action,payload)=>{
    if(channel==='weiyue:call'){
      info.calls.push({action,payload});
      if(action==='messages.cleanup.apply'&&info.holdApply){info.held=true;await new Promise(resolve=>info.release=resolve);info.held=false;info.holdApply=false;info.release=null;}
    }
    const result=await handler(event,action,payload);
    if(channel==='weiyue:call'&&action==='messages.cleanup.preview'&&result?.ok)info.previews.push(result.value);
    return result;
  });
  require('./app/main.cjs');
}
if(!packaged)fs.writeFileSync(path.join(harness,'boot.cjs'),'('+boot.toString()+')();');
const checks=[],errors=[],runs=[],processes=[];let application,page,stage='prepare',failure=null,lastSelection;
const pass=text=>{checks.push(text);console.log('PASS '+text);},delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,message,timeout=12000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await delay(100);}throw Error(message);}
const api=(action,payload={})=>page.evaluate(({action,payload})=>window.api.call(action,payload),{action,payload});
const data=()=>new Store(path.join(dataDir,'accounts')).get(fixture.accountId);
function protectedState(s){return{bookmarks:s.bookmarks,summaries:s.summaries,exports:s.exports,settings:s.settings,importantMembers:s.importantMembers,groups:s.groups,readPositions:s.readPositions,readStates:Object.fromEntries(Object.entries(s.readStates).map(([id,r])=>[id,{anchorId:r.anchorId,readThroughId:r.readThroughId,unreadIds:r.unreadIds}]))};}
const activeIds=()=>data().messages.filter(m=>m.groupId===fixture.groupId&&!m.localDeletion).map(m=>m.id);
async function launch(){
  const preflight=assertWindowsRuntimeReadable(executablePath),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const netLog=path.join(evidence,'native-net-'+(processes.length+1)+'.json');
  application=await _electron.launch({executablePath,args:packaged?['--data-dir='+dataDir,'--log-net-log='+netLog,'--net-log-capture-mode=Default']:[path.join(harness,'boot.cjs'),'--data-dir='+dataDir],cwd:packaged?.installRoot||harness,env,timeout:30000});
  const p=application.process(),record={pid:p.pid,preflight,...(packaged?{netLog,runtime:await validatePackaged(application,packaged,dataDir)}:{})};processes.push(record);p.once('exit',(code,signal)=>Object.assign(record,{code,signal}));
  page=await application.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.waitForSelector('article[data-message-id]');await resize(1000,680);await delay(650);
}
async function close(){if(!application)return;if(packaged){await closePackaged(application);const network=networkSummary(processes.at(-1).netLog);processes.at(-1).network=network;runs.push({network:network.externalHosts,calls:[],previews:[]});}else{await application.evaluate(()=>globalThis.__cleanupAcceptance.release?.());runs.push(await application.evaluate(()=>{const i=globalThis.__cleanupAcceptance;return{network:i.network,calls:i.calls,previews:i.previews};}));await application.close();}application=null;}
async function resize(w,h){await application.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows()[0].setSize(...size),[w,h]);await delay(400);}
async function openCleanup(){await page.locator('#settings-button').click();await page.locator('#manage-local-data').click();await until(()=>page.locator('#cleanup-preview').isEnabled(),'Cleanup form failed to load');}
async function closeDialog(){await page.locator('#modal-close').click();await until(()=>page.locator('#modal').evaluate(d=>!d.open),'Modal did not close');}
async function range(start,end){await page.locator('#cleanup-start').fill(start);await page.locator('#cleanup-end').fill(end);}
async function preview(){lastSelection=await page.locator('.cleanup-form').evaluate(el=>({groupId:el.querySelector('#cleanup-group').value,startMinute:el.querySelector('#cleanup-start').value,endMinute:el.querySelector('#cleanup-end').value,retainSenderIds:[...el.querySelectorAll('#cleanup-members input[type="checkbox"]:checked')].map(i=>i.value),retainSummaryRanges:el.querySelector('#cleanup-keep-summaries').checked}));lastSelection.accountId=(await api('state')).account.id;await page.locator('#cleanup-preview').click();await page.locator('#cleanup-confirm').waitFor();await assertPreviewGeometry();return page.locator('.cleanup-preview').innerText();}
async function assertPreviewGeometry(){const g=await page.locator('#modal').evaluate(el=>{const head=el.querySelector('.modal-head').getBoundingClientRect(),body=el.querySelector('.modal-body').getBoundingClientRect(),footer=el.querySelector('.modal-footer').getBoundingClientRect(),time=el.querySelector('.cleanup-preview>p').getBoundingClientRect();return{outerScroll:el.scrollHeight>el.clientHeight+1,bodyBelowTitle:body.top>=head.bottom-1,bodyAboveFooter:body.bottom<=footer.top+1,timeVisible:time.top>=body.top-1&&time.bottom<=body.bottom+1,buttonsVisible:[...el.querySelectorAll('.modal-footer button')].every(b=>{const r=b.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&r.right<=innerWidth&&r.left>=0;})};});assert.deepEqual(g,{outerScroll:false,bodyBelowTitle:true,bodyAboveFooter:true,timeVisible:true,buttonsVisible:true},'Cleanup preview must use a single body scroller with title, time range and footer visible');}
async function back(){await page.locator('#cleanup-back').click();await until(()=>page.locator('#cleanup-preview').isEnabled(),'Back to cleanup filter failed');}
async function chooseRetained(){const toggle=page.locator('#cleanup-members .member-picker-toggle');if(!await page.locator('#cleanup-members .member-picker-search').isVisible())await toggle.click();await page.locator('#cleanup-members .member-picker-search').fill('同名');await page.locator('#cleanup-members input[value="retain-id"]').check();await toggle.click();}
const countCalls=action=>packaged?Promise.resolve(null):application.evaluate((_electron,action)=>globalThis.__cleanupAcceptance.calls.filter(c=>c.action===action).length,action);
// The packaged mode never instruments IPC. Its independent, read-only preview
// checks the displayed result; only actual feature buttons perform valid writes.
async function getPlan(){return packaged?api('messages.cleanup.preview',lastSelection):application.evaluate(()=>globalThis.__cleanupAcceptance.previews.at(-1));}
(async()=>{try{
  stage='launch';await launch();await openCleanup();const before=protectedState(data());assert.equal(path.resolve((await api('state')).dataRoot),dataDir);
  const bounds=await page.locator('#modal').evaluate(el=>{const r=el.getBoundingClientRect(),body=el.querySelector('.modal-body');return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight,overflow:body.scrollWidth>body.clientWidth+1};});
  assert.ok(bounds.x>=0&&bounds.y>=0&&bounds.right<=bounds.width+1&&bounds.bottom<=bounds.height+1&&!bounds.overflow);
  await page.locator('#cleanup-oldest').click();assert.equal(await page.locator('#cleanup-start').inputValue(),'2026-10-21T08:59');
  await page.locator('#cleanup-end').fill('2000-01-01T00:00');const nowBefore=Date.now();await page.locator('#cleanup-now').click();const nowValue=Date.parse((await page.locator('#cleanup-end').inputValue())+':00+08:00');assert.ok(nowValue>=Math.floor(nowBefore/60000)*60000&&nowValue<=Date.now());
  await page.screenshot({path:path.join(evidence,'synthetic-cleanup-form.png')});pass('Cleanup opens from Settings in the minimum Windows window; oldest and now use China wall minutes without horizontal overflow');

  stage='range-validation';const callsBefore=await countCalls('messages.cleanup.preview');await range('2026-10-21T10:00','2026-10-21T09:00');await page.locator('#cleanup-preview').click();await page.locator('#modal-error').waitFor();assert.match(await page.locator('#modal-error').innerText(),/开始|结束|早/);assert.equal(await countCalls('messages.cleanup.preview'),callsBefore);
  await range('2026-10-21T09:00','2026-10-21T09:00');const accountHash=hash(store._file(fixture.accountId));const boundary=await preview();assert.match(boundary,/符合范围 2 条；保留 0 条；将移入本地回收区 2 条/);
  const boundaryPlan=await getPlan();assert.deepEqual(boundaryPlan.range,{start:base,end:base+60000});assert.deepEqual(boundaryPlan.sample.map(m=>m.id),[messages[1].id,messages[2].id]);
  await closeDialog();if(!packaged)assert.equal(await countCalls('messages.cleanup.apply'),0);assert.equal(hash(store._file(fixture.accountId)),accountHash);assert.equal(data().messageTrash.length,0);
  pass(packaged?'Reversed minutes reject, the complete end minute includes 59.999 seconds, and closing the preview changes zero account bytes or trash batches':'Reversed minutes reject before IPC; the complete end minute includes 59.999 seconds; closing the preview makes zero apply calls and changes zero account bytes');

  stage='member-ime';await openCleanup();await range('2026-10-21T09:00','2026-10-21T09:20');await page.locator('#cleanup-members .member-picker-toggle').click();
  const search=page.locator('#cleanup-members .member-picker-search');await search.focus();
  await search.evaluate(el=>{globalThis.__cleanupSearch=el;el.dispatchEvent(new CompositionEvent('compositionstart',{data:'同',bubbles:true}));el.value='同';el.dispatchEvent(new InputEvent('input',{data:'同',isComposing:true,bubbles:true}));});await delay(2300);
  assert.ok(await search.evaluate(el=>el===globalThis.__cleanupSearch&&document.activeElement===el));
  await search.evaluate(el=>{el.value='同名';el.dispatchEvent(new CompositionEvent('compositionend',{data:'同名',bubbles:true}));});assert.equal(await page.locator('#cleanup-members .member-picker-option:visible').count(),2);
  await page.locator('#cleanup-members input[value="retain-id"]').check();await search.fill('其他');assert.equal(await page.locator('#cleanup-members input[value="retain-id"]').isChecked(),true);await search.fill('同名');
  assert.equal(await page.locator('#cleanup-members input[value="same-name-other"]').isChecked(),false);await page.locator('#cleanup-members .member-picker-clear').click();assert.equal(await page.locator('#cleanup-members input:checked').count(),0);
  await chooseRetained();
  const full=await preview();assert.match(full,/符合范围 22 条；保留 12 条；将移入本地回收区 10 条/);const plan=await getPlan();
  assert.deepEqual(plan.selection.retainSenderIds,['retain-id']);assert.deepEqual(plan.reasonCounts,{bookmark:1,exportReference:2,readPosition:2,syncAnchor:1,retainedMember:2,summaryReference:3,summaryRange:4,unread:2});
  await page.locator('.cleanup-samples summary').click();assert.match(await page.locator('.cleanup-samples').innerText(),/<script>不得执行的合成文本<\/script>/);assert.equal(await page.locator('.cleanup-samples script').count(),0);
  await page.screenshot({path:path.join(evidence,'synthetic-cleanup-preview.png')});await back();await page.locator('#cleanup-keep-summaries').uncheck();assert.match(await preview(),/将移入本地回收区 11 条/);assert.equal((await getPlan()).reasonCounts.summaryReference,3);await back();await page.locator('#cleanup-keep-summaries').check();
  assert.deepEqual(protectedState(data()),before);pass('Member IME preserves input identity and focus; stable IDs distinguish duplicate names, search retains checks, and preview protects bookmarks, exports, reading marks, unread, sync anchors and known local/AI summary ranges');

  stage='cross-group';await page.locator('#cleanup-group').selectOption(fixture.otherGroupId);await until(()=>page.locator('#cleanup-preview').isEnabled(),'Second group load failed');assert.match(await page.locator('#cleanup-members .member-picker-toggle').innerText(),/不额外保留/);
  const conservative=await preview();assert.match(conservative,/保留 5 条/);assert.match(conservative,/缺少可核对的来源|保守保留/);assert.equal(await page.locator('#cleanup-confirm').isDisabled(),true);await back();
  await page.locator('#cleanup-trash').click();assert.equal(await page.locator('[data-restore-batch]').count(),0);await back();await page.locator('#cleanup-group').selectOption(fixture.groupId);await until(()=>page.locator('#cleanup-preview').isEnabled(),'First group reload failed');await range('2026-10-21T09:00','2026-10-21T09:20');await chooseRetained();await preview();
  pass('Switching groups clears only member selection, uses each group’s own records and trash, and explains conservative retention for untraceable legacy summary ranges');

  stage='persistence-failure';const failHash=hash(store._file(fixture.accountId));
  if(!packaged){await application.evaluate(()=>globalThis.__cleanupAcceptance.failWrite=true);await page.locator('#cleanup-confirm').click();await page.locator('#modal-error').waitFor();assert.match(await page.locator('#modal-error').innerText(),/模拟保存失败/);assert.equal(hash(store._file(fixture.accountId)),failHash);assert.ok(await page.locator('#cleanup-confirm').isDisabled());assert.equal(data().messageTrash.length,0);assert.ok(await page.locator('#modal').evaluate(d=>d.open));await back();await preview();}
  const applyBefore=await countCalls('messages.cleanup.apply'),livePlan=await getPlan();if(!packaged)await application.evaluate(()=>globalThis.__cleanupAcceptance.holdApply=true);
  await page.locator('#cleanup-confirm').click({clickCount:2});
  if(!packaged){await until(()=>application.evaluate(()=>globalThis.__cleanupAcceptance.held),'Apply gate not entered');assert.ok(await page.locator('#cleanup-confirm').isDisabled());assert.equal(hash(store._file(fixture.accountId)),failHash);await application.evaluate(()=>globalThis.__cleanupAcceptance.release());}
  await until(()=>page.locator('#modal').evaluate(d=>!d.open),'Successful cleanup did not close');if(!packaged)assert.equal(await countCalls('messages.cleanup.apply'),applyBefore+1);
  const expectedDeleted=[1,2,3,5,7,9,11,18,19,22].map(i=>messages[i].id);assert.deepEqual(data().messages.filter(m=>m.localDeletion).map(m=>m.id),expectedDeleted);assert.equal(activeIds().length,14);assert.deepEqual(protectedState(data()),before);assert.equal(data().messageTrash.length,1);
  if(!packaged)await assert.rejects(()=>api('messages.cleanup.apply',{accountId:fixture.accountId,groupId:fixture.groupId,confirmationToken:livePlan.confirmationToken,confirmed:true}),/失效/);
  assert.equal(data().messageTrash.length,1);pass(packaged?'Actual confirm-button double-click creates one batch containing exactly the expected ten stable IDs; all protected source relations remain unchanged':'Injected atomic-save failure changes no data and never shows success; a subsequent real confirmation stays busy, double-click submits once, and a consumed token cannot delete twice');

  stage='restart';await close();await launch();assert.equal(activeIds().length,14);assert.equal((await api('messages.query',{groupId:fixture.groupId})).total,14);assert.deepEqual(protectedState(data()),before);await openCleanup();await page.locator('#cleanup-trash').click();await page.locator('[data-restore-batch]').waitFor();assert.match(await page.locator('[data-restore-batch]').innerText(),/恢复 10 条/);
  await page.screenshot({path:path.join(evidence,'synthetic-trash-restart.png')});pass('Actual app restart keeps recycled messages hidden, preserves full saved relations and reading/unread state, and shows exactly one recoverable batch');
  stage='restore';const restoreBefore=await countCalls('messages.trash.restore');await page.locator('[data-restore-batch]').click();await until(()=>activeIds().length===24,'Restore failed');await until(()=>page.locator('[data-restore-batch]').count().then(n=>n===0),'Restored batch still actionable');if(!packaged)assert.equal(await countCalls('messages.trash.restore'),restoreBefore+1);assert.deepEqual(data().messages.filter(m=>m.groupId===fixture.groupId),messages);assert.deepEqual(protectedState(data()),before);await closeDialog();pass('Restoring the selected batch returns every original message exactly once without changing bookmarks, summaries, export links, high-water or unread');

  stage='stale-owner';await openCleanup();await range('2026-10-21T09:00','2026-10-21T09:00');await preview();const stale=await getPlan();await closeDialog();
  const beforeStale=hash(store._file(fixture.accountId));await assert.rejects(()=>api('messages.cleanup.apply',{accountId:fixture.accountId,groupId:fixture.otherGroupId,confirmationToken:stale.confirmationToken,confirmed:true}),/失效/);assert.equal(hash(store._file(fixture.accountId)),beforeStale);
  await openCleanup();await range('2026-10-21T09:00','2026-10-21T09:00');await preview();const oldAccountPlan=await getPlan();await closeDialog();
  await page.locator('#account-select').selectOption(fixture.otherAccountId);await until(()=>api('state').then(s=>s.account.id===fixture.otherAccountId),'Account switch failed');
  const otherBefore=hash(store._file(fixture.otherAccountId));await assert.rejects(()=>api('messages.cleanup.apply',{accountId:fixture.otherAccountId,groupId:fixture.groupId,confirmationToken:oldAccountPlan.confirmationToken,confirmed:true}),/失效/);assert.equal(hash(store._file(fixture.otherAccountId)),otherBefore);
  assert.equal(data().messages.filter(m=>m.localDeletion).length,0);pass('A group-mismatched confirmation and a previous-account preview are both rejected without changing either account');
  stage='complete';
}catch(error){failure=String(error.stack||error);console.error(failure);}finally{
  await close().catch(error=>failure||=String(error));
  const blocked=runs.flatMap(r=>r.network),allExited=processes.length===2&&processes.every(p=>p.code===0&&p.signal===null);
  const sourceStillMatches=Object.entries(sourceHashes).every(([file,value])=>hash(path.join(appSource,file))===value);
  const program=verifyPackaged(packaged),passed=!failure&&!errors.length&&!blocked.length&&allExited&&(!program||(program.programUnchanged&&program.installDataUnchanged));
  const result={passed,stage,failure,checks,errors,blocked,runs,processes,sourceHashes,sourceStillMatches,program,harness,dataDir,executablePath,scope:packaged?'Unmodified actual packaged EXE/resources, two synthetic accounts, two launches, native network logs, no boot shim or API instrumentation; failure injection only covered by source-mode run':'Actual copied Windows app, two synthetic accounts, two groups, test-only atomic-write failure injection, all network blocked; final packaged candidate not tested by this source run'};
  fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed,checks:checks.length,stage,sourceStillMatches,report:path.join(evidence,'result.json')}));if(!passed)process.exitCode=1;
}})();
