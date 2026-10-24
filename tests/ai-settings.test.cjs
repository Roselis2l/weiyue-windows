'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const os = require('node:os');
const path = require('node:path');
const { listAiProviders, prepareAiSettingsSave, prepareLegacyAiSettingsSave, assertAiKeyScope, scopeFor } = require('../app/core/ai-settings.cjs');
const { prepareAiRequest, aiSummary, prepareSummary } = require('../app/core/summary.cjs');
const { AiPreviewStore } = require('../app/core/ai-preview.cjs');
const { Vault } = require('../app/core/security.cjs');
const { Store } = require('../app/core/store.cjs');

const oldSettings = () => ({ endpoint: 'https://api.openai.com/v1', model: 'model-entered-by-user', unrelated: 'preserved' });
const secrets = () => ({ aiKey: 'old-mock-key', notionToken: 'notion-mock', cookies: [{ name: 'session', value: 'cookie-mock' }] });
const save = (extra = {}) => ({ providerId: 'openai', endpoint: 'https://api.openai.com/v1', model: 'user-model', keyAction: 'replace', aiKey: 'new-mock-key', ...extra });
const bound = () => prepareAiSettingsSave(oldSettings(), secrets(), save());

test('provider list is offline, ordered, has no default model or credentials, and cannot mutate registry', () => {
  const providers = listAiProviders();
  assert.deepEqual(providers.map(item => item.id), ['openai', 'deepseek', 'kimi', 'zhipu', 'minimax', 'hunyuan', 'qwen', 'xiaomi', 'custom']);
  assert.ok(providers.every(item => !('model' in item) && !('aiKey' in item) && typeof item.notice === 'string'));
  assert.equal(providers.find(item => item.id === 'deepseek').endpoint, 'https://api.deepseek.com/chat/completions');
  assert.equal(providers.at(-1).custom, true); assert.equal(providers.at(-1).endpoint, '');
  const expected = [
    'https://api.openai.com/v1/chat/completions',
    'https://api.deepseek.com/chat/completions',
    'https://api.moonshot.cn/v1/chat/completions',
    'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    'https://api.minimax.cn/v1/chat/completions',
    'https://api.hunyuan.cloud.tencent.com/v1/chat/completions',
    'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    'https://api.xiaomimimo.com/v1/chat/completions',
  ];
  assert.deepEqual(providers.slice(0, -1).map(item => prepareAiRequest({ endpoint: item.endpoint, model: 'chosen-id' }).url), expected);
  providers[0].endpoint = 'https://wrong.invalid';
  assert.equal(listAiProviders()[0].endpoint, 'https://api.openai.com/v1');
});

test('explicit save preserves user model and other settings/secrets, binding only the canonical destination', () => {
  const settings = oldSettings(), credentials = secrets(), before = structuredClone({ settings, credentials });
  const result = prepareAiSettingsSave(settings, credentials, save({ model: ' GPT-6 Astra ' }));
  assert.equal(result.settings.model, 'GPT-6 Astra');
  assert.equal(result.settings.aiProviderId, 'openai');
  assert.equal(result.settings.unrelated, 'preserved');
  assert.equal(result.credentials.aiKey, 'new-mock-key');
  assert.deepEqual(result.credentials.aiKeyScope, { providerId: 'openai', endpoint: 'https://api.openai.com/v1/chat/completions' });
  assert.deepEqual(result.credentials.cookies, credentials.cookies);
  assert.equal(result.credentials.notionToken, credentials.notionToken);
  assert.deepEqual({ settings, credentials }, before);
});

test('keep permits equivalent endpoint spelling and model-only edits within the same provider scope', () => {
  const current = bound();
  for (const endpoint of ['https://api.openai.com/v1/', 'https://API.OPENAI.COM:443/v1/chat/completions/']) {
    const result = prepareAiSettingsSave(current.settings, current.credentials, save({ endpoint, model: 'another-user-model', keyAction: 'keep', aiKey: '' }));
    assert.equal(result.credentials.aiKey, current.credentials.aiKey);
    assert.deepEqual(result.credentials.aiKeyScope, current.credentials.aiKeyScope);
    assert.equal(result.settings.endpoint, 'https://api.openai.com/v1');
    assert.equal(result.settings.model, 'another-user-model');
  }
});

