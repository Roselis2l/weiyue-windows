'use strict';
// Run the real source app or --exe packaged application with an isolated synthetic
// profile. Runtime transports return in-memory Notion fixtures; no real service,
// account, page or credential is accessed. Packaged resources are never edited.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {assertWindowsRuntimeReadable}=require('./windows-runtime-check.cjs');
const root=path.resolve(__dirname,'..'),args=process.argv.slice(2);
const exeArg=args.find(x=>x.startsWith('--exe='))?.slice(6)||(args.includes('--exe')?args[args.indexOf('--exe')+1]:null);
const packaged=!!exeArg,harness=fs.mkdtempSync(path.join(os.tmpdir(),'weiyue-notion-direct-'));
const evidence=path.resolve(process.env.WEIYUE_NOTION_DIRECT_OUTPUT||path.join(root,'artifacts','notion-direct-'+new Date().toISOString().replace(/[:.]/g,'-')));
const dataDir=path.join(harness,'data');fs.mkdirSync(evidence,{recursive:true});fs.mkdirSync(dataDir);
let appRoot,executablePath;
if(packaged){executablePath=path.resolve(exeArg);appRoot=path.join(path.dirname(executablePath),'resources/app/app');}
else{
  fs.cpSync(path.join(root,'vendor/runtime'),path.join(harness,'runtime'),{recursive:true});
  fs.cpSync(path.join(root,'app'),path.join(harness,'app'),{recursive:true});
  appRoot=path.join(harness,'app');executablePath=path.join(harness,'runtime/electron.exe');
  fs.writeFileSync(path.join(harness,'package.json'),JSON.stringify({name:'weiyue-notion-direct-test',version:JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version,main:'app/main.cjs'}));
}
const version=JSON.parse(fs.readFileSync(packaged?path.join(appRoot,'../package.json'):path.join(root,'package.json'),'utf8')).version;
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function manifest(base){
  const files={};
  for(const file of fs.readdirSync(base,{recursive:true})){
    const full=path.join(base,file),stat=fs.lstatSync(full);assert.equal(stat.isSymbolicLink(),false);
    if(stat.isFile())files[file.replace(/\\/g,'/')]=hash(full);
  }
  return files;
}
function applicationManifestSha256(files){
  const powershell=process.env.WEIYUE_POWERSHELL||'pwsh.exe';
  const command="[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $keys=ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd()); $sorted=@($keys | Sort-Object -CaseSensitive); [Console]::Write((ConvertTo-Json -InputObject $sorted -Compress));";
  const sorted=require('node:child_process').spawnSync(powershell,['-NoLogo','-NoProfile','-NonInteractive','-Command',command],
    {input:JSON.stringify(Object.keys(files)),encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:4*1024*1024});
  if(sorted.error||sorted.status!==0)throw Error('MANIFEST_SORT_FAILED');
  const keys=JSON.parse(sorted.stdout);assert.ok(Array.isArray(keys)&&keys.length===Object.keys(files).length);
  return crypto.createHash('sha256').update(keys.map(key=>key+'\t'+files[key].toLowerCase()).join('\n'),'utf8').digest('hex');
}
const resourceRoot=packaged?path.dirname(appRoot):appRoot,resourcesBefore=manifest(resourceRoot),sourceBefore=manifest(path.join(root,'app')),exeBefore=hash(executablePath);
fs.writeFileSync(path.join(evidence,'resources-before.json'),JSON.stringify(resourcesBefore,null,2));
const fixture={accountId:'import-notion-direct-115',groupId:'9007199254742800001',summaryId:'summary-notion-direct-115',
  targetA:'11111111-1111-4111-8111-111111111111',targetB:'33333333-3333-4333-8333-333333333333'};
const start=Date.parse('2026-10-20T08:00:00Z');
fixture.messages=Array.from({length:8},(_,i)=>({id:String(9007199254742900000n+BigInt(i)),groupId:fixture.groupId,senderId:'fixture-member',
  senderName:'虚构验收成员',time:start+i*60000,text:`NOTION-FIXTURE-REFERENCE-${i} 完全合成消息。`,mediaVersion:1}));
