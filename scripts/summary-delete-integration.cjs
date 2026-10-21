'use strict';
// Isolated development acceptance for local summary deletion.
// Source mode copies the application and injects confirmation/write failures.
// --exe mode runs the supplied binary and its resources unchanged and uses
// the real application confirmation dialog through its visible DOM controls.
// No existing data directory, account credential, external service or page is used.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {assertWindowsRuntimeReadable}=require('./windows-runtime-check.cjs');
const root=path.resolve(__dirname,'..'),args=process.argv.slice(2);
const exeArg=args.find(x=>x.startsWith('--exe='))?.slice(6)||(args.includes('--exe')?args[args.indexOf('--exe')+1]:null);
const packaged=!!exeArg,harness=fs.mkdtempSync(path.join(os.tmpdir(),'weiyue-summary-delete-'));
const evidence=path.resolve(process.env.WEIYUE_SUMMARY_DELETE_OUTPUT||path.join(root,'artifacts','summary-delete-integration-'+new Date().toISOString().replace(/[:.]/g,'-')));
const dataDir=path.join(harness,'data'),powershell=process.env.WEIYUE_POWERSHELL||'pwsh.exe';
fs.mkdirSync(evidence,{recursive:true});fs.mkdirSync(dataDir);
let appRoot,executablePath;
if(packaged){executablePath=path.resolve(exeArg);appRoot=path.join(path.dirname(executablePath),'resources/app/app');}
else{
  fs.cpSync(path.join(root,'vendor/runtime'),path.join(harness,'runtime'),{recursive:true});
  fs.cpSync(path.join(root,'app'),path.join(harness,'app'),{recursive:true});
  appRoot=path.join(harness,'app');executablePath=path.join(harness,'runtime/electron.exe');
  // Test-only renderer helper in the copied app: model a previously completed
  // request without preparing, sending or charging for any AI call.
  const rendererFile=path.join(appRoot,'renderer/app.js'),renderer=fs.readFileSync(rendererFile,'utf8');
  const marker='function renderSummary() {';
  assert.equal(renderer.split(marker).length,2,'SYNTHETIC_RENDERER_INJECTION_MARKER');
  const helper=`window.__summaryDeleteSynthetic={attachCompleted(id){
    const summary=model.summaries.find(s=>s.id===id);if(!summary)throw Error('SYNTHETIC_SUMMARY_MISSING');
    model.aiRequest={status:'complete',accountId:model.state.account.id,epoch:model.accountEpoch,summary,
      range:{groupId:summary.groupId,start:summary.start,end:summary.end}};
    renderAiRequestStatus();
  },hasCompleted(){return !!model.aiRequest;}};
`;
  fs.writeFileSync(rendererFile,renderer.replace(marker,helper+marker));
}
const packageFile=packaged?path.join(appRoot,'../package.json'):path.join(root,'package.json');
const version=JSON.parse(fs.readFileSync(packageFile,'utf8')).version;
const expectedVersion=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function manifest(base){
  const files={};
  for(const name of fs.readdirSync(base,{recursive:true})){
    const full=path.join(base,name),stat=fs.lstatSync(full);
    assert.equal(stat.isSymbolicLink(),false,'TEST_RESOURCE_SYMLINK');
    if(stat.isFile())files[name.replace(/\\/g,'/')]=hash(full);
  }
  return files;
}
function applicationManifestSha256(files){
  const command="[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $keys=ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd()); $sorted=@($keys | Sort-Object -CaseSensitive); [Console]::Write((ConvertTo-Json -InputObject $sorted -Compress));";
  const sorted=spawnSync(powershell,['-NoLogo','-NoProfile','-NonInteractive','-Command',command],
    {input:JSON.stringify(Object.keys(files)),encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:4*1024*1024});
  if(sorted.error||sorted.status!==0)throw Error('MANIFEST_SORT_FAILED');
  const keys=JSON.parse(sorted.stdout);
  assert.ok(Array.isArray(keys)&&keys.length===Object.keys(files).length&&new Set(keys).size===keys.length&&keys.every(key=>Object.hasOwn(files,key)));
  return crypto.createHash('sha256').update(keys.map(key=>key+'\t'+files[key].toLowerCase()).join('\n'),'utf8').digest('hex');
}
const resourcesBase=packaged?path.dirname(appRoot):appRoot,resourcesBefore=manifest(resourcesBase),exeBefore=hash(executablePath),originalSource=manifest(path.join(root,'app'));
fs.writeFileSync(path.join(evidence,'resources-before.json'),JSON.stringify(resourcesBefore,null,2));
const {Store}=require(path.join(appRoot,'core/store.cjs'));
const store=new Store(path.join(dataDir,'accounts')),base=Date.parse('2026-10-20T00:00:00Z');
const fixtures={
  accountId:'import-summary-delete-115-a',otherAccountId:'import-summary-delete-115-b',
  groups:[{id:'9007199254741150001',name:'删除验收合成群 A'},{id:'9007199254741150002',name:'删除验收合成群 B'}],
  summaries:[
    {id:'synthetic-summary-115-cancel',group:0,title:'合成摘要 QA115 同名标题',order:6},
    {id:'synthetic-summary-115-failure',group:0,title:'合成摘要 QA115 保存失败',order:5},
    {id:'synthetic-summary-115-pending',group:0,title:'合成摘要 QA115 切群保护',order:4},
    {id:'synthetic-summary-115-detail',group:0,title:'合成摘要 QA115 详情删除',order:3},
    {id:'synthetic-summary-115-peer',group:1,title:'合成摘要 QA115 同名标题',order:2},
    {id:'synthetic-summary-115-last',group:1,title:'合成摘要 QA115 最后记录',order:1}
  ]
};
function seed(accountId,other=false){
  store.ensureAccount({id:accountId,name:other?'删除验收独立账号 B':'删除验收独立账号 A',kind:'import'});
  const messages=fixtures.groups.flatMap((g,gi)=>Array.from({length:8},(_,i)=>({
    id:String(9007199254741160000n+BigInt(gi*100+i)),groupId:g.id,senderId:'115'+String(i%2),
    senderName:'合成成员 '+String(i%2),time:base+i*60000,text:`QA115 ${other?'B':'A'} ${gi} 合成聊天 ${i} [哈哈]`
  })));
  store.mergeMessages(accountId,fixtures.groups.map(g=>({...g,selected:true})),messages,{history:true});
  store.update(accountId,state=>{
    state.settings.autoSyncEnabled=false;
    state.summaries=fixtures.summaries.map(s=>({
      id:s.id,groupId:fixtures.groups[s.group].id,title:s.title,
      body:`只用于验收的本地摘要 ${s.id}。\n删除这份摘要不应改变聊天、收藏或历史导出记录。`,
      start:base,end:base+8*60000,createdAt:base+s.order*1000,mode:'local',
      refs:messages.filter(m=>m.groupId===fixtures.groups[s.group].id).slice(0,2)
    }));
    state.bookmarks=[{id:'synthetic-bookmark-115',groupId:fixtures.groups[0].id,
      messageIds:[messages[0].id],note:'必须保留的合成收藏',tags:['验收'],createdAt:base}];
    state.exports={'synthetic-export-115':{summaryId:fixtures.summaries[0].id,
      pageId:'00000000-0000-4000-8000-000000000115',status:'complete',marker:'合成历史导出，不访问 Notion'}};
    for(const g of fixtures.groups){
      const ids=messages.filter(m=>m.groupId===g.id).map(m=>m.id);
      state.readPositions[g.id]=ids[0];
      state.readStates[g.id]={anchorId:ids[0],anchorOffset:0,atBottom:false,readThroughId:ids[3],
        unreadIds:ids.slice(4),updatedAt:base};
    }
  });
}
seed(fixtures.accountId);seed(fixtures.otherAccountId,true);
fs.writeFileSync(path.join(dataDir,'preferences.json'),JSON.stringify({activeId:fixtures.accountId}));
const baseline=store.get(fixtures.accountId),otherBaseline=store.get(fixtures.otherAccountId);
const protectedKeys=['account','groups','messages','bookmarks','settings','importantMembers','exports'];
const protectedPart=state=>Object.fromEntries(protectedKeys.map(key=>[key,state[key]]));

