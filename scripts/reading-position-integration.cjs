'use strict';

// Actual main/preload/core/renderer, isolated synthetic profile, mocked network.
// DOM geometry and trusted wheel input are measured separately from passive
// JavaScript scrolling. No existing account, application data or service is used.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { assertWindowsRuntimeReadable } = require('./windows-runtime-check.cjs');

const root = path.resolve(__dirname, '..');
const evidence = path.join(root, 'artifacts', 'reading-position-integration');
const harness = fs.mkdtempSync(path.join(os.tmpdir(), 'weiyue-reading-position-'));
const dataDir = path.join(harness, 'data');
fs.mkdirSync(evidence, { recursive: true });
fs.mkdirSync(dataDir);
fs.cpSync(path.join(root, 'vendor', 'runtime'), path.join(harness, 'runtime'), { recursive: true });
fs.cpSync(path.join(root, 'app'), path.join(harness, 'app'), { recursive: true });
const executablePath = path.join(harness, 'runtime', 'electron.exe');
const sourcePackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const sourceHashes = {};
for (const file of fs.readdirSync(path.join(harness, 'app'), { recursive: true })) {
  const full = path.join(harness, 'app', file);
  if (fs.statSync(full).isFile()) sourceHashes[file] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
}

const fixture = {
  identity: '9007199254740993999', accountId: 'weibo-9007199254740993999',
  groups: [
    { id: '9007199254740994101', key: 'A', name: '中部锚点与迟图片', count: 220, anchor: 80 },
    { id: '9007199254740994102', key: 'B', name: '近尾短消息', count: 6, anchor: 5 },
    { id: '9007199254740994103', key: 'C', name: '未读完的长文本', count: 2, anchor: 1 },
    { id: '9007199254740994104', key: 'D', name: '未读完的长图片', count: 2, anchor: 1 },
    { id: '9007199254740994105', key: 'E', name: '用户主动阅读推进', count: 8, anchor: 2 },
  ],
};
const { Store } = require(path.join(harness, 'app', 'core', 'store.cjs'));
const store = new Store(path.join(dataDir, 'accounts'));
store.ensureAccount({ id: fixture.accountId, name: '阅读定位离线验收账号', kind: 'weibo' });
const groups = fixture.groups.map(group => ({ id: group.id, name: group.name, selected: true }));
const messages = fixture.groups.flatMap((group, groupIndex) => {
  group.ids = Array.from({ length: group.count }, (_, i) => String(9007199254741000000n + BigInt(groupIndex * 1000 + i)));
  group.anchorId = group.ids[group.anchor];
  return group.ids.map((id, index) => ({ id, groupId: group.id, senderId: '71', senderName: '本地模拟成员',
    time: 1700000000000 + index * 60000,
    text: `${group.key} 第 ${index} 条本地模拟消息。\n阅读位置验收；这些内容不是任何真实群聊。`,
    mediaVersion: 1,
    ...(group.key === 'A' && index === 79 ? { images: [{ url: 'https://wx1.sinaimg.cn/delayed-above.png' }] } : {}),
    ...(group.key === 'C' && index === 1 ? { text: Array.from({ length: 90 }, (_, line) => `长文本第 ${line + 1} 行：尚未读到下方内容时，不应清除这条消息的未读。`).join('\n') } : {}),
    ...(group.key === 'D' && index === 1 ? { text: '长图片的下半部分尚未读到。\n图片加载和布局变化不构成阅读。\n必须等内容真正显示。',
      images: [{ url: 'https://wx1.sinaimg.cn/long-unread.png' }] } : {}),
  }));
});
store.mergeMessages(fixture.accountId, groups, messages, { history: true });
store.update(fixture.accountId, state => {
  state.settings.autoSyncEnabled = false;
  for (const [index, group] of fixture.groups.entries()) {
    state.readPositions[group.id] = group.anchorId;
    state.readStates[group.id] = { anchorId: group.anchorId, anchorOffset: -37, atBottom: true,
      readThroughId: group.ids[group.anchor - 1], unreadIds: group.ids.slice(group.anchor), updatedAt: 4000 - index * 1000 };
  }
});
fs.writeFileSync(path.join(dataDir, 'preferences.json'), JSON.stringify({ activeId: fixture.accountId }));