const {Store}=require(path.join(appRoot,'core/store.cjs')),store=new Store(path.join(dataDir,'accounts'));
store.ensureAccount({id:fixture.accountId,kind:'import',name:'Notion 单次导出合成验收'});
store.mergeMessages(fixture.accountId,[{id:fixture.groupId,name:'Notion 合成验收群',selected:true}],fixture.messages,{history:true});
fixture.bookmarkIds=[0,2,4].map(i=>store.bookmark(fixture.accountId,{groupId:fixture.groupId,messageIds:fixture.messages.slice(i,i+2).map(m=>m.id),note:'虚构备注 '+i,tags:['合成']}).id);
store.update(fixture.accountId,state=>{
  state.settings.autoSyncEnabled=false;
  state.summaries=[{id:fixture.summaryId,groupId:fixture.groupId,title:'原始合成摘要',body:'ORIGINAL-SYNTHETIC-SUMMARY [M1]',mode:'local',
    start,end:start+3600000,createdAt:start+3600000,refs:fixture.messages.slice(0,2).map((m,i)=>({...m,label:'M'+(i+1)}))}];
});
fs.writeFileSync(path.join(dataDir,'preferences.json'),JSON.stringify({activeId:fixture.accountId}));
const sources=store.get(fixture.accountId);

function installMocks({app,net,session,dialog},fixtures){
  const info=globalThis.__notionDirect={requests:[],dialogs:[],blocked:[],holdNextCreate:false,failNextCreate:false,failNextAppend:false,pending:null,created:[],
    release(){if(this.pending){const done=this.pending;this.pending=null;done();}}};
  // Unexpected native confirmation fails this test immediately. The production
  // Notion branch must never reach this sentinel after the editor submit.
  dialog.showMessageBox=async(...args)=>{info.dialogs.push({title:args.at(-1)?.title,message:args.at(-1)?.message});throw Error('UNEXPECTED_SECOND_CONFIRMATION');};
  const originalFetch=net.fetch.bind(net),originalRequest=net.request.bind(net);
  net.fetch=async(target,options={})=>{
    const url=String(target);
    if(/^(app|file):/i.test(url))return originalFetch(target,options);
    const search=url==='https://api.notion.com/v1/search',create=url==='https://api.notion.com/v1/pages';
    const pageId=/^https:\/\/api\.notion\.com\/v1\/blocks\/([a-f0-9-]+)\/children$/.exec(url)?.[1];
    if(!search&&!create&&!(pageId&&info.created.includes(pageId))){info.blocked.push('Unexpected net.fetch');throw Error('EXTERNAL_BLOCKED');}
    const headers=new Headers(options.headers);
    if(headers.get('authorization')!=='Bearer NOTION-DIRECT-SYNTHETIC-TOKEN'||options.redirect!=='error'||options.method!==(pageId?'PATCH':'POST'))throw Error('MOCK_REQUEST_CONTRACT');
    const body=JSON.parse(options.body||'{}'),call={kind:search?'search':create?'create':'append',method:options.method,body,pageId};
    info.requests.push(call);
    if(search){call.status=200;return Response.json({results:[fixtures.targetA,fixtures.targetB].map((id,i)=>({object:'page',id,properties:{title:{type:'title',title:[{plain_text:i?'模拟目标 B':'模拟目标 A'}]}}})),has_more:false});}
    if(create){
      if(![fixtures.targetA,fixtures.targetB].includes(body.parent?.page_id))throw Error('WRONG_MOCK_TARGET');
      if(info.holdNextCreate){info.holdNextCreate=false;await new Promise(resolve=>{info.pending=resolve;});}
      if(info.failNextCreate){info.failNextCreate=false;call.status=400;return Response.json({message:'Synthetic rejected create'},{status:400});}
      const id=`22222222-2222-4222-8222-${String(info.created.length+1).padStart(12,'0')}`;
      info.created.push(id);call.pageId=id;call.status=200;return Response.json({id,url:'https://www.notion.so/'+id.replaceAll('-','')});
    }
    if(info.failNextAppend){info.failNextAppend=false;call.status=400;return Response.json({message:'Synthetic rejected append'},{status:400});}
    call.status=200;return Response.json({results:body.children.map((_,i)=>({id:String(i)}))});
  };
  net.request=options=>{
    if(/^(app|file):/i.test(typeof options==='string'?options:options.url))return originalRequest(options);
    info.blocked.push('Unexpected net.request');throw Error('EXTERNAL_BLOCKED');
  };
  const attached=new WeakSet();
  function attach(current){
    if(attached.has(current))return;attached.add(current);
    current.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_request,callback)=>{info.blocked.push('Unexpected browser request');callback({cancel:true});});
    const fetch=current.fetch.bind(current);
    current.fetch=(target,options)=>/^(app|file):/i.test(String(target))?fetch(target,options):(info.blocked.push('Unexpected session.fetch'),Promise.reject(Error('EXTERNAL_BLOCKED')));
  }
  attach(session.defaultSession);app.on('session-created',attach);
}