function boot(options){
  const {app,net,session,ipcMain}=require('electron'),fs=require('node:fs'),path=require('node:path');
  const info=globalThis.__summaryDeleteTest={calls:[],blocked:[],writesFailed:0,failDeleteId:null,
    previewFailure:false,malformedNext:false,malformedResponses:0,holdPreview:false,holdDelete:false,heldPreview:[],heldDelete:[]};
  const originalHandle=ipcMain.handle.bind(ipcMain);
  ipcMain.handle=(channel,handler)=>originalHandle(channel,async(event,action,payload={})=>{
    if(channel==='weiyue:call'){
      info.calls.push({action,payload});
      if(/^summary\.ai|^notion\./.test(action))throw Error('EXTERNAL_FEATURE_NOT_ALLOWED_IN_TEST');
      if(action==='summary.delete.preview'&&info.previewFailure){info.previewFailure=false;throw Error('合成测试：确认预览暂时无法显示。');}
      if(action==='summary.delete'&&info.malformedNext){
        info.malformedNext=false;info.malformedResponses++;
        return {ok:true,value:{accountId:payload.accountId,summaryId:'synthetic-wrong-summary-id',groupId:payload.groupId,deleted:true,summaryCount:0}};
      }
    }
    const result=await handler(event,action,payload);
    if(action==='summary.delete.preview'&&info.holdPreview)await new Promise(resolve=>info.heldPreview.push(resolve));
    if(action==='summary.delete'&&info.holdDelete)await new Promise(resolve=>info.heldDelete.push(resolve));
    return result;
  });
  info.release=()=>{
    info.holdPreview=false;info.holdDelete=false;
    while(info.heldPreview.length)info.heldPreview.shift()();
    while(info.heldDelete.length)info.heldDelete.shift()();
  };
  // Fail only the rename that would persist deletion of one exact synthetic ID.
  // The production Store error handling and old file preservation remain live.
  const rename=fs.renameSync.bind(fs);
  fs.renameSync=(from,to)=>{
    if(info.failDeleteId&&path.resolve(path.dirname(to))===path.resolve(options.accountsDir)&&String(from).endsWith('.tmp')){
      const proposed=JSON.parse(fs.readFileSync(from,'utf8')),current=JSON.parse(fs.readFileSync(to,'utf8'));
      if(current.summaries.some(s=>s.id===info.failDeleteId)&&!proposed.summaries.some(s=>s.id===info.failDeleteId)){
        info.failDeleteId=null;info.writesFailed++;const error=Error('Synthetic disk failure');error.code='EACCES';throw error;
      }
    }
    return rename(from,to);
  };
  const fetch=net.fetch.bind(net),request=net.request.bind(net);
  net.fetch=(url,opts)=>/^https?:/i.test(String(url))?(info.blocked.push('net.fetch'),Promise.reject(Error('EXTERNAL_BLOCKED'))):fetch(url,opts);
  net.request=opts=>{
    if(/^https?:/i.test(typeof opts==='string'?opts:opts.url)){info.blocked.push('net.request');throw Error('EXTERNAL_BLOCKED');}
    return request(opts);
  };
  const attached=new WeakSet();
  const attach=s=>{
    if(attached.has(s))return;attached.add(s);
    s.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,callback)=>{info.blocked.push('webRequest');callback({cancel:true});});
    const original=s.fetch.bind(s);
    s.fetch=(url,opts)=>/^https?:/i.test(String(url))?(info.blocked.push('session.fetch'),Promise.reject(Error('EXTERNAL_BLOCKED'))):original(url,opts);
  };
  app.on('session-created',attach);app.whenReady().then(()=>attach(session.defaultSession));
  require('./app/main.cjs');
}
if(!packaged){
  fs.writeFileSync(path.join(harness,'package.json'),JSON.stringify({...JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')),main:'boot.cjs'}));
  fs.writeFileSync(path.join(harness,'boot.cjs'),'('+boot.toString()+')('+JSON.stringify({accountsDir:path.join(dataDir,'accounts')})+');');
}

let application,page,stage='prepare',failure=null;
const checks=[],errors=[],httpRequests=[],launches=[],runs=[],confirmationAudit=[],confirmationDecisions=[],deletedIds=[];
const result={passed:false,version,expectedVersion,mode:packaged?'final-executable':'source-harness',
  executablePath,harness,dataDir,checks,errors,httpRequests,launches,confirmationAudit,confirmationDecisions,
  confirmationKind:'application-html-dialog'};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,timeout=12000){const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await fn())return;await pause(100);}throw Error(label);}
