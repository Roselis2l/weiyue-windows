'use strict';

// Real copied main/preload/renderer. Reading progress is driven only by native
// webContents input; mocked sync and false-returning breakpoints control timing
// and observe state without changing the app's reading logic.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { assertWindowsRuntimeReadable } = require('./windows-runtime-check.cjs');

const root = path.resolve(__dirname, '..');
const evidence = path.join(root, 'artifacts', 'reading-refresh-integration-'+new Date().toISOString().replace(/[:.]/g,'-'));
const harness = fs.mkdtempSync(path.join(os.tmpdir(), 'weiyue-reading-refresh-'));
const dataDir = path.join(harness, 'data');
fs.mkdirSync(evidence, { recursive: true });
fs.mkdirSync(dataDir);
fs.cpSync(path.join(root, 'vendor', 'runtime'), path.join(harness, 'runtime'), { recursive: true });
fs.cpSync(path.join(root, 'app'), path.join(harness, 'app'), { recursive: true });
const executablePath = path.join(harness, 'runtime', 'electron.exe');
const sourceVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sourceHashes = Object.fromEntries(fs.readdirSync(path.join(harness, 'app'), { recursive: true })
  .filter(file => fs.statSync(path.join(harness, 'app', file)).isFile())
  .map(file => [file, hash(path.join(harness, 'app', file))]));
fs.cpSync(path.join(harness,'app'),path.join(evidence,'frozen-app'),{recursive:true,errorOnExist:true,force:false});
const fixture = { identity: '9007199254740993999', accountId: 'weibo-9007199254740993999', groups: [
  { key: 'A', id: '9007199254740995101', name: '原生平滑滚轮', count: 160, anchor: 30 },
  { key: 'B', id: '9007199254740995102', name: '原生慢速滚动条', count: 160, anchor: 30 },
  { key: 'C', id: '9007199254740995103', name: '保存等待期与新到消息', count: 5, anchor: 1 },
] };
const { Store } = require(path.join(harness, 'app', 'core', 'store.cjs'));
const store = new Store(path.join(dataDir, 'accounts'));
store.ensureAccount({ id: fixture.accountId, kind: 'weibo', name: '原生输入离线模拟账号' });
const groups = fixture.groups.map(group => ({ id: group.id, name: group.name, selected: true }));
const messages = fixture.groups.flatMap((group, groupIndex) => {
  group.ids = Array.from({ length: group.count }, (_, index) => String(9007199254741100000n + BigInt(groupIndex * 1000 + index)));
  group.anchorId = group.ids[group.anchor];
  return group.ids.map((id, index) => ({ id, groupId: group.id, senderId: '71', senderName: '模拟成员',
    time: 1700000000000 + index * 60000, mediaVersion: 1,
    text: group.key==='C'?`C 第 ${index} 条模拟消息。`:`${group.key} 第 ${index} 条原生输入验收消息。\n这些记录完全由测试生成，不包含任何真实群聊。` +
      (index === 10 ? '\n已读上下文中的额外文本行，用于覆盖非等高消息。'.repeat(7) : '') }));
});
store.mergeMessages(fixture.accountId, groups, messages, { history: true });
store.update(fixture.accountId, state => {
  state.settings.autoSyncEnabled = false;
  for (const [index, group] of fixture.groups.entries()) {
    state.readPositions[group.id] = group.anchorId;
    state.readStates[group.id] = { anchorId: group.anchorId, anchorOffset: -12, atBottom: false,
      readThroughId: group.ids[group.anchor - 1], unreadIds: group.ids.slice(group.anchor), updatedAt: 2000 - index * 1000 };
  }
});
fs.writeFileSync(path.join(dataDir, 'preferences.json'), JSON.stringify({ activeId: fixture.accountId }));

