'use strict';

const { validateEndpoint, completionEndpoint, prepareAiRequest, inspectAiVision } = require('./summary.cjs');

// These are destination presets, not model suggestions or connectivity checks.
// Other regions and plans must use an explicitly entered custom destination.
const PROVIDERS = Object.freeze([
  { id: 'openai', name: 'OpenAI', endpoint: 'https://api.openai.com/v1', notice: '使用 OpenAI API 项目的 Key，并确认所在地在官方支持地区内。模型填写 API ID。' },
  { id: 'deepseek', name: 'DeepSeek', endpoint: 'https://api.deepseek.com/chat/completions', notice: '使用 DeepSeek 开放平台 API Key；此处为官方完整 Chat Completions 地址。' },
  { id: 'kimi', name: 'Kimi', endpoint: 'https://api.moonshot.cn/v1', notice: '中国站开放平台。中国站、国际站及 Kimi Code 的 Key 不互通；国际站请选择自定义并填写对应地址。' },
  { id: 'zhipu', name: '智谱', endpoint: 'https://open.bigmodel.cn/api/paas/v4', notice: '使用标准开放平台 API Key；此地址不是 Coding Plan 或 Responses 接口。' },
  { id: 'minimax', name: 'MiniMax', endpoint: 'https://api.minimax.cn/v1', notice: '中国站标准 API。国际站或其他套餐请使用自定义地址，并使用该平台对应的 Key。' },
  { id: 'hunyuan', name: '混元', endpoint: 'https://api.hunyuan.cloud.tencent.com/v1', notice: '现有混元兼容服务，使用专用 API Key，不是 SecretId/SecretKey。TokenHub 用户请按控制台地址选择自定义。' },
  { id: 'qwen', name: '千问', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1', notice: '北京地域兼容接口。Key 须与地域匹配；新工作空间专属域名或其他地域请从控制台复制到自定义地址。' },
  { id: 'xiaomi', name: '小米', endpoint: 'https://api.xiaomimimo.com/v1', notice: 'MiMo 按量付费 API。Token Plan 使用独立地址和 Key，请按套餐说明选择自定义。' },
  { id: 'custom', name: '自定义', endpoint: '', custom: true, notice: '填写兼容 Chat Completions 的基础地址或完整接口。变更厂商或实际请求地址后，需要重新输入对应 Key。' },
].map(value => Object.freeze(value)));
const BY_ID = new Map(PROVIDERS.map(value => [value.id, value]));
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function listAiProviders() { return PROVIDERS.map(value => ({ ...value })); }

function providerId(settings) {
  const id = settings.aiProviderId === undefined ? 'custom' : settings.aiProviderId;
  if (typeof id !== 'string' || !BY_ID.has(id)) throw new Error('AI 厂商无效，请重新配置。');
  return id;
}

function scopeFor(settings) {
  return { providerId: providerId(settings), endpoint: completionEndpoint(settings.endpoint) };
}

function sameScope(a, b) {
  return !!a && !!b && a.providerId === b.providerId && a.endpoint === b.endpoint;
}

function validKey(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192 || /[\r\n\u0000]/.test(value)) throw new Error('请填写有效的 AI API Key。');
  return value.trim();
}

function assertAiKeyScope(settings, credentials) {
  if (!credentials || !credentials.aiKey) throw new Error('请先在设置中保存 AI Key。');
  const key = validKey(credentials.aiKey);
  // Legacy keys keep their previous behavior until the user explicitly saves.
  // Nothing binds or rewrites credentials merely by opening or running the app.
  if (credentials.aiKeyScope !== undefined && !sameScope(credentials.aiKeyScope, scopeFor(settings))) {
    throw new Error('已保存的 AI Key 与当前厂商或请求地址不匹配，请重新配置并输入对应 Key。');
  }
  return key;
}