test('keep cannot cross provider or endpoint scope and cannot bypass an existing mismatched binding', () => {
  const current = bound();
  for (const payload of [
    save({ providerId: 'custom', keyAction: 'keep', aiKey: '' }),
    save({ providerId: 'custom', endpoint: 'https://other.invalid/v1', keyAction: 'keep', aiKey: '' }),
    save({ providerId: 'kimi', endpoint: 'https://api.moonshot.cn/v1', keyAction: 'keep', aiKey: '' }),
  ]) assert.throws(() => prepareAiSettingsSave(current.settings, current.credentials, payload), /改变/);
  assert.throws(() => prepareAiSettingsSave(current.settings, { ...current.credentials, aiKeyScope: { providerId: 'custom', endpoint: 'https://other.invalid/v1/chat/completions' } }, save({ keyAction: 'keep', aiKey: '' })), /不匹配/);
  assert.throws(() => prepareAiSettingsSave(current.settings, {}, save({ keyAction: 'keep', aiKey: '' })), /没有可保留/);
});

test('preset endpoint cannot be spoofed; custom explicit destination uses same safe endpoint validation', () => {
  assert.throws(() => prepareAiSettingsSave({}, {}, save({ endpoint: 'https://api.openai.com.evil.invalid/v1' })), /预设/);
  for (const endpoint of ['', 'https://user:pass@example.com/v1', 'https://example.com/v1?token=mock', 'http://example.com/v1', 'file:///tmp/file', 'https://example.com/responses', 'https://example.com/messages']) assert.throws(() => prepareAiSettingsSave({}, {}, save({ providerId: 'custom', endpoint })));
  const local = prepareAiSettingsSave({}, {}, save({ providerId: 'custom', endpoint: 'http://127.0.0.1:11434/v1' }));
  assert.equal(local.settings.endpoint, 'http://127.0.0.1:11434/v1');
  assert.equal(local.credentials.aiKeyScope.endpoint, 'http://127.0.0.1:11434/v1/chat/completions');
});

test('save requires actual model and deliberate key action without reflecting secret input in errors', () => {
  for (const payload of [
    save({ model: '' }), save({ model: ' ' }), save({ model: 7 }), save({ model: 'x'.repeat(201) }),
    save({ providerId: '__proto__' }), save({ providerId: 'azure' }),
    save({ keyAction: 'other' }), save({ keyAction: 'replace', aiKey: '' }),
    save({ keyAction: 'replace', aiKey: 'mock-secret\r\nAuthorization: test' }),
    save({ keyAction: 'keep', aiKey: 'mock-secret' }),
  ]) assert.throws(() => prepareAiSettingsSave({}, {}, payload), error => !error.message.includes('mock-secret'));
});

test('unbound legacy key stays usable without mutation; explicit same custom save binds it', () => {
  const settings = oldSettings(), credentials = secrets(), original = structuredClone(credentials);
  assert.equal(assertAiKeyScope(settings, credentials), credentials.aiKey);
  assert.deepEqual(credentials, original);
  const result = prepareAiSettingsSave(settings, credentials, save({ providerId: 'custom', model: settings.model, keyAction: 'keep', aiKey: '' }));
  assert.equal(result.credentials.aiKey, credentials.aiKey);
  assert.equal(result.credentials.aiKeyScope.providerId, 'custom');
  assert.throws(() => assertAiKeyScope({ ...result.settings, endpoint: 'https://other.invalid/v1' }, result.credentials), /不匹配/);
  assert.throws(() => assertAiKeyScope({ ...result.settings, aiProviderId: 'openai' }, result.credentials), /不匹配/);
});