function boot(fixtures) {
  const { app, net, session, ipcMain } = require('electron');
  const path = require('node:path');
  const { Store } = require('./app/core/store.cjs');
  const data = process.argv.find(value => value.startsWith('--data-dir=')).slice(11);
  const testStore = new Store(path.join(data, 'accounts'));
  const pending = new Map();
  let releasePollGate=null;
  const info = globalThis.__nativeReading = { blocked: [], apiCalls: [], readCalls: [], holdPoll:false, pollHeld:false, armPoll(){this.holdPoll=true;}, releasePoll(){if(releasePollGate){const release=releasePollGate;releasePollGate=null;this.pollHeld=false;release();}}, queue(groupId, count) {
    const previous = testStore.get(fixtures.accountId).messages.filter(message => message.groupId === groupId);
    const last = previous.at(-1);
    const added = Array.from({ length: count }, (_, index) => ({ id: String(BigInt(last.id) + BigInt(index + 1)),
      groupId, senderId: '71', senderName: '模拟成员', time: last.time + (index + 1) * 60000,
      text: `被动到达的第 ${index + 1} 条离线模拟消息。`, mediaVersion: 1 }));
    pending.set(groupId, [...added].reverse().concat(last));
    return { ids: added.map(message => message.id), total: previous.length + count };
  } };
  const originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, handler) => originalHandle(channel, (event, action, payload) => {
    if (channel === 'weiyue:call' && action === 'read.set') info.readCalls.push({ at: Date.now(), payload });
    if(channel==='weiyue:call'&&action==='sync.status'&&info.holdPoll){info.holdPoll=false;info.pollHeld=true;return new Promise(resolve=>{releasePollGate=()=>resolve(handler(event,action,payload));});}
    return handler(event, action, payload);
  });
  const originalFetch = net.fetch.bind(net);
  net.fetch = (url, options) => {
    if (/^https?:/i.test(String(url))) { info.blocked.push(String(url)); return Promise.reject(Error('External fetch blocked')); }
    return originalFetch(url, options);
  };
  const originalRequest = net.request.bind(net);
  net.request = options => {
    const url = typeof options === 'string' ? options : options.url;
    if (/^https?:/i.test(String(url))) { info.blocked.push(String(url)); throw Error('Unexpected external request blocked'); }
    return originalRequest(options);
  };
  const attached = new WeakSet();
  const attach = current => {
    if (attached.has(current)) return;
    attached.add(current);
    current.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      info.blocked.push(details.url); callback({ cancel: true });
    });
    const original = current.fetch.bind(current);
    current.fetch = async (target, options) => {
      const url = new URL(String(target));
      if (['app:', 'file:'].includes(url.protocol)) return original(target, options);
      info.apiCalls.push(url.pathname);
      if (url.origin === 'https://api.weibo.com' && url.pathname === '/webim/query_primary_info.json') {
        return Response.json({ profile: { id: fixtures.identity, screen_name: '离线模拟账号' } });
      }
      if (url.origin === 'https://api.weibo.com' && url.pathname === '/webim/groupchat/query_messages.json') {
        const batch = pending.get(url.searchParams.get('id'));
        if (!batch) throw Error('No local sync fixture queued');
        return Response.json({ has_more: 1, messages: batch.map(message => ({ id: message.id, gid: message.groupId,
          from_uid: '71', from_user: { screen_name: message.senderName }, time: message.time / 1000, content: message.text })) });
      }
      info.blocked.push(String(target)); throw Error('Unexpected session fetch blocked');
    };
  };
  app.on('session-created', attach);
  app.whenReady().then(() => attach(session.defaultSession));
  require('./app/main.cjs');
}
fs.writeFileSync(path.join(harness, 'boot.cjs'), '(' + boot.toString() + ')(' + JSON.stringify(fixture) + ');\n');

