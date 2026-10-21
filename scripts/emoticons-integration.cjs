'use strict';
// Source mode copies the app and supplies only bounded local test controls.
// --exe mode launches the delivered executable in place with fresh import data,
// without a boot shim or packaged-file mutation. No real account or service is used.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {assertWindowsRuntimeReadable}=require('./windows-runtime-check.cjs');
const root=path.resolve(__dirname,'..'),args=process.argv.slice(2);
const exeArg=args.find(x=>x.startsWith('--exe='))?.slice(6)||(args.includes('--exe')?args[args.indexOf('--exe')+1]:null);
const packaged=!!exeArg,harness=fs.mkdtempSync(path.join(os.tmpdir(),'weiyue-emoticons-'));
const evidence=path.resolve(process.env.WEIYUE_EMOTICONS_OUTPUT||path.join(root,'artifacts','emoticons-integration-'+new Date().toISOString().replace(/[:.]/g,'-')));
const dataDir=path.join(harness,'data');fs.mkdirSync(evidence,{recursive:true});fs.mkdirSync(dataDir);
let appRoot,executablePath;
if(packaged){executablePath=path.resolve(exeArg);appRoot=path.join(path.dirname(executablePath),'resources/app/app');}
else{
  fs.cpSync(path.join(root,'vendor/runtime'),path.join(harness,'runtime'),{recursive:true});
  fs.cpSync(path.join(root,'app'),path.join(harness,'app'),{recursive:true});
  appRoot=path.join(harness,'app');executablePath=path.join(harness,'runtime/electron.exe');
}
const expectedVersion=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version,version=JSON.parse(fs.readFileSync(packaged?path.join(appRoot,'../package.json'):path.join(root,'package.json'),'utf8')).version;
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function manifest(base){
  const files={};
  for(const file of fs.readdirSync(base,{recursive:true})){
    const full=path.join(base,file),stat=fs.lstatSync(full);
    assert.equal(stat.isSymbolicLink(),false,'TEST_RESOURCE_SYMLINK');
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
  const keys=JSON.parse(sorted.stdout);
  assert.ok(Array.isArray(keys)&&keys.length===Object.keys(files).length&&new Set(keys).size===keys.length&&keys.every(key=>Object.hasOwn(files,key)));
  return crypto.createHash('sha256').update(keys.map(key=>key+'\t'+files[key].toLowerCase()).join('\n'),'utf8').digest('hex');
}
const resourcesBefore=manifest(packaged?path.dirname(appRoot):appRoot),exeBefore=hash(executablePath);
const originalSource=manifest(path.join(root,'app'));
fs.writeFileSync(path.join(evidence,'resources-before.json'),JSON.stringify(resourcesBefore,null,2));
const officialManifest=require(path.join(appRoot,'renderer/emoticon-manifest.js'));
const catalog=Object.entries(officialManifest).map(([name,descriptor])=>({name,...descriptor}));
assert.ok(catalog.length>=3,'BUNDLED_EMOTICON_CATALOG_EMPTY');
const catalogTokens=catalog.flatMap(item=>['['+item.name+']','【'+item.name+'】']);
// Equal-length tokens can have very different fallback widths. Prefer fullwidth
// and CJK glyphs so the real 404 case exercises the most demanding long token.
const tokenDisplayWeight=token=>Array.from(token).reduce((sum,char)=>sum+(char.codePointAt(0)>255?2:1),0);
const longestCatalogToken=catalogTokens.reduce((current,token)=>
  token.length>current.length||(token.length===current.length&&tokenDisplayWeight(token)>tokenDisplayWeight(current))?token:current,'');
const catalogTexts=Array.from({length:Math.ceil(catalogTokens.length/24)},(_,index)=>
  '完整本地表情目录 '+index+'\n'+catalogTokens.slice(index*24,(index+1)*24).join(' '));
const {Store}=require(path.join(appRoot,'core/store.cjs'));
const store=new Store(path.join(dataDir,'accounts'));
const fixtures={accountId:'import-emoticons-114',groups:[
  {key:'A',id:'9007199254742400001',name:'表情长列表合成群',count:260,anchor:30,through:200},
  {key:'B',id:'9007199254742400002',name:'跨群表情合成群',count:40,anchor:10,through:15}
]};
const names=['同名成员','同名成员','林岚','周舟'],base=Date.parse('2026-10-20T00:00:00Z');
const raw={
  mixed:'复制验收 EMO-114 第一行[二哈]中间【笑cry】末尾[哈哈]\n第二行【二哈】[笑cry]【哈哈】链接 https://example.com/a[哈哈]?q=【二哈】 完毕',
  link:'链接前[二哈] https://example.com/a[哈哈]?q=【二哈】 链接后【笑cry】',
  unknown:'未知[并不存在的表情]【未知表情】[]【】应完整保留；javascript:alert(1) <img src=x onerror=alert(1)>',
  repeated:'重复[二哈][二哈]【二哈】[笑cry]【笑cry】[哈哈]【哈哈】[二哈]【哈哈】',
  failure:'失败回退 [二哈] / 【二哈】 后续文字',
  shared:'原微博合成正文[哈哈]【笑cry】与原文链接 https://example.com/post'
};
raw.unknown='未知[微阅QA115未收录代码]【QA115未知表情】[]【】普通括号保持原文 javascript:alert(1) <img src=x onerror=alert(1)>';
assert.ok(!Object.hasOwn(officialManifest,'微阅QA115未收录代码')&&!Object.hasOwn(officialManifest,'QA115未知表情'),'UNKNOWN_FIXTURE_BECAME_KNOWN');
const group=key=>fixtures.groups.find(g=>g.key===key);
fixtures.groups.push({key:'C',id:'9007199254742400003',name:'全部官方表情合成目录',
  count:catalogTexts.length,anchor:0,through:0});
const messages=fixtures.groups.flatMap((g,gi)=>{
  g.ids=Array.from({length:g.count},(_,i)=>String(9007199254742500000n+BigInt(gi*10000+i)));
  return g.ids.map((id,i)=>({
    id,groupId:g.id,senderId:String(71+i%4),senderName:names[i%4],
    time:base+i*60000+([99,120].includes(i)?59999:0),mediaVersion:1,attachmentVersion:1,
    text:g.key==='C'?catalogTexts[i]:g.key==='A'&&i>=30&&i<=34?[raw.mixed,raw.link,raw.unknown,raw.repeated,raw.failure][i-30]:
      g.key==='A'&&i===200?'A 合成记录 200 [二哈]【哈哈】[笑cry]【笑cry】':`${g.key} 合成记录 ${i} [二哈]【哈哈】`,
    ...(g.key==='A'&&i===35?{sharedPost:{state:'ready',text:raw.shared,images:[],author:'合成作者',url:'https://weibo.com/71/SyntheticPost'}}:{})
  }));
});
store.ensureAccount({id:fixtures.accountId,name:'完全合成的内联表情验收账号',kind:'import'});
store.mergeMessages(fixtures.accountId,fixtures.groups.map(({id,name})=>({id,name,selected:true})),messages,{history:true});
store.update(fixtures.accountId,state=>{
  state.settings.autoSyncEnabled=false;
  for(const [i,g]of fixtures.groups.entries()){
    state.readPositions[g.id]=g.ids[g.anchor];
    state.readStates[g.id]={anchorId:g.ids[g.anchor],anchorOffset:0,atBottom:false,readThroughId:g.ids[g.through],
      unreadIds:g.ids.slice(g.through+1),updatedAt:3000-i*1000};
  }
});
fs.writeFileSync(path.join(dataDir,'preferences.json'),JSON.stringify({activeId:fixtures.accountId}));
function boot(options){
  const {app,net,session,protocol,ipcMain,dialog}=require('electron'),path=require('node:path');
  let release;
  const info=globalThis.__emoticonTest={blocked:[],readCalls:[],calls:[],assetRequests:[],assetDecisions:[],failedAssets:[],holdAssets:options.holdAssets,failAsset:options.failAsset||null,failAssets:options.failAssets||(options.failAsset?[options.failAsset]:[]),exports:[],
    releaseAssets(){this.holdAssets=false;release?.();},held:new Promise(resolve=>{release=resolve;})};
  const originalHandle=protocol.handle.bind(protocol);
  protocol.handle=(scheme,handler)=>originalHandle(scheme,async request=>{
    const url=new URL(request.url);
    if(scheme==='app'&&url.hostname==='local'&&url.pathname.startsWith('/emoticons/')){
      info.assetRequests.push(url.href);
      if(info.holdAssets)await info.held;
      info.assetDecisions.push({source:url.href,failAsset:info.failAsset,matched:info.failAssets.includes(url.href)});
      if(info.failAssets.includes(url.href)){info.failedAssets.push({source:url.href,status:404});return new Response('Synthetic missing local asset',{status:404});}
    }
    return handler(request);
  });
  const handle=ipcMain.handle.bind(ipcMain);
  ipcMain.handle=(channel,handler)=>handle(channel,async(event,action,payload={})=>{
    if(channel==='weiyue:call'){
      info.calls.push(action);
      if(action==='read.set')info.readCalls.push({...payload});
      if(/^summary\.ai|^notion\./.test(action))throw Error('EXTERNAL_FEATURE_NOT_ALLOWED_IN_TEST');
    }
    return handler(event,action,payload);
  });
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
  // Source harness only: replace the native save-path picker, not export logic.
  dialog.showSaveDialog=async(...args)=>{
    const settings=args.at(-1),extension=String(settings.defaultPath||'').endsWith('.json')?'json':'md';
    const filePath=path.join(options.evidence,'bookmarks-'+info.exports.length+'.'+extension);
    info.exports.push({filePath,extension});return {canceled:false,filePath};
  };
  require('./app/main.cjs');
}
if(!packaged)fs.writeFileSync(path.join(harness,'package.json'),JSON.stringify({...JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')),main:'boot.cjs'}));
let application,page,stage='prepare',failure=null,activeDataDir=dataDir;
const checks=[],errors=[],launches=[],samples=[],copyRecords=[],runs=[],httpRequests=[];
const result={passed:false,version,expectedVersion,mode:packaged?'final-executable':'source-harness',executablePath,harness,dataDir,checks,launches,samples,copyRecords,errors,httpRequests};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,timeout=12000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await pause(100);}throw Error(label);}
const api=(action,payload={})=>page.evaluate(({action,payload})=>window.api.call(action,payload),{action,payload});
const card=index=>page.locator('article[data-message-id="'+group('A').ids[index]+'"]');
const check=text=>{checks.push(text);console.log('PASS '+text);};
async function launch({dataDirectory=dataDir,failAsset=null,failAssets=null,holdAssets=true}={}){
  activeDataDir=dataDirectory;
  if(!packaged)fs.writeFileSync(path.join(harness,'boot.cjs'),'('+boot.toString()+')('+JSON.stringify({holdAssets,failAsset,failAssets,evidence})+');');
  const preflight=assertWindowsRuntimeReadable(executablePath),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  application=await _electron.launch({executablePath,args:[...(!packaged?[harness]:[]),'--data-dir='+activeDataDir],
    cwd:packaged?path.dirname(executablePath):harness,env,timeout:45000});
  const native=application.process(),record={pid:native.pid,preflight,dataDir:activeDataDir};launches.push(record);
  native.once('exit',(exitCode,signal)=>Object.assign(record,{exitCode,signal}));
  native.stderr?.on('data',bytes=>fs.appendFileSync(path.join(evidence,'native.stderr.log'),bytes));
  page=await application.firstWindow();page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(/^https?:/i.test(r.url()))httpRequests.push({origin:new URL(r.url()).origin,type:r.resourceType()});});
  record.security=await application.evaluate(({BrowserWindow,app})=>{
    const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()==='app://local/index.html')||BrowserWindow.getAllWindows()[0];
    w.setSize(1440,930);w.show();w.focus();w.webContents.focus();
    const p=w.webContents.getLastWebPreferences();
    return {packaged:app.isPackaged,version:app.getVersion(),appPath:app.getAppPath(),executable:process.execPath,
      sandbox:p.sandbox,contextIsolation:p.contextIsolation,nodeIntegration:p.nodeIntegration,webSecurity:p.webSecurity};
  });
  assert.ok(record.security.sandbox&&record.security.contextIsolation&&!record.security.nodeIntegration&&record.security.webSecurity,'APP_ISOLATION');
  assert.equal(record.security.version,expectedVersion,'RUNTIME_APPLICATION_VERSION');
  if(packaged){
    assert.equal(record.security.packaged,true);assert.equal(record.security.version,version);
    assert.equal(path.resolve(record.security.executable).toLowerCase(),executablePath.toLowerCase());
    assert.equal(path.resolve(record.security.appPath).toLowerCase(),path.dirname(appRoot).toLowerCase());
  }
  await page.waitForSelector('article[data-message-id]');await pause(500);
  const state=await api('state');
  assert.equal(state.account.id,fixtures.accountId);assert.equal(state.account.kind,'import');
  assert.equal(path.resolve(state.dataRoot),activeDataDir);assert.equal(state.sessionReady,false);
  assert.equal(state.credentials.ai,false);assert.equal(state.credentials.notion,false);
  assert.equal((await api('sync.status')).enabled,false);
}
async function close(){
  if(!application)return;
  if(!packaged){
    await application.evaluate(()=>globalThis.__emoticonTest.releaseAssets());
    runs.push(await application.evaluate(()=>{const i=globalThis.__emoticonTest;return {blocked:i.blocked,readCalls:i.readCalls,calls:i.calls,assetRequests:i.assetRequests,assetDecisions:i.assetDecisions,failedAssets:i.failedAssets,exports:i.exports};}));
  }
  await application.close();application=null;
  await until(()=>launches.at(-1).exitCode!==undefined,'PROCESS_DID_NOT_EXIT',10000);
}
async function snapshot(){
  const value=await page.evaluate(async()=>{
    const state=await window.api.call('state'),groupId=document.querySelector('#group-list .active')?.dataset.groupId;
    const scroll=document.getElementById('message-scroll'),bounds=scroll.getBoundingClientRect(),r=state.readStates[groupId];
    const articles=[...scroll.querySelectorAll('[data-message-id]')],first=articles.find(el=>el.getBoundingClientRect().bottom>bounds.top+1);
    const badge=document.querySelector('#group-list .active .unread-badge');
    return {groupId,anchorId:r.anchorId,readThroughId:r.readThroughId,unread:r.unreadCount,firstId:first?.dataset.messageId,
      offset:first?first.getBoundingClientRect().top-bounds.top:null,loadedIds:articles.map(el=>el.dataset.messageId),
      visibleIds:articles.filter(el=>{const b=el.getBoundingClientRect();return b.bottom>bounds.top+1&&b.top<bounds.bottom;}).map(el=>el.dataset.messageId),
      labels:{left:badge?.getAttribute('aria-label'),hidden:badge?.hidden,right:document.getElementById('new-messages-count').textContent.trim()}};
  });
  const count=new Store(path.join(activeDataDir,'accounts')).getReadStats(fixtures.accountId,value.groupId).unreadCount;
  assert.equal(value.unread,count);assert.equal(value.labels.left,count+' 条未读');
  assert.equal(value.labels.right,count+' 条未读');assert.equal(value.labels.hidden,count===0);return value;
}
function sameRead(a,b){assert.equal(a.readThroughId,b.readThroughId,'PASSIVE_HIGH_WATER_CHANGED');assert.equal(a.unread,b.unread,'PASSIVE_UNREAD_CHANGED');}
function sameAnchor(a,b){assert.equal(a.firstId,b.firstId,'PASSIVE_ANCHOR_CHANGED');assert.ok(Math.abs(a.offset-b.offset)<=2,'PASSIVE_ANCHOR_OFFSET_CHANGED');}
async function geometry(){
  return card(30).locator('.inline-emoticon').evaluateAll(elements=>elements.map(el=>{
    const b=el.getBoundingClientRect(),img=el.querySelector('img.emoticon-image');
    const fallback=el.querySelector('.emoticon-fallback'),style=img&&getComputedStyle(img),imageBounds=img?.getBoundingClientRect();
    return {token:el.dataset.originalToken,width:b.width,height:b.height,image:!!img,loaded:!!img?.complete&&img.naturalWidth>0,src:img?.getAttribute('src'),
      messageHeight:el.closest('article').getBoundingClientRect().height,textHeight:el.closest('.message-text').getBoundingClientRect().height,
      state:el.dataset.emoticonState,imageVisible:!!img&&!img.hidden&&style.display!=='none'&&style.visibility==='visible',
      fallbackHidden:fallback?.hidden,imageWidth:imageBounds?.width,imageHeight:imageBounds?.height};
  }));
}
async function measureFallbackWidths(tokens=['[二哈]','【二哈】','[笑cry]','【笑cry】','[哈哈]','【哈哈】']){
  const rows=await page.evaluate(async tokens=>{
    await document.fonts.ready;
    const formatter=window.WeiyueEmoticons.create({manifest:window.WeiyueEmoticonManifest,links:window.WeiyueLinks}),
      host=document.createElement('div');
    host.className='message-text';
    host.style.cssText='position:fixed;left:20px;top:20px;width:500px;pointer-events:none;opacity:0';
    const slots=tokens.map(token=>{
      const detached=document.createElement('span');formatter.appendText(detached,token,()=>{});
      const slot=detached.querySelector('.inline-emoticon');if(!slot)throw Error('FALLBACK_TOKEN_NOT_IN_REAL_MANIFEST');
      slot.dataset.emoticonState='failed';
      // Remove image nodes before attaching the synthetic measurement DOM.
      // Only actual packaged CSS and literal fallback text participate.
      for(const image of slot.querySelectorAll('img'))image.remove();
      const text=slot.querySelector('.emoticon-fallback');text.hidden=false;text.textContent=token;
      host.append(slot,document.createTextNode('  '));return slot;
    });
    document.body.append(host);
    try{return slots.map(slot=>{
      const text=slot.querySelector('.emoticon-fallback'),range=document.createRange();range.selectNodeContents(text);
      const box=slot.getBoundingClientRect(),content=range.getBoundingClientRect();
      return {token:slot.dataset.originalToken,width:box.width,height:box.height,textWidth:content.width,textHeight:content.height,
        fontSize:getComputedStyle(text).fontSize,overflow:getComputedStyle(slot).overflow,
        clipLeft:Math.max(0,box.left-content.left),clipRight:Math.max(0,content.right-box.right),
        clipTop:Math.max(0,box.top-content.top),clipBottom:Math.max(0,content.bottom-box.bottom),
        fits:content.left>=box.left-.01&&content.right<=box.right+.01&&content.top>=box.top-.01&&content.bottom<=box.bottom+.01};
    });}finally{host.remove();}
  },tokens);
  assert.deepEqual(rows.map(row=>row.token),tokens,'FALLBACK_MEASUREMENT_MISSED_TOKEN');
  if(rows.some(row=>row.width!==32||row.height!==24||!row.textWidth||!row.textHeight||!row.fits))
    result.fallbackFailure=rows.filter(row=>row.width!==32||row.height!==24||!row.textWidth||!row.textHeight||!row.fits);
  assert.ok(rows.every(row=>row.width===32&&row.height===24&&row.textWidth>0&&row.textHeight>0&&row.fits),'FALLBACK_LITERAL_TEXT_IS_CLIPPED');
  return rows;
}
async function copyText(index,expected,{startNode=null,startOffset=0,endNode=null,endOffset=0}={}){
  const selector='article[data-message-id="'+group('A').ids[index]+'"] .message-text';
  await page.evaluate(({selector,startNode,startOffset,endNode,endOffset})=>{
    const host=document.querySelector(selector),range=document.createRange();
    const textNodes=[];const walk=document.createTreeWalker(host,NodeFilter.SHOW_TEXT);while(walk.nextNode())textNodes.push(walk.currentNode);
    if(startNode===null)range.selectNodeContents(host);
    else{range.setStart(textNodes[startNode],startOffset);range.setEnd(textNodes[endNode],endOffset);}
    const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
    globalThis.__emoticonCopyObservation=null;
    document.addEventListener('copy',event=>{
      globalThis.__emoticonCopyObservation={trusted:event.isTrusted,prevented:event.defaultPrevented,text:event.clipboardData?.getData('text/plain')};
    },{once:true});
  },{selector,startNode,startOffset,endNode,endOffset});
  await page.keyboard.press('Control+C');await pause(100);
  const observed=await page.evaluate(()=>globalThis.__emoticonCopyObservation);
  assert.ok(observed?.trusted&&observed.prevented,'COPY_NOT_HANDLED_AS_TRUSTED_SELECTION');
  assert.equal(observed.text,expected,'COPY_EVENT_LOST_OR_CHANGED_ORIGINAL_TEXT');
  // Only after observing the exact expected test text in the trusted copy event
  // do we read the clipboard that this test just wrote. No prior clipboard read.
  const copied=await application.evaluate(({clipboard})=>clipboard.readText());
  // A failed system clipboard write must not echo a previous clipboard value.
  assert.ok(copied.replace(/\r\n/g,'\n')===expected,'NATIVE_CLIPBOARD_CHANGED_SELECTION');
  copyRecords.push({index,characters:expected.length,trusted:true,expectedHash:crypto.createHash('sha256').update(expected).digest('hex')});
  await page.evaluate(()=>getSelection().removeAllRanges());
}
async function jump(){
  const before=await snapshot();await page.locator('#jump-latest-read').click();
  await until(()=>snapshot().then(s=>s.firstId===before.readThroughId&&Math.abs(s.offset)<=2),'LATEST_READ_TARGET');
  await pause(600);const after=await snapshot();sameRead(after,before);samples.push({stage,before,after});return after;
}
async function switchGroup(key){
  await page.locator('[data-group-id="'+group(key).id+'"]').click();
  await until(()=>page.locator('#group-list .active').getAttribute('data-group-id').then(id=>id===group(key).id),'GROUP_SWITCH');
  await pause(650);return snapshot();
}
async function verifyCompleteCatalog(){
  const before=await switchGroup('C'),host=page.locator('#message-scroll');
  await until(()=>host.locator('.inline-emoticon').evaluateAll((tokens,expected)=>
    tokens.length===expected&&tokens.every(token=>{
      const image=token.querySelector('img.emoticon-image');
      return token.dataset.emoticonState==='ready'&&image?.complete&&image.naturalWidth>0&&!image.hidden;
    }),catalogTokens.length),'FULL_CATALOG_DID_NOT_RENDER',30000);
  const rendered=await host.locator('.inline-emoticon').evaluateAll(tokens=>tokens.map(token=>{
    const image=token.querySelector('img.emoticon-image'),b=token.getBoundingClientRect(),i=image.getBoundingClientRect();
    return {token:token.dataset.originalToken,source:image.getAttribute('src'),alt:image.alt,title:image.title,
      width:b.width,height:b.height,imageWidth:i.width,imageHeight:i.height,naturalWidth:image.naturalWidth,naturalHeight:image.naturalHeight};
  }));
  assert.deepEqual(rendered.map(row=>row.token),catalogTokens,'FULL_CATALOG_TOKEN_ORDER_OR_COVERAGE');
  for(const row of rendered){
    const descriptor=officialManifest[row.token.slice(1,-1)];
    assert.equal(row.source,descriptor.src,'CATALOG_MAPPING_MISMATCH');
    assert.equal(row.alt,row.token);assert.equal(row.title,row.token);
    assert.equal(row.width,32);assert.equal(row.height,24);assert.equal(row.imageWidth,24);assert.equal(row.imageHeight,24);
    if(descriptor.width)assert.equal(row.naturalWidth,descriptor.width);
    if(descriptor.height)assert.equal(row.naturalHeight,descriptor.height);
  }
  result.catalogFallbackWidths=await measureFallbackWidths(catalogTokens);
  const unique=[...new Map(catalog.map(item=>[item.src,item])).values()];
  const responses=await application.evaluate(async({net},sources)=>{
    const results=new Array(sources.length);let cursor=0;
    await Promise.all(Array.from({length:Math.min(8,sources.length)},async()=>{
      while(cursor<sources.length){
        const index=cursor++,source=sources[index],response=await net.fetch(source),bytes=await response.arrayBuffer();
        results[index]={src:source,status:response.status,mime:response.headers.get('content-type'),
          nosniff:response.headers.get('x-content-type-options'),cacheControl:response.headers.get('cache-control'),
          bytes:bytes.byteLength,bodyBase64:Buffer.from(bytes).toString('base64')};
      }
    }));
    return results;
  },unique.map(item=>item.src));
  for(const response of responses){
    response.sha256=crypto.createHash('sha256').update(Buffer.from(response.bodyBase64,'base64')).digest('hex');
    delete response.bodyBase64;
  }
  for(const [index,response]of responses.entries()){
    const descriptor=unique[index],extension=path.extname(new URL(descriptor.src).pathname).slice(1);
    assert.equal(response.status,200);assert.equal(response.mime,{png:'image/png',gif:'image/gif',webp:'image/webp'}[extension]);
    assert.equal(response.nosniff,'nosniff');assert.match(response.cacheControl,/immutable/);
    assert.equal(response.sha256,descriptor.sha256,'CATALOG_PROTOCOL_HASH_MISMATCH');
    if(descriptor.bytes)assert.equal(response.bytes,descriptor.bytes);
    const file=path.join(appRoot,'renderer/emoticons',path.basename(new URL(descriptor.src).pathname));
    assert.equal(hash(file),descriptor.sha256,'CATALOG_PACKAGED_ASSET_HASH_MISMATCH');
  }
  const counts=key=>Object.fromEntries([...new Set(catalog.map(item=>String(item[key]||'unspecified')))].map(value=>[value,catalog.filter(item=>String(item[key]||'unspecified')===value).length]));
  const metadataFile=path.join(appRoot,'renderer/emoticons/catalog-source.json'),
    catalogManifestFile=path.join(appRoot,'renderer/emoticons/catalog-manifest.json'),
    catalogManifest=JSON.parse(fs.readFileSync(catalogManifestFile,'utf8'));
  assert.equal(catalogManifest.mappingCount,catalog.length);
  assert.equal(catalogManifest.uniqueResourceCount,unique.length);
  assert.equal(catalogManifest.source.sha256,hash(metadataFile),'CATALOG_SOURCE_SNAPSHOT_HASH');
  assert.equal(catalogManifest.entries.length,catalog.length);
  for(const entry of catalogManifest.entries){
    assert.equal(officialManifest[entry.name]?.src,entry.src,'CATALOG_PROVENANCE_MAPPING_MISMATCH');
    assert.equal(officialManifest[entry.name]?.sha256,entry.sha256,'CATALOG_PROVENANCE_HASH_MISMATCH');
  }
  result.catalogCoverage={mappingCount:catalog.length,uniqueResourceCount:unique.length,
    loadedMappings:new Set(rendered.map(row=>row.token.slice(1,-1))).size,failedMappings:0,
    metadataSha256:hash(metadataFile),manifestSha256:hash(catalogManifestFile),
    mappingSha256:hash(path.join(appRoot,'renderer/emoticon-manifest.js')),
    renderedTokens:rendered.length,allMappingsLoaded:false,categoryCounts:counts('group'),formatCounts:counts('format'),
    officialAnimatedGifCount:catalog.filter(item=>item.animated===true&&item.format==='gif').length,
    localProtocolResponses:responses,protocolFetchContext:'electron-main; renderer CSP unchanged',
    longestToken:longestCatalogToken,
    longestTokenFits:result.catalogFallbackWidths.every(row=>row.fits)};
  assert.equal(catalog.length,308,'OFFICIAL_CATALOG_MAPPING_COUNT');
  assert.equal(unique.length,307,'OFFICIAL_CATALOG_RESOURCE_COUNT');
  assert.ok(Object.keys(result.catalogCoverage.categoryCounts).length>1,'OFFICIAL_CATALOG_CATEGORY_COVERAGE');
  assert.equal(result.catalogCoverage.loadedMappings,catalog.length);
  assert.equal(result.catalogCoverage.officialAnimatedGifCount,0,'OFFICIAL_GIF_COVERAGE_CHANGED_REQUIRES_REVIEW');
  sameRead(await snapshot(),before);sameAnchor(await snapshot(),before);
  await page.screenshot({path:path.join(evidence,'synthetic-complete-official-catalog.png')});
  const back=await switchGroup('A');
  result.catalogCoverage.allMappingsLoaded=true;
  return back;
}
(async()=>{
  try{
    assert.equal(version,expectedVersion,'EXPECTED_APPLICATION_VERSION');
    stage='launch';await launch();const initial=await snapshot();
    assert.equal(initial.firstId,group('A').ids[30]);assert.equal(initial.readThroughId,group('A').ids[200]);assert.equal(initial.unread,59);
    const beforeGeometry=await geometry();
    result.fallbackWidths={initial:await measureFallbackWidths()};
    assert.equal(beforeGeometry.length,6,'KNOWN_AND_FULLWIDTH_TOKEN_COUNT');
    assert.ok(beforeGeometry.every(item=>item.width>=12&&item.width<=40&&item.height>=12&&item.height<=40),'INLINE_SIZE_NOT_BOUNDED');
    if(!packaged){
      assert.ok(beforeGeometry.every(item=>!item.loaded),'HOLD_DID_NOT_DELAY_ASSETS');
      await pause(1400);sameRead(await snapshot(),initial);sameAnchor(await snapshot(),initial);
      await application.evaluate(()=>globalThis.__emoticonTest.releaseAssets());
    }
    await until(()=>card(30).locator('img.emoticon-image').evaluateAll(images=>images.length===6&&images.every(img=>img.complete&&img.naturalWidth>0)),'LOCAL_ASSETS_NOT_RENDERED');
    const afterGeometry=await geometry();
    assert.ok(afterGeometry.every(item=>item.state==='ready'&&item.imageVisible&&item.fallbackHidden),'LOADED_ICON_NOT_VISIBLE');
    assert.ok(afterGeometry.every(item=>Math.abs(item.width-32)<0.1&&Math.abs(item.height-24)<0.1&&Math.abs(item.imageWidth-24)<0.1&&Math.abs(item.imageHeight-24)<0.1),'INLINE_FIXED_PIXEL_SIZE');
    assert.ok(afterGeometry.every(item=>/^app:\/\/local\/emoticons\/[a-zA-Z0-9][a-zA-Z0-9_-]*\.(?:png|gif|webp)$/.test(item.src)),'EMOTICON_SOURCE_NOT_RESTRICTED');
    assert.equal(new Set(afterGeometry.map(item=>item.src)).size,3,'EXPECTED_THREE_DISTINCT_OFFICIAL_ASSETS');
    const expectedSources={'二哈':'app://local/emoticons/erha.png','笑cry':'app://local/emoticons/xiaoku.png','哈哈':'app://local/emoticons/haha.png'};
    for(const item of afterGeometry)assert.equal(item.src,expectedSources[item.token.slice(1,-1)],'EMOTICON_TOKEN_ASSET_MAPPING');
    assert.deepEqual(afterGeometry.map(({token,width,height})=>({token,width,height})),beforeGeometry.map(({token,width,height})=>({token,width,height})),'ICON_LOAD_CHANGED_FIXED_SIZE');
    assert.deepEqual(afterGeometry.map(({messageHeight,textHeight})=>({messageHeight,textHeight})),beforeGeometry.map(({messageHeight,textHeight})=>({messageHeight,textHeight})),'ICON_LOAD_CHANGED_PARENT_LINE_HEIGHT');
    await pause(1000);const afterLoad=await snapshot();sameRead(afterLoad,initial);sameAnchor(afterLoad,initial);
    samples.push({stage:'asset-load',before:initial,after:afterLoad,beforeGeometry,afterGeometry});
    await page.screenshot({path:path.join(evidence,'synthetic-inline-emoticons.png')});
    check('Both bracket forms render the official local icons at bounded fixed size; passive loading preserves viewport, high-water and unread');

    stage='mixed-and-safe-text';
    assert.equal(await card(31).locator('.inline-emoticon').count(),2,'URL_TEXT_WAS_PARSED_AS_EMOTICON');
    const link=card(31).locator('a.message-link');
    assert.equal(await link.count(),1);assert.equal(await link.textContent(),'https://example.com/a[哈哈]?q=【二哈】');
    assert.equal(await link.locator('img').count(),0);assert.equal(await link.getAttribute('rel'),'noopener noreferrer');
    assert.equal(await card(32).locator('.message-text').textContent(),raw.unknown);
    assert.equal(await card(32).locator('.message-text img,.message-text script,.message-text a').count(),0,'UNKNOWN_OR_HTML_BECAME_ACTIVE');
    assert.equal(await card(33).locator('.inline-emoticon').count(),9);
    assert.equal(await card(35).locator('.shared-post-text .inline-emoticon').count(),2);
    assert.ok((await card(30).locator('img.emoticon-image').first().getAttribute('src')).startsWith('app://local/emoticons/'));
    assert.equal(await page.locator('.message-media img').count(),0,'EMOTICONS_BECAME_CHAT_MEDIA');
    check('Repeated, mixed and shared-post text renders safely; unknown tokens and markup remain literal and URL labels remain intact');

    stage='native-copy';await copyText(30,raw.mixed);
    // First line ends immediately before the literal newline text node.
    const partial=await card(30).locator('.message-text').evaluate(host=>{
      const nodes=[],walker=document.createTreeWalker(host,NodeFilter.SHOW_TEXT);while(walker.nextNode())nodes.push(walker.currentNode);
      const end=nodes.findIndex(n=>n.data.includes('\n'));return {end,offset:nodes[end]?.data.indexOf('\n')};
    });
    assert.ok(partial.end>=0);
    await copyText(30,raw.mixed.split('\n')[0],{startNode:0,startOffset:0,endNode:partial.end,endOffset:partial.offset});
    await copyText(31,raw.link);
    sameRead(await snapshot(),initial);sameAnchor(await snapshot(),initial);
    check('Actual Ctrl+C preserves exact original tokens, both bracket forms, links, newlines and partial selected text');

    stage='store-search-bookmark';
    const query=await api('messages.query',{groupId:group('A').id,keyword:'【笑cry】',limit:1000,offset:0});
    assert.ok(query.messages.some(m=>m.id===group('A').ids[30]&&m.text===raw.mixed),'RAW_TOKEN_QUERY_CHANGED');
    await card(30).locator('.message-check').check();await card(31).locator('.message-check').check();
    await page.locator('#bookmark-note').fill('合成收藏：保留[二哈]原文');await page.locator('#bookmark-tags').fill('表情验收, 原文');
    await page.locator('#save-bookmark').click();await pause(400);
    const saved=await api('bookmark.list',{query:'【笑cry】'});
    assert.equal(saved.length,1);assert.deepEqual(saved[0].messages.map(m=>m.text),[raw.mixed,raw.link]);
    if(!packaged){
      await api('export.bookmarks',{query:'【笑cry】',format:'json'});await api('export.bookmarks',{query:'【笑cry】',format:'md'});
      const exported=await application.evaluate(()=>globalThis.__emoticonTest.exports);
      const json=JSON.parse(fs.readFileSync(exported.find(x=>x.extension==='json').filePath,'utf8'));
      assert.deepEqual(json[0].messages.map(m=>m.text),[raw.mixed,raw.link]);
      const md=fs.readFileSync(exported.find(x=>x.extension==='md').filePath,'utf8');
      assert.ok(md.includes(raw.mixed.replace(/\n/g,'\n  '))&&md.includes(raw.link),'MARKDOWN_LOST_ORIGINAL_TOKENS');
      result.exportCoverage='Real main-process JSON/Markdown exporter; source harness supplies only isolated save-dialog paths.';
    }else result.exportCoverage='Final executable raw bookmark/list semantics checked; native save dialog/export remains covered by the separate source-harness run.';
    sameRead(await snapshot(),initial);sameAnchor(await snapshot(),initial);
    check('Token search and multi-message bookmarking retain raw message text; local exporter coverage is recorded explicitly by mode');

    stage='local-summary-scope';
    const range={groupId:group('A').id,start:base+30*60000,end:base+35*60000};
    const preview=await api('summary.preview',range);
    assert.equal(preview.messages.find(m=>m.id===group('A').ids[30]).text,raw.mixed);
    const local=await api('summary.local',range);
    assert.equal(local.refs.find(m=>m.id===group('A').ids[30]).text,raw.mixed);
    const rawSaved=new Store(path.join(dataDir,'accounts')).get(fixtures.accountId).messages;
    assert.ok(rawSaved.every(m=>!m.images?.length&&!m.sharedPost?.images?.length),'DECORATIVE_ICON_PERSISTED_AS_MEDIA');
    const {prepareSummary,prepareAiSummary}=require(path.join(appRoot,'core/summary.cjs'));
    const {prepareSummaryContent}=require(path.join(appRoot,'core/summary-content.cjs'));
    const sourceMessages=rawSaved.filter(m=>m.groupId===range.groupId&&m.time>=range.start&&m.time<range.end);
    const originalMessages=JSON.stringify(sourceMessages);
    const pre=prepareSummary({messages:sourceMessages,group:group('A'),start:range.start,end:range.end});
    let imageReads=0;
    const resolved=await prepareSummaryContent(pre,{messages:sourceMessages,includeImages:true,
      loadImage:async()=>{imageReads++;throw Error('DECORATIVE_IMAGE_MUST_NOT_BE_READ');}});
    // Pure local preparation only. No API key, fetch, or send function is used.
    const ready=prepareAiSummary(pre,{endpoint:'https://emoticon-test.invalid/v1',model:'local-fixture',
      aiVisionMode:'enabled',content:resolved.content});
    assert.equal(imageReads,0);assert.equal(resolved.coverage.postLookups,0);
    for(const key of ['imageCandidates','imageCount','imageBytes'])assert.equal(ready.contentScope[key],0,'DECORATIVE_ICON_EXPANDED_AI_SCOPE');
    assert.equal(ready.contentScope.vision.supported,true);
    assert.ok(ready.chunks.every(chunk=>chunk.images.length===0));
    assert.deepEqual(ready.messages.map(m=>m.text),pre.messages.map(m=>m.text));assert.equal(JSON.stringify(sourceMessages),originalMessages);
    result.localContentScope={imageReads,imageCandidates:ready.contentScope.imageCandidates,imageCount:ready.contentScope.imageCount,
      imageBytes:ready.contentScope.imageBytes,visionEnabledForPureLocalCheck:true,serviceCalled:false};
    sameRead(await snapshot(),initial);
    check('Local summary previews and references preserve original tokens; no decorative icon is stored as a message image or sent to a service');

    stage='complete-official-catalog';
    const catalogReturn=await verifyCompleteCatalog();sameRead(catalogReturn,initial);sameAnchor(catalogReturn,initial);
    const catalogMessages=rawSaved.filter(message=>message.groupId===group('C').id);
    const catalogPreview=prepareSummary({messages:catalogMessages,group:group('C'),start:base,end:base+group('C').count*60000});
    const catalogContent=await prepareSummaryContent(catalogPreview,{messages:catalogMessages,includeImages:true,
      loadImage:async()=>{throw Error('CATALOG_EMOTICON_IS_NOT_SHARED_MEDIA');}});
    const catalogReady=prepareAiSummary(catalogPreview,{endpoint:'https://emoticon-test.invalid/v1',model:'local-fixture',
      aiVisionMode:'enabled',content:catalogContent.content});
    assert.equal(catalogReady.contentScope.imageCandidates,0);
    assert.equal(catalogContent.coverage.imageCount,0);
    assert.equal(catalogContent.coverage.postLookups,0);
    result.catalogCoverage.aiImageCandidates=0;result.catalogCoverage.aiImageCount=0;result.catalogCoverage.serviceCalled=false;
    check(`All ${catalog.length} official mappings render both bracket forms from ${result.catalogCoverage.uniqueResourceCount} verified local assets across every category; MIME, hashes, fallback slots and reading state are preserved`);

    stage='reading-regression';
    if(!await page.locator('#reading-start').isVisible())await page.locator('#filter-toggle').click();
    await page.locator('#reading-start').fill('2026-10-20T09:40');await page.locator('#reading-start').press('Tab');
    await page.locator('#reading-end').fill('2026-10-20T10:00');await page.locator('#reading-end').press('Tab');
    await until(()=>snapshot().then(s=>JSON.stringify(s.loadedIds)===JSON.stringify(group('A').ids.slice(100,121))),'MINUTE_RANGE_CHANGED');
    await page.locator('#member-filter .member-picker-toggle').click();
    await page.locator('#member-filter .member-picker-option input[value="71"]').check();await pause(500);
    await page.locator('#member-filter .member-picker-option input[value="72"]').check();await pause(650);
    const filtered=await snapshot(),expected=group('A').ids.slice(100,121).filter(id=>[0,1].includes(group('A').ids.indexOf(id)%4));
    assert.deepEqual(filtered.loadedIds,expected);sameRead(filtered,initial);
    const high=await jump();assert.equal(high.firstId,group('A').ids[200]);
    assert.equal(await page.locator('#reading-start').inputValue(),'');assert.equal(await page.locator('#reading-end').inputValue(),'');
    assert.equal(await page.locator('#member-filter .member-picker-option input:checked').count(),0);
    await switchGroup('B');const back=await switchGroup('A');sameRead(back,high);sameAnchor(back,high);
    check('Inclusive Beijing end-minute, same-name multi-member OR filtering, latest-read navigation and cross-group anchors remain unchanged');

    if(!packaged){
      stage='failed-local-asset';
      // Resolve one exact source already observed in the real DOM. Failure
      // injection affects only the copied app's protocol handler.
      const source=afterGeometry.find(x=>x.token==='【笑cry】').src;
      assert.ok(typeof source==='string'&&/^app:\/\/local\/emoticons\/[a-zA-Z0-9][a-zA-Z0-9_-]*\.(?:png|gif|webp)$/.test(source),'FAILURE_TARGET_NOT_EXACT_LOCAL_ASSET');
      const before=await snapshot();
      const beforeSlots=await card(200).locator('.inline-emoticon').evaluateAll(elements=>elements.map(el=>{
        const rect=el.getBoundingClientRect();return {token:el.dataset.originalToken,width:rect.width,height:rect.height};
      }));
      const beforeMessageBox=await card(200).evaluate(el=>{
        const text=el.querySelector('.message-text'),r=el.getBoundingClientRect(),t=text.getBoundingClientRect();
        const scroll=document.getElementById('message-scroll').getBoundingClientRect();
        return {cardHeight:r.height,textHeight:t.height,top:r.top-scroll.top,
          slots:[...text.querySelectorAll('.inline-emoticon')].map(e=>({token:e.dataset.originalToken,top:e.getBoundingClientRect().top-t.top,height:e.getBoundingClientRect().height}))};
      });
      await close();
      // Fault injection is a separate group with a new process and empty cache.
      // Copy only this test's synthetic account/preferences, never its runtime
      // cache, credentials, or any existing user profile.
      const faultDataDir=path.join(harness,'fault-data');fs.mkdirSync(faultDataDir);
      fs.cpSync(path.join(dataDir,'accounts'),path.join(faultDataDir,'accounts'),{recursive:true});
      fs.copyFileSync(path.join(dataDir,'preferences.json'),path.join(faultDataDir,'preferences.json'));
      result.faultDataDir=faultDataDir;
      const longestToken=result.catalogCoverage.longestToken,longestSource=officialManifest[longestToken.slice(1,-1)].src;
      await launch({dataDirectory:faultDataDir,failAsset:source,failAssets:[source,longestSource],holdAssets:false});
      await pause(1200);const after=await snapshot();
      const fallback=await page.locator('article[data-message-id="'+group('A').ids[200]+'"] .message-text').evaluate((host,url)=>{
        const clone=host.cloneNode(true);
        for(const token of clone.querySelectorAll('.inline-emoticon'))token.replaceWith(document.createTextNode(token.dataset.originalToken));
        return {literal:host.textContent,original:clone.textContent,
          messageBox:{cardHeight:host.closest('article').getBoundingClientRect().height,textHeight:host.getBoundingClientRect().height,
            top:host.closest('article').getBoundingClientRect().top-document.getElementById('message-scroll').getBoundingClientRect().top,
            slots:[...host.querySelectorAll('.inline-emoticon')].map(e=>({token:e.dataset.originalToken,top:e.getBoundingClientRect().top-host.getBoundingClientRect().top,height:e.getBoundingClientRect().height}))},
          slots:[...host.querySelectorAll('.inline-emoticon')].map(el=>{
            const rect=el.getBoundingClientRect();return {token:el.dataset.originalToken,width:rect.width,height:rect.height};
          }),
          failedImages:[...host.querySelectorAll('img.emoticon-image')].filter(img=>img.getAttribute('src')===url).map(img=>{
            const wrapper=img.closest('.inline-emoticon'),text=wrapper.querySelector('.emoticon-fallback'),style=getComputedStyle(text),rect=text.getBoundingClientRect();
            const range=document.createRange();range.selectNodeContents(text);
            const box=wrapper.getBoundingClientRect(),content=range.getBoundingClientRect();
            return {hidden:img.hidden,complete:img.complete,naturalWidth:img.naturalWidth,state:wrapper.dataset.emoticonState,
              token:wrapper.dataset.originalToken,fallback:text.textContent,fallbackHidden:text.hidden,
              textWidth:content.width,textHeight:content.height,fontSize:style.fontSize,slotWidth:box.width,slotHeight:box.height,
              fits:content.left>=box.left-.01&&content.right<=box.right+.01&&content.top>=box.top-.01&&content.bottom<=box.bottom+.01,
              fallbackVisible:style.display!=='none'&&style.visibility==='visible'&&rect.width>0&&rect.height>0};
          })};
      },source);
      const failureProbe=await application.evaluate(()=>({configured:globalThis.__emoticonTest.failAsset,
        failedAssets:globalThis.__emoticonTest.failedAssets,decisions:globalThis.__emoticonTest.assetDecisions}));
      result.assetFailure={tested:false,source,fallback,before,after,beforeSlots,afterSlots:fallback.slots,beforeMessageBox,afterMessageBox:fallback.messageBox,failureProbe};
      sameRead(after,before);sameAnchor(after,before);
      assert.ok(failureProbe.failedAssets.some(item=>item.source===source&&item.status===404),'FAULT_INJECTION_DID_NOT_RETURN_404');
      assert.equal(fallback.original,messages.find(m=>m.id===group('A').ids[200]).text,'FAILED_ASSET_CHANGED_ORIGINAL_TOKEN');
      assert.ok(fallback.failedImages.length>0,'MISSING_ASSET_FAILURE_WAS_NOT_OBSERVED');
      assert.ok(fallback.failedImages.every(img=>img.state==='failed'&&img.fallbackVisible&&!img.fallbackHidden&&img.fallback===img.token),'FAILED_ASSET_DID_NOT_RESTORE_VISIBLE_LITERAL_TOKEN');
      assert.ok(fallback.failedImages.every(img=>img.hidden&&img.complete&&img.naturalWidth===0),'FAILED_ICON_REMAINS_AS_BROKEN_IMAGE');
      assert.ok(fallback.failedImages.some(img=>img.token==='【笑cry】'),'FULLWIDTH_LONG_TOKEN_FAILURE_NOT_EXERCISED');
      assert.ok(fallback.failedImages.every(img=>img.textWidth>0&&img.textHeight>0&&img.fits),'FAILED_ASSET_LITERAL_TEXT_IS_CLIPPED');
      assert.deepEqual(fallback.slots,beforeSlots,'FAILED_ICON_CHANGED_FIXED_SLOT_GEOMETRY');
      assert.equal(fallback.messageBox.cardHeight,beforeMessageBox.cardHeight,'FAILED_ICON_CHANGED_CARD_HEIGHT');
      assert.equal(fallback.messageBox.textHeight,beforeMessageBox.textHeight,'FAILED_ICON_CHANGED_TEXT_LINE_HEIGHT');
      result.fallbackWidths.failure=await measureFallbackWidths();
      result.assetFailure.tested=true;
      await page.screenshot({path:path.join(evidence,'synthetic-failed-emoticon.png')});
      check('An exact missing local asset falls back to its original token without changing read progress or viewport');
      const catalogBefore=await switchGroup('C');
      await page.waitForFunction(token=>[...document.querySelectorAll('.inline-emoticon')].some(slot=>
        slot.dataset.originalToken===token&&slot.dataset.emoticonState==='failed'),longestToken);
      const longestFallback=await page.evaluate(token=>{
        const slot=[...document.querySelectorAll('.inline-emoticon')].find(slot=>slot.dataset.originalToken===token);
        const image=slot.querySelector('img'),text=slot.querySelector('.emoticon-fallback'),b=slot.getBoundingClientRect();
        const range=document.createRange();range.selectNodeContents(text);const ink=range.getBoundingClientRect();
        return {token,text:text.textContent,state:slot.dataset.emoticonState,width:b.width,height:b.height,
          imageHidden:image.hidden,imageComplete:image.complete,naturalWidth:image.naturalWidth,fallbackHidden:text.hidden,
          textWidth:ink.width,textHeight:ink.height,fontSize:getComputedStyle(text).fontSize,lineHeight:getComputedStyle(text).lineHeight,
          fits:ink.left>=b.left-.01&&ink.right<=b.right+.01&&ink.top>=b.top-.01&&ink.bottom<=b.bottom+.01};
      },longestToken);
      assert.equal(longestFallback.text,longestToken);assert.equal(longestFallback.state,'failed');
      assert.ok(longestFallback.imageHidden&&longestFallback.imageComplete&&longestFallback.naturalWidth===0&&!longestFallback.fallbackHidden);
      assert.equal(longestFallback.width,32);assert.equal(longestFallback.height,24);assert.equal(longestFallback.fits,true,'LONGEST_FAILED_TOKEN_CLIPPED');
      const failedUrls=await application.evaluate(()=>globalThis.__emoticonTest.failedAssets);
      assert.ok(failedUrls.some(item=>item.source===longestSource&&item.status===404));
      sameRead(await snapshot(),catalogBefore);sameAnchor(await snapshot(),catalogBefore);
      result.catalogAssetFailure={tested:true,source:longestSource,status:404,fallback:longestFallback};
      await page.evaluate(token=>{
        [...document.querySelectorAll('.inline-emoticon')].find(slot=>slot.dataset.originalToken===token).scrollIntoView({block:'center'});
      },longestToken);
      await pause(200);sameRead(await snapshot(),catalogBefore);
      result.catalogAssetFailure.screenshotContext='Intentional programmatic viewport move to show the tested fallback; no read intent or high-water change.';
      await page.screenshot({path:path.join(evidence,'synthetic-longest-failed-token.png')});
      const restoredA=await switchGroup('A');sameRead(restoredA,before);sameAnchor(restoredA,before);
      check('The longest official code also survives a real local 404 as complete, unclipped text inside the fixed slot, with no reading-state change');
    }else result.assetFailure={tested:false,covered:false,reason:'No fault injection or packaged-file change is permitted in final-executable mode; separately verified in the copied-source harness.'};

    stage='restart';const beforeRestart=await snapshot();await close();await launch();
    if(!packaged)await application.evaluate(()=>globalThis.__emoticonTest.releaseAssets());
    await pause(700);const restarted=await snapshot();sameRead(restarted,beforeRestart);sameAnchor(restarted,beforeRestart);
    await close();
    const finalState=new Store(path.join(dataDir,'accounts')).get(fixtures.accountId);
    for(const g of fixtures.groups){assert.equal(finalState.readStates[g.id].readThroughId,g.ids[g.through]);assert.deepEqual(finalState.readStates[g.id].unreadIds,g.ids.slice(g.through+1));}
    assert.deepEqual(errors,[]);assert.deepEqual(httpRequests,[]);
    if(!packaged){
      assert.ok(runs.every(r=>!r.blocked.length&&!r.calls.some(action=>/^summary\.ai|^notion\./.test(action))));
      assert.ok(runs.flatMap(r=>r.readCalls).every(call=>!Object.hasOwn(call,'readThroughId')),'PASSIVE_OPERATION_ADVANCED_READ');
    }
    check('Restart restores the same reading anchor; all original high-water IDs and unread sets survive with no AI, Notion or HTTP activity');
    stage='complete';
  }catch(error){failure=String(error.stack||error);}
  finally{
    await close().catch(error=>{failure||='CLOSE_FAILED '+String(error);});
    const after=manifest(packaged?path.dirname(appRoot):appRoot);
    fs.writeFileSync(path.join(evidence,'resources-after.json'),JSON.stringify(after,null,2));
    result.resourcesUnchanged=JSON.stringify(resourcesBefore)===JSON.stringify(after)&&hash(executablePath)===exeBefore;
    result.sourceStillMatches=JSON.stringify(originalSource)===JSON.stringify(manifest(path.join(root,'app')));
    result.nativeExitedCleanly=launches.length===(packaged?2:3)&&launches.every(r=>r.exitCode===0&&r.signal===null);
    result.failure=failure;result.stage=stage;result.runs=runs;result.executableSha256=exeBefore;
    result.resourceFileCount=Object.keys(after).length;
    result.applicationManifestSha256=applicationManifestSha256(after);
    result.scope='Synthetic import data only; live main/preload/store/renderer; clipboard read only after the exact synthetic copy event; no real accounts, credentials, AI or Notion.';
    result.noPackagedFilesReplaced=packaged&&result.resourcesUnchanged;
    result.passed=stage==='complete'&&!failure&&result.resourcesUnchanged&&result.nativeExitedCleanly&&(packaged||result.sourceStillMatches);
    fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify({passed:result.passed,stage,checks:checks.length,report:path.join(evidence,'result.json'),resourcesUnchanged:result.resourcesUnchanged,sourceStillMatches:result.sourceStillMatches}));
    if(!result.passed)process.exitCode=1;
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
