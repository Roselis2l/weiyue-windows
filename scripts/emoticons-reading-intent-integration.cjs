'use strict';

// Source-only acceptance: a complete app copy plus a test entry point, fresh
// synthetic import data, held local emoticon responses, and native wheel input.
// No production file, existing profile, installed EXE, AI or Notion is used.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { assertWindowsRuntimeReadable } = require('./windows-runtime-check.cjs');

const root = path.resolve(__dirname, '..');
const expectedVersion = JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
let assetSources = [], displayTokens = [], tokensPerMessage = 0;
const syntheticGif = {
  name: 'QA115动态GIF',src:'app://local/emoticons/qa115-animation.gif',
  base64:'R0lGODlhAQABAIAAAAAAAP///yH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAQABAAACAkQBACH5BAAKAAAALAAAAAABAAEAAAICTAEAOw==',
  sha256:'860a7b85200c12f04d72afff8731930bcb0c376e84732412066d462a3b69a610',
  width:1,height:1,frameCount:2,delayMs:100,official:false
};
const fixture = {
  accountId: 'import-emoticon-reading-114',
  groupId: '9007199254743100001',
  count: 80,
  anchorIndex: 10,
  throughIndex: 9,
  ids: Array.from({ length: 80 }, (_, index) => String(9007199254743200000n + BigInt(index))),
};
const evidence = path.resolve(process.env.WEIYUE_EMOTICONS_READING_OUTPUT || path.join(root, 'artifacts',
  'emoticons-reading-intent-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex')));
const result = {
  passed: false, expectedVersion, stage: 'prepare', checks: [], samples: [],
  launches: [], errors: [], httpRequests: [], nativeInputRequests: [],
  scope: 'Copied source app with explicit test-only GIF manifest overlay; synthetic import account; native webContents mouseWheel; held local assets; no existing profile or external service',
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let harness, dataDir, appRoot, executablePath, Store, application, page;
let sourceBefore, copiedBefore, executableBefore;

function manifest(base) {
  const entries = [];
  function visit(directory, relative = '') {
    for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(directory, item.name), key = path.join(relative, item.name);
      assert.equal(fs.lstatSync(full).isSymbolicLink(), false, 'SOURCE_SYMLINK_NOT_ALLOWED');
      if (item.isDirectory()) visit(full, key);
      else if (item.isFile()) entries.push([key.replace(/\\/g, '/'), hash(full)]);
      else throw Error('SOURCE_ENTRY_NOT_REGULAR');
    }
  }
  visit(base);
  return Object.fromEntries(entries);
}
function sourceManifest() {
  return { packageSha256: hash(path.join(root, 'package.json')), app: manifest(path.join(root, 'app')) };
}
async function until(fn, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await pause(100);
  }
  throw Error(label);
}
function check(description) { result.checks.push(description); console.log('PASS ' + description); }