let application, page;
const checks = [], errors = [], launches = [], samples = [], inputRuns = [], networkRuns = [], coverageFailures = [];
const check = text => { checks.push(text); console.log('PASS ' + text); };
const group = key => fixture.groups.find(item => item.key === key);
const api = (action, payload = {}) => page.evaluate(({ action, payload }) => window.api.call(action, payload), { action, payload });
async function launch() {
  const preflight = assertWindowsRuntimeReadable(executablePath);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({ executablePath, args: [path.join(harness, 'boot.cjs'), '--data-dir=' + dataDir], cwd: harness, env, timeout: 30000 });
  const native = application.process(), record = { pid: native.pid, startedAt: new Date().toISOString(), preflight };
  launches.push(record);
  native.once('exit', (exitCode, signal) => Object.assign(record, { exitCode, signal, exitedAt: new Date().toISOString() }));
  native.stderr?.on('data', bytes => fs.appendFileSync(path.join(evidence, 'native.stderr.log'), bytes));
  record.versions = await application.evaluate(() => process.versions);
  page = await application.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(1440, 930); window.show(); window.focus(); window.webContents.focus(); });
  await page.waitForSelector('article[data-message-id]');
  await page.evaluate(() => {
    globalThis.__nativeInputEvidence = [];
    for (const type of ['wheel', 'pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'mousemove', 'mouseup', 'scroll']) {
      document.addEventListener(type, event => {
        const scroll = document.getElementById('message-scroll');
        if (event.target !== scroll && !scroll?.contains(event.target)) return;
        globalThis.__nativeInputEvidence.push({ type, at: performance.now(), trusted: event.isTrusted,
          groupId: document.querySelector('#group-list .active')?.dataset.groupId,
          scrollTop: scroll.scrollTop, deltaY: event.deltaY ?? null, buttons: event.buttons ?? null,
          targetIsScroll: event.target === scroll, x: event.clientX ?? null, y: event.clientY ?? null });
      }, { capture: true, passive: true });
    }
  });
  await page.waitForFunction(() => document.hasFocus() && document.visibilityState === 'visible');
  await page.waitForTimeout(900);
}
async function close() {
  if (!application) return;
  inputRuns.push(await page.evaluate(() => globalThis.__nativeInputEvidence).catch(() => []));
  networkRuns.push(await application.evaluate(() => ({ blocked: globalThis.__nativeReading.blocked,
    apiCalls: globalThis.__nativeReading.apiCalls, readCalls: globalThis.__nativeReading.readCalls })));
  await application.close(); application = null;
}
async function sample() {
  return page.evaluate(async () => {
    const state = await window.api.call('state');
    const groupId = document.querySelector('#group-list .active')?.dataset.groupId;
    const read = state.readStates[groupId], scroll = document.getElementById('message-scroll');
    const bounds = scroll.getBoundingClientRect();
    const articles = [...scroll.querySelectorAll('article[data-message-id]')];
    const first = articles.find(item => item.getBoundingClientRect().bottom > bounds.top + 1);
    const through = articles.find(item => item.dataset.messageId === read.readThroughId);
    return { groupId, unread: read.unreadCount, readThroughId: read.readThroughId, anchorId: read.anchorId,
      firstId: first?.dataset.messageId, firstOffset: first ? first.getBoundingClientRect().top - bounds.top : null,
      throughBottom: through ? through.getBoundingClientRect().bottom - bounds.top : null,
      scrollTop: scroll.scrollTop, scrollHeight: scroll.scrollHeight, clientHeight: scroll.clientHeight,
      clientWidth: scroll.clientWidth, offsetWidth: scroll.offsetWidth, devicePixelRatio,
      right: document.getElementById('new-messages-count').textContent,
      left: document.querySelector('#group-list .active .unread-badge')?.textContent,
      focus: document.hasFocus(), visible: document.visibilityState,
      bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }, events: globalThis.__nativeInputEvidence };
  });
}
function countsAgree(value, expected = value.unread) {
  assert.equal(value.unread, expected);
  assert.equal(Number.parseInt(value.right, 10), expected, 'Right unread label does not match persisted state');
  assert.equal(Number.parseInt(value.left, 10), expected, 'Sidebar unread badge does not match persisted state');
}
async function clearEvents() { await page.evaluate(() => { globalThis.__nativeInputEvidence = []; }); }
async function nativeInput(events) {
  await application.evaluate(({ BrowserWindow }, items) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL() === 'app://local/index.html');
    for (const event of items) window.webContents.sendInputEvent(event);
  }, events);
}
async function switchGroup(key) {
  await page.locator('[data-group-id="' + group(key).id + '"]').click();
  await page.waitForSelector('[data-group-id="' + group(key).id + '"].active');
  await page.waitForTimeout(1000);
  const value = await sample();
  assert.equal(value.groupId, group(key).id); assert.ok(Math.abs(value.firstOffset) <= 2, 'Group restore is not at anchor top');
  return value;
}
function scrollFrames(before, after) {
  let previous = before.scrollTop;
  return after.events.filter(event => event.type === 'scroll').map(event => {
    const frame = { ...event, delta: event.scrollTop - previous }; previous = event.scrollTop; return frame;
  });
}
function assertReadProgress(before, after) {
  assert.ok(after.scrollTop > before.scrollTop + 2, 'Native input did not move the actual viewport');
  assert.ok(after.unread < before.unread && after.unread > 0, 'Read progress must consume only a subset of unread');
  assert.notEqual(after.readThroughId, before.readThroughId);
  assert.ok(after.throughBottom > 0 && after.throughBottom <= after.clientHeight + 2, 'Read boundary is not visibly completed');
  countsAgree(after);
}

