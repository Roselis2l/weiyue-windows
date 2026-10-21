'use strict';
// Real app/core/preload/renderer with a synthetic legacy profile. Every external
// transport is blocked before main starts. No actual model service is called.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { assertWindowsRuntimeReadable } = require('./windows-runtime-check.cjs');
const root = path.resolve(__dirname, '..'), version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const evidence = fs.mkdtempSync(path.join(root, 'artifacts', 'ai-settings-workflow-' + version + '-'));
const harness = fs.mkdtempSync(path.join(os.tmpdir(), 'weiyue-ai-settings-')), dataDir = path.join(harness, 'data');
fs.mkdirSync(dataDir);
fs.cpSync(path.join(root, 'vendor/runtime'), path.join(harness, 'runtime'), { recursive: true });
fs.cpSync(path.join(root, 'app'), path.join(harness, 'app'), { recursive: true });
fs.writeFileSync(path.join(harness, 'package.json'), JSON.stringify({ name: 'weiyue-ai-settings-test', version, main: 'boot.cjs' }));
const executablePath = path.join(harness, 'runtime', 'electron.exe');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sourceHashes = Object.fromEntries(fs.readdirSync(path.join(root, 'app'), { recursive: true })
  .filter(name => fs.statSync(path.join(root, 'app', name)).isFile()).map(name => [name, sha(path.join(root, 'app', name))]));
const fixture = { accountId: 'import-ai-settings-only', groupId: 'mock-ai-settings-group', dataDir, evidence,
  legacyEndpoint: 'https://legacy-ai.example/v1/', legacyModel: 'legacy/model:2026',
  legacyKey: 'AI-SETTINGS-LEGACY-DUMMY', savedNotion: 'AI-SETTINGS-NOTION-SAVED-DUMMY',
  draftNotion: 'AI-SETTINGS-NOTION-DRAFT-DUMMY' };
const { Store } = require(path.join(harness, 'app/core/store.cjs'));
const store = new Store(path.join(dataDir, 'accounts'));
store.ensureAccount({ id: fixture.accountId, kind: 'import', name: '虚构 AI 配置工作区' });
store.mergeMessages(fixture.accountId, [{ id: fixture.groupId, name: '虚构设置验收', selected: true }],
  [{ id: '9007199254741700001', groupId: fixture.groupId, senderId: 'mock-member', senderName: '虚构成员',
    time: Date.now() - 60000, text: '仅用于设置界面验收，不发送给任何服务。', mediaVersion: 1 }], { history: true });
store.update(fixture.accountId, state => { state.settings = { autoSyncEnabled: false, endpoint: fixture.legacyEndpoint, model: fixture.legacyModel }; });
fs.writeFileSync(path.join(dataDir, 'preferences.json'), JSON.stringify({ activeId: fixture.accountId }));

