'use strict';

// Exercises the unchanged packaged EXE (argv[2] or WEIYUE_EXE), or source app.
// Only a new temporary --data-dir is used. The initial account has no remote
// content. All HTTP transports are replaced before importing media fixtures.
// No real account, paid AI endpoint, Notion workspace or browser profile is read.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { assertWindowsRuntimeReadable } = require('./windows-runtime-check.cjs');
const { Store } = require('../app/core/store.cjs');
const root = path.resolve(__dirname, '..');
const requestedExe = process.env.WEIYUE_EXE || process.argv[2];
const packaged = !!requestedExe;
const executablePath = path.resolve(requestedExe || path.join(root, 'vendor', 'runtime', 'electron.exe'));
const harness = fs.mkdtempSync(path.join(os.tmpdir(), 'weiyue-feature-119-'));
const dataDir = path.join(harness, 'data');
const evidence = path.join(root, 'artifacts', 'feature-1.1.9', path.basename(harness));
fs.mkdirSync(evidence, { recursive: true });
fs.mkdirSync(dataDir);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const groupId = '9007199254740993888';
const ids = Array.from({ length: 8 }, (_, i) => String(9007199254740993000n + BigInt(i)));
const start = new Date('2026-10-19T00:00:00Z').getTime(), end = start + 86400000;
const preStore = new Store(path.join(dataDir, 'accounts'));
preStore.ensureAccount({ id: 'import-119-bootstrap', name: '1.1.9 独立合成验证', kind: 'import' });
preStore.mergeMessages('import-119-bootstrap', [{ id: groupId, name: '纯文本启动夹具', selected: true }], [
  { id: ids[0], groupId, senderId: '1', senderName: '测试用户', text: '没有远程媒体的启动记录。', time: start },
]);
preStore.update('import-119-bootstrap', s => { s.settings.autoSyncEnabled = false; });
fs.writeFileSync(path.join(dataDir, 'preferences.json'), JSON.stringify({ activeId: 'import-119-bootstrap' }));
const checks = [], observations = {}, errors = [];
let application, page, failure, finalAudit, exitCode;
const check = (name, details) => { checks.push({ name, ...(details === undefined ? {} : { details }) }); console.log('PASS ' + name); };
const api = (action, payload = {}) => page.evaluate(({ action, payload }) => window.api.call(action, payload), { action, payload });
const audit = () => application.evaluate(() => {
  const a = globalThis.__feature119;
  return { imageCalls: a.imageCalls, aiCalls: a.aiCalls, blocked: a.blocked,
    saveDialogs: a.saveDialogs, confirms: a.confirms, canceledFetches: a.canceledFetches };
});
const control = value => application.evaluate((_, value) => Object.assign(globalThis.__feature119, value), value);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(80); }
  throw new Error('Timed out: ' + description);
}
const capture = (name, target = page) => target.screenshot({ path: path.join(evidence, name + '.png') });
function localInput(timestamp) {
  const d = new Date(timestamp);
  return new Date(timestamp - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
}
async function setRange() {
  await page.locator('#summary-start').fill(localInput(start).slice(0, 16));
  await page.locator('#summary-start').dispatchEvent('change');
  await page.locator('#summary-end').fill(localInput(end).slice(0, 16));
  await page.locator('#summary-end').dispatchEvent('change');
}
async function openViewer(messageId = ids[1]) {
  const pending = application.waitForEvent('window');
  await page.locator(`[data-message-id="${messageId}"] .image-button`).first().click();
  const viewer = await pending;
  viewer.setDefaultTimeout(15000);
  await viewer.waitForURL('app://local/image-viewer.html');
  await viewer.waitForFunction(() => {
    const image = document.getElementById('image');
    return image && !image.hidden && image.complete && image.naturalWidth > 0;
  });
  return viewer;
}
async function closeViewer(viewer, escape = false) {
  const closed = viewer.waitForEvent('close');
  try {
    if (escape) await viewer.keyboard.press('Escape'); else await viewer.locator('#close').click();
  } catch (error) {
    // The frameless window may be destroyed before Playwright receives the
    // input acknowledgment. Only an observed close makes that race successful.
    if (!viewer.isClosed()) throw error;
  }
  await closed;
}
function installMocks(electron, fixtures) {
  const { app, net, session, dialog } = electron;
  const { EventEmitter } = process.getBuiltinModule('node:events'), { Readable } = process.getBuiltinModule('node:stream');
  const a = globalThis.__feature119 = {
    imageCalls: [], aiCalls: [], blocked: [], saveDialogs: [], confirms: [],
    saveQueue: [], confirmQueue: [], waitForAbort: false, canceledFetches: 0,
  };
  const png = Buffer.from(fixtures.png, 'base64'), jpeg = Buffer.from(fixtures.jpeg, 'base64');
  const originalRequest = net.request.bind(net), originalFetch = net.fetch.bind(net);
  net.request = options => {
    const url = String(typeof options === 'string' ? options : options.url);
    if (/^(app|file):/.test(url)) return originalRequest(options);
    const request = new EventEmitter(); let aborted = false;
    request.setHeader = () => {};
    request.abort = () => { aborted = true; request.emit('abort'); };
    request.end = () => setImmediate(() => {
      if (aborted) return;
      a.imageCalls.push(url);
      const parsed = new URL(url);
      if (parsed.origin !== 'https://wx1.sinaimg.cn' || !['/119-original.png', '/119-post.jpg', '/119-denied.png'].includes(parsed.pathname)) {
        a.blocked.push(url); request.emit('error', Error('Unexpected synthetic image request')); return;
      }
      const denied = parsed.pathname === '/119-denied.png', jpg = parsed.pathname.endsWith('.jpg');
      const bytes = denied ? Buffer.from('denied') : jpg ? jpeg : png;
      const response = Readable.from([bytes]);
      response.statusCode = denied ? 403 : 200;
      response.headers = { 'content-type': [denied ? 'text/plain' : jpg ? 'image/jpeg' : 'image/png'], 'content-length': [String(bytes.length)] };
      request.emit('response', response);
    });
    return request;
  };
  net.fetch = async (value, options = {}) => {
    const url = String(value);
    if (/^(app|file):/.test(url)) return originalFetch(value, options);
    if (url !== 'http://127.0.0.1:9999/v1/chat/completions') { a.blocked.push(url); throw Error('Real HTTP forbidden in integration fixture'); }
    const body = JSON.parse(options.body);
    a.aiCalls.push({ url, method: options.method, body });
    if (a.waitForAbort) {
      await new Promise((resolve, reject) => {
        const abort = () => { a.canceledFetches++; reject(new DOMException('Synthetic abort', 'AbortError')); };
        if (options.signal?.aborted) abort(); else options.signal?.addEventListener('abort', abort, { once: true });
      });
    }
    return Response.json({ choices: [{ message: { content: '合成摘要：分享微博包含验证正文，图片已作为视觉输入发送。[M1]\n此处仅为模拟服务响应。' } }] });
  };
  globalThis.fetch = async value => { a.blocked.push(String(value)); throw Error('Global HTTP blocked'); };
  const attached = new WeakSet();
  function attach(current) {
    if (attached.has(current)) return; attached.add(current);
    current.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { a.blocked.push(details.url); callback({ cancel: true }); });
    const original = current.fetch.bind(current);
    current.fetch = async (value, options) => {
      if (/^(app|file):/.test(String(value))) return original(value, options);
      a.blocked.push(String(value)); throw Error('Session HTTP forbidden in import fixture');
    };
  }
  attach(session.defaultSession); app.on('session-created', attach);
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixtures.importFile] });
  dialog.showSaveDialog = async (_, options) => {
    a.saveDialogs.push(options);
    return a.saveQueue.shift() || { canceled: true };
  };
  dialog.showMessageBox = async (_, options) => {
    a.confirms.push({ title: options.title, message: options.message, detail: options.detail, buttons: options.buttons });
    return { response: a.confirmQueue.shift() ?? 0 };
  };
}