function boot(fixtures) {
  const { app, net, session, ipcMain } = require('electron');
  const path = require('node:path');
  const { EventEmitter } = require('node:events');
  const { Readable } = require('node:stream');
  const { Store } = require('./app/core/store.cjs');
  const rootArg = process.argv.find(value => value.startsWith('--data-dir='));
  const testStore = new Store(path.join(rootArg.slice(11), 'accounts'));
  const pending = new Map(), held = [], released = new Set(), queryWaiters = [];
  const info = globalThis.__readingPosition = { blocked: [], images: [], apiCalls: [], readCalls: [],
    queryGate: null, waitingQueries: () => queryWaiters.length,
    releaseQueries() { this.queryGate = null; for (const resolve of queryWaiters.splice(0)) resolve(); },
    held: () => held.filter(item => !item.done).map(item => item.name),
    release(name) { released.add(name); for (const item of held) if (item.name === name && !item.done) item.deliver(); },
    queue(groupId, count) {
      const prior = testStore.get(fixtures.accountId).messages.filter(message => message.groupId === groupId);
      const latest = prior.at(-1);
      const fresh = Array.from({ length: count }, (_, i) => ({ id: String(BigInt(latest.id) + BigInt(i + 1)), groupId,
        senderId: '71', senderName: '本地模拟成员', time: latest.time + (i + 1) * 60000,
        text: `后台新消息 ${i + 1}。\n只应增加未读，不应移动正在阅读的位置。`, mediaVersion: 1 }));
      pending.set(groupId, [...fresh].reverse().concat(latest));
      return { ids: fresh.map(message => message.id), total: prior.length + count };
    },
  };
  const originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, handler) => originalHandle(channel, async (event, action, payload) => {
    if (channel === 'weiyue:call' && action === 'read.set') info.readCalls.push({ payload, at: Date.now() });
    if (channel === 'weiyue:call' && action === 'messages.query' && payload?.groupId === info.queryGate) {
      await new Promise(resolve => queryWaiters.push(resolve));
    }
    return handler(event, action, payload);
  });
  const crc32 = bytes => { let crc = -1; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ -1) >>> 0; };
  const chunk = (name, body) => { const label = Buffer.from(name), size = Buffer.alloc(4), crc = Buffer.alloc(4); size.writeUInt32BE(body.length); crc.writeUInt32BE(crc32(Buffer.concat([label, body]))); return Buffer.concat([size, label, body, crc]); };
  const width = 64, height = 1600, header = Buffer.alloc(13), rows = Buffer.alloc(height * (1 + width * 4));
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const i = y * (1 + width * 4) + 1 + x * 4; rows[i] = 40 + (y % 180); rows[i + 1] = 90 + x; rows[i + 2] = 120; rows[i + 3] = 255; }
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', require('node:zlib').deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
  const originalRequest = net.request.bind(net);
  net.request = options => {
    const target = typeof options === 'string' ? options : options.url;
    if (/^(app|file):/i.test(target)) return originalRequest(options);
    const request = new EventEmitter(); let aborted = false;
    request.setHeader = () => {};
    request.abort = () => { aborted = true; request.emit('abort'); };
    request.end = () => setImmediate(() => {
      if (aborted) return;
      const url = new URL(target);
      if (url.origin !== 'https://wx1.sinaimg.cn' || !['/delayed-above.png', '/long-unread.png'].includes(url.pathname)) {
        info.blocked.push(target); request.emit('error', Error('Unexpected image blocked')); return;
      }
      info.images.push(url.pathname);
      const item = { name: url.pathname, done: false, deliver() {
        if (this.done || aborted) return; this.done = true;
        const response = Readable.from([png]); response.statusCode = 200;
        response.headers = { 'content-type': ['image/png'], 'content-length': [String(png.length)] };
        request.emit('response', response);
      } };
      held.push(item); if (released.has(item.name)) item.deliver();
    });
    return request;
  };
  const originalFetch = net.fetch.bind(net);
  net.fetch = (target, options) => {
    if (/^https?:/i.test(String(target))) { info.blocked.push(String(target)); return Promise.reject(Error('External fetch blocked')); }
    return originalFetch(target, options);
  };
  const attached = new WeakSet();
  function attach(current) {
    if (attached.has(current)) return; attached.add(current);
    current.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { info.blocked.push(details.url); callback({ cancel: true }); });
    const original = current.fetch.bind(current);
    current.fetch = async (target, options) => {
      const url = new URL(String(target));
      if (['app:', 'file:'].includes(url.protocol)) return original(target, options);
      info.apiCalls.push(url.pathname);
      if (url.origin === 'https://api.weibo.com' && url.pathname === '/webim/query_primary_info.json') {
        return Response.json({ profile: { id: fixtures.identity, screen_name: '离线定位验收' } });
      }
      if (url.origin === 'https://api.weibo.com' && url.pathname === '/webim/groupchat/query_messages.json') {
        const batch = pending.get(url.searchParams.get('id'));
        if (!batch) throw Error('No local sync fixture queued');
        return Response.json({ has_more: 1, messages: batch.map(message => ({ id: message.id, gid: message.groupId,
          from_uid: '71', from_user: { screen_name: message.senderName }, time: message.time / 1000, content: message.text })) });
      }
      info.blocked.push(String(target)); throw Error('Unexpected API blocked');
    };
  }
  app.on('session-created', attach);
  app.whenReady().then(() => attach(session.defaultSession));
  require('./app/main.cjs');
}
fs.writeFileSync(path.join(harness, 'boot.cjs'), '(' + boot.toString() + ')(' + JSON.stringify(fixture) + ');\n');

