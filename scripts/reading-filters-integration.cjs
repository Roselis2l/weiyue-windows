'use strict';
// Real copied Windows app, synthetic accounts only. This harness never opens the
// installed application, existing data, or an external service.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {assertWindowsRuntimeReadable}=require('./windows-runtime-check.cjs');
const root=path.resolve(__dirname,'..'),sourceVersion=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
const evidence=path.resolve(process.env.WEIYUE_READING_FILTERS_OUTPUT||path.join(root,'artifacts','reading-filters-integration-'+new Date().toISOString().replace(/[:.]/g,'-')));
const harness=fs.mkdtempSync(path.join(os.tmpdir(),'weiyue-reading-filters-')),dataDir=path.join(harness,'data');
fs.mkdirSync(evidence,{recursive:true});fs.mkdirSync(dataDir);
fs.cpSync(path.join(root,'vendor/runtime'),path.join(harness,'runtime'),{recursive:true});
fs.cpSync(path.join(root,'app'),path.join(harness,'app'),{recursive:true});
const executablePath=path.join(harness,'runtime/electron.exe'),hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sourceHashes=Object.fromEntries(fs.readdirSync(path.join(harness,'app'),{recursive:true}).filter(file=>fs.statSync(path.join(harness,'app',file)).isFile()).map(file=>[file,hash(path.join(harness,'app',file))]));
const fixtures={identity:'9007199254740993998',accountId:'weibo-9007199254740993998',groups:[
  {key:'A',id:'9007199254740996101',name:'长列表定位甲群',count:640,anchor:30,through:520},
  {key:'B',id:'9007199254740996102',name:'跨群定位乙群',count:640,anchor:15,through:100},
  {key:'C',id:'9007199254740996103',name:'尚无阅读进度群',count:12,anchor:0,through:null}
]};
const base=Date.parse('2026-10-20T00:00:00Z'),names=['同名成员','同名成员','林岚','周舟'];
const group=key=>fixtures.groups.find(g=>g.key===key);
const messages=fixtures.groups.flatMap((g,gi)=>{
  g.ids=Array.from({length:g.count},(_,i)=>String(9007199254741200000n+BigInt(gi*10000+i)));
  return g.ids.map((id,i)=>({id,groupId:g.id,senderId:String(71+i%4),senderName:names[i%4],mediaVersion:1,attachmentVersion:1,
    time:base+i*60000+(i===120?59999:(i%3)*20000),
    text:`${g.key} 第 ${i} 条 ${i%2===0?'共同关键词':''} 合成阅读验收。`+
      (i===520?'\n高水位长消息；用于检查完整窗口和阅读边界。'.repeat(6):'')}));
});
const {Store}=require(path.join(harness,'app/core/store.cjs'));
const store=new Store(path.join(dataDir,'accounts'));
store.ensureAccount({id:fixtures.accountId,kind:'weibo',name:'完全合成的阅读筛选验收账号'});
store.mergeMessages(fixtures.accountId,fixtures.groups.map(({id,name})=>({id,name,selected:true})),messages,{history:true});
store.update(fixtures.accountId,state=>{
  state.settings.autoSyncEnabled=false;state.importantMembers=['71'];
  for(const [i,g]of fixtures.groups.entries()){
    state.readPositions[g.id]=g.ids[g.anchor];
    state.readStates[g.id]={anchorId:g.ids[g.anchor],anchorOffset:0,atBottom:false,
      readThroughId:g.through===null?null:g.ids[g.through],unreadIds:g.through===null?[]:g.ids.slice(g.through+1),updatedAt:3000-i*1000};
  }
});
fs.writeFileSync(path.join(dataDir,'preferences.json'),JSON.stringify({activeId:fixtures.accountId}));
function boot(fixtures){
  const {app,net,session,ipcMain,safeStorage}=require('electron'),path=require('node:path');
  const {Store}=require('./app/core/store.cjs');
  const testStore=new Store(path.join(process.argv.find(x=>x.startsWith('--data-dir=')).slice(11),'accounts'));
  const pending=new Map();let releaseGate;
  const info=globalThis.__readingFilters={blocked:[],apiCalls:[],readCalls:[],queryCalls:[],held:false,hold:null,
    armHold(action,payload){this.hold={action,payload};this.held=false;},
    release(){const release=releaseGate;releaseGate=null;this.held=false;release?.();},
    queue(groupId,count){
      const previous=testStore.get(fixtures.accountId).messages.filter(m=>m.groupId===groupId),last=previous.at(-1);
      const added=Array.from({length:count},(_,i)=>({id:String(BigInt(last.id)+BigInt(i+1)),groupId,
        senderId:'71',senderName:'同名成员',time:last.time+(i+1)*60000,text:'合成的新到达消息 '+(i+1),mediaVersion:1,attachmentVersion:1}));
      pending.set(groupId,[...added].reverse().concat(last));return added.map(m=>m.id);
    },
    enableSyntheticSession(){
      const {Vault}=require('./app/core/security.cjs');
      new Vault(path.resolve(app.getPath('userData'),'../credentials'),safeStorage).write(fixtures.accountId,{cookies:[{
        name:'SUB',value:'synthetic-reading-filters-only',domain:'api.weibo.com',path:'/',secure:true,httpOnly:true,hostOnly:true
      }]});
    }};
  const handle=ipcMain.handle.bind(ipcMain);
  ipcMain.handle=(channel,handler)=>handle(channel,async(event,action,payload={})=>{
    if(channel==='weiyue:call'){
      if(action==='read.set')info.readCalls.push({at:Date.now(),payload:{...payload}});
      if(action==='messages.query')info.queryCalls.push({at:Date.now(),payload:{...payload}});
    }
    const answer=await handler(event,action,payload);
    if(channel==='weiyue:call'&&info.hold?.action===action&&Object.entries(info.hold.payload).every(([k,v])=>payload[k]===v)){
      info.hold=null;info.held=true;await new Promise(resolve=>{releaseGate=resolve;});
    }
    return answer;
  });
  const fetch=net.fetch.bind(net),request=net.request.bind(net);
  net.fetch=(url,opts)=>/^https?:/i.test(String(url))?(info.blocked.push('net.fetch'),Promise.reject(Error('EXTERNAL_BLOCKED'))):fetch(url,opts);
  net.request=options=>{
    if(/^https?:/i.test(typeof options==='string'?options:options.url)){info.blocked.push('net.request');throw Error('EXTERNAL_BLOCKED');}
    return request(options);
  };
  const attached=new WeakSet();
  const attach=s=>{
    if(attached.has(s))return;attached.add(s);
    s.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,callback)=>{info.blocked.push('webRequest');callback({cancel:true});});
    const original=s.fetch.bind(s);
    s.fetch=async(target,options)=>{
      const u=new URL(String(target));if(['app:','file:'].includes(u.protocol))return original(target,options);
      info.apiCalls.push({path:u.pathname,at:Date.now()});
      if(u.origin==='https://api.weibo.com'&&u.pathname==='/webim/query_primary_info.json')return Response.json({profile:{id:fixtures.identity,screen_name:'合成账号'}});
      if(u.origin==='https://api.weibo.com'&&u.pathname==='/webim/2/direct_messages/contacts.json')return Response.json({contacts:fixtures.groups.map(g=>({user:{type:2,id:g.id,name:g.name}}))});
      if(u.origin==='https://api.weibo.com'&&u.pathname==='/webim/groupchat/query_messages.json'){
        const groupId=u.searchParams.get('id');
        if(!fixtures.groups.some(g=>g.id===groupId))throw Error('UNEXPECTED_SYNTHETIC_GROUP');
        const previous=testStore.get(fixtures.accountId).messages.filter(m=>m.groupId===groupId);
        const batch=pending.get(groupId)||[previous.at(-1)];
        return Response.json({has_more:1,messages:batch.map(m=>({id:m.id,gid:m.groupId,from_uid:m.senderId,
          from_user:{screen_name:m.senderName},time:m.time/1000,content:m.text}))});
      }
      info.blocked.push('session.fetch');throw Error('EXTERNAL_BLOCKED');
    };
  };
  app.on('session-created',attach);app.whenReady().then(()=>attach(session.defaultSession));
  require('./app/main.cjs');
}
fs.writeFileSync(path.join(harness,'boot.cjs'),'('+boot.toString()+')('+JSON.stringify(fixtures)+');');
let application,page,stage='prepare',failure=null;
const checks=[],errors=[],launches=[],runs=[],samples=[];
const check=text=>{checks.push(text);console.log('PASS '+text);};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,timeout=10000){const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await fn())return;await delay(100);}throw Error(label);}
const api=(action,payload={})=>page.evaluate(({action,payload})=>window.api.call(action,payload),{action,payload});
async function launch(){
  const preflight=assertWindowsRuntimeReadable(executablePath),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  application=await _electron.launch({executablePath,args:[path.join(harness,'boot.cjs'),'--data-dir='+dataDir],cwd:harness,env,timeout:30000});
  const native=application.process(),record={pid:native.pid,startedAt:new Date().toISOString(),preflight};launches.push(record);
  native.once('exit',(exitCode,signal)=>Object.assign(record,{exitCode,signal}));
  native.stderr?.on('data',bytes=>fs.appendFileSync(path.join(evidence,'native.stderr.log'),bytes));
  page=await application.firstWindow();page.on('pageerror',e=>errors.push(e.message));
  await application.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setSize(1440,930);w.show();w.focus();w.webContents.focus();});
  await page.waitForSelector('article[data-message-id]');await page.waitForTimeout(800);
}
async function close(){
  if(!application)return;
  await application.evaluate(()=>globalThis.__readingFilters.release()).catch(()=>{});
  runs.push(await application.evaluate(()=>{const i=globalThis.__readingFilters;return{blocked:i.blocked,apiCalls:i.apiCalls,readCalls:i.readCalls,queryCalls:i.queryCalls};}));
  await application.close();application=null;
}
async function snapshot(){
  return page.evaluate(async()=>{
    const state=await window.api.call('state'),groupId=document.querySelector('#group-list .active')?.dataset.groupId,r=state.readStates[groupId];
    const scroll=document.getElementById('message-scroll'),bounds=scroll.getBoundingClientRect();
    const first=[...scroll.querySelectorAll('[data-message-id]')].find(e=>e.getBoundingClientRect().bottom>bounds.top+1);
    return{groupId,readThroughId:r.readThroughId,unread:r.unreadCount,anchorId:r.anchorId,
      firstId:first?.dataset.messageId,offset:first?first.getBoundingClientRect().top-bounds.top:null,
      visibleIds:[...scroll.querySelectorAll('[data-message-id]')].filter(e=>{const r=e.getBoundingClientRect();return r.bottom>bounds.top+1&&r.top<bounds.bottom-1;}).map(e=>e.dataset.messageId),
      loadedIds:[...scroll.querySelectorAll('[data-message-id]')].map(e=>e.dataset.messageId),
      keyword:document.getElementById('message-search').value,start:document.getElementById('reading-start').value,end:document.getElementById('reading-end').value,
      selectedMembers:[...document.querySelectorAll('#member-filter .member-picker-option input:checked')].map(e=>e.value),
      important:document.getElementById('important-filter')?.checked||false,
      right:document.getElementById('new-messages-count').textContent,bounds:{x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height}};
  });
}
function sameRead(actual,expected){assert.equal(actual.readThroughId,expected.readThroughId,'READ_THROUGH_CHANGED_WITHOUT_INTENT');assert.equal(actual.unread,expected.unread,'UNREAD_CHANGED_WITHOUT_INTENT');}
function atTarget(actual,id){assert.equal(actual.firstId,id,'TARGET_NOT_FIRST_VISIBLE');assert.ok(Math.abs(actual.offset)<=2,'TARGET_OFFSET_CHANGED');}
async function chooseGroup(key){const g=group(key);await page.locator('[data-group-id="'+g.id+'"]').click();await until(()=>snapshot().then(s=>s.groupId===g.id),'GROUP_SWITCH_FAILED');await delay(700);return snapshot();}
async function clickReadTarget(expected){
  const before=await snapshot(),count=await application.evaluate(()=>globalThis.__readingFilters.readCalls.length);
  await page.locator('#jump-latest-read').click();
  await until(()=>snapshot().then(s=>s.firstId===expected&&Math.abs(s.offset)<=2),'LATEST_READ_TARGET_FAILED');
  await delay(750);const after=await snapshot();atTarget(after,expected);sameRead(after,before);
  const writes=await application.evaluate((_electron,index)=>globalThis.__readingFilters.readCalls.slice(index),count);
  assert.ok(writes.every(c=>!('readThroughId'in c.payload)&&!('seenId'in c.payload)),'LATEST_READ_GRANTED_READ_PERMISSION');
  samples.push({stage,before,after});return after;
}
async function ensureAdvanced(){if(!await page.locator('#reading-start').isVisible())await page.locator('#filter-toggle').click();}
async function setMember(id,checked=true){
  const input=page.locator('#member-filter .member-picker-option input[value="'+id+'"]');
  if(!await input.isVisible())await page.locator('#member-filter .member-picker-toggle').click();
  await input.setChecked(checked);await delay(550);
}
async function closeMemberPicker(){
  if(await page.locator('#member-filter .member-picker-search').isVisible())await page.locator('#member-filter .member-picker-toggle').click();
}
async function displayedIds(){return page.locator('article[data-message-id]').evaluateAll(elements=>elements.map(e=>e.dataset.messageId));}
(async()=>{
  try{
    stage='launch';await launch();const initial=await snapshot();atTarget(initial,group('A').ids[30]);sameRead(initial,{readThroughId:group('A').ids[520],unread:119});
    assert.equal((await api('state')).account.id,fixtures.accountId);
    assert.equal(path.resolve((await api('state')).dataRoot),dataDir);
    assert.ok(await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().every(w=>{const p=w.webContents.getLastWebPreferences();return p.sandbox&&p.contextIsolation&&p.webSecurity&&!p.nodeIntegration;})));
    const placement=await page.locator('#jump-latest-read').evaluate(button=>({footer:!!button.closest('.reading-footer'),insideScroll:!!button.closest('#message-scroll'),disabled:button.disabled}));
    assert.ok(placement.footer&&!placement.insideScroll&&!placement.disabled,'LATEST_READ_BUTTON_PLACEMENT');
    check('Actual sandboxed main/preload/renderer starts in a synthetic long group; latest-read control is outside scrolling messages');

    stage='long-window-target';await clickReadTarget(group('A').ids[520]);assert.ok(!(await displayedIds()).includes(group('A').ids[30]));
    check('Latest-read navigation loads a different page around exact high-water ID without moving to latest unread or consuming unread');
    stage='no-high-water';await chooseGroup('C');assert.ok(await page.locator('#jump-latest-read').isDisabled(),'NO_HIGH_WATER_BUTTON_ENABLED');
    const empty=await snapshot();await delay(700);sameRead(await snapshot(),empty);
    await chooseGroup('A');
    check('A group with no high-water mark disables the control and does not infer a read boundary');

    stage='member-or';
    await page.locator('#member-filter .member-picker-toggle').click();
    const memberSearch=page.locator('#member-filter .member-picker-search');
    await memberSearch.fill('同名');
    assert.equal(await page.locator('#member-filter .member-picker-option:visible').count(),2,'CHINESE_MEMBER_SEARCH_FAILED');
    await memberSearch.fill('71');
    assert.equal(await page.locator('#member-filter .member-picker-option:visible').count(),1,'MEMBER_ID_SEARCH_FAILED');
    await memberSearch.fill('');await setMember('71');await setMember('72');await closeMemberPicker();
    await until(()=>api('messages.query',{groupId:group('A').id,senderIds:['71','72'],limit:2000}).then(r=>r.total===320),'MEMBER_BACKEND_OR_FAILED');
    const listed=await displayedIds();assert.ok(listed.length>1&&listed.every(id=>[0,1].includes(group('A').ids.indexOf(id)%4)),'MEMBER_UI_OR_FAILED');
    assert.deepEqual([...new Set(listed.map(id=>group('A').ids.indexOf(id)%4))].sort(),[0,1],'MEMBER_UI_MISSING_SELECTED_MEMBER');
    const queries=await application.evaluate(()=>globalThis.__readingFilters.queryCalls);
    assert.ok(queries.some(c=>Array.isArray(c.payload.senderIds)&&c.payload.senderIds.length===2&&c.payload.senderIds.includes('71')&&c.payload.senderIds.includes('72')),'MEMBER_MULTI_PAYLOAD_MISSING');
    assert.equal(await page.locator('#member-filter .member-picker-option input[value="71"]').count(),1);
    assert.equal(await page.locator('#member-filter .member-picker-option input[value="72"]').count(),1);
    check('Two same-name members are selected by distinct lexical IDs; UI query uses senderIds with OR semantics');

    stage='minute-boundaries';await ensureAdvanced();
    await page.locator('#reading-start').fill('2026-10-20T09:40');await page.locator('#reading-start').press('Tab');
    await page.locator('#reading-end').fill('2026-10-20T10:00');await page.locator('#reading-end').press('Tab');
    await page.locator('#message-search').fill('共同关键词');await page.locator('#message-search').press('Enter');await delay(800);
    const expected=messages.filter(m=>m.groupId===group('A').id&&['71','72'].includes(m.senderId)&&m.text.includes('共同关键词')&&m.time>=Date.parse('2026-10-20T01:40:00Z')&&m.time<Date.parse('2026-10-20T02:01:00Z')).map(m=>m.id);
    assert.deepEqual(await displayedIds(),expected,'BEIJING_MINUTE_OR_COMBINED_FILTER_FAILED');
    assert.ok(expected.includes(group('A').ids[120]),'END_MINUTE_FIXTURE_MISSING');
    sameRead(await snapshot(),{readThroughId:group('A').ids[520],unread:119});
    check('Keyword, multiple senders and Beijing start/end timestamps intersect correctly; end includes the final 59.999 seconds');

    stage='clear-blocking-filters';await page.locator('#important-filter').check();await delay(600);
    await clickReadTarget(group('A').ids[520]);const cleared=await snapshot();
    assert.equal(cleared.keyword,'');assert.equal(cleared.start,'');assert.equal(cleared.end,'');assert.deepEqual(cleared.selectedMembers,[]);assert.equal(cleared.important,false);
    check('Latest-read clears keyword/member/date/important filters and the old filter return anchor without read permission');

    stage='late-filter-response';await application.evaluate(()=>globalThis.__readingFilters.armHold('messages.query',{keyword:'共同关键词'}));
    await page.locator('#message-search').fill('共同关键词');await page.locator('#message-search').press('Enter');
    await until(()=>application.evaluate(()=>globalThis.__readingFilters.held),'FILTER_HOLD_NOT_REACHED');
    await page.locator('#jump-latest-read').click();await delay(300);
    await application.evaluate(()=>globalThis.__readingFilters.release());
    await until(()=>snapshot().then(s=>s.keyword===''&&s.firstId===group('A').ids[520]),'LATE_FILTER_OVERWROTE_TARGET');
    await delay(750);sameRead(await snapshot(),cleared);
    check('A delayed old keyword response cannot overwrite latest-read navigation');

    stage='late-locate-cross-group';await application.evaluate((_electron,arg)=>globalThis.__readingFilters.armHold('messages.locate',arg),{groupId:group('A').id,messageId:group('A').ids[520]});
    await page.locator('#jump-latest-read').click();await until(()=>application.evaluate(()=>globalThis.__readingFilters.held),'LOCATE_HOLD_NOT_REACHED');
    const b=await chooseGroup('B');await application.evaluate(()=>globalThis.__readingFilters.release());await delay(800);
    const bAfter=await snapshot();assert.equal(bAfter.groupId,group('B').id);sameRead(bAfter,b);atTarget(bAfter,b.firstId);
    await clickReadTarget(group('B').ids[100]);await chooseGroup('A');atTarget(await snapshot(),group('A').ids[520]);
    check('A late locate for A cannot overwrite B; each group independently restores its own navigation anchor and high-water mark');

    stage='programmatic-scroll-negative';const passive=await snapshot();
    await page.locator('#message-scroll').evaluate(scroll=>{scroll.scrollTop+=180;});await delay(800);sameRead(await snapshot(),passive);
    await clickReadTarget(passive.readThroughId);
    check('Programmatic scrolling and target restoration do not reduce unread');

    stage='empty-members-native-read';const nativeBefore=await snapshot();
    await application.evaluate(({BrowserWindow},bounds)=>{
      const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()==='app://local/index.html');w.focus();w.webContents.focus();
      const x=Math.floor(bounds.x+bounds.width/2),y=Math.floor(bounds.y+bounds.height/2);
      w.webContents.sendInputEvent({type:'mouseMove',x,y});w.webContents.sendInputEvent({type:'mouseWheel',x,y,deltaX:0,deltaY:-650,canScroll:true});
    },nativeBefore.bounds);
    await delay(1400);const nativeAfter=await snapshot();
    assert.ok(nativeAfter.unread<nativeBefore.unread&&nativeAfter.unread>0,'EMPTY_MEMBER_FILTER_PREVENTED_NATIVE_READ');
    assert.notEqual(nativeAfter.readThroughId,nativeBefore.readThroughId);
    await clickReadTarget(nativeAfter.readThroughId);
    check('After member filters are cleared, genuine downward input still advances only the visible completed read boundary');

    stage='automatic-sync';await application.evaluate(()=>globalThis.__readingFilters.enableSyntheticSession());
    const beforeTick=await snapshot(),newIds=await application.evaluate((_electron,id)=>globalThis.__readingFilters.queue(id,3),group('A').id);
    const enabledAt=Date.now(),configured=await api('sync.configure',{enabled:true});assert.equal(configured.intervalMs,60000);
    assert.ok(configured.nextRunAt>=enabledAt+59000,'AUTOMATIC_TIMER_NOT_REAL_60_SECONDS');
    console.log('WAIT actual 60-second timer; all responses are local synthetic fixtures');
    let status;
    for(let i=0;i<9;i++){await delay(10000);status=await api('sync.status');if(status.lastSuccessAt>=enabledAt)break;}
    assert.ok(status.lastSuccessAt>=enabledAt,'AUTOMATIC_SYNC_DID_NOT_COMPLETE');
    await api('sync.configure',{enabled:false});await delay(2500);
    const afterTick=await snapshot();assert.equal(afterTick.readThroughId,beforeTick.readThroughId);assert.equal(afterTick.unread,beforeTick.unread+3);atTarget(afterTick,beforeTick.firstId);
    assert.ok(!afterTick.visibleIds.includes(newIds.at(-1)),'NEW_MESSAGE_FORCED_LONG_WINDOW_TO_TAIL');
    check('A real 60-second automatic sync adds three unread messages without moving the long-window target or read boundary');

    stage='restart';const restartExpected=await snapshot();await close();await launch();const restarted=await snapshot();
    assert.equal(restarted.groupId,restartExpected.groupId);sameRead(restarted,restartExpected);atTarget(restarted,restartExpected.firstId);
    const all=(await api('state')).readStates;assert.equal(all[group('B').id].readThroughId,group('B').ids[100]);assert.equal(all[group('B').id].unreadCount,539);
    assert.equal(all[group('C').id].readThroughId,null);
    check('Actual close and restart restore latest-read target, independent group high-water marks and remaining unread');
    assert.deepEqual(errors,[]);stage='complete';
    await page.screenshot({path:path.join(evidence,'synthetic-restart.png')});
  }catch(error){failure=String(error.stack||error);console.error(failure);}
  finally{
    await close().catch(error=>{failure||='CLOSE_FAILED '+String(error);});
    const sourceStillMatches=Object.entries(sourceHashes).every(([file,value])=>hash(path.join(root,'app',file))===value);
    const blocked=runs.flatMap(r=>r.blocked),nativeExitedCleanly=launches.length===2&&launches.every(r=>r.exitCode===0&&r.signal===null);
    const passed=!failure&&!errors.length&&!blocked.length&&sourceStillMatches&&nativeExitedCleanly;
    const result={passed,stage,failure,checks,errors,samples,launches,runs,blocked,sourceVersion,sourceHashes,sourceStillMatches,nativeExitedCleanly,harness,dataDir,executablePath,
      scope:'Actual copied Windows app, synthetic three-group data, locally mocked 60-second sync, no installed application or real account'};
    fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed,checks:checks.length,report:path.join(evidence,'result.json'),stage,sourceStillMatches,nativeExitedCleanly}));
    if(!passed)process.exitCode=1;
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
