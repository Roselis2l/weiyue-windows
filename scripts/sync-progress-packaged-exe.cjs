'use strict';

// Launch the actual packaged EXE unchanged. No boot shim, IPC replacement,
// credentials, remote URLs, or synchronization clicks are used. Each run owns
// one new synthetic profile; Chromium's native net log observes network use.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {assertWindowsRuntimeReadable}=require('./windows-runtime-check.cjs');
const root=path.resolve(__dirname,'..');
const argument=process.argv.find(value=>value.startsWith('--exe='));
assert(argument,'Usage: node scripts/sync-progress-packaged-exe.cjs --exe=absolute/path/WeiYue.exe');
const executablePath=path.resolve(argument.slice(6)),installRoot=path.dirname(executablePath),packageRoot=path.join(installRoot,'resources','app');
assert.equal(path.basename(executablePath).toLowerCase(),'weiyue.exe');
assert(fs.statSync(executablePath).isFile(),'Packaged EXE must exist before testing');
const packageVersion=JSON.parse(fs.readFileSync(path.join(packageRoot,'package.json'),'utf8')).version;
const evidence=fs.mkdtempSync(path.join(root,'artifacts','sync-progress-exe-'+packageVersion+'-'));
const profileRoot=fs.mkdtempSync(path.join(os.tmpdir(),'weiyue-exe-sync-')),dataDir=path.join(profileRoot,'data');fs.mkdirSync(dataDir);
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const installDataExisted=fs.existsSync(path.join(installRoot,'data'));
function programHashes(){const files=fs.readdirSync(installRoot,{recursive:true}).filter(relative=>!/^data(?:[\\/]|$)/i.test(relative)&&fs.statSync(path.join(installRoot,relative)).isFile());return Object.fromEntries(files.map(relative=>[relative,hash(path.join(installRoot,relative))]));}
const beforeProgramHashes=programHashes();
const fixtures={accountId:'weibo-9007199254740993888',groups:[
  {key:'A',id:'9007199254740998101',name:'示例数据 · 离线补扫',count:640,anchor:30,through:520,phase:'backfill'},
  {key:'B',id:'9007199254740998102',name:'示例数据 · 尚未衔接',count:240,anchor:15,through:100,phase:'unresolved'},
  {key:'C',id:'9007199254740998103',name:'示例数据 · 本轮已衔接',count:90,anchor:10,through:60,phase:'joined'},
]};
const base=Date.parse('2026-10-20T00:00:00Z');
const messages=fixtures.groups.flatMap((g,gi)=>{g.ids=Array.from({length:g.count},(_,i)=>String(9007199254741800000n+BigInt(gi*10000+i)));return g.ids.map((id,i)=>({id,groupId:g.id,senderId:String(7101+i%2),senderName:i%2?'模拟成员乙':'模拟成员甲',time:base+i*60000,text:`${g.key} 合成消息 ${i}。${i>=20&&i<=22?'回看命中':'普通记录'}。仅用于正式 EXE 阅读状态验收。`,mediaVersion:1,attachmentVersion:1}));});
// Use the packaged Store implementation to construct/normalize fixture data.
const {Store}=require(path.join(packageRoot,'app/core/store.cjs'));
const fixtureStore=new Store(path.join(dataDir,'accounts'));
fixtureStore.ensureAccount({id:fixtures.accountId,kind:'weibo',name:'正式 EXE 合成验收账号'});
fixtureStore.mergeMessages(fixtures.accountId,fixtures.groups.map(g=>({id:g.id,name:g.name,selected:true})),messages,{history:true});
fixtureStore.update(fixtures.accountId,state=>{
  state.settings.autoSyncEnabled=false;
  fixtures.groups.forEach((g,index)=>{
    state.readPositions[g.id]=g.ids[g.anchor];state.readStates[g.id]={anchorId:g.ids[g.anchor],anchorOffset:0,atBottom:false,readThroughId:g.ids[g.through],unreadIds:g.ids.slice(g.through+1),updatedAt:3000-index*1000};
    const group=state.groups.find(item=>item.id===g.id);
    const pending={cursor:g.ids[Math.min(g.count-2,200)],baselineId:g.ids[0],arrivalAfterId:g.ids[0],status:g.phase==='unresolved'?'unresolved':'pending'};
    group.latestPendingRanges=g.phase==='joined'?[]:[pending];group.latestPending=g.phase==='joined'?null:{...pending};
    group.syncProgress={phase:g.phase,added:g.phase==='joined'?300:1200+index*60,pages:60+index*3,scannedUntil:base+240*60000,updatedAt:base+720*60000,reason:g.phase==='unresolved'?'接口提前返回边界，尚未与原记录衔接；已保存位置，可手动检查并继续补扫。':''};
  });
});
fs.writeFileSync(path.join(dataDir,'preferences.json'),JSON.stringify({activeId:fixtures.accountId}));
const originalFixture=fixtureStore.get(fixtures.accountId);
assert.equal(originalFixture.settings.autoSyncEnabled,false);
assert.equal(originalFixture.messages.length,messages.length);
assert(originalFixture.groups.every(g=>!g.avatarUrl));
assert(originalFixture.messages.every(m=>!m.senderAvatarUrl&&!m.images?.length&&!m.attachments?.length&&!m.sharedPost));
const expectedRead=Object.fromEntries(fixtures.groups.map(g=>[g.id,{readThroughId:g.ids[g.through],unreadCount:g.count-g.through-1}]));

