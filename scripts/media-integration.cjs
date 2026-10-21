'use strict';
const {assertWindowsRuntimeReadable}=require('./windows-runtime-check.cjs');

// Actual main/preload/core/renderer with fresh synthetic account storage. Every
// HTTP transport is mocked before main starts; no existing profile is accessed.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const sourceVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const harness = fs.mkdtempSync(path.join(os.tmpdir(), 'weiyue-media-integration-'));
const evidence = path.resolve(process.env.WEIYUE_MEDIA_TEST_OUTPUT || path.join(root, 'artifacts', 'media-integration'));
const dataDir = path.join(harness, 'data');
fs.mkdirSync(evidence, { recursive: true });
fs.mkdirSync(dataDir);
fs.cpSync(path.join(root, 'vendor', 'runtime'), path.join(harness, 'runtime'), { recursive: true });
fs.cpSync(path.join(root, 'app'), path.join(harness, 'app'), { recursive: true });
const sourceHashes = {};
for (const file of fs.readdirSync(path.join(root, 'app'), { recursive: true })) {
  const full = path.join(root, 'app', file);
  if (fs.statSync(full).isFile()) sourceHashes[file] = crypto.createHash('sha256').update(fs.readFileSync(path.join(harness, 'app', file))).digest('hex');
}
const fixture = { identity: '9007199254740993999', groupId: '9007199254740993888',
  ids: Array.from({ length: 6 }, (_, i) => String(9007199254740993001n + BigInt(i))) };
fixture.accountId = 'weibo-' + fixture.identity;
const { Store } = require(path.join(harness, 'app', 'core', 'store.cjs'));
const store = new Store(path.join(dataDir, 'accounts'));
store.ensureAccount({ id: fixture.accountId, name: '媒体集成模拟账号', kind: 'weibo' });
store.ensureAccount({ id: 'import-media-other', name: '第二个隔离模拟账号', kind: 'import' });
const messages = fixture.ids.map((id, index) => ({ id, groupId: fixture.groupId,
  senderId: '71', senderName: '模拟群成员', time: 1700000000000 + index * 1000,
  text: index < 3 ? '媒体代理模拟消息 ' + index : index === 3 ? '发送图片' : '我发布了新微博，快来围观吧！',
  ...(index < 3 ? { mediaVersion: 1, images: [{ url: 'https://wx1.sinaimg.cn/' + ['direct.png', 'redirect.png', 'denied.png'][index], width: 32, height: 20 }] } : {}) }));
const groups = [{ id: fixture.groupId, name: '模拟媒体测试群', selected: true }];
store.mergeMessages(fixture.accountId, groups, messages);
store.mergeMessages('import-media-other', groups, [messages[0]]);
store.update(fixture.accountId, state => { state.settings.autoSyncEnabled = false; });
fs.writeFileSync(path.join(dataDir, 'preferences.json'), JSON.stringify({ activeId: fixture.accountId }));

