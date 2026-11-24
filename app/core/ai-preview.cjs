'use strict';
const crypto = require('node:crypto');

function profileKey(settings = {}) {
  return JSON.stringify({
    endpoint: settings.endpoint || '', model: settings.model || '',
    aiProviderId: settings.aiProviderId || '', aiVisionMode: settings.aiVisionMode || 'auto',
  });
}

// Release the caller immediately even when a native operation cannot abort.
// Keep both outcome handlers attached so late failures are still consumed.
function waitForAiOperation(promise, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (complete, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      complete(value);
    };
    const onAbort = () => finish(reject, new Error('本次 AI 操作已取消。'));
    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

// Prepared bodies and image bytes remain in main-process memory. A consent
// token is bound to one account epoch, one configuration, and one attempt.
class AiPreviewStore {
  constructor({ now = Date.now, ttlMs = 5 * 60 * 1000 } = {}) {
    this.now = now; this.ttlMs = ttlMs; this.value = null;
  }
  put({ owner, settings, prepared, profile }) {
    const token = crypto.randomUUID();
    this.value = { token, owner, profileKey: profileKey(settings), prepared, profile, expires: this.now() + this.ttlMs };
    return token;
  }
  clear(token) {
    if (!token || this.value?.token === token) this.value = null;
  }
  take({ token, owner, settings, confirmed }) {
    if (confirmed !== true) throw new Error('请先明确确认本次 AI 发送范围。');
    const value = this.value;
    if (!value || value.token !== token) throw new Error('待发送内容已失效，请重新准备并核对发送范围。');
    this.value = null;
    if (value.owner !== owner || value.profileKey !== profileKey(settings) || value.expires <= this.now()) {
      throw new Error('账号、模型配置或待发送内容已变化，请重新准备并确认。');
    }
    return value;
  }
}

module.exports = { AiPreviewStore, profileKey, waitForAiOperation };