const api=(action,payload={})=>page.evaluate(({action,payload})=>window.api.call(action,payload),{action,payload});
const current=()=>new Store(path.join(dataDir,'accounts')).get(fixtures.accountId);
const card=id=>page.locator('.summary-list-card[data-summary-id="'+id+'"]');
const deleteButton=id=>page.locator('.summary-delete[data-action="delete-summary"][data-summary-id="'+id+'"]');
const check=text=>{checks.push(text);console.log('PASS '+text);};
const summaryById=id=>fixtures.summaries.find(s=>s.id===id);
function verifyProtected(){
  assert.deepEqual(protectedPart(current()),protectedPart(baseline),'SOURCE_CHAT_BOOKMARK_EXPORT_STATE_CHANGED');
  const other=store.get(fixtures.otherAccountId);
  assert.deepEqual(protectedPart(other),protectedPart(otherBaseline),'OTHER_ACCOUNT_STATE_CHANGED');
  assert.deepEqual(other.summaries,otherBaseline.summaries,'OTHER_ACCOUNT_SUMMARIES_CHANGED');
  for(const [state,before]of [[current(),baseline],[other,otherBaseline]])for(const group of fixtures.groups){
    assert.equal(state.readStates[group.id].readThroughId,before.readStates[group.id].readThroughId,'READ_HIGH_WATER_CHANGED');
    assert.deepEqual(state.readStates[group.id].unreadIds,before.readStates[group.id].unreadIds,'UNREAD_SET_CHANGED');
  }
  const expected=baseline.summaries.filter(s=>!deletedIds.includes(s.id));
  assert.deepEqual(current().summaries,expected,'EXACT_SUMMARY_ID_ISOLATION');
}
async function launch(){
  const preflight=assertWindowsRuntimeReadable(executablePath),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  application=await _electron.launch({executablePath,args:[...(!packaged?[harness]:[]),'--data-dir='+dataDir],
    cwd:packaged?path.dirname(executablePath):harness,env,timeout:45000});
  const native=application.process(),record={pid:native.pid,preflight,dataDir};launches.push(record);
  native.once('exit',(exitCode,signal)=>Object.assign(record,{exitCode,signal}));
  native.stderr?.on('data',bytes=>fs.appendFileSync(path.join(evidence,'native.stderr.log'),bytes));
  page=await application.firstWindow();page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(/^https?:/i.test(request.url()))httpRequests.push({origin:new URL(request.url()).origin,type:request.resourceType()});});
  record.security=await application.evaluate(({BrowserWindow,app})=>{
    const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()==='app://local/index.html')||BrowserWindow.getAllWindows()[0];
    win.setSize(1440,930);win.show();win.focus();win.webContents.focus();
    const p=win.webContents.getLastWebPreferences();
    return {packaged:app.isPackaged,version:app.getVersion(),appPath:app.getAppPath(),executable:process.execPath,
      sandbox:p.sandbox,contextIsolation:p.contextIsolation,nodeIntegration:p.nodeIntegration,webSecurity:p.webSecurity};
  });
  assert.ok(record.security.sandbox&&record.security.contextIsolation&&!record.security.nodeIntegration&&record.security.webSecurity,'APP_ISOLATION');
  assert.equal(record.security.version,expectedVersion,'APPLICATION_VERSION');
  if(packaged){
    assert.equal(record.security.packaged,true);assert.equal(record.security.version,version);
    assert.equal(path.resolve(record.security.executable).toLowerCase(),executablePath.toLowerCase());
    assert.equal(path.resolve(record.security.appPath).toLowerCase(),path.dirname(appRoot).toLowerCase());
  }
  await page.waitForSelector('article[data-message-id]');await pause(350);
  const state=await api('state');
  assert.equal(state.account.id,fixtures.accountId);assert.equal(state.account.kind,'import');
  assert.equal(path.resolve(state.dataRoot),dataDir);assert.equal(state.sessionReady,false);
  assert.equal(state.credentials.ai,false);assert.equal(state.credentials.notion,false);
  assert.equal((await api('sync.status')).enabled,false);
}
async function close(){
  if(!application)return;
  if(!packaged)runs.push(await application.evaluate(()=>{const i=globalThis.__summaryDeleteTest;return {
    calls:i.calls,blocked:i.blocked,writesFailed:i.writesFailed,malformedResponses:i.malformedResponses,pending:i.heldPreview.length+i.heldDelete.length};}));
  await application.close();application=null;
  await until(()=>launches.at(-1).exitCode!==undefined,'NATIVE_PROCESS_DID_NOT_EXIT',10000);
}
async function showSummaries(){
  await page.locator('[data-view="summaries"]').click();
  await until(async()=>await card(fixtures.summaries.find(s=>!deletedIds.includes(s.id))?.id||'absent').count()>0||await page.locator('#workspace-content .empty-state').count()>0,'SUMMARY_VIEW_NOT_READY');
}
async function waitPending(id){
  await page.locator('#modal[open] #summary-delete-warning').waitFor({state:'visible'});
  const audit=await page.locator('#modal').evaluate(dialog=>({
    title:dialog.querySelector('#modal-title')?.textContent,
    summaryTitle:dialog.querySelector('.summary-delete-title')?.textContent,
    warning:dialog.querySelector('#summary-delete-warning')?.textContent,
    buttons:[...dialog.querySelectorAll('#summary-delete-cancel,#summary-delete-confirm')].map(b=>({id:b.id,text:b.textContent})),
    defaultFocus:document.activeElement?.id,modal:dialog.matches(':modal'),open:dialog.open
  }));
  assert.equal(audit.title,'删除摘要？');assert.equal(audit.defaultFocus,'summary-delete-cancel');
  assert.ok(audit.modal&&audit.open,'CONFIRMATION_NOT_MODAL');
  assert.deepEqual(audit.buttons.map(b=>b.id).sort(),['summary-delete-cancel','summary-delete-confirm']);
  assert.equal(audit.summaryTitle,summaryById(id).title,'CONFIRMATION_TARGET_TITLE');
  for(const token of ['本地','聊天','收藏','Notion'])assert.ok(audit.warning.includes(token),'CONFIRMATION_SCOPE_MISSING_'+token);
  confirmationAudit.push(audit);
}
async function decide(id,response,{escape=false}={}){
  if(escape)await page.keyboard.press('Escape');
  else await page.locator(response===0?'#summary-delete-cancel':'#summary-delete-confirm').click();
  confirmationDecisions.push({decision:response===0?'cancel':'delete',realAppDialog:true,packaged,
    summaryId:id,mechanism:escape?'Escape':'visible-button'});
  if(response===1){
    await until(()=>!current().summaries.some(s=>s.id===id),'CONFIRMED_SUMMARY_NOT_DELETED');
    deletedIds.push(id);
  }
  await until(async()=>!(await page.locator('#modal[open] #summary-delete-warning').count()),'CONFIRMATION_DID_NOT_CLOSE');
  await until(async()=>!(await page.locator('.summary-delete[aria-busy="true"]').count()),'DELETE_PENDING_DID_NOT_CLEAR');
}
async function startDelete(id,{keyboard=false}={}){
  const button=deleteButton(id);await button.waitFor({state:'visible'});
  if(keyboard){await button.focus();await button.press('Enter');}else await button.click();
  await waitPending(id);
}
async function assertPendingDisabled(){
  const flags=await page.locator('.summary-delete').evaluateAll(buttons=>buttons.map(b=>({disabled:b.disabled,busy:b.getAttribute('aria-busy')})));
  assert.ok(flags.length>0&&flags.every(b=>b.disabled&&b.busy==='true'),'PENDING_BUTTONS_NOT_DISABLED');
}

