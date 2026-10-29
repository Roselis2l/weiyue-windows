'use strict';
// Exercises the real login.complete IPC and wall-clock scheduler. All identities,
// cookies, groups and messages are synthetic; the transport is replaced in RAM.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {assertWindowsRuntimeReadable}=require('./windows-runtime-check.cjs');
const {packagedInput,validatePackaged,networkSummary,verifyPackaged}=require('./lib/packaged-ui-support.cjs');
const packaged=packagedInput(),root=path.resolve(__dirname,'..'),appSource=packaged?.appSource||path.join(root,'app');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'weiyue-login-127-')),dataDir=path.join(temp,'data');
const evidence=path.resolve(process.env.WEIYUE_LOGIN_OUTPUT||path.join(root,'artifacts','feature-1.1.27','login-'+Date.now()));
fs.mkdirSync(dataDir);fs.mkdirSync(evidence,{recursive:true});
const {Store}=require(path.join(appSource,'core/store.cjs'));
const accounts=['weibo-127001','weibo-127002'],groupId='127003';
const messages=Array.from({length:90},(_,i)=>({id:String(9007199254741990000n+BigInt(i)),groupId,senderId:'127004',senderName:'合成测试成员',text:'重新登录验收示例 '+i,time:1793000000000+i*60000,mediaVersion:1,attachmentVersion:1,referenceVersion:1,contextVersion:1}));
const fixture=new Store(path.join(dataDir,'accounts'));
for(const id of accounts){
  fixture.ensureAccount({id,kind:'weibo',name:'合成登录账号 '+id.slice(-1)});
  fixture.mergeMessages(id,[{id:groupId,name:'离线验收示例群',selected:true},{id:'127005',name:'未选择的示例群',selected:false}],messages,{history:true});
  fixture.update(id,s=>{s.settings.autoSyncEnabled=false;s.readPositions[groupId]=messages[20].id;s.readStates[groupId]={anchorId:messages[20].id,anchorOffset:0,readThroughId:messages[40].id,atBottom:false,unreadIds:messages.slice(41).map(m=>m.id),updatedAt:1000};});
}
fs.writeFileSync(path.join(dataDir,'preferences.json'),JSON.stringify({activeId:accounts[0]}));