function prepareAiSettingsSave(currentSettings, credentials, payload, { allowMissingKey = false } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.providerId !== 'string' || !BY_ID.has(payload.providerId)) throw new Error('请选择有效的 AI 厂商。');
  const provider = BY_ID.get(payload.providerId);
  if (typeof payload.endpoint !== 'string' || typeof payload.model !== 'string') throw new Error('请填写 AI 地址和模型 API ID。');
  const endpoint = validateEndpoint(payload.endpoint.trim()), model = payload.model.trim();
  if (!provider.custom && completionEndpoint(endpoint) !== completionEndpoint(provider.endpoint)) throw new Error('预设厂商地址不可修改；其他地区或服务请使用自定义。');
  const settings = { ...currentSettings, endpoint: provider.custom ? endpoint : provider.endpoint, model, aiProviderId: provider.id };
  prepareAiRequest(settings);
  let unchangedModelScope = false;
  try { unchangedModelScope = sameScope(scopeFor(currentSettings), scopeFor(settings)) && currentSettings.model?.trim() === model; } catch {}
  // A capability declaration belongs to this exact service/model selection.
  // Legacy callers which change either must not silently inherit "enabled".
  settings.aiVisionMode = own(payload, 'aiVisionMode') ? payload.aiVisionMode : unchangedModelScope ? currentSettings.aiVisionMode || 'auto' : 'auto';
  inspectAiVision(settings);
  if (!['keep', 'replace'].includes(payload.keyAction)) throw new Error('请选择保留现有 Key 或输入新 Key。');
  const next = { ...credentials }, scope = scopeFor(settings);
  if (payload.keyAction === 'replace') {
    next.aiKey = validKey(payload.aiKey);
  } else {
    if (payload.aiKey !== undefined && payload.aiKey !== '') throw new Error('保留现有 Key 时不能同时提交新 Key。');
    if (!next.aiKey && allowMissingKey) {
      delete next.aiKeyScope;
      return { settings, credentials: next };
    }
    if (!next.aiKey) throw new Error('没有可保留的 AI Key，请输入新 Key。');
    let currentScope;
    try { currentScope = scopeFor(currentSettings); } catch { /* invalid old destination cannot retain a key */ }
    if (!sameScope(currentScope, scope)) throw new Error('AI 厂商或请求地址已改变，请重新输入对应的 API Key，不能沿用旧 Key。');
    assertAiKeyScope(currentSettings, next);
  }
  next.aiKeyScope = scope;
  return { settings, credentials: next };
}

// Keep old settings.save callers compatible without letting them bypass the
// same destination/key checks used by the dedicated AI editor.
function prepareLegacyAiSettingsSave(currentSettings, credentials, payload, options) {
  if (!['endpoint', 'model', 'aiKey', 'aiVisionMode'].some(field => own(payload, field))) return { settings: { ...currentSettings }, credentials: { ...credentials } };
  const endpoint = own(payload, 'endpoint') ? payload.endpoint : currentSettings.endpoint || '';
  const model = own(payload, 'model') ? payload.model : currentSettings.model || '';
  if (typeof endpoint !== 'string' || typeof model !== 'string' || (own(payload, 'aiKey') && typeof payload.aiKey !== 'string')) throw new Error('AI 设置格式无效。');
  const nextEndpoint = endpoint.trim(), nextModel = model.trim(), newKey = payload.aiKey?.trim() || '';
  if (!nextEndpoint && !nextModel && !newKey && !credentials.aiKey) {
    const next = { ...credentials }; delete next.aiKeyScope;
    if (own(payload, 'aiVisionMode') && !['auto', 'enabled', 'disabled'].includes(payload.aiVisionMode)) throw new Error('图片理解设置无效。');
    return { settings: { ...currentSettings, endpoint: '', model: '', aiProviderId: 'custom', aiVisionMode: 'auto' }, credentials: next };
  }
  let sameDestination = false;
  try { sameDestination = completionEndpoint(nextEndpoint) === completionEndpoint(currentSettings.endpoint); } catch {}
  return prepareAiSettingsSave(currentSettings, credentials, {
    providerId: sameDestination ? providerId(currentSettings) : 'custom',
    endpoint: nextEndpoint, model: nextModel, keyAction: newKey ? 'replace' : 'keep',
    ...(newKey ? { aiKey: newKey } : {}),
    ...(own(payload, 'aiVisionMode') ? { aiVisionMode: payload.aiVisionMode } : {}),
  }, options);
}

module.exports = { listAiProviders, prepareAiSettingsSave, prepareLegacyAiSettingsSave, assertAiKeyScope, scopeFor };
