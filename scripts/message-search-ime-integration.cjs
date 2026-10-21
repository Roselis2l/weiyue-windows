'use strict';

// CDP drives Chromium's real composition pipeline in an actual sandboxed
// Electron window. This does NOT exercise a Windows Pinyin candidate window.
// DOM-dispatched compatibility events are separately labelled in the report.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto'), assert = require('node:assert/strict');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { assertWindowsRuntimeReadable } = require('./windows-runtime-check.cjs');
const root = path.resolve(__dirname, '..');
const option = name => { const i=process.argv.indexOf(name); return i<0?null:process.argv[i+1]; };
const sourceRoot = path.resolve(option('--source-root') || root);
const expectBug = process.argv.includes('--expect-bug');
const sourceVersion = JSON.parse(fs.readFileSync(path.join(sourceRoot,'package.json'),'utf8')).version;
const harness = fs.mkdtempSync(path.join(os.tmpdir(),'weiyue-search-ime-'));
const evidence = process.env.WEIYUE_IME_OUTPUT ? path.resolve(process.env.WEIYUE_IME_OUTPUT) : fs.mkdtempSync(path.join(root,'artifacts','message-search-ime-'+sourceVersion+'-'));
fs.mkdirSync(evidence,{recursive:true});
const dataDir = path.join(harness,'data');
fs.mkdirSync(dataDir);
fs.cpSync(path.join(root,'vendor/runtime'),path.join(harness,'runtime'),{recursive:true});
fs.cpSync(path.join(sourceRoot,'app'),path.join(harness,'app'),{recursive:true});
const executablePath=path.join(harness,'runtime/electron.exe');
const hash = p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const allFiles = p=>fs.readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?allFiles(path.join(p,e.name)):[path.join(p,e.name)]);
const sourceHashes=Object.fromEntries(allFiles(path.join(harness,'app')).map(p=>[path.relative(path.join(harness,'app'),p),hash(p)]));
const scriptHash=hash(__filename);
const fixture={identity:'9007199254740996888',accountId:'weibo-9007199254740996888',groups:[
  {id:'9007199254740996101',name:'中文搜索甲群',key:'A'},
  {id:'9007199254740996102',name:'中文搜索乙群',key:'B'},
]};
const phrases=new Map([[12,'明天下午三点讨论发布计划'],[45,'中文输入法选词持续验证'],[60,'Release v1.1 中文搜索测试'],[62,'拼音选词 项目进度'],[66,'连续中文输入 测试']]);
fixture.messages=fixture.groups.flatMap((g,gi)=>{
  g.ids=Array.from({length:120},(_,i)=>String(9007199254741200000n+BigInt(gi*1000+i)));
  g.anchorId=g.ids[35];g.throughId=g.ids[34];
  return g.ids.map((id,i)=>({id,groupId:g.id,senderId:'81',senderName:'虚构测试成员',time:1700000000000+i*60000,mediaVersion:1,
    text:phrases.get(i)||`${g.key} 群第 ${i} 条模拟记录。阅读状态与中文搜索验收，全部内容为虚构。`}));
});
const {Store}=require(path.join(harness,'app/core/store.cjs'));
const store=new Store(path.join(dataDir,'accounts'));
store.ensureAccount({id:fixture.accountId,kind:'weibo',name:'中文组合输入离线测试'});
store.mergeMessages(fixture.accountId,fixture.groups.map(g=>({id:g.id,name:g.name,selected:true})),fixture.messages,{history:true});
store.update(fixture.accountId,state=>{
  state.settings.autoSyncEnabled=false;
  fixture.groups.forEach((g,i)=>{
    state.readPositions[g.id]=g.anchorId;
    state.readStates[g.id]={anchorId:g.anchorId,anchorOffset:0,atBottom:false,readThroughId:g.throughId,unreadIds:g.ids.slice(35),updatedAt:2000-i*1000};
  });
});
fs.writeFileSync(path.join(dataDir,'preferences.json'),JSON.stringify({activeId:fixture.accountId}));