function installMock({app,net,session}){
  const info=globalThis.__loginAcceptance={failure:'auth',calls:[],blocked:[],attached:new WeakSet(),latestText:'合成登录账号',inFlight:0,maxInFlight:0};
  const deny=async()=>{info.blocked.push('blocked-external');throw Error('Offline acceptance forbids external requests');};
  globalThis.fetch=deny;
  const nativeFetch=net.fetch.bind(net);net.fetch=(url,options)=>/^(?:app|file):/i.test(String(url))?nativeFetch(url,options):deny();
  const attach=s=>{
    if(info.attached.has(s))return;info.attached.add(s);const fetch=s.fetch.bind(s);
    s.fetch=async(url,options)=>{
      if(/^(?:app|file):/i.test(String(url)))return fetch(url,options);
      const u=new URL(String(url));if(u.origin!=='https://api.weibo.com')return deny();
      const cookie=(await s.cookies.get({})).find(c=>c.name==='SYNTHETIC_ACCOUNT');
      if(!cookie||!['127001','127002'].includes(cookie.value))return deny();
      const id=cookie.value;info.calls.push({id,path:u.pathname,time:Date.now()});info.inFlight++;info.maxInFlight=Math.max(info.maxInFlight,info.inFlight);
      try{
        if(u.pathname==='/webim/query_primary_info.json'){
          if(info.failure==='auth')return new Response('{}',{status:401});
          if(info.failure==='access')return new Response('{}',{status:403});
          if(info.failure==='rate')return new Response('{}',{status:429,headers:{'retry-after':'120'}});
          return new Response(JSON.stringify({profile:{id,screen_name:info.latestText}}),{headers:{'content-type':'application/json'}});
        }
        if(u.pathname==='/webim/2/direct_messages/contacts.json')return new Response(JSON.stringify({contacts:[{user:{type:2,id:'127003',name:'离线验收示例群'}},{user:{type:2,id:'127005',name:'未选择的示例群'}},{user:{type:2,id:'127006',name:'新发现的示例群'}}]}),{headers:{'content-type':'application/json'}});
        if(u.pathname==='/webim/groupchat/query_messages.json')return new Response('{"messages":[]}',{headers:{'content-type':'application/json'}});
        return deny();
      }finally{info.inFlight--;}
    };
    s.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_detail,callback)=>{info.blocked.push('blocked-web-request');callback({cancel:true});});
  };
  app.on('session-created',attach);if(app.isReady())attach(session.defaultSession);else app.whenReady().then(()=>attach(session.defaultSession));
}
if(!packaged){
  fs.writeFileSync(path.join(temp,'package.json'),fs.readFileSync(path.join(root,'package.json')));
  fs.writeFileSync(path.join(temp,'boot.cjs'),'('+installMock.toString()+')(require("electron"));require('+JSON.stringify(path.join(appSource,'main.cjs'))+');');
}
const checks=[],runs=[],errors=[];let application,page,stage='prepare',failure,diagnostic;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),pass=text=>{checks.push(text);console.log('PASS '+text);};
const api=(action,payload={})=>page.evaluate(({action,payload})=>window.api.call(action,payload),{action,payload});
const setFailure=async value=>application.evaluate((_e,value)=>{globalThis.__loginAcceptance.failure=value;},value);
const status=()=>api('sync.status',{accountId:accounts[0],groupId});
const stats=()=>application.evaluate(()=>{const i=globalThis.__loginAcceptance;return{calls:i.calls,blocked:i.blocked,maxInFlight:i.maxInFlight};});
async function until(check,description,timeout=10000){const deadline=Date.now()+timeout;while(Date.now()<deadline){const value=await check();if(value)return value;await wait(100);}throw Error('Timed out: '+description);}
const marks=s=>{const r=s.readStates[groupId];return{anchorId:r.anchorId,readThroughId:r.readThroughId,unreadIds:r.unreadIds,unreadCount:r.unreadCount,atBottom:r.atBottom};};
async function launch(){
  const run={netLog:path.join(evidence,'native-net-'+runs.length+'.json')};runs.push(run);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const executablePath=packaged?.executablePath||process.env.WEIYUE_TEST_RUNTIME_EXE||path.join(root,'vendor','runtime','electron.exe');
  run.preflight=assertWindowsRuntimeReadable(executablePath);
  application=await _electron.launch({executablePath,args:[...(packaged?[]:[path.join(temp,'boot.cjs')]),'--data-dir='+dataDir,'--log-net-log='+run.netLog,'--net-log-capture-mode=Default'],cwd:packaged?.installRoot||temp,env,timeout:30000});
  run.pid=application.process().pid;application.process().once('exit',(code,signal)=>Object.assign(run,{code,signal}));
  if(packaged){run.runtime=await validatePackaged(application,packaged,dataDir);assert.equal(run.runtime.version,'1.1.27');await application.evaluate(installMock);}
  await application.evaluate(({safeStorage},{appSource,dataDir,accounts})=>{
    const path=process.getBuiltinModule('node:path'),nodeRequire=process.getBuiltinModule('node:module').createRequire(path.join(appSource,'main.cjs'));
    const {Vault}=nodeRequire(path.join(appSource,'core/security.cjs'));
    const vault=new Vault(path.join(dataDir,'credentials'),safeStorage);
    for(const id of accounts)vault.write(id,{cookies:[{name:'SYNTHETIC_ACCOUNT',value:id.slice(6),domain:'.weibo.com',path:'/',secure:true,httpOnly:true,sameSite:'unspecified'}]});
  },{appSource,dataDir,accounts});
  page=await application.firstWindow();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));await page.waitForSelector('article[data-message-id]',{timeout:30000});await wait(600);
}
async function close(){
  if(!application)return;const run=runs.at(-1);run.instrumentation=await stats();
  const process=application.process(),done=new Promise(resolve=>process.exitCode!==null?resolve():process.once('exit',resolve));
  try{await application.evaluate(({BrowserWindow})=>{setTimeout(()=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()==='app://local/index.html')?.close(),0);});}catch(error){if(process.exitCode===null)throw error;}
  let timer;try{await Promise.race([done,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Normal close timed out')),15000))]);}finally{clearTimeout(timer);}
  run.network=networkSummary(run.netLog);application=null;
}
(async()=>{try{
  await launch();const initialA=marks(await api('state'));
  await api('sync.configure',{enabled:true});await until(async()=>(await status()).errorCode==='AUTH_REQUIRED','authentication stop');
  const expired=await status();assert.equal(expired.enabled,true);assert.equal(expired.nextRunAt,null);assert.equal(expired.blocked,true);
  await until(async()=>/重新登录/.test(await page.locator('#sync-status-line').innerText()),'visible expired-login status');
  const count=(await stats()).calls.length;await wait(5500);assert.equal((await stats()).calls.length,count);
  pass('Enabled account reaches visible AUTH_REQUIRED pause and sends no further periodic requests');
  stage='same-account-recovery';await setFailure(null);const completedAt=Date.now();const state=await api('login.complete');assert.equal(state.account.id,accounts[0]);
  assert.deepEqual(Object.fromEntries(state.groups.map(g=>[g.id,g.selected])),{'127003':true,'127005':false,'127006':false});
  const recovered=await status();assert.equal(recovered.enabled,true);assert.equal(recovered.blocked,false);assert.equal(recovered.errorCode,'');assert.ok(recovered.nextRunAt>=completedAt+4900&&recovered.nextRunAt<=Date.now()+5100);assert.deepEqual(marks(state),initialA);
  await api('login.complete');assert.equal((await status()).nextRunAt,recovered.nextRunAt);
  await until(async()=>!!(await status()).lastSuccessAt,'automatic successful cycle');
  const success=await status();assert.ok(success.nextRunAt-success.lastSuccessAt>=5000);assert.deepEqual(marks(await api('state')),initialA);
  assert.equal((await stats()).maxInFlight,1);
  pass('Real login.complete retains old group choices, leaves new groups unselected and restores one timer; repeat login retains due time and 5-second cycle preserves reading state');
  stage='other-blocks';await setFailure('access');await until(async()=>(await status()).errorCode==='ACCESS_DENIED','access stop');await setFailure(null);await api('login.complete');
  assert.equal((await status()).errorCode,'ACCESS_DENIED');assert.equal((await status()).blocked,true);assert.equal((await status()).nextRunAt,null);
  pass('Successful login cannot clear an existing access-denied pause');
  stage='disabled-account';await page.locator('#account-select').selectOption(accounts[1]);await wait(300);const initialB=marks(await api('state'));
  await api('login.complete');assert.equal((await status()).enabled,false);assert.equal((await status()).nextRunAt,null);assert.equal((await api('state')).settings.autoSyncEnabled,false);
  const disabledCount=(await stats()).calls.length;await wait(5500);assert.equal((await stats()).calls.length,disabledCount);assert.deepEqual(marks(await api('state')),initialB);
  pass('Other account saved manual-off preference remains off after successful login with no automatic calls');
  stage='cached-auth-account';await page.locator('#account-select').selectOption(accounts[0]);await wait(300);assert.equal((await status()).errorCode,'ACCESS_DENIED');
  await setFailure('auth');await api('sync.configure',{enabled:true});await until(async()=>(await status()).errorCode==='AUTH_REQUIRED','cached account auth stop');
  await page.locator('#account-select').selectOption(accounts[1]);await wait(250);await page.locator('#account-select').selectOption(accounts[0]);await wait(250);
  assert.equal((await status()).errorCode,'AUTH_REQUIRED');await setFailure(null);await api('login.complete');assert.equal((await status()).blocked,false);
  assert.equal((await status()).enabled,true);assert.deepEqual(marks(await api('state')),initialA);
  pass('Switching preserves account security pauses; verified login recovers the cached AUTH_REQUIRED controller only');
  stage='restart';await page.locator('#account-select').selectOption(accounts[1]);await wait(250);await close();await launch();
  assert.equal((await api('state')).account.id,accounts[1]);assert.equal((await status()).enabled,false);assert.deepEqual(marks(await api('state')),initialB);
  await setFailure(null);await page.locator('#account-select').selectOption(accounts[0]);await wait(300);assert.equal((await status()).enabled,true);
  await until(async()=>!!(await status()).lastSuccessAt,'saved enabled account after restart');assert.deepEqual(marks(await api('state')),initialA);
  pass('Normal restart preserves both accounts\' manual preferences and marks; returning to saved enabled account resumes one automatic cycle');
  stage='complete';
}catch(error){failure=String(error.stack||error);console.error(failure);if(page)try{diagnostic=await page.evaluate(async()=>({url:location.href,body:document.body.innerText,state:await window.api.call('state').catch(e=>({error:e.message}))}));}catch(e){diagnostic={error:String(e)};}}finally{
  try{await close();}catch(error){failure||=String(error.stack||error);}
  const program=verifyPackaged(packaged),external=runs.some(r=>r.instrumentation?.blocked.length||r.network?.externalUrlObservations);
  const passed=!failure&&!errors.length&&!external&&runs.every(r=>r.code===0)&&(!program||(program.programUnchanged&&program.installDataUnchanged));
  fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({passed,stage,failure,diagnostic,checks,errors,runs,program,dataDir,scope:'Isolated synthetic accounts and encrypted dummy cookies only; mock official responses in RAM; no real login, network or user data'},null,2));
  console.log(JSON.stringify({passed,checks:checks.length,report:path.join(evidence,'result.json')}));if(!passed)process.exitCode=1;
}})();