let application, page;
const checks = [], errors = [], geometry = [], launches = [], networkRuns = [], inputRuns = [];
const check = description => { checks.push(description); console.log('PASS ' + description); };
const group = key => fixture.groups.find(item => item.key === key);
const api = (action, payload = {}) => page.evaluate(({ action, payload }) => window.api.call(action, payload), { action, payload });
const readStats = async key => (await api('state')).readStates[group(key).id];
async function launch() {
  const preflight = assertWindowsRuntimeReadable(executablePath);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({ executablePath, args: [path.join(harness, 'boot.cjs'), '--data-dir=' + dataDir], cwd: harness, env, timeout: 30000 });
  const native = application.process(), record = { pid: native.pid, startedAt: new Date().toISOString(), preflight };
  launches.push(record);
  native.once('exit', (code, signal) => { record.exitCode = code; record.signal = signal; record.exitedAt = new Date().toISOString(); });
  native.stderr?.on('data', bytes => fs.appendFileSync(path.join(evidence, 'native.stderr.log'), bytes));
  record.versions = await application.evaluate(() => process.versions);
  page = await application.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(1240, 760); window.focus(); });
  await page.bringToFront();
  await page.waitForSelector('article[data-message-id]');
  await page.evaluate(() => {
    globalThis.__readingInputEvidence = [];
    for (const kind of ['wheel', 'scroll', 'focus', 'blur', 'visibilitychange']) {
      document.addEventListener(kind, event => {
        if (kind === 'scroll' && event.target?.id !== 'message-scroll') return;
        globalThis.__readingInputEvidence.push({ kind, trusted: event.isTrusted, at: Date.now(),
          focus: document.hasFocus(), visibility: document.visibilityState, modalOpen: document.getElementById('modal')?.open,
          target: event.target?.id, deltaY: event.deltaY, scrollTop: document.getElementById('message-scroll')?.scrollTop });
      }, { capture: true, passive: true });
    }
  });
}
async function close() {
  if (!application) return;
  inputRuns.push(await page.evaluate(() => globalThis.__readingInputEvidence || []).catch(() => []));
  await application.evaluate(() => globalThis.__readingPosition.releaseQueries());
  networkRuns.push(await application.evaluate(() => ({ blocked: globalThis.__readingPosition.blocked,
    images: globalThis.__readingPosition.images, apiCalls: globalThis.__readingPosition.apiCalls, readCalls: globalThis.__readingPosition.readCalls })));
  await application.close(); application = null;
}
async function measure(id) {
  return page.evaluate(target => {
    const scroll = document.getElementById('message-scroll'), bounds = scroll.getBoundingClientRect();
    const articles = [...scroll.querySelectorAll('article[data-message-id]')];
    const first = articles.find(item => item.getBoundingClientRect().bottom > bounds.top + 1);
    const item = articles.find(item => item.dataset.messageId === target);
    const rect = item?.getBoundingClientRect(), last = articles.at(-1)?.getBoundingClientRect();
    return { id: first?.dataset.messageId, offset: first ? first.getBoundingClientRect().top - bounds.top : null,
      targetId: target, top: rect ? rect.top - bounds.top : null, height: rect?.height,
      bottom: rect ? rect.bottom - bounds.top : null, viewportHeight: scroll.clientHeight,
      scrollTop: scroll.scrollTop, scrollHeight: scroll.scrollHeight, lastBottom: last ? last.bottom - bounds.top : null };
  }, id);
}
async function atTop(key, id = group(key).anchorId) {
  await page.waitForFunction(target => {
    const s = document.getElementById('message-scroll');
    const item = [...(s?.querySelectorAll('article[data-message-id]') || [])].find(el => el.dataset.messageId === target);
    return item && Math.abs(item.getBoundingClientRect().top - s.getBoundingClientRect().top) <= 2;
  }, id, { timeout: 8000 });
  await page.waitForTimeout(750);
  const value = await measure(id); assert.ok(Math.abs(value.top) <= 2, 'Restored message is not at viewport top: ' + JSON.stringify(value));
  geometry.push({ stage: 'top-' + key, ...value }); return value;
}
async function switchGroup(key) {
  await page.locator('[data-group-id="' + group(key).id + '"]').click();
  await page.waitForSelector('[data-group-id="' + group(key).id + '"].active');
  await page.waitForSelector('article[data-message-id="' + group(key).anchorId + '"]');
}
async function assertUnread(key, count) {
  assert.equal((await readStats(key)).unreadCount, count, 'Unexpected persisted unread count in ' + key);
  await page.waitForFunction(value => document.getElementById('new-messages-count')?.textContent.startsWith(value + ' '), count, { timeout: 6000 });
  assert.equal(await page.locator('#new-messages-notice').isVisible(), true);
  assert.equal((await page.locator('#jump-latest').innerText()).trim(), '加载到最新');
}
async function append(key, count, unread) {
  const result = await application.evaluate((_electron, value) => globalThis.__readingPosition.queue(value.id, value.count), { id: group(key).id, count });
  await api('sync', { groupId: group(key).id });
  await page.waitForFunction(total => document.getElementById('read-count')?.textContent.startsWith(String(total)), result.total, { timeout: 8000 });
  await page.waitForTimeout(750);
  await assertUnread(key, unread);
  return result;
}
async function trustedWheel(pixels) {
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
  await page.bringToFront();
  await page.waitForFunction(() => document.hasFocus() && document.visibilityState === 'visible' && !document.getElementById('modal').open);
  const box = await page.locator('#message-scroll').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, pixels);
  await page.waitForTimeout(850);
}
async function waitHeld(name) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if ((await application.evaluate(() => globalThis.__readingPosition.held())).includes(name)) return;
    await page.waitForTimeout(100);
  }
  throw Error('Image fixture did not reach its held request: ' + name);
}