let application,page,failure;const checks=[],errors=[],samples=[],launches=[],rendererHttpRequests=[];
const check=label=>{checks.push(label);console.log('PASS '+label);};
async function api(action,payload={}){return page.evaluate(({action,payload})=>window.api.call(action,payload),{action,payload});}
function assertRead(state){for(const g of fixtures.groups){assert.equal(state.readStates[g.id].readThroughId,expectedRead[g.id].readThroughId,'High-water changed for '+g.key);assert.equal(state.readStates[g.id].unreadCount,expectedRead[g.id].unreadCount,'Unread changed for '+g.key);}}
async function sample(stage){const value=await page.evaluate(async()=>{const state=await window.api.call('state'),id=document.querySelector('#group-list .active')?.dataset.groupId,scroll=document.getElementById('message-scroll'),rect=scroll.getBoundingClientRect(),article=[...scroll.querySelectorAll('article[data-message-id]')].find(el=>el.getBoundingClientRect().bottom>rect.top+1);return{state,groupId:id,visibleId:article?.dataset.messageId,visibleOffset:article?article.getBoundingClientRect().top-rect.top:null,scrollTop:scroll.scrollTop,viewportHeight:rect.height,headerHeight:document.getElementById('workspace-header').getBoundingClientRect().height,gap:document.getElementById('sync-gap-line').textContent,automatic:document.getElementById('sync-status-line').textContent,footer:document.getElementById('new-messages-count').textContent};});assertRead(value.state);samples.push({stage,...value});return value;}
async function launch(){
  const run=launches.length+1,netLog=path.join(evidence,'net-'+run+'.json'),preflight=assertWindowsRuntimeReadable(executablePath),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  application=await _electron.launch({executablePath,cwd:installRoot,args:['--data-dir='+dataDir,'--log-net-log='+netLog,'--net-log-capture-mode=Default'],env,timeout:30000});
  const native=application.process(),record={run,pid:native.pid,netLog,preflight,startedAt:new Date().toISOString()};launches.push(record);
  native.once('exit',(code,signal)=>{record.exitCode=code;record.signal=signal;record.exitedAt=new Date().toISOString();});
  page=await application.firstWindow();page.on('pageerror',e=>errors.push(e.message));page.on('request',request=>{if(/^https?:/i.test(request.url()))rendererHttpRequests.push(request.url());});
  record.runtime=await application.evaluate(({app})=>({isPackaged:app.isPackaged,version:app.getVersion(),executable:app.getPath('exe'),appPath:app.getAppPath(),userData:app.getPath('userData')}));
  assert.equal(record.runtime.isPackaged,true);assert.equal(record.runtime.version,packageVersion);assert.equal(path.resolve(record.runtime.executable).toLowerCase(),executablePath.toLowerCase());assert.equal(path.resolve(record.runtime.appPath).toLowerCase(),packageRoot.toLowerCase());assert(path.resolve(record.runtime.userData).startsWith(dataDir+path.sep));
  await application.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()==='app://local/index.html');w.setSize(1360,900);w.show();w.focus();});
  await page.waitForSelector('article[data-message-id]');await page.waitForTimeout(800);
  const state=await api('state'),status=await api('sync.status');assert.equal(path.resolve(state.dataRoot),dataDir);assert.equal(state.account.id,fixtures.accountId);assert.equal(state.sessionReady,false);assert.equal(state.credentials.ai,false);assert.equal(state.credentials.notion,false);assert.equal(state.settings.autoSyncEnabled,false);assert.equal(status.enabled,false);assert.equal(status.running,false);assertRead(state);
  record.isolation={sessionReady:state.sessionReady,credentials:state.credentials,autoSyncEnabled:status.enabled,dataRoot:state.dataRoot};
}
async function close(){
  if(!application)return;
  const current=application,native=current.process(),record=launches.at(-1);
  const exited=new Promise(resolve=>{if(native.exitCode!==null)resolve();else native.once('exit',resolve);});
  await current.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()==='app://local/index.html');w?.close();});
  let timeout;await Promise.race([exited,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Synthetic test window did not close normally')),15000);})]).finally(()=>clearTimeout(timeout));
  assert.equal(record.exitCode,0);assert.equal(record.signal,null);application=null;page=null;
}
async function select(key){const g=fixtures.groups.find(g=>g.key===key);await page.locator('[data-group-id="'+g.id+'"]').click();await page.waitForFunction(id=>document.querySelector('#group-list .active')?.dataset.groupId===id,g.id);await page.waitForSelector('article[data-message-id]');await page.waitForTimeout(650);return sample('select-'+key);}
async function latestRead(g){await page.locator('#jump-latest-read').click();await page.waitForFunction(id=>{const s=document.getElementById('message-scroll'),a=[...s.querySelectorAll('[data-message-id]')].find(x=>x.dataset.messageId===id);return a&&Math.abs(a.getBoundingClientRect().top-s.getBoundingClientRect().top)<2;},g.ids[g.through]);await page.waitForTimeout(700);return sample('latest-read-'+g.key);}
function netSummary(file){assert(fs.existsSync(file),'Native network log is missing');const log=JSON.parse(fs.readFileSync(file,'utf8')),external=[];function walk(value){if(!value||typeof value!=='object')return;for(const[k,v]of Object.entries(value)){if(typeof v==='string'&&/^(https?|wss?):\/\//i.test(v)){const u=new URL(v);if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname))external.push({protocol:u.protocol,hostname:u.hostname});}else if(v&&typeof v==='object')walk(v);}}for(const event of log.events||[])walk(event.params);return{events:log.events?.length||0,externalUrlObservations:external.length,externalHosts:[...new Set(external.map(x=>x.hostname))]};}
(async()=>{
 try{
  await launch();const first=await sample('first-launch');
  const module=await page.evaluate(()=>({type:typeof window.WeiyueSyncStatus?.groupStatus,script:document.querySelector('script[src="sync-status.js"]')?.src,base:document.baseURI,functionSource:String(window.WeiyueSyncStatus?.groupStatus),resources:performance.getEntriesByType('resource').filter(r=>r.name==='app://local/sync-status.js').map(r=>({name:r.name,decodedBodySize:r.decodedBodySize,responseStatus:r.responseStatus}))}));
  assert.equal(module.type,'function');assert.equal(module.script,'app://local/sync-status.js');assert.equal(module.base,'app://local/index.html');
  // Custom app: resources are not guaranteed ResourceTiming entries. Compare
  // the executed function to the actual packaged file instead of assuming one.
  assert.equal(module.functionSource,String(require(path.join(packageRoot,'app/renderer/sync-status.js')).groupStatus));
  check('Unmodified packaged EXE loads the exact packaged sync-status.js function through its real app protocol');
  assert.match(first.gap,/已补入 1,200 条.*仍有 1 段待衔接/);assert.match(first.automatic,/自动更新已暂停/);assert.equal(await page.locator('#sync-latest').textContent(),'补齐离线消息');assert.equal(await page.locator('#sync-history').textContent(),'更早历史');assert.match(await page.locator('#sync-history').getAttribute('title'),/本机最早记录之前.*中间的离线缺口/);check('Real persisted pending state and clearly separated history/backfill controls render with no credentials');
  const highWater=fixtures.groups[0];await page.locator('#message-search').fill('回看命中');await page.locator('#message-search').press('Enter');await page.waitForFunction(()=>document.querySelectorAll('article[data-message-id]').length===3&&document.getElementById('read-count').textContent.includes('已筛选'));await sample('filtered-old-messages');check('Search of older messages preserves every group high-water and unread count');
  const returned=await latestRead(highWater);assert.equal(returned.visibleId,highWater.ids[highWater.through]);assert.equal(await page.locator('#message-search').inputValue(),'');assert.match(await page.locator('#toast').textContent(),/清除筛选.*最新已读位置/);assert.equal(returned.footer,expectedRead[highWater.id].unreadCount+' 条未读');check('Latest-read button clears the search and loads the saved boundary beyond the initial 160-message window without reading newer messages');
  await page.locator('#previous-page').click();await page.waitForFunction(id=>!document.querySelector('article[data-message-id="'+id+'"]'),highWater.ids[highWater.through]);await sample('earlier-local-page');await latestRead(highWater);check('Local page look-back and return preserve unread/high-water instead of jumping to newest unread');
  const unresolved=await select('B');assert.match(unresolved.gap,/仍有缺口.*已补入 1,260 条/);assert.equal(await page.locator('#sync-latest').textContent(),'检查并继续补扫');assert.equal(unresolved.headerHeight,first.headerHeight);assert.equal(unresolved.viewportHeight,first.viewportHeight);assert.equal(await page.locator('#sync-gap-line').getAttribute('title'),unresolved.gap);check('Persisted unresolved state is not called complete and its longer status does not move the reading layout');
  const joined=await select('C');assert.match(joined.gap,/本次离线消息已与本机记录衔接/);assert.equal(await page.locator('#sync-latest').textContent(),'同步最新');assert.equal(joined.headerHeight,first.headerHeight);check('Across groups, only the joined group reports this scan as rejoined');
  await select('A');const restored=await sample('A-restored-after-cross-group');assert.equal(restored.visibleId,highWater.ids[highWater.through]);
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()==='app://local/index.html').setSize(1100,760));await page.waitForTimeout(350);await sample('compact-layout');
  const compact=await page.evaluate(()=>{const gap=document.getElementById('sync-gap-line'),auto=document.getElementById('sync-status-line'),header=document.getElementById('workspace-header'),scroll=document.getElementById('message-scroll');return{gapHeight:gap.getBoundingClientRect().height,autoHeight:auto.getBoundingClientRect().height,nonoverlap:header.getBoundingClientRect().bottom<=scroll.getBoundingClientRect().top,buttonsVisible:[...header.querySelectorAll('button')].every(b=>b.getBoundingClientRect().right<=innerWidth)};});assert.deepEqual(compact,{gapHeight:16,autoHeight:16,nonoverlap:true,buttonsVisible:true});check('Actual EXE compact layout reserves two status lines and leaves messages unobscured');
  await page.screenshot({path:path.join(evidence,'packaged-synthetic-backfill.png')});await close();
  const persisted=new Store(path.join(dataDir,'accounts')).get(fixtures.accountId);for(const g of fixtures.groups){assert.equal(persisted.readStates[g.id].readThroughId,expectedRead[g.id].readThroughId);assert.deepEqual(persisted.readStates[g.id].unreadIds,g.ids.slice(g.through+1));}assert.equal(persisted.messages.length,messages.length);check('Normal Windows close persists all exact unread IDs and high-water boundaries without changing message data');
  await launch();const restarted=await sample('restarted');assert.equal(restarted.groupId,highWater.id);assert.equal(restarted.visibleId,highWater.ids[highWater.through]);assert.match(restarted.gap,/仍有 1 段待衔接/);await select('B');assert.match(await page.locator('#sync-gap-line').textContent(),/仍有缺口/);await latestRead(fixtures.groups[1]);check('Restart restores reading position and each saved pending/unresolved state without advancing unread');
  await close();assert.deepEqual(errors,[]);assert.deepEqual(rendererHttpRequests,[]);
  for(const record of launches){record.network=netSummary(record.netLog);assert.equal(record.network.externalUrlObservations,0,'Unexpected external network in native log');}check('Both actual EXE launches used no remote HTTP/WebSocket URLs in Chromium native network logs');
 }catch(error){failure=String(error.stack||error);console.error(failure);}
 finally{
  if(application)await close().catch(async error=>{failure||=String(error);await application?.close().catch(()=>{});application=null;});
  const afterProgramHashes=programHashes(),programUnchanged=JSON.stringify(beforeProgramHashes)===JSON.stringify(afterProgramHashes),installDataUnchanged=fs.existsSync(path.join(installRoot,'data'))===installDataExisted;
  const passed=!failure&&programUnchanged&&installDataUnchanged&&errors.length===0;
  fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({passed,failure,checks,errors,rendererHttpRequests,packageVersion,executablePath,profileRoot,dataDir,launches,samples,programUnchanged,installDataUnchanged,beforeProgramHashes,afterProgramHashes,scope:'Actual packaged EXE with no modified executable/resources or boot shim; new synthetic account with no credentials, no avatar/media URLs, auto-sync disabled, no sync/login/AI/Notion actions; native network logs observed both launches',at:new Date().toISOString()},null,2));
  console.log(JSON.stringify({passed,report:path.join(evidence,'result.json'),packageVersion,programUnchanged,installDataUnchanged}));if(!passed)process.exitCode=1;
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
