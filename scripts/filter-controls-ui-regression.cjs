'use strict';
// Isolated production control module in actual sandboxed Windows Electron.
// Synthetic members only; all HTTP/HTTPS requests are denied.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { assertWindowsRuntimeReadable } = require('./windows-runtime-check.cjs');
const root = path.resolve(__dirname, '..');
const evidence = fs.mkdtempSync(path.join(root, 'artifacts', 'filter-controls-ui-'));
const harness = fs.mkdtempSync(path.join(os.tmpdir(), 'weiyue-filter-controls-ui-'));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const source = path.join(root, 'app/renderer/filter-controls.js');
fs.cpSync(path.join(root, 'vendor/runtime'), path.join(harness, 'runtime'), { recursive: true });
fs.copyFileSync(source, path.join(harness, 'filter-controls.js'));
const sourceHash = hash(source);
fs.writeFileSync(path.join(harness, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'">
<title>成员筛选合成控件验收</title><style>
body{font:16px "Microsoft YaHei",sans-serif;margin:32px;color:#243c34;background:#fafbf7}button,input{font:inherit;padding:8px}
[hidden]{display:none!important}.member-picker{position:relative;width:370px}.member-picker-panel{padding:16px;border:1px solid #abc;background:white}
.member-picker-search{width:100%;box-sizing:border-box}.member-picker-option{display:flex;gap:10px;padding:8px;align-items:center}
.member-picker-id,.member-picker-status{font-size:12px;color:#65756a}.member-picker-list{max-height:340px;overflow:auto}
.member-picker-clear{margin:8px 0}.member-picker-empty{color:#65756a}button:focus-visible,input:focus-visible{outline:3px solid #337e62}
</style><h1>成员筛选合成控件验收</h1><p>仅模拟昵称与 ID；网络已禁用。</p><div id="host"></div>
<button id="outside">控件外按钮</button><div id="second"></div>
<script src="filter-controls.js"></script><script src="fixture.js"></script></html>`);
fs.writeFileSync(path.join(harness, 'fixture.js'), `
'use strict';
globalThis.changes=[];globalThis.interactions=[];globalThis.imeEvents=[];
globalThis.members=[
 {id:'9007199254741000001',name:'阿明'},
 {id:'9007199254741000002',name:'阿明'},
 {id:'9007199254741000003',name:'中文小组'},
 {id:'danger<&"',name:'<img src=x onerror=alert(1)>'}
];
globalThis.picker=WeiyueFilters.createMemberPicker({container:document.getElementById('host'),
 members,selectedIds:[],onChange:ids=>changes.push(ids),onInteraction:active=>interactions.push(active)});
for(const type of ['compositionstart','compositionend','input']){
 document.addEventListener(type,event=>{if(event.target.matches('.member-picker-search'))
 imeEvents.push({type,trusted:event.isTrusted,isComposing:event.isComposing??null,data:event.data??null,value:event.target.value});},true);
}
`);
function boot() {
  const { app, BrowserWindow, session } = require('electron'), path = require('node:path');
  app.setPath('userData', path.join(__dirname, 'isolated-profile'));
  globalThis.blocked = [];
  app.whenReady().then(() => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      globalThis.blocked.push(details.url); callback({ cancel: true });
    });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    const win = new BrowserWindow({ width: 920, height: 760, show: true, webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
    } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.loadFile(path.join(__dirname, 'index.html'));
  });
  app.on('window-all-closed', () => app.quit());
}
fs.writeFileSync(path.join(harness, 'main.cjs'), '(' + boot.toString() + ')();');
let application, page, failure, nativeExit;
const checks = [], errors = [], samples = [];
const pass = text => { checks.push(text); console.log('PASS ' + text); };
async function snapshot(stage) {
  const value = await page.evaluate(() => ({
    sameInput: globalThis.originalInput === document.querySelector('.member-picker-search'),
    connected: !!globalThis.originalInput?.isConnected,
    focused: document.activeElement === globalThis.originalInput,
    value: document.querySelector('.member-picker-search')?.value,
    selectionStart: document.querySelector('.member-picker-search')?.selectionStart,
    selected: picker.getSelected(), interacting: picker.isInteracting(),
    visible: [...document.querySelectorAll('.member-picker-option:not([hidden])')].map(el => el.textContent),
    changes: structuredClone(changes), interactions: [...interactions], events: structuredClone(imeEvents),
  }));
  samples.push({ stage, ...value }); return value;
}
(async () => {
  try {
    const executablePath = path.join(harness, 'runtime/electron.exe');
    assertWindowsRuntimeReadable(executablePath);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    application = await _electron.launch({ executablePath, args: [path.join(harness, 'main.cjs')], cwd: harness, env, timeout: 30000 });
    application.process().once('exit', (code, signal) => { nativeExit = { code, signal }; });
    page = await application.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await page.waitForSelector('.member-picker-toggle');
    assert.deepEqual(await page.evaluate(() => ({ require: typeof require, process: typeof process })), { require: 'undefined', process: 'undefined' });
    const prefs = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
    assert.ok(prefs.sandbox && prefs.contextIsolation && !prefs.nodeIntegration && prefs.webSecurity);
    pass('Production UMD control loads in actual sandboxed Electron with no Node access');
    await page.locator('.member-picker-toggle').click();
    const search = page.locator('.member-picker-search');
    await page.evaluate(() => { globalThis.originalInput = document.querySelector('.member-picker-search'); });
    assert.equal(await page.locator('.member-picker-option').count(), 4);
    assert.equal(await page.locator('.member-picker-option img').count(), 0);
    assert.equal(await page.locator('.member-picker-option .member-picker-id:visible').count(), 2);
    assert.ok(await page.locator('.member-picker-option').last().innerText().then(text => text.includes('<img src=x onerror=alert(1)>')));
    assert.equal(await page.locator('.member-picker-option input').evaluateAll(inputs => new Set(inputs.map(el => el.id)).size), 4);
    pass('Duplicate names display their distinct precision-safe IDs and untrusted labels remain text');

    await search.fill('阿明');
    await page.getByRole('checkbox', { name: '阿明，ID：9007199254741000001', exact: true }).check();
    await search.fill('9007199254741000002');
    await page.getByRole('checkbox', { name: '阿明，ID：9007199254741000002', exact: true }).check();
    assert.deepEqual(await page.evaluate(() => picker.getSelected()), ['9007199254741000001', '9007199254741000002']);
    const changeCount = await page.evaluate(() => changes.length);
    await page.evaluate(() => picker.setMembers(members.filter(member => member.id !== '9007199254741000001')));
    assert.deepEqual(await page.evaluate(() => picker.getSelected()), ['9007199254741000001', '9007199254741000002']);
    await page.evaluate(() => picker.setMembers(members));
    assert.equal(await page.evaluate(() => changes.length), changeCount);
    assert.equal(await search.inputValue(), '9007199254741000002');
    assert.equal((await snapshot('selection-refresh')).sameInput, true);
    pass('Searching by name or ID preserves all selected members across refresh and temporarily absent IDs');

    await search.fill(''); await search.focus();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: 'zhongwen', selectionStart: 8, selectionEnd: 8 });
    await page.waitForTimeout(400);
    const before = await snapshot('chromium-composing');
    assert.ok(before.events.some(event => event.type === 'compositionstart' && event.trusted));
    assert.ok(before.events.some(event => event.type === 'input' && event.trusted && event.isComposing));
    assert.equal(before.value, 'zhongwen'); assert.equal(before.visible.length, 4);
    await page.evaluate(() => {
      picker.setMembers([...members, { id: 'added-member', name: '中文新增成员' }]);
      picker.setSelected(['9007199254741000001', '9007199254741000002']);
      document.querySelector('.member-picker-search').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 229, isComposing: true, bubbles: true }));
      document.querySelector('.member-picker-search').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true }));
    });
    await page.waitForTimeout(400);
    const during = await snapshot('refresh-during-chromium-composition');
    assert.ok(during.sameInput && during.connected && during.focused && during.interacting);
    assert.equal(during.value, before.value); assert.equal(during.selectionStart, before.selectionStart);
    assert.deepEqual(during.visible, before.visible);
    assert.equal(during.changes.length, changeCount);
    assert.equal(await page.locator('.member-picker-toggle').getAttribute('aria-expanded'), 'true');
    pass('Trusted Chromium composition survives member/selection refresh with identical input, focus and caret; provisional text is not filtered');
    await cdp.send('Input.insertText', { text: '中文' });
    await page.waitForFunction(() => document.querySelector('.member-picker-search').value === '中文' &&
      document.querySelectorAll('.member-picker-option:not([hidden])').length === 2);
    const committed = await snapshot('composition-committed');
    assert.ok(committed.sameInput && committed.focused);
    assert.ok(committed.visible.every(text => text.includes('中文')));
    assert.deepEqual(committed.selected, ['9007199254741000001', '9007199254741000002']);
    assert.equal(committed.changes.length, changeCount);
    pass('Composition commit applies the latest members and complete Chinese query without changing selected IDs');
    await page.screenshot({ path: path.join(evidence, 'chinese-member-filter.png') });

    await search.fill(''); await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), '阿明，ID：9007199254741000001');
    await page.keyboard.press('Space');
    assert.deepEqual(await page.evaluate(() => picker.getSelected()), ['9007199254741000002']);
    await page.evaluate(() => { globalThis.focusedOption = document.activeElement; picker.setMembers(members); });
    assert.equal(await page.evaluate(() => document.activeElement === globalThis.focusedOption), true);
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), '阿明，ID：9007199254741000002');
    await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp');
    assert.equal(await search.evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.member-picker-toggle').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('.member-picker-toggle').evaluate(el => el === document.activeElement), true);
    pass('Native checkbox Space, arrow navigation, label association and Escape support keyboard use and survive refresh');
    await page.keyboard.press('ArrowDown');
    await search.fill('阿明');
    await page.locator('.member-picker-clear').click();
    assert.deepEqual(await page.evaluate(() => picker.getSelected()), []);
    assert.equal(await search.inputValue(), '阿明');
    assert.equal((await snapshot('clear-selection')).sameInput, true);
    assert.equal(await page.locator('.member-picker-clear').isDisabled(), true);
    await page.locator('#outside').click();
    assert.equal(await page.evaluate(() => picker.isInteracting()), false);
    assert.equal(await page.locator('.member-picker-toggle').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.evaluate(() => interactions.at(-1)), false);
    pass('Clear-all preserves search text and input; outside interaction closes the panel and releases deferred-refresh state');

    await page.evaluate(() => {
      globalThis.second = WeiyueFilters.createMemberPicker({ container: document.getElementById('second'), members, selectedIds: new Set(['9007199254741000002']) });
    });
    const ids = await page.locator('input, [role="group"]').evaluateAll(nodes => nodes.map(node => node.id).filter(Boolean));
    assert.equal(new Set(ids).size, ids.length);
    await page.evaluate(() => { picker.destroy(); picker.setMembers(members); picker.setSelected(['9007199254741000001']); second.destroy(); });
    assert.equal(await page.locator('.member-picker').count(), 0);
    assert.equal(await page.locator('#outside').count(), 1);
    pass('Multiple controls have distinct accessible IDs; destroy removes only owned nodes and disables later updates');
    assert.deepEqual(errors, []);
    assert.deepEqual(await application.evaluate(() => globalThis.blocked), []);
  } catch (error) {
    failure = String(error.stack || error); console.error(failure);
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
  } finally {
    const blocked = application ? await application.evaluate(() => globalThis.blocked).catch(() => null) : null;
    if (application) await application.close().catch(error => { failure ||= String(error); });
    const sourceUnchanged = hash(source) === sourceHash && hash(path.join(harness, 'filter-controls.js')) === sourceHash;
    const passed = !failure && !errors.length && sourceUnchanged && blocked?.length === 0 && nativeExit?.code === 0;
    const result = { passed, checks, failure, errors, samples, blocked, sourceHash, sourceUnchanged, nativeExit,
      evidence, harness, generatedAt: new Date().toISOString(),
      scope: 'Isolated production control module, synthetic members, HTTP/HTTPS denied; no real account, AI or Notion',
      coverage: { chromiumTrustedComposition: samples.some(sample => sample.events.some(event => event.type === 'compositionstart' && event.trusted)),
        windowsPinyinCandidateWindow: false, compositionCommit: 'CDP Input.insertText; runtime reports compositionend as untrusted',
        keyboard: 'Trusted Chromium keyboard delivery', appIntegration: 'Owned by parent; this harness exercises the production control module only' } };
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ passed, checks: checks.length, report: path.join(evidence, 'result.json') }));
    if (!passed) process.exitCode = 1;
  }
})();