test('legacy Notion-only save preserves AI exactly; full payload cannot bypass the new binding', () => {
  const current = bound();
  assert.deepEqual(prepareLegacyAiSettingsSave(current.settings, current.credentials, { notionToken: 'changed' }), current);
  const kept = prepareLegacyAiSettingsSave(current.settings, current.credentials, { endpoint: current.settings.endpoint, model: 'new-model', aiKey: '' });
  assert.equal(kept.settings.aiProviderId, 'openai'); assert.equal(kept.credentials.aiKey, current.credentials.aiKey);
  assert.throws(() => prepareLegacyAiSettingsSave(current.settings, current.credentials, { endpoint: 'https://other.invalid/v1', model: 'new-model', aiKey: '' }), /改变/);
  const changed = prepareLegacyAiSettingsSave(current.settings, current.credentials, { endpoint: 'https://other.invalid/v1', model: 'new-model', aiKey: 'deliberately-new-key' });
  assert.equal(changed.settings.aiProviderId, 'custom');
  assert.equal(changed.credentials.aiKeyScope.endpoint, 'https://other.invalid/v1/chat/completions');
  assert.equal(prepareLegacyAiSettingsSave({}, {}, { endpoint: '', model: '', aiKey: '' }).credentials.aiKey, undefined);
});

test('omitted vision mode remains bound to canonical endpoint, provider and model across current and legacy saves', () => {
  const initial = {
    settings: { endpoint: 'https://vision.example.test/v1', model: 'declared-vision-model', aiProviderId: 'custom', aiVisionMode: 'enabled' },
    credentials: { aiKey: 'VISION-MOCK-KEY', aiKeyScope: { providerId: 'custom', endpoint: 'https://vision.example.test/v1/chat/completions' } },
  };
  const payload = { providerId: 'custom', endpoint: initial.settings.endpoint, model: initial.settings.model, keyAction: 'keep' };
  const current = extra => prepareAiSettingsSave(initial.settings, initial.credentials, { ...payload, ...extra });
  const legacy = extra => prepareLegacyAiSettingsSave(initial.settings, initial.credentials, extra);
  assert.equal(current({ endpoint: 'https://VISION.EXAMPLE.TEST:443/v1/chat/completions/', model: ' declared-vision-model ' }).settings.aiVisionMode, 'enabled');
  assert.equal(current({ model: 'different-model' }).settings.aiVisionMode, 'auto');
  assert.equal(current({ endpoint: 'https://another-vision.example.test/v1', keyAction: 'replace', aiKey: 'NEW-MOCK-KEY' }).settings.aiVisionMode, 'auto');
  assert.equal(current({ providerId: 'openai', endpoint: 'https://api.openai.com/v1', keyAction: 'replace', aiKey: 'NEW-MOCK-KEY' }).settings.aiVisionMode, 'auto');
  assert.equal(current({ model: 'different-model', aiVisionMode: 'enabled' }).settings.aiVisionMode, 'enabled');
  assert.equal(legacy({ endpoint: 'https://vision.example.test/v1/chat/completions/', model: initial.settings.model, aiKey: '' }).settings.aiVisionMode, 'enabled');
  assert.equal(legacy({ model: 'different-model', aiKey: '' }).settings.aiVisionMode, 'auto');
  assert.equal(legacy({ endpoint: 'https://another-vision.example.test/v1', aiKey: 'NEW-MOCK-KEY' }).settings.aiVisionMode, 'auto');
  assert.equal(legacy({ model: 'different-model', aiKey: '', aiVisionMode: 'enabled' }).settings.aiVisionMode, 'enabled');
  assert.deepEqual(legacy({ notionToken: 'NOTION-MOCK-ONLY' }), initial);
  assert.equal(initial.settings.aiVisionMode, 'enabled', 'Neither save helper may mutate original configuration');
});

