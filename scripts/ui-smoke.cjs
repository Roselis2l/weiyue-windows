'use strict';
const {assertWindowsRuntimeReadable}=require('./windows-runtime-check.cjs');
// Uses an existing Playwright installation; never downloads a browser or contacts services.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const playwrightPath=process.env.PLAYWRIGHT_MODULE||'playwright';
const {_electron}=require(playwrightPath);
const root=path.resolve(__dirname,'..');
const executablePath=process.argv[2]?path.resolve(process.argv[2]):path.join(root,'vendor/runtime/electron.exe');
const packaged=!!process.argv[2];
const evidence=path.resolve(process.env.WEIYUE_UI_OUTPUT||path.join(root,'artifacts'));fs.mkdirSync(evidence,{recursive:true});
const dataDir=path.join(evidence,'ui-profile-'+Date.now());
const readerAnchor=page=>page.evaluate(()=>{
 const scroll=document.querySelector('#message-scroll'),top=scroll.getBoundingClientRect().top;
 const article=[...scroll.querySelectorAll('article[data-message-id]')].find(item=>item.getBoundingClientRect().bottom>top+1);
 return {id:article?.dataset.messageId,offset:article?article.getBoundingClientRect().top-top:null};
});
const waitAnchorAtTop=(page,id)=>page.waitForFunction(id=>{
 const scroll=document.querySelector('#message-scroll');if(!scroll)return false;
 const article=[...scroll.querySelectorAll('article[data-message-id]')].find(item=>item.dataset.messageId===id);
 return article&&Math.abs(article.getBoundingClientRect().top-scroll.getBoundingClientRect().top)<=2;
},id);
(async()=>{
 const errors=[];const checks=[];let application,page,version,aiAudit;
 try{
  assertWindowsRuntimeReadable(executablePath);
  application=await _electron.launch({executablePath,cwd:root,args:[...(packaged?[]:[root]),'--data-dir='+dataDir],timeout:30000});
  page=await application.firstWindow();page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  version=await application.evaluate(({app})=>app.getVersion());assert.equal(version,JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version);
  await page.waitForSelector('#group-list button',{timeout:30000});
  await page.waitForSelector('article[data-message-id]',{timeout:15000});
  await page.screenshot({path:path.join(evidence,'reading.png'),fullPage:true});
  const state=await page.evaluate(()=>window.api.call('state'));
  assert.equal(state.account.kind,'demo');assert.ok(state.stats.messages>500);checks.push('Windows executable launched; demo has 592 records');
  const isolation=await page.evaluate(()=>({node:typeof require,process:typeof process}));assert.deepEqual(isolation,{node:'undefined',process:'undefined'});checks.push('Renderer has no Node require or process access');
  const windows=await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().map(w=>({sandbox:w.webContents.getLastWebPreferences().sandbox,contextIsolation:w.webContents.getLastWebPreferences().contextIsolation,nodeIntegration:w.webContents.getLastWebPreferences().nodeIntegration})));
  assert.ok(windows.every(w=>w.sandbox&&w.contextIsolation&&!w.nodeIntegration));checks.push('Sandbox and context isolation enabled');
  const protection=await application.evaluate(({safeStorage})=>({available:safeStorage.isEncryptionAvailable(),roundtrip:safeStorage.decryptString(safeStorage.encryptString('LOCAL-MOCK-DPAPI'))==='LOCAL-MOCK-DPAPI'}));
  assert.ok(protection.available&&protection.roundtrip);checks.push('Actual Windows DPAPI encrypt/decrypt roundtrip');
  const before=state.stats.bookmarks;
  await page.locator('article[data-message-id] input[type=checkbox]').nth(0).check();
  await page.locator('article[data-message-id] input[type=checkbox]').nth(1).check();
  await page.locator('#bookmark-note').fill('UI验收：保留上下文与行动建议');await page.locator('#bookmark-tags').fill('验收,待读');
  await page.locator('#save-bookmark').click();
  await page.waitForFunction(async n=>(await window.api.call('state')).stats.bookmarks===n,before+1);
  checks.push('Two-message bookmark saved with note and tags');
  await page.locator('[data-view=bookmarks]').click();await page.locator('#bookmark-search').fill('UI验收');await page.locator('#bookmark-search').press('Enter');
  await page.waitForFunction(()=>document.querySelectorAll('.bookmark-card[data-bookmark-id]').length===1&&document.querySelectorAll('.bookmark-select[data-bookmark-id]').length===1);
  await page.screenshot({path:path.join(evidence,'bookmarks.png')});
  const exportPath=path.join(evidence,'ui-bookmarks.md');const summaryPath=path.join(evidence,'ui-summary.md');
  await application.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},exportPath);
  await page.locator('#export-bookmarks-md').click();await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('导出完成'));
  assert.ok(fs.readFileSync(exportPath,'utf8').includes('UI验收'));checks.push('Bookmark search and Markdown export');
  await page.getByRole('button',{name:'回到原文 ↗'}).first().click();await page.waitForSelector('.message.target');checks.push('Bookmark returns to original message');
  await page.locator('#message-search').fill('不存在的验收关键词XYZ');await page.locator('#message-search').press('Enter');
  await page.waitForFunction(()=>document.querySelectorAll('article[data-message-id]').length===0);
  await page.locator('#message-search').fill('');await page.locator('#message-search').press('Enter');await page.waitForSelector('article[data-message-id]');
   await page.locator('#member-filter .member-picker-toggle').click();
   const member=await page.locator('#member-filter input[type=checkbox]').first().inputValue();
   assert.ok(member&&member!=='on','Member checkbox must expose the stable member ID as its value');
   const memberValue=await page.evaluate(value=>CSS.escape(value),member);
   const memberCheckbox=page.locator(`#member-filter input[type=checkbox][value="${memberValue}"]`);
   await memberCheckbox.check();
  await page.waitForFunction(()=>document.querySelector('.read-meta')?.textContent.includes('已筛选'));
  const senders=await page.locator('article[data-message-id] .sender-name').allTextContents();assert.equal(new Set(senders).size,1);checks.push('Keyword and member filters');
   await memberCheckbox.uncheck();await page.waitForFunction(()=>!document.querySelector('.read-meta')?.textContent.includes('已筛选'));
   await page.locator('#member-filter .member-picker-toggle').click();
  const beforeProgrammatic=(await page.evaluate(()=>window.api.call('state'))).readStates[state.groups[0].id].readThroughId;
  await page.locator('#message-scroll').evaluate(el=>el.scrollTop=600);await page.waitForTimeout(850);
  const readState=await page.evaluate(()=>window.api.call('state'));assert.ok(readState.readPositions[state.groups[0].id]);
  assert.equal(readState.readStates[state.groups[0].id].readThroughId,beforeProgrammatic,'Programmatic layout movement must not mark messages read');
  const savedReader=await readerAnchor(page);
  await page.locator('[data-group-id]').nth(1).click();await page.waitForFunction(id=>document.querySelector('.group-item.active')?.dataset.groupId===id,state.groups[1].id);await page.waitForSelector('article[data-message-id]');
  await page.locator('[data-group-id]').nth(0).click();await waitAnchorAtTop(page,savedReader.id);assert.equal((await readerAnchor(page)).id,savedReader.id);
  assert.equal((await page.evaluate(()=>window.api.call('state'))).readStates[state.groups[0].id].readThroughId,beforeProgrammatic);
  checks.push('Per-group switch restores the saved message at viewport top without passive read advancement');
  await page.locator('#preview-summary').click();await page.waitForSelector('.preview-stats');
  await page.locator('#generate-local').click();await page.waitForSelector('#export-summary');await page.waitForSelector('.citation');
  const summaries=await page.evaluate(()=>window.api.call('summary.list'));assert.ok(summaries[0].refs.length>0);assert.equal(summaries[0].mode,'local');
  await page.screenshot({path:path.join(evidence,'summary.png')});checks.push('Time-range preview, local summary, coverage warning and source references');
  await application.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},summaryPath);
  await page.locator('#export-summary').click();await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('已导出'));assert.ok(fs.readFileSync(summaryPath,'utf8').includes('[M1]'));
  await page.locator('.citation').first().click();await page.waitForSelector('.message.target');checks.push('Summary Markdown export and citation returns to original');
  await page.locator('#settings-button').click();await page.locator('#configure-ai').click();await page.waitForSelector('#ai-provider');
  await page.locator('#ai-provider').selectOption('custom');await page.locator('#ai-endpoint').fill('http://127.0.0.1:9999/v1');await page.locator('#ai-model').fill('mock-ui-only');await page.locator('#ai-key').fill('LOCAL-TEST-NOT-A-REAL-KEY');
  await page.locator('#save-ai-config').click();await page.waitForSelector('#notion-token');
  await page.locator('#notion-token').fill('LOCAL-TEST-NOT-A-REAL-TOKEN');await page.locator('#save-settings').click();await page.waitForFunction(()=>!document.querySelector('#modal').open);
  const configured=await page.evaluate(()=>window.api.call('state'));assert.ok(configured.credentials.ai&&configured.credentials.notion);assert.ok(!JSON.stringify(configured).includes('LOCAL-TEST'));
  for(const name of fs.readdirSync(path.join(dataDir,'credentials')))assert.ok(!fs.readFileSync(path.join(dataDir,'credentials',name)).includes(Buffer.from('LOCAL-TEST')));
  checks.push('UI settings saved as encrypted credentials, no secret echo in IPC state');
  await application.evaluate(({net,dialog,ipcMain})=>{
    globalThis.__mockCalls=[];globalThis.__mockConfirms=[];globalThis.__mockViolations=[];globalThis.__mockNotionExports=[];
    // AI retains native confirmation. Notion submits directly from its editor.
    globalThis.__mockDecisions=[0,1,1];
    const ensure=(condition,label)=>{if(!condition){globalThis.__mockViolations.push(label);throw Error('Mock request contract: '+label);}};
    // Observation-only wrapper delegates the exact existing handler and response.
    // Capture the real first export snapshot, so the repeated-export assertion
    // cannot accidentally test an independently reconstructed draft.
    const originalCall=ipcMain._invokeHandlers?.get('weiyue:call');
    ensure(typeof originalCall==='function','Pinned Electron IPC observer available');
    ipcMain.removeHandler('weiyue:call');
    ipcMain.handle('weiyue:call',(event,action,payload)=>{
      if(action==='notion.export')globalThis.__mockNotionExports.push(structuredClone(payload));
      return originalCall(event,action,payload);
    });
    dialog.showMessageBox=async(...args)=>{
      const options=args.at(-1),response=globalThis.__mockDecisions.shift();
      ensure(response===0||response===1,'Unexpected native confirmation');
      ensure(options.title==='确认发送内容'&&options.defaultId===0&&options.cancelId===0,'Native confirmation defaults to cancel');
      globalThis.__mockConfirms.push({message:options.message,detail:options.detail,response});return {response};
    };
    net.fetch=async(url,options={})=>{
      const address=String(url),method=options.method||'GET';
      const aiLocal=address==='http://127.0.0.1:9999/v1/chat/completions';
      const aiOfficial=address==='https://api.openai.com/v1/chat/completions';
      const notionSearch=address==='https://api.notion.com/v1/search';
      const notionCreate=address==='https://api.notion.com/v1/pages';
      const notionAppend=address==='https://api.notion.com/v1/blocks/22222222-2222-4222-8222-222222222222/children';
      const record={url:aiLocal||aiOfficial||notionSearch||notionCreate||notionAppend?address:'[unmatched URL]',method};
      globalThis.__mockCalls.push(record);
      ensure(aiLocal||aiOfficial||notionSearch||notionCreate||notionAppend,'Unmatched URL blocked without network');
      ensure(method===(notionAppend?'PATCH':'POST'),'Exact HTTP method');
      const headers=new Headers(options.headers);ensure(headers.get('content-type')==='application/json','JSON Content-Type');
      ensure(options.redirect==='error','Redirects forbidden');
      const body=JSON.parse(options.body);
      if(aiLocal||aiOfficial){
        ensure(headers.get('authorization')==='Bearer LOCAL-TEST-NOT-A-REAL-KEY','Mock AI credential only');
        ensure(body.model===(aiLocal?'mock-ui-only':'gpt-6-astra'),'Exact resolved model');
        ensure(Array.isArray(body.messages)&&body.messages.length===2,'System and user messages only');
        ensure(body.messages[0].role==='system'&&body.messages[1].role==='user','Exact message roles');
        ensure(body.messages.every(message=>typeof message.content==='string'&&message.content.length>0),'Text-only message content');
        ensure(body.messages[0].content.includes('不可信的聊天资料'),'Data remains untrusted');
        const reference=body.messages[1].content.match(/"ref":"(M\d+)"/)?.[1];ensure(!!reference,'Selected chat reference');
        ensure(!Object.hasOwn(body,'tools'),'No tools');
        const keys=Object.keys(body).sort().join(',');
        if(aiLocal){
          ensure(keys==='max_tokens,messages,model,temperature','Exact compatible payload fields');
          ensure(body.max_tokens===4096&&body.temperature===0.2,'Compatible token and temperature parameters');
          record.model=body.model;record.parameters={max_tokens:body.max_tokens,temperature:body.temperature};record.outcome=400;
          return new Response(JSON.stringify({error:{code:'unsupported_value',param:'temperature',
            message:'LOCAL-TEST-NOT-A-REAL-KEY MOCK-CHAT-REFLECTION-DO-NOT-SHOW <img src=x onerror="window.errorInjected=true">'}}),
          {status:400,headers:{'content-type':'application/json'}});
        }
        ensure(keys==='max_completion_tokens,messages,model','Exact official payload fields');
        ensure(body.max_completion_tokens===4096&&!Object.hasOwn(body,'temperature'),'Official token budget without temperature');
        record.model=body.model;record.parameters={max_completion_tokens:body.max_completion_tokens};record.outcome=200;
        return new Response(JSON.stringify({choices:[{message:{content:`模拟 AI 回顾：保留上下文并回查出处。[${reference}]`},finish_reason:'stop'}]}),{status:200,headers:{'content-type':'application/json'}});
      }
      ensure(headers.get('authorization')==='Bearer LOCAL-TEST-NOT-A-REAL-TOKEN','Mock Notion credential only');
      if(notionSearch)return new Response(JSON.stringify({results:[{object:'page',id:'11111111-1111-4111-8111-111111111111',properties:{title:{type:'title',title:[{plain_text:'本地模拟目标'}]}}}],has_more:false}),{status:200});
      if(notionCreate){ensure(body.parent?.page_id==='11111111-1111-4111-8111-111111111111','Exact mock Notion target');return new Response(JSON.stringify({id:'22222222-2222-4222-8222-222222222222',url:'https://www.notion.so/22222222222242228222222222222222'}),{status:200});}
      return new Response(JSON.stringify({results:body.children}),{status:200});
    };
  });
  const mockState=()=>application.evaluate(()=>({calls:globalThis.__mockCalls,confirms:globalThis.__mockConfirms,violations:globalThis.__mockViolations,decisionsLeft:globalThis.__mockDecisions.length,notionExports:globalThis.__mockNotionExports}));
  const summariesBeforeAI=(await page.evaluate(()=>window.api.call('summary.list'))).length;assert.equal(summariesBeforeAI,1);
  await page.locator('#generate-ai').click();await page.waitForSelector('#ai-consent');
  const aiChunkCount=Number((await page.locator('#modal .preview-blocks').first().textContent()).match(/分段：(\d+) 个/)?.[1]);assert.ok(aiChunkCount>0);
  assert.equal(await page.locator('#ai-consent').isChecked(),false);assert.equal(await page.locator('#confirm-ai-send').isDisabled(),true);
  let audit=await mockState();assert.equal(audit.calls.length,0);assert.equal(audit.confirms.length,0);
  checks.push('AI preview without consent sends no request and opens no native confirmation');
  await page.locator('#ai-consent').check();await page.locator('#confirm-ai-send').click();
  await page.waitForFunction(()=>!document.querySelector('#modal').open&&document.querySelector('#ai-request-message')?.textContent.startsWith('已取消，未发送内容。')&&!document.querySelector('#generate-ai').disabled);
  audit=await mockState();assert.equal(audit.calls.length,0);assert.equal(audit.confirms.length,1);assert.equal(audit.confirms[0].response,0);
  assert.equal((await page.evaluate(()=>window.api.call('summary.list'))).length,summariesBeforeAI);
  checks.push('Canceling native AI confirmation sends no request, saves no summary and restores the generation action outside the closed modal');
  // Reopening and consenting again is an explicit new user action; the mock returns exactly one 400.
  await page.locator('#generate-ai').click();await page.waitForSelector('#ai-consent');
  assert.equal(await page.locator('#ai-consent').isChecked(),false);assert.equal(await page.locator('#confirm-ai-send').isDisabled(),true);
  await page.locator('#ai-consent').check();await page.locator('#confirm-ai-send').click();
  const safeAiError=`AI 服务返回 HTTP 400（第 1/${aiChunkCount} 段）。服务不接受 temperature 参数或取值，请核对该模型的采样参数要求。此前 0 段已完成；程序未自动重试。`;
  await page.waitForFunction(expected=>!document.querySelector('#modal').open&&document.querySelector('#ai-request-message')?.textContent.startsWith(expected)&&!document.querySelector('#generate-ai').disabled,safeAiError);
  await page.waitForTimeout(500);audit=await mockState();assert.equal(audit.calls.length,1);assert.equal(audit.confirms.length,2);assert.equal(audit.confirms[1].response,1);
  assert.equal(audit.calls[0].outcome,400);assert.deepEqual(audit.violations,[]);
  const errorText=await page.locator('#ai-request-message').textContent();assert.equal(errorText,safeAiError+'不会自动重试，请检查后重新确认发送。');
  assert.doesNotMatch(errorText,/LOCAL-TEST|MOCK-CHAT-REFLECTION|<img|onerror/);assert.equal(await page.locator('#ai-request-message img').count(),0);assert.equal(await page.evaluate(()=>window.errorInjected),undefined);
  assert.equal((await page.evaluate(()=>window.api.call('summary.list'))).length,summariesBeforeAI);
  await page.screenshot({path:path.join(evidence,'ai-400-safe-error.png')});
  checks.push('One confirmed compatible AI 400 yields only fixed safe main-window guidance, no retry or partial save, and restores the generation action');
  await page.locator('#settings-button').click();await page.locator('#configure-ai').click();await page.waitForSelector('#ai-provider');
  await page.locator('#ai-endpoint').fill('https://api.openai.com/v1/responses');await page.locator('#ai-model').fill('GPT-6 Astra');await page.locator('#ai-key').fill('LOCAL-TEST-NOT-A-REAL-KEY');
  const unsupportedProtocol='此地址使用的 API 协议暂不支持。请填写兼容 Chat Completions 的服务基础地址或完整 /chat/completions 地址。';
  assert.equal(await page.locator('#save-ai-config').isDisabled(),true);
  const protocolRejection=await page.evaluate(async()=>{
    try{await window.api.call('settings.ai.save',{providerId:'custom',endpoint:'https://api.openai.com/v1/responses',model:'GPT-6 Astra',aiKey:'LOCAL-TEST-NOT-A-REAL-KEY',keyAction:'replace'});return null;}
    catch(error){return error.message;}
  });
  assert.equal(protocolRejection,unsupportedProtocol);
  audit=await mockState();assert.equal(audit.calls.length,1);assert.equal(audit.confirms.length,2);
  assert.equal((await page.evaluate(()=>window.api.call('state'))).settings.endpoint,'http://127.0.0.1:9999/v1');
  checks.push('Unsupported Responses settings are rejected locally without network, native confirmation or overwriting saved settings');
  await page.locator('#ai-provider').selectOption('openai');await page.locator('#ai-model').fill('GPT-6 Astra');await page.locator('#ai-key').fill('LOCAL-TEST-NOT-A-REAL-KEY');await page.locator('#save-ai-config').click();await page.waitForSelector('#notion-token');
  await page.locator('#save-settings').click();await page.waitForFunction(()=>!document.querySelector('#modal').open);
  assert.equal((await page.evaluate(()=>window.api.call('state'))).settings.model,'GPT-6 Astra');
  // Only this further explicit consent/confirmation may produce the single saved AI summary.
  await page.locator('#generate-ai').click();await page.waitForSelector('#ai-consent');audit=await mockState();assert.equal(audit.calls.length,1);assert.equal(audit.confirms.length,2);
  assert.equal(await page.locator('#confirm-ai-send').isDisabled(),true);await page.locator('#ai-consent').check();await page.locator('#confirm-ai-send').click();
  await page.waitForFunction(()=>!document.querySelector('#modal').open);
  await page.waitForFunction(async count=>(await window.api.call('summary.list')).length===count,summariesBeforeAI+1);
  await page.waitForSelector('#view-ai-summary');await page.locator('#view-ai-summary').click();await page.waitForSelector('#notion-load-targets');
  const afterAI=await page.evaluate(()=>window.api.call('summary.list'));assert.equal(afterAI.length,summariesBeforeAI+1);assert.equal(afterAI[0].mode,'ai');
  audit=await mockState();assert.equal(audit.confirms.length,3);assert.equal(audit.confirms[2].response,1);
   assert.match(audit.confirms[2].detail,/实际模型 ID：gpt-6-astra/);assert.match(audit.confirms[2].detail,/每段生成上限：4096 token/);
  assert.match(audit.confirms[2].detail,/https:\/\/api\.openai\.com\/v1\/chat\/completions/);
  assert.equal(audit.calls.filter(call=>call.url==='http://127.0.0.1:9999/v1/chat/completions').length,1);
  assert.equal(audit.calls.filter(call=>call.url==='https://api.openai.com/v1/chat/completions').length,aiChunkCount);assert.deepEqual(audit.violations,[]);
  assert.equal((await page.evaluate(()=>window.api.call('state'))).settings.model,'GPT-6 Astra');
  checks.push('AI sends only after UI consent plus native confirmation (local mocked response)');
  checks.push('Explicitly renewed consent uses official resolved model and 4096-token budget without temperature, preserving the configured display name');
  aiAudit={summariesBeforeAI,summariesAfterAI:afterAI.length,aiChunkCount,safeAiError,requests:audit.calls,nativeConfirmations:audit.confirms,violations:audit.violations};
  await page.locator('#notion-load-targets').click();await page.waitForSelector('#notion-target');await page.locator('#notion-preview').click();await page.waitForSelector('#notion-edit-body');
  assert.equal(await page.locator('#notion-consent').count(),0);assert.equal(await page.locator('#notion-confirm-export').isDisabled(),false);
  let calls=await application.evaluate(()=>globalThis.__mockCalls);assert.equal(calls.filter(c=>c.url.endsWith('/pages')).length,0);
  await page.screenshot({path:path.join(evidence,'notion-preview.png')});await page.locator('#notion-confirm-export').click();await page.waitForFunction(()=>document.querySelector('#modal-title')?.textContent==='Notion 导出结果');
  await page.getByRole('button',{name:'完成',exact:true}).click();
  const newest=(await page.evaluate(()=>window.api.call('summary.list')))[0];
  audit=await mockState();assert.equal(audit.notionExports.length,1);
  const originalNotionExport=audit.notionExports[0];assert.equal(originalNotionExport.summaryId,newest.id);assert.equal(originalNotionExport.targetId,'11111111-1111-4111-8111-111111111111');
  assert.equal(originalNotionExport.confirmed,true);assert.match(originalNotionExport.sourceHash,/^[a-f0-9]{64}$/);
  assert.equal(originalNotionExport.draft.body,newest.body);assert.equal(originalNotionExport.draft.includeReferences,true);
  await page.evaluate(p=>window.api.call('notion.export',p),originalNotionExport);
  calls=await application.evaluate(()=>globalThis.__mockCalls);assert.equal(calls.filter(c=>c.url.endsWith('/pages')).length,1);checks.push('Notion target selection, editable preview, direct submit and repeated-export idempotency (local mock)');
  audit=await mockState();assert.equal(audit.confirms.length,3);assert.equal(audit.decisionsLeft,0);assert.deepEqual(audit.violations,[]);
  assert.equal(audit.notionExports.length,2);assert.deepEqual(audit.notionExports[1],originalNotionExport);
  assert.ok(audit.confirms.every(confirm=>!confirm.message.includes('Notion')),'Notion must not request a second native confirmation');
  aiAudit.totalNativeConfirmations=audit.confirms.length;aiAudit.totalMockRequests=audit.calls.length;
  const fixture=path.join(evidence,'ui-import.json');fs.writeFileSync(fixture,JSON.stringify({groups:[{id:'custom-group',name:'注入测试（虚构）',selected:true}],messages:[{id:'custom-id',groupId:'custom-group',senderId:'u',senderName:'Mock',time:Date.now()-1000,text:'<img src=x onerror="window.injected=true">'}]}));
  await application.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},fixture);
  await page.locator('#import-button').click();await page.waitForFunction(()=>document.querySelector('#account-select')?.value.startsWith('import-'));await page.waitForSelector('article[data-message-id]');
  assert.ok((await page.locator('.message-text').first().textContent()).includes('<img'));assert.equal(await page.locator('.message-text img').count(),0);assert.equal(await page.evaluate(()=>window.injected),undefined);
  const imported=await page.evaluate(()=>window.api.call('state'));assert.equal(imported.stats.bookmarks,0);assert.equal(imported.credentials.ai,false);
  await page.evaluate(()=>window.api.call('messages.locate',{groupId:'custom-group',messageId:'custom-id'}));checks.push('JSON import is isolated, string IDs locate, injected HTML remains text');
  await page.locator('#account-select').selectOption(state.account.id);await page.waitForFunction(id=>document.querySelector('#account-select')?.value===id,state.account.id);
  await page.waitForFunction(()=>document.querySelector('article[data-message-id]')&&!document.querySelector('article[data-message-id="custom-id"]'));
  assert.equal((await page.evaluate(()=>window.api.call('state'))).stats.bookmarks,before+1);
  const beforeRestartAnchor=await readerAnchor(page);
  const beforeRestartState=await page.evaluate(()=>window.api.call('state'));
  await application.close();application=null;
  assertWindowsRuntimeReadable(executablePath);
  application=await _electron.launch({executablePath,cwd:root,args:[...(packaged?[]:[root]),'--data-dir='+dataDir],timeout:30000});page=await application.firstWindow();await page.waitForSelector('#group-list button');
  await page.waitForSelector('article[data-message-id]');await waitAnchorAtTop(page,beforeRestartAnchor.id);
  const restored=await page.evaluate(()=>window.api.call('state'));assert.equal(restored.stats.bookmarks,before+1);assert.equal(restored.stats.summaries,2);assert.ok(restored.credentials.ai&&restored.credentials.notion);assert.equal(restored.settings.model,'GPT-6 Astra');
  for(const [id,read] of Object.entries(beforeRestartState.readStates))assert.equal(restored.readStates[id].readThroughId,read.readThroughId,'Restart must not advance read state');
  checks.push('Actual executable restart restores the saved message at viewport top and preserves read progress, bookmarks, summaries and encrypted credentials');
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1100,760));await page.waitForTimeout(200);await page.screenshot({path:path.join(evidence,'compact-window.png')});
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);assert.equal(overflow,false);checks.push('1100×760 window has no horizontal page overflow');
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(evidence,'ui-smoke.json'),JSON.stringify({passed:true,version,executablePath,dataDir,checks,errors,windows,protection,aiAudit,generatedAt:new Date().toISOString(),externalServices:'All AI/Notion responses mocked with exact URL and payload contracts; no real service calls'},null,2));
  console.log(JSON.stringify({checks,errors}));
 }catch(e){fs.writeFileSync(path.join(evidence,'ui-smoke.json'),JSON.stringify({passed:false,version,executablePath,dataDir,checks,errors,failure:String(e),generatedAt:new Date().toISOString()},null,2));if(page){console.log('URL',page.url());console.log('ERRORS',JSON.stringify(errors));console.log('BODY',await page.locator('body').innerText());await page.screenshot({path:path.join(evidence,'ui-failure.png')});}throw e;}finally{if(application)await application.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
