'use strict';

// Real main/preload/renderer, synthetic account, no real network or profile.
// Baseline and candidate run sequentially with the same fixture and native sizes.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { assertWindowsRuntimeReadable } = require('./windows-runtime-check.cjs');

const root = path.resolve(__dirname, '..');
const baselineRoot = path.join(root, 'dist-1.1.5', 'WeiYue-Windows-x64', 'resources', 'app');
const sourceVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const evidence = fs.mkdtempSync(path.join(root, 'artifacts', 'layout-smoke-' + sourceVersion + '-'));
const harness = fs.mkdtempSync(path.join(os.tmpdir(), 'weiyue-layout-'));
const runtime = path.join(harness, 'runtime');
fs.cpSync(path.join(root, 'vendor', 'runtime'), runtime, { recursive: true });
const executablePath = path.join(runtime, 'electron.exe');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const hashApp = folder => Object.fromEntries(fs.readdirSync(path.join(folder, 'app'), { recursive: true })
  .filter(file => fs.statSync(path.join(folder, 'app', file)).isFile())
  .map(file => [file, hash(path.join(folder, 'app', file))]));
const sourceHashes = hashApp(root), baselineHashes = hashApp(baselineRoot);
const mainSource = fs.readFileSync(path.join(root, 'app', 'main.cjs'), 'utf8');
const minimum = { width: Number(mainSource.match(/minWidth\s*:\s*(\d+)/)?.[1]),
  height: Number(mainSource.match(/minHeight\s*:\s*(\d+)/)?.[1]) };
assert.ok(minimum.width && minimum.height, 'Application minimum size must be explicit');
const sizes = [{ key: 'normal', width: 1360, height: 900 }, { key: 'compact', width: 1100, height: 760 },
  { key: 'minimum', ...minimum }];
const fixture = { accountId: 'weibo-9007199254740993999', groups: [
  { key: 'A', id: '9007199254740996101', name: '布局验收：连续阅读', count: 100, anchor: 20 },
  { key: 'L', id: '9007199254740996102', name: '布局验收：长文本末条', count: 3, anchor: 1 },
  { key: 'I', id: '9007199254740996103', name: '布局验收：图片末条', count: 3, anchor: 1 },
  { key: 'Z', id: '9007199254740996104', name: '布局验收：零未读', count: 3, anchor: 1, zero: true },
] };
for (const [g, group] of fixture.groups.entries()) {
  group.ids = Array.from({ length: group.count }, (_, i) => String(9007199254741200000n + BigInt(g * 1000 + i)));
  group.anchorId = group.ids[group.anchor];
}