function boot(fixtures) {
  const { app, net, session, safeStorage, dialog, ipcMain } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
  const { Vault } = require('./app/core/security.cjs');
  const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const audit = globalThis.__aiSettingsAudit = { networkAttempts: [], confirms: 0, actions: [], seedCredentialHash: null,
    vault() {
      const vault = new Vault(path.join(fixtures.dataDir, 'credentials'), safeStorage), credentials = vault.read(fixtures.accountId);
      return { fileSha256: digest(vault.file(fixtures.accountId)), hasAi: !!credentials.aiKey, scope: credentials.aiKeyScope || null,
        legacyKeyUnchanged: credentials.aiKey === fixtures.legacyKey, savedNotionUnchanged: credentials.notionToken === fixtures.savedNotion,
        draftNotionSaved: credentials.notionToken === fixtures.draftNotion,
        ciphertextContainsDummyText: fs.readFileSync(vault.file(fixtures.accountId)).includes(Buffer.from('AI-SETTINGS-')) };
    },
  };
  const trace = event => fs.appendFileSync(path.join(fixtures.evidence, 'bootstrap-events.jsonl'), JSON.stringify({ event, at: new Date().toISOString() }) + '\n');
  const deny = transport => { audit.networkAttempts.push(transport); trace('Blocked ' + transport); throw Error('External network blocked by settings-only test'); };
  const originalFetch = net.fetch.bind(net);
  net.fetch = (url, options) => /^(file|app):/i.test(String(url)) ? originalFetch(url, options) : deny('net.fetch');
  const originalRequest = net.request.bind(net);
  net.request = options => /^(file|app):/i.test(String(typeof options === 'string' ? options : options?.url)) ? originalRequest(options) : deny('net.request');
  globalThis.fetch = () => deny('global.fetch');
  const attached = new WeakSet();
  function attach(current) {
    if (attached.has(current)) return; attached.add(current);
    current.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, callback) => {
      audit.networkAttempts.push('browser'); callback({ cancel: true });
    });
    const original = current.fetch.bind(current);
    current.fetch = (url, options) => /^(file|app):/i.test(String(url)) ? original(url, options) : deny('session.fetch');
  }
  app.on('session-created', attach);
  app.on('browser-window-created', () => trace('Native window created'));
  app.on('will-quit', () => trace('App will quit'));
  dialog.showMessageBox = async () => { audit.confirms++; return { response: 0 }; };
  const originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, handler) => originalHandle(channel, (event, action, payload) => {
    if (channel === 'weiyue:call' && ['settings.save', 'settings.ai.save', 'ai.providers', 'summary.ai'].includes(action)) {
      audit.actions.push({ action, providerId: payload?.providerId, keyAction: payload?.keyAction,
        aiVisionMode: payload?.aiVisionMode,
        hasTypedKey: !!payload?.aiKey, includesAiFields: ['endpoint', 'model', 'aiKey'].some(key => Object.hasOwn(payload || {}, key)) });
    }
    return handler(event, action, payload);
  });
  // Register before main.start: initialize only this fresh fixture's legacy
  // ciphertext using actual Windows safeStorage, never re-seed on restart.
  app.whenReady().then(() => {
    attach(session.defaultSession);
    const vault = new Vault(path.join(fixtures.dataDir, 'credentials'), safeStorage);
    if (!fs.existsSync(vault.file(fixtures.accountId))) vault.write(fixtures.accountId, { aiKey: fixtures.legacyKey, notionToken: fixtures.savedNotion });
    audit.seedCredentialHash = digest(vault.file(fixtures.accountId)); trace('Synthetic credential fixture ready');
  });
  require('./app/main.cjs');
}
fs.writeFileSync(path.join(harness, 'boot.cjs'), '(' + boot.toString() + ')(' + JSON.stringify(fixture) + ');\n');
let application, page, failure, failureDetail;
const checks = [], errors = [], observations = [], launches = [], audits = [];
const check = value => { checks.push(value); console.log('PASS ' + value); };
const api = (action, payload = {}) => page.evaluate(({ action, payload }) => window.api.call(action, payload), { action, payload });
const safeAudit = () => application.evaluate(() => {
  const a = globalThis.__aiSettingsAudit; return { networkAttempts: a.networkAttempts, confirms: a.confirms,
    actions: a.actions, seedCredentialHash: a.seedCredentialHash, vault: a.vault() };
});
const state = () => api('state');
async function launch() {
  const preflight = assertWindowsRuntimeReadable(executablePath), env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({ executablePath, cwd: harness, args: [harness, '--data-dir=' + dataDir], env, timeout: 30000 });
  const native = application.process(), record = { pid: native.pid, startedAt: new Date().toISOString(), preflight }; launches.push(record);
  native.once('exit', (exitCode, signal) => Object.assign(record, { exitCode, signal, exitedAt: new Date().toISOString() }));
  page = await application.firstWindow();
  page.on('pageerror', () => errors.push('Renderer exception'));
  page.on('console', event => { if (event.type() === 'error') errors.push('Renderer console error'); });
  await page.waitForSelector('article[data-message-id]');
  await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(1360, 900); window.show(); window.focus(); });
}
async function close() {
  if (!application) return;
  audits.push(await safeAudit());
  await application.close(); Object.assign(launches.at(-1), { closeAwaited: true, closedAt: new Date().toISOString() }); application = null;
}
async function openSettings() { await page.locator('#settings-button').click(); await page.waitForSelector('#configure-ai'); }
async function openAI() { await page.locator('#configure-ai').click(); await page.waitForSelector('#ai-provider'); }
async function backToSettings() { await page.locator('#modal-close').click(); await page.waitForSelector('#notion-token'); }
async function closeSettings() { await page.locator('#modal-close').click(); await page.waitForFunction(() => !document.getElementById('modal').open); }
async function rejected(action, payload) {
  const before = await state(), beforeVault = (await safeAudit()).vault.fileSha256;
  const result = await page.evaluate(async ({ action, payload }) => { try { await window.api.call(action, payload); return { rejected: false }; }
    catch (error) { return { rejected: true, message: String(error.message) }; } }, { action, payload });
  assert.equal(result.rejected, true, action + ' unexpectedly accepted a mismatched credential destination');
  assert.match(result.message, /Key|厂商|地址|API|模型/);
  assert.deepEqual((await state()).settings, before.settings);
  assert.equal((await safeAudit()).vault.fileSha256, beforeVault);
  observations.push({ kind: 'rejection', action, rejected: true });
}
async function screenshotLayouts(label) {
  for (const [suffix, width, height] of [['normal', 1360, 900], ['minimum', 1000, 680]]) {
    await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height]);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const geometry = await page.evaluate(() => {
      const modal = document.getElementById('modal'), r = modal.getBoundingClientRect(), body = modal.querySelector('.modal-body');
      return { viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth,
        modal: { left: r.left, right: r.right, top: r.top, bottom: r.bottom }, bodyClientHeight: body.clientHeight,
        bodyScrollHeight: body.scrollHeight, bodyOverflowY: getComputedStyle(body).overflowY };
    });
    assert.ok(geometry.documentWidth <= geometry.viewport.width + 2);
    assert.ok(geometry.modal.left >= -2 && geometry.modal.right <= geometry.viewport.width + 2);
    for (const selector of ['#ai-provider', '#ai-key', '#ai-model', '#ai-vision-mode', '#save-ai-config']) {
      await page.locator(selector).scrollIntoViewIfNeeded();
      assert.ok(await page.locator(selector).evaluate(element => {
        const r = element.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(15, r.height / 2));
        return hit === element || element.contains(hit);
      }), selector + ' inaccessible at ' + suffix);
    }
    observations.push({ kind: 'layout', label, size: suffix, ...geometry });
    await page.screenshot({ path: path.join(evidence, `${label}-${suffix}.png`) });
  }
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1360, 900));
}
(async () => {
  try {
    await launch();
    const initial = await state(); assert.equal(initial.account.id, fixture.accountId); assert.equal(path.resolve(initial.dataRoot), dataDir);
    assert.equal(initial.settings.endpoint, fixture.legacyEndpoint); assert.equal(initial.settings.model, fixture.legacyModel);
    assert.equal(initial.settings.aiProviderId, undefined);
    assert.deepEqual(await page.evaluate(() => ({ require: typeof require, process: typeof process })), { require: 'undefined', process: 'undefined' });
    let audit = await safeAudit(); assert.equal(audit.vault.scope, null); assert.equal(audit.vault.fileSha256, audit.seedCredentialHash);
    assert.equal(audit.vault.ciphertextContainsDummyText, false);
    check('Isolated legacy profile starts with unchanged endpoint/model and unbound encrypted dummy key; no startup credential migration');

    const providers = await api('ai.providers'), expectedIds = ['openai', 'deepseek', 'kimi', 'zhipu', 'minimax', 'hunyuan', 'qwen', 'xiaomi', 'custom'];
    assert.deepEqual(providers.map(item => item.id), expectedIds);
    assert.deepEqual(providers.map(item => item.name), ['OpenAI', 'DeepSeek', 'Kimi', '智谱', 'MiniMax', '混元', '千问', '小米', '自定义']);
    const expectedUrls = ['https://api.openai.com/v1', 'https://api.deepseek.com/chat/completions', 'https://api.moonshot.cn/v1',
      'https://open.bigmodel.cn/api/paas/v4', 'https://api.minimax.cn/v1', 'https://api.hunyuan.cloud.tencent.com/v1',
      'https://dashscope.aliyuncs.com/compatible-mode/v1', 'https://api.xiaomimimo.com/v1', ''];
    assert.deepEqual(providers.map(item => item.endpoint), expectedUrls);
    assert.ok(providers.every(item => typeof item.notice === 'string' && item.notice.length > 10));
    await openSettings(); await page.locator('#notion-token').fill(fixture.draftNotion); await openAI();
    assert.deepEqual(await page.locator('#ai-provider option').evaluateAll(options => options.filter(option => !option.disabled).map(option => option.value)), expectedIds);
    assert.equal(await page.locator('#ai-provider option[disabled][value=""]').count(), 1);
    assert.equal(await page.locator('#ai-provider').inputValue(), 'custom');
    assert.equal(await page.locator('#ai-endpoint').inputValue(), fixture.legacyEndpoint);
    assert.equal(await page.locator('#ai-model').inputValue(), fixture.legacyModel);
    assert.ok(await page.evaluate(() => {
      const provider = document.getElementById('ai-provider'), key = document.getElementById('ai-key'), model = document.getElementById('ai-model');
      return !!(provider.compareDocumentPosition(key) & Node.DOCUMENT_POSITION_FOLLOWING) &&
        !!(key.compareDocumentPosition(model) & Node.DOCUMENT_POSITION_FOLLOWING);
    }), 'Provider, API key and model fields must follow the requested order');
    check('Eight offline provider presets plus custom retain the required order and destinations; legacy settings open as custom without rewriting values');

    assert.equal(await page.locator('#ai-vision-mode').inputValue(), 'auto');
    assert.deepEqual(await page.locator('#ai-vision-mode option').evaluateAll(options => options.map(option => option.value)), ['auto', 'enabled', 'disabled']);
    await page.locator('#ai-vision-mode').selectOption('enabled');
    await page.locator('#ai-model').fill('different/vision-model');
    assert.equal(await page.locator('#ai-vision-mode').inputValue(), 'auto', 'A visual declaration must not follow an edited model');
    await page.locator('#ai-model').fill(fixture.legacyModel);
    await page.locator('#ai-vision-mode').selectOption('enabled');
    await page.locator('#ai-endpoint').fill('https://different-vision.example/v1');
    assert.equal(await page.locator('#ai-vision-mode').inputValue(), 'auto', 'A visual declaration must not follow an edited endpoint');
    await page.locator('#ai-endpoint').fill(fixture.legacyEndpoint);
    await page.locator('#ai-vision-mode').selectOption('enabled');
    await page.locator('#ai-provider').selectOption('openai');
    assert.equal(await page.locator('#ai-vision-mode').inputValue(), 'auto', 'A visual declaration must not follow a different provider');
    await page.locator('#ai-provider').selectOption('custom');
    assert.equal(await page.locator('#ai-endpoint').inputValue(), fixture.legacyEndpoint);
    assert.equal(await page.locator('#ai-model').inputValue(), fixture.legacyModel);
    assert.deepEqual((await state()).settings, initial.settings);
    observations.push({ kind: 'vision-reset', changedFields: ['model', 'endpoint', 'provider'], declarationBefore: 'enabled', declarationAfter: 'auto', storageUntouched: true });
    check('Real vision selector defaults legacy settings to auto and resets enabled on every model, endpoint and provider change without changing storage');

    assert.equal(await page.locator('#ai-key').inputValue(), ''); assert.equal(await page.locator('#ai-key').getAttribute('type'), 'password');
    assert.equal(await page.locator('#toggle-ai-key').isDisabled(), true);
    await page.locator('#ai-key').fill('AI-SETTINGS-TYPED-ONLY-DUMMY'); await page.locator('#toggle-ai-key').click();
    assert.equal(await page.locator('#ai-key').getAttribute('type'), 'text');
    assert.equal(await page.locator('#ai-key').inputValue(), 'AI-SETTINGS-TYPED-ONLY-DUMMY');
    await page.locator('#toggle-ai-key').click(); assert.equal(await page.locator('#ai-key').getAttribute('type'), 'password');
    assert.ok(!JSON.stringify(await state()).includes('AI-SETTINGS-'));
    check('Eye control reveals only currently typed text; an existing saved key remains absent and cannot be revealed through state');

    await page.locator('#ai-model').fill('free/model:2026-10-user-choice');
    for (const provider of providers.filter(item => !item.custom)) {
      await page.locator('#ai-provider').selectOption(provider.id);
      assert.equal(await page.locator('#ai-key').inputValue(), ''); assert.equal(await page.locator('#toggle-ai-key').isDisabled(), true);
      assert.equal(await page.locator('#ai-key').getAttribute('type'), 'password');
      assert.equal(await page.locator('#ai-model').inputValue(), 'free/model:2026-10-user-choice');
      assert.ok((await page.locator('#ai-provider-endpoint').textContent()).includes(provider.endpoint));
      assert.ok((await page.locator('#ai-provider-notice').textContent()).includes(provider.notice));
      assert.equal(await page.locator('#ai-endpoint').isVisible(), false);
      assert.equal(await page.locator('#save-ai-config').isDisabled(), true);
    }
    await page.locator('#ai-model').fill(''); await page.locator('#ai-key').fill('AI-SETTINGS-UNSAVED-DUMMY');
    assert.equal(await page.locator('#save-ai-config').isDisabled(), true);
    await page.locator('#ai-provider').selectOption('qwen');
    assert.equal(await page.locator('#ai-model').inputValue(), '', 'Selecting a provider must not invent a default model');
    await backToSettings(); assert.equal(await page.locator('#notion-token').inputValue(), fixture.draftNotion);
    assert.deepEqual((await state()).settings, initial.settings);
    audit = await safeAudit(); assert.equal(audit.vault.fileSha256, audit.seedCredentialHash); assert.equal(audit.vault.savedNotionUnchanged, true);
    await closeSettings();
    check('Preset changes preserve free model text, clear typed credentials, require complete fields, and cancellation preserves old storage plus outer Notion draft');

    await openSettings(); await page.locator('#notion-token').fill(fixture.draftNotion); await openAI();
    await page.locator('#ai-endpoint').fill(''); assert.equal(await page.locator('#save-ai-config').isDisabled(), true);
    await page.locator('#ai-endpoint').fill(fixture.legacyEndpoint);
    await page.locator('#ai-model').fill(''); assert.equal(await page.locator('#save-ai-config').isDisabled(), true);
    await page.locator('#ai-model').fill('any/vendor-model:2026.10');
    assert.equal(await page.locator('#save-ai-config').isDisabled(), false);
    await page.locator('#ai-vision-mode').selectOption('enabled');
    await screenshotLayouts('legacy-custom-editor');
    await page.locator('#save-ai-config').click(); await page.waitForSelector('#notion-token');
    assert.equal(await page.locator('#notion-token').inputValue(), fixture.draftNotion);
    let configured = await state(); assert.equal(configured.settings.model, 'any/vendor-model:2026.10'); assert.equal(configured.settings.aiProviderId, 'custom');
    assert.equal(configured.settings.aiVisionMode, 'enabled');
    audit = await safeAudit(); assert.equal(audit.vault.legacyKeyUnchanged, true); assert.equal(audit.vault.savedNotionUnchanged, true);
    assert.equal(audit.actions.filter(item => item.action === 'settings.ai.save').at(-1).aiVisionMode, 'enabled');
    assert.deepEqual(audit.vault.scope, { providerId: 'custom', endpoint: 'https://legacy-ai.example/v1/chat/completions' });
    check('Explicit same-scope AI save accepts a freely entered model, binds the legacy key only then, and leaves unsaved Notion text uncommitted');
    const aiSettings = configured.settings;
    await page.locator('#save-settings').click(); await page.waitForFunction(() => !document.getElementById('modal').open);
    assert.deepEqual((await state()).settings, aiSettings);
    audit = await safeAudit(); assert.equal(audit.vault.draftNotionSaved, true);
    const notionSave = audit.actions.filter(item => item.action === 'settings.save').at(-1); assert.equal(notionSave.includesAiFields, false);
    check('Saving outer Notion-only settings preserves all AI fields and submits no accidental blank AI values');

    await openSettings(); await openAI(); await page.locator('#ai-provider').selectOption('openai');
    assert.equal(await page.locator('#ai-vision-mode').inputValue(), 'auto');
    await page.locator('#ai-model').fill('gpt-6-astra');
    assert.equal(await page.locator('#save-ai-config').isDisabled(), true);
    await rejected('settings.ai.save', { providerId: 'openai', endpoint: providers[0].endpoint, model: 'gpt-6-astra', keyAction: 'keep' });
    await rejected('settings.save', { endpoint: providers[0].endpoint, model: 'gpt-6-astra', aiKey: '' });
    await page.locator('#ai-key').fill('AI-SETTINGS-OPENAI-DUMMY'); assert.equal(await page.locator('#save-ai-config').isDisabled(), false);
    await screenshotLayouts('preset-editor');
    await page.locator('#save-ai-config').click(); await page.waitForSelector('#notion-token');
    configured = await state(); assert.equal(configured.settings.aiProviderId, 'openai'); assert.equal(configured.settings.endpoint, providers[0].endpoint);
    check('Switching provider requires a newly entered key in UI and both dedicated and legacy IPC paths; explicit new-key preset save succeeds');

    await openAI(); await page.locator('#ai-provider').selectOption('custom');
    await page.locator('#ai-endpoint').fill('https://custom-one.example/v1'); await page.locator('#ai-model').fill('unlisted/free-model:next');
    assert.equal(await page.locator('#save-ai-config').isDisabled(), true);
    await page.locator('#ai-key').fill('AI-SETTINGS-CUSTOM-DUMMY'); await page.locator('#save-ai-config').click(); await page.waitForSelector('#notion-token');
    await openAI(); await page.locator('#ai-endpoint').fill('https://custom-two.example/v1');
    assert.equal(await page.locator('#ai-key').inputValue(), ''); assert.equal(await page.locator('#save-ai-config').isDisabled(), true);
    await rejected('settings.ai.save', { providerId: 'custom', endpoint: 'https://custom-two.example/v1', model: 'unlisted/free-model:next', keyAction: 'keep' });
    await rejected('settings.save', { endpoint: 'https://custom-two.example/v1', model: 'unlisted/free-model:next', aiKey: '' });
    await rejected('settings.ai.save', { providerId: 'openai', endpoint: 'https://custom-two.example/v1', model: 'gpt-6-astra',
      keyAction: 'replace', aiKey: 'AI-SETTINGS-PRESET-SPOOF-DUMMY' });
    await backToSettings(); await closeSettings();
    check('Changing a custom host cannot reuse a saved key or bypass scope through legacy settings.save; spoofed preset destinations are rejected');

    // A same-origin, normalized completion URL is the same scope; retain the
    // existing key without making a service request.
    await api('settings.ai.save', { providerId: 'custom', endpoint: 'https://custom-one.example/v1/chat/completions/',
      model: 'unlisted/free-model:final', keyAction: 'keep' });
    assert.equal((await state()).settings.aiVisionMode, 'auto');
    await openSettings(); await openAI();
    assert.equal(await page.locator('#ai-vision-mode').inputValue(), 'auto');
    // The direct IPC normalization assertion above intentionally does not drive
    // the renderer's local model. Enter the final model through the UI before
    // declaring its vision capability, exactly as a user would.
    await page.locator('#ai-model').fill('unlisted/free-model:final');
    assert.equal(await page.locator('#ai-vision-mode').inputValue(), 'auto');
    await page.locator('#ai-vision-mode').selectOption('enabled');
    await page.locator('#save-ai-config').click(); await page.waitForSelector('#notion-token');
    await closeSettings();
    const finalSettings = (await state()).settings, finalVault = (await safeAudit()).vault;
    assert.equal(finalSettings.aiVisionMode, 'enabled');
    assert.deepEqual(finalVault.scope, { providerId: 'custom', endpoint: 'https://custom-one.example/v1/chat/completions' });
    assert.equal(finalVault.ciphertextContainsDummyText, false); assert.equal(finalVault.draftNotionSaved, true);
    assert.ok(!JSON.stringify(await state()).includes('AI-SETTINGS-'));
    check('Equivalent normalized completion URL retains the same scoped key; credentials remain encrypted with no IPC secret echo');
    check('Explicit vision declaration is saved through actual UI and IPC only for the currently selected model after model edits reset to auto');

    // Tamper only the synthetic fixture's stored destination to verify generation
    // validates encrypted key scope before any native consent or network.
    store.update(fixture.accountId, value => { value.settings.endpoint = 'https://tampered.example/v1'; });
    const mismatch = await page.evaluate(async groupId => {
      try { await window.api.call('summary.ai', { groupId, start: Date.now() - 3600000, end: Date.now() + 60000, consent: true }); return false; }
      catch (error) { return /Key.*(厂商|地址)|不匹配/.test(error.message); }
    }, fixture.groupId);
    assert.equal(mismatch, true);
    store.update(fixture.accountId, value => { value.settings = finalSettings; });
    assert.equal((await safeAudit()).confirms, 0);
    check('AI generation rejects a deliberately mismatched synthetic persisted destination before consent or network');

    await close(); await launch();
    assert.deepEqual((await state()).settings, finalSettings);
    const restarted = await safeAudit(); assert.equal(restarted.vault.fileSha256, finalVault.fileSha256);
    assert.deepEqual(restarted.vault.scope, finalVault.scope); assert.equal(restarted.vault.draftNotionSaved, true);
    await openSettings(); await openAI();
    assert.equal(await page.locator('#ai-key').inputValue(), ''); assert.equal(await page.locator('#toggle-ai-key').isDisabled(), true);
    assert.equal(await page.locator('#ai-model').inputValue(), 'unlisted/free-model:final');
    assert.equal(await page.locator('#ai-vision-mode').inputValue(), 'enabled');
    await backToSettings(); await closeSettings();
    check('Actual restart preserves explicit model, endpoint, vision declaration, encrypted key scope and Notion token without revealing the saved key');
    assert.deepEqual(errors, []);
    assert.equal((await safeAudit()).networkAttempts.length, 0);
  } catch (error) {
    failure = error instanceof assert.AssertionError ? error.message : 'Settings workflow failed: ' + (error.code || error.name || 'Error');
    failureDetail = String(error.message || '').replace(/AI-SETTINGS-[A-Z-]+/g, '[DUMMY]').slice(0, 12000);
    console.error(failure);
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
  } finally {
    await close().catch(() => { failure ||= 'Native close failed'; });
    const sourceStillMatches = Object.entries(sourceHashes).every(([name, digest]) => sha(path.join(root, 'app', name)) === digest);
    const nativeExitedCleanly = launches.length > 0 && launches.every(run => run.exitCode === 0 && run.signal === null && run.closeAwaited);
    const noExternalRequests = audits.length > 0 && audits.every(audit => audit.networkAttempts.length === 0 && audit.confirms === 0);
    const passed = !failure && !errors.length && sourceStillMatches && nativeExitedCleanly && noExternalRequests;
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ passed, version, checks, failure, failureDetail, errors,
      observations, launches, nativeExitedCleanly, noExternalRequests, sourceHashes, sourceStillMatches, audits, executablePath, dataDir,
      generatedAt: new Date().toISOString(), scope: 'Synthetic legacy account, dummy credentials and actual Windows DPAPI only. Every external transport blocked before main loads. No real account or API service.' }, null, 2));
    console.log(JSON.stringify({ passed, version, checks: checks.length, evidence, nativeExitedCleanly, noExternalRequests }));
    if (!passed) process.exitCode = 1;
  }
})().catch(() => { console.error('Settings test initialization failed'); process.exitCode = 1; });
