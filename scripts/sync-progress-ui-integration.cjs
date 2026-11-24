'use strict';
// Production renderer in a copied app, with synthetic Store data and a local IPC transport fixture.
// No user profile or real service is opened. Status transitions do not alter messages/read state.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {assertWindowsRuntimeReadable}=require('./windows-runtime-check.cjs');
const root=path.resolve(__dirname,'..'),evidence=fs.mkdtempSync(path.join(root,'artifacts','sync-progress-ui-'));
const harness=fs.mkdtempSync(path.join(os.tmpdir(),'weiyue-sync-progress-')),data=path.join(harness,'data');fs.mkdirSync(data);
fs.cpSync(path.join(root,'app'),path.join(harness,'app'),{recursive:true});fs.cpSync(path.join(root,'vendor/runtime'),path.join(harness,'runtime'),{recursive:true});
const owned=['app.js','index.html','style.css','sync-status.js'],hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const hashes=Object.fromEntries(owned.map(file=>[file,hash(path.join(harness,'app/renderer',file))]));
assert.match(fs.readFileSync(path.join(harness,'app/main.cjs'),'utf8'),/['"]\/sync-status\.js['"]/,'Production app must allow the new local module');
const fixture={accountId:'weibo-9007199254740993999',groups:[{id:'9007199254740997101',name:'示例数据 · 补扫进度',count:220,anchor:50,through:139},{id:'9007199254740997102',name:'示例数据 · 未衔接区间',count:120,anchor:20,through:79}]};
const {Store}=require(path.join(harness,'app/core/store.cjs')),store=new Store(path.join(data,'accounts'));
store.ensureAccount({id:fixture.accountId,kind:'weibo',name:'补扫界面合成账号'});
const messages=fixture.groups.flatMap((g,gi)=>{g.ids=Array.from({length:g.count},(_,i)=>String(9007199254741600000n+BigInt(gi*1000+i)));return g.ids.map((id,i)=>({id,groupId:g.id,senderId:'7001',senderName:'模拟成员',time:Date.parse('2026-10-20T00:00:00Z')+i*60000,text:`纯合成消息 ${i}，用于验证补扫状态不会改变阅读位置。`,mediaVersion:1}));});
store.mergeMessages(fixture.accountId,fixture.groups.map(g=>({id:g.id,name:g.name,selected:true})),messages,{history:true});
store.update(fixture.accountId,state=>{state.settings.autoSyncEnabled=false;fixture.groups.forEach((g,i)=>{state.readPositions[g.id]=g.ids[g.anchor];state.readStates[g.id]={anchorId:g.ids[g.anchor],anchorOffset:0,atBottom:false,readThroughId:g.ids[g.through],unreadIds:g.ids.slice(g.through+1),updatedAt:2000-i*1000};});});
fs.writeFileSync(path.join(data,'preferences.json'),JSON.stringify({activeId:fixture.accountId}));
function boot(fixtures){
  const {app,net,session,ipcMain}=require('electron');
  const pending={cursor:'9007199254741500000',baselineId:'9007199254741400000',arrivalAfterId:'9007199254741400000',status:'pending'};
  const info=globalThis.__syncProgressFixture={revision:1,requests:[],readCalls:[],blocked:[],hold:false,release:null,
    status:{enabled:true,running:false,intervalMs:60000,lastSuccessAt:Date.now()},
    groups:Object.fromEntries(fixtures.groups.map(g=>[g.id,{latestPendingRanges:[{...pending}],latestPending:{...pending},syncProgress:{phase:'backfill',added:1200,pages:60,scannedUntil:Date.parse('2026-10-20T04:15:00Z'),updatedAt:Date.now(),reason:''}}]))};
  const originalHandle=ipcMain.handle.bind(ipcMain);
  ipcMain.handle=(channel,handler)=>originalHandle(channel,async(event,action,payload)=>{
    if(channel==='weiyue:call'){
      if(action==='sync.status')return{ok:true,value:{...info.status,accountId:fixtures.accountId,revision:info.revision}};
      if(action==='sync.configure'){info.requests.push({action,payload});info.status={...info.status,enabled:payload.enabled,blocked:false,error:'',errorCode:'',pausedReason:''};return{ok:true,value:{...info.status,accountId:fixtures.accountId,revision:++info.revision}};}
      if(action==='sync'){
        info.requests.push({action,payload});info.status.running=true;
        if(info.hold)await new Promise(resolve=>{info.release=resolve;});
        info.status.running=false;info.revision++;
        if(info.failNext){info.failNext=false;info.groups[payload.groupId].syncProgress={...info.groups[payload.groupId].syncProgress,phase:'blocked',added:1280,reason:'断网后保存位置等待续补。'};return{ok:false,error:'模拟断网，已保存的页面仍保留。'};}
        return{ok:true,value:{count:60}};
      }
      if(action==='read.set')info.readCalls.push(payload);
      const result=await handler(event,action,payload);
      if(action==='state'&&result.ok)result.value={...result.value,revision:info.revision,groups:result.value.groups.map(g=>({...g,...info.groups[g.id]}))};
      return result;
    }
    return handler(event,action,payload);
  });
  const originalFetch=net.fetch.bind(net);net.fetch=(url,options)=>{if(/^https?:/i.test(String(url))){info.blocked.push('external net.fetch');throw Error('External requests blocked in UI fixture');}return originalFetch(url,options);};
  const originalRequest=net.request.bind(net);net.request=(options,...rest)=>{const url=typeof options==='string'?options:options.url;if(/^(app|file):/i.test(String(url)))return originalRequest(options,...rest);info.blocked.push('external net.request');throw Error('External requests blocked in UI fixture');};
  const attach=s=>{const original=s.fetch.bind(s);s.fetch=(url,options)=>{if(/^(app|file):/i.test(String(url)))return original(url,options);info.blocked.push('external session.fetch');throw Error('External requests blocked in UI fixture');};};
  app.on('session-created',attach);app.whenReady().then(()=>attach(session.defaultSession));require('./app/main.cjs');
}
fs.writeFileSync(path.join(harness,'boot.cjs'),'('+boot.toString()+')('+JSON.stringify(fixture)+');');
let application,page;const checks=[],samples=[],errors=[];let failure;
const check=label=>{checks.push(label);console.log('PASS '+label);};
async function sample(){return page.evaluate(async()=>{const state=await window.api.call('state'),id=document.querySelector('#group-list .active').dataset.groupId,scroll=document.getElementById('message-scroll'),r=scroll.getBoundingClientRect(),first=[...scroll.querySelectorAll('[data-message-id]')].find(x=>x.getBoundingClientRect().bottom>r.top+1);return{id,readThroughId:state.readStates[id].readThroughId,unread:state.readStates[id].unreadCount,anchor:first?.dataset.messageId,offset:first?first.getBoundingClientRect().top-r.top:null,top:scroll.scrollTop,viewportHeight:r.height,headerHeight:document.getElementById('workspace-header').getBoundingClientRect().height,status:document.getElementById('sync-status-line').textContent,gap:document.getElementById('sync-gap-line').textContent};});}
async function stage(groupPatch,statusPatch){await application.evaluate((_electron,{groupPatch,statusPatch,id})=>{const f=globalThis.__syncProgressFixture;if(groupPatch)f.groups[id]={...f.groups[id],...groupPatch};if(statusPatch)f.status={...f.status,...statusPatch};f.revision++;},{groupPatch,statusPatch,id:fixture.groups[0].id});}
function unchanged(before,after){assert.equal(after.readThroughId,before.readThroughId);assert.equal(after.unread,before.unread);assert.equal(after.anchor,before.anchor);assert.ok(Math.abs(after.offset-before.offset)<2);assert.ok(Math.abs(after.headerHeight-before.headerHeight)<1);assert.ok(Math.abs(after.viewportHeight-before.viewportHeight)<1);}
(async()=>{
 try{
  const executablePath=path.join(harness,'runtime/electron.exe');const preflight=assertWindowsRuntimeReadable(executablePath);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  application=await _electron.launch({executablePath,args:[path.join(harness,'boot.cjs'),'--data-dir='+data],cwd:harness,env,timeout:30000});
  page=await application.firstWindow();page.on('pageerror',e=>errors.push(e.message));
  await application.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setSize(1360,900);w.show();w.focus();});
  await page.waitForSelector('article[data-message-id]');await page.waitForFunction(()=>document.getElementById('sync-gap-line').textContent.includes('1,200'));
  await page.waitForTimeout(700);const before=await sample();samples.push({stage:'initial',...before});
  assert.match(before.gap,/已补入 1,200 条.*12:15（北京时间）.*仍有 1 段待衔接/);assert.equal(await page.locator('#sync-latest').textContent(),'补齐离线消息');assert.equal(await page.locator('#sync-history').textContent(),'更早历史');assert.match(await page.locator('#sync-history').getAttribute('title'),/中间的离线缺口/);check('Backfill count, China time, pending range and distinct history action are visible');
  await stage({syncProgress:{phase:'backfill',added:1260,pages:63,scannedUntil:Date.parse('2026-10-20T03:45:00Z')}},{running:true});await page.waitForFunction(()=>document.getElementById('sync-gap-line').textContent.includes('1,260'));
  assert.equal(await page.locator('#sync-latest').isDisabled(),true);const running=await sample();unchanged(before,running);samples.push({stage:'running',...running});check('Background progress preserves anchor/high-water/unread and disables overlapping manual requests');
  await stage({syncProgress:{phase:'blocked',added:1260,scannedUntil:Date.parse('2026-10-20T03:45:00Z'),reason:'微博限流，已保存补扫位置。'}},{running:false,errorCode:'RATE_LIMIT',error:'微博暂时限流。',nextRunAt:Date.now()+120000});await page.waitForFunction(()=>document.getElementById('sync-status-line').textContent.includes('限流'));
  const limited=await sample();unchanged(before,limited);samples.push({stage:'rate-limited',...limited});assert.match(limited.gap,/暂停/);assert.match(limited.status,/下次尝试/);assert.equal(await page.locator('#sync-latest').isDisabled(),true);assert.equal(await page.locator('#sync-history').isDisabled(),true);check('Rate limit reports paused batch and retry time and disables manual retries during the known cooldown without viewport movement');
  await stage({latestPendingRanges:[{status:'unresolved'}],syncProgress:{phase:'unresolved',added:1260,reason:'接口提前返回边界，尚未与本机原记录衔接；进度保留。'.repeat(5)}},{error:'',errorCode:'',nextRunAt:null,blocked:true,pausedReason:'微博拒绝访问，请在官方页面确认权限后手动恢复。'});await page.waitForFunction(()=>document.getElementById('sync-latest').textContent==='检查并继续补扫');
  const unresolved=await sample();unchanged(before,unresolved);samples.push({stage:'unresolved',...unresolved});assert.match(unresolved.gap,/仍有缺口/);assert.equal(await page.locator('#auto-sync-toggle').textContent(),'恢复自动更新');assert.equal(await page.locator('#sync-gap-line').getAttribute('title'),unresolved.gap);check('Unresolved/blocked progress remains explicit with full text available and fixed layout');
  await page.locator('#auto-sync-toggle').click();const config=await application.evaluate(()=>globalThis.__syncProgressFixture.requests.filter(x=>x.action==='sync.configure'));assert.equal(config.length,1);assert.equal(config[0].payload.enabled,true);check('Explicit restore issues one enabled request after a security pause');
  await application.evaluate(()=>{globalThis.__syncProgressFixture.hold=true;});await page.locator('#sync-latest').click();await page.waitForFunction(()=>document.getElementById('sync-latest').disabled);await page.locator('#sync-latest').evaluate(el=>el.click());
  assert.equal((await application.evaluate(()=>globalThis.__syncProgressFixture.requests.filter(x=>x.action==='sync'))).length,1);
  await application.evaluate(()=>{const f=globalThis.__syncProgressFixture;f.hold=false;f.release?.();f.release=null;});await page.waitForFunction(()=>document.getElementById('toast').textContent.includes('仍未补齐'));assert.doesNotMatch(await page.locator('#toast').textContent(),/同步完成/);check('Manual click submits once; unfinished toast retains gap instead of declaring complete');
  await application.evaluate(()=>{globalThis.__syncProgressFixture.failNext=true;});await page.locator('#sync-latest').click();await page.waitForFunction(()=>document.getElementById('toast').textContent.includes('模拟断网'));await page.waitForFunction(()=>document.getElementById('sync-gap-line').textContent.includes('1,280'));
  const failed=await sample();unchanged(before,failed);samples.push({stage:'manual-error-with-saved-progress',...failed});assert.equal(await page.locator('#toast').evaluate(el=>el.classList.contains('error')),true);check('Failed manual page reports failure and refreshes already-saved progress without a false success');
  await stage({latestPending:null,latestPendingRanges:[],syncProgress:{phase:'joined',added:2200,reason:''}},{running:false,blocked:false,error:'',errorCode:'',pausedReason:''});await page.waitForFunction(()=>document.getElementById('sync-gap-line').textContent.includes('已与本机记录衔接'));
  const joined=await sample();unchanged(before,joined);samples.push({stage:'joined',...joined});assert.equal(await page.locator('#sync-latest').textContent(),'同步最新');check('Only joined progress claims this scan has rejoined; unread and anchor remain unchanged');
  await page.locator('[data-group-id="'+fixture.groups[1].id+'"]').click();await page.waitForFunction(id=>document.querySelector('#group-list .active').dataset.groupId===id,fixture.groups[1].id);await page.waitForFunction(()=>document.getElementById('sync-gap-line').textContent.includes('1,200'));
  assert.equal(await page.locator('#sync-latest').textContent(),'补齐离线消息');check('Switching groups shows that group progress instead of the previous joined state');
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1100,760));await page.waitForTimeout(200);
  const layout=await page.evaluate(()=>{const gap=document.getElementById('sync-gap-line'),status=document.getElementById('sync-status-line'),scroll=document.getElementById('message-scroll'),buttons=[...document.querySelectorAll('.header-actions button')];return{gapHeight:gap.getBoundingClientRect().height,statusHeight:status.getBoundingClientRect().height,headerBottom:document.getElementById('workspace-header').getBoundingClientRect().bottom,scrollTop:scroll.getBoundingClientRect().top,buttonWithin:buttons.every(b=>b.getBoundingClientRect().right<=innerWidth)};});assert.equal(layout.gapHeight,16);assert.equal(layout.statusHeight,16);assert.ok(layout.headerBottom<=layout.scrollTop);assert.equal(layout.buttonWithin,true);check('Compact Windows layout keeps status and controls outside the reading viewport');
  await page.screenshot({path:path.join(evidence,'synthetic-backfill-progress.png')});
  const audit=await application.evaluate(()=>({blocked:globalThis.__syncProgressFixture.blocked,requests:globalThis.__syncProgressFixture.requests,readCalls:globalThis.__syncProgressFixture.readCalls}));assert.deepEqual(audit.blocked,[]);assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(evidence,'audit.json'),JSON.stringify({preflight,audit,layout},null,2));
 }catch(e){failure=String(e.stack||e);console.error(failure);}
 finally{
  if(application)await application.close().catch(e=>{failure||='Test app close failed: '+String(e);});
  const rendererUnchanged=owned.every(f=>hash(path.join(root,'app/renderer',f))===hashes[f]);
  const passed=!failure&&rendererUnchanged;
  fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({passed,failure,checks,samples,errors,rendererUnchanged,hashes,harness,scope:'Copied production app, independent synthetic Store, local IPC fixtures, all service transports blocked; no real data or credentials',at:new Date().toISOString()},null,2));
  console.log(JSON.stringify({passed,report:path.join(evidence,'result.json')}));if(!passed)process.exitCode=1;
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