function boot(fixtures) {
  const { app, net, session, ipcMain } = require('electron');
  const { EventEmitter } = require('node:events');
  const { Readable } = require('node:stream');
  const info = globalThis.__layoutEvidence = { readCalls: [], blocked: [], images: [] };
  const originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, handler) => originalHandle(channel, (event, action, payload) => {
    if (channel === 'weiyue:call' && action === 'read.set') info.readCalls.push({ at: Date.now(), payload });
    return handler(event, action, payload);
  });
  // Procedural PNG, generated entirely in memory; no remote image is fetched.
  const crc32 = bytes => { let crc = -1; for (const byte of bytes) { crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ -1) >>> 0; };
  const chunk = (name, body) => { const label = Buffer.from(name), size = Buffer.alloc(4), crc = Buffer.alloc(4);
    size.writeUInt32BE(body.length); crc.writeUInt32BE(crc32(Buffer.concat([label, body]))); return Buffer.concat([size, label, body, crc]); };
  const width = 240, height = 420, header = Buffer.alloc(13), rows = Buffer.alloc(height * (1 + width * 4));
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * (1 + width * 4) + 1 + x * 4; rows[i] = 60 + y % 150; rows[i + 1] = 90 + x % 120; rows[i + 2] = 120; rows[i + 3] = 255;
  }
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', require('node:zlib').deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
  const originalRequest = net.request.bind(net);
  net.request = options => {
    const target = typeof options === 'string' ? options : options.url;
    if (/^(app|file):/i.test(target)) return originalRequest(options);
    const request = new EventEmitter(); let aborted = false;
    request.setHeader = () => {}; request.abort = () => { aborted = true; request.emit('abort'); };
    request.end = () => setImmediate(() => {
      if (aborted) return;
      if (String(target) !== 'https://wx1.sinaimg.cn/layout-fixture.png') {
        info.blocked.push('Unexpected image URL'); request.emit('error', Error('Unexpected image URL blocked')); return;
      }
      info.images.push('layout-fixture.png');
      const response = Readable.from([png]); response.statusCode = 200;
      response.headers = { 'content-type': ['image/png'], 'content-length': [String(png.length)] };
      request.emit('response', response);
    });
    return request;
  };
  const originalFetch = net.fetch.bind(net);
  net.fetch = (target, options) => {
    if (/^https?:/i.test(String(target))) { info.blocked.push('External net.fetch'); return Promise.reject(Error('External network blocked')); }
    return originalFetch(target, options);
  };
  const attached = new WeakSet();
  function attach(current) {
    if (attached.has(current)) return; attached.add(current);
    current.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => {
      info.blocked.push('External web request'); callback({ cancel: true });
    });
    const original = current.fetch.bind(current);
    current.fetch = (target, options) => {
      if (/^(app|file):/i.test(String(target))) return original(target, options);
      info.blocked.push('External session.fetch'); return Promise.reject(Error('External network blocked'));
    };
  }
  app.on('session-created', attach); app.whenReady().then(() => attach(session.defaultSession));
  require('./app/main.cjs');
}

function prepare(label, source) {
  const folder = path.join(harness, label), dataDir = path.join(folder, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.cpSync(path.join(source, 'app'), path.join(folder, 'app'), { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ ...pkg, main: 'boot.cjs' }));
  fs.writeFileSync(path.join(folder, 'boot.cjs'), '(' + boot.toString() + ')(' + JSON.stringify(fixture) + ');\n');
  const { Store } = require(path.join(folder, 'app', 'core', 'store.cjs'));
  const store = new Store(path.join(dataDir, 'accounts'));
  store.ensureAccount({ id: fixture.accountId, kind: 'weibo', name: '纯虚构布局测试账号' });
  const messages = fixture.groups.flatMap(group => group.ids.map((id, index) => ({ id, groupId: group.id,
    senderId: '71', senderName: '模拟成员', time: 1700000000000 + index * 60000, mediaVersion: 1,
    text: group.key === 'L' && index === group.count - 1
      ? Array.from({ length: 60 }, (_, line) => `长文本第 ${line + 1} 行；仅用于几何验收，无真实群聊。`).join('\n')
      : `${group.key} 第 ${index} 条虚构消息。\n用于检查锚点、底栏及完整阅读边界。`,
    ...(group.key === 'I' && index === group.count - 1 ? { images: [{ url: 'https://wx1.sinaimg.cn/layout-fixture.png', width: 240, height: 420 }] } : {}),
  })));
  store.mergeMessages(fixture.accountId, fixture.groups.map(g => ({ id: g.id, name: g.name, selected: true })), messages, { history: true });
  store.update(fixture.accountId, state => {
    state.settings.autoSyncEnabled = false;
    for (const [i, group] of fixture.groups.entries()) {
      state.readPositions[group.id] = group.anchorId;
      state.readStates[group.id] = { anchorId: group.anchorId, anchorOffset: -30, atBottom: true,
        readThroughId: group.zero ? group.ids.at(-1) : group.ids[group.anchor - 1],
        unreadIds: group.zero ? [] : group.ids.slice(group.anchor), updatedAt: 5000 - i * 1000 };
    }
  });
  fs.writeFileSync(path.join(dataDir, 'preferences.json'), JSON.stringify({ activeId: fixture.accountId }));
  return { folder, dataDir, version: pkg.version };
}

