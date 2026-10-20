'use strict';

// Real copied main/preload/core/renderer; synthetic local profile only.
// External transports are intercepted before main starts. No real service is contacted.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto'), assert = require('node:assert/strict');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { assertWindowsRuntimeReadable } = require('./windows-runtime-check.cjs');
const root = path.resolve(__dirname, '..');
const sourceVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const evidence = fs.mkdtempSync(path.join(root, 'artifacts', 'export-workflow-' + sourceVersion + '-'));
const harness = fs.mkdtempSync(path.join(os.tmpdir(), 'weiyue-export-workflow-'));
const dataDir = path.join(harness, 'data'); fs.mkdirSync(dataDir);
fs.cpSync(path.join(root, 'vendor/runtime'), path.join(harness, 'runtime'), { recursive: true });
fs.cpSync(path.join(root, 'app'), path.join(harness, 'app'), { recursive: true });
fs.writeFileSync(path.join(harness, 'package.json'), JSON.stringify({ name: 'weiyue-export-workflow-test', version: sourceVersion, main: 'boot.cjs' }));
const executablePath = path.join(harness, 'runtime', 'electron.exe');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sourceHashes = Object.fromEntries(fs.readdirSync(path.join(root, 'app'), { recursive: true })
  .filter(name => fs.statSync(path.join(root, 'app', name)).isFile()).map(name => [name, sha(path.join(root, 'app', name))]));
const fixture = { accountId: 'import-export-workflow-only', groupId: 'mock-export-group',
  targetA: '11111111-1111-4111-8111-111111111111', targetB: '33333333-3333-4333-8333-333333333333',
  messages: Array.from({ length: 12 }, (_, i) => ({ id: String(9007199254741300000n + BigInt(i)), groupId: 'mock-export-group',
    senderId: 'mock-user', senderName: '虚构成员', time: Date.now() - (60 - i * 3) * 60000,
    text: `FIXTURE-REFERENCE-${String(i + 1).padStart(2, '0')} 这是一条完全虚构的导出验收消息。`, mediaVersion: 1 })) };
const { Store } = require(path.join(harness, 'app/core/store.cjs'));
const store = new Store(path.join(dataDir, 'accounts'));
store.ensureAccount({ id: fixture.accountId, kind: 'import', name: '纯虚构导出工作区' });
store.mergeMessages(fixture.accountId, [{ id: fixture.groupId, name: '虚构导出工作流', selected: true }], fixture.messages, { history: true });
fixture.bookmarkIds = [0, 2, 4].map(i => store.bookmark(fixture.accountId, { groupId: fixture.groupId,
  messageIds: fixture.messages.slice(i, i + 2).map(message => message.id), note: `原收藏备注 ${i}`, tags: ['虚构', '验收'] }).id);
store.update(fixture.accountId, state => { state.settings.autoSyncEnabled = false; });
fs.writeFileSync(path.join(dataDir, 'preferences.json'), JSON.stringify({ activeId: fixture.accountId }));