let application,page,failure,stage='launch',auditData;
const checks=[],errors=[],httpRequests=[],launches=[],observations=[],scopes={};
const result={version,mode:packaged?'final-executable':'copied-source',executablePath,harness,dataDir,checks,errors,httpRequests,launches,observations,scopes,
  mockOnly:true,externalServices:{ai:false,notion:false}};
const check=value=>{checks.push(value);console.log('PASS '+value);};
const api=(action,payload={})=>page.evaluate(({action,payload})=>window.api.call(action,payload),{action,payload});
const audit=()=>application.evaluate(()=>JSON.parse(JSON.stringify(globalThis.__notionDirect,(key,value)=>typeof value==='function'?undefined:value)));
const writes=info=>info.requests.filter(r=>r.kind==='create'||r.kind==='append');
const blockText=blocks=>blocks.map(block=>(block[block.type]?.rich_text||[]).map(p=>p.text?.content||'').join('')).join('');
const cancel=async()=>{await page.locator('#modal-close').click();await page.waitForFunction(()=>!document.getElementById('modal').open);};
const editor=async()=>{await page.locator('#notion-preview').click();await page.waitForSelector('#notion-edit-body');};
const success=async()=>{await page.waitForFunction(()=>document.getElementById('modal-title')?.textContent==='Notion 导出结果');assert.equal(await page.getByRole('button',{name:'打开 Notion 页面',exact:true}).count(),1);scopes.successLink=true;};
const finish=()=>page.getByRole('button',{name:'完成',exact:true}).click();
async function chooseTarget(target){
  if(!await page.locator('#notion-target').isVisible())await page.locator('#notion-load-targets').click();
  await page.locator('#notion-target').selectOption(target);await editor();
}
async function openSummary(){
  await page.locator('[data-view=summaries]').click();
  const card=page.locator('.summary-list-card[data-summary-id="'+fixture.summaryId+'"]');
  const open=card.locator('.summary-open');if(await open.count())await open.click();else await card.click();
  await page.waitForSelector('.summary-document');
}
async function layout(){
  for(const [label,width,height]of[['normal',1360,900],['minimum',1000,680]]){
    await application.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows()[0].setSize(...size),[width,height]);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    for(const selector of['#notion-edit-body','#notion-include-references','#notion-confirm-export']){
      await page.locator(selector).scrollIntoViewIfNeeded();
      const box=await page.locator(selector).evaluate(el=>{const r=el.getBoundingClientRect();return {width:r.width,left:r.left,right:r.right,top:r.top,bottom:r.bottom,viewportWidth:innerWidth,viewportHeight:innerHeight};});
      assert.ok(box.width>0&&box.left>=-2&&box.right<=box.viewportWidth+2&&box.top<box.viewportHeight&&box.bottom>0);
      observations.push({label,selector,...box});
    }
    const overflow=await page.evaluate(()=>({page:document.documentElement.scrollWidth,viewport:innerWidth}));
    assert.ok(overflow.page<=overflow.viewport+2);
    await page.screenshot({path:path.join(evidence,'notion-editor-'+label+'.png')});
  }
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1360,900));
}
async function close(){
  if(!application)return;
  await application.evaluate(()=>globalThis.__notionDirect?.release()).catch(()=>{});
  auditData=await audit().catch(()=>auditData);
  await application.close();application=null;
  for(let i=0;i<100&&launches.at(-1).exitCode===undefined;i++)await new Promise(resolve=>setTimeout(resolve,50));
}
(async()=>{
  try{
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
    const preflight=assertWindowsRuntimeReadable(executablePath);
    application=await _electron.launch({executablePath,cwd:packaged?path.dirname(executablePath):harness,args:[...(!packaged?[harness]:[]),'--data-dir='+dataDir],env,timeout:45000});
    const native=application.process(),record={pid:native.pid,preflight};launches.push(record);native.once('exit',(exitCode,signal)=>Object.assign(record,{exitCode,signal}));
    native.stderr?.on('data',bytes=>fs.appendFileSync(path.join(evidence,'native.stderr.log'),bytes));
    await application.evaluate(installMocks,fixture);
    page=await application.firstWindow();page.on('pageerror',e=>errors.push(e.message));
    page.on('request',r=>{if(/^https?:/i.test(r.url()))httpRequests.push(new URL(r.url()).origin);});
    record.security=await application.evaluate(({BrowserWindow,app})=>{
      const w=BrowserWindow.getAllWindows()[0],p=w.webContents.getLastWebPreferences();w.setSize(1360,900);w.show();w.focus();
      return {version:app.getVersion(),packaged:app.isPackaged,sandbox:p.sandbox,contextIsolation:p.contextIsolation,nodeIntegration:p.nodeIntegration,webSecurity:p.webSecurity};
    });
    assert.equal(record.security.version,JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version);assert.ok(record.security.sandbox&&record.security.contextIsolation&&!record.security.nodeIntegration&&record.security.webSecurity);
    if(packaged)assert.equal(record.security.packaged,true);
    await page.waitForSelector('article[data-message-id]');
    const initial=await api('state');assert.equal(initial.account.id,fixture.accountId);assert.equal(path.resolve(initial.dataRoot),dataDir);
    assert.equal(initial.credentials.ai,false);assert.equal(initial.credentials.notion,false);
    await api('settings.save',{notionToken:'NOTION-DIRECT-SYNTHETIC-TOKEN'});
    await page.reload();await page.waitForSelector('article[data-message-id]');
    check('Real isolated app starts sandboxed with synthetic local data and in-memory Notion transports');

    stage='summary-preview';await openSummary();await chooseTarget(fixture.targetA);
    assert.equal(await page.locator('#notion-consent').count(),0);assert.equal(await page.locator('#notion-confirm-export').isDisabled(),false);
    assert.match(await page.locator('#notion-export-target').textContent(),/模拟目标 A.*[\s\S]*立即提交/);
    const originalTitle=await page.locator('#notion-edit-title').inputValue(),originalBody=await page.locator('#notion-edit-body').inputValue();
    await page.locator('#notion-edit-title').fill('   ');assert.equal(await page.locator('#notion-confirm-export').isDisabled(),true);
    await page.locator('#notion-edit-title').fill('SUMMARY EDITED TITLE');
    const summaryBody='SUMMARY-DIRECT-EDITED-ONLY\nLiteral <img src=x onerror=alert(1)> stays text.';
    await page.locator('#notion-edit-body').fill(summaryBody);
    await page.locator('#notion-include-references').uncheck();await page.locator('#notion-include-references').check();
    assert.equal(await page.locator('#notion-edit-body').inputValue(),summaryBody);await layout();
    check('Editor shows exact target and immediate-submit meaning; no consent checkbox, blank-title validation and reachable controls remain');
    await cancel();assert.equal(writes(await audit()).length,0);
    await editor();assert.equal(await page.locator('#notion-edit-title').inputValue(),originalTitle);assert.equal(await page.locator('#notion-edit-body').inputValue(),originalBody);
    scopes.cancelZeroSubmit=true;scopes.noConsentCheckbox=true;
    check('Cancel submits nothing and reopening starts from the unchanged saved summary');

    stage='summary-submit';
    await page.locator('#notion-edit-title').fill('SUMMARY EDITED TITLE');await page.locator('#notion-edit-body').fill(summaryBody);
    await application.evaluate(()=>{globalThis.__notionDirect.holdNextCreate=true;});
    const button=await page.locator('#notion-confirm-export').boundingBox();await page.mouse.dblclick(button.x+button.width/2,button.y+button.height/2,{delay:30});
    await page.waitForFunction(()=>document.getElementById('notion-confirm-export')?.disabled&&document.getElementById('notion-submit-status')?.textContent.includes('正在导出'));
    assert.equal(await page.locator('#notion-edit-body').isDisabled(),true);assert.equal(await page.locator('#modal-close').isDisabled(),true);
    await page.keyboard.press('Escape');assert.equal(await page.locator('#modal').evaluate(el=>el.open),true);
    let current=await audit();assert.equal(writes(current).length,1);assert.equal(current.dialogs.length,0);
    await page.locator('#notion-confirm-export').evaluate(el=>{el.click();el.click();});
    assert.equal(writes(await audit()).length,1);
    await application.evaluate(()=>globalThis.__notionDirect.release());await success();
    current=await audit();const summaryWrite=writes(current)[0];
    assert.equal(summaryWrite.body.parent.page_id,fixture.targetA);assert.equal(summaryWrite.body.properties.title.title[0].text.content,'SUMMARY EDITED TITLE');
    const submitted=blockText(summaryWrite.body.children);assert.ok(submitted.includes(summaryBody)&&submitted.includes('NOTION-FIXTURE-REFERENCE-'));assert.ok(!submitted.includes('ORIGINAL-SYNTHETIC-SUMMARY'));
    scopes.summary=true;scopes.duplicateProtected=true;scopes.noExtraConfirmation=true;await finish();
    check('One explicit summary click submits edited content and references once; repeated clicks, Escape and native confirmation cannot interfere');

    stage='summary-failure';await editor();await page.locator('#notion-edit-body').fill('SUMMARY-FAILURE-DRAFT');
    await application.evaluate(()=>{globalThis.__notionDirect.failNextCreate=true;});
    await page.locator('#notion-confirm-export').click();await page.waitForFunction(()=>document.getElementById('modal-error')?.textContent.includes('HTTP 400'));
    assert.equal(await page.locator('#notion-edit-body').inputValue(),'SUMMARY-FAILURE-DRAFT');assert.equal(await page.locator('#notion-confirm-export').isDisabled(),false);
    assert.equal(await page.locator('#modal-title').textContent(),'编辑 Notion 导出预览');
    const failureCount=writes(await audit()).length;await page.waitForTimeout(450);assert.equal(writes(await audit()).length,failureCount);
    await page.screenshot({path:path.join(evidence,'summary-known-failure.png')});await cancel();
    check('Known summary failure keeps the draft visible with an error and no success screen or automatic retry');

    stage='bookmarks-preview';await page.locator('[data-view=bookmarks]').click();await page.waitForSelector('.bookmark-select');
    await page.locator('.bookmark-select').nth(0).check();await page.locator('.bookmark-select').nth(1).check();
    assert.match(await page.locator('#bookmark-selected-count').textContent(),/2/);
    await page.locator('#export-bookmarks-notion').click();await chooseTarget(fixture.targetB);
    const batchOriginal=await page.locator('#notion-edit-body').inputValue();assert.ok(batchOriginal.includes('虚构备注'));
    await cancel();assert.equal(writes(await audit()).length,failureCount);
    await page.locator('#export-bookmarks-notion').click();await chooseTarget(fixture.targetB);
    assert.equal(await page.locator('#notion-edit-body').inputValue(),batchOriginal);
    check('Two selected bookmarks use the same direct-submit editor; canceled batch preview makes zero writes and keeps selection');

    stage='bookmarks-failure';
    const batchTitle='BATCH EDITED TITLE',batchBody=('BOOKMARK-DRAFT-EDITED-ONLY '+('x'.repeat(175))+'\n').repeat(960).slice(0,190000);
    await page.locator('#notion-edit-title').fill(batchTitle);await page.locator('#notion-edit-body').fill(batchBody);await page.locator('#notion-include-references').uncheck();
    await application.evaluate(()=>{globalThis.__notionDirect.failNextAppend=true;});
    await page.locator('#notion-confirm-export').click();await page.waitForFunction(()=>document.getElementById('modal-error')?.textContent.includes('HTTP 400'));
    assert.equal(await page.locator('#notion-edit-title').inputValue(),batchTitle);assert.equal(await page.locator('#notion-edit-body').inputValue(),batchBody);
    assert.equal(await page.locator('#notion-include-references').isChecked(),false);
    assert.equal(await page.locator('#modal-title').textContent(),'编辑 Notion 导出预览');
    const afterFailure=await audit(),count=writes(afterFailure).length;
    assert.equal(afterFailure.requests.filter(r=>r.kind==='append').length,1);
    await page.waitForTimeout(450);assert.equal(writes(await audit()).length,count);scopes.failurePreserved=true;
    await page.screenshot({path:path.join(evidence,'bookmarks-partial-failure.png')});
    check('Partial batch failure preserves every edited character and disabled-reference choice without success or automatic retry');

    stage='bookmarks-reopen';await cancel();await page.locator('#export-bookmarks-notion').click();await chooseTarget(fixture.targetB);
    assert.equal(await page.locator('#notion-edit-title').inputValue(),batchTitle);assert.equal(await page.locator('#notion-edit-body').inputValue(),batchBody);
    assert.equal(await page.locator('#notion-include-references').isChecked(),false);assert.ok(await page.locator('#notion-resume-notice').isVisible());
    assert.equal(await page.locator('#notion-confirm-export').isDisabled(),false);assert.equal(writes(await audit()).length,count);
    scopes.partialDraftRestored=true;await page.screenshot({path:path.join(evidence,'bookmarks-restored-draft.png')});
    check('Reopening an unfinished export restores exact journaled title, body and reference choice without a new consent step');

    stage='bookmarks-retry';await page.locator('#notion-confirm-export').click();await success();current=await audit();
    const appends=current.requests.filter(r=>r.kind==='append');
    assert.equal(appends.length,2);assert.equal(appends[0].pageId,appends[1].pageId);assert.deepEqual(appends[0].body,appends[1].body);
    assert.equal(current.requests.filter(r=>r.kind==='create').length,3);assert.equal(appends[1].status,200);
    const batchPage=appends[1].pageId,completed=current.requests.filter(r=>r.pageId===batchPage&&r.status===200).flatMap(r=>r.body.children);
    const batchText=blockText(completed);assert.ok(batchText.includes(batchBody));assert.ok(!batchText.includes('NOTION-FIXTURE-REFERENCE-'));
    scopes.multipleBookmarks=true;await finish();
    check('Explicit batch retry appends to the same mock page once, preserving edited body and excluding unchecked references');

    stage='preservation';const saved=new Store(path.join(dataDir,'accounts')).get(fixture.accountId);
    assert.deepEqual(saved.summaries,sources.summaries);assert.deepEqual(saved.bookmarks,sources.bookmarks);assert.deepEqual(saved.messages,sources.messages);
    assert.equal(Object.values(saved.exports).filter(e=>e.status==='completed').length,2);
    assert.deepEqual(current.dialogs,[]);assert.deepEqual(current.blocked,[]);assert.deepEqual(errors,[]);assert.deepEqual(httpRequests,[]);
    check('Original synthetic chats, bookmarks and summary remain unchanged; two completed journal records and zero real network/dialog calls');
    stage='complete';
  }catch(error){failure=String(error.stack||error);if(page&&!page.isClosed())await page.screenshot({path:path.join(evidence,'failure.png')}).catch(()=>{});}
  finally{
    await close().catch(error=>{failure||='CLOSE_FAILED '+String(error);});
    const resourcesAfter=manifest(resourceRoot);fs.writeFileSync(path.join(evidence,'resources-after.json'),JSON.stringify(resourcesAfter,null,2));
    result.stage=stage;result.failure=failure;result.audit=auditData;
    result.executableSha256=exeBefore;result.applicationManifestSha256=applicationManifestSha256(resourcesAfter);
    result.resourcesUnchanged=JSON.stringify(resourcesBefore)===JSON.stringify(resourcesAfter)&&hash(executablePath)===exeBefore;
    result.sourceStillMatches=JSON.stringify(sourceBefore)===JSON.stringify(manifest(path.join(root,'app')));
    result.noPackagedFilesReplaced=packaged&&result.resourcesUnchanged;
    result.nativeExitedCleanly=launches.length===1&&launches.every(r=>r.exitCode===0&&r.signal===null);
    result.passed=stage==='complete'&&!failure&&result.resourcesUnchanged&&result.nativeExitedCleanly&&(packaged||result.sourceStillMatches);
    result.scope='Synthetic import profile only; original main/preload/store/renderer; in-memory mock Notion responses and dummy local token; no real AI/Notion requests or pages. Final mode does not replace packaged files.';
    fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify({passed:result.passed,stage,checks:checks.length,report:path.join(evidence,'result.json')}));
    if(!result.passed)process.exitCode=1;
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