let application, page, currentLaunch;
const checks = [], errors = [], geometry = [], launches = [], networkRuns = [], baseline = {}, comparisons = [], nativeSizes = [];
const check = value => { checks.push(value); console.log('PASS ' + value); };
const group = key => fixture.groups.find(value => value.key === key);
const api = (action, payload = {}) => page.evaluate(({ action, payload }) => window.api.call(action, payload), { action, payload });
const settle = () => page.waitForTimeout(850);
async function launch(label, configuration) {
  const preflight = assertWindowsRuntimeReadable(executablePath), env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({ executablePath, args: [configuration.folder, '--data-dir=' + configuration.dataDir],
    cwd: configuration.folder, env, timeout: 30000 });
  const native = application.process(); currentLaunch = { label, pid: native.pid, preflight, startedAt: new Date().toISOString() };
  const record = currentLaunch; launches.push(record);
  native.once('exit', (exitCode, signal) => Object.assign(record, { exitCode, signal, exitedAt: new Date().toISOString() }));
  page = await application.firstWindow();
  // Suppress raw renderer diagnostics: all recorded errors are fixed labels.
  page.on('pageerror', () => errors.push(label + ': renderer exception'));
  page.on('console', message => { if (message.type() === 'error') errors.push(label + ': renderer console error'); });
  await page.waitForSelector('article[data-message-id]');
  assert.equal(await application.evaluate(({ app }) => app.getVersion()), configuration.version);
  const state = await api('state'); assert.equal(state.account.id, fixture.accountId); assert.equal(path.resolve(state.dataRoot), configuration.dataDir);
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus(); window.webContents.focus();
  });
  await page.waitForFunction(() => document.hasFocus()); await settle();
}
async function close() {
  if (!application) return;
  networkRuns.push(await application.evaluate(() => globalThis.__layoutEvidence));
  await application.close(); currentLaunch.closeAwaited = true; currentLaunch.closedAt = new Date().toISOString(); application = null;
}
async function resize(size) {
  const bounds = await application.evaluate(({ BrowserWindow }, value) => {
    const window = BrowserWindow.getAllWindows()[0]; window.setSize(value.width, value.height);
    return { outer: window.getBounds(), content: window.getContentBounds(), minimum: window.getMinimumSize(), title: window.getTitle() };
  }, size);
  nativeSizes.push({ label: currentLaunch.label, requested: size, ...bounds });
  // Windows frame rounding at fractional DPI can add one device-independent pixel.
  assert.ok(Math.abs(bounds.outer.width - size.width) <= 2 && Math.abs(bounds.outer.height - size.height) <= 2, 'Native size differs beyond DPI rounding');
  assert.ok(bounds.outer.height > bounds.content.height, 'Native frame/titlebar must remain');
  await settle(); return bounds;
}
async function sample(stage) {
  const value = await page.evaluate(async () => {
    const rect = element => { const r = element?.getBoundingClientRect(); return r ? { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height } : null; };
    const scroll = document.getElementById('message-scroll'), bounds = rect(scroll);
    const articles = [...scroll.querySelectorAll('article[data-message-id]')], first = articles.find(item => item.getBoundingClientRect().bottom > bounds.top + 1);
    const state = await window.api.call('state'), id = document.querySelector('#group-list .active').dataset.groupId;
    const read = state.readStates[id], notice = document.getElementById('new-messages-notice'), selection = document.getElementById('selection-bar');
    const brand = document.querySelector('.brand'), name = document.querySelector('.brand-name'), brandStyle = getComputedStyle(brand);
    const hit = document.elementFromPoint(bounds.right - 2, bounds.bottom - 3);
    return { id, unread: read.unreadCount, readThroughId: read.readThroughId, anchorId: read.anchorId,
      firstId: first?.dataset.messageId, firstOffset: first ? first.getBoundingClientRect().top - bounds.top : null,
      rightUnread: document.getElementById('new-messages-count')?.textContent,
      leftUnread: document.querySelector('#group-list .active .unread-badge')?.getAttribute('aria-label'),
      notice: rect(notice), noticeHidden: notice.hidden, noticeDisplay: getComputedStyle(notice).display,
      selection: rect(selection), selectionHidden: selection.hidden, viewport: bounds,
      footer: rect(document.querySelector('.reading-footer')), pagination: rect(document.querySelector('.pagination')),
      header: rect(document.getElementById('workspace-header')), filter: rect(document.querySelector('.filter-area')),
      first: rect(first), last: rect(articles.at(-1)), lastId: articles.at(-1)?.dataset.messageId,
      scrollTop: scroll.scrollTop, scrollHeight: scroll.scrollHeight, clientHeight: scroll.clientHeight,
      clientWidth: scroll.clientWidth, offsetWidth: scroll.offsetWidth, scrollWidth: scroll.scrollWidth,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      scrollbarExposed: hit === scroll || scroll.contains(hit), title: document.title,
      brandText: brand.textContent, brandMarkCount: document.querySelectorAll('.brand-mark').length,
      brandContentInset: name.getBoundingClientRect().left - brand.getBoundingClientRect().left - Number.parseFloat(brandStyle.paddingLeft),
      inspectorText: document.getElementById('inspector').innerText,
      images: [...scroll.querySelectorAll('img')].map(image => ({ complete: image.complete, naturalWidth: image.naturalWidth, rect: rect(image) })),
    };
  });
  value.commits = await application.evaluate(() => globalThis.__layoutEvidence.readCalls.filter(call => call.payload?.readThroughId).length);
  geometry.push({ stage, ...value }); return value;
}
function countsAgree(value, expected = value.unread) {
  assert.equal(value.unread, expected, 'Persisted unread count changed unexpectedly');
  assert.equal(Number.parseInt(value.rightUnread, 10), expected, 'Right unread label disagrees with persisted state');
  assert.equal(Number.parseInt(value.leftUnread, 10), expected, 'Sidebar unread label disagrees with persisted state');
}
function unchanged(before, after) {
  assert.equal(after.id, before.id); countsAgree(after, before.unread);
  assert.equal(after.readThroughId, before.readThroughId, 'Layout must not advance read boundary');
  assert.equal(after.commits, before.commits, 'Layout must not send read.set with readThroughId');
}
function anchorStable(before, after) {
  assert.equal(after.firstId, before.firstId, 'Passive layout changed the visible anchor message');
  assert.ok(Math.abs(after.firstOffset - before.firstOffset) <= 2, 'Passive layout moved the visible anchor offset');
}
function unobscured(value) {
  assert.equal(value.horizontalOverflow, false, 'Window has horizontal page overflow');
  assert.ok(value.viewport.height > 100, 'Message viewport lost usable height');
  assert.ok(value.scrollWidth <= value.clientWidth + 1, 'Messages overflow horizontally');
  for (const [name, rect] of [['notice', value.noticeHidden ? null : value.notice],
    ['selection', value.selectionHidden ? null : value.selection], ['pagination', value.pagination]]) {
    if (rect?.height) assert.ok(rect.top >= value.viewport.bottom - 1, name + ' overlaps the message viewport');
  }
  assert.ok(value.scrollbarExposed, 'Message scrollbar region is covered by another panel');
}
async function switchGroup(key) {
  await page.locator('[data-group-id="' + group(key).id + '"]').click();
  await page.waitForSelector('[data-group-id="' + group(key).id + '"].active'); await settle();
  const value = await sample('switch-' + key);
  assert.ok(Math.abs(value.firstOffset) <= 2, 'Group restore must place saved anchor at top');
  countsAgree(value); return value;
}
async function alignLast() {
  // Deliberately untrusted JS movement is a negative reading control.
  await page.locator('#message-scroll').evaluate(scroll => {
    const last = scroll.querySelector('article[data-message-id]:last-of-type');
    scroll.scrollTop += last.getBoundingClientRect().bottom - scroll.getBoundingClientRect().bottom;
  });
  await settle();
}