function boot(fixtures) {
  const { app, net, dialog, session, ipcMain } = require('electron');
  const { createHash } = require('node:crypto');
  const digest = text => createHash('sha256').update(text).digest('hex');
  const text = blocks => (blocks || []).map(block => (block[block.type]?.rich_text || []).map(item => item.text?.content || '').join('')).join('');
  const info = globalThis.__exportWorkflow = { requests: [], confirms: [], actions: [], blocked: [], violations: [],
    nativePlans: [], aiPlans: [], pendingNative: null, pendingAI: null, failNextAppend: false, createdIds: [],
    releaseNative() { if (!this.pendingNative) throw Error('No pending native confirmation'); const release = this.pendingNative; this.pendingNative = null; release(); },
    releaseAI() { if (!this.pendingAI) throw Error('No pending AI response'); const release = this.pendingAI; this.pendingAI = null; release(); },
    safe() { return { requests: this.requests.map(call => ({ kind: call.kind, method: call.method, status: call.status,
      parent: call.body?.parent?.page_id, pageId: call.pageId, title: call.body?.properties?.title?.title?.[0]?.text?.content,
      childCount: call.body?.children?.length, bodySha256: call.body ? digest(JSON.stringify(call.body)) : null,
      childrenTextSha256: call.body?.children ? digest(text(call.body.children)) : null })),
      confirms: this.confirms, actions: this.actions.map(call => ({ action: call.action, at: call.at,
        sourceHash: call.payload?.sourceHash, source: call.payload?.summaryId ? 'summary' : call.payload?.bookmarkIds ? 'bookmarks' : undefined,
        bookmarkCount: call.payload?.bookmarkIds?.length, draftBodySha256: call.payload?.draft ? digest(call.payload.draft.body) : undefined })),
      blocked: this.blocked, violations: this.violations, pendingNative: !!this.pendingNative, pendingAI: !!this.pendingAI }; },
  };
  const ensure = (condition, label) => { if (!condition) { info.violations.push(label); throw Error('Mock contract: ' + label); } };
  const originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, handler) => originalHandle(channel, (event, action, payload) => {
    if (channel === 'weiyue:call' && ['summary.ai', 'notion.preview', 'notion.export'].includes(action)) {
      info.actions.push({ action, at: Date.now(), payload: JSON.parse(JSON.stringify(payload)) });
    }
    return handler(event, action, payload);
  });
  dialog.showMessageBox = async (...args) => {
    const options = args.at(-1), plan = info.nativePlans.shift();
    ensure(!!plan, 'Unexpected native confirmation');
    ensure(options.title === '确认发送内容' && options.defaultId === 0 && options.cancelId === 0, 'Native defaults to cancel');
    ensure(plan.kind === 'ai' ? options.message.includes('AI') : options.message.includes('Notion'), 'Expected native action');
    info.confirms.push({ kind: plan.kind, message: options.message, detail: options.detail, response: plan.response, held: !!plan.hold });
    if (plan.hold) await new Promise(resolve => { ensure(!info.pendingNative, 'Only one pending native confirmation'); info.pendingNative = resolve; });
    return { response: plan.response };
  };
  const originalFetch = net.fetch.bind(net);
  net.fetch = async (target, options = {}) => {
    const url = String(target);
    if (/^(app|file):/i.test(url)) return originalFetch(target, options);
    const ai = url === 'http://127.0.0.1:9999/v1/chat/completions';
    const search = url === 'https://api.notion.com/v1/search', create = url === 'https://api.notion.com/v1/pages';
    const pageId = /^https:\/\/api\.notion\.com\/v1\/blocks\/([a-f0-9-]+)\/children$/.exec(url)?.[1];
    const append = !!pageId && info.createdIds.includes(pageId);
    if (!ai && !search && !create && !append) { info.blocked.push('Unexpected net.fetch URL'); throw Error('External network blocked'); }
    const headers = new Headers(options.headers), body = JSON.parse(options.body || '{}');
    ensure(options.method === (append ? 'PATCH' : 'POST') && options.redirect === 'error', 'Exact HTTP method and no redirects');
    ensure(headers.get('content-type') === 'application/json', 'JSON Content-Type');
    const call = { kind: ai ? 'ai' : search ? 'search' : create ? 'create' : 'append', method: options.method, pageId, body };
    info.requests.push(call);
    if (ai) {
      ensure(headers.get('authorization') === 'Bearer WORKFLOW-DUMMY-KEY', 'Dummy AI key only');
      ensure(Object.keys(body).sort().join(',') === 'max_tokens,messages,model,temperature', 'Exact compatible fields');
      ensure(body.model === 'workflow-mock' && body.max_tokens === 4096 && body.temperature === 0.2, 'Compatible model and parameters');
      ensure(body.messages?.length === 2 && body.messages[0].role === 'system' && body.messages[1].role === 'user', 'System and user messages');
      ensure(body.messages[0].content.includes('不可信的聊天资料') && /"ref":"M\d+"/.test(body.messages[1].content), 'Untrusted chat and references');
      const plan = info.aiPlans.shift(); ensure(!!plan, 'No implicit AI retry');
      if (plan.hold) await new Promise(resolve => { ensure(!info.pendingAI, 'Only one pending AI request'); info.pendingAI = resolve; });
      call.status = plan.status;
      return plan.status === 400
        ? Response.json({ error: { code: 'unsupported_value', param: 'temperature', message: 'WORKFLOW-DUMMY-KEY REFLECTED-MOCK-CHAT <img src=x onerror="window.reflected=true">' } }, { status: 400 })
        : Response.json({ choices: [{ message: { content: 'WORKFLOW-AI-SAVED 这是模拟总结，核查原文。[M1]' }, finish_reason: 'stop' }] });
    }
    ensure(headers.get('authorization') === 'Bearer WORKFLOW-DUMMY-NOTION', 'Dummy Notion token only');
    ensure(headers.get('notion-version') === '2026-03-11', 'Explicit Notion version');
    if (search) {
      call.status = 200;
      return Response.json({ results: [fixtures.targetA, fixtures.targetB].map((id, i) => ({ object: 'page', id,
        properties: { title: { type: 'title', title: [{ plain_text: i ? '模拟目标 B' : '模拟目标 A' }] } } })), has_more: false });
    }
    if (create) {
      ensure([fixtures.targetA, fixtures.targetB].includes(body.parent?.page_id), 'Selected mock parent');
      ensure(Object.keys(body).sort().join(',') === 'children,parent,properties', 'Create only a child page');
      const id = info.createdIds.length === 0 ? '22222222-2222-4222-8222-222222222222' : '44444444-4444-4444-8444-444444444444';
      ensure(!info.createdIds.includes(id), 'Unexpected duplicate page creation');
      info.createdIds.push(id); call.pageId = id; call.status = 200;
      return Response.json({ id, url: 'https://www.notion.so/' + id.replaceAll('-', '') });
    }
    ensure(Object.keys(body).join(',') === 'children' && Array.isArray(body.children), 'Append children only');
    if (info.failNextAppend) { info.failNextAppend = false; call.status = 400;
      return Response.json({ message: 'WORKFLOW-DUMMY-NOTION RAW-MOCK-FAILURE' }, { status: 400 }); }
    call.status = 200; return Response.json({ results: body.children });
  };
  const originalRequest = net.request.bind(net);
  net.request = options => {
    const target = typeof options === 'string' ? options : options.url;
    if (/^(app|file):/i.test(String(target))) return originalRequest(options);
    info.blocked.push('Unexpected net.request'); throw Error('External network blocked');
  };
  const attached = new WeakSet();
  function attach(current) {
    if (attached.has(current)) return; attached.add(current);
    current.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, callback) => {
      info.blocked.push('Unexpected browser network'); callback({ cancel: true });
    });
    const original = current.fetch.bind(current);
    current.fetch = (target, options) => {
      if (/^(app|file):/i.test(String(target))) return original(target, options);
      info.blocked.push('Unexpected session.fetch'); return Promise.reject(Error('External network blocked'));
    };
  }
  app.on('session-created', attach); app.whenReady().then(() => attach(session.defaultSession));
  require('./app/main.cjs');
}
fs.writeFileSync(path.join(harness, 'boot.cjs'), '(' + boot.toString() + ')(' + JSON.stringify(fixture) + ');\n');