function boot(options) {
  const { app, net, session, protocol, ipcMain } = require('electron');
  const allowed = new Set(options.assetSources);
  let release;
  const info = globalThis.__emoticonReadingTest = {
    holdAssets: true, blocked: [], calls: [], readCalls: [], assetRequests: [],
    releasedAt: null, releaseReadCallIndex: null,
    held: new Promise(resolve => { release = resolve; }),
    releaseAssets() {
      if (!this.holdAssets) return;
      this.releasedAt = Date.now();
      this.releaseReadCallIndex = this.readCalls.length;
      this.holdAssets = false;
      release();
    },
  };
  const describe = (via, target) => {
    const value = typeof target === 'string' ? target : target?.url || String(target);
    let origin = 'unparsed';
    try { origin = new URL(value).origin; } catch { /* Do not log arbitrary input. */ }
    info.blocked.push({ via, origin });
    return Error('EXTERNAL_NETWORK_BLOCKED_BY_TEST');
  };
  const remote = value => /^https?:/i.test(typeof value === 'string' ? value : value?.url || String(value));
  const originalProtocol = protocol.handle.bind(protocol);
  protocol.handle = (scheme, handler) => originalProtocol(scheme, async request => {
    if (scheme === 'app' && allowed.has(request.url)) {
      const record = { source: request.url, startedAt: Date.now(), held: info.holdAssets };
      info.assetRequests.push(record);
      if (info.holdAssets) await info.held;
      record.releasedAt = Date.now();
      return handler(request);
    }
    return handler(request);
  });
  const originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, handler) => originalHandle(channel, async (event, action, payload = {}) => {
    let read;
    if (channel === 'weiyue:call') {
      info.calls.push(action);
      if (/^(?:summary\.ai|notion\.)/.test(action)) throw Error('EXTERNAL_FEATURE_NOT_ALLOWED_IN_TEST');
      if (action === 'read.set') {
        read = { at: Date.now(), assetsHeld: info.holdAssets, payload: { ...payload } };
        info.readCalls.push(read);
      }
    }
    const returned = await handler(event, action, payload);
    if (read) {
      const value = returned?.ok === true ? returned.value : returned;
      const state = value?.readState || value;
      read.returned = state && typeof state === 'object'
        ? { anchorId: state.anchorId, readThroughId: state.readThroughId, unreadCount: state.unreadCount }
        : null;
      read.finishedAt = Date.now();
    }
    return returned;
  });
  const originalFetch = net.fetch.bind(net), originalRequest = net.request.bind(net);
  net.fetch = (target, options) => remote(target)
    ? Promise.reject(describe('net.fetch', target)) : originalFetch(target, options);
  net.request = options => {
    const target = typeof options === 'string' ? options : options?.url;
    // A URL-less request can be built from protocol/host fields. This test has
    // no legitimate ClientRequest use, so do not let that form escape the guard.
    if (!target || remote(target)) throw describe('net.request', target);
    return originalRequest(options);
  };
  if (typeof globalThis.fetch === 'function') {
    const originalGlobalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (target, options) => remote(target)
      ? Promise.reject(describe('global.fetch', target)) : originalGlobalFetch(target, options);
  }
  const attached = new WeakSet();
  const attach = current => {
    if (attached.has(current)) return;
    attached.add(current);
    current.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      describe('webRequest', details.url); callback({ cancel: true });
    });
    const original = current.fetch.bind(current);
    current.fetch = (target, options) => remote(target)
      ? Promise.reject(describe('session.fetch', target)) : original(target, options);
  };
  app.on('session-created', attach);
  app.whenReady().then(() => attach(session.defaultSession));
  require('./app/main.cjs');
}

