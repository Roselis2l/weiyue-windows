'use strict';
// Reproducible public screenshots of the production weibo-account UI.
// This script creates only synthetic data in a fresh Temp directory. It never
// opens an existing profile, a browser login, or a real AI/Notion service.
// Review every PNG visually before placing it in public documentation.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {assertWindowsRuntimeReadable}=require('./windows-runtime-check.cjs');
const root=path.resolve(__dirname,'..'),args=process.argv.slice(2);
if(!args.includes('--capture'))throw Error('Use --capture after reviewing the synthetic fixture and production account layout.');
const exeArg=args.find(x=>x.startsWith('--exe='))?.slice(6)||(args.includes('--exe')?args[args.indexOf('--exe')+1]:null);
const packaged=!!exeArg,harness=fs.mkdtempSync(path.join(os.tmpdir(),'weiyue-release-screenshots-')),dataDir=path.join(harness,'data');
const output=path.resolve(process.env.WEIYUE_SCREENSHOTS_OUTPUT||path.join(root,'artifacts','release-screenshots-'+Date.now()));
fs.mkdirSync(output,{recursive:true});fs.mkdirSync(dataDir);
let appRoot,executablePath;
if(packaged){executablePath=path.resolve(exeArg);appRoot=path.join(path.dirname(executablePath),'resources/app/app');}
else{
  fs.cpSync(path.join(root,'vendor/runtime'),path.join(harness,'runtime'),{recursive:true});
  fs.cpSync(path.join(root,'app'),path.join(harness,'app'),{recursive:true});
  appRoot=path.join(harness,'app');executablePath=path.join(harness,'runtime/electron.exe');
  fs.writeFileSync(path.join(harness,'package.json'),JSON.stringify({name:'weiyue-synthetic-screenshots',version:JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version,main:'app/main.cjs'}));
}
const version=JSON.parse(fs.readFileSync(packaged?path.join(appRoot,'../package.json'):path.join(root,'package.json'),'utf8')).version;
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function manifest(base){
  const result={};
  for(const relative of fs.readdirSync(base,{recursive:true})){
    const file=path.join(base,relative),stat=fs.lstatSync(file);assert.equal(stat.isSymbolicLink(),false);
    if(stat.isFile())result[relative.replace(/\\/g,'/')]=hash(file);
  }
  return result;
}
const sourceBefore=manifest(path.join(root,'app')),resourceBefore=manifest(packaged?path.dirname(appRoot):appRoot),exeBefore=hash(executablePath);
const fixture={
  accountId:'weibo-9007199254740993777',accountName:'示例数据 · 微阅',
  groups:[{id:'9007199254743993001',name:'产品交流 · 示例',selected:true},{id:'9007199254743993002',name:'阅读共学 · 示例',selected:true},{id:'9007199254743993003',name:'灵感便笺 · 示例',selected:true}],
  members:[{id:'sample-member-a',name:'小林（示例）'},{id:'sample-member-b',name:'小陈（示例）'},{id:'sample-member-c',name:'阿禾（示例）'},{id:'sample-member-d',name:'小周（示例）'}],
  targetId:'11111111-1111-4111-8111-111111111111',
  summaryId:'synthetic-summary-product'
};
const start=Date.parse('2026-10-20T08:00:00Z');
const texts=[
  '今天把讨论集中在三个问题：读到哪里、哪些值得保存、怎样回顾。所有内容均为示例数据。',
  '我喜欢先按时间梳理，再把有用的观点一起收藏。这样回头看不会丢掉上下文。[哈哈]',
  '可以把一段讨论写成短摘要，再用引用回到原文核对。结论旁边保留来源很有帮助。[鼓掌]',
  '同意！记录当前阅读位置，稍后看新消息也能接着读。【二哈】',
  '几个表情放在一起也能显示：[笑cry][给力][心]，聊天里的轻松语气可以保留下来。',
  '午后做一次复盘：把待办、不同意见和需要验证的信息分开记录。',
  '阅读筛选精确到分钟，结束的那一分钟也会完整包含进来。',
  '收藏时补一句“为什么值得留下”，以后搜索备注比翻长记录快。',
  '这份讨论很适合分享成一页短笔记。标题和正文可以在导出前再整理。',
  '参考资料可以放在这里：https://example.org/notes 。这是专为说明保留的示例链接。',
  '成员名字旁的重点标记，方便集中关注熟悉的分享者。[赞]',
  '先保留问题，再记录证据，最后写结论。今天的小组复盘就按这个顺序。',
  '补充一条新观点：长记录可以分段阅读，整理后再合并。',
  '我刚补了一份示例材料，稍后一起看。[微笑]',
  '明天继续讨论下一步的安排。'
];
fixture.messages=texts.map((text,i)=>({
  id:String(9007199254744993000n+BigInt(i)),groupId:fixture.groups[0].id,
  senderId:fixture.members[i%fixture.members.length].id,senderName:fixture.members[i%fixture.members.length].name,
  time:start+i*120000,text,mediaVersion:1,attachmentVersion:1
}));
for(let groupIndex=1;groupIndex<fixture.groups.length;groupIndex++){
  for(let i=0;i<4;i++)fixture.messages.push({
    id:String(9007199254744994000n+BigInt(groupIndex*100+i)),groupId:fixture.groups[groupIndex].id,
    senderId:fixture.members[i].id,senderName:fixture.members[i].name,time:start+i*240000,
    text:['本周挑一个主题慢慢读，记录让自己有启发的片段。','把一个问题讲清楚，就是一次有价值的交流。[鼓掌]','这段内容是为软件截图创建的示例，不来自真实群聊。','稍后把讨论整理成一份带引用的时段回顾。'][i],
    mediaVersion:1,attachmentVersion:1
  });
}
const {Store}=require(path.join(appRoot,'core/store.cjs')),store=new Store(path.join(dataDir,'accounts'));
store.ensureAccount({id:fixture.accountId,kind:'weibo',name:fixture.accountName});
store.mergeMessages(fixture.accountId,fixture.groups,fixture.messages,{history:true});
const refs=fixture.messages.slice(0,4).map((m,i)=>({...m,label:'M'+(i+1)}));
const summaryBody='讨论要点\n\n• 先按时间与成员筛选，把一段完整的对话读清楚。[M1]\n• 将有价值的内容连同上下文收藏，并写下自己的理解。[M2]\n• 回顾时保留原文引用，便于核实每个结论。[M3]\n\n后续行动\n\n把今天值得继续讨论的问题整理成一页笔记，下次交流前再回看。[M4]\n\n以上均为软件界面展示用的示例数据。';
store.update(fixture.accountId,state=>{
  state.settings.autoSyncEnabled=false;state.importantMembers=[fixture.members[0].id];
  for(const [i,g]of fixture.groups.entries()){
    const rows=fixture.messages.filter(m=>m.groupId===g.id),through=i===0?11:2;
    state.readPositions[g.id]=rows[0].id;
    state.readStates[g.id]={anchorId:rows[0].id,anchorOffset:0,atBottom:false,readThroughId:rows[through].id,unreadIds:rows.slice(through+1).map(m=>m.id),updatedAt:3000-i*1000};
  }
  state.summaries=[
    {id:fixture.summaryId,groupId:fixture.groups[0].id,title:'午后讨论：把对话整理成收获（示例）',body:summaryBody,mode:'local',start,end:start+1800000,createdAt:start+1860000,refs},
    {id:'synthetic-summary-reading',groupId:fixture.groups[1].id,title:'本周共读：留下问题与启发（示例）',body:'把阅读中遇到的问题记下来，连同原文一起保存。每一次回看，都可以补充新的理解。以上均为示例数据。',mode:'local',start:start-86400000,end:start-82800000,createdAt:start-82700000,refs:fixture.messages.filter(m=>m.groupId===fixture.groups[1].id).map((m,i)=>({...m,label:'M'+(i+1)}))},
    {id:'synthetic-summary-notes',groupId:fixture.groups[2].id,title:'灵感便笺：值得继续探索的方向（示例）',body:'先收集不同视角，再明确需要验证的证据。把未完成的问题留到下一次交流。以上均为示例数据。',mode:'local',start:start-172800000,end:start-169200000,createdAt:start-169100000,refs:fixture.messages.filter(m=>m.groupId===fixture.groups[2].id).map((m,i)=>({...m,label:'M'+(i+1)}))}
  ];
});
store.bookmark(fixture.accountId,{groupId:fixture.groups[0].id,messageIds:fixture.messages.slice(0,3).map(m=>m.id),note:'留下完整上下文，回看时更容易理解。',tags:['阅读方法','示例']});
store.bookmark(fixture.accountId,{groupId:fixture.groups[0].id,messageIds:[fixture.messages[7].id],note:'收藏时写下自己的理解。',tags:['灵感','示例']});
fs.writeFileSync(path.join(dataDir,'preferences.json'),JSON.stringify({activeId:fixture.accountId}));
const storedBefore=store.get(fixture.accountId);
function installMocks({app,net,session,dialog},targetId){
  const info=globalThis.__releaseScreenshots={blocked:[],notionSearches:0,notionWrites:0,nativeDialogs:0};
  const fetch=net.fetch.bind(net),request=net.request.bind(net);
  net.fetch=async(url,options={})=>{
    if(/^(app|file):/i.test(String(url)))return fetch(url,options);
    if(String(url)==='https://api.notion.com/v1/search'&&options.method==='POST'){
      info.notionSearches++;
      return Response.json({results:[{object:'page',id:targetId,properties:{title:{type:'title',title:[{plain_text:'知识手帐 · 示例目标'}]}}}],has_more:false});
    }
    if(String(url).startsWith('https://api.notion.com/'))info.notionWrites++;
    info.blocked.push('net.fetch');throw Error('PUBLIC_SCREENSHOT_EXTERNAL_BLOCKED');
  };
  net.request=options=>{
    if(/^(app|file):/i.test(typeof options==='string'?options:options.url))return request(options);
    info.blocked.push('net.request');throw Error('PUBLIC_SCREENSHOT_EXTERNAL_BLOCKED');
  };
  dialog.showMessageBox=async()=>{info.nativeDialogs++;throw Error('PUBLIC_SCREENSHOT_NATIVE_DIALOG_BLOCKED');};
  const seen=new WeakSet();
  const attach=s=>{
    if(seen.has(s))return;seen.add(s);
    s.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_request,cb)=>{info.blocked.push('webRequest');cb({cancel:true});});
    const sf=s.fetch.bind(s);
    s.fetch=(url,options)=>/^(app|file):/i.test(String(url))?sf(url,options):(info.blocked.push('session.fetch'),Promise.reject(Error('PUBLIC_SCREENSHOT_EXTERNAL_BLOCKED')));
  };
  attach(session.defaultSession);app.on('session-created',attach);
}
let application,page,failure,stage='launch';
const checks=[],shots=[],errors=[],requests=[];
const result={version,mode:packaged?'final-executable':'copied-source',executablePath,harness,dataDir,output,checks,shots,errors,requests,syntheticDataOnly:true,accountKind:'weibo',realServicesCalled:false,realProfileOpened:false};
const check=text=>{checks.push(text);console.log('PASS '+text);};
const api=(action,payload={})=>page.evaluate(({action,payload})=>window.api.call(action,payload),{action,payload});
async function settle(){await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
async function capture(name){
  await settle();
  const text=await page.locator('body').innerText();
  assert.match(text,/示例数据/);assert.match(text,/微博账号 · 本机隔离/);
  assert.doesNotMatch(text,/演示数据 · 仅本机|导入数据 · 仅本机|NOTION-SCREENSHOT-SYNTHETIC|[A-Za-z]:\\|Bearer |Cookie:|签名媒体/);
  assert.equal(await page.locator('img[src^=\"http\"]').count(),0);
  const file=path.join(output,name);await page.screenshot({path:file});
  const bytes=fs.readFileSync(file);
  shots.push({name,path:file,sha256:hash(file),width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20),syntheticLabel:true});
}
(async()=>{
  try{
    const env={...process.env,TZ:'Asia/Shanghai'};delete env.ELECTRON_RUN_AS_NODE;
    result.preflight=assertWindowsRuntimeReadable(executablePath);
    application=await _electron.launch({executablePath,cwd:packaged?path.dirname(executablePath):harness,args:[...(!packaged?[harness]:[]),'--data-dir='+dataDir],env,timeout:45000});
    const native=application.process();result.pid=native.pid;
    native.once('exit',(code,signal)=>{result.exitCode=code;result.exitSignal=signal;});
    await application.evaluate(installMocks,fixture.targetId);
    page=await application.firstWindow();
    page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(/^https?:/i.test(request.url()))requests.push(new URL(request.url()).origin);});
    result.security=await application.evaluate(({app,BrowserWindow})=>{
      const w=BrowserWindow.getAllWindows()[0],p=w.webContents.getLastWebPreferences();
      w.setContentSize(1440,960);w.show();w.focus();
      return {version:app.getVersion(),packaged:app.isPackaged,sandbox:p.sandbox,contextIsolation:p.contextIsolation,nodeIntegration:p.nodeIntegration,webSecurity:p.webSecurity};
    });
    assert.equal(result.security.version,version);assert.ok(result.security.sandbox&&result.security.contextIsolation&&!result.security.nodeIntegration&&result.security.webSecurity);
    if(packaged)assert.equal(result.security.packaged,true);
    await page.waitForSelector('article[data-message-id]');
    let state=await api('state');assert.equal(state.account.id,fixture.accountId);assert.equal(state.account.kind,'weibo');assert.equal(path.resolve(state.dataRoot),dataDir);
    assert.equal(state.credentials.ai,false);assert.equal(state.credentials.notion,false);
    for(const selector of ['#auto-sync-toggle','#sync-latest','#sync-history','#sync-status-line','#jump-latest-read'])assert.equal(await page.locator(selector).isVisible(),true);
    assert.match(await page.locator('#sync-status-line').innerText(),/已暂停/);
    await page.locator('#summary-start').fill('2026-10-20T16:00');
    await page.locator('#summary-start').press('Tab');
    await page.locator('#summary-end').fill('2026-10-20T16:30');
    await page.locator('#summary-end').press('Tab');
    check('Production weibo account route renders sync controls, local coverage and saved reading controls from synthetic data');
    stage='reading';
    await page.locator('#filter-toggle').click();
    await page.locator('#reading-start').fill('2026-10-20T16:00');await page.locator('#reading-start').press('Tab');
    await page.waitForFunction(()=>document.getElementById('read-count').textContent.includes('已筛选'));
    await page.locator('#reading-end').fill('2026-10-20T16:30');await page.locator('#reading-end').press('Tab');
    await page.waitForFunction(()=>document.querySelectorAll('.inline-emoticon[data-emoticon-state="ready"]').length>0);
    await page.locator('.member-picker-toggle').click();
    await page.locator('.member-picker-search').fill('示例');
    await page.locator('.member-picker-option input[value=\"sample-member-a\"]').check();
    await page.locator('.member-picker-option input[value=\"sample-member-b\"]').check();
    await page.waitForFunction(()=>document.querySelector('.member-picker-status').textContent.includes('已选 2 位'));
    await capture('reading-weibo-sample.png');
    assert.equal((await api('state')).readStates[fixture.groups[0].id].readThroughId,storedBefore.readStates[fixture.groups[0].id].readThroughId);
    check('Reading screenshot includes minute range, searchable multiple members, official emoticons and latest-read control');
    stage='summaries';
    await page.locator('.member-picker-search').press('Escape');
    await page.locator('[data-view=\"summaries\"]').click();
    await page.waitForSelector('.summary-list-card');assert.equal(await page.locator('.summary-list-card').count(),3);
    assert.equal(await page.locator('.summary-list-card .summary-delete').count(),3);
    await capture('summaries-weibo-sample.png');
    await page.locator('.summary-list-card[data-summary-id=\"'+fixture.summaryId+'\"] .summary-delete').click();
    await page.waitForSelector('#summary-delete-cancel');
    assert.match(await page.locator('#summary-delete-warning').innerText(),/不影响聊天记录、收藏或已经导出的 Notion 页面/);
    await capture('summary-delete-weibo-sample.png');
    await page.locator('#summary-delete-cancel').click();
    assert.equal((await api('summary.list')).length,3);
    check('Summary cards and local-delete confirmation use synthetic summaries; cancel leaves all summaries intact');
    stage='notion';
    await api('settings.save',{notionToken:'NOTION-SCREENSHOT-SYNTHETIC'});
    await page.reload();await page.waitForSelector('article[data-message-id]');
    await page.locator('[data-view=\"summaries\"]').click();
    await page.locator('.summary-list-card[data-summary-id=\"'+fixture.summaryId+'\"] .summary-open').click();
    await page.locator('#notion-load-targets').click();
    await page.waitForSelector('#notion-target');await page.locator('#notion-target').selectOption(fixture.targetId);
    await page.locator('#notion-preview').click();await page.waitForSelector('#notion-edit-body');
    await page.locator('#notion-edit-title').fill('午后讨论 · 示例回顾');
    await page.locator('#notion-edit-body').fill('今天的收获\n\n1. 按时间与成员筛选，读清一段完整的对话。\n2. 收藏有价值的观点，并记录自己的理解。\n3. 为摘要保留引用，随时回到原文核对。\n\n下一步\n将值得继续讨论的问题带到明天的交流中。\n\n以上均为软件界面展示用的示例数据。');
    assert.equal(await page.locator('#notion-consent').count(),0);
    assert.equal(await page.locator('#notion-confirm-export').isEnabled(),true);
    await page.locator('#notion-include-references').check();
    // Use the textarea's normal resize handle, as a user can, so the optional
    // original-reference checkbox stays visible beside the one submit action.
    // No CSS/DOM layout override or production rendering change is involved.
    const editorBox=await page.locator('#notion-edit-body').boundingBox();
    await page.mouse.move(editorBox.x+editorBox.width-4,editorBox.y+editorBox.height-4);
    await page.mouse.down();
    await page.mouse.move(editorBox.x+editorBox.width-4,editorBox.y+editorBox.height-150,{steps:12});
    await page.mouse.up();
    await settle();
    const previewLayout=await page.evaluate(()=>{
      const body=document.querySelector('#modal .modal-body').getBoundingClientRect();
      return ['#notion-export-target','#notion-edit-title','#notion-edit-body','#notion-include-references'].map(selector=>{
        const r=document.querySelector(selector).getBoundingClientRect();
        return {selector,top:r.top,bottom:r.bottom,containerTop:body.top,containerBottom:body.bottom,visible:r.top>=body.top-1&&r.bottom<=body.bottom+1};
      });
    });
    result.notionPreviewLayout=previewLayout;assert.ok(previewLayout.every(item=>item.visible),'PREVIEW_CONTROLS_NOT_ALL_VISIBLE');
    assert.equal(await page.locator('#notion-confirm-export').isVisible(),true);
    await capture('notion-weibo-sample.png');
    await page.locator('#modal-close').click();
    result.network=await application.evaluate(()=>globalThis.__releaseScreenshots);
    assert.equal(result.network.notionSearches,1);assert.equal(result.network.notionWrites,0);assert.equal(result.network.nativeDialogs,0);
    assert.deepEqual(result.network.blocked,[]);assert.deepEqual(requests,[]);assert.deepEqual(errors,[]);
    const final=store.get(fixture.accountId);
    assert.deepEqual(final.messages,storedBefore.messages);assert.deepEqual(final.summaries,storedBefore.summaries);assert.deepEqual(final.bookmarks,storedBefore.bookmarks);
    for(const group of fixture.groups){
      assert.equal(final.readStates[group.id].readThroughId,storedBefore.readStates[group.id].readThroughId);
      assert.deepEqual(final.readStates[group.id].unreadIds,storedBefore.readStates[group.id].unreadIds);
    }
    check('Notion preview shows edited synthetic body and one submit button; cancel issues zero writes and preserves source records');
  }catch(error){failure=error;result.failure={stage,message:error.message,stack:error.stack};console.error('FAIL '+stage+': '+error.message);}
  finally{
    if(application){await application.close().catch(error=>{failure||=error;result.closeError=error.message;});application=null;}
    for(let i=0;i<100&&result.exitCode===undefined;i++)await new Promise(resolve=>setTimeout(resolve,50));
    try{
      assert.deepEqual(manifest(path.join(root,'app')),sourceBefore);
      assert.deepEqual(manifest(packaged?path.dirname(appRoot):appRoot),resourceBefore);
      assert.equal(hash(executablePath),exeBefore);assert.equal(result.exitCode,0);
      result.sourceUnchanged=true;result.resourcesUnchanged=true;result.executableSha256=exeBefore;result.sourceFiles=sourceBefore;
    }catch(error){failure||=error;result.integrityError=error.message;}
    result.passed=!failure;result.completedAt=new Date().toISOString();
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify({passed:result.passed,version,output,checks:checks.length,screenshots:shots.map(s=>s.name),failure:result.failure}));
    if(failure)process.exitCode=1;
  }
})();