(async () => {
  let failure;
  try {
    const old = prepare('baseline', baselineRoot); assert.equal(old.version, '1.1.5');
    await launch('baseline-1.1.5', old);
    for (const size of sizes) { await resize(size); baseline[size.key] = await sample('baseline-' + size.key); }
    await close(); check('Read-only 1.1.5 baseline measured at all three native window sizes with identical fixtures');
    const current = prepare('candidate', root); await launch('candidate', current);
    assert.ok(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => {
      const p = window.webContents.getLastWebPreferences(); return p.sandbox && p.contextIsolation && !p.nodeIntegration;
    })), 'Sandbox isolation must remain enabled');
    const initial = await sample('initial'); countsAgree(initial, 80);
    assert.equal(initial.firstId, group('A').anchorId); assert.ok(Math.abs(initial.firstOffset) <= 2);
    assert.ok(initial.last.bottom > initial.viewport.bottom + 50, 'Initial anchor must not jump to tail');
    check('Synthetic profile and sandbox are isolated; startup anchor restores at top without jumping to tail');

    for (const size of sizes) {
      const before = await sample(size.key + '-before-resize'), native = await resize(size), value = await sample(size.key + '-initial');
      unchanged(before, value); anchorStable(before, value); unobscured(value);
      const oldNative = nativeSizes.find(item => item.label === 'baseline-1.1.5' && item.requested.key === size.key);
      assert.equal(native.outer.width, oldNative.outer.width); assert.equal(native.outer.height, oldNative.outer.height);
      assert.equal(native.content.width, oldNative.content.width); assert.equal(native.content.height, oldNative.content.height);
      assert.ok(!/Windows/i.test(value.title + native.title + value.brandText), 'Title/brand contains Windows');
      assert.equal(value.brandMarkCount, 0, 'Removed brand mark still exists');
      assert.ok(Math.abs(value.brandContentInset) <= 2, 'Removed brand mark left a placeholder gap');
      assert.ok(value.brandText.includes('微阅')); assert.ok(!value.inspectorText.includes('阅读工作台'));
      const gain = value.viewport.height - baseline[size.key].viewport.height;
      assert.ok(gain >= 24, 'Message viewport should gain at least 24px over 1.1.5: ' + size.key);
      comparisons.push({ size, beforeHeight: baseline[size.key].viewport.height, afterHeight: value.viewport.height, gain });
      await page.screenshot({ path: path.join(evidence, size.key + '.png') });
      check(size.key + ': native frame retained, simplified branding, larger message viewport, no overlap/overflow or passive read');

      const beforeFilters = await sample(size.key + '-before-filter');
      await page.locator('#filter-toggle').click(); await settle();
      const expanded = await sample(size.key + '-filter-expanded'); unchanged(beforeFilters, expanded); anchorStable(beforeFilters, expanded); unobscured(expanded);
      assert.ok(expanded.filter.height > beforeFilters.filter.height, 'Filter toggle did not expand actual layout');
      await page.screenshot({ path: path.join(evidence, size.key + '-filters.png') });
      await page.locator('#filter-toggle').click(); await settle(); const collapsed = await sample(size.key + '-filter-closed'); unchanged(beforeFilters, collapsed); anchorStable(beforeFilters, collapsed);

      // Direct visibility mutation isolates passive layout changes from a real read action.
      const beforeToggle = await sample(size.key + '-before-notice-layout');
      await page.locator('#new-messages-notice').evaluate(notice => { notice.hidden = true; }); await settle();
      const hiddenNotice = await sample(size.key + '-notice-layout-hidden'); unchanged(beforeToggle, hiddenNotice); anchorStable(beforeToggle, hiddenNotice);
      assert.ok(Math.abs(hiddenNotice.footer.height - beforeToggle.footer.height) <= 1, 'Hiding unread changes footer row height');
      await page.locator('#new-messages-notice').evaluate(notice => { notice.hidden = false; }); await settle();
      const shownNotice = await sample(size.key + '-notice-layout-shown'); unchanged(beforeToggle, shownNotice); anchorStable(beforeToggle, shownNotice);
      // Synthetic label stress only: no store/unread algorithm is modified.
      const oldLabel = await page.locator('#new-messages-count').innerText();
      await page.locator('#new-messages-count').evaluate(label => { label.textContent = '999999 条未读'; }); await settle();
      const largeLabel = await sample(size.key + '-large-label');
      assert.equal(largeLabel.unread, beforeToggle.unread); assert.equal(largeLabel.commits, beforeToggle.commits); anchorStable(beforeToggle, largeLabel);
      assert.ok(Math.abs(largeLabel.footer.height - beforeToggle.footer.height) <= 1, 'Large unread label wraps footer into a second row');
      assert.ok(Math.min(largeLabel.notice.bottom, largeLabel.pagination.bottom) > Math.max(largeLabel.notice.top, largeLabel.pagination.top), 'Pagination and unread controls are not on the same row');
      await page.locator('#new-messages-count').evaluate((label, text) => { label.textContent = text; }, oldLabel); await settle();
      unchanged(beforeToggle, await sample(size.key + '-large-label-restored'));
      check(size.key + ': filter expansion and notice hide/show cannot commit read or reduce either unread counter');

      const visible = page.locator('article[data-message-id="' + beforeToggle.firstId + '"] input[type=checkbox]');
      await visible.check(); await settle();
      const selected = await sample(size.key + '-selection-visible'); unchanged(beforeToggle, selected); unobscured(selected);
      assert.equal(selected.selectionHidden, false); await page.screenshot({ path: path.join(evidence, size.key + '-selection.png') });
      await page.locator('#selection-bar button').last().click(); await settle(); unchanged(beforeToggle, await sample(size.key + '-selection-hidden'));

      for (const key of ['L', 'I']) {
        const start = await switchGroup(key);
        if (key === 'I') {
          await page.locator('article[data-message-id="' + group(key).ids.at(-1) + '"]').scrollIntoViewIfNeeded();
          await page.waitForFunction(() => [...document.querySelectorAll('#message-scroll img')].every(image => image.complete && image.naturalWidth > 0));
        }
        await alignLast();
        const end = await sample(size.key + '-' + key + '-last'); unchanged(start, end); unobscured(end);
        assert.ok(Math.abs(end.last.bottom - end.viewport.bottom) <= 2, 'Last message bottom is not fully reachable above footer');
        if (key === 'L') assert.ok(end.last.height > end.viewport.height, 'Long text fixture must exceed the viewport');
        else assert.ok(end.images.some(image => image.complete && image.naturalWidth === 240), 'Synthetic image was not decoded');
        await page.locator('article[data-message-id="' + group(key).ids.at(-1) + '"] input[type=checkbox]').check(); await settle();
        await alignLast(); const selectedEnd = await sample(size.key + '-' + key + '-last-selected'); unchanged(start, selectedEnd); unobscured(selectedEnd);
        assert.ok(Math.abs(selectedEnd.last.bottom - selectedEnd.viewport.bottom) <= 2, 'Selection bar covers last message bottom');
        await page.screenshot({ path: path.join(evidence, size.key + '-' + key + '-last-selected.png') });
        await page.locator('#selection-bar button').last().click(); await settle();
      }
      check(size.key + ': long text, decoded image and last-message end remain reachable with unread/selection bars; passive scroll never reads');
      const zero = await switchGroup('Z'); assert.equal(zero.unread, 0); assert.equal(zero.noticeHidden, false);
      assert.ok(await page.locator('#jump-latest').isVisible(), 'Zero unread must retain explicit latest navigation'); unobscured(zero);
      assert.ok(Math.abs(zero.footer.height - value.footer.height) <= 1, 'Zero and nonzero unread must use one stable footer row');
      assert.ok(Math.min(zero.notice.bottom, zero.pagination.bottom) > Math.max(zero.notice.top, zero.pagination.top), 'Zero-unread navigation adds a second row');
      await page.screenshot({ path: path.join(evidence, size.key + '-zero-unread.png') });
      check(size.key + ': genuine zero-unread group retains latest navigation in the same stable footer row with no extra height');
      await switchGroup('A');
    }

    await resize(sizes[0]); const beforeWheel = await switchGroup('A');
    await page.evaluate(() => { globalThis.__layoutWheels = [];
      document.getElementById('message-scroll').addEventListener('wheel', event => globalThis.__layoutWheels.push({ trusted: event.isTrusted, deltaY: event.deltaY }), { passive: true }); });
    const bounds = beforeWheel.viewport;
    await application.evaluate(({ BrowserWindow }, position) => {
      const window = BrowserWindow.getAllWindows()[0]; window.focus(); window.webContents.focus();
      window.webContents.sendInputEvent({ type: 'mouseMove', x: position.x, y: position.y });
      window.webContents.sendInputEvent({ type: 'mouseWheel', x: position.x, y: position.y, deltaX: 0, deltaY: -240, canScroll: true });
    }, { x: Math.round(bounds.left + bounds.width / 2), y: Math.round(bounds.top + bounds.height / 2) });
    await page.waitForFunction(async prior => {
      const state = await window.api.call('state'), id = document.querySelector('#group-list .active').dataset.groupId;
      return state.readStates[id].unreadCount < prior;
    }, beforeWheel.unread, { timeout: 8000 });
    await settle(); const afterWheel = await sample('native-wheel'); countsAgree(afterWheel);
    assert.ok(afterWheel.unread > 0 && afterWheel.commits > beforeWheel.commits && afterWheel.scrollTop > beforeWheel.scrollTop);
    assert.ok((await page.evaluate(() => globalThis.__layoutWheels)).some(event => event.trusted && event.deltaY > 0));
    await page.screenshot({ path: path.join(evidence, 'native-wheel.png') });
    check('Actual trusted native wheel advances visible reading and decreases both unread counters; no passive operation could do so');
    assert.deepEqual(errors, []);
  } catch (error) {
    // Assertion messages contain only fixture geometry or fixed diagnostics.
    failure = error instanceof assert.AssertionError ? error.message : 'Layout harness operation failed: ' + (error.code || error.name || 'Error');
    console.error(failure);
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
  } finally {
    await close().catch(() => { failure ||= 'Native close failed'; });
    const sourceStillMatches = JSON.stringify(sourceHashes) === JSON.stringify(hashApp(root));
    const baselineStillMatches = JSON.stringify(baselineHashes) === JSON.stringify(hashApp(baselineRoot));
    const nativeExitedCleanly = launches.length === 2 && launches.every(run => run.exitCode === 0 && run.signal === null && run.closeAwaited);
    const blocked = networkRuns.flatMap(run => run.blocked), passed = !failure && !errors.length && !blocked.length && sourceStillMatches && baselineStillMatches && nativeExitedCleanly;
    const report = { passed, version: sourceVersion, sourceVersion, checks, errors, failure, comparisons, geometry, nativeSizes, launches, networkRuns, blocked,
      sourceHashes, baselineHashes, sourceStillMatches, baselineStillMatches, nativeExitedCleanly, executablePath, harness, evidence,
      generatedAt: new Date().toISOString(), scope: 'Sequential real 1.1.5/candidate Electron, identical synthetic data; all external transports blocked or image-mocked; native wheel positive control' };
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed, sourceVersion, checks: checks.length, evidence, nativeExitedCleanly, comparisons }));
    if (!passed) process.exitCode = 1;
  }
})().catch(() => { console.error('Layout harness initialization failed; no real data accessed'); process.exitCode = 1; });