(async () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  observations.preflight = assertWindowsRuntimeReadable(executablePath);
  observations.executablePath = executablePath;
  observations.executableSha256 = digest(fs.readFileSync(executablePath));
  observations.packaged = packaged;
  application = await _electron.launch({ executablePath, args: [...(packaged ? [] : [root]), '--data-dir=' + dataDir], cwd: root, env, timeout: 45000 });
  page = await application.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof window.api?.call === 'function');
  const initial = await api('state');
  assert.equal(path.resolve(initial.dataRoot), path.resolve(dataDir));
  assert.equal(initial.account.id, 'import-119-bootstrap');
  observations.version = await application.evaluate(({ app }) => app.getVersion());
  observations.pid = application.process().pid;
  fs.writeFileSync(path.join(evidence, 'launch.json'), JSON.stringify({ pid: observations.pid, dataDir, executablePath }, null, 2));
  const sourceRoot = packaged ? path.join(path.dirname(executablePath), 'resources', 'app') : root;
  observations.sourceHashes = Object.fromEntries([
    'app/main.cjs', 'app/core/image-viewer.cjs', 'app/core/summary.cjs', 'app/core/summary-content.cjs',
    'app/core/ai-preview.cjs', 'app/renderer/app.js', 'app/renderer/style.css', 'app/renderer/image-viewer.js',
  ].map(file => [file, digest(fs.readFileSync(path.join(sourceRoot, file)))]));
  check('Actual executable starts with independent synthetic data directory', { version: observations.version, packaged });

  // The browser generates genuinely decodable PNG/JPEG bytes, not image URLs
  // or fake headers; the same buffers are used by the mock transport and audit.
  const images = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 2048; canvas.height = 1536;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#dcebd1'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#41623a'; ctx.font = '80px sans-serif'; ctx.fillText('119 SYNTHETIC ORIGINAL', 100, 200);
    ctx.fillStyle = '#b58d55'; ctx.fillRect(300, 400, 900, 600);
    const png = canvas.toDataURL('image/png').split(',')[1];
    canvas.width = 800; canvas.height = 600;
    ctx.fillStyle = '#ede1c8'; ctx.fillRect(0, 0, 800, 600);
    ctx.fillStyle = '#304e30'; ctx.font = '50px sans-serif'; ctx.fillText('SHARED POST 119', 70, 220);
    return { png, jpeg: canvas.toDataURL('image/jpeg', 0.9).split(',')[1] };
  });
  const pngBytes = Buffer.from(images.png, 'base64'), jpegBytes = Buffer.from(images.jpeg, 'base64');
  observations.fixtureImages = { png: { bytes: pngBytes.length, sha256: digest(pngBytes) }, jpeg: { bytes: jpegBytes.length, sha256: digest(jpegBytes) } };
  const makeMessage = (index, text, extra = {}) => ({
    id: ids[index], groupId, senderId: index % 2 ? '71' : '72', senderName: index % 2 ? '林间 · 合成成员' : '夏禾 · 合成成员',
    time: start + index * 1000, text, mediaVersion: 1, ...extra,
  });
  const fixture = { groups: [{ id: groupId, name: '1.1.9 多模态合成验证群', selected: true }], messages: [
    makeMessage(0, 'OUTSIDE_RANGE_MUST_NOT_SEND', { time: start - 1000 }),
    makeMessage(1, '请查看这张合成原图。', { images: [{ url: 'https://wx1.sinaimg.cn/119-original.png', width: 2048, height: 1536 }] }),
    makeMessage(2, '分享微博：验证正文和转发上下文。', { sharedPost: {
      state: 'ready', id: '9007199254740993991', url: 'https://weibo.com/71/Fixture119', author: '合成微博作者',
      text: 'SHARED_POST_BODY_119：先整理问题，再核对依据。转发原文：REPOST_BODY_119 不要忽略原作者的修正。',
      images: [{ url: 'https://wx1.sinaimg.cn/119-post.jpg', width: 800, height: 600 }, { url: 'https://wx1.sinaimg.cn/119-original.png', width: 2048, height: 1536 }],
    } }),
    makeMessage(3, '分享的微博暂无可读正文。', { sharedPost: { state: 'unavailable', text: '', images: [], url: 'https://weibo.com/71/Missing119', reason: '合成夹具：原帖不可访问' } }),
    makeMessage(4, '我发布了新微博，快来围观吧！'),
    makeMessage(5, '这张图片模拟权限不足。', { images: [{ url: 'https://wx1.sinaimg.cn/119-denied.png', width: 32, height: 20 }] }),
    makeMessage(6, '成员切换后的紧凑间距仍保留昵称与时间。'),
    makeMessage(7, 'END_EXCLUSIVE_MUST_NOT_SEND', { time: end }),
  ] };
  const importFile = path.join(harness, '1.1.9 合成消息.json');
  fs.writeFileSync(importFile, JSON.stringify(fixture));
  await application.evaluate(installMocks, { ...images, importFile });
  await page.locator('#import-button').click();
  await until(async () => (await api('state')).account.id !== 'import-119-bootstrap', 'synthetic import account activated');
  await page.locator(`[data-group-id="${groupId}"]`).click();
  await page.locator(`[data-message-id="${ids[1]}"] .message-image`).first().waitFor();
  await until(() => page.locator(`[data-message-id="${ids[1]}"] .message-image`).first().evaluate(img => img.complete && img.naturalWidth === 2048), 'fixture image decoded');
  const layout = await page.locator('.message').evaluateAll(cards => cards.map(card => {
    const css = getComputedStyle(card);
    return { id: card.dataset.messageId, paddingTop: parseFloat(css.paddingTop), paddingBottom: parseFloat(css.paddingBottom),
      name: card.querySelector('.sender-name')?.textContent, time: card.querySelector('.message-time')?.textContent,
      nameVisible: !!card.querySelector('.sender-name')?.getClientRects().length, timeVisible: !!card.querySelector('.message-time')?.getClientRects().length };
  }));
  assert(layout.length >= 7);
  assert(layout.every(card => card.nameVisible && card.timeVisible && card.name && card.time));
  assert(layout.every(card => card.paddingTop <= 10 && card.paddingBottom <= 10), '1.1.9 message padding should be smaller than 1.1.8 (15px)');
  observations.layout = layout;
  await capture('01-compact-reading');
  check('Compact chat spacing keeps each member name and timestamp', layout[1]);

  let viewer = await openViewer();
  const viewerInfo = await application.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(win => win.webContents.getURL() === 'app://local/image-viewer.html');
    const prefs = win.webContents.getLastWebPreferences();
    return { bounds: win.getBounds(), contentBounds: win.getContentBounds(), resizable: win.isResizable(),
      sandbox: prefs.sandbox, nodeIntegration: prefs.nodeIntegration, contextIsolation: prefs.contextIsolation, webSecurity: prefs.webSecurity };
  });
  assert(viewerInfo.sandbox && viewerInfo.contextIsolation && viewerInfo.webSecurity && !viewerInfo.nodeIntegration && viewerInfo.resizable);
  assert(viewerInfo.bounds.width >= 640 && viewerInfo.bounds.height >= 480);
  assert(Math.abs(viewerInfo.bounds.height - viewerInfo.contentBounds.height) <= 2, 'frameless content covers outer height');
  assert.equal(await viewer.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await viewer.evaluate(() => typeof window.api), 'undefined');
  const csp = await viewer.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  assert(csp.includes("connect-src 'none'") && csp.includes('img-src data:'));
  observations.viewer = { ...viewerInfo, csp };
  check('Independent large frameless viewer has isolated trusted bridge, sandbox, no Node and strict CSP', observations.viewer);
  const initialZoom = await viewer.locator('#zoom-value').textContent();
  await viewer.locator('#actual').click(); assert.equal(await viewer.locator('#zoom-value').textContent(), '100%');
  await viewer.locator('#zoom-in').click(); assert.equal(await viewer.locator('#zoom-value').textContent(), '125%');
  await viewer.locator('#zoom-out').click(); assert.equal(await viewer.locator('#zoom-value').textContent(), '100%');
  const beforePan = await viewer.locator('#image').evaluate(img => img.style.transform);
  const box = await viewer.locator('#viewport').boundingBox();
  await viewer.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await viewer.mouse.down();
  await viewer.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 70, { steps: 6 }); await viewer.mouse.up();
  assert.notEqual(await viewer.locator('#image').evaluate(img => img.style.transform), beforePan);
  await viewer.locator('#fit').click(); assert.equal(await viewer.locator('#zoom-value').textContent(), initialZoom);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('/image-viewer.html')).setSize(850, 650));
  await until(async () => (await viewer.locator('#zoom-value').textContent()) !== initialZoom, 'fit follows native window resize');
  await viewer.locator('#actual').click(); await capture('02-viewer-original-size', viewer);
  check('Viewer zoom, original size, fit, drag pan and resize all operate');

  const canceledFile = path.join(harness, 'canceled.png'), savedFile = path.join(harness, 'saved-original.png');
  await control({ saveQueue: [{ canceled: true, filePath: canceledFile }] });
  await viewer.locator('#save').click();
  await until(async () => (await viewer.locator('#save-status').textContent()).includes('取消'), 'save cancel');
  assert(!fs.existsSync(canceledFile));
  await control({ saveQueue: [{ canceled: false, filePath: savedFile }] });
  await viewer.locator('#save').click();
  await until(async () => (await viewer.locator('#save-status').textContent()).includes('已保存原图') && await viewer.locator('#save').isEnabled(), 'PNG save IPC completion');
  assert.equal(digest(fs.readFileSync(savedFile)), digest(pngBytes));
  fs.writeFileSync(savedFile, 'synthetic existing file to overwrite');
  await control({ saveQueue: [{ canceled: false, filePath: savedFile }] });
  await viewer.locator('#save').click();
  await until(() => digest(fs.readFileSync(savedFile)) === digest(pngBytes), 'overwrite original');
  const saveAudit = await audit();
  assert(saveAudit.saveDialogs.every(options => options.properties.includes('showOverwriteConfirmation')));
  assert(saveAudit.saveDialogs.every(options => options.filters[0].extensions.includes('png')));
  check('Save As cancel writes nothing; save/overwrite preserves exact PNG bytes and requests native overwrite confirmation');
  await closeViewer(viewer, true);
  viewer = await openViewer(ids[2]);
  const savedJpeg = path.join(harness, 'saved-post.jpg');
  await control({ saveQueue: [{ canceled: false, filePath: savedJpeg }] });
  await viewer.locator('#save').click();
  await until(async () => (await viewer.locator('#save-status').textContent()).includes('已保存原图') && await viewer.locator('#save').isEnabled(), 'JPEG save IPC completion');
  assert.equal(digest(fs.readFileSync(savedJpeg)), digest(jpegBytes));
  await closeViewer(viewer);
  await assert.rejects(() => api('image.open', { source: 'https://wx1.sinaimg.cn/119-original.png' }), /原图地址/);
  check('JPEG saves original format; Esc and close button close viewer; untrusted image source rejected');

  const settings = { providerId: 'custom', endpoint: 'http://127.0.0.1:9999/v1', model: 'fixture-vision-119',
    aiVisionMode: 'enabled', keyAction: 'replace', aiKey: 'synthetic-test-key-never-valid' };
  await api('settings.ai.save', settings);
  await page.reload(); await page.waitForFunction(() => typeof window.api?.call === 'function');
  await page.locator(`[data-group-id="${groupId}"]`).click(); await setRange();
  await page.locator('#generate-ai').click();
  await page.locator('#ai-content-scope').waitFor();
  const previewText = await page.locator('#ai-content-scope').textContent();
  assert(previewText.includes('分享微博正文：1 条') && previewText.includes('实际图片：2 张'));
  assert(await page.locator('#confirm-ai-send').isDisabled());
  assert((await page.locator('#ai-omissions').textContent()).includes('未完整纳入'));
  assert.equal((await audit()).aiCalls.length, 0);
  await capture('03-ai-content-preview');
  await page.locator('#modal-close').click();
  assert.equal((await audit()).aiCalls.length, 0);
  check('Prepare preview shows actual posts, two unique images, omissions and cost consent; dismiss sends no AI request');

  const range = { groupId, start, end };
  const prepare = requestId => api('summary.ai.prepare', { ...range, requestId });
  let preview = await prepare('fixture-unconfirmed');
  assert.equal(preview.contentScope.imageCount, 2); assert.equal(preview.contentScope.postCount, 1);
  assert(preview.contentScope.omissions.length >= 2); assert.equal(preview.messageCount, 6);
  await assert.rejects(() => api('summary.ai', { previewId: preview.previewId, confirmed: false }), /确认/);
  assert.equal((await audit()).aiCalls.length, 0);
  await control({ confirmQueue: [0] });
  await assert.rejects(() => api('summary.ai', { previewId: preview.previewId, confirmed: true, requestId: 'fixture-native-cancel' }), /取消/);
  assert.equal((await audit()).aiCalls.length, 0);
  check('Unconfirmed IPC and native confirmation cancellation cannot send AI content');

  // Drive the successful send through the actual consent UI as well as native
  // confirmation mock, then inspect the real main-process request body.
  await control({ confirmQueue: [1] });
  await page.locator('#generate-ai').click(); await page.locator('#ai-content-scope').waitFor();
  await page.locator('#ai-consent').check(); await page.locator('#confirm-ai-send').click();
  await until(async () => (await api('summary.list')).length === 1, 'AI summary saved after consent');
  const successful = await audit(); assert.equal(successful.aiCalls.length, 1);
  const payload = successful.aiCalls[0].body;
  const parts = payload.messages.flatMap(message => Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content }]);
  const dataImages = parts.filter(part => part.type === 'image_url').map(part => part.image_url.url);
  assert.equal(dataImages.length, 2);
  assert(dataImages.every(url => /^data:image\/(png|jpeg);base64,/.test(url)));
  const sentHashes = dataImages.map(url => digest(Buffer.from(url.split(',')[1], 'base64'))).sort();
  assert.deepEqual(sentHashes, [digest(pngBytes), digest(jpegBytes)].sort());
  const sentText = parts.filter(part => part.type === 'text').map(part => part.text).join('\n');
  assert(sentText.includes('SHARED_POST_BODY_119') && sentText.includes('REPOST_BODY_119'));
  assert(!sentText.includes('OUTSIDE_RANGE_MUST_NOT_SEND') && !sentText.includes('END_EXCLUSIVE_MUST_NOT_SEND'));
  const savedSummary = (await api('summary.list'))[0];
  assert(!JSON.stringify(savedSummary).includes('data:image/'), 'persistent summaries must not retain image data URLs');
  observations.sentRequest = { url: successful.aiCalls[0].url, model: payload.model, imageHashes: sentHashes,
    imageCount: dataImages.length, postBodyIncluded: true, boundaryExcluded: true, maxTokens: payload.max_tokens ?? payload.max_completion_tokens };
  await assert.rejects(() => api('summary.ai', { previewId: preview.previewId, confirmed: true }), /预览|准备|失效/);
  check('Explicit UI consent sends actual PNG/JPEG byte payloads and shared/reposted text, excludes [end] and earlier records, saves no base64', observations.sentRequest);

  await api('settings.ai.save', { ...settings, aiVisionMode: 'auto', keyAction: 'keep', aiKey: '' });
  preview = await prepare('fixture-no-vision');
  assert.equal(preview.contentScope.imageCount, 0);
  assert.equal(preview.contentScope.vision.supported, false);
  assert(preview.contentScope.omissions.some(item => item.kind === 'image'));
  await control({ confirmQueue: [1] });
  await api('summary.ai', { previewId: preview.previewId, confirmed: true, requestId: 'fixture-text-only' });
  const textOnly = (await audit()).aiCalls.at(-1).body;
  assert(textOnly.messages.every(message => !Array.isArray(message.content) || !message.content.some(part => part.type === 'image_url')));
  assert(JSON.stringify(textOnly).includes('SHARED_POST_BODY_119'));
  check('Unconfirmed vision capability is explicitly omitted; text-only request retains accessible post body');

  await api('settings.ai.save', { ...settings, keyAction: 'keep', aiKey: '' });
  preview = await prepare('fixture-cancel-network');
  const summariesBeforeCancel = (await api('summary.list')).length, requestsBeforeCancel = (await audit()).aiCalls.length;
  await control({ waitForAbort: true, confirmQueue: [1] });
  const sending = api('summary.ai', { previewId: preview.previewId, confirmed: true, requestId: 'fixture-active-cancel' }).then(
    () => ({ resolved: true }), error => ({ error: error.message }));
  await until(async () => (await audit()).aiCalls.length === requestsBeforeCancel + 1, 'pending synthetic AI request');
  await api('summary.ai.cancel', { requestId: 'fixture-active-cancel' });
  const canceled = await sending;
  assert(canceled.error && /取消|中断|abort/i.test(canceled.error));
  assert.equal((await api('summary.list')).length, summariesBeforeCancel);
  await control({ waitForAbort: false });
  assert.equal((await audit()).canceledFetches, 1);
  check('Active AI cancellation aborts transport, saves no partial summary and does not retry');

  finalAudit = await audit();
  assert.equal(finalAudit.blocked.length, 0, 'no unmocked network attempts');
  assert.equal(errors.length, 0);
  await capture('04-completed-reading');
  check('All external requests stayed inside mocks; no renderer exceptions');
})().catch(error => {
  failure = { message: String(error.message).slice(0, 8000), stack: String(error.stack).slice(0, 10000) };
  console.error(failure.stack);
}).finally(async () => {
  if (application) {
    try { finalAudit = await audit(); } catch {}
    if (failure && page && !page.isClosed()) try { await capture('failure'); } catch {}
    const process = application.process();
    try { await application.close(); } catch {}
    exitCode = process.exitCode;
  }
  // Synthetic request bodies may include only generated test data, never keys.
  // Retaining them proves the actual image_url payload rather than UI wording.
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ success: !failure, checks, observations,
    failure, errors, exitCode, harness, dataDir, audit: finalAudit }, null, 2));
  console.log('EVIDENCE ' + evidence);
  process.exitCode = failure ? 1 : 0;
});
