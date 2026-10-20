'use strict';

// Real copied main/preload/renderer. Only native webContents input may satisfy
// positive reading assertions; JavaScript scrolling is a negative control.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { assertWindowsRuntimeReadable } = require('./windows-runtime-check.cjs');

const root = path.resolve(__dirname, '..');
const sourceVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const evidence = path.join(root, 'artifacts', 'native-reading-input-integration-' + sourceVersion);
const harness = fs.mkdtempSync(path.join(os.tmpdir(), 'weiyue-native-reading-'));
const dataDir = path.join(harness, 'data');
fs.mkdirSync(evidence, { recursive: true });
fs.mkdirSync(dataDir);
fs.cpSync(path.join(root, 'vendor', 'runtime'), path.join(harness, 'runtime'), { recursive: true });
fs.cpSync(path.join(root, 'app'), path.join(harness, 'app'), { recursive: true });
const executablePath = path.join(harness, 'runtime', 'electron.exe');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sourceHashes = Object.fromEntries(fs.readdirSync(path.join(harness, 'app'), { recursive: true })
  .filter(file => fs.statSync(path.join(harness, 'app', file)).isFile())
  .map(file => [file, hash(path.join(harness, 'app', file))]));
const fixture = { identity: '9007199254740993999', accountId: 'weibo-9007199254740993999', groups: [
  { key: 'A', id: '9007199254740995101', name: '原生平滑滚轮', count: 160, anchor: 30 },
  { key: 'B', id: '9007199254740995102', name: '原生慢速滚动条', count: 160, anchor: 30 },
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
    text: `${group.key} 第 ${index} 条原生输入验收消息。\n这些记录完全由测试生成，不包含任何真实群聊。` +
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
  const info = globalThis.__nativeReading = { blocked: [], apiCalls: [], readCalls: [], queue(groupId, count) {
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
function assertReadProgress(before, after, minimumMovement = 2) {
  assert.ok(after.scrollTop > before.scrollTop + minimumMovement, 'Native input did not move the actual viewport');
  assert.ok(after.unread < before.unread && after.unread > 0, 'Read progress must consume only a subset of unread');
  assert.notEqual(after.readThroughId, before.readThroughId);
  assert.ok(after.throughBottom > 0 && after.throughBottom <= after.clientHeight + 2, 'Read boundary is not visibly completed');
  countsAgree(after);
}

(async () => {
  let failure;
  fs.writeFileSync(path.join(evidence, 'native.stderr.log'), '');
  try {
    await launch();
    const initialState = await api('state');
    assert.equal(initialState.account.id, fixture.accountId); assert.equal(path.resolve(initialState.dataRoot), dataDir);
    assert.ok(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => {
      const prefs = window.webContents.getLastWebPreferences(); return prefs.sandbox && prefs.contextIsolation && !prefs.nodeIntegration;
    })));
    const initial = await sample(); countsAgree(initial, 130); assert.ok(Math.abs(initial.firstOffset) <= 2);
    check('Actual sandboxed app opens an isolated synthetic account with 130 unread and a nonempty read boundary without consuming visible messages');

    let fractionalWheel = false, microWheel = false, lastA;
    // Frame cadence changes the final quantized step. Keep all gestures native
    // and vary only their requested distance to exercise a genuine <=1px tail.
    // A whole subpixel gesture is a separate regression; it cannot satisfy the
    // multiple-frame tail requirement. Fractional requested distances exercise
    // native quantization without assigning the DOM scroll position.
    // Large strokes can finish in a 4px compositor frame on this host even
    // though an earlier run ended in 0.67px. Preserve those original strokes,
    // then use a fixed, bounded set of shorter native strokes. Their cumulative
    // movement crosses another message boundary, but coverage still requires
    // the SAME stroke to have >=3 real frames, a <=1px tail, and read progress.
    const wheelDistances = [0.67, 1, 200.67, 200.333, 201.333,
      32.667, 40.333, 32.667, 40.333, 32.667, 40.333, 32.667, 40.333];
    for (let attempt = 1; attempt <= wheelDistances.length && !fractionalWheel; attempt++) {
      await clearEvents(); const before = await sample();
      const x = Math.floor(before.bounds.x + before.bounds.width / 2), y = Math.floor(before.bounds.y + before.bounds.height / 2);
      const distance = wheelDistances[attempt - 1];
      await nativeInput([{ type: 'mouseMove', x, y }, { type: 'mouseWheel', x, y, deltaX: 0, deltaY: -distance, canScroll: true }]);
      await page.waitForTimeout(1400);
      const after = await sample(), frames = scrollFrames(before, after);
      assert.ok(after.events.some(event => event.type === 'wheel' && event.trusted && event.deltaY > 0));
      assert.ok(frames.length >= 1, 'Native wheel did not produce a scroll frame');
      if (distance > 2) assert.ok(frames.length >= 3, 'Native wheel did not produce multiple smooth-scroll frames');
      const totalMovement = after.scrollTop - before.scrollTop;
      assert.ok(totalMovement > (distance > 2 ? 2 : 0), 'Native wheel did not move the viewport');
      countsAgree(after); assert.ok(after.unread <= before.unread && after.unread > 0);
      // A small gesture may end before the next card is completely visible.
      // The target regression is covered only when this SAME fractional-tail
      // gesture also commits a newly completed visible message.
      const advanced = after.unread < before.unread;
      if (advanced) assertReadProgress(before, after, distance > 2 ? 2 : 0);
      else assert.equal(after.readThroughId, before.readThroughId);
      const tail = frames.at(-1)?.delta;
      const microGesture = totalMovement > 0 && totalMovement <= 1 && advanced;
      if (microGesture && !microWheel) {
        microWheel = true;
        check('A native whole subpixel wheel gesture advances visible reading; recorded separately from multiple-frame tail coverage');
      }
      fractionalWheel = frames.length >= 3 && tail > 0 && tail <= 1 && advanced;
      samples.push({ stage: 'native-smooth-wheel', attempt, distance, before, after, frames, totalMovement,
        tailDelta: tail, advanced, microGesture, fractionalWheel });
      lastA = after;
    }
    if (fractionalWheel) check('Native trusted mouseWheel produces multiple scroll frames including a final <=1px step and decreases both unread labels consistently');
    else coverageFailures.push('No fractional-tail native gesture with actual read advancement was observed in ' + wheelDistances.length + ' bounded gestures');
    await page.screenshot({ path: path.join(evidence, 'native-wheel-unread.png') });

    const beforePassive = await sample();
    await page.locator('#message-scroll').evaluate(scroll => { scroll.scrollTop += 30; });
    await page.waitForTimeout(1000);
    const afterPassive = await sample(); countsAgree(afterPassive, beforePassive.unread);
    assert.equal(afterPassive.readThroughId, beforePassive.readThroughId); assert.ok(afterPassive.scrollTop > beforePassive.scrollTop + 20);
    samples.push({ stage: 'passive-scroll-after-wheel', before: beforePassive, after: afterPassive });
    lastA = afterPassive;
    check('A later programmatic scroll moves the viewport but cannot consume unread after the native wheel gesture ends');

    await switchGroup('B'); await clearEvents();
    const beforeDrag = await sample(); countsAgree(beforeDrag, 130);
    const thumb = Math.max(18, beforeDrag.clientHeight * beforeDrag.clientHeight / beforeDrag.scrollHeight);
    const x = Math.floor(beforeDrag.bounds.x + beforeDrag.bounds.width - 5);
    const y = Math.floor(beforeDrag.bounds.y + (beforeDrag.clientHeight - thumb) * beforeDrag.scrollTop /
      (beforeDrag.scrollHeight - beforeDrag.clientHeight) + thumb / 2);
    const readCallStart = await application.evaluate(() => globalThis.__nativeReading.readCalls.length);
    await nativeInput([{ type: 'mouseMove', x, y }, { type: 'mouseDown', x, y, button: 'left', clickCount: 1 }]);
    await page.waitForTimeout(1600);
    const held = await sample(); countsAgree(held, beforeDrag.unread); assert.equal(held.readThroughId, beforeDrag.readThroughId);
    await nativeInput([{ type: 'mouseMove', x, y: y + 3, movementX: 0, movementY: 3, modifiers: ['leftButtonDown'] }]);
    await page.waitForTimeout(80);
    await nativeInput([{ type: 'mouseUp', x, y: y + 3, button: 'left', clickCount: 1 }]);
    await page.waitForTimeout(1400);
    const afterDrag = await sample(); assertReadProgress(beforeDrag, afterDrag);
    const down = afterDrag.events.find(event => event.type === 'pointerdown' && event.trusted && event.targetIsScroll);
    assert.ok(down, 'Trusted native scrollbar pointerdown was not observed');
    const firstMovement = afterDrag.events.find(event => event.type === 'scroll' && event.scrollTop > beforeDrag.scrollTop + 1);
    assert.ok(firstMovement && firstMovement.at - down.at >= 1500, 'Scrollbar movement did not occur after the required long hold');
    const pointerMovesBeforeMovement = afterDrag.events.filter(event => event.type === 'pointermove' && event.trusted &&
      event.at > down.at && event.at <= firstMovement.at);
    assert.equal(pointerMovesBeforeMovement.length, 0, 'Native drag dispatched pointermove before scroll; the missing-pointermove regression was not covered');
    const dragReadCalls = await application.evaluate((_electron, start) => globalThis.__nativeReading.readCalls.slice(start), readCallStart);
    assert.ok(dragReadCalls.some(call => call.payload.readThroughId === afterDrag.readThroughId));
    samples.push({ stage: 'native-long-scrollbar-drag', input: { x, y, dragPixels: 3, holdMs: 1600 }, before: beforeDrag,
      held, after: afterDrag, frames: scrollFrames(beforeDrag, afterDrag), readCalls: dragReadCalls,
      pointerMovesBeforeMovement: pointerMovesBeforeMovement.length,
      pointerMovesAfterDown: afterDrag.events.filter(event => event.type === 'pointermove' && event.at > down.at).length });
    check('Holding the native scrollbar thumb for over 1500ms then dragging 3px advances visible reading and synchronizes both unread labels');
    await page.screenshot({ path: path.join(evidence, 'native-long-scrollbar-unread.png') });

    await page.locator('#message-scroll').evaluate(scroll => { scroll.scrollTop += 30; });
    await page.waitForTimeout(1000);
    const afterReleasedPassive = await sample(); countsAgree(afterReleasedPassive, afterDrag.unread);
    assert.equal(afterReleasedPassive.readThroughId, afterDrag.readThroughId);
    assert.ok(afterReleasedPassive.scrollTop > afterDrag.scrollTop + 20, 'Post-release passive control did not move the viewport');
    samples.push({ stage: 'passive-scroll-after-thumb-release', before: afterDrag, after: afterReleasedPassive });
    check('Releasing the scrollbar ends continuous input authorization; later passive scrolling cannot mark messages read');

    const queued = await application.evaluate((_electron, id) => globalThis.__nativeReading.queue(id, 2), group('B').id);
    await api('sync', { groupId: group('B').id });
    await page.waitForFunction(total => document.getElementById('read-count')?.textContent.startsWith(String(total)), queued.total);
    await page.waitForTimeout(900);
    const afterArrival = await sample(); countsAgree(afterArrival, afterDrag.unread + 2);
    assert.equal(afterArrival.readThroughId, afterDrag.readThroughId);
    assert.equal(afterArrival.firstId, afterReleasedPassive.firstId);
    assert.ok(Math.abs(afterArrival.firstOffset - afterReleasedPassive.firstOffset) <= 2);
    samples.push({ stage: 'passive-new-arrival', before: afterReleasedPassive, after: afterArrival });
    check('Real sync with local response fixtures adds two unread without moving the reading anchor or extending native input permission');

    const returnedA = await switchGroup('A'); countsAgree(returnedA, lastA.unread); assert.equal(returnedA.readThroughId, lastA.readThroughId);
    const returnedB = await switchGroup('B'); countsAgree(returnedB, afterArrival.unread); assert.equal(returnedB.readThroughId, afterArrival.readThroughId);
    samples.push({ stage: 'switch-back-A', ...returnedA }, { stage: 'switch-back-B', ...returnedB });
    check('Switching groups restores saved anchors to top and retains the read boundaries established by native input');

    await close();
    const persistedB = store.getReadStats(fixture.accountId, group('B').id);
    assert.equal(persistedB.unreadCount, afterArrival.unread); assert.equal(persistedB.readThroughId, afterArrival.readThroughId);
    await launch();
    const restarted = await sample(); assert.equal(restarted.groupId, group('B').id);
    countsAgree(restarted, afterArrival.unread); assert.equal(restarted.readThroughId, afterArrival.readThroughId);
    assert.equal(restarted.firstId, returnedB.firstId); assert.ok(Math.abs(restarted.firstOffset) <= 2);
    const restoredA = (await api('state')).readStates[group('A').id];
    assert.equal(restoredA.unreadCount, lastA.unread); assert.equal(restoredA.readThroughId, lastA.readThroughId);
    samples.push({ stage: 'real-close-restart', ...restarted });
    await page.screenshot({ path: path.join(evidence, 'restart-native-progress.png') });
    check('Actual close and restart preserve both groups native reading progress, remaining unread, and the most recent group anchor');
    assert.deepEqual(errors, []);
    assert.deepEqual(coverageFailures, [], 'Required native regression coverage was not reached');
  } catch (error) {
    failure = String(error.stack || error); console.error(failure);
    if (page && !page.isClosed()) {
      await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
      samples.push({ stage: 'failure', ...(await sample().catch(() => ({}))) });
    }
  } finally {
    await close().catch(error => { failure ||= 'Close failed: ' + String(error); });
    const sourceStillMatches = Object.entries(sourceHashes).every(([file, value]) => hash(path.join(root, 'app', file)) === value);
    const nativeExitedCleanly = launches.length === 2 && launches.every(run => run.exitCode === 0 && run.signal === null);
    const blocked = networkRuns.flatMap(run => run.blocked);
    const passed = !failure && !errors.length && !blocked.length && sourceStillMatches && nativeExitedCleanly;
    const report = { passed, checks, errors, failure, coverageFailures, samples, launches, inputRuns, networkRuns, blocked,
      sourceVersion, sourceHashes, sourceStillMatches, nativeExitedCleanly, executablePath, harness, dataDir,
      generatedAt: new Date().toISOString(), scope: 'Real copied app, native webContents.sendInputEvent wheel and scrollbar drag, synthetic account, local mocked sync, no real service or existing profile' };
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed, checks: checks.length, report: path.join(evidence, 'result.json'), sourceStillMatches, nativeExitedCleanly, launches }));
    if (!passed) process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