function boot(fixtures) {
  const { app, net, session, safeStorage } = require('electron');
  const { EventEmitter } = require('node:events');
  const { Readable } = require('node:stream');
  const info = globalThis.__mediaIntegration = { imageCalls: [], apiCalls: [], blocked: [],
    forbiddenRedirectTarget: 'https://not-allowed.invalid/private.png' };
  // Generated 32x20 RGBA PNG; exact bytes are compared after the real protocol.
  const crc32 = bytes => { let crc = -1; for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ -1) >>> 0; };
  const chunk = (type, body) => { const label = Buffer.from(type), size = Buffer.alloc(4), crc = Buffer.alloc(4); size.writeUInt32BE(body.length); crc.writeUInt32BE(crc32(Buffer.concat([label, body]))); return Buffer.concat([size, label, body, crc]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(32, 0); header.writeUInt32BE(20, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc(20 * 129);
  for (let y = 0; y < 20; y++) for (let x = 0; x < 32; x++) { const i = y * 129 + 1 + x * 4; rows[i] = 60 + x * 3; rows[i + 1] = 110 + y * 3; rows[i + 2] = 80; rows[i + 3] = 255; }
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', require('node:zlib').deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
  info.pngHash = require('node:crypto').createHash('sha256').update(png).digest('hex');
  info.enableSyntheticSession = () => {
    const { Vault } = require('./app/core/security.cjs');
    const credentialsDir = require('node:path').resolve(app.getPath('userData'), '..', 'credentials');
    new Vault(credentialsDir, safeStorage).write(fixtures.accountId, { cookies: [{
      name: 'SUB', value: 'local-fixture-only-not-a-real-cookie', domain: 'api.weibo.com',
      path: '/', secure: true, httpOnly: true, hostOnly: true
    }] });
  };
  const originalRequest = net.request.bind(net);
  net.request = options => {
    const target = typeof options === 'string' ? options : options.url;
    if (/^(app|file):/i.test(String(target))) return originalRequest(options);
    const request = new EventEmitter(), headers = {};
    let aborted = false;
    request.setHeader = (name, value) => { headers[name] = value; };
    request.abort = () => { aborted = true; request.emit('abort'); };
    request.end = () => setImmediate(() => {
      if (aborted) return;
      const url = new URL(options.url);
      info.imageCalls.push({ url: url.href, headers: { ...headers }, redirect: options.redirect,
        credentials: options.credentials, isolatedSession: options.session !== session.defaultSession });
      if (url.hostname !== 'wx1.sinaimg.cn' && url.hostname !== 'wx2.sinaimg.cn') { info.blocked.push(url.href); request.emit('error', new Error('Blocked unexpected image request')); return; }
      if (url.pathname === '/redirect.png') { request.emit('redirect', 302, 'GET', 'https://wx2.sinaimg.cn/final.png'); return; }
      if (url.pathname === '/denied.png') { request.emit('redirect', 302, 'GET', info.forbiddenRedirectTarget); return; }
      const response = Readable.from([png]); response.statusCode = 200;
      response.headers = { 'content-type': ['image/png'], 'content-length': [String(png.length)] };
      request.emit('response', response);
    });
    return request;
  };
  const originalFetch = net.fetch.bind(net);
  net.fetch = (url, options) => {
    if (/^https?:/i.test(String(url))) { info.blocked.push(String(url)); return Promise.reject(Error('Real HTTP blocked')); }
    return originalFetch(url, options);
  };
  const attached = new WeakSet();
  function attach(current) {
    if (attached.has(current)) return; attached.add(current);
    current.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { info.blocked.push(details.url); callback({ cancel: true }); });
    const original = current.fetch.bind(current);
    current.fetch = async (value, options = {}) => {
      const url = new URL(String(value));
      if (url.protocol === 'app:' || url.protocol === 'file:') return original(value, options);
      info.apiCalls.push({ url: url.href, referer: options.headers?.Referer, credentials: options.credentials });
      if (url.origin !== 'https://api.weibo.com') { info.blocked.push(url.href); throw Error('Unexpected API origin'); }
      if (url.pathname === '/webim/query_primary_info.json') return Response.json({ profile: { id: fixtures.identity, screen_name: '媒体集成模拟账号' } });
      if (url.pathname === '/webim/groupchat/query_messages.json') return Response.json({ messages: [
        { id: '9007199254740993007', gid: fixtures.groupId, from_uid: '71', from_user: { screen_name: '模拟群成员' }, time: 1700000010, content: '真实60秒调度器收到的本地模拟新消息' },
        { id: fixtures.ids[5], gid: fixtures.groupId, from_uid: '71', from_user: { screen_name: '模拟群成员' }, time: 1700000005, content: '我发布了新微博，快来围观吧！', url: 'https://weibo.com/71/MissingPost' }
      ] });
      if (url.pathname !== '/webim/groupchat/query_message.json') { info.blocked.push(url.href); throw Error('Unexpected API endpoint'); }
      const id = url.searchParams.get('mid');
      const message = { id, gid: fixtures.groupId, from_uid: '71', from_user: { screen_name: '模拟群成员' }, time: 1700000000,
        content: id === fixtures.ids[3] ? '发送图片' : '我发布了新微博，快来围观吧！' };
      if (id === fixtures.ids[3]) message.pic_infos = [{ original_pic: 'https://wx1.sinaimg.cn/enriched.png', thumbnail_pic: 'https://wx1.sinaimg.cn/enriched-thumb.png', width: 32, height: 20 }];
      if (id === fixtures.ids[4]) message.url_objects = [{ info: { url_long: 'https://weibo.com/71/MockPost' }, status: {
        idstr: '9007199254740993777', user: { screen_name: '模拟微博作者' },
        text: '<p>集成测试微博正文</p><script>window.unsafeRan=true</script>', pic_urls: [{ large: { url: 'https://wx1.sinaimg.cn/post.png' } }] } }];
      if (id === fixtures.ids[5]) message.url = 'https://weibo.com/71/MissingPost';
      return Response.json({ message });
    };
  }
  app.on('session-created', attach);
  app.whenReady().then(() => attach(session.defaultSession));
  require('./app/main.cjs');
}
fs.writeFileSync(path.join(harness, 'boot.cjs'), '(' + boot.toString() + ')(' + JSON.stringify(fixture) + ');\n');

let application, page, nativeChild, nativeRun;
const checks = [], errors = [], expectedMediaErrors = [];
const check = text => { checks.push(text); console.log('PASS ' + text); };
const api = (action, payload = {}) => page.evaluate(({ action, payload }) => window.api.call(action, payload), { action, payload });
const query = () => api('messages.query', { groupId: fixture.groupId, limit: 100, offset: 0 });
const mediaFetch = async url => {
  const value = await application.evaluate(async ({ net }, target) => {
  const response = await net.fetch(target);
  const bytes = Buffer.from(await response.arrayBuffer());
  return { status: response.status, type: response.headers.get('content-type'), noSniff: response.headers.get('x-content-type-options'),
    bytes: Array.from(bytes) };
  }, url);
  const { bytes, ...result } = value;
  return { ...result, hash: crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex') };
};
const anchor = () => page.evaluate(() => {
  const scroll = document.getElementById('message-scroll'), box = scroll.getBoundingClientRect();
  const article = [...scroll.querySelectorAll('article')].find(item => item.getBoundingClientRect().bottom > box.top + 1);
  return { id: article?.dataset.messageId, offset: article?.getBoundingClientRect().top - box.top };
});

(async () => {
  try {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    assertWindowsRuntimeReadable(path.join(harness, 'runtime', 'electron.exe'));
    application = await _electron.launch({ executablePath: path.join(harness, 'runtime', 'electron.exe'),
      args: [path.join(harness, 'boot.cjs'), '--data-dir=' + dataDir], cwd: harness, env, timeout: 30000 });
    nativeChild = application.process();
    nativeRun = { pid: nativeChild.pid, startedAt: new Date().toISOString(), exitCode: null, signal: null };
    nativeChild.once('exit', (code, signal) => { nativeRun.exitCode = code; nativeRun.signal = signal; nativeRun.exitedAt = new Date().toISOString(); });
    page = await application.firstWindow();
    console.log('Window created at ' + page.url());
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() !== 'error') return;
      if (message.location().url.startsWith('app://media/') && /502|ERR_FAILED/.test(message.text())) expectedMediaErrors.push(message.text());
      else errors.push(message.text());
    });
    await page.waitForSelector('article[data-message-id]');
    const state = await api('state');
    assert.equal(state.account.id, fixture.accountId); assert.equal(state.sessionReady, false);
    assert.equal(path.resolve(state.dataRoot), dataDir);
    assert.equal((await api('sync.status')).enabled, false);
    const isolation = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => {
      const prefs = window.webContents.getLastWebPreferences(); return { sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration };
    }));
    assert.ok(isolation.every(prefs => prefs.sandbox && prefs.contextIsolation && !prefs.nodeIntegration));
    assert.deepEqual(await page.evaluate(() => ({ require: typeof require, process: typeof process })), { require: 'undefined', process: 'undefined' });
    check('Actual main/preload/renderer starts from a fresh mock account with sandbox and no credentials');

    const initial = (await query()).messages;
    const direct = await mediaFetch(initial[0].images[0].src);
    const expectedHash = await application.evaluate(() => globalThis.__mediaIntegration.pngHash);
    assert.deepEqual(direct, { status: 200, type: 'image/png', noSniff: 'nosniff', hash: expectedHash });
    await page.waitForFunction(id => document.querySelector('article[data-message-id="' + id + '"] img')?.naturalWidth === 32, fixture.ids[0]);
    const beforeCache = await application.evaluate(() => globalThis.__mediaIntegration.imageCalls.filter(call => call.url.endsWith('/direct.png')).length);
    await mediaFetch(initial[0].images[0].originalSrc);
    assert.equal(await application.evaluate(() => globalThis.__mediaIntegration.imageCalls.filter(call => call.url.endsWith('/direct.png')).length), beforeCache);
    check('Real app://media protocol returns byte-identical PNG with nosniff; renderer decodes it and preview/original share cache');

    const redirected = await mediaFetch(initial[1].images[0].src);
    assert.equal(redirected.status, 200); assert.equal(redirected.hash, expectedHash);
    const denied = await mediaFetch(initial[2].images[0].src);
    assert.equal(denied.status, 502);
    const transport = await application.evaluate(() => globalThis.__mediaIntegration.imageCalls);
    assert.ok(transport.some(call => call.url === 'https://wx2.sinaimg.cn/final.png'));
    assert.ok(transport.every(call => !call.url.includes('not-allowed.invalid')));
    assert.ok(transport.every(call => call.redirect === 'manual' && call.credentials === 'include' && call.isolatedSession));
    assert.ok(transport.every(call => call.headers.Referer === 'https://api.weibo.com/' && !Object.keys(call.headers).some(key => key.toLowerCase() === 'cookie')));
    check('Native redirect event permits the image CDN hop and rejects foreign targets before a request; cookies are never copied into headers');

    const enriched = await api('messages.enrich', { groupId: fixture.groupId, messageIds: fixture.ids.slice(3) });
    assert.equal(enriched.count, 3);
    const after = (await query()).messages;
    assert.equal(after[3].mediaVersion, 1); assert.equal(after[3].images[0].width, 32);
    assert.equal((await mediaFetch(after[3].images[0].src)).hash, expectedHash);
    assert.equal(after[4].sharedPost.state, 'ready');
    assert.equal(after[4].sharedPost.id, '9007199254740993777');
    assert.equal(after[4].sharedPost.text, '集成测试微博正文');
    assert.equal(after[5].sharedPost.state, 'unavailable');
    assert.equal(after[5].sharedPost.url, 'https://weibo.com/71/MissingPost');
    assert.deepEqual(after.map(message => message.id), fixture.ids);
    const freshStore = new Store(path.join(dataDir, 'accounts'));
    assert.equal(freshStore.get(fixture.accountId).messages[3].mediaVersion, 1);
    assert.equal(freshStore.get(fixture.accountId).messages.length, 6);
    check('Actual identity/detail API adapter enriches three existing records, preserves exact IDs and atomically persists image/ready/unavailable content');

    const beforeRetry = await application.evaluate(() => globalThis.__mediaIntegration.apiCalls.filter(call => call.url.includes('query_message')).length);
    assert.equal((await api('messages.enrich', { groupId: fixture.groupId, messageIds: fixture.ids.slice(3) })).count, 0);
    assert.equal(await application.evaluate(() => globalThis.__mediaIntegration.apiCalls.filter(call => call.url.includes('query_message')).length), beforeRetry);
    const calls = await application.evaluate(() => globalThis.__mediaIntegration.apiCalls);
    assert.ok(calls.every(call => call.referer === 'https://api.weibo.com/chat' && call.credentials === 'include'));
    assert.deepEqual(calls.filter(call => call.url.includes('query_message')).map(call => new URL(call.url).searchParams.get('mid')), fixture.ids.slice(3));
    check('Repeated enrichment makes no duplicate detail requests; official-source headers and 19-digit request IDs remain intact');

    await page.waitForSelector('article[data-message-id="' + fixture.ids[4] + '"] .shared-post');
    const readyCard = page.locator('article[data-message-id="' + fixture.ids[4] + '"]');
    await readyCard.scrollIntoViewIfNeeded();
    assert.ok((await readyCard.innerText()).includes('集成测试微博正文'));
    assert.equal(await readyCard.locator('script').count(), 0);
    assert.equal(await page.evaluate(() => window.unsafeRan), undefined);
    const unavailableCard = page.locator('article[data-message-id="' + fixture.ids[5] + '"]');
    await unavailableCard.scrollIntoViewIfNeeded();
    assert.equal(await unavailableCard.locator('.shared-post-warning').count(), 1);
    await page.screenshot({ path: path.join(evidence, 'enriched-media-cards.png') });
    check('Real renderer receives the main revision update and displays ready/unavailable cards without executing supplied markup');

    await api('account.switch', { id: 'import-media-other' });
    assert.equal((await mediaFetch(initial[0].images[0].src)).status, 404);
    const other = (await query()).messages[0].images[0].src;
    assert.notEqual(other, initial[0].images[0].src);
    assert.equal((await mediaFetch(other)).status, 200);
    check('Switching accounts invalidates the previous media token and isolates the next account cache');

    await api('account.switch', { id: fixture.accountId });
    await application.evaluate(() => globalThis.__mediaIntegration.enableSyntheticSession());
    await page.reload();
    await page.waitForSelector('article[data-message-id]');
    await page.locator('#message-scroll').evaluate(scroll => { scroll.scrollTop = 70; });
    await page.waitForTimeout(850);
    const beforeTick = await anchor();
    const readBeforeTick = (await api('state')).readStates[fixture.groupId];
    const enabledAt = Date.now();
    const configured = await api('sync.configure', { enabled: true });
    assert.equal(configured.intervalMs, 60000);
    assert.ok(configured.nextRunAt >= enabledAt + 59000);
    console.log('WAIT actual 60-second automatic sync timer (only local response fixtures)');
    let scheduledStatus;
    for (let attempt = 0; attempt < 8; attempt++) {
      await page.waitForTimeout(10000);
      scheduledStatus = await api('sync.status');
      if (scheduledStatus.lastSuccessAt) break;
      console.log('WAIT automatic sync: ' + Math.floor((Date.now() - enabledAt) / 1000) + ' seconds');
    }
    assert.ok(scheduledStatus.lastSuccessAt >= enabledAt + 59000, 'Real scheduler did not succeed after its 60-second interval');
    // The unread strip is intentionally always visible in 1.1.2. Wait for the
    // renderer's next revision poll, not merely for the already-visible strip.
    await page.waitForFunction(() => document.querySelector('#new-messages-count')?.textContent === '1 条未读', null, { timeout: 10000 });
    await page.waitForTimeout(850);
    const afterTick = await anchor();
    assert.equal(afterTick.id, beforeTick.id);
    assert.ok(Math.abs(afterTick.offset - beforeTick.offset) <= 2);
    const tickState = await api('state');
    assert.equal(tickState.groups[0].unreadCount, 1);
    assert.equal(tickState.readStates[fixture.groupId].readThroughId, readBeforeTick.readThroughId, 'Background arrival must not advance read progress');
    assert.equal(await page.locator('#jump-latest').innerText(), '加载到最新');
    assert.equal(await page.locator('#new-messages-count').innerText(), '1 条未读');
    assert.equal(tickState.stats.messages, 7);
    assert.equal((await query()).messages.at(-1).id, '9007199254740993007');
    await api('sync.configure', { enabled: false });
    await page.screenshot({ path: path.join(evidence, 'actual-auto-sync-tick.png') });
    check('Real 60-second automatic tick persists one new message, keeps it unread without advancing progress and preserves the reading anchor within 2 pixels');

    assert.deepEqual(errors, []);
    const info = await application.evaluate(() => globalThis.__mediaIntegration);
    assert.deepEqual(info.blocked, []);
    const hashesMatch = Object.entries(sourceHashes).every(([file, hash]) => hash === crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'app', file))).digest('hex'));
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ passed: true, checks, errors,
      expectedMediaErrors, blockedRequests: info.blocked, imageCalls: info.imageCalls, apiCalls: info.apiCalls,
      automaticTick: { enabledAt, lastSuccessAt: scheduledStatus.lastSuccessAt, before: beforeTick, after: afterTick },
      sourceHashes, sourceStillMatches: hashesMatch, sourceVersion, harness, dataDir, generatedAt: new Date().toISOString(),
      scope: 'Actual copied source main/preload/core/renderer; synthetic accounts; native transport mock installed before main; no real network or credentials' }, null, 2));
  } catch (error) {
    console.error('Integration failed:', String(error));
    if (application) await application.evaluate(() => globalThis.__mediaIntegration).then(info => {
      fs.writeFileSync(path.join(evidence, 'debug-transports.json'), JSON.stringify(info, null, 2));
    }).catch(() => {});
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ passed: false, checks, errors, expectedMediaErrors,
      sourceHashes, sourceVersion, harness, dataDir, failure: String(error), generatedAt: new Date().toISOString() }, null, 2));
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(evidence, 'failure.png'), timeout: 5000 }).catch(() => {});
    throw error;
  } finally {
    let closeError = null;
    if (application) { try { await application.close(); } catch (error) { closeError = String(error); } }
    if (nativeRun && nativeChild) {
      nativeRun.exitCode = nativeChild.exitCode;
      nativeRun.signal = nativeChild.signalCode;
    }
    const report = JSON.parse(fs.readFileSync(path.join(evidence, 'result.json'), 'utf8'));
    report.nativeRun = nativeRun || null;
    report.nativeExitedCleanly = !!nativeRun && nativeRun.exitCode === 0 && nativeRun.signal === null;
    report.closeError = closeError;
    report.passed = report.passed && report.nativeExitedCleanly && !closeError;
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: report.passed, checks: checks.length, sourceVersion,
      sourceStillMatches: report.sourceStillMatches, nativeRun, report: path.join(evidence, 'result.json') }));
    if (!report.passed) process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
