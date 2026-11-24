'use strict';

const { randomBytes, createHash } = require('node:crypto');
const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 32;
const fingerprint = summary => createHash('sha256').update(JSON.stringify(summary)).digest('hex');

class SummaryDeletePreviewStore {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.entries = new Map();
  }
  clear() { this.entries.clear(); }
  prune() {
    const now = this.now();
    for (const [token, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(token);
  }
  create(selection, epoch, summary) {
    this.prune();
    while (this.entries.size >= MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value);
    const token = randomBytes(32).toString('hex');
    this.entries.set(token, { ...selection, epoch, fingerprint: fingerprint(summary), expiresAt: this.now() + TTL_MS });
    return token;
  }
  take(selection, epoch, token, confirmed) {
    if (confirmed !== true || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
      throw new Error('请重新打开删除确认并确认所选摘要。');
    }
    const entry = this.entries.get(token);
    this.entries.delete(token);
    this.prune();
    if (!entry || entry.expiresAt <= this.now()) throw new Error('删除确认已失效，请重新打开确认后再试。');
    if (entry.epoch !== epoch || ['accountId', 'summaryId', 'groupId'].some(key => entry[key] !== selection[key])) {
      throw new Error('当前账号或摘要已变化，请重新打开删除确认。');
    }
    return entry.fingerprint;
  }
}

module.exports = { SummaryDeletePreviewStore, fingerprint, TTL_MS, MAX_ENTRIES };
