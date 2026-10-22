'use strict';

// These are local scheduling bounds, not a claim about Weibo's service limits.
// Failure backoff and server cooldowns remain owned by AutoSync separately.
const AUTOMATIC_INTERVAL_MS = 5000;
const BACKGROUND_HEAD_INTERVAL_MS = 60000;
const UNRESOLVED_RETRY_INTERVAL_MS = 60000;
const AUTOMATIC_TIME_BUDGET_MS = 8000;
const AUTOMATIC_DEADLINE_MS = 20000;
const AUTOMATIC_MAX_PAGES = 8;
const AUTOMATIC_HEAD_EVERY_PAGES = 4;
const MAX_BACKGROUND_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_DATE_MS = 8640000000000000;

function stableId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

function pendingRanges(group) {
  // An explicitly empty canonical list supersedes a stale legacy view.
  const ranges = Array.isArray(group.latestPendingRanges) ? group.latestPendingRanges :
    group.latestPending && typeof group.latestPending === 'object' ? [group.latestPending] : [];
  return ranges.filter(range => range && typeof range === 'object' && !Array.isArray(range));
}

class RefreshPlan {
  constructor({now = Date.now, backgroundIntervalMs = BACKGROUND_HEAD_INTERVAL_MS} = {}) {
    if (typeof now !== 'function') throw new TypeError('自动刷新计划需要有效时钟。');
    if (!Number.isSafeInteger(backgroundIntervalMs) || backgroundIntervalMs < BACKGROUND_HEAD_INTERVAL_MS ||
      backgroundIntervalMs > MAX_BACKGROUND_INTERVAL_MS) {
      throw new TypeError('后台群刷新间隔须为 60 秒至 24 小时之间的整数毫秒数。');
    }
    this.now = now;
    this.backgroundIntervalMs = backgroundIntervalMs;
    this.lastHeadAt = new Map();
    this.lastUnresolvedAt = new Map();
    this.lastObservedAt = null;
  }

  time() {
    const current = this.now();
    if (!Number.isSafeInteger(current) || current < 0 || current > MAX_DATE_MS) {
      throw new TypeError('自动刷新计划时钟无效。');
    }
    // Wall-clock rollback cannot bring a background request forward. Once the
    // clock catches up, ordinary 60-second scheduling resumes. Foreground heads
    // remain eligible; this planner never changes AutoSync's timer or cooldown.
    this.lastObservedAt = Math.max(current, this.lastObservedAt ?? current);
    return this.lastObservedAt;
  }

  recordHead(groupId) {
    if (!stableId(groupId)) throw new TypeError('自动刷新群标识无效。');
    const completedAt = this.time();
    this.lastHeadAt.set(groupId, completedAt);
    return completedAt;
  }

  // Call only after a successful persisted retry of a range that was already
  // unresolved when dispatched (onChange.retriedUnresolved === true). Ordinary
  // pending-page completions must not postpone an older unresolved interval.
  // Failed requests are handled by AutoSync and do not call this method.
  recordUnresolvedAttempt(groupId) {
    if (!stableId(groupId)) throw new TypeError('自动补扫群标识无效。');
    const completedAt = this.time();
    this.lastUnresolvedAt.set(groupId, completedAt);
    return completedAt;
  }

  plan(groups, preferredGroupId) {
    if (!Array.isArray(groups)) throw new TypeError('自动刷新群列表无效。');
    const time = this.time(), selected = [], seen = new Set();
    for (const group of groups) {
      if (!group || group.selected !== true || !stableId(group.id) || seen.has(group.id)) continue;
      seen.add(group.id);
      selected.push(group);
    }
    const preferred = stableId(preferredGroupId) && seen.has(preferredGroupId) ? preferredGroupId : null;
    const due = selected.filter(group => group.id !== preferred &&
      (!this.lastHeadAt.has(group.id) || time - this.lastHeadAt.get(group.id) >= this.backgroundIntervalMs));
    // Stable sort preserves the caller's order for equally old/unseen groups.
    // The service owns page fairness and the shared request budget afterwards.
    due.sort((a, b) => (this.lastHeadAt.get(a.id) ?? -1) - (this.lastHeadAt.get(b.id) ?? -1));
    const headGroupIds = [...(preferred ? [preferred] : []), ...due.map(group => group.id)];
    // Previously unresolved ranges must not be probed every foreground tick.
    // This separate completion clock only records retries of those ranges:
    // neither frequent heads nor ordinary pending pages postpone their turn.
    const unresolvedDue = selected.filter(group => pendingRanges(group).some(range => range.status === 'unresolved') &&
      (!this.lastUnresolvedAt.has(group.id) || time - this.lastUnresolvedAt.get(group.id) >= UNRESOLVED_RETRY_INTERVAL_MS));
    unresolvedDue.sort((a, b) => (this.lastUnresolvedAt.get(a.id) ?? -1) - (this.lastUnresolvedAt.get(b.id) ?? -1));
    const retryUnresolvedGroupIds = unresolvedDue.map(group => group.id);
    // nextCursor alone only permits explicitly requested older history; it is
    // not evidence of an automatic latest-message gap or initial continuation.
    return {headGroupIds, retryUnresolvedGroupIds, hasWork: headGroupIds.length > 0 ||
      retryUnresolvedGroupIds.length > 0 || selected.some(group => pendingRanges(group).some(range => range.status !== 'unresolved'))};
  }
}

module.exports = {RefreshPlan, AUTOMATIC_INTERVAL_MS, BACKGROUND_HEAD_INTERVAL_MS, UNRESOLVED_RETRY_INTERVAL_MS,
  AUTOMATIC_TIME_BUDGET_MS, AUTOMATIC_DEADLINE_MS, AUTOMATIC_MAX_PAGES, AUTOMATIC_HEAD_EVERY_PAGES};
