'use strict';
const {assertWindowsRuntimeReadable}=require('./windows-runtime-check.cjs');

// Actual packaged main/preload/renderer, isolated data directory and local fetch fixtures.
// This script never authenticates a real account or reads an existing application profile.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = path.resolve(__dirname, '..');
const executablePath = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'WeiYue-1.0.1-verification', 'WeiYue.exe'));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weiyue-login-integration-data-'));
const evidence = path.join(root, 'artifacts', 'login-integration');
fs.mkdirSync(evidence, { recursive: true });
const identityId = '9007199254740993999';
const groupId = '9007199254740993888';
const checks = [], errors = [];
let application, page;
const check = description => { checks.push(description); console.log(`PASS ${description}`); };
const state = () => page.evaluate(() => window.api.call('state'));
const status = () => page.evaluate(() => window.api.call('login.status'));
const mock = () => application.evaluate(() => ({ mode: globalThis.__loginIntegration.mode, opened: globalThis.__loginIntegration.opened, calls: globalThis.__loginIntegration.calls, aborted: globalThis.__loginIntegration.aborted, blocked: globalThis.__loginIntegration.blocked }));

function fileHashes() {
  const files = ['main.cjs', 'preload.cjs', 'core/login-flow.cjs', 'core/weibo.cjs', 'core/account-session.cjs', 'renderer/app.js', 'renderer/index.html', 'renderer/style.css'];
  const appRoot = path.join(path.dirname(executablePath), 'resources', 'app', 'app');
  return Object.fromEntries(files.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(appRoot, file))).digest('hex')]));
}

async function launch() {
  assertWindowsRuntimeReadable(executablePath);
  application = await _electron.launch({ executablePath, cwd: root, args: ['--data-dir=' + dataDir], timeout: 30000 });
  page = await application.firstWindow({ timeout: 30000 });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.waitForSelector('#login-button');
}

async function installFixtures() {
  await application.evaluate(({ app, BrowserWindow, session }, fixtures) => {
    const info = globalThis.__loginIntegration = { mode: 'unauthorized', opened: 0, calls: [], aborted: 0, blocked: [] };
    const originalLoadURL = BrowserWindow.prototype.loadURL;
    BrowserWindow.prototype.loadURL = function(url, options) {
      if (url === 'https://api.weibo.com/chat') { info.opened++; return Promise.resolve(); }
      return originalLoadURL.call(this, url, options);
    };
    const attached = new WeakSet();
    const attach = current => {
      if (attached.has(current)) return;
      attached.add(current);
      current.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
        info.blocked.push({ origin: new URL(details.url).origin });
        callback({ cancel: true });
      });
      current.fetch = async (url, options = {}) => {
        const target = new URL(String(url));
        if (target.origin !== 'https://api.weibo.com') throw new Error('Unexpected service blocked by integration test');
        const safeReferer = options.headers?.Referer === 'https://api.weibo.com/chat';
        const mode = info.mode;
        info.calls.push({ endpoint: target.pathname, safeReferer, mode });
        if (!safeReferer || mode === 'unauthorized') return new Response(JSON.stringify({ error_code: 10012 }), { status: 200, headers: { 'content-type': 'application/json' } });
        if (mode === 'hold') return new Promise((resolve, reject) => {
          const abort = () => { info.aborted++; reject(new DOMException('Local mock canceled', 'AbortError')); };
          if (options.signal?.aborted) abort();
          else options.signal?.addEventListener('abort', abort, { once: true });
        });
        const body = target.pathname === '/webim/query_primary_info.json'
          ? { profile: { id: fixtures.identityId, screen_name: '模拟登录 · 集成测试' } }
          : target.pathname === '/webim/2/direct_messages/contacts.json'
            ? { contacts: [{ user: { type: 2, id: fixtures.groupId, name: '模拟群 · 无真实记录' } }] }
            : null;
        if (!body) throw new Error('Unexpected Weibo endpoint blocked by integration test');
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      };
    };
    app.on('session-created', attach);
    attach(session.defaultSession);
    for (const window of BrowserWindow.getAllWindows()) attach(window.webContents.session);
  }, { identityId, groupId });
}

