'use strict';
const {assertWindowsRuntimeReadable}=require('./windows-runtime-check.cjs');

// Offline renderer acceptance: a copied renderer, an isolated Temp profile and
// in-memory IPC fixtures. No production main, account data or credentials.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = path.resolve(__dirname, '..');
let executablePath = process.argv[2] ? path.resolve(process.argv[2]) : null;
const evidence = process.env.WEIYUE_READING_UI_OUTPUT ? path.resolve(process.env.WEIYUE_READING_UI_OUTPUT) : path.join(root, 'artifacts', 'reading-ui-regression');
const harness = fs.mkdtempSync(path.join(os.tmpdir(), 'weiyue-reading-ui-'));
if (!executablePath) {
  // A workspace can carry restrictive AppContainer ACLs. An ordinary Temp copy
  // gives Chromium's sandbox access without changing ACLs or disabling sandboxing.
  fs.cpSync(path.join(root, 'vendor', 'runtime'), path.join(harness, 'runtime'), { recursive: true });
  executablePath = path.join(harness, 'runtime', 'electron.exe');
}
fs.mkdirSync(evidence, { recursive: true });
fs.mkdirSync(path.join(harness, 'renderer'));
const hashes = {};
for (const name of ['index.html', 'style.css', 'app.js', 'reading-state.js','filter-controls.js','linkify.js','emoticons.js','emoticon-manifest.js']) {
  const bytes = fs.readFileSync(path.join(root, 'app', 'renderer', name));
  fs.writeFileSync(path.join(harness, 'renderer', name), bytes);
  hashes[name] = crypto.createHash('sha256').update(bytes).digest('hex');
}
fs.writeFileSync(path.join(harness, 'preload.cjs'), `
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', Object.freeze({
  call: async (action, payload = {}) => {
    const result = await ipcRenderer.invoke('mock:call', action, payload);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  },
  onBeforeClose: listener => {
    const handler = () => listener();
    ipcRenderer.on('mock:before-close', handler);
    return () => ipcRenderer.removeListener('mock:before-close', handler);
  }
}));
`);