function boot(fixtures){
  const {app,net,session,ipcMain}=require('electron');
  const pending=new Map(),held=[];
  const info=globalThis.__searchIme={queries:[],readCalls:[],syncStatuses:[],blocked:[],apiCalls:[],holdKeyword:null,
    holdNext(keyword){this.holdKeyword=keyword;},heldCount(){return held.length;},release(){while(held.length)held.shift()();},
    queue(groupId){
      const original=fixtures.messages.filter(m=>m.groupId===groupId).at(-1);
      const added={...original,id:String(BigInt(original.id)+1n),time:original.time+60000,text:'被动到达的中文测试消息'};
      pending.set(groupId,[added,original]);return added;
    }};
  const originalHandle=ipcMain.handle.bind(ipcMain);
  ipcMain.handle=(channel,handler)=>originalHandle(channel,async(event,action,payload)=>{
    if(channel==='weiyue:call'&&action==='read.set')info.readCalls.push({at:Date.now(),payload});
    if(channel==='weiyue:call'&&action==='sync.status'){
      const value=await handler(event,action,payload);
      info.syncStatuses.push({returnedAt:Date.now(),ok:value.ok,accountId:value.value?.accountId,revision:value.value?.revision});
      return value;
    }
    if(channel==='weiyue:call'&&action==='messages.query'){
      const record={at:Date.now(),payload:{...payload}};info.queries.push(record);
      const value=await handler(event,action,payload);
      record.ids=value.value?.messages?.map(m=>m.id)||[];
      if(info.holdKeyword!==null&&payload.keyword===info.holdKeyword){
        info.holdKeyword=null;record.held=true;return new Promise(resolve=>held.push(()=>{record.releasedAt=Date.now();resolve(value);}));
      }
      return value;
    }
    return handler(event,action,payload);
  });
  const originalFetch=net.fetch.bind(net),originalRequest=net.request.bind(net);
  net.fetch=(url,options)=>{if(/^https?:/i.test(String(url))){info.blocked.push(String(url));return Promise.reject(Error('External fetch blocked'));}return originalFetch(url,options);};
  net.request=options=>{const url=typeof options==='string'?options:options.url;if(/^https?:/i.test(String(url))){info.blocked.push(String(url));throw Error('External request blocked');}return originalRequest(options);};
  const attached=new WeakSet();
  const attach=current=>{
    if(attached.has(current))return;attached.add(current);
    current.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,callback)=>{info.blocked.push(details.url);callback({cancel:true});});
    const fetch=current.fetch.bind(current);
    current.fetch=async(target,options)=>{
      const u=new URL(String(target));if(['app:','file:'].includes(u.protocol))return fetch(target,options);
      info.apiCalls.push(u.pathname);
      if(u.origin==='https://api.weibo.com'&&u.pathname==='/webim/2/direct_messages/contacts.json'&&
          u.searchParams.get('source')==='209678993'&&u.searchParams.get('special_source')==='3'){
        return Response.json({contacts:fixtures.groups.map(group=>({user:{type:2,id:group.id,name:group.name}}))});
      }
      if(u.origin==='https://api.weibo.com'&&u.pathname==='/webim/query_primary_info.json')return Response.json({profile:{id:fixtures.identity,screen_name:'虚构中文测试账号'}});
      if(u.origin==='https://api.weibo.com'&&u.pathname==='/webim/groupchat/query_messages.json'){
        const batch=pending.get(u.searchParams.get('id'));if(!batch)throw Error('No fake sync batch queued');
        return Response.json({has_more:1,messages:batch.map(m=>({id:m.id,gid:m.groupId,from_uid:'81',from_user:{screen_name:m.senderName},time:m.time/1000,content:m.text}))});
      }
      info.blocked.push(String(target));throw Error('Unexpected session request blocked');
    };
  };
  app.on('session-created',attach);app.whenReady().then(()=>attach(session.defaultSession));
  require('./app/main.cjs');
}
fs.writeFileSync(path.join(harness,'boot.cjs'),'('+boot.toString()+')('+JSON.stringify(fixture)+');\n');