function prepare() {
  assert.equal(process.argv.length, 2, 'THIS_TEST_ACCEPTS_NO_INSTALLED_EXE_OR_PROFILE_ARGUMENTS');
  fs.mkdirSync(evidence, { recursive: true });
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(metadata.version, expectedVersion, 'EXPECTED_SOURCE_VERSION_MISMATCH');
  result.version = metadata.version;
  sourceBefore = sourceManifest();
  fs.writeFileSync(path.join(evidence, 'source-before.json'), JSON.stringify(sourceBefore, null, 2));
  harness = fs.mkdtempSync(path.join(os.tmpdir(), 'weiyue-emoticon-reading-'));
  dataDir = path.join(harness, 'data'); fs.mkdirSync(dataDir);
  fs.cpSync(path.join(root, 'app'), path.join(harness, 'app'), { recursive: true });
  fs.cpSync(path.join(root, 'vendor/runtime'), path.join(harness, 'runtime'), { recursive: true });
  appRoot = path.join(harness, 'app'); executablePath = path.join(harness, 'runtime/electron.exe');
  copiedBefore = manifest(appRoot); executableBefore = hash(executablePath);
  assert.deepEqual(copiedBefore, sourceBefore.app, 'SOURCE_COPY_MISMATCH');
  for (const name of ['erha.png', 'xiaoku.png', 'haha.png'])
    assert.ok(fs.statSync(path.join(appRoot, 'renderer/emoticons', name)).isFile(), 'EXPECTED_BUNDLED_ASSET_MISSING');
  const official=require(path.join(appRoot,'renderer/emoticon-manifest.js'));
  const representatives=new Map(['二哈','笑cry','哈哈'].map(name=>[name,official[name]]));
  const categories=new Set();
  for(const [name,descriptor]of Object.entries(official))if(!categories.has(descriptor.group)){
    categories.add(descriptor.group);representatives.set(name,descriptor);
  }
  for(const [name,descriptor]of representatives)assert.ok(descriptor?.src,'MISSING_REPRESENTATIVE_'+name);
  const gifBytes=Buffer.from(syntheticGif.base64,'base64');
  assert.equal(crypto.createHash('sha256').update(gifBytes).digest('hex'),syntheticGif.sha256);
  fs.writeFileSync(path.join(appRoot,'renderer/emoticons/qa115-animation.gif'),gifBytes);
  const gifDescriptor={src:syntheticGif.src,sourceUrl:'synthetic:test-only',sha256:syntheticGif.sha256,
    group:'synthetic-test-only',format:'gif',bytes:gifBytes.length,width:1,height:1,animated:true,frameCount:2};
  const augmented={...official,[syntheticGif.name]:gifDescriptor};
  const augmentedSource="(function(root,factory){const value=factory();if(typeof module==='object'&&module.exports)module.exports=value;else root.WeiyueEmoticonManifest=value;})(typeof globalThis==='object'?globalThis:this,function(){return Object.freeze(Object.fromEntries(Object.entries("+JSON.stringify(augmented)+").map(([name,item])=>[name,Object.freeze(item)])));});\n";
  fs.writeFileSync(path.join(appRoot,'renderer/emoticon-manifest.js'),augmentedSource);
  representatives.set(syntheticGif.name,gifDescriptor);
  displayTokens=[...representatives.keys()].map((name,index)=>index%2?'【'+name+'】':'['+name+']');
  tokensPerMessage=displayTokens.length;
  assetSources=[...new Set([...representatives.values()].map(item=>item.src))];
  copiedBefore=manifest(appRoot);
  result.syntheticGif={...syntheticGif,base64:undefined,bytes:gifBytes.length,testOnly:true,animationObserved:false};
  result.representatives={officialMappingCount:Object.keys(official).length,categories:[...categories],
    tokens:displayTokens,assetSources,sourceOverlay:['renderer/emoticon-manifest.js','renderer/emoticons/qa115-animation.gif']};
  // This source-only overlay supplies a visibly synthetic GIF to the unchanged
  // production renderer/asset server. No official GIF coverage is claimed.
  fs.writeFileSync(path.join(harness, 'package.json'), JSON.stringify({ ...metadata, main: 'boot.cjs' }, null, 2));
  fs.writeFileSync(path.join(harness, 'boot.cjs'), '(' + boot.toString() + ')(' + JSON.stringify({ assetSources }) + ');\n');
  Store = require(path.join(appRoot, 'core/store.cjs')).Store;
  const store = new Store(path.join(dataDir, 'accounts'));
  store.ensureAccount({ id: fixture.accountId, name: '表情阅读意图合成账号', kind: 'import' });
  const messages = fixture.ids.map((id, index) => ({
    id, groupId: fixture.groupId, senderId: '71', senderName: '合成成员',
    time: Date.parse('2026-10-20T00:00:00Z') + index * 60000,
    text: `合成记录 ${index} ${displayTokens.join('')}\n这些内容只用于本地阅读验收。`,
    mediaVersion: 1, attachmentVersion: 1,
  }));
  store.mergeMessages(fixture.accountId, [{ id: fixture.groupId, name: '表情等待中的原未读消息', selected: true }], messages, { history: true });
  store.update(fixture.accountId, state => {
    state.settings.autoSyncEnabled = false;
    state.readPositions[fixture.groupId] = fixture.ids[fixture.anchorIndex];
    state.readStates[fixture.groupId] = {
      anchorId: fixture.ids[fixture.anchorIndex], anchorOffset: 0, atBottom: false,
      readThroughId: fixture.ids[fixture.throughIndex], unreadIds: fixture.ids.slice(fixture.anchorIndex), updatedAt: 3000,
    };
  });
  fs.writeFileSync(path.join(dataDir, 'preferences.json'), JSON.stringify({ activeId: fixture.accountId }));
  Object.assign(result, { executablePath, harness, dataDir, initialUnreadIds: fixture.ids.slice(fixture.anchorIndex),
    isolatedData: { kind: 'import', synthetic: true, autoSyncEnabled: false, existingProfileAccessed: false } });
}