let application, page, nativeRecord, failure, finalAudit;
const checks = [], errors = [], observations = [];
const check = value => { checks.push(value); console.log('PASS ' + value); };
const api = (action, payload = {}) => page.evaluate(({ action, payload }) => window.api.call(action, payload), { action, payload });
const audit = () => application.evaluate(() => globalThis.__exportWorkflow.safe());
const plan = (native, ai) => application.evaluate((_electron, input) => {
  if (input.native) globalThis.__exportWorkflow.nativePlans.push(input.native);
  if (input.ai) globalThis.__exportWorkflow.aiPlans.push(input.ai);
}, { native, ai });
const writes = state => state.requests.filter(call => ['create', 'append'].includes(call.kind));
const statusText = () => page.locator('#ai-request-message').textContent();
const waitNative = () => application.evaluate(async () => {
  for (let i = 0; i < 160 && !globalThis.__exportWorkflow.pendingNative; i++) await new Promise(resolve => setTimeout(resolve, 25));
  if (!globalThis.__exportWorkflow.pendingNative) throw Error('Native confirmation gate was not reached');
});
async function openAI() {
  await page.locator('#generate-ai').click(); await page.waitForSelector('#ai-consent');
  assert.equal(await page.locator('#ai-consent').isChecked(), false);
  assert.equal(await page.locator('#confirm-ai-send').isDisabled(), true);
  await page.locator('#ai-consent').check();
}
async function expectSummaries(count) {
  await page.waitForFunction(async expected => (await window.api.call('summary.list')).length === expected, count);
}
async function cancelModal() { await page.locator('#modal-close').click(); await page.waitForFunction(() => !document.getElementById('modal').open); }
async function openNotionTarget(target) {
  if (!await page.locator('#notion-target').isVisible()) await page.locator('#notion-load-targets').click();
  await page.waitForSelector('#notion-target'); await page.locator('#notion-target').selectOption(target);
  await page.locator('#notion-preview').click(); await page.waitForSelector('#notion-edit-body');
}
async function exportResult() {
  await page.waitForFunction(() => document.getElementById('modal-title')?.textContent === 'Notion 导出结果');
}
async function finishResult() { await page.getByRole('button', { name: '完成', exact: true }).click(); }
async function lastExportPayload() {
  return application.evaluate(() => globalThis.__exportWorkflow.actions.filter(call => call.action === 'notion.export').at(-1).payload);
}
async function windowSize(width, height) {
  const dimensions = await application.evaluate(({ BrowserWindow }, input) => {
    const window = BrowserWindow.getAllWindows()[0]; window.setSize(input.width, input.height);
    return { minimum: window.getMinimumSize(), size: window.getSize() };
  }, { width, height });
  assert.deepEqual(dimensions.minimum, [1000, 680]);
  assert.ok(Math.abs(dimensions.size[0] - width) <= 2 && Math.abs(dimensions.size[1] - height) <= 2, 'Native window size outside DPI tolerance');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return dimensions;
}
async function geometry(label, selectors) {
  const result = await page.evaluate(selectors => {
    const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    return { viewport: { width: innerWidth, height: innerHeight }, pageWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth, elements: Object.fromEntries(selectors.map(selector => {
        const element = document.querySelector(selector); if (!element) return [selector, null];
        return [selector, { ...rect(element), clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
          clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, overflowY: getComputedStyle(element).overflowY }];
      })) };
  }, selectors);
  assert.ok(result.pageWidth <= result.viewport.width + 2 && result.bodyWidth <= result.viewport.width + 2, label + ': horizontal page overflow');
  for (const [selector, element] of Object.entries(result.elements)) {
    assert.ok(element && element.width > 0 && element.height > 0, label + ': missing visible ' + selector);
    assert.ok(element.x >= -2 && element.right <= result.viewport.width + 2, label + ': horizontal element clipping ' + selector);
    assert.ok(element.scrollWidth <= element.clientWidth + 2, label + ': horizontal content overflow ' + selector);
  }
  observations.push({ kind: 'layout', label, ...result }); return result;
}
async function verifyWorkflowLayout(kind) {
  for (const [size, width, height] of [['normal', 1360, 900], ['minimum', 1000, 680]]) {
    await windowSize(width, height);
    if (kind === 'ai') {
      const result = await geometry('ai-running-' + size, ['#ai-request-status', '#ai-request-message']);
      assert.ok(result.elements['#ai-request-status'].y >= 0 && result.elements['#ai-request-status'].bottom <= result.viewport.height, 'AI status outside viewport');
      const endTime = await page.evaluate(() => {
        const input = document.getElementById('summary-end'), start = document.getElementById('summary-start'),
          now = document.getElementById('summary-now'), style = getComputedStyle(input), canvas = document.createElement('canvas'),
          context = canvas.getContext('2d');
        context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width }; };
        // UA datetime shadow fields do not expose reliable scrollWidth. Use a
        // complete seconds + AM/PM text budget, independent calendar allowance,
        // full-row geometry, and a mandatory manual screenshot review together.
        const completeText = '00/00/0000 00:00:00 AM', textWidth = context.measureText(completeText).width;
        const paddingAndBorder = ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth']
          .reduce((sum, key) => sum + parseFloat(style[key] || 0), 0);
        return { input: rect(input), start: rect(start), now: rect(now), value: input.value, step: input.step,
          font: context.font, completeText, textWidth, paddingAndBorder, calendarAllowance: 28,
          widthBudget: textWidth + paddingAndBorder + 28,
          nativeRenderingRequiresScreenshotReview: true };
      });
      assert.equal(endTime.step, '1');
      assert.ok(endTime.input.width >= endTime.start.width - 2, 'End-time input must retain the full available field row');
      assert.ok(endTime.input.y >= endTime.now.bottom - 2, 'Now button must not consume the end-time input row');
      assert.ok(endTime.input.width + 2 >= endTime.widthBudget, 'Full seconds and AM/PM text budget does not fit the native date input');
      observations.push({ kind: 'end-time-native-width', size, ...endTime });
      await page.locator('#summary-end').screenshot({ path: path.join(evidence, `end-time-${size}.png`) });
      await page.screenshot({ path: path.join(evidence, `ai-running-${size}.png`) });
    } else if (kind === 'bookmarks') {
      const result = await geometry('bookmark-toolbar-' + size, ['.bookmark-selection-toolbar', '#bookmark-select-all', '#bookmark-selected-count', '#export-bookmarks-notion']);
      for (const element of Object.values(result.elements)) assert.ok(element.y >= 0 && element.bottom <= result.viewport.height + 2, 'Bookmark toolbar outside viewport');
      await page.screenshot({ path: path.join(evidence, `bookmark-toolbar-${size}.png`) });
    } else {
      const result = await geometry('notion-editor-' + size, ['#modal', '.modal-body', '#notion-edit-body']);
      const body = result.elements['.modal-body'];
      assert.ok(['auto', 'scroll'].includes(body.overflowY), 'Editor content must support scrolling');
      if (size === 'minimum') assert.ok(body.scrollHeight > body.clientHeight, 'Minimum editor fixture must exercise actual scrolling');
      for (const selector of ['#notion-edit-body', '#notion-include-references', '#notion-confirm-export']) {
        await page.locator(selector).scrollIntoViewIfNeeded();
        const reachable = await page.locator(selector).evaluate(element => {
          const r = element.getBoundingClientRect(), x = Math.max(0, Math.min(innerWidth - 1, r.left + r.width / 2)),
            y = Math.max(0, Math.min(innerHeight - 1, r.top + Math.min(r.height / 2, 20)));
          const hit = document.elementFromPoint(x, y);
          return { intersects: r.bottom > 0 && r.top < innerHeight, hit: hit === element || element.contains(hit) || hit?.contains(element) };
        });
        assert.ok(reachable.intersects && reachable.hit, 'Editor control is clipped or covered: ' + selector);
        if (selector !== '#notion-include-references') await page.screenshot({ path: path.join(evidence, `notion-editor-${size}-${selector === '#notion-edit-body' ? 'body' : 'confirm'}.png`) });
      }
    }
  }
  await windowSize(1360, 900);
  check(kind === 'ai' ? 'AI running status fits normal and minimum native windows without horizontal overflow' :
    kind === 'bookmarks' ? 'Bookmark batch toolbar remains visible and usable in normal and minimum native windows without horizontal overflow' :
      'Notion body, reference choice and confirmation are reachable in normal and minimum windows with actual scrollable content');
}