let application,page,cdp;
const checks=[],errors=[],samples=[],launches=[];
const check=name=>{checks.push(name);console.log('PASS '+name);};
const api=(action,payload={})=>page.evaluate(({action,payload})=>window.api.call(action,payload),{action,payload});
const audit=()=>application.evaluate(()=>({queries:globalThis.__searchIme.queries,readCalls:globalThis.__searchIme.readCalls,syncStatuses:globalThis.__searchIme.syncStatuses,blocked:globalThis.__searchIme.blocked,apiCalls:globalThis.__searchIme.apiCalls}));
async function capture(){
  const value=await page.evaluate(async()=>{
    const node=document.getElementById('message-search'),scroll=document.getElementById('message-scroll'),bounds=scroll?.getBoundingClientRect();
    const first=[...document.querySelectorAll('article[data-message-id]')].find(n=>n.getBoundingClientRect().bottom>(bounds?.top||0)+1);
    const state=await window.api.call('state'),groupId=document.querySelector('#group-list .active')?.dataset.groupId;
    return {value:node?.value,connected:!!globalThis.__originalSearch?.isConnected,sameNode:node===globalThis.__originalSearch,
      focused:document.activeElement===node,selectionStart:node?.selectionStart,selectionEnd:node?.selectionEnd,
      ids:[...document.querySelectorAll('article[data-message-id]')].map(n=>n.dataset.messageId),groupId,
      firstId:first?.dataset.messageId,firstOffset:first?first.getBoundingClientRect().top-bounds.top:null,
      readStates:state.readStates,stateRevision:state.revision,events:globalThis.__imeEvents};
  });
  return {...value,...await audit()};
}
async function rememberNode(){await page.locator('#message-search').focus();await page.evaluate(()=>{globalThis.__originalSearch=document.getElementById('message-search');});}
async function setText(text){await page.locator('#message-search').focus();await page.keyboard.press('Control+A');if(text)await cdp.send('Input.insertText',{text});else await page.keyboard.press('Backspace');}
async function compose(text){await cdp.send('Input.imeSetComposition',{text,selectionStart:text.length,selectionEnd:text.length});}
async function commit(text){await cdp.send('Input.insertText',{text});}
async function settled(text){
  await page.waitForFunction(value=>document.getElementById('message-search')?.value===value,text);
  await page.waitForTimeout(700);
}
async function drainNaturalPoll(){
  // Prior composition may legitimately defer a background refresh. Let the
  // real renderer's next 2s poll drain it before isolated keyboard query counts.
  // The separate sync-during-composition case below keeps polling fully active.
  const before=(await audit()).syncStatuses.length;
  for(let i=0;i<30&&(await audit()).syncStatuses.length===before;i++)await page.waitForTimeout(100);
  assert.ok((await audit()).syncStatuses.length>before,'Need a naturally delivered poll before isolated keyboard timing');
  await page.waitForTimeout(180);
}
function expectedIds(text,groupId=fixture.groups[0].id){return fixture.messages.filter(m=>m.groupId===groupId&&m.text.toLowerCase().includes(text.toLowerCase())).map(m=>m.id);}
function assertOriginalUnread(value,arrivals=0){
  for(const [i,g]of fixture.groups.entries()){
    assert.equal(value.readStates[g.id].readThroughId,g.throughId,'Search must not advance read boundary');
    assert.equal(value.readStates[g.id].unreadCount,85+(i===0?arrivals:0),'Search must not consume unread');
  }
}
async function snapshot(stage){const value=await capture();samples.push({stage,...value});return value;}