// Native-input refresh regression driver. No direct read.set or DOM scrolling.
let traceSession;
const breakpointSpecs=[];
async function observeReader() {
  await page.evaluate(()=>{globalThis.__readingRefreshTrace=[];});
  traceSession=await page.context().newCDPSession(page);await traceSession.send('Debugger.enable');
  const lines=fs.readFileSync(path.join(harness,'app','renderer','app.js'),'utf8').split(/\r?\n/);
  const probes=[
    ['invalidate','function invalidateReadingIntent(',"({held:model.pointerScrolling,context:readingContext(),stack:(new Error()).stack})"],
    ['queue-refresh','function queueReadingRefresh(',"({held:model.pointerScrolling,busy:readingBusy(),context:readingContext(),stack:(new Error()).stack})"],
    ['patch',"const existing=new Map([...scroll.querySelectorAll('[data-message-id]')]","({held:model.pointerScrolling,context:readingContext(),stack:(new Error()).stack})"],
    ['after-down',"if(event.pointerType==='touch')model.touchY=event.clientY;","({held:model.pointerScrolling,trusted:event.isTrusted,context:readingContext()})"],
    ['scroll-candidate','model.scrollTop=scroll.scrollTop;updateReadChrome();scheduleRead(candidate);',"({held:model.pointerScrolling,top:scroll.scrollTop,candidate:candidate?{id:candidate.readThroughId,context:candidate.context}:null,context:readingContext()})"],
    ['schedule','model.readTimer=setTimeout(',"({held:model.pointerScrolling,candidate:candidate?{id:candidate.readThroughId,context:candidate.context}:null,context:readingContext()})"]
  ];
  for(const [label,needle,expression] of probes) {
    const index=lines.findIndex(line=>line.includes(needle));assert.ok(index>=0,'Missing read-only observation seam '+label);
    const result=await traceSession.send('Debugger.setBreakpointByUrl',{lineNumber:index,urlRegex:'app://local/app\\.js$',
      condition:`(globalThis.__readingRefreshTrace.push({label:${JSON.stringify(label)},at:performance.now(),...${expression}}),false)`});
    breakpointSpecs.push({label,index,result});
  }
  assert.ok(breakpointSpecs.every(item=>item.result.locations.length===1));
}
async function detail() {
  const value=await sample();
  const extra=await page.evaluate(async()=>{
    const state=await window.api.call('state'),groupId=document.querySelector('#group-list .active').dataset.groupId;
    const scroll=document.getElementById('message-scroll'),top=scroll.getBoundingClientRect().top,stats=state.readStates[groupId];
    const items=[...scroll.querySelectorAll('[data-message-id]')].map(element=>{
      const box=element.getBoundingClientRect();return {id:element.dataset.messageId,top:box.top-top,bottom:box.bottom-top,
        imageCount:element.querySelectorAll('img').length,ready:[...element.querySelectorAll('img')].every(img=>img.complete&&(img.naturalWidth>0||img.hidden))};
    });
    return {firstUnreadId:stats.firstUnreadId,items,trace:globalThis.__readingRefreshTrace};
  });
  return {...value,...extra};
}
function thumbAt(value) {
  const thumb=Math.max(18,value.clientHeight*value.clientHeight/value.scrollHeight);
  return {x:Math.floor(value.bounds.x+value.bounds.width-5),
    y:Math.floor(value.bounds.y+(value.clientHeight-thumb)*value.scrollTop/(value.scrollHeight-value.clientHeight)+thumb/2)};
}
async function press(position) {
  await nativeInput([{type:'mouseMove',...position},{type:'mouseDown',...position,button:'left',clickCount:1}]);
}
async function moveRelease(position) {
  await nativeInput([{type:'mouseMove',x:position.x,y:position.y+3,movementX:0,movementY:3,modifiers:['leftButtonDown']}]);
  await page.waitForTimeout(80);
  await nativeInput([{type:'mouseUp',x:position.x,y:position.y+3,button:'left',clickCount:1}]);
  await page.waitForTimeout(1000);
}
async function resetEvidence() {
  await clearEvents();await page.evaluate(()=>{globalThis.__readingRefreshTrace=[];});
}
function assertNativeDrag(before,after) {
  const down=after.events.find(e=>e.type==='pointerdown'&&e.trusted&&e.targetIsScroll);
  const movement=after.events.find(e=>e.type==='scroll'&&e.scrollTop>before.scrollTop+1);
  assert.ok(down&&movement&&movement.at-down.at>=1500,'Need actual held native movement');
  assert.equal(after.events.filter(e=>e.type==='pointermove'&&e.trusted&&e.at>down.at&&e.at<=movement.at).length,0);
  assert.ok(after.scrollTop>before.scrollTop+2);
}
function visibleNewlyRead(before,after) {
  return after.items.filter(item=>BigInt(item.id)>BigInt(before.readThroughId)&&BigInt(item.id)<=BigInt(after.readThroughId)&&
    item.top>=0&&item.bottom<=after.clientHeight&&item.ready);
}
async function holdNaturalPoll() {
  await application.evaluate(()=>globalThis.__nativeReading.armPoll());
  for(let attempt=0;attempt<35;attempt++) {
    if(await application.evaluate(()=>globalThis.__nativeReading.pollHeld))return;
    await page.waitForTimeout(100);
  }
  throw Error('Natural two-second renderer poll did not reach the test transport gate');
}
async function releaseNaturalPoll() {
  await application.evaluate(()=>globalThis.__nativeReading.releasePoll());
}
(async()=>{
  let failure;
  fs.writeFileSync(path.join(evidence,'native.stderr.log'),'');
  try {
    await launch();await observeReader();
    const initialState=await api('state');assert.equal(initialState.account.id,fixture.accountId);assert.equal(path.resolve(initialState.dataRoot),dataDir);
    await resetEvidence();const beforeA=await detail();countsAgree(beforeA,130);
    const a=thumbAt(beforeA);await press(a);await page.waitForTimeout(1600);await moveRelease(a);
    const afterA=await detail();assertNativeDrag(beforeA,afterA);assertReadProgress(beforeA,afterA);
    samples.push({stage:'A-control-no-refresh',before:beforeA,after:afterA});
    check('Uninterrupted native long drag advances reading');

    await switchGroup('B');await resetEvidence();const beforeB=await detail();countsAgree(beforeB,130);
    const b=thumbAt(beforeB);await press(b);await page.waitForTimeout(100);
    const pressed=await detail();assert.ok(pressed.trace.some(item=>item.label==='after-down'&&item.held===true));
    await application.evaluate((_electron,id)=>globalThis.__nativeReading.queue(id,0),group('B').id);
    await api('sync',{groupId:group('B').id});
    await page.waitForFunction(()=>globalThis.__readingRefreshTrace.some(item=>item.label==='queue-refresh'&&item.held===true));
    await page.waitForTimeout(1700);
    const heldAfterRefresh=await detail();countsAgree(heldAfterRefresh,130);assert.equal(heldAfterRefresh.readThroughId,beforeB.readThroughId);
    assert.ok(Math.abs(heldAfterRefresh.scrollTop-beforeB.scrollTop)<=2);
    assert.equal(heldAfterRefresh.trace.filter(item=>item.label==='patch').length,0,'Refresh must be deferred while the native thumb is held');
    await moveRelease(b);const afterB=await detail();assertNativeDrag(beforeB,afterB);assertReadProgress(beforeB,afterB);
    assert.ok(visibleNewlyRead(beforeB,afterB).length,'A ready unread message must be fully visible and actually saved read');
    samples.push({stage:'B-sync-while-held-preserves-next-native-input',before:beforeB,pressed,heldAfterRefresh,after:afterB});
    check('Sync/poll refresh during native hold preserves subsequent actual user reading without reading during the hold');

    await switchGroup('C');await resetEvidence();const beforeC=await detail();countsAgree(beforeC,4);
    await holdNaturalPoll();
    const x=Math.floor(beforeC.bounds.x+beforeC.bounds.width/2),y=Math.floor(beforeC.bounds.y+beforeC.bounds.height/2);
    await nativeInput([{type:'mouseMove',x,y},{type:'mouseWheel',x,y,deltaX:0,deltaY:-200,canScroll:true}]);
    await page.waitForFunction(()=>{
      const events=globalThis.__nativeInputEvidence.filter(event=>event.type==='scroll');
      return events.length>0&&performance.now()-events.at(-1).at>=45;
    });
    const beforeSync=await detail();
    assert.ok(beforeSync.events.some(event=>event.type==='wheel'&&event.trusted&&event.deltaY>0));
    assert.ok(beforeSync.scrollTop>beforeC.scrollTop+2);assert.equal(beforeSync.readThroughId,beforeC.readThroughId,'Dwell already committed before interleave');
    const snapshotId=group('C').ids.at(-1);
    const scheduled=beforeSync.trace.filter(item=>item.label==='schedule'&&item.candidate?.id===snapshotId).at(-1);
    assert.ok(scheduled,'Native scroll must establish the old last-message snapshot before syncing');
    const queued=await application.evaluate((_electron,id)=>globalThis.__nativeReading.queue(id,2),group('C').id);
    await api('sync',{groupId:group('C').id});
    const duringSync=await api('state');assert.equal(duringSync.readStates[group('C').id].readThroughId,beforeC.readThroughId,'Dwell already committed before poll release');
    await releaseNaturalPoll();
    await page.waitForFunction(total=>document.getElementById('read-count')?.textContent.startsWith(String(total)),queued.total);
    await page.waitForTimeout(1000);
    const afterC=await detail();
    const queuedRefresh=afterC.trace.find(item=>item.label==='queue-refresh'&&item.at>scheduled.at);
    assert.ok(queuedRefresh&&queuedRefresh.at-scheduled.at<500,'Sync result must be received inside the original native 500ms dwell');
    const patch=afterC.trace.find(item=>item.label==='patch'&&item.at>queuedRefresh.at);
    assert.ok(patch,'Deferred result must eventually render after reading settles');
    countsAgree(afterC,2);assert.equal(afterC.readThroughId,snapshotId);assert.equal(afterC.firstUnreadId,queued.ids[0]);
    const visibleArrivals=afterC.items.filter(item=>queued.ids.includes(item.id)&&item.top>=0&&item.bottom<=afterC.clientHeight&&item.ready);
    assert.ok(visibleArrivals.length,'At least one newly arrived unread message must be fully visible to exercise snapshot protection');
    samples.push({stage:'C-sync-during-dwell-keeps-old-snapshot',before:beforeC,beforeSync,queued,scheduled,queuedRefresh,patch,after:afterC,visibleArrivals});
    check('Refresh inside native dwell preserves its original read snapshot while newly arrived visible messages stay unread');
    await page.screenshot({path:path.join(evidence,'new-arrivals-still-unread.png')});
    await page.waitForTimeout(700);const passive=await detail();countsAgree(passive,2);assert.equal(passive.readThroughId,snapshotId);
    check('No further user input means no further reading advancement');
    assert.deepEqual(errors,[]);
  } catch(error) {
    failure=String(error.stack||error);console.error(failure);
    if(page&&!page.isClosed())samples.push({stage:'failure',...(await detail().catch(()=>({})))});
  } finally {
    if(application)await releaseNaturalPoll().catch(()=>{});
    await close().catch(error=>{failure||='Close failed: '+String(error);});
    const sourceStillMatches=Object.entries(sourceHashes).every(([file,value])=>hash(path.join(root,'app',file))===value);
    const frozenStillMatches=Object.entries(sourceHashes).every(([file,value])=>hash(path.join(harness,'app',file))===value);
    const nativeExitedCleanly=launches.length===1&&launches[0].exitCode===0&&launches[0].signal===null;
    const blocked=networkRuns.flatMap(run=>run.blocked);
    const passed=!failure&&!errors.length&&!blocked.length&&sourceStillMatches&&frozenStillMatches&&nativeExitedCleanly;
    const report={passed,failure,checks,errors,blocked,samples,launches,inputRuns,networkRuns,breakpointSpecs,sourceVersion,sourceHashes,
      sourceStillMatches,frozenStillMatches,nativeExitedCleanly,harness,dataDir,generatedAt:new Date().toISOString(),
      scope:'Copied unchanged source, isolated synthetic profile, false-returning observation breakpoints, native input, local sync fixture; no real profiles or services'};
    fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify(report,null,2),{flag:'wx'});
    console.log(JSON.stringify({passed,failure,report:path.join(evidence,'result.json'),harness,nativeExitedCleanly}));
    if(!passed)process.exitCode=1;
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