test('binding stays inside the encrypted Vault blob and provider settings survive Store restart', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'weiyue-ai-settings-test-'));
  try {
    const inputs = [], safeStorage = { isEncryptionAvailable: () => true, encryptString: text => { inputs.push(text); return Buffer.from(Buffer.from(text).toString('base64')); }, decryptString: bytes => Buffer.from(bytes.toString(), 'base64').toString() };
    const current = bound(), vault = new Vault(path.join(temp, 'credentials'), safeStorage);
    vault.write('mock', current.credentials);
    const raw = fs.readFileSync(vault.file('mock'), 'utf8');
    assert.ok(!raw.includes(current.credentials.aiKey)); assert.ok(!raw.includes('aiKeyScope'));
    assert.equal(inputs.length, 1); assert.ok(inputs[0].includes('"aiKeyScope"'));
    assert.deepEqual(new Vault(path.join(temp, 'credentials'), safeStorage).read('mock'), current.credentials);
    const store = new Store(path.join(temp, 'accounts')); store.ensureAccount({ id: 'mock', name: 'Mock', kind: 'demo' });
    store.update('mock', state => { state.settings = current.settings; });
    const loaded = new Store(path.join(temp, 'accounts')).get('mock').settings;
    assert.deepEqual(loaded, current.settings); assert.ok(!JSON.stringify(loaded).includes('new-mock-key')); assert.ok(!('aiKeyScope' in loaded));
  } finally {
    const resolved = path.resolve(temp);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('weiyue-ai-settings-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test('Kimi exact official origins omit temperature, keep user model and 4096 budget, with no extra fields', async () => {
  const start = 1700000000000;
  const prepared = prepareSummary({ messages: [{ id: '1', groupId: 'g', senderId: 'u', senderName: 'mock', time: start + 1, text: 'fixture text' }], group: { id: 'g', name: 'mock' }, start, end: start + 10000 });
  for (const endpoint of ['https://api.moonshot.cn/v1', 'https://api.moonshot.ai/v1', 'https://API.MOONSHOT.CN:443/v1']) {
    let calls = 0;
    await aiSummary(prepared, { endpoint, model: 'user-chosen-api-id', key: 'mock', fetch: async (url, options) => {
      calls++;
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'user-chosen-api-id'); assert.equal(body.max_tokens, 4096);
      for (const field of ['temperature', 'max_completion_tokens', 'thinking', 'reasoning_effort', 'tools']) assert.equal(field in body, false);
      assert.match(url, /^https:\/\/api\.moonshot\.(?:cn|ai)\/v1\/chat\/completions$/);
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'mock summary [M1]' } }] }), { status: 200 });
    } });
    assert.equal(calls, 1);
  }
  for (const endpoint of ['https://api.moonshot.cn.evil.invalid/v1', 'https://api.moonshot.ai:444/v1', 'https://other.invalid/v1']) assert.equal(prepareAiRequest({ endpoint, model: 'user-id' }).requestParameters.temperature, 0.2);
  assert.deepEqual(prepareAiRequest({ endpoint: 'https://api.openai.com/v1', model: 'user-id' }).requestParameters, { max_completion_tokens: 4096 });
});

const mainSource = fs.readFileSync(require.resolve('../app/main.cjs'), 'utf8');
const handleSource = mainSource.slice(mainSource.indexOf('async function handle(action,p){'), mainSource.indexOf('\nasync function start(){'));
function mainHarness(initial = bound()) {
  const account = { settings: structuredClone(initial.settings) }, calls = { secrets: 0, vault: [], settings: 0, summary: [], confirm: 0, reset: 0, invalidates: 0 };
  const aiPreviews = new AiPreviewStore(), owner = 'account-A:epoch-1';
  let privateData = structuredClone(initial.credentials);
  const context = vm.createContext({
    activeId: 'account-A', busy: false, cleanupBusy: () => false, activeAi: null, account: () => account,
    aiPreviews, aiOwner: () => owner, AbortController, crypto: require('node:crypto'),
    checkAiOperation: operation => { assert.equal(operation.owner, owner); assert.equal(operation.controller.signal.aborted, false); },
    secrets: id => { assert.equal(id, 'account-A'); calls.secrets++; return structuredClone(privateData); },
    vault: { write: (id, value) => { assert.equal(id, 'account-A'); calls.vault.push(structuredClone(value)); privateData = structuredClone(value); } },
    store: { update: (id, fn) => { assert.equal(id, 'account-A'); calls.settings++; fn(account); } },
    snapshot: () => ({ settings: structuredClone(account.settings), credentials: { ai: !!privateData.aiKey, notion: !!privateData.notionToken } }),
    listAiProviders, prepareAiSettingsSave, prepareLegacyAiSettingsSave, assertAiKeyScope, prepareAiRequest,
    summaryFor: () => ({ messages: [{ text: 'mock' }], chunks: [{}] }), net: { fetch: () => { throw new Error('network forbidden'); } },
    aiSummary: async (_pre, options) => { calls.summary.push(options); return { id: 'mock-summary' }; },
    confirmSend: async () => { calls.confirm++; }, saveSummary: (id, value) => { assert.equal(id, 'account-A'); return value; },
    win: {}, dialog: { showMessageBox: async () => { calls.reset++; return { response: 1 }; } },
    sessionRegistry: { invalidate: () => { calls.invalidates++; } },
  });
  vm.runInContext(`${handleSource}\nglobalThis.handle = handle;`, context);
  return {
    context, calls, account, handle: context.handle, credentials: () => privateData,
    prepareToken: () => aiPreviews.put({
      owner, settings: account.settings, prepared: { messages: [{ text: 'mock' }], chunks: [{}] },
      profile: prepareAiRequest(account.settings),
    }),
  };
}