const api = (action, payload = {}) => page.evaluate(({ action, payload }) => window.api.call(action, payload), { action, payload });
async function probe() {
  return application.evaluate(() => {
    const info = globalThis.__emoticonReadingTest;
    return { holdAssets: info.holdAssets, blocked: info.blocked, calls: info.calls, readCalls: info.readCalls,
      assetRequests: info.assetRequests, releasedAt: info.releasedAt, releaseReadCallIndex: info.releaseReadCallIndex };
  });
}
async function launch() {
  const preflight = assertWindowsRuntimeReadable(executablePath), env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({ executablePath, args: [harness, '--data-dir=' + dataDir],
    cwd: harness, env, timeout: 45000 });
  const native = application.process(), record = { pid: native.pid, preflight, startedAt: new Date().toISOString() };
  result.launches.push(record);
  native.once('exit', (exitCode, signal) => Object.assign(record, { exitCode, signal, exitedAt: new Date().toISOString() }));
  native.stderr?.on('data', bytes => fs.appendFileSync(path.join(evidence, 'native.stderr.log'), bytes));
  page = await application.firstWindow();
  page.on('pageerror', error => result.errors.push(error.message));
  page.on('request', request => {
    if (/^https?:/i.test(request.url())) result.httpRequests.push({ origin: new URL(request.url()).origin, type: request.resourceType() });
  });
  record.application = await application.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL() === 'app://local/index.html') || BrowserWindow.getAllWindows()[0];
    window.setSize(1440, 930); window.show(); window.focus(); window.webContents.focus();
    const prefs = window.webContents.getLastWebPreferences();
    return { version: app.getVersion(), appPath: app.getAppPath(), executable: process.execPath,
      sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, webSecurity: prefs.webSecurity, nodeIntegration: prefs.nodeIntegration };
  });
  assert.equal(record.application.version, expectedVersion, 'COPIED_APP_VERSION_MISMATCH');
  assert.equal(path.resolve(record.application.appPath).toLowerCase(), harness.toLowerCase(), 'APP_PATH_NOT_ISOLATED_COPY');
  assert.equal(path.resolve(record.application.executable).toLowerCase(), executablePath.toLowerCase(), 'EXE_PATH_NOT_ISOLATED_COPY');
  assert.ok(record.application.sandbox && record.application.contextIsolation && record.application.webSecurity && !record.application.nodeIntegration, 'APP_SECURITY_PREFERENCES_CHANGED');
  await page.waitForSelector('article[data-message-id]');
  await page.evaluate(() => {
    globalThis.__emoticonReadingEvents = [];
    for (const type of ['wheel', 'scroll']) document.addEventListener(type, event => {
      const scroll = document.getElementById('message-scroll');
      if (event.target !== scroll && !scroll?.contains(event.target)) return;
      globalThis.__emoticonReadingEvents.push({ type, at: performance.now(), trusted: event.isTrusted,
        scrollTop: scroll.scrollTop, deltaY: event.deltaY ?? null, targetIsScroll: event.target === scroll });
    }, { capture: true, passive: true });
  });
  await page.waitForFunction(() => document.hasFocus() && document.visibilityState === 'visible');
  const state = await api('state');
  assert.equal(state.account.id, fixture.accountId); assert.equal(state.account.kind, 'import');
  assert.equal(path.resolve(state.dataRoot), dataDir); assert.equal(state.sessionReady, false);
  assert.equal(state.credentials.ai, false); assert.equal(state.credentials.notion, false);
  assert.equal((await api('sync.status')).enabled, false);
}
async function sample() {
  const value = await page.evaluate(async () => {
    const state = await window.api.call('state');
    const groupId = document.querySelector('#group-list .active')?.dataset.groupId;
    const read = state.readStates[groupId], scroll = document.getElementById('message-scroll'), viewport = scroll.getBoundingClientRect();
    const rect = element => {
      const b = element.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height, top: b.top, right: b.right, bottom: b.bottom };
    };
    const messages = [...scroll.querySelectorAll('article[data-message-id]')].map(element => ({
      id: element.dataset.messageId, box: rect(element),
      tokens: [...element.querySelectorAll('.inline-emoticon')].map(token => {
        const image = token.querySelector('img.emoticon-image'), fallback = token.querySelector('.emoticon-fallback');
        return { token: token.dataset.originalToken, state: token.dataset.emoticonState, box: rect(token),
          image: image ? { source: image.getAttribute('src'), complete: image.complete, naturalWidth: image.naturalWidth,
            naturalHeight: image.naturalHeight, hidden: image.hidden } : null,
          fallbackHidden: fallback?.hidden };
      }),
    }));
    const first = messages.find(message => message.box.bottom > viewport.top + 1);
    const badge = document.querySelector('#group-list .active .unread-badge');
    return { groupId, anchorId: read.anchorId, readThroughId: read.readThroughId, unread: read.unreadCount,
      firstId: first?.id, firstOffset: first ? first.box.top - viewport.top : null,
      viewport: rect(scroll), scrollTop: scroll.scrollTop, clientHeight: scroll.clientHeight, scrollHeight: scroll.scrollHeight,
      focus: document.hasFocus(), visibility: document.visibilityState, messages,
      events: [...globalThis.__emoticonReadingEvents],
      labels: { left: badge?.getAttribute('aria-label'), hidden: badge?.hidden, right: document.getElementById('new-messages-count').textContent.trim() } };
  });
  const stored = new Store(path.join(dataDir, 'accounts')).getReadStats(fixture.accountId, fixture.groupId);
  assert.equal(value.groupId, fixture.groupId);
  assert.equal(value.unread, stored.unreadCount, 'UI_STORE_UNREAD_MISMATCH');
  assert.equal(value.readThroughId, stored.readThroughId, 'UI_STORE_HIGH_WATER_MISMATCH');
  assert.equal(value.labels.left, value.unread + ' 条未读');
  assert.equal(value.labels.right, value.unread + ' 条未读');
  assert.equal(value.labels.hidden, value.unread === 0);
  value.persisted = stored;
  return value;
}
function assertPending(value) {
  assert.equal(value.messages.length, fixture.count, 'EXPECTED_SMALL_GROUP_NOT_FULLY_LOADED');
  for (const message of value.messages) {
    assert.equal(message.tokens.length, tokensPerMessage, 'MESSAGE_MISSING_EMOTICON_TOKENS');
    for (const token of message.tokens) {
      assert.ok(assetSources.includes(token.image?.source), 'EMOTICON_SOURCE_NOT_EXACT_LOCAL_ASSET');
      assert.equal(token.state, 'loading', 'EMOTICON_NOT_PENDING');
      assert.equal(token.image.complete, false, 'PENDING_IMAGE_COMPLETED');
      assert.equal(token.image.naturalWidth, 0, 'PENDING_IMAGE_HAS_PIXELS');
      assert.equal(token.image.hidden, true);
      assert.equal(token.fallbackHidden, false);
    }
  }
}
function sameReading(before, after) {
  assert.equal(after.readThroughId, before.readThroughId, 'PASSIVE_HIGH_WATER_CHANGED');
  assert.equal(after.unread, before.unread, 'PASSIVE_UNREAD_CHANGED');
  assert.equal(after.firstId, before.firstId, 'PASSIVE_FIRST_VISIBLE_CHANGED');
  assert.ok(Math.abs(after.firstOffset - before.firstOffset) <= 2, 'PASSIVE_VIEWPORT_OFFSET_CHANGED');
  assert.ok(Math.abs(after.scrollTop - before.scrollTop) <= 2, 'PASSIVE_SCROLL_POSITION_CHANGED');
}
async function close() {
  if (!application) return;
  await application.evaluate(() => globalThis.__emoticonReadingTest?.releaseAssets()).catch(() => {});
  result.finalProbe = await probe().catch(() => result.finalProbe);
  result.finalInputEvents = await page.evaluate(() => globalThis.__emoticonReadingEvents || []).catch(() => []);
  await application.close(); application = null;
  await until(() => result.launches.at(-1).exitCode !== undefined, 'NATIVE_PROCESS_DID_NOT_EXIT', 10000);
}

