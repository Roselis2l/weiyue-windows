'use strict';
// Assigned GUI slot only. The packaged EXE stays byte-identical. Account data,
// credentials and API responses below are synthetic and confined to a temp profile.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {assertWindowsRuntimeReadable}=require('./windows-runtime-check.cjs');
const {packagedInput,validatePackaged,closePackaged,networkSummary,verifyPackaged}=require('./lib/packaged-ui-support.cjs');
const root=path.resolve(__dirname,'..'),packaged=packagedInput();
const harness=fs.mkdtempSync(path.join(os.tmpdir(),'weiyue-refresh-122-')),dataDir=path.join(harness,'data');
const evidence=path.resolve(process.env.WEIYUE_REFRESH_OUTPUT||path.join(root,'artifacts','feature-1.1.22','refresh-'+Date.now()));
const appSource=packaged?.appSource||path.join(root,'app'),hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
fs.mkdirSync(dataDir);fs.mkdirSync(evidence,{recursive:true});
const sourceHashes=Object.fromEntries(['main.cjs','core/auto-sync.cjs','core/account-auto-sync.cjs','core/sync-service.cjs','core/refresh-plan.cjs','renderer/app.js','renderer/sync-status.js'].map(file=>[file,hash(path.join(appSource,file))]));
if(!packaged){fs.cpSync(path.join(root,'vendor/runtime'),path.join(harness,'runtime'),{recursive:true});fs.cpSync(appSource,path.join(harness,'app'),{recursive:true});fs.copyFileSync(path.join(root,'package.json'),path.join(harness,'package.json'));}
const executablePath=packaged?.executablePath||path.join(harness,'runtime','electron.exe');
const {Store}=require(path.join(appSource,'core/store.cjs')),store=new Store(path.join(dataDir,'accounts'));
const identity='8999999999',accountId='weibo-'+identity,base=Date.parse('2026-10-22T00:00:00Z');
const groups=['810001','810002','810003'].map((id,index)=>({id,name:'定时刷新 '+(index+1)+' · 示例数据',selected:true,messages:Array.from({length:201},(_,i)=>({id:String(9007199254743000000n+BigInt(index)*10000n+BigInt(i)),groupId:id,senderId:'8999999998',senderName:'刷新验收成员 · 示例数据',text:'合成阅读记录 '+i+'；仅验证自动更新时间和阅读位置，不请求真实服务。',time:base+i*60000,mediaVersion:1,attachmentVersion:1,referenceVersion:1,contextVersion:1}))}));
store.ensureAccount({id:accountId,kind:'weibo',name:'自动刷新验收 · 示例数据'});
store.mergeMessages(accountId,groups.map(({messages,...g})=>g),groups.flatMap(g=>g.messages),{history:true});
store.update(accountId,state=>{state.settings.autoSyncEnabled=false;for(const g of groups){state.readPositions[g.id]=g.messages[40].id;state.readStates[g.id]={anchorId:g.messages[40].id,anchorOffset:0,readThroughId:g.messages[150].id,atBottom:false,unreadIds:g.messages.slice(151).map(m=>m.id),updatedAt:1000};}});
fs.writeFileSync(path.join(dataDir,'preferences.json'),JSON.stringify({activeId:accountId}));
const fixture={identity,accountId,groups:groups.map(g=>({id:g.id,last:g.messages.at(-1)}))};
const checks=[],errors=[],runs=[],snapshots=[];let application,page,stage='prepare',failure=null,processResult=null;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const pass=text=>{checks.push(text);console.log('PASS '+text);};
async function until(check,message,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await wait(100);}throw Error(message);}
const api=(action,payload={})=>page.evaluate(({action,payload})=>window.api.call(action,payload),{action,payload});
const info=()=>application.evaluate(()=>globalThis.__refreshAcceptance);
const status=()=>api('sync.status');
async function viewport(){return page.locator('#message-scroll').evaluate(el=>{const bounds=el.getBoundingClientRect(),first=[...el.querySelectorAll('article[data-message-id]')].find(row=>row.getBoundingClientRect().bottom>bounds.top+1);return{anchorId:first?.dataset.messageId,offset:first?first.getBoundingClientRect().top-bounds.top:null,scrollTop:el.scrollTop};});}
function assertReadingPreserved(before,after,added){assert.equal(after.readThroughId,before.readThroughId);assert.equal(after.anchorId,before.anchorId);assert.equal(after.unreadCount,before.unreadCount+added);}
async function choose(g){await page.locator('#group-list [data-group-id="'+g.id+'"]').click();await until(async()=>await page.locator('#message-scroll [data-message-id="'+g.messages[40].id+'"]').count()===1,'Selected group did not render');await wait(2300);}
async function installMock(mode='ok'){
  return application.evaluate(({app,net,session},config)=>{
    const require=process.getBuiltinModule('node:module').createRequire(app.getAppPath()+'/package.json');
    const path=require('node:path');
    const {WeiboClient,WeiboError,PATHS}=require(path.join(app.getAppPath(),'app/core/weibo.cjs'));
    const {Vault}=require(path.join(app.getAppPath(),'app/core/security.cjs'));
    const report=globalThis.__refreshAcceptance={mode:config.mode,requests:[],network:[],active:0,maxActive:0,cycle:0,vaultWrites:0,heads:{},startedAt:Date.now()};
    const deny=()=>{report.network.push({kind:'external-blocked',at:Date.now()});throw Error('Synthetic refresh acceptance forbids external services');};
    globalThis.fetch=async()=>deny();
    const nf=net.fetch.bind(net),nr=net.request.bind(net);
    net.fetch=(url,options)=>/^(?:app|file):/i.test(String(url))?nf(url,options):Promise.reject(deny());
    net.request=options=>{const url=typeof options==='string'?options:options.url;if(/^https?:/i.test(String(url)))return deny();return nr(options);};
    const attached=new WeakSet(),attach=s=>{if(attached.has(s))return;attached.add(s);const original=s.fetch.bind(s);s.fetch=(url,options)=>/^(?:app|file):/i.test(String(url))?original(url,options):Promise.reject(deny());s.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,callback)=>{report.network.push({kind:'web-request-blocked',at:Date.now()});callback({cancel:true});});};
    app.on('session-created',attach);attach(session.defaultSession);
    const fakeCookies=[{domain:'api.weibo.com',path:'/',name:'synthetic_refresh_fixture',value:'not-a-real-login',secure:true,httpOnly:true,hostOnly:true,sameSite:'unspecified'}];
    Vault.prototype.read=function(id){if(id!==config.accountId)throw Error('Unexpected account in synthetic acceptance');return{cookies:fakeCookies};};
    Vault.prototype.write=function(id){if(id!==config.accountId)throw Error('Unexpected account in synthetic acceptance');report.vaultWrites++;};
    const current=new Map(config.groups.map(g=>[g.id,g.last]));
    WeiboClient.prototype._request=async function(endpoint,parameters={},signal){
      if(signal?.aborted)throw new WeiboError('ABORTED','Synthetic canceled request');
      if(endpoint===PATHS.identity)report.cycle++;
      const entry={kind:endpoint===PATHS.identity?'identity':endpoint===PATHS.messages?'messages':'other',groupId:parameters.id||null,before:parameters.max_mid??null,cycle:report.cycle,start:Date.now(),end:null};
      report.requests.push(entry);report.active++;report.maxActive=Math.max(report.maxActive,report.active);
      try{
        await new Promise((resolve,reject)=>{const timer=report.mode==='hang'?null:setTimeout(resolve,220);signal?.addEventListener('abort',()=>{if(timer!==null)clearTimeout(timer);reject(new WeiboError('ABORTED','Synthetic canceled request'));},{once:true});});
        if(report.mode==='rate')throw new WeiboError('RATE_LIMIT','Synthetic rate limit',{retryAfter:'90'});
        if(report.mode==='auth')throw new WeiboError('AUTH_REQUIRED','Synthetic expired login');
        if(endpoint===PATHS.identity)return{profile:{id:config.identity,screen_name:'合成刷新账号'}};
        if(endpoint!==PATHS.messages)throw Error('Unexpected mocked endpoint');
        const previous=current.get(parameters.id);if(!previous)throw Error('Unexpected synthetic group');
        if(parameters.max_mid!==null&&parameters.max_mid!==undefined)throw Error('Unexpected gap during joined synthetic fixture');
        const next={...previous,id:(BigInt(previous.id)+1n).toString(),time:previous.time+60000,text:'合成自动新增 '+report.cycle+'；不得推进阅读位置。'};
        current.set(parameters.id,next);report.heads[parameters.id]=(report.heads[parameters.id]||0)+1;
        const convert=m=>({id:m.id,gid:m.groupId,from_uid:m.senderId,from_user:{id:m.senderId,screen_name:m.senderName},text:m.text,time:m.time/1000});
        return{messages:[convert(next),convert(previous)],has_more:true};
      }finally{entry.end=Date.now();report.active--;}
    };
    return{installed:true,syntheticAccount:config.accountId,mode:config.mode};
  },{...fixture,mode});
}
async function launch(mode='ok'){
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const netLog=path.join(evidence,'native-net-'+runs.length+'.json');
  processResult={preflight:assertWindowsRuntimeReadable(executablePath),netLog,mode};runs.push(processResult);
  application=await _electron.launch({executablePath,args:packaged?['--data-dir='+dataDir,'--log-net-log='+netLog,'--net-log-capture-mode=Default']:[harness,'--data-dir='+dataDir,'--log-net-log='+netLog,'--net-log-capture-mode=Default'],cwd:packaged?.installRoot||harness,env,timeout:30000});
  const appProcess=application.process();processResult.pid=appProcess.pid;appProcess.once('exit',(code,signal)=>Object.assign(processResult,{code,signal}));
  if(packaged){processResult.runtime=await validatePackaged(application,packaged,dataDir);assert.equal(processResult.runtime.version,'1.1.22');}
  page=await application.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.waitForSelector('#message-scroll article[data-message-id]');
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()==='app://local/index.html').setSize(1440,930));
  assert.equal(path.resolve((await api('state')).dataRoot),dataDir);assert.equal((await status()).enabled,false);
  await installMock(mode);
}
async function close(){
  if(!application)return;
  processResult.instrumentation=await info();
  await closePackaged(application);processResult.network=networkSummary(processResult.netLog);application=null;page=null;
}
(async()=>{try{
  stage='launch';await launch();
  const foreground=groups[1],background=groups[2];await choose(foreground);
  const before=(await api('state')).readStates,beforeView=await viewport();
  const enabledAt=Date.now(),enabled=await api('sync.configure',{enabled:true});assert.equal(enabled.intervalMs,5000);assert.ok(enabled.nextRunAt-enabledAt>=4800);assert.ok(enabled.nextRunAt-enabledAt<=5500);
  pass('Actual running app reports a 5000 ms automatic interval and waits a full first interval');
  await wait(1500);assert.equal((await info()).requests.length,0);
  await until(async()=>{const x=await info();return x.cycle>=1&&!(await status()).running&&x.requests.some(r=>r.kind==='messages');},'First automatic cycle did not finish',22000);
  const first=await info(),firstStatus=await status();assert.equal(first.requests.find(r=>r.kind==='messages').groupId,foreground.id);assert.equal(first.maxActive,1);assert.equal(first.requests.filter(r=>r.kind==='messages').length,3);
  assert.ok(first.requests.find(r=>r.kind==='identity').start-enabledAt>=4800);assert.ok(firstStatus.nextRunAt-firstStatus.lastSuccessAt>=5000);assert.ok(firstStatus.nextRunAt-firstStatus.lastSuccessAt<5100);
  pass('First wall-clock cycle reads the current group first and visits due background groups serially');
  await until(async()=>{const x=await info();return x.cycle>=2&&!(await status()).running;},'Second automatic cycle did not finish',20000);
  const second=await info(),secondStatus=await status(),secondMessages=second.requests.filter(r=>r.kind==='messages'&&r.cycle===2);
  assert.deepEqual(secondMessages.map(r=>r.groupId),[foreground.id]);assert.equal(second.maxActive,1);
  const firstEnd=Math.max(...second.requests.filter(r=>r.cycle===1).map(r=>r.end)),secondStart=second.requests.find(r=>r.kind==='identity'&&r.cycle===2).start;
  assert.ok(secondStart-firstEnd>=4950);assert.ok(secondStart-firstEnd<12000);assert.equal(secondStatus.intervalMs,5000);
  snapshots.push({phase:'wall-clock',firstCycleEnd:firstEnd,secondCycleStart:secondStart,completionToNextMs:secondStart-firstEnd,status:secondStatus});
  pass('Second real-time cycle starts at least 5 seconds after completion, does not overlap, and skips background heads still inside 60 seconds');
  await wait(2100);const after=(await api('state')).readStates,afterView=await viewport();
  for(const g of groups)assertReadingPreserved(before[g.id],after[g.id],second.heads[g.id]||0);
  assert.equal(afterView.anchorId,beforeView.anchorId);assert.ok(Math.abs(afterView.offset-beforeView.offset)<=2);
  const disk=store.get(accountId);for(const g of groups){assert.deepEqual(disk.readStates[g.id].unreadIds.slice(0,50),g.messages.slice(151).map(m=>m.id));assert.equal(disk.readStates[g.id].readThroughId,g.messages[150].id);}
  assert.match(await page.locator('#sync-status-line').innerText(),/5\s*秒/);
  await page.screenshot({path:path.join(evidence,'synthetic-refresh-five-seconds.png')});
  pass('New synchronized messages add only their IDs to unread; every previous unread ID, high-water mark and visible historical viewport is preserved');
  const currentCycle=(await info()).cycle;await choose(background);
  await until(async()=>{const x=await info();return x.cycle>currentCycle&&!(await status()).running;},'Changed foreground group did not refresh',20000);
  const switched=await info(),newCycle=switched.cycle,newHeads=switched.requests.filter(r=>r.cycle===newCycle&&r.kind==='messages');
  assert.equal(newHeads[0].groupId,background.id);assert.ok(!newHeads.some(r=>r.groupId===groups[0].id));assert.equal(switched.maxActive,1);
  pass('Changing the visible group changes the next foreground read without high-frequency contacts polling or parallel work');
  await api('sync.configure',{enabled:false});await until(async()=>!(await status()).running,'Pause did not settle');const pausedCount=(await info()).requests.length;await wait(5500);assert.equal((await info()).requests.length,pausedCount);
  pass('Pausing automatic refresh cancels future cycles without consuming unread messages');
  stage='slow-batch';const beforeSlow=(await api('state')).readStates;await application.evaluate(()=>{globalThis.__refreshAcceptance.mode='hang';});await api('sync.configure',{enabled:true});
  await until(async()=>(await status()).running&&(await info()).active===1,'Synthetic slow batch did not start',10000);
  const duringSlowCount=(await info()).requests.length;await api('sync.configure',{enabled:true});assert.equal((await status()).running,true);
  await until(async()=>{const s=await status();return !s.running&&s.errorCode==='ABORTED';},'Slow batch was not canceled by its outer 20-second deadline',29000);
  const slowInfo=await info(),slowRequest=slowInfo.requests.at(-1),slowStatus=await status(),afterSlow=(await api('state')).readStates;
  assert.ok(slowRequest.end-slowRequest.start>=19500);assert.ok(slowRequest.end-slowRequest.start<27000);assert.equal(slowInfo.requests.length,duringSlowCount);assert.equal(slowInfo.active,0);assert.equal(slowInfo.maxActive,1);assert.ok(slowStatus.nextRunAt-Date.now()>57000);
  for(const g of groups)assertReadingPreserved(beforeSlow[g.id],afterSlow[g.id],0);
  snapshots.push({phase:'slow-batch',durationMs:slowRequest.end-slowRequest.start,status:slowStatus});await api('sync.configure',{enabled:false});
  pass('A synthetic hanging transport honors the real outer 20-second abort after enabled:true reconfiguration during the request, releases single-flight occupancy, keeps reading state and retains the 60-second failure delay');
  stage='rate-limit';await application.evaluate(()=>{globalThis.__refreshAcceptance.mode='rate';});await api('sync.configure',{enabled:true});
  await until(async()=>(await status()).errorCode==='RATE_LIMIT','Synthetic 429 did not reach scheduler',15000);
  const limited=await status(),limitedCount=(await info()).requests.length;assert.ok(limited.nextRunAt-Date.now()>85000);
  await api('sync.configure',{enabled:false});await api('sync.configure',{enabled:true});const resumed=await status();assert.ok(resumed.nextRunAt>=limited.nextRunAt-10);await wait(5500);assert.equal((await info()).requests.length,limitedCount);
  await api('sync.configure',{enabled:false});pass('Retry-After 90 seconds is retained across pause/resume; the new 5-second cadence cannot bypass cooldown');
  stage='restart';const beforeRestart=(await api('state')).readStates;await until(async()=>(await page.locator('#auto-sync-toggle').innerText()).includes('恢复'),'Paused state did not reach the renderer',5000);await page.screenshot({path:path.join(evidence,'synthetic-refresh-paused.png')});await close();await launch('auth');
  const restored=(await api('state')).readStates;for(const g of groups){assert.equal(restored[g.id].readThroughId,beforeRestart[g.id].readThroughId);assert.equal(restored[g.id].unreadCount,beforeRestart[g.id].unreadCount);assert.equal(restored[g.id].anchorId,beforeRestart[g.id].anchorId);}
  assert.equal((await status()).enabled,false);assert.equal((await status()).intervalMs,5000);pass('Normal close/reopen keeps the pause preference, read boundaries, anchor IDs and unread counts; 5-second policy remains active');
  stage='auth-stop';await api('sync.configure',{enabled:true});await until(async()=>(await status()).blocked,'Synthetic authentication failure did not pause',15000);
  const blocked=await status(),authCount=(await info()).requests.length;assert.equal(blocked.errorCode,'AUTH_REQUIRED');assert.equal(blocked.nextRunAt,null);await wait(5500);assert.equal((await info()).requests.length,authCount);
  pass('Authentication failure stops all automatic retries until explicit recovery');
  stage='complete';await page.screenshot({path:path.join(evidence,'synthetic-refresh-auth-paused.png')});
}catch(error){failure=String(error.stack||error);console.error(failure);}finally{
  try{await close();}catch(error){failure||=String(error.stack||error);}
  const sourceStillMatches=Object.entries(sourceHashes).every(([file,value])=>hash(path.join(appSource,file))===value),program=verifyPackaged(packaged);
  const allClosed=runs.every(r=>r.code===0),external=runs.reduce((n,r)=>n+(r.network?.externalUrlObservations||0)+(r.instrumentation?.network?.length||0),0);
  const passed=!failure&&!errors.length&&!external&&allClosed&&sourceStillMatches&&(!program||(program.programUnchanged&&program.installDataUnchanged));
  const report={passed,stage,failure,checks,errors,snapshots,runs,sourceHashes,sourceStillMatches,program,harness,dataDir,executablePath,externalObservations:external,scope:'Actual app scheduler, sync service, store and renderer; real wall-clock timers; in-memory synthetic Weibo transport and synthetic Vault only; all external network blocked. Packaged mode does not alter program files. Not a real Weibo rate-limit/performance test.'};
  fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed,checks:checks.length,report:path.join(evidence,'result.json')}));if(!passed)process.exitCode=1;
}})();