(async()=>{
  try{
    stage='launch';await launch();await showSummaries();
    stage='card-accessibility';
    assert.equal(await page.locator('.summary-list-card').count(),fixtures.summaries.length);
    assert.equal(await page.locator('button button').count(),0,'NESTED_BUTTONS');
    const geometry=await page.locator('.summary-list-card').evaluateAll(cards=>cards.map(card=>{
      const open=card.querySelector('.summary-open'),del=card.querySelector('.summary-delete'),r=card.getBoundingClientRect(),o=open?.getBoundingClientRect(),d=del?.getBoundingClientRect();
      return {id:card.dataset.summaryId,tag:card.tagName,openTag:open?.tagName,deleteTag:del?.tagName,
        title:del?.title,label:del?.getAttribute('aria-label'),svg:!!del?.querySelector('svg'),type:del?.type,
        deleteInside:d&&d.left>=r.left&&d.right<=r.right&&d.top>=r.top&&d.bottom<=r.bottom,
        topRight:d&&d.right>=r.right-30&&d.top<=r.top+30,overlap:o&&d&&o.left<d.right&&o.right>d.left&&o.top<d.bottom&&o.bottom>d.top};
    }));
    assert.ok(geometry.every(g=>g.tag==='ARTICLE'&&g.openTag==='BUTTON'&&g.deleteTag==='BUTTON'&&g.type==='button'),'SEMANTIC_CARD_CONTROLS');
    assert.ok(geometry.every(g=>g.title==='删除摘要'&&g.label==='删除摘要'&&g.svg),'ACCESSIBLE_TRASH_ICON');
    assert.ok(geometry.every(g=>g.deleteInside&&g.topRight&&!g.overlap),'DELETE_OVERLAPS_CARD_CONTENT');
    result.cardGeometry=geometry;
    const cancelId=fixtures.summaries[0].id;
    await deleteButton(cancelId).focus();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');
    const focus=await deleteButton(cancelId).evaluate(button=>{
      const s=getComputedStyle(button);return {active:document.activeElement===button,focusVisible:button.matches(':focus-visible'),
        outlineStyle:s.outlineStyle,outlineWidth:s.outlineWidth,outlineColor:s.outlineColor,boxShadow:s.boxShadow};
    });
    assert.ok(focus.active&&focus.focusVisible,'KEYBOARD_FOCUS_NOT_VISIBLE');
    assert.ok((focus.outlineStyle!=='none'&&parseFloat(focus.outlineWidth)>0)||focus.boxShadow!=='none','NO_VISIBLE_FOCUS_INDICATOR');
    result.keyboardFocus=focus;
    await page.screenshot({path:path.join(evidence,'synthetic-summary-list.png')});
    check('Every summary has a labeled keyboard-accessible trash icon in a separate top-right area; no nested buttons or content overlap');

    stage='cancel';
    const beforeCancel=current();
    const deletesBeforeCancel=packaged?null:await application.evaluate(()=>globalThis.__summaryDeleteTest.calls.filter(c=>c.action==='summary.delete').length);
    await startDelete(cancelId,{keyboard:true});
    assert.deepEqual(current(),beforeCancel,'PENDING_CONFIRMATION_WROTE_DATA');
    await page.screenshot({path:path.join(evidence,'synthetic-delete-confirmation.png')});
    await decide(cancelId,0,{escape:true});await pause(150);
    assert.deepEqual(current(),beforeCancel,'CANCEL_CHANGED_DATA');
    if(!packaged)assert.equal(await application.evaluate(()=>globalThis.__summaryDeleteTest.calls.filter(c=>c.action==='summary.delete').length),deletesBeforeCancel,'CANCEL_SENT_DELETE_REQUEST');
    assert.equal(await card(cancelId).count(),1);assert.equal(await page.locator('.summary-document').count(),0,'DELETE_BUBBLED_TO_DETAIL');
    result.cancelPreserved=true;verifyProtected();
    check('Enter opens the real modal with Cancel focused; Escape preserves the exact account data and leaves the selected card in the list');

    if(!packaged){
      stage='write-failure';
      const failureId=fixtures.summaries[1].id,beforeFailure=current();
      await application.evaluate((_electron,id)=>{globalThis.__summaryDeleteTest.failDeleteId=id;},failureId);
      await startDelete(failureId);
      assert.equal(await card(failureId).count(),1,'OPTIMISTIC_CARD_REMOVAL');
      await page.locator('#summary-delete-confirm').click();
      await until(()=>application.evaluate(()=>globalThis.__summaryDeleteTest.writesFailed===1),'WRITE_FAILURE_NOT_INJECTED');
      await page.locator('#modal-error').waitFor({state:'visible'});
      assert.match(await page.locator('#modal-error').innerText(),/保存|删除|失败|权限/);
      assert.deepEqual(current(),beforeFailure);assert.equal(await card(failureId).count(),1);
      await until(async()=>!(await page.locator('#summary-delete-cancel').isDisabled()),'FAILURE_DID_NOT_RELEASE_BUTTON');
      assert.equal(await page.locator('#summary-delete-confirm').isDisabled(),true,'FAILED_SINGLE_USE_TOKEN_CAN_BE_REPLAYED');
      result.failurePreserved=true;result.failureMessage=await page.locator('#modal-error').innerText();
      await page.screenshot({path:path.join(evidence,'synthetic-save-failure.png')});
      await decide(failureId,0);
      check('A real Store rename failure leaves both the persisted summary and visible card intact, reports an error and allows retry');

      stage='malformed-response';
      await application.evaluate(()=>{globalThis.__summaryDeleteTest.malformedNext=true;});
      await startDelete(failureId);
      await page.locator('#summary-delete-confirm').click();
      await page.locator('#modal-error').waitFor({state:'visible'});
      assert.equal(await page.locator('#modal[open] #summary-delete-warning').count(),1,'INVALID_RESPONSE_CLOSED_CONFIRMATION');
      assert.deepEqual(current(),beforeFailure,'INVALID_RESPONSE_REMOVED_DATA');
      assert.equal(await card(failureId).count(),1);
      await until(async()=>!(await page.locator('#summary-delete-cancel').isDisabled()),'INVALID_RESPONSE_LOCKED_DIALOG');
      await decide(failureId,0);
      await startDelete(failureId);await decide(failureId,0);
      check('A malformed delete response keeps confirmation and the card intact; cancellation releases pending state and permits a fresh preview');

      stage='preview-failure';
      await application.evaluate(()=>{globalThis.__summaryDeleteTest.previewFailure=true;});
      await deleteButton(failureId).click();await page.locator('#toast.error').waitFor({state:'visible'});
      await until(async()=>!(await deleteButton(failureId).isDisabled()),'CONFIRMATION_FAILURE_DID_NOT_RELEASE_BUTTON');
      assert.deepEqual(current(),beforeFailure);assert.equal(await card(failureId).count(),1);
      check('A confirmation-preview failure leaves data untouched and restores the delete control');

      stage='preview-isolation';
      const pendingId=fixtures.summaries[2].id;
      const callsBefore=await application.evaluate(()=>globalThis.__summaryDeleteTest.calls.filter(c=>c.action==='summary.delete.preview').length);
      await application.evaluate(()=>{globalThis.__summaryDeleteTest.holdPreview=true;});
      await deleteButton(pendingId).click();
      await until(()=>application.evaluate(()=>globalThis.__summaryDeleteTest.heldPreview.length===1),'PREVIEW_NOT_HELD');
      await deleteButton(pendingId).evaluate(button=>{for(let i=0;i<3;i++)button.dispatchEvent(new MouseEvent('click',{bubbles:true}));});
      await pause(100);
      assert.equal(await application.evaluate(()=>globalThis.__summaryDeleteTest.calls.filter(c=>c.action==='summary.delete.preview').length),callsBefore+1,'DUPLICATE_PREVIEW_REQUESTS');
      await page.locator('#group-list [data-group-id="'+fixtures.groups[1].id+'"]').click();
      await page.waitForSelector('article[data-message-id]');
      await application.evaluate(()=>globalThis.__summaryDeleteTest.release());await pause(200);
      assert.equal(await page.locator('#modal[open] #summary-delete-warning').count(),0,'STALE_PREVIEW_OPENED_AFTER_GROUP_SWITCH');
      assert.ok(current().summaries.some(s=>s.id===pendingId),'PREVIEW_RACE_DELETED_SUMMARY');
      assert.equal(await page.locator('#group-list .active').getAttribute('data-group-id'),fixtures.groups[1].id);
      await showSummaries();
      check('Repeated icon activation makes one preview request; a late preview cannot open a stale confirmation after group switching');

      stage='pending-delete-isolation';
      await startDelete(pendingId);
      await application.evaluate(()=>{globalThis.__summaryDeleteTest.holdDelete=true;});
      const deletesBefore=await application.evaluate(()=>globalThis.__summaryDeleteTest.calls.filter(c=>c.action==='summary.delete').length);
      await page.locator('#summary-delete-confirm').click();
      await until(()=>application.evaluate(()=>globalThis.__summaryDeleteTest.heldDelete.length===1),'DELETE_RESPONSE_NOT_HELD');
      await assertPendingDisabled();
      for(const selector of ['#summary-delete-cancel','#summary-delete-confirm','#modal .modal-head button'])assert.equal(await page.locator(selector).isDisabled(),true,'PENDING_MODAL_CONTROL_NOT_DISABLED');
      await page.locator('#summary-delete-confirm').evaluate(button=>{for(let i=0;i<3;i++)button.dispatchEvent(new MouseEvent('click',{bubbles:true}));});
      assert.equal(await application.evaluate(()=>globalThis.__summaryDeleteTest.calls.filter(c=>c.action==='summary.delete').length),deletesBefore+1,'DUPLICATE_DELETE_REQUESTS');
      assert.equal(await card(pendingId).count(),1,'OPTIMISTIC_REMOVAL_BEFORE_REPLY');
      // A synthetic event exercises an asynchronous programmatic view change
      // that ordinary pointer input cannot perform behind a modal dialog.
      await page.locator('#group-list [data-group-id="'+fixtures.groups[0].id+'"]').evaluate(button=>button.click());
      await until(async()=>await page.locator('#group-list .active').getAttribute('data-group-id')===fixtures.groups[0].id,'PROGRAMMATIC_GROUP_SWITCH_FAILED');
      await application.evaluate(()=>globalThis.__summaryDeleteTest.release());
      deletedIds.push(pendingId);await pause(250);
      assert.equal(await page.locator('#modal[open] #summary-delete-warning').count(),0);
      assert.equal(await page.locator('.summary-document').count(),0);
      assert.equal(await page.locator('#group-list .active').getAttribute('data-group-id'),fixtures.groups[0].id,'DELETE_STOLE_NEW_GROUP_CONTEXT');
      assert.ok(await page.locator('article[data-message-id]').count()>0,'DELETE_LEFT_CURRENT_READING_VIEW');
      verifyProtected();await showSummaries();assert.equal(await card(pendingId).count(),0);
      result.pendingGroupProtection=true;
      check('Executing deletion disables its controls, suppresses duplicate confirmation and cannot steal a programmatically changed group view when its response arrives');
    }else{
      result.failurePreserved={tested:false,reason:'Fault injection is restricted to the separate copied-source harness.'};
      result.pendingGroupProtection={tested:false,reason:'The real modal prevents pointer group switching; copied-source response delays exercise asynchronous races.'};
    }

    stage='account-isolation';
    const target={accountId:fixtures.accountId,summaryId:cancelId,groupId:fixtures.groups[0].id};
    const preview=await api('summary.delete.preview',target);
    assert.ok(preview.confirmationToken,'PREVIEW_CONFIRMATION_TOKEN_MISSING');
    await page.locator('#account-select').selectOption(fixtures.otherAccountId);
    await until(async()=>(await api('state')).account.id===fixtures.otherAccountId,'SECOND_ACCOUNT_NOT_ACTIVE');
    const stale=await page.evaluate(async payload=>{try{return {accepted:true,value:await window.api.call('summary.delete',payload)};}
      catch(error){return {accepted:false,error:String(error.message)};}},{...target,confirmationToken:preview.confirmationToken,confirmed:true});
    assert.equal(stale.accepted,false,'STALE_ACCOUNT_TOKEN_ACCEPTED');
    assert.deepEqual(store.get(fixtures.otherAccountId).summaries,otherBaseline.summaries,'SAME_ID_OTHER_ACCOUNT_DELETED');
    await page.locator('#account-select').selectOption(fixtures.accountId);
    await until(async()=>(await api('state')).account.id===fixtures.accountId,'ORIGINAL_ACCOUNT_NOT_RESTORED');
    await showSummaries();verifyProtected();result.staleAccountTokenRejected=stale;
    check('A preview token becomes unusable after account switching; an identical summary ID in the other account remains untouched');

    stage='stable-id-success';
    await startDelete(cancelId);await decide(cancelId,1);
    await until(async()=>await card(cancelId).count()===0,'DELETED_CARD_STILL_VISIBLE');
    assert.equal(await card(fixtures.summaries[4].id).count(),1,'SAME_TITLE_PEER_DELETED');
    assert.equal(await page.locator('.summary-document').count(),0,'SUCCESS_OPENED_DETAIL');
    verifyProtected();result.stableIdIsolation=true;
    const nextFocus=await page.evaluate(()=>({tag:document.activeElement?.tagName,cls:document.activeElement?.className,id:document.activeElement?.closest('[data-summary-id]')?.dataset.summaryId}));
    assert.ok(nextFocus.tag==='BUTTON'&&nextFocus.id&&nextFocus.id!==cancelId,'FOCUS_NOT_RESTORED_AFTER_DELETE');
    result.afterDeleteFocus=nextFocus;
    check('Confirmed deletion targets its stable ID, preserves a same-title summary in another group, does not open details and restores keyboard focus');

    stage='detail-delete';
    const detailId=fixtures.summaries[3].id;
    await card(detailId).locator('.summary-open').click();await page.locator('.summary-document').waitFor({state:'visible'});
    if(!packaged){
      await page.evaluate(id=>window.__summaryDeleteSynthetic.attachCompleted(id),detailId);
      assert.equal(await page.locator('#view-ai-summary').count(),1,'COMPLETED_REQUEST_FIXTURE_NOT_VISIBLE');
    }
    assert.equal(await deleteButton(detailId).count(),1);assert.equal(await page.locator('#export-summary').count(),1);
    await startDelete(detailId);await decide(detailId,0);
    assert.equal(await page.locator('.summary-document').count(),1,'DETAIL_CANCEL_NAVIGATED_AWAY');
    await startDelete(detailId);await decide(detailId,1);
    await until(async()=>await page.locator('.summary-document').count()===0,'DELETED_DETAIL_NOT_CLOSED');
    assert.equal(await card(detailId).count(),0);verifyProtected();
    if(!packaged){
      assert.equal(await page.locator('#view-ai-summary').count(),0,'COMPLETED_REQUEST_REOPENS_DELETED_SUMMARY');
      assert.equal(await page.evaluate(()=>window.__summaryDeleteSynthetic.hasCompleted()),false);
      result.completedRequestCleared=true;
    }
    check('The detail page offers deletion alongside export; cancel preserves details and successful deletion returns to the remaining list');

    stage='restart';
    const remainingBeforeRestart=current().summaries;
    await close();await launch();await showSummaries();
    assert.deepEqual(await api('summary.list'),remainingBeforeRestart,'RESTART_SUMMARY_STATE_CHANGED');
    for(const id of deletedIds)assert.equal(await card(id).count(),0,'DELETED_SUMMARY_RETURNED_AFTER_RESTART');
    verifyProtected();result.restartRestored=true;
    check('Restart restores the remaining summaries and does not resurrect deleted entries');

    stage='empty-state';
    for(const summary of current().summaries){
      await startDelete(summary.id);await decide(summary.id,1);
      await until(async()=>await card(summary.id).count()===0,'FINAL_CARD_NOT_REMOVED');
    }
    assert.equal(await page.locator('.summary-list-card').count(),0);
    assert.equal(await page.locator('.summary-delete').count(),0);
    assert.ok((await page.locator('#workspace-content').innerText()).includes('给一段讨论'));
    const state=await api('state');assert.equal(state.stats.summaries,0);
    result.emptyStateFocus=await page.evaluate(()=>({tag:document.activeElement?.tagName,text:document.activeElement?.textContent}));
    assert.equal(result.emptyStateFocus.tag,'BUTTON','EMPTY_STATE_FOCUS_LOST');
    verifyProtected();result.protectedStateUnchanged=true;
    await page.screenshot({path:path.join(evidence,'synthetic-empty-summary-list.png')});
    check('Deleting the last local summary updates the list, sidebar count and focused empty state while preserving chats, bookmarks and historical exports');
    await close();await launch();await showSummaries();
    assert.deepEqual(await api('summary.list'),[]);verifyProtected();
    await close();
    assert.deepEqual(errors,[]);assert.deepEqual(httpRequests,[]);
    if(!packaged){
      assert.ok(runs.every(r=>r.pending===0&&r.blocked.length===0&&!r.calls.some(c=>/^summary\.ai|^notion\./.test(c.action))));
      assert.equal(runs.reduce((sum,r)=>sum+r.writesFailed,0),1);
      assert.equal(runs.reduce((sum,r)=>sum+r.malformedResponses,0),1);
    }else{
      assert.equal(confirmationDecisions.filter(d=>d.decision==='cancel').length,2);
      assert.equal(confirmationDecisions.filter(d=>d.decision==='delete').length,fixtures.summaries.length);
    }
    check('The empty state also persists after restart; no AI, Notion, network request or real account was used');
    stage='complete';
  }catch(error){
    failure=String(error.stack||error);
    if(page)await page.screenshot({path:path.join(evidence,'failure.png')}).catch(()=>{});
  }finally{
    if(application&&!packaged)await application.evaluate(()=>globalThis.__summaryDeleteTest.release()).catch(()=>{});
    if(page)await page.keyboard.press('Escape').catch(()=>{});
    await close().catch(error=>{failure||='CLOSE_FAILED '+String(error);});
    const resourcesAfter=manifest(resourcesBase);
    fs.writeFileSync(path.join(evidence,'resources-after.json'),JSON.stringify(resourcesAfter,null,2));
    result.resourcesUnchanged=JSON.stringify(resourcesBefore)===JSON.stringify(resourcesAfter)&&hash(executablePath)===exeBefore;
    result.sourceStillMatches=JSON.stringify(originalSource)===JSON.stringify(manifest(path.join(root,'app')));
    result.nativeExitedCleanly=launches.length===3&&launches.every(r=>r.exitCode===0&&r.signal===null);
    Object.assign(result,{failure,stage,runs,deletedIds,executableSha256:exeBefore,
      resourceFileCount:Object.keys(resourcesAfter).length,applicationManifestSha256:applicationManifestSha256(resourcesAfter),
      noPackagedFilesReplaced:packaged&&result.resourcesUnchanged,
      noRealServices:httpRequests.length===0&&runs.every(r=>!r.blocked.length&&!r.calls.some(c=>/^summary\.ai|^notion\./.test(c.action))),
      scope:'Fresh synthetic import accounts only; no real user profile, credential, AI, Notion or network. Final mode does not modify executable/resources or replace the application confirmation dialog.'});
    result.passed=stage==='complete'&&!failure&&result.resourcesUnchanged&&result.nativeExitedCleanly&&(packaged||result.sourceStillMatches);
    fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify({passed:result.passed,stage,checks:checks.length,report:path.join(evidence,'result.json'),resourcesUnchanged:result.resourcesUnchanged,sourceStillMatches:result.sourceStillMatches}));
    if(!result.passed)process.exitCode=1;
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