function harnessMain() {
  const { app, BrowserWindow, ipcMain, session, protocol } = require('electron');
  const path = require('node:path');
  protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
  app.setPath('userData', path.join(__dirname, 'isolated-profile'));
  const account = { id: 'mock-weibo-reading', name: '阅读测试账号（仅本地）', kind: 'weibo' };
  const groups = ['A', 'B'].map(id => ({ id, name: '模拟群 ' + id, selected: true }));
  const data = { A: [], B: [] };
  const readStates = {};
  const base = 9007199254740993000n;
  const start = new Date('2026-10-20T09:00:00Z').getTime();
  const make = (groupId, index) => ({
    id: String(base + (groupId === 'B' ? 10000n : 0n) + BigInt(index)), groupId,
    senderId: String(9007199254741000000n + BigInt(index % 5)),
    senderName: '模拟成员 ' + (index % 5), time: start + index * 60000,
    text: '群 ' + groupId + ' 第 ' + index + ' 条：本地阅读测试。\n' +
      '这是一段用于验证阅读位置和正文换行的模拟内容，所有信息均为测试生成。'.repeat(12) +
      '\n记录思路、保留上下文，后台新消息不应打断当前阅读。'
  });
  for (const group of groups) {
    data[group.id] = Array.from({ length: 300 }, (_, i) => make(group.id, i));
    const index = group.id === 'A' ? 110 : 70;
    readStates[group.id] = { anchorId: data[group.id][index].id, anchorOffset: -25,
      atBottom: group.id === 'A', readThroughId: data[group.id][index].id, unreadIds: [], updatedAt: 0 };
  }
  const stats = groupId => {
    const state = readStates[groupId], messages = data[groupId];
    return { ...state, unreadIds: [...state.unreadIds], unreadCount: state.unreadIds.length,
      firstUnreadId: state.unreadIds[0] || null, latestMessageId: messages.at(-1)?.id || null,
      messageCount: messages.length };
  };
  const state = () => ({ accounts: [account], account,
    groups: groups.map(group => ({ ...group, ...stats(group.id),
      coverage: { oldest: data[group.id][0].time, newest: data[group.id].at(-1).time, complete: false } })),
    stats: { messages: data.A.length + data.B.length, bookmarks: 0, summaries: 0 },
    readPositions: Object.fromEntries(groups.map(group => [group.id, readStates[group.id].anchorId])),
    readStates: Object.fromEntries(groups.map(group => [group.id, stats(group.id)])),
    importantMembers: [], settings: {}, credentials: {}, sessionReady: true, dataRoot: path.join(__dirname, 'isolated-profile')
  });
  const mock = globalThis.__readingMock = {
    calls: [], events: [], blockedRequests: [], mediaRequests: [], readDelay: 0, closeReady: false,
    sync: { accountId: account.id, revision: 0, enabled: true, intervalMs: 60000,
      running: false, paused: false, lastError: null, lastSyncAt: 0, nextRunAt: Date.now() + 60000 },
    stats, state,
    append(groupId, count = 1) {
      const messages = data[groupId];
      for (let i = 0; i < count; i++) {
        const message = make(groupId, messages.length);
        messages.push(message); readStates[groupId].unreadIds.push(message.id);
      }
      this.sync.revision++; this.sync.lastSyncAt = Date.now();
      return { total: messages.length, latestId: messages.at(-1).id, revision: this.sync.revision };
    },
    beforeClose() { BrowserWindow.getAllWindows()[0].webContents.send('mock:before-close'); },
    installMedia() {
      const messages = data.A.slice(-4);
      for (const message of messages) { message.text = '仅本地媒体测试'; message.mediaVersion = 1; }
      messages[0].images = [{ src: 'app://media/thumb.png', originalSrc: 'app://media/original.png', width: 32, height: 20 }];
      messages[1].images = [{ src: 'app://media/thumb.png', originalSrc: 'app://media/original-missing.png', width: 32, height: 20 }];
      messages[2].images = [{ src: 'app://media/missing.png', width: 32, height: 20 }];
      messages[2].sharedPost = { state: 'ready', author: '模拟微博作者', text: '离线微博完整正文 <script>不可执行</script>',
        url: 'https://weibo.com/1234567890/MockPost', images: [{ src: 'app://media/post.png', width: 32, height: 20 }] };
      messages[3].sharedPost = { state: 'unavailable', author: '缓存作者', text: '之前保存在本地的微博正文',
        reason: '模拟原文当前不可访问', url: 'https://weibo.com/1234567890/MockCachedPost', truncated: true };
      this.sync.revision++; this.sync.lastSyncAt = Date.now();
      return { ids: messages.map(message => message.id), revision: this.sync.revision };
    },
    data
  };
  async function call(action, payload) {
    mock.calls.push({ action, payload, time: Date.now() });
    mock.events.push({ type: 'call', action, time: Date.now() });
    switch (action) {
      case 'state': return state();
      case 'messages.query': {
        const messages = data[payload.groupId].filter(message =>
          (!payload.keyword || message.text.includes(payload.keyword)) &&
          (!payload.senderId || message.senderId === payload.senderId) &&
          (!payload.start || message.time >= payload.start) && (!payload.end || message.time < payload.end));
        return { messages: messages.slice(payload.offset || 0, (payload.offset || 0) + (payload.limit || 160)), total: messages.length };
      }
      case 'messages.locate': {
        const offset = data[payload.groupId].findIndex(message => message.id === payload.messageId);
        return { message: data[payload.groupId][offset] || null, offset };
      }
      case 'members.list': return Array.from({ length: 5 }, (_, i) => ({
        id: String(9007199254741000000n + BigInt(i)), name: '模拟成员 ' + i
      }));
      case 'read.set': {
        if (mock.readDelay) await new Promise(resolve => setTimeout(resolve, mock.readDelay));
        const current = readStates[payload.groupId];
        const id = payload.messageId || payload.anchorId;
        if (!data[payload.groupId].some(message => message.id === id)) throw Error('Invalid mock anchor');
        current.anchorId = id;
        current.anchorOffset = payload.offset ?? payload.anchorOffset ?? 0;
        current.atBottom = payload.followTail ?? payload.atBottom ?? false;
        const seen = payload.seenId ?? payload.readThroughId ?? null;
        if (seen && (!current.readThroughId || BigInt(seen) > BigInt(current.readThroughId))) current.readThroughId = seen;
        current.unreadIds = current.unreadIds.filter(unread => !current.readThroughId || BigInt(unread) > BigInt(current.readThroughId));
        current.updatedAt = Date.now();
        mock.events.push({ type: 'read-saved', groupId: payload.groupId, anchorId: id, time: Date.now() });
        return stats(payload.groupId);
      }
      case 'messages.enrich': {
        if (mock.deferEnrichment > 0 && payload.messageIds.includes(mock.deferEnrichmentId)) { mock.deferEnrichment--; return { count: 0, deferred: true }; }
        let count = 0;
        for (const message of data[payload.groupId]) if (payload.messageIds.includes(message.id) && !message.mediaVersion) {
          message.mediaVersion = 1;
          message.images = [{ src: 'app://media/thumb.png', originalSrc: 'app://media/original.png', width: 32, height: 24 }];
          count++;
        }
        if (count) mock.sync.revision++;
        return { count };
      }
      case 'sync.status': return { ...mock.sync };
      case 'sync.configure': Object.assign(mock.sync, payload); return { ...mock.sync };
      case 'sync': return { messages: [], count: 0 };
      case 'window.closeReady': mock.closeReady = true; return true;
      case 'image.open': return { opened: true };
      case 'external.open': return { opened: true };
      default: throw new Error('Unexpected mock action: ' + action);
    }
  }
  ipcMain.handle('mock:call', async (_event, action, payload = {}) => {
    try { return { ok: true, value: await call(action, payload) }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
  app.whenReady().then(() => {
    function png() {
      const crc32 = bytes => { let crc = -1; for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ -1) >>> 0; };
      const chunk = (type, body) => { const label = Buffer.from(type), size = Buffer.alloc(4), crc = Buffer.alloc(4); size.writeUInt32BE(body.length); crc.writeUInt32BE(crc32(Buffer.concat([label, body]))); return Buffer.concat([size, label, body, crc]); };
      const header = Buffer.alloc(13); header.writeUInt32BE(32, 0); header.writeUInt32BE(20, 4); header[8] = 8; header[9] = 6;
      const rows = Buffer.alloc(20 * (1 + 32 * 4));
      for (let y = 0; y < 20; y++) for (let x = 0; x < 32; x++) { const i = y * 129 + 1 + x * 4; rows[i] = 65 + x * 3; rows[i + 1] = 100 + y * 4; rows[i + 2] = 90; rows[i + 3] = 255; }
      return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', require('node:zlib').deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
    }
    const image = png();
    protocol.handle('app', request => {
      const url = new URL(request.url);
      if (url.hostname !== 'media') return new Response('Not found', { status: 404 });
      mock.mediaRequests.push(url.pathname);
      // An invalid PNG payload exercises image.onerror without external I/O.
      return new Response(url.pathname.includes('missing') ? Buffer.from('invalid local PNG fixture') : image,
        { headers: { 'content-type': 'image/png', 'cache-control': 'no-store' } });
    });
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      mock.blockedRequests.push(details.url); callback({ cancel: true });
    });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    const win = new BrowserWindow({ width: 1440, height: 960, show: true, webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false
    } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  });
  app.on('window-all-closed', () => app.quit());
}
fs.writeFileSync(path.join(harness, 'main.cjs'), '(' + harnessMain.toString() + ')();\n');

let application, page;
const checks = [], errors = [], measurements = {};
const check = description => { checks.push(description); console.log('PASS ' + description); };
const snapshot = () => page.evaluate(() => {
  const scroll = document.getElementById('message-scroll'), box = scroll.getBoundingClientRect();
  const article = [...scroll.querySelectorAll('article[data-message-id]')].find(item => {
    const rect = item.getBoundingClientRect(); return rect.bottom > box.top + 1 && rect.top < box.bottom;
  });
  return { id: article?.dataset.messageId, offset: article ? article.getBoundingClientRect().top - box.top : null,
    scrollTop: scroll.scrollTop, distanceToBottom: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
    firstId: scroll.querySelector('article')?.dataset.messageId,
    lastId: scroll.querySelector('article:last-of-type')?.dataset.messageId,
    lastBottomOffset: scroll.querySelector('article:last-of-type')?.getBoundingClientRect().bottom - box.bottom };
});
async function sameAnchor(expected, description) {
  await page.waitForFunction(expected => {
    const scroll = document.getElementById('message-scroll'); if (!scroll) return false;
    const top = scroll.getBoundingClientRect().top;
    const article = [...scroll.querySelectorAll('article[data-message-id]')].find(item => item.dataset.messageId === expected.id);
    return article && Math.abs(article.getBoundingClientRect().top - top - expected.offset) <= 2;
  }, expected, { timeout: 6000 });
  const actual = await snapshot();
  assert.equal(actual.id, expected.id, description + ': first visible ID changed');
  assert.ok(Math.abs(actual.offset - expected.offset) <= 2, description + ': offset drifted');
  measurements[description] = { before: expected, after: actual };
}
async function settle() { await page.waitForTimeout(850); }
async function scrollMiddle() {
  await page.locator('#message-scroll').evaluate(scroll => { scroll.scrollTop = Math.floor((scroll.scrollHeight - scroll.clientHeight) * 0.48) + 17; });
  await settle();
  return snapshot();
}
async function waitRevision(revision) {
  await application.evaluate(async (_electron, revision) => {
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      const calls = globalThis.__readingMock.calls;
      if (calls.some(call => call.action === 'state' && call.time >= globalThis.__readingMock.sync.lastSyncAt)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Renderer did not refresh after revision ' + revision);
  }, revision);
  await settle();
}

(async () => {
  try {
    const launchEnv = { ...process.env };
    delete launchEnv.ELECTRON_RUN_AS_NODE;
    assertWindowsRuntimeReadable(executablePath);
    application = await _electron.launch({ executablePath, args: [path.join(harness, 'main.cjs')], cwd: harness, timeout: 30000,
      env: launchEnv });
    page = await application.firstWindow({ timeout: 30000 });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.waitForSelector('article[data-message-id]');
    await page.waitForSelector('#auto-sync-toggle');
    await settle();
    assert.deepEqual(await page.evaluate(() => ({ require: typeof require, process: typeof process })), { require: 'undefined', process: 'undefined' });
    assert.equal(await page.locator('#group-list button').count(), 2);
    const restoredStart = await snapshot();
    assert.equal(restoredStart.id, '9007199254740993110');
    assert.ok(Math.abs(restoredStart.offset) <= 2, 'Old tail flag must restore the saved anchor at viewport top');
    assert.equal(await application.evaluate(() => globalThis.__readingMock.stats('A').readThroughId), restoredStart.id);
    assert.equal(await page.locator('#jump-latest').innerText(), '加载到最新');
    assert.equal(await page.locator('#new-messages-notice').isVisible(), true);
    check('Actual isolated renderer restores the old-tail anchor at viewport top without advancing read state; unread controls remain visible');

    await scrollMiddle();
    const chosen = await page.evaluate(() => {
      const scroll = document.getElementById('message-scroll'), top = scroll.getBoundingClientRect().top;
      const article = [...scroll.querySelectorAll('article')].find(item => item.getBoundingClientRect().bottom > top + 1);
      article.querySelector('input[type=checkbox]').click();
      return article.dataset.messageId;
    });
    await page.locator('#bookmark-note').fill('未保存草稿：后台更新后仍应保留');
    await page.evaluate(id => {
      window.__readingRegression = { article: [...document.querySelectorAll('article')].find(item => item.dataset.messageId === id),
        input: document.getElementById('bookmark-note'), scroll: document.getElementById('message-scroll') };
    }, chosen);
    const beforeAppend = await snapshot();
    const appended = await application.evaluate(() => {
      globalThis.__readingMock.append('B', 2); return globalThis.__readingMock.append('A', 4);
    });
    await waitRevision(appended.revision);
    await page.waitForSelector('#new-messages-notice', { state: 'visible' });
    await sameAnchor(beforeAppend, 'background-append');
    assert.deepEqual(await page.evaluate(id => ({
      articleSame: window.__readingRegression.article === [...document.querySelectorAll('article')].find(item => item.dataset.messageId === id),
      inputSame: window.__readingRegression.input === document.getElementById('bookmark-note'),
      scrollSame: window.__readingRegression.scroll === document.getElementById('message-scroll'),
      checked: window.__readingRegression.article.querySelector('input[type=checkbox]').checked,
      value: document.getElementById('bookmark-note').value
    }), chosen), { articleSame: true, inputSame: true, scrollSame: true, checked: true, value: '未保存草稿：后台更新后仍应保留' });
    assert.equal(await page.locator('[data-group-id="A"] .unread-badge').innerText(), '4');
    assert.equal(await page.locator('[data-group-id="B"] .unread-badge').innerText(), '2');
    await page.screenshot({ path: path.join(evidence, 'background-keeps-reading.png') });
    check('Background arrivals preserve article/input/scroll identities, exact anchor, selection and draft; both unread badges update');

    await page.locator('#message-scroll').evaluate(scroll => { scroll.scrollTop = scroll.scrollHeight; });
    await settle();
    const oldBottom = await snapshot();
    const oldAppend = await application.evaluate(() => globalThis.__readingMock.append('A', 2));
    await waitRevision(oldAppend.revision);
    await sameAnchor(oldBottom, 'old-page-bottom');
    assert.notEqual((await snapshot()).lastId, oldAppend.latestId);
    assert.equal(await application.evaluate(() => globalThis.__readingMock.stats('A').atBottom), false);
    check('Bottom of a historical page does not enable live-tail following or jump to appended messages');

    await page.locator('#jump-latest').click();
    await page.waitForFunction(id => [...document.querySelectorAll('#message-scroll article')].at(-1)?.dataset.messageId === id, oldAppend.latestId);
    await settle();
    assert.ok(Math.abs((await snapshot()).lastBottomOffset) <= 2, 'Explicit latest action must align the actual last article, not a spacer');
    const beforeTailAppend = await snapshot();
    const readAfterExplicitJump = await application.evaluate(() => globalThis.__readingMock.stats('A'));
    assert.equal(readAfterExplicitJump.readThroughId, oldAppend.latestId);
    assert.equal(readAfterExplicitJump.unreadCount, 0);
    const tailAppend = await application.evaluate(() => globalThis.__readingMock.append('A', 3));
    await waitRevision(tailAppend.revision);
    await settle();
    await sameAnchor(beforeTailAppend, 'arrivals-after-explicit-latest');
    const tailStats = await application.evaluate(() => globalThis.__readingMock.stats('A'));
    assert.equal(tailStats.readThroughId, oldAppend.latestId);
    assert.equal(tailStats.atBottom, false);
    assert.equal(tailStats.unreadCount, 3);
    assert.equal(await page.locator('#new-messages-count').innerText(), '3 条未读');
    await page.screenshot({ path: path.join(evidence, 'latest-then-keeps-arrivals-unread.png') });
    check('Explicit latest action reaches the real tail and updates read progress once; later arrivals preserve the anchor and stay unread');

    const beforeSwitch = await scrollMiddle();
    await page.locator('[data-group-id="B"]').click();
    await page.waitForFunction(() => document.querySelector('.group-item.active')?.dataset.groupId === 'B');
    await page.waitForFunction(() => [...document.querySelectorAll('#message-scroll article')].some(item => item.textContent.includes('群 B')));
    await settle();
    await page.locator('[data-group-id="A"]').click();
    await page.waitForFunction(() => document.querySelector('.group-item.active')?.dataset.groupId === 'A');
    await sameAnchor({ ...beforeSwitch, offset: 0 }, 'group-A-B-A-top');
    check('Switching A → B → A restores the original first visible message at viewport top');

    const beforeResize = await snapshot();
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 840));
    await settle();
    await sameAnchor(beforeResize, 'window-resize');
    const beforeMedia = await snapshot();
    await page.evaluate(id => {
      const articles = [...document.querySelectorAll('#message-scroll article')];
      const index = articles.findIndex(article => article.dataset.messageId === id);
      if (index < 1) throw Error('Fixture requires a preceding message for media resize');
      const placeholder = document.createElement('div');
      placeholder.className = 'regression-media-placeholder';
      placeholder.style.height = '280px';
      placeholder.textContent = '本地模拟媒体容器：延迟获得尺寸';
      articles[index - 1].querySelector('.message-copy').append(placeholder);
    }, beforeMedia.id);
    await settle();
    await sameAnchor(beforeMedia, 'media-height-change');
    await page.screenshot({ path: path.join(evidence, 'resized-anchor.png') });
    check('Window resizing and delayed media-container growth preserve the reading anchor within 2 pixels');

    await page.locator('#auto-sync-toggle').click();
    assert.equal(await application.evaluate(() => globalThis.__readingMock.sync.enabled), false);
    await page.locator('#auto-sync-toggle').click();
    assert.equal(await application.evaluate(() => globalThis.__readingMock.sync.enabled), true);
    check('Automatic-update control calls sync.configure to pause and resume');

    const media = await application.evaluate(() => globalThis.__readingMock.installMedia());
    await waitRevision(media.revision);
    await page.locator('#jump-latest').click();
    await settle();
    const mediaCard = index => page.locator('article[data-message-id="' + media.ids[index] + '"]');
    await mediaCard(0).scrollIntoViewIfNeeded();
    await page.waitForFunction(id => {
      const image = document.querySelector('article[data-message-id="' + id + '"] .message-image');
      return image?.complete && image.naturalWidth === 32;
    }, media.ids[0]);
    await mediaCard(0).locator('.image-button').click();
    let originalRequest = await application.evaluate(() => globalThis.__readingMock.calls.filter(call => call.action === 'image.open').at(-1));
    assert.equal(originalRequest.payload.source, 'app://media/original.png');
    assert.equal(typeof originalRequest.payload.title, 'string');
    assert.ok(originalRequest.payload.caption.length > 0);
    assert.equal(await page.locator('#modal').evaluate(modal => modal.open), false);
    await page.screenshot({ path: path.join(evidence, 'local-original-image.png') });
    await mediaCard(1).scrollIntoViewIfNeeded();
    await mediaCard(1).locator('.image-button').click();
    originalRequest = await application.evaluate(() => globalThis.__readingMock.calls.filter(call => call.action === 'image.open').at(-1));
    assert.equal(originalRequest.payload.source, 'app://media/original-missing.png');
    assert.equal(await page.locator('#modal').evaluate(modal => modal.open), false);
    check('Local PNG thumbnails load through app://media; original clicks pass source/title/caption to the dedicated viewer without opening a reading modal (viewer loading/error/save covered by image-viewer-integration)');

    await mediaCard(2).scrollIntoViewIfNeeded();
    await mediaCard(2).locator('.image-failure').first().waitFor({ state: 'visible' });
    await mediaCard(2).locator('.image-failure').first().getByRole('button', { name: '重试', exact: true }).click();
    await mediaCard(2).locator('.image-failure').first().waitFor({ state: 'visible' });
    const ready = mediaCard(2).locator('.shared-post');
    assert.equal(await ready.locator('.shared-post-title span').innerText(), '微博内容');
    assert.equal(await ready.locator('script').count(), 0);
    assert.ok((await ready.locator('.shared-post-text').innerText()).includes('<script>不可执行</script>'));
    await ready.getByRole('button', { name: /打开原微博/ }).click();
    const opened = await application.evaluate(() => globalThis.__readingMock.calls.filter(call => call.action === 'external.open').at(-1));
    assert.equal(opened.payload.url, 'https://weibo.com/1234567890/MockPost');
    await mediaCard(3).scrollIntoViewIfNeeded();
    const cached = await mediaCard(3).locator('.shared-post').innerText();
    assert.ok(cached.includes('本地缓存'));
    assert.ok(cached.includes('模拟原文当前不可访问'));
    assert.ok(cached.includes('可能不完整'));
    await page.screenshot({ path: path.join(evidence, 'local-shared-posts.png') });
    check('Failed thumbnails retry; ready/cached Weibo cards display text safely, disclose unavailable/truncated content and route links through IPC');

    await mediaCard(3).getByRole('button', { name: '重试读取原文', exact: true }).click();
    const explicitRetry = await application.evaluate(() => globalThis.__readingMock.calls.filter(call => call.action === 'messages.enrich').at(-1));
    assert.equal(explicitRetry.payload.retry, true);
    const deferred = await application.evaluate(() => {
      const mock = globalThis.__readingMock; mock.append('A', 1); const message = mock.data.A.at(-1);
      delete message.images; delete message.sharedPost; delete message.mediaVersion;
      message.text = '分享图片'; mock.deferEnrichment = 1; mock.deferEnrichmentId = message.id; mock.sync.revision++;
      return { id: message.id, revision: mock.sync.revision, start: mock.calls.filter(call => call.action === 'messages.enrich').length };
    });
    await waitRevision(deferred.revision);
    await page.locator('#jump-latest').click();
    await settle();
    await page.locator('article[data-message-id="' + deferred.id + '"]').scrollIntoViewIfNeeded();
    // Other isolated Electron tests may own the OS foreground window. This case
    // exercises the focused-reader enrichment branch with a deterministic fixture.
    await page.evaluate(() => {
      document.hasFocus = () => true;
      document.querySelector('#message-scroll').dispatchEvent(new Event('scroll'));
    });
    await page.waitForFunction(id => !!document.querySelector('article[data-message-id="' + id + '"] .message-image'), deferred.id, { timeout: 12000 });
    await page.evaluate(() => { delete document.hasFocus; });
    const retried = await application.evaluate((_electron, { start, id }) => globalThis.__readingMock.calls.filter(call => call.action === 'messages.enrich').slice(start).filter(call => call.payload.messageIds.includes(id)), { start: deferred.start, id: deferred.id });
    assert.ok(retried.length >= 2, 'A deferred response must release attempted IDs for a later retry');
    assert.ok(retried.every(call => call.payload.messageIds.includes(deferred.id)));
    assert.ok(retried.every(call => call.payload.retry === false));
    check('Explicit unavailable-post retry sets retry:true; deferred automatic enrichment releases its attempted ID and succeeds later');

    const notifications = await application.evaluate(() => {
      const mock = globalThis.__readingMock; mock.append('A', 6);
      const messages = mock.data.A.slice(-6);
      const placeholder = () => ({ state: 'unavailable', reason: '通知未提供原微博地址，无法确定原帖', text: '', images: [] });
      for (const message of messages) { message.text = '我发布了新微博，快来围观吧！'; message.mediaVersion = 1; message.sharedPost = placeholder(); }
      delete messages[1].mediaVersion;
      delete messages[2].mediaVersion; delete messages[2].sharedPost;
      messages[3].sharedPost.url = 'https://weibo.com/1234567890/ActualPost';
      messages[4].sharedPost = { state: 'ready', text: '正常分享正文保留', images: [] };
      messages[5].sharedPost.reason = '原文已删除';
      mock.sync.revision++;
      return { ids: messages.map(message => message.id), revision: mock.sync.revision, original: JSON.stringify(messages) };
    });
    await waitRevision(notifications.revision);
    await page.locator('#jump-latest').click();
    await settle();
    for (const id of notifications.ids.slice(0, 3)) {
      const card = page.locator('article[data-message-id="' + id + '"]');
      assert.equal(await card.locator('.message-text').innerText(), '我发布了新微博，快来围观吧！');
      assert.equal(await card.locator('.shared-post').count(), 0);
      assert.equal(await card.locator('.legacy-share-note').count(), 0);
    }
    for (const id of notifications.ids.slice(3)) assert.equal(await page.locator('article[data-message-id="' + id + '"] .shared-post').count(), 1);
    await page.locator('article[data-message-id="' + notifications.ids[1] + '"]').scrollIntoViewIfNeeded();
    await page.evaluate(() => { document.hasFocus = () => true; document.querySelector('#message-scroll').dispatchEvent(new Event('scroll')); });
    await page.waitForTimeout(700);
    await page.evaluate(() => { delete document.hasFocus; });
    const notificationResult = await application.evaluate((_electron, ids) => {
      const mock = globalThis.__readingMock;
      return { archived: JSON.stringify(mock.data.A.filter(message => ids.includes(message.id))), enrichment: mock.calls.filter(call => call.action === 'messages.enrich' && call.payload.messageIds.some(id => ids.slice(0, 3).includes(id))).length };
    }, notifications.ids);
    assert.equal(notificationResult.archived, notifications.original, 'Renderer compatibility must not edit or delete archived notification records');
    assert.equal(notificationResult.enrichment, 0, 'Plain notices must not trigger detail requests');
    check('Plain publication notices keep original text without legacy placeholders or detail requests; real shares and other unavailable reasons remain intact');

    await application.evaluate(() => { globalThis.__readingMock.readDelay = 120; globalThis.__readingMock.events = []; });
    await page.locator('#message-scroll').evaluate(scroll => { scroll.scrollTop += 33; });
    await page.waitForTimeout(20);
    const closingAnchor = await snapshot();
    await application.evaluate(() => globalThis.__readingMock.beforeClose());
    await application.evaluate(async () => {
      const deadline = Date.now() + 6000;
      while (!globalThis.__readingMock.closeReady && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
      if (!globalThis.__readingMock.closeReady) throw Error('window.closeReady not called');
    });
    const closeInfo = await application.evaluate(() => ({ events: globalThis.__readingMock.events, stats: globalThis.__readingMock.stats('A') }));
    const savedIndex = closeInfo.events.findIndex(event => event.type === 'read-saved');
    const readyIndex = closeInfo.events.findIndex(event => event.action === 'window.closeReady');
    assert.ok(savedIndex >= 0 && readyIndex > savedIndex, 'Close acknowledgement must follow awaited read persistence');
    assert.equal(closeInfo.stats.anchorId, closingAnchor.id);
    assert.ok(Math.abs(closeInfo.stats.anchorOffset - closingAnchor.offset) <= 2);
    check('Before-close callback flushes the current anchor and awaits persistence before window.closeReady');

    assert.deepEqual(errors, []);
    const blockedRequests = await application.evaluate(() => globalThis.__readingMock.blockedRequests);
    assert.deepEqual(blockedRequests, []);
    const mediaRequests = await application.evaluate(() => globalThis.__readingMock.mediaRequests);
    assert.ok(mediaRequests.includes('/thumb.png') && mediaRequests.includes('/missing.png') && mediaRequests.includes('/post.png'));
    assert.ok(!mediaRequests.includes('/original.png') && !mediaRequests.includes('/original-missing.png'),
      'The reading renderer must delegate original-image loading to the dedicated viewer');
    const report = { passed: true, checks, errors, blockedRequests, mediaRequests, measurements, sourceHashes: hashes,
      executablePath, harness, generatedAt: new Date().toISOString(),
      scope: 'Real renderer, isolated mock IPC, no real account/network/credentials; PNG fixture served through a local app://media protocol' };
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: true, checks: checks.length, report: path.join(evidence, 'result.json') }));
  } catch (error) {
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ passed: false, checks, errors,
      measurements, sourceHashes: hashes, harness, failure: String(error), generatedAt: new Date().toISOString() }, null, 2));
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    if (application) await application.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
