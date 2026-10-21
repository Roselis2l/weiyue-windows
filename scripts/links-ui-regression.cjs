'use strict';
// Actual renderer, synthetic imported messages, isolated Electron profile.
// external.open is recorded, never forwarded to an external browser or service.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { assertWindowsRuntimeReadable } = require('./windows-runtime-check.cjs');
const root = path.resolve(__dirname, '..');
const evidence = fs.mkdtempSync(path.join(root, 'artifacts', 'links-ui-'));
const harness = fs.mkdtempSync(path.join(os.tmpdir(), 'weiyue-links-ui-'));
fs.cpSync(path.join(root, 'vendor/runtime'), path.join(harness, 'runtime'), { recursive: true });
fs.cpSync(path.join(root, 'app/renderer'), path.join(harness, 'renderer'), { recursive: true });
const hashes = Object.fromEntries(['app.js', 'index.html', 'style.css', 'linkify.js'].map(name => [
  name, crypto.createHash('sha256').update(fs.readFileSync(path.join(harness, 'renderer', name))).digest('hex'),
]));
fs.writeFileSync(path.join(harness, 'preload.cjs'), `
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('api',{call:(action,payload={})=>ipcRenderer.invoke('mock:call',action,payload),onBeforeClose:()=>()=>{}});
`);
function boot() {
  const { app, BrowserWindow, ipcMain, session } = require('electron'), path = require('node:path');
  app.setPath('userData', path.join(__dirname, 'isolated-profile'));
  const messages = Array.from({ length: 35 }, (_, i) => ({
    id: String(9007199254741000000n + BigInt(i)), groupId: 'g', senderId: 's', senderName: '合成测试',
    time: Date.UTC(2026, 9, 20, 8, i), mediaVersion: 1,
    text: '合成消息 ' + i + '\n请看https://example.com/a(b)?x=1&y=2。\n<img src=x onerror="bad()"> javascript:alert(1)',
    ...(i % 2 === 0 ? { sharedPost: { state: 'ready', author: '模拟作者', text: '正文 http://example.com/post', images: [], url: 'https://weibo.com/123/Abc' } } : {}),
  }));
  const readState = { anchorId: messages[10].id, anchorOffset: 0, atBottom: false, readThroughId: messages[0].id, unreadCount: 34 };
  const mock = globalThis.__linksMock = { calls: [], blocked: [], readState };
  const snapshot = () => ({
    account: { id: 'links-import', name: '合成链接测试', kind: 'import' },
    accounts: [{ id: 'links-import', name: '合成链接测试', kind: 'import' }],
    groups: [{ id: 'g', name: '链接测试群', selected: true, unreadCount: 34 }],
    stats: { messages: messages.length, bookmarks: 0, summaries: 0 }, readPositions: { g: readState.anchorId },
    readStates: { g: readState }, importantMembers: [], settings: {}, credentials: {},
  });
  ipcMain.handle('mock:call', (_event, action, payload) => {
    mock.calls.push({ action, payload });
    switch (action) {
      case 'state': return snapshot();
      case 'messages.query': return { messages, total: messages.length };
      case 'members.list': return [{ id: 's', name: '合成测试' }];
      case 'read.set': Object.assign(readState, payload); return { unreadCount: 34 };
      case 'sync.status': return { enabled: false, revision: 0, accountId: 'links-import' };
      case 'external.open': return true;
      default: throw Error('Unexpected mock action: ' + action);
    }
  });
  app.whenReady().then(() => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      mock.blocked.push(details.url); callback({ cancel: true });
    });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    const win = new BrowserWindow({ width: 1440, height: 930, show: true, webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
    } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.loadFile(path.join(__dirname, 'renderer/index.html'));
  });
  app.on('window-all-closed', () => app.quit());
}
fs.writeFileSync(path.join(harness, 'main.cjs'), '(' + boot.toString() + ')();');
let app, page, failure;
const checks = [], errors = [];
const pass = message => { checks.push(message); console.log('PASS ' + message); };
(async () => {
  try {
    const executablePath = path.join(harness, 'runtime/electron.exe');
    assertWindowsRuntimeReadable(executablePath);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({ executablePath, args: [path.join(harness, 'main.cjs')], cwd: harness, env, timeout: 30000 });
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await page.waitForSelector('article .message-link');
    await page.waitForTimeout(800);
    assert.deepEqual(await page.evaluate(() => ({ require: typeof require, process: typeof process })), { require: 'undefined', process: 'undefined' });
    const prefs = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
    assert.equal(prefs.sandbox, true); assert.equal(prefs.webSecurity, true); assert.equal(prefs.contextIsolation, true);
    pass('Actual renderer starts with sandbox, web security and context isolation');
    const message = page.locator('article[data-message-id="9007199254741000010"]');
    await message.scrollIntoViewIfNeeded(); await page.waitForTimeout(700);
    const anchors = await message.locator('a.message-link').evaluateAll(elements => elements.map(el => ({ text: el.textContent, href: el.getAttribute('href') })));
    assert.equal(anchors.length, 3);
    assert.equal(anchors[0].href, 'https://example.com/a(b)?x=1&y=2');
    assert.equal(anchors[1].href, 'http://example.com/post');
    assert.equal(anchors[2].href, 'https://weibo.com/123/Abc');
    assert.equal(await message.locator('img').count(), 0);
    assert.ok((await message.locator('.message-text').innerText()).includes('<img src=x onerror="bad()">'));
    pass('Message and post links preserve punctuation and parameters while markup remains escaped text');
    const before = await page.evaluate(() => {
      const scroll = document.getElementById('message-scroll');
      return { scrollTop: scroll.scrollTop, selected: [...document.querySelectorAll('.message-check:checked')].length };
    });
    const callsBefore = await app.evaluate(() => globalThis.__linksMock.calls.length);
    await message.locator('a.message-link').first().click();
    await page.waitForTimeout(700);
    const after = await page.evaluate(() => ({ scrollTop: document.getElementById('message-scroll').scrollTop, selected: [...document.querySelectorAll('.message-check:checked')].length }));
    assert.deepEqual(after, before);
    const calls = await app.evaluate((_electron, index) => globalThis.__linksMock.calls.slice(index), callsBefore);
    assert.deepEqual(calls.filter(call => call.action !== 'sync.status'), [
      { action: 'external.open', payload: { url: 'https://example.com/a(b)?x=1&y=2' } },
    ]);
    pass('Trusted click routes once to external.open without changing scroll, selection or read state');
    await message.locator('a.post-original-link').click();
    assert.equal((await app.evaluate(() => globalThis.__linksMock.calls.filter(call => call.action === 'external.open'))).at(-1).payload.url, 'https://weibo.com/123/Abc');
    assert.deepEqual(await app.evaluate(() => globalThis.__linksMock.blocked), []);
    assert.deepEqual(errors, []);
    pass('Original-post click uses the same bridge and no real network or external browser opens in the test');
    await page.screenshot({ path: path.join(evidence, 'synthetic-links.png') });
  } catch (error) { failure = error.stack || error.message; console.error(failure); process.exitCode = 1; }
  finally {
    if (app) await app.close().catch(() => {});
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ checks, failure: failure || null, errors, hashes, harness }, null, 2));
    console.log('Evidence: ' + evidence);
  }
})();