(async()=>{
  let failure,reproduction=null;
  fs.writeFileSync(path.join(evidence,'native.stderr.log'),'');
  try{
    const preflight=assertWindowsRuntimeReadable(executablePath),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
    application=await _electron.launch({executablePath,args:[path.join(harness,'boot.cjs'),'--data-dir='+dataDir],cwd:harness,env,timeout:30000});
    const native=application.process(),launch={pid:native.pid,preflight,startedAt:new Date().toISOString()};launches.push(launch);
    native.once('exit',(exitCode,signal)=>Object.assign(launch,{exitCode,signal,exitedAt:new Date().toISOString()}));
    native.stderr?.on('data',v=>fs.appendFileSync(path.join(evidence,'native.stderr.log'),v));
    page=await application.firstWindow();page.on('pageerror',e=>errors.push(e.message));
    await application.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setSize(1440,930);w.show();w.focus();w.webContents.focus();});
    await page.waitForSelector('article[data-message-id]');
    cdp=await page.context().newCDPSession(page);
    await page.evaluate(()=>{
      globalThis.__imeEvents=[];
      for(const type of ['compositionstart','compositionupdate','compositionend','beforeinput','input','keydown','keyup','focusin','focusout']){
        document.addEventListener(type,e=>{if(e.target?.id==='message-search')globalThis.__imeEvents.push({type,trusted:e.isTrusted,isComposing:e.isComposing??null,key:e.key??null,keyCode:e.keyCode??null,inputType:e.inputType??null,data:e.data??null,value:e.target.value,at:performance.now()});},true);
      }
    });
    await page.waitForTimeout(900);await rememberNode();
    const initialState=await api('state');
    assert.equal(initialState.account.id,fixture.accountId);
    assert.equal(path.resolve(initialState.dataRoot),dataDir);
    assert.equal(await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().every(w=>{
      const p=w.webContents.getLastWebPreferences();return p.sandbox&&p.contextIsolation&&!p.nodeIntegration;
    })),true);
    const baseline=await snapshot('initial');assertOriginalUnread(baseline);assert.equal(baseline.firstId,fixture.groups[0].anchorId);
    check('Actual isolated sandboxed app opens two fake groups with preserved read anchors and unread counts');
    const queryStart=baseline.queries.length;
    await compose('zhongwen');await page.waitForTimeout(650);
    const composing=await snapshot('chromium-composition-over-debounce');
    assert.ok(composing.events.some(e=>e.type==='compositionstart'&&e.trusted),'Need Chromium-generated trusted compositionstart');
    assert.ok(composing.events.some(e=>e.type==='input'&&e.trusted&&e.isComposing),'Need Chromium-generated trusted composing input');
    if(expectBug){
      reproduction={duringCompositionQueries:composing.queries.slice(queryStart),inputWasReplaced:!composing.sameNode,
        lostOriginalNode:!composing.connected,trustedCompositionObserved:true,description:'Old renderer debounces composing input and replaces the live search node after 350ms.'};
      assert.ok(reproduction.duringCompositionQueries.some(q=>q.payload.keyword==='zhongwen'));
      assert.equal(reproduction.inputWasReplaced,true);assert.equal(reproduction.lostOriginalNode,true);
      await page.screenshot({path:path.join(evidence,'baseline-composition-interrupted.png')});
      check('Reproduced 1.1.7: real Chromium composition is queried and its active input destroyed during the candidate phase');
    }else{
      assert.equal(composing.sameNode,true);assert.equal(composing.focused,true);assert.equal(composing.value,'zhongwen');
      assert.equal(composing.queries.length,queryStart,'Uncommitted composition must not query');
      assertOriginalUnread(composing);
      await page.evaluate(()=>document.getElementById('message-search').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:229,isComposing:true,bubbles:true})));
      await page.waitForTimeout(450);const enter=await snapshot('synthetic-ime-enter-229');
      assert.equal(enter.queries.length,queryStart);assert.equal(enter.sameNode,true);assert.equal(enter.focused,true);
      check('Trusted composition beyond debounce and separately simulated IME Enter/229 preserve the live input and do not search');
      await compose('中文输入法');await page.waitForTimeout(500);
      assert.equal((await audit()).queries.length,queryStart);
      await commit('中文输入法');await settled('中文输入法');
      const committed=await snapshot('chinese-phrase-committed');
      assert.equal(committed.sameNode,true);assert.equal(committed.focused,true);assert.deepEqual(committed.ids,expectedIds('中文输入法'));
      assert.equal(committed.queries.slice(queryStart).filter(q=>q.payload.keyword==='中文输入法').length,1);
      assert.ok(committed.events.some(e=>e.type==='compositionend'&&e.data==='中文输入法'),'The CDP commit must deliver compositionend (this runtime reports the commit event as untrusted)');
      assertOriginalUnread(committed);
      check('Committed Chinese candidate performs one current-group search and keeps the input, focus and read boundary');

      let next;
      await drainNaturalPoll();
      const compatibilityStart=(await audit()).queries.length;
      await setText('中文输入法选');
      await page.evaluate(()=>document.getElementById('message-search').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:229,isComposing:false,bubbles:true})));
      await page.waitForTimeout(120);
      assert.equal((await audit()).queries.length,compatibilityStart,'Legacy keyCode 229 must not submit the pending draft even after composition ended');
      await settled('中文输入法选');
      next=await snapshot('synthetic-keycode229-after-composition');
      assert.equal(next.queries.slice(compatibilityStart).filter(q=>q.payload.keyword==='中文输入法选').length,1);
      assert.deepEqual(next.ids,expectedIds('中文输入法选'));assert.equal(next.sameNode,true);assert.equal(next.focused,true);
      assert.ok(next.events.some(e=>e.type==='keydown'&&e.keyCode===229&&e.isComposing===false&&!e.trusted));
      check('Independent synthetic keyCode 229 after composition ends does not submit early or duplicate the debounced search');

      await drainNaturalPoll();
      const enterStart=(await audit()).queries.length;
      await setText('中文输入法选词');await page.keyboard.press('Enter');await settled('中文输入法选词');
      next=await snapshot('trusted-enter-submits-pending-draft');
      assert.equal(next.queries.slice(enterStart).filter(q=>q.payload.keyword==='中文输入法选词').length,1);
      assert.deepEqual(next.ids,expectedIds('中文输入法选词'));assert.equal(next.sameNode,true);assert.equal(next.focused,true);
      assertOriginalUnread(next);
      check('Trusted normal Enter submits a pending Chinese draft once without a later debounce duplicate');
      await setText('中文输入法');await settled('中文输入法');

      await page.keyboard.press('End');await compose('xuanci');await page.waitForTimeout(450);await commit('选词');await settled('中文输入法选词');
      next=await snapshot('continuous-second-composition');assert.deepEqual(next.ids,expectedIds('中文输入法选词'));assert.equal(next.sameNode,true);assertOriginalUnread(next);
      check('Consecutive Pinyin-style compositions append complete Chinese words without losing the caret');

      await page.keyboard.press('Backspace');await settled('中文输入法选');await page.keyboard.press('Backspace');await settled('中文输入法');
      next=await snapshot('trusted-keyboard-deletion');assert.equal(next.sameNode,true);assert.deepEqual(next.ids,expectedIds('中文输入法'));
      check('Trusted keyboard deletion updates Chinese search without input replacement');

      await setText('明天下午三点讨论发布计划');await settled('明天下午三点讨论发布计划');
      next=await snapshot('complete-chinese-sentence');assert.deepEqual(next.ids,expectedIds('明天下午三点讨论发布计划'));assert.equal(next.sameNode,true);
      await setText('Release v1.1 中文');await settled('Release v1.1 中文');
      next=await snapshot('mixed-latin-chinese');assert.deepEqual(next.ids,expectedIds('Release v1.1 中文'));assert.equal(next.sameNode,true);
      check('Full Chinese sentences and mixed English/Chinese text match only the current group');

      await page.evaluate(()=>{
        const n=document.getElementById('message-search');n.value='拼音选词';n.setSelectionRange(4,4);
        n.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertFromPaste',data:'拼音选词',isComposing:false}));
      });
      await settled('拼音选词');next=await snapshot('synthetic-paste-input');assert.deepEqual(next.ids,expectedIds('拼音选词'));assert.equal(next.sameNode,true);
      check('Separately simulated paste input searches complete Chinese text and preserves the node');

      await setText('');await settled('');
      const cleared=await snapshot('clear-search');assert.equal(cleared.sameNode,true);assert.equal(cleared.focused,true);
      assert.equal(cleared.firstId,baseline.firstId);assert.ok(Math.abs(cleared.firstOffset-baseline.firstOffset)<=2);
      assert.equal(cleared.readStates[fixture.groups[0].id].anchorId,fixture.groups[0].anchorId);assertOriginalUnread(cleared);
      check('Clearing search restores the original reading anchor and does not consume unread');

      await compose('zhong');const beforeSync=await capture();
      const added=await application.evaluate((_e,id)=>globalThis.__searchIme.queue(id),fixture.groups[0].id);
      await api('sync',{groupId:fixture.groups[0].id});await page.waitForTimeout(2500);
      const duringSync=await snapshot('background-sync-during-composition');
      assert.equal(duringSync.sameNode,true);assert.equal(duringSync.focused,true);assert.equal(duringSync.value,'zhong');
      assert.equal(duringSync.selectionStart,beforeSync.selectionStart);assert.equal(duringSync.selectionEnd,beforeSync.selectionEnd);
      assert.ok(duringSync.stateRevision>beforeSync.stateRevision,'The mocked sync must change the account revision');
      assert.ok(duringSync.syncStatuses.slice(beforeSync.syncStatuses.length).some(s=>s.accountId===fixture.accountId&&s.revision===duringSync.stateRevision),'Natural renderer polling must receive the new revision');
      assert.ok(duringSync.queries.slice(beforeSync.queries.length).every(q=>q.payload.keyword!=='zhong'));
      assertOriginalUnread(duringSync,1);
      await commit('中文测试');await settled('中文测试');
      next=await snapshot('commit-after-sync');assert.deepEqual(next.ids,[added.id]);assert.equal(next.sameNode,true);assertOriginalUnread(next,1);
      check('Real local mocked sync and natural polling preserve active composition, selection and unread until commit');

      await setText('');await settled('');await rememberNode();
      await application.evaluate(()=>globalThis.__searchIme.holdNext('中文'));
      await setText('中文');
      await page.waitForFunction(async()=>{await window.api.call('state');return true;});
      for(let i=0;i<20&&!await application.evaluate(()=>globalThis.__searchIme.heldCount()>0);i++)await page.waitForTimeout(100);
      assert.equal(await application.evaluate(()=>globalThis.__searchIme.heldCount()),1);
      await page.keyboard.press('Control+A');await compose('pinyin');
      const beforeOld=await capture();await application.evaluate(()=>globalThis.__searchIme.release());await page.waitForTimeout(500);
      const afterOld=await snapshot('old-query-return-during-new-composition');
      assert.equal(afterOld.sameNode,true);assert.equal(afterOld.focused,true);assert.equal(afterOld.value,'pinyin');
      assert.equal(afterOld.selectionStart,beforeOld.selectionStart);
      assert.equal(afterOld.selectionEnd,beforeOld.selectionEnd);assert.deepEqual(afterOld.ids,beforeOld.ids,'Stale response must not change the visible message list');
      await commit('拼音选词');await settled('拼音选词');
      assert.deepEqual((await capture()).ids,expectedIds('拼音选词'));assertOriginalUnread(await capture(),1);
      check('An older delayed search result cannot replace the input or overwrite a newer composition');

      await setText('');await settled('');await compose('weixuan');await page.waitForTimeout(80);
      await page.locator('[data-group-id="'+fixture.groups[1].id+'"]').click();await page.waitForTimeout(900);
      next=await snapshot('group-switch-cancels-composition-work');assert.equal(next.groupId,fixture.groups[1].id);assert.equal(next.value,'');
      assert.equal(next.firstId,fixture.groups[1].anchorId);assertOriginalUnread(next,1);
      await rememberNode();await setText('中文输入法');await settled('中文输入法');
      next=await snapshot('same-chinese-query-other-current-group');assert.deepEqual(next.ids,expectedIds('中文输入法',fixture.groups[1].id));assertOriginalUnread(next,1);
      check('Switching groups cancels old composition/debounce and the same Chinese query remains group-scoped');
      await page.screenshot({path:path.join(evidence,'chinese-current-group-result.png')});
      await setText('');await settled('');
      await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1000,680));
      await setText('Release v1.1 中文');await settled('Release v1.1 中文');
      await page.screenshot({path:path.join(evidence,'mixed-chinese-search-minimum.png')});
      assertOriginalUnread(await capture(),1);
      check('Minimum supported window accepts mixed Chinese text while preserving read state');
    }
    assert.deepEqual(errors,[]);assert.deepEqual((await audit()).blocked,[]);
  }catch(error){failure=String(error.stack||error);console.error(failure);if(page&&!page.isClosed()){await page.screenshot({path:path.join(evidence,'failure.png')}).catch(()=>{});samples.push({stage:'failure',...(await capture().catch(()=>({})))});}}
  finally{
    let network;
    if(application){
      network=await audit().catch(()=>null);
      await application.evaluate(()=>globalThis.__searchIme.release()).catch(()=>{});
      await application.close().catch(e=>{failure||=String(e);});application=null;
    }
    const sourceStillMatches=Object.entries(sourceHashes).every(([p,h])=>hash(path.join(sourceRoot,'app',p))===h);
    const frozenStillMatches=Object.entries(sourceHashes).every(([p,h])=>hash(path.join(harness,'app',p))===h);
    const nativeExitedCleanly=launches.length===1&&launches[0].exitCode===0&&launches[0].signal===null;
    const scriptStillMatches=hash(__filename)===scriptHash;
    const passed=!failure&&!errors.length&&network?.blocked.length===0&&sourceStillMatches&&frozenStillMatches&&nativeExitedCleanly&&scriptStillMatches;
    const result={passed,mode:expectBug?'baseline-reproduction':'regression',sourceVersion,version:sourceVersion,sourceRoot,checks,failure,errors,
      reproduction,samples,network,sourceHashes,sourceStillMatches,frozenStillMatches,nativeExitedCleanly,scriptHash,scriptStillMatches,launches,
      harness,dataDir,executablePath,generatedAt:new Date().toISOString(),coverage:{chromiumTrustedComposition:samples.some(s=>s.events?.some(e=>e.type==='compositionstart'&&e.trusted)),windowsPinyinCandidateUI:false,
        compositionStartUpdateInput:'CDP Input.imeSetComposition produces trusted Chromium compositionstart/update and composing input events',
        compositionCommit:'CDP Input.insertText; compositionend is observed but this Chromium runtime reports isTrusted=false',
        compositionEndTrustObserved:[...new Set(samples.flatMap(s=>(s.events||[]).filter(e=>e.type==='compositionend').map(e=>e.trusted)))],
        keyboard:'Chromium trusted keyboard delivery',paste:'DOM InputEvent insertFromPaste simulation; no system clipboard read or changed',
        enter229:'DOM KeyboardEvent compatibility simulation, separately labelled'},
      scope:'Actual sandboxed Electron, isolated fictitious account and mocked local sync; no real user profile, AI, Notion or external service'};
    fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify({passed,mode:result.mode,checks:checks.length,report:path.join(evidence,'result.json'),nativeExitedCleanly,sourceStillMatches}));
    if(!passed)process.exitCode=1;
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