(async () => {
  try {
    const preflight = assertWindowsRuntimeReadable(executablePath), env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    application = await _electron.launch({ executablePath, cwd: harness, args: [harness, '--data-dir=' + dataDir], env, timeout: 30000 });
    const native = application.process(); nativeRecord = { pid: native.pid, startedAt: new Date().toISOString(), preflight };
    native.once('exit', (exitCode, signal) => Object.assign(nativeRecord, { exitCode, signal, exitedAt: new Date().toISOString() }));
    page = await application.firstWindow();
    page.on('pageerror', () => errors.push('Renderer exception')); page.on('console', event => { if (event.type() === 'error') errors.push('Renderer console error'); });
    await page.waitForSelector('article[data-message-id]');
    await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(1360, 900); window.show(); window.focus(); });
    const state = await api('state'); assert.equal(state.account.id, fixture.accountId); assert.equal(path.resolve(state.dataRoot), dataDir);
    assert.deepEqual(await page.evaluate(() => ({ require: typeof require, process: typeof process })), { require: 'undefined', process: 'undefined' });
    const sourceBookmarks = await api('bookmark.list'); assert.equal(sourceBookmarks.length, 3);
    check('Real sandboxed app uses only the isolated synthetic profile and all external transports are intercepted');

    // Fixture setup uses the real isolated-account IPC. Dedicated settings/UI22
    // tests cover the configuration modal; all 17 export assertions stay intact.
    await api('settings.ai.save', { providerId: 'custom', endpoint: 'http://127.0.0.1:9999/v1',
      model: 'workflow-mock', aiKey: 'WORKFLOW-DUMMY-KEY', keyAction: 'replace' });
    await api('settings.save', { notionToken: 'WORKFLOW-DUMMY-NOTION' });
    // IPC fixture writes do not run renderer save handlers. Reload the real
    // renderer so its startup snapshot sees these persisted test settings.
    await page.reload(); await page.waitForSelector('article[data-message-id]');
    assert.ok((await api('state')).credentials.ai && (await api('state')).credentials.notion);
    // Ensure every fixture message is covered using local component conversion.
    const startLocal = await page.evaluate(time => { const d = new Date(time), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }, fixture.messages[0].time - 60000);
    await page.locator('#summary-start').fill(startLocal); await page.locator('#summary-end').focus();
    // datetime-local has no zone suffix. Parse it on the same local machine,
    // never append Z or compare to an assumed UTC date.
    const beforeNow = await page.evaluate(() => Date.now()); await page.locator('#summary-now').click();
    const now = await page.evaluate(() => { const input = document.getElementById('summary-end'); return {
      after: Date.now(), value: input.value, parsedLocal: new Date(input.value).getTime(), step: input.step, timezoneOffset: new Date().getTimezoneOffset() }; });
    assert.equal(now.step, '1');
    assert.ok(/T\d{2}:\d{2}:\d{2}$/.test(now.value) || new Date(now.parsedLocal).getSeconds() === 0, 'Now must retain nonzero seconds');
    assert.ok(now.parsedLocal >= beforeNow - 2000 && now.parsedLocal <= now.after + 2000, 'Now differs from local clock by more than two seconds');
    observations.push({ kind: 'local-now-seconds', beforeNow, ...now });
    check('Now button uses step=1 and the actual local date/time to the second within two seconds, without a UTC assumption');

    await page.locator('#generate-ai').click(); await page.waitForSelector('#ai-consent');
    let current = await audit(); assert.equal(current.requests.length, 0); assert.equal(current.confirms.length, 0);
    assert.equal(await page.locator('#confirm-ai-send').isDisabled(), true); await cancelModal();
    check('AI preview and unchecked UI consent produce no native confirmation or request');

    await plan({ kind: 'ai', response: 0, hold: true }); await openAI(); await page.locator('#confirm-ai-send').click();
    assert.equal(await page.evaluate(() => document.getElementById('modal').open), false);
    await page.waitForFunction(() => document.getElementById('ai-request-status')?.getAttribute('aria-busy') === 'true');
    await waitNative();
    current = await audit(); assert.equal(current.pendingNative, true); assert.equal(current.requests.length, 0);
    assert.equal(await page.locator('#generate-ai').isDisabled(), true);
    await application.evaluate(() => globalThis.__exportWorkflow.releaseNative());
    await page.waitForFunction(() => document.getElementById('ai-request-message')?.textContent.includes('取消'));
    current = await audit(); assert.equal(current.requests.length, 0); await expectSummaries(0);
    check('AI confirmation closes before native response; native cancellation sends zero requests and saves no summary');

    await plan({ kind: 'ai', response: 1, hold: true }, { status: 400, hold: true }); await openAI();
    const send = await page.locator('#confirm-ai-send').boundingBox(); await page.mouse.dblclick(send.x + send.width / 2, send.y + send.height / 2, { delay: 35 });
    assert.equal(await page.evaluate(() => document.getElementById('modal').open), false);
    await waitNative();
    current = await audit(); assert.equal(current.actions.filter(call => call.action === 'summary.ai').length, 2); assert.equal(current.confirms.length, 2);
    await application.evaluate(() => globalThis.__exportWorkflow.releaseNative());
    await page.waitForFunction(() => document.getElementById('ai-request-status')?.getAttribute('aria-busy') === 'true');
    await application.evaluate(async () => { for (let i = 0; i < 40 && !globalThis.__exportWorkflow.pendingAI; i++) await new Promise(resolve => setTimeout(resolve, 25)); });
    current = await audit(); assert.equal(current.pendingAI, true); assert.equal(current.requests.filter(call => call.kind === 'ai').length, 1);
    await verifyWorkflowLayout('ai');
    await page.screenshot({ path: path.join(evidence, 'ai-running.png') });
    check('Double-click submits only one AI operation and one request; main-window running status remains visible');
    await application.evaluate(() => globalThis.__exportWorkflow.releaseAI());
    await page.waitForFunction(() => document.getElementById('ai-request-message')?.textContent.includes('HTTP 400'));
    const safeError = await statusText(); assert.match(safeError, /temperature/); assert.match(safeError, /未自动重试/);
    assert.doesNotMatch(safeError, /WORKFLOW-DUMMY|REFLECTED-MOCK|<img|onerror/);
    assert.equal(await page.locator('#generate-ai').isDisabled(), false); await expectSummaries(0); await page.waitForTimeout(600);
    assert.equal((await audit()).requests.filter(call => call.kind === 'ai').length, 1);
    await page.screenshot({ path: path.join(evidence, 'ai-safe-error.png') });
    check('AI failure appears outside the closed modal as safe persistent feedback, restores action, and never retries automatically');

    await plan({ kind: 'ai', response: 1 }, { status: 200 }); await openAI(); await page.locator('#confirm-ai-send').click();
    await expectSummaries(1); await page.waitForSelector('#view-ai-summary');
    assert.ok(await page.locator('#message-scroll').isVisible(), 'Background AI completion must not steal the reading view');
    await page.locator('#view-ai-summary').click(); await page.waitForSelector('.summary-document');
    const savedSummary = (await api('summary.list'))[0]; assert.equal(savedSummary.mode, 'ai');
    check('Only renewed explicit AI confirmation succeeds, saves once and leaves reading in place until View summary is clicked');

    await openNotionTarget(fixture.targetA);
    assert.equal(await page.locator('#notion-include-references').isChecked(), true);
    assert.equal(await page.locator('#notion-confirm-export').isDisabled(), true);
    const editedTitle = 'EDITED SUMMARY TITLE', editedBody = 'SUMMARY-EDITED-BODY\nOnly the edited draft goes to Notion.\nLiteral <img src=x> remains plain text.';
    await page.locator('#notion-edit-title').fill(editedTitle); await page.locator('#notion-edit-body').fill(editedBody);
    await page.locator('#notion-include-references').uncheck(); assert.equal(await page.locator('#notion-edit-body').inputValue(), editedBody);
    await page.locator('#notion-include-references').check(); assert.equal(await page.locator('#notion-edit-body').inputValue(), editedBody);
    await verifyWorkflowLayout('notion');
    const beforeEditorCancel = (await audit()).requests.length;
    assert.equal(writes(await audit()).length, 0); await cancelModal(); assert.equal(writes(await audit()).length, 0);
    assert.equal((await audit()).requests.length, beforeEditorCancel);
    check('Notion editor defaults to references, preserves edited body when toggled, and UI cancellation writes nothing');

    await page.locator('#notion-preview').click(); await page.waitForSelector('#notion-edit-body');
    await page.locator('#notion-edit-title').fill(editedTitle); await page.locator('#notion-edit-body').fill(editedBody);
    await page.locator('#notion-include-references').uncheck(); await page.locator('#notion-consent').check();
    const beforeNativeCancel = (await audit()).requests.length;
    await plan({ kind: 'notion', response: 0 }); await page.locator('#notion-confirm-export').click();
    await page.waitForFunction(() => document.getElementById('modal-error')?.textContent.includes('取消'));
    assert.equal(writes(await audit()).length, 0); assert.equal(await page.locator('#notion-edit-body').inputValue(), editedBody);
    assert.equal((await audit()).requests.length, beforeNativeCancel);
    check('Native Notion cancellation sends zero writes and retains the exact editable draft');

    await page.locator('#notion-include-references').check(); assert.equal(await page.locator('#notion-edit-body').inputValue(), editedBody);
    await plan({ kind: 'notion', response: 1 }); await page.locator('#notion-confirm-export').click(); await exportResult();
    let summaryExport = await lastExportPayload(); assert.equal(summaryExport.draft.body, editedBody); assert.equal(summaryExport.draft.includeReferences, true);
    current = await audit(); const firstWrite = writes(current)[0]; assert.equal(firstWrite.parent, fixture.targetA); assert.equal(firstWrite.title, editedTitle);
    const transmitted = await application.evaluate(() => {
      const call = globalThis.__exportWorkflow.requests.find(call => call.kind === 'create');
      return call.body.children.map(block => (block[block.type]?.rich_text || []).map(item => item.text?.content || '').join('')).join('');
    });
    assert.ok(transmitted.includes(editedBody)); assert.ok(!transmitted.includes('WORKFLOW-AI-SAVED'));
    assert.ok(transmitted.includes('FIXTURE-REFERENCE-') && !transmitted.includes('覆盖与核查提示'));
    const confirmed = current.confirms.at(-1); assert.ok(confirmed.detail.includes(fixture.targetA) && confirmed.detail.includes(editedTitle));
    assert.deepEqual((await api('summary.list'))[0], savedSummary, 'Editing/exporting must not overwrite the saved summary');
    await finishResult();
    await plan({ kind: 'notion', response: 1 }); await api('notion.export', summaryExport);
    assert.equal(writes(await audit()).length, 1);
    check('Actual Notion payload matches edited title/body with references; target is confirmed, original summary untouched, exact repeat idempotent');

    await page.locator('[data-view=bookmarks]').click(); await page.waitForSelector('.bookmark-select');
    assert.equal(await page.locator('#export-bookmarks-notion').isDisabled(), true);
    await page.locator('#bookmark-select-all').check(); assert.match(await page.locator('#bookmark-selected-count').textContent(), /3/);
    await page.locator('#bookmark-select-all').uncheck(); assert.equal(await page.locator('#export-bookmarks-notion').isDisabled(), true);
    await page.locator('.bookmark-select').first().check(); assert.match(await page.locator('#bookmark-selected-count').textContent(), /1/);
    await verifyWorkflowLayout('bookmarks');
    assert.deepEqual(await api('bookmark.list'), sourceBookmarks);
    await page.locator('.bookmark-card').first().locator('[data-action=notion-export]').click(); await openNotionTarget(fixture.targetB);
    const onePreview = await application.evaluate(() => globalThis.__exportWorkflow.actions.filter(call => call.action === 'notion.preview').at(-1).payload);
    assert.equal(onePreview.bookmarkIds.length, 1); assert.equal(await page.locator('#notion-include-references').isChecked(), true);
    await cancelModal(); assert.equal(writes(await audit()).length, 1); assert.deepEqual(await api('bookmark.list'), sourceBookmarks);
    check('Bookmark empty selection disables export; all/none/single selection and canceled single export never mutate original bookmarks');

    const boxes = page.locator('.bookmark-select'); await boxes.nth(0).check(); await boxes.nth(1).check();
    assert.match(await page.locator('#bookmark-selected-count').textContent(), /2/);
    await page.locator('#export-bookmarks-notion').click(); await openNotionTarget(fixture.targetB);
    const batchPreview = await application.evaluate(() => globalThis.__exportWorkflow.actions.filter(call => call.action === 'notion.preview').at(-1).payload);
    assert.equal(batchPreview.bookmarkIds.length, 2);
    const batchTitle = 'EDITED BATCH TITLE';
    const batchBody = ('BOOKMARK-DRAFT-EDITED-ONLY ' + 'x'.repeat(175) + '\n').repeat(960).slice(0, 190000);
    await page.locator('#notion-edit-title').fill(batchTitle); await page.locator('#notion-edit-body').fill(batchBody);
    assert.equal(await page.locator('#notion-include-references').isChecked(), true);
    await page.locator('#notion-include-references').uncheck();
    assert.equal(await page.locator('#notion-edit-body').inputValue(), batchBody);
    await page.screenshot({ path: path.join(evidence, 'bookmark-export-editor.png') });
    await page.locator('#notion-consent').check(); await application.evaluate(() => { globalThis.__exportWorkflow.failNextAppend = true; });
    await plan({ kind: 'notion', response: 1 }); await page.locator('#notion-confirm-export').click();
    await page.waitForFunction(() => document.getElementById('modal-error')?.textContent.includes('HTTP 400'));
    assert.equal(await page.locator('#notion-edit-body').inputValue(), batchBody); assert.equal(await page.locator('#notion-include-references').isChecked(), false);
    let afterFailure = await audit(); assert.equal(afterFailure.requests.filter(call => call.kind === 'create').length, 2);
    assert.equal(afterFailure.requests.filter(call => call.kind === 'append').length, 1);
    assert.equal(afterFailure.requests.filter(call => call.kind === 'append')[0].status, 400);
    await page.waitForTimeout(600); assert.equal(writes(await audit()).length, writes(afterFailure).length);
    await page.screenshot({ path: path.join(evidence, 'bookmark-export-failure.png') });
    check('Batch export uses the same editor and retains every edited character/reference choice after known append failure, without automatic retry');

    const failedExport = await lastExportPayload();
    await cancelModal(); await page.locator('#export-bookmarks-notion').click(); await openNotionTarget(fixture.targetB);
    assert.equal(await page.locator('#notion-edit-title').inputValue(), batchTitle);
    assert.equal(await page.locator('#notion-edit-body').inputValue(), batchBody);
    assert.equal(await page.locator('#notion-include-references').isChecked(), false);
    assert.ok(await page.locator('#notion-resume-notice').isVisible());
    assert.match(await page.locator('#notion-resume-notice').textContent(), /恢复|继续|续传/);
    assert.equal(writes(await audit()).length, writes(afterFailure).length);
    await page.screenshot({ path: path.join(evidence, 'bookmark-export-restored.png') });
    check('Reopening a failed partial export restores the journaled title, full draft and disabled references without writing again');
    await page.locator('#notion-consent').check(); await plan({ kind: 'notion', response: 1 });
    await page.locator('#notion-confirm-export').click(); await exportResult();
    const retriedExport = await lastExportPayload(); assert.deepEqual(retriedExport, failedExport);
    current = await audit(); assert.equal(current.requests.filter(call => call.kind === 'create').length, 2);
    const appends = current.requests.filter(call => call.kind === 'append'); assert.equal(appends.length, 2);
    assert.equal(appends[0].pageId, appends[1].pageId); assert.equal(appends[0].bodySha256, appends[1].bodySha256);
    assert.equal(appends[1].status, 200);
    const completedBatch = await application.evaluate(() => globalThis.__exportWorkflow.requests
      .filter(call => call.pageId === '44444444-4444-4444-8444-444444444444' && call.status === 200)
      .flatMap(call => call.body.children).map(block => (block[block.type]?.rich_text || []).map(item => item.text?.content || '').join('')).join(''));
    assert.ok(completedBatch.includes(batchBody)); assert.ok(!completedBatch.includes('FIXTURE-REFERENCE-'));
    assert.ok(!completedBatch.includes('覆盖与核查提示'));
    assert.deepEqual(await api('bookmark.list'), sourceBookmarks);
    await page.screenshot({ path: path.join(evidence, 'bookmark-export-completed.png') }); await finishResult();
    const writeCount = writes(current).length; await plan({ kind: 'notion', response: 1 }); await api('notion.export', retriedExport);
    assert.equal(writes(await audit()).length, writeCount);
    check('Explicit identical batch retry resumes only the failed append on the same page; all draft text/references survive and completed repeat writes nothing');
    assert.deepEqual(errors, []); finalAudit = await audit(); assert.deepEqual(finalAudit.blocked, []); assert.deepEqual(finalAudit.violations, []);
    assert.equal(finalAudit.pendingAI, false); assert.equal(finalAudit.pendingNative, false);
  } catch (error) {
    failure = error instanceof assert.AssertionError ? error.message : 'Workflow operation failed: ' + (error.code || error.name || 'Error');
    console.error(failure);
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
  } finally {
    if (application) {
      finalAudit ||= await audit().catch(() => null);
      await application.evaluate(() => { const info = globalThis.__exportWorkflow; if (info.pendingNative) info.releaseNative(); if (info.pendingAI) info.releaseAI(); }).catch(() => {});
      await application.close().then(() => { nativeRecord.closeAwaited = true; nativeRecord.closedAt = new Date().toISOString(); }).catch(() => { failure ||= 'Native close failed'; });
    }
    const sourceStillMatches = Object.entries(sourceHashes).every(([name, digest]) => sha(path.join(root, 'app', name)) === digest);
    const nativeExitedCleanly = nativeRecord?.exitCode === 0 && nativeRecord?.signal === null && nativeRecord?.closeAwaited;
    const passed = !failure && !errors.length && sourceStillMatches && nativeExitedCleanly && finalAudit && !finalAudit.blocked.length && !finalAudit.violations.length;
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ passed: !!passed, version: sourceVersion, checks, errors, failure,
      observations, nativeRecord, nativeExitedCleanly, sourceHashes, sourceStillMatches, audit: finalAudit, executablePath, harness, dataDir,
      generatedAt: new Date().toISOString(), scope: 'Isolated synthetic account and dummy credentials; every external transport intercepted before actual main starts; native confirmation and responses deterministically gated; no real AI/Notion/profile' }, null, 2));
    console.log(JSON.stringify({ passed: !!passed, version: sourceVersion, checks: checks.length, evidence, nativeExitedCleanly }));
    if (!passed) process.exitCode = 1;
  }
})().catch(() => { console.error('Workflow harness initialization failed; no real data accessed'); process.exitCode = 1; });