(async () => {
  try {
    prepare(); result.stage = 'launch'; await launch();
    await pause(1100);
    const initial = await sample(); assertPending(initial);
    assert.equal(initial.firstId, fixture.ids[fixture.anchorIndex]);
    assert.ok(Math.abs(initial.firstOffset) <= 2, 'INITIAL_ANCHOR_OFFSET');
    assert.equal(initial.readThroughId, fixture.ids[fixture.throughIndex]);
    assert.equal(initial.unread, fixture.count - fixture.anchorIndex);
    const held = await probe();
    assert.equal(held.holdAssets, true);
    assert.deepEqual([...new Set(held.assetRequests.map(request => request.source))].sort(), [...assetSources].sort(), 'NOT_ALL_LOCAL_ASSETS_WERE_HELD');
    assert.ok(held.assetRequests.every(request => request.held && !request.releasedAt), 'ASSET_ESCAPED_HOLD');
    assert.ok(held.readCalls.every(call => !Object.hasOwn(call.payload, 'readThroughId')), 'PASSIVE_INITIAL_RENDER_GRANTED_READ');
    result.samples.push({ stage: 'initial-all-pending', value: initial, probe: held });
    check(`The sandboxed ${expectedVersion} source copy opens ${fixture.count-fixture.anchorIndex} unread synthetic messages while ${assetSources.length} multi-category local assets, including a test-only GIF, remain pending`);

    result.stage = 'native-wheel-with-pending-emoticons';
    const x = Math.floor(initial.viewport.x + initial.viewport.width / 2);
    const y = Math.floor(initial.viewport.y + initial.viewport.height / 2);
    const nativeEvents = [{ type: 'mouseMove', x, y }, { type: 'mouseWheel', x, y, deltaX: 0, deltaY: -240.67, canScroll: true }];
    result.nativeInputRequests.push({ at: Date.now(), events: nativeEvents });
    await application.evaluate(({ BrowserWindow }, events) => {
      const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL() === 'app://local/index.html');
      for (const event of events) window.webContents.sendInputEvent(event);
    }, nativeEvents);
    await pause(1600);
    const advanced = await sample(); assertPending(advanced);
    const advancedIndex = fixture.ids.indexOf(advanced.readThroughId);
    assert.ok(advanced.scrollTop > initial.scrollTop + 2, 'NATIVE_WHEEL_DID_NOT_SCROLL');
    assert.ok(advanced.events.some(event => event.type === 'wheel' && event.trusted && event.deltaY > 0), 'TRUSTED_DOWNWARD_WHEEL_NOT_OBSERVED');
    assert.ok(advanced.events.some(event => event.type === 'scroll' && event.trusted && event.scrollTop > initial.scrollTop), 'TRUSTED_SCROLL_NOT_OBSERVED');
    assert.ok(advancedIndex >= fixture.anchorIndex && advancedIndex < fixture.count - 1, 'PENDING_EMOTICONS_BLOCKED_OR_OVERADVANCED_READ');
    assert.equal(advanced.unread, fixture.count - advancedIndex - 1, 'UNREAD_DOES_NOT_MATCH_EXACT_HIGH_WATER');
    assert.ok(advanced.unread > 0 && advanced.unread < initial.unread, 'READ_DID_NOT_CONSUME_ONLY_VISIBLE_SUBSET');
    const completed = advanced.messages.find(message => message.id === advanced.readThroughId);
    assert.ok(completed && completed.box.top >= advanced.viewport.top - 1 &&
      completed.box.bottom > advanced.viewport.top + 1 &&
      completed.box.bottom <= advanced.viewport.top + advanced.clientHeight + 1, 'HIGH_WATER_MESSAGE_NOT_FULLY_VISIBLE');
    assert.ok(result.initialUnreadIds.includes(completed.id), 'ADVANCED_MESSAGE_WAS_ALREADY_READ_CONTEXT');
    assert.ok(completed.tokens.length === tokensPerMessage && completed.tokens.every(token =>
      token.state === 'loading' && token.image.complete === false && token.image.naturalWidth === 0), 'ADVANCED_UNREAD_MESSAGE_HAS_NO_PENDING_EMOTICONS');
    const progressed = await probe();
    assert.equal(progressed.holdAssets, true);
    assert.ok(progressed.assetRequests.every(request => !request.releasedAt), 'ASSETS_RELEASED_BEFORE_READ_ADVANCEMENT');
    assert.ok(progressed.readCalls.some(call => call.assetsHeld && call.payload.readThroughId === advanced.readThroughId), 'NO_NATIVE_READ_COMMIT_WHILE_ASSETS_HELD');
    result.samples.push({ stage: 'native-progress-still-pending', before: initial, after: advanced, completed, probe: progressed });
    await page.screenshot({ path: path.join(evidence, 'synthetic-native-pending.png') });
    check('Trusted native wheel input advances to a fully visible originally unread message while that message and every other emoticon are still pending');

    result.stage = 'release-assets-without-read-intent';
    await application.evaluate(() => globalThis.__emoticonReadingTest.releaseAssets());
    await until(() => page.locator('article[data-message-id] .inline-emoticon').evaluateAll((tokens,expected) =>
      tokens.length === expected && tokens.every(token => {
        const image = token.querySelector('img.emoticon-image'), fallback = token.querySelector('.emoticon-fallback');
        return token.dataset.emoticonState === 'ready' && image?.complete && image.naturalWidth > 0 &&
          !image.hidden && fallback?.hidden;
      }),fixture.count*tokensPerMessage), 'RELEASED_LOCAL_EMOTICONS_DID_NOT_LOAD');
    await pause(1300);
    const loaded = await sample(); sameReading(advanced, loaded);
    for (const [index, message] of loaded.messages.entries()) {
      const before = advanced.messages[index];
      assert.equal(message.id, before.id);
      assert.equal(message.box.height, before.box.height, 'LOADED_EMOTICON_CHANGED_MESSAGE_HEIGHT');
      assert.deepEqual(message.tokens.map(token => ({ token: token.token, width: token.box.width, height: token.box.height })),
        before.tokens.map(token => ({ token: token.token, width: token.box.width, height: token.box.height })), 'LOADED_EMOTICON_CHANGED_FIXED_SLOT');
    }
    const released = await probe();
    assert.equal(released.holdAssets, false);
    assert.ok(released.assetRequests.every(request => request.releasedAt !== undefined));
    assert.ok(released.readCalls.slice(released.releaseReadCallIndex).every(call =>
      !Object.hasOwn(call.payload, 'readThroughId')), 'PASSIVE_ASSET_RELEASE_GRANTED_NEW_READ_INTENT');
    result.samples.push({ stage: 'assets-loaded-passively', before: advanced, after: loaded, probe: released });
    await page.screenshot({ path: path.join(evidence, 'synthetic-native-loaded.png') });
    check('Releasing the real local icon bytes changes only icon visibility: no extra read commit, unread reduction, card resize or anchor shift');

    result.stage='synthetic-gif-animation';
    const gifImage=page.locator('article[data-message-id="'+completed.id+'"] img.emoticon-image[src="'+syntheticGif.src+'"]');
    const bounds=await gifImage.boundingBox();
    assert.ok(bounds&&bounds.width===24&&bounds.height===24&&bounds.y>=loaded.viewport.y&&bounds.y+bounds.height<=loaded.viewport.bottom,'VISIBLE_GIF_FRAME_TARGET');
    const gifResponse=await application.evaluate(async({net},source)=>{
      const response=await net.fetch(source),bytes=await response.arrayBuffer();
      return {status:response.status,mime:response.headers.get('content-type'),bytes:bytes.byteLength,
        bodyBase64:Buffer.from(bytes).toString('base64')};
    },syntheticGif.src);
    gifResponse.sha256=crypto.createHash('sha256').update(Buffer.from(gifResponse.bodyBase64,'base64')).digest('hex');
    delete gifResponse.bodyBase64;
    assert.equal(gifResponse.status,200);assert.equal(gifResponse.mime,'image/gif');
    assert.equal(gifResponse.sha256,syntheticGif.sha256);
    const frames=[];
    for(let index=0;index<10;index++){
      const bytes=await page.screenshot({clip:bounds});
      fs.writeFileSync(path.join(evidence,'synthetic-gif-frame-'+index+'.png'),bytes);
      frames.push({index,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
      await pause(75);
    }
    const distinctFrames=new Set(frames.map(frame=>frame.sha256)).size;
    assert.ok(distinctFrames>=2,'SYNTHETIC_GIF_DID_NOT_ANIMATE_IN_CHROMIUM');
    const afterAnimation=await sample();sameReading(loaded,afterAnimation);
    assert.deepEqual(afterAnimation.messages.map(message=>({id:message.id,height:message.box.height})),
      loaded.messages.map(message=>({id:message.id,height:message.box.height})),'GIF_FRAME_CHANGED_MESSAGE_GEOMETRY');
    Object.assign(result.syntheticGif,{animationObserved:true,protocol:gifResponse,frames,distinctFrames});
    check('A clearly synthetic two-frame GIF decodes and visibly animates through the unchanged local asset server without moving the viewport or reducing unread; no official GIF coverage is claimed');

    result.stage = 'close-and-persist';
    await close();
    const persisted = new Store(path.join(dataDir, 'accounts')).get(fixture.accountId).readStates[fixture.groupId];
    result.finalReadState = persisted;
    assert.equal(persisted.readThroughId, advanced.readThroughId);
    assert.deepEqual(persisted.unreadIds, fixture.ids.slice(advancedIndex + 1));
    assert.deepEqual(result.errors, []); assert.deepEqual(result.httpRequests, []);
    assert.deepEqual(result.finalProbe.blocked, []);
    assert.ok(!result.finalProbe.calls.some(action => /^(?:summary\.ai|notion\.)/.test(action)));
    check('The native app closes cleanly and persists only the reading progress from the wheel, with no HTTP, AI or Notion activity');
    result.stage = 'complete';
  } catch (error) {
    result.failure = String(error.stack || error);
    if (page && !page.isClosed()) {
      const value = await sample().catch(() => null);
      if (value) result.samples.push({ stage: 'failure', value });
    }
  } finally {
    await close().catch(error => { result.failure ||= 'CLOSE_FAILED ' + String(error); });
    if (sourceBefore) {
      try {
        const sourceAfter = sourceManifest();
        fs.writeFileSync(path.join(evidence, 'source-after.json'), JSON.stringify(sourceAfter, null, 2));
        result.sourceStillMatches = JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter);
        const copiedAfter = manifest(appRoot);
        fs.writeFileSync(path.join(evidence, 'copied-app-before.json'), JSON.stringify(copiedBefore, null, 2));
        fs.writeFileSync(path.join(evidence, 'copied-app-after.json'), JSON.stringify(copiedAfter, null, 2));
        result.copiedAppUnchanged = JSON.stringify(copiedBefore) === JSON.stringify(copiedAfter);
        result.executableUnchanged = hash(executablePath) === executableBefore;
        result.sourceHashes = sourceBefore; result.executableSha256 = executableBefore;
      } catch (error) { result.failure ||= 'SOURCE_HASH_CHECK_FAILED ' + String(error); }
    }
    result.nativeExitedCleanly = result.launches.length === 1 &&
      result.launches.every(record => record.exitCode === 0 && record.signal === null);
    result.passed = result.stage === 'complete' && !result.failure && result.sourceStillMatches &&
      result.copiedAppUnchanged && result.executableUnchanged && result.nativeExitedCleanly;
    fs.mkdirSync(evidence, { recursive: true });
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ passed: result.passed, stage: result.stage, checks: result.checks.length,
      report: path.join(evidence, 'result.json'), sourceStillMatches: result.sourceStillMatches,
      copiedAppUnchanged: result.copiedAppUnchanged, nativeExitedCleanly: result.nativeExitedCleanly }));
    if (!result.passed) process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