(async () => {
  let requests = [], sourceHashes;
  try {
    sourceHashes = fileHashes();
    await launch();
    await installFixtures();
    const initial = await state();
    assert.equal(initial.account.kind, 'demo');
    assert.equal(path.resolve(initial.dataRoot), dataDir);
    const initialIds = initial.accounts.map(account => account.id).sort();
    assert.deepEqual(await page.evaluate(() => ({ require: typeof require, process: typeof process })), { require: 'undefined', process: 'undefined' });
    await page.locator('#login-button').click();
    await page.locator('#open-official-login').click();
    await application.waitForEvent('window', { timeout: 2000 }).catch(() => {});
    assert.equal((await mock()).opened, 1);
    assert.equal((await mock()).calls.length, 0);
    const windowPreferences = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => {
      const prefs = window.webContents.getLastWebPreferences();
      return { sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration };
    }));
    assert.equal(windowPreferences.length, 2);
    assert.ok(windowPreferences.every(prefs => prefs.sandbox && prefs.contextIsolation && !prefs.nodeIntegration));
    assert.equal((await status()).running, false);
    check('Packaged executable uses a new temporary data directory; real IPC opens an isolated sandboxed login window without network');

    await page.locator('#complete-login').click();
    await page.waitForFunction(() => !document.querySelector('#login-error')?.hidden && document.querySelector('#login-error')?.textContent.includes('页面来源'));
    assert.equal(await page.locator('#complete-login').isEnabled(), true);
    assert.equal(await page.locator('#modal').evaluate(element => element.open), true);
    assert.equal((await status()).stage, 'error');
    const failedState = await state();
    assert.equal(failedState.account.id, initial.account.id);
    assert.deepEqual(failedState.accounts.map(account => account.id).sort(), initialIds);
    assert.equal((await mock()).calls.length, 1);
    assert.equal((await mock()).calls[0].safeReferer, true);
    await page.screenshot({ path: path.join(evidence, 'inline-source-error.png') });
    check('Real WeiboClient maps error_code 10012 to an inline retryable error; failure creates no account and preserves demo selection');

    await application.evaluate(() => { globalThis.__loginIntegration.mode = 'hold'; });
    await page.locator('#complete-login').click();
    await page.waitForFunction(async () => (await window.api.call('login.status')).running);
    const runningStatus = await status();
    assert.equal(runningStatus.stage, 'identity');
    assert.equal(await page.locator('#complete-login').isDisabled(), true);
    assert.equal(await page.locator('#login-status .busy-indicator').isVisible(), true);
    await page.locator('#cancel-login-read').click();
    await page.waitForFunction(async () => !(await window.api.call('login.status')).running && !document.querySelector('#complete-login')?.disabled);
    assert.equal((await status()).stage, 'canceled');
    assert.equal((await mock()).aborted, 1);
    const canceledState = await state();
    assert.equal(canceledState.account.id, initial.account.id);
    assert.deepEqual(canceledState.accounts.map(account => account.id).sort(), initialIds);
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 2);
    assert.equal(await page.locator('#modal').evaluate(element => element.open), true);
    await page.screenshot({ path: path.join(evidence, 'canceled-real-ipc.png') });
    check('Real login.status and login.cancel abort the pending session.fetch; no account is saved or selected and the login session remains open');

    const requestStart = (await mock()).calls.length;
    await application.evaluate(() => { globalThis.__loginIntegration.mode = 'success'; });
    await page.locator('#complete-login').click();
    await page.waitForSelector('#save-groups');
    const success = await state();
    assert.equal(success.account.id, 'weibo-' + identityId);
    assert.equal(success.account.kind, 'weibo');
    assert.equal(success.groups.length, 1);
    assert.equal(success.groups[0].id, groupId);
    assert.equal(success.groups[0].selected, false);
    assert.equal((await status()).stage, 'completed');
    const successCalls = (await mock()).calls.slice(requestStart);
    assert.deepEqual(successCalls.map(call => call.endpoint), ['/webim/query_primary_info.json', '/webim/2/direct_messages/contacts.json', '/webim/query_primary_info.json']);
    assert.ok(successCalls.every(call => call.safeReferer));
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
    await page.screenshot({ path: path.join(evidence, 'success-group-chooser.png') });
    check('Real identity → groups → identity verification succeeds, preserves both oversized IDs as strings and opens group selection');

    const finalMock = await mock();
    requests = finalMock.calls;
    assert.ok(requests.every(call => call.safeReferer));
    assert.deepEqual(finalMock.blocked, []);
    await application.close(); application = null;
    await launch();
    await installFixtures();
    const restored = await state();
    assert.equal(restored.account.id, 'weibo-' + identityId);
    assert.equal(restored.groups[0].id, groupId);
    assert.equal(restored.groups[0].selected, false);
    assert.deepEqual((await mock()).calls, []);
    assert.deepEqual((await mock()).blocked, []);
    assert.deepEqual(errors, []);
    check('Restarting the same actual executable restores the isolated test account and exact group ID without background service calls');

    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ passed: true, executablePath, dataDir, sourceHashes, checks, errors, requests, externalServices: 'All session.fetch responses mocked before login.open; every HTTP(S) request denied; no real credentials', generatedAt: new Date().toISOString() }, null, 2));
    console.log(JSON.stringify({ passed: true, checks: checks.length, report: path.join(evidence, 'result.json'), dataDir }));
  } catch (error) {
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ passed: false, executablePath, dataDir, sourceHashes, checks, errors, requests, failure: String(error), generatedAt: new Date().toISOString() }, null, 2));
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    if (application) await application.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