(async () => {
  let failure;
  fs.writeFileSync(path.join(evidence, 'native.stderr.log'), '');
  try {
    await launch();
    assert.equal((await api('state')).account.id, fixture.accountId);
    assert.equal(path.resolve((await api('state')).dataRoot), dataDir);
    const isolation = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => {
      const prefs = window.webContents.getLastWebPreferences(); return prefs.sandbox && prefs.contextIsolation && !prefs.nodeIntegration;
    }));
    assert.ok(isolation.every(Boolean));
    const originalA = await atTop('A'); await assertUnread('A', 140);
    check('Legacy atBottom=true opens the saved middle message at viewport top within 2px without consuming unread');

    await waitHeld('/delayed-above.png');
    const beforeImage = await measure(group('A').ids[79]);
    await application.evaluate(() => globalThis.__readingPosition.release('/delayed-above.png'));
    await page.waitForFunction(id => { const image = document.querySelector('article[data-message-id="' + id + '"] img'); return image?.complete && image.naturalHeight === 1600; }, group('A').ids[79]);
    await page.waitForTimeout(850);
    const afterImage = await measure(group('A').ids[79]);
    assert.ok(Math.abs(afterImage.height - beforeImage.height) > 20, 'Delayed image did not cause a meaningful layout change');
    await atTop('A'); await assertUnread('A', 140);
    geometry.push({ stage: 'delayed-image-layout', before: beforeImage, after: afterImage });
    check('A real delayed app://media image changes the preceding card height while preserving the reading anchor and unread');

    await append('A', 2, 142);
    const afterAppend = await measure(group('A').anchorId);
    assert.equal(afterAppend.id, originalA.id); assert.ok(Math.abs(afterAppend.offset - originalA.offset) <= 2);
    check('Real sync persistence and revision polling append messages without jumping or consuming the current group unread');

    await switchGroup('B'); const shortTail = await atTop('B'); await assertUnread('B', 1);
    assert.ok(shortTail.height < shortTail.viewportHeight - 40, 'Near-tail fixture is not shorter than its viewport');
    assert.equal(await page.locator('#reading-end-space').count(), 1);
    await append('B', 1, 2); await atTop('B');
    await switchGroup('A'); await atTop('A'); await assertUnread('A', 142);
    await switchGroup('B'); await atTop('B'); await assertUnread('B', 2);
    check('Near-tail content with insufficient following height restores at the actual top; switching and visible arrivals preserve unread');

    await page.locator('#message-scroll').evaluate(scroll => { scroll.scrollTop += 25; });
    await page.waitForTimeout(850); await assertUnread('B', 2);
    const passive = await measure(group('B').anchorId);
    assert.ok(passive.top < -10, 'Passive scroll fixture did not move');
    await page.locator('[data-group-id="' + group('B').id + '"]').click();
    await atTop('B'); await assertUnread('B', 2);
    check('Programmatic scroll does not authorize read advancement; clicking the current group restores its anchor to top');

    await switchGroup('A'); await atTop('A');
    const gateStart = await application.evaluate((_electron, id) => {
      globalThis.__readingPosition.queryGate = id; return globalThis.__readingPosition.readCalls.length;
    }, group('B').id);
    await page.locator('[data-group-id="' + group('B').id + '"]').click();
    let heldQuery = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      if (await application.evaluate(() => globalThis.__readingPosition.waitingQueries() > 0)) { heldQuery = true; break; }
      await page.waitForTimeout(50);
    }
    assert.equal(heldQuery, true, 'Group switch did not reach the controlled query gate');
    const oldDomPresent = await page.locator('article[data-message-id="' + group('A').anchorId + '"]').count();
    if (oldDomPresent) await trustedWheel(70);
    else await page.waitForTimeout(850);
    const gatedCalls = await application.evaluate((_electron, start) => globalThis.__readingPosition.readCalls.slice(start), gateStart);
    assert.ok(gatedCalls.every(call => call.payload.groupId !== group('B').id), 'Old DOM attempted a read save into the new group during its pending query');
    assert.equal((await readStats('B')).unreadCount, 2);
    await application.evaluate(() => globalThis.__readingPosition.releaseQueries());
    await atTop('B'); await assertUnread('B', 2);
    geometry.push({ stage: 'pending-group-query', oldDomPresent: Boolean(oldDomPresent), gatedReadCalls: gatedCalls });
    check('Trusted input while the next group query is held cannot save the previous DOM anchor or unread into that group');

    await switchGroup('E'); await atTop('E'); await assertUnread('E', 6);
    await trustedWheel(70);
    const advanced = await readStats('E');
    assert.ok(advanced.unreadCount < 6 && advanced.unreadCount > 0, 'Trusted reading must consume visible completed messages, not the whole group');
    const completed = await measure(advanced.readThroughId);
    assert.ok(completed.bottom <= completed.viewportHeight + 2 && completed.bottom > 0);
    geometry.push({ stage: 'trusted-read-advance', ...completed, unreadCount: advanced.unreadCount });
    check('Trusted downward wheel input advances only through messages whose ends remain visibly inside the viewport');

    await switchGroup('C'); const longText = await atTop('C'); await assertUnread('C', 1);
    assert.ok(longText.height > longText.viewportHeight * 2);
    await trustedWheel(110);
    const partiallyReadText = await measure(group('C').anchorId);
    assert.ok(partiallyReadText.top < -20 && partiallyReadText.bottom > partiallyReadText.viewportHeight + 50);
    await assertUnread('C', 1);
    check('Trusted downward wheel movement keeps a long message unread until its end has actually been reached');

    await switchGroup('D'); await atTop('D'); await assertUnread('D', 1);
    await waitHeld('/long-unread.png');
    await trustedWheel(35); const beforeLongImage = await measure(group('D').anchorId);
    await assertUnread('D', 1);
    await application.evaluate(() => globalThis.__readingPosition.release('/long-unread.png'));
    await page.waitForFunction(id => { const image = document.querySelector('article[data-message-id="' + id + '"] img'); return image?.complete && image.naturalHeight === 1600; }, group('D').anchorId);
    await page.waitForTimeout(850);
    const loadedLongImage = await measure(group('D').anchorId);
    assert.equal(loadedLongImage.id, beforeLongImage.id);
    assert.ok(Math.abs(loadedLongImage.offset - beforeLongImage.offset) <= 2);
    assert.ok(loadedLongImage.bottom > loadedLongImage.viewportHeight + 20, 'Long image end must remain below the viewport');
    await assertUnread('D', 1);
    await trustedWheel(20); await assertUnread('D', 1);
    check('A pending image and later decoded long image cannot clear unread through passive layout or partial scrolling');

    await switchGroup('A'); await atTop('A'); await assertUnread('A', 142);
    const corner = await page.evaluate(() => {
      const content = document.getElementById('workspace-content').getBoundingClientRect();
      const notice = document.getElementById('new-messages-notice').getBoundingClientRect();
      return { rightGap: content.right - notice.right, lowerFraction: (notice.bottom - content.top) / content.height };
    });
    assert.ok(corner.rightGap >= -2 && corner.rightGap <= 40 && corner.lowerFraction > 0.7, 'Unread controls are not at the lower right: ' + JSON.stringify(corner));
    await page.locator('#jump-latest').click();
    await page.waitForTimeout(850); await assertUnread('A', 0);
    const latestId = (await readStats('A')).latestMessageId, jumped = await measure(latestId);
    assert.ok(Math.abs(jumped.bottom - jumped.viewportHeight) <= 2, 'Explicit jump should align the actual final message bottom, not spacer bottom');
    await page.screenshot({ path: path.join(evidence, 'explicit-latest.png') });
    check('Lower-right unread count stays visible at zero; explicit Load latest aligns the actual last message and advances read');

    const beforeLastArrival = await measure(latestId);
    await append('A', 1, 1);
    const afterLastArrival = await measure(latestId);
    assert.equal(afterLastArrival.id, beforeLastArrival.id);
    assert.ok(Math.abs(afterLastArrival.offset - beforeLastArrival.offset) <= 2);
    geometry.push({ stage: 'arrival-after-explicit-jump', before: beforeLastArrival, after: afterLastArrival });
    check('Even after explicitly jumping to latest, the next arrival remains unread and does not enable tail following');

    await switchGroup('B'); await atTop('B'); await assertUnread('B', 2);
    await page.locator('#message-scroll').evaluate(scroll => { scroll.scrollTop += 25; });
    await page.waitForTimeout(850);
    const saved = await readStats('B');
    assert.equal(saved.anchorId, group('B').anchorId); assert.equal(saved.atBottom, false);
    await close();
    const persisted = store.getReadStats(fixture.accountId, group('B').id);
    assert.equal(persisted.anchorId, saved.anchorId); assert.equal(persisted.unreadCount, 2);
    await launch();
    await page.waitForSelector('[data-group-id="' + group('B').id + '"].active');
    await atTop('B'); await assertUnread('B', 2);
    assert.equal((await readStats('A')).unreadCount, 1);
    await page.screenshot({ path: path.join(evidence, 'restart-near-tail-top.png') });
    check('Real close/restart restores the most recently read group and saved short-tail anchor at top without consuming unread');
    assert.deepEqual(errors, []);
  } catch (error) {
    failure = String(error.stack || error);
    console.error(failure);
    if (page && !page.isClosed()) {
      await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
      geometry.push({ stage: 'failure', ...(await measure('').catch(() => ({}))) });
    }
  } finally {
    await close().catch(error => { failure ||= 'Close failed: ' + String(error); });
    const sourceStillMatches = Object.entries(sourceHashes).every(([file, hash]) =>
      crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'app', file))).digest('hex') === hash);
    const blocked = networkRuns.flatMap(run => run.blocked);
    const nativeExitedCleanly = launches.length === 2 && launches.every(run => run.exitCode === 0 && run.signal === null);
    const passed = !failure && errors.length === 0 && blocked.length === 0 && sourceStillMatches && nativeExitedCleanly;
    const report = { passed, checks, errors, blocked, failure, geometry, launches, networkRuns, inputRuns,
      sourceHashes, sourceStillMatches, sourceVersion: sourcePackage.version, nativeExitedCleanly, executablePath, harness, dataDir, generatedAt: new Date().toISOString(),
      scope: 'Real copied app/main/preload/core/renderer and sandboxed Electron; synthetic persisted account; all external transports mocked; actual DOM geometry and trusted mouse wheel input' };
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed, checks: checks.length, sourceStillMatches, report: path.join(evidence, 'result.json'), launches }));
    if (!passed) process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