test('main provider listing has zero credentials/network activity; AI save returns snapshot without keys', async () => {
  const h = mainHarness();
  const providers = await h.handle('ai.providers', {}); assert.equal(providers.length, 9);
  assert.equal(h.calls.secrets, 0); assert.equal(h.calls.vault.length, 0);
  const result = await h.handle('settings.ai.save', { ...save(), accountId: 'other-account' });
  assert.equal(result.settings.aiProviderId, 'openai'); assert.equal(result.credentials.ai, true);
  assert.ok(!JSON.stringify(result).includes('new-mock-key')); assert.ok(!JSON.stringify(result).includes('aiKeyScope'));
  assert.equal(h.calls.vault.length, 1); assert.equal(h.calls.confirm, 0); assert.equal(h.calls.summary.length, 0);
  h.context.busy = true;
  await assert.rejects(h.handle('settings.ai.save', save()), /操作正在进行/);
});

test('main Notion-only save preserves bound AI; old full payload changed endpoint is rejected before writes', async () => {
  const h = mainHarness(), before = h.credentials();
  await h.handle('settings.save', { notionToken: 'new-notion-only' });
  assert.deepEqual(h.credentials().aiKeyScope, before.aiKeyScope); assert.equal(h.credentials().aiKey, before.aiKey);
  assert.equal(h.account.settings.endpoint, 'https://api.openai.com/v1');
  const writes = h.calls.vault.length;
  await assert.rejects(h.handle('settings.save', { endpoint: 'https://other.invalid/v1', model: 'model', aiKey: '', accountId: 'other' }), /改变/);
  assert.equal(h.calls.vault.length, writes); assert.equal(h.context.busy, false);
});

test('main delete and explicit unreadable reset remove binding and never retain hidden old keys', async () => {
  const h = mainHarness();
  await h.handle('settings.save', { deleteSecrets: true, aiKey: 'must-not-be-saved', notionToken: 'must-not-be-saved' });
  assert.equal(h.credentials().aiKey, undefined); assert.equal(h.credentials().aiKeyScope, undefined); assert.equal(h.credentials().notionToken, undefined);
  assert.ok(h.credentials().cookies.length);
  const r = mainHarness();
  r.context.secrets = () => { throw new Error('credentials unavailable'); };
  await r.handle('settings.save', { resetUnreadable: true, notionToken: 'new-notion-only' });
  assert.equal(r.credentials().aiKey, undefined); assert.equal(r.credentials().aiKeyScope, undefined); assert.equal(r.credentials().cookies, undefined);
  assert.equal(r.calls.reset, 1); assert.equal(r.calls.invalidates, 1); assert.equal(r.credentials().notionToken, 'new-notion-only');
  assert.equal(r.account.settings.endpoint, 'https://api.openai.com/v1');
});

test('main summary refuses mismatched key binding before confirmation, allows untouched legacy key without writing it', async () => {
  const current = bound();
  const bad = mainHarness({ settings: { ...current.settings, endpoint: 'https://other.invalid/v1' }, credentials: current.credentials });
  await assert.rejects(bad.handle('summary.ai', {}), /不匹配/);
  assert.equal(bad.calls.confirm, 0); assert.equal(bad.calls.summary.length, 0); assert.equal(bad.calls.vault.length, 0);
  const legacy = mainHarness({ settings: oldSettings(), credentials: secrets() });
  await legacy.handle('summary.ai', { previewId: legacy.prepareToken(), confirmed: true });
  assert.equal(legacy.calls.confirm, 1); assert.equal(legacy.calls.summary.length, 1); assert.equal(legacy.calls.vault.length, 0);
  assert.equal(legacy.credentials().aiKeyScope, undefined);
});
