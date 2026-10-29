'use strict';

// Successful refreshes may run frequently. Failure/rate-limit waits are a
// separate policy and must never shrink with the normal refresh interval.
const MIN_INTERVAL_MS = 5000;
const FAILURE_BASE_MS = 60000;
const RATE_LIMIT_MIN_MS = 60000;
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;
const BUSY_DELAY_MS = 5000;
const MAX_BACKOFF_MS = 15 * 60 * 1000;
const MAX_TIMER_MS = 2147483647;
const MAX_DATE_MS = 8640000000000000;

const STOP_MESSAGES = Object.freeze({
  AUTH_REQUIRED: '微博登录已失效，自动更新已暂停。请在官方页面重新登录，成功后将按原设置恢复。',
  ACCESS_DENIED: '微博拒绝访问，自动更新已暂停。请在官方页面确认权限或验证提示后手动恢复。',
  API_REJECTED: '微博拒绝读取，自动更新已暂停。请在官方页面确认权限或风控提示后手动恢复。',
  RISK_CONTROL: '微博要求验证，自动更新已暂停。请在官方页面完成验证后手动恢复。',
  RISK_REQUIRED: '微博要求验证，自动更新已暂停。请在官方页面完成验证后手动恢复。',
  ACCOUNT_MISMATCH: '微博登录身份发生变化，自动更新已暂停。请确认当前账号后手动恢复。',
  PAGE_SOURCE_REJECTED: '微博未接受页面来源，自动更新已暂停。请更新应用或重新打开官方登录页后手动恢复。',
  UNSAFE_ENDPOINT: '同步地址未获允许，自动更新已暂停。请检查应用后手动恢复。',
  UNSAFE_REDIRECT: '同步响应地址发生变化，自动更新已暂停。请检查应用后手动恢复。',
  INVALID_RESPONSE: '微博响应格式无法确认，自动更新已暂停。请手动检查同步后再恢复。',
  CURSOR_IGNORED: '微博历史游标未生效，自动更新已暂停。请手动检查同步后再恢复。',
  HTTP_ERROR: '微博未接受读取请求，自动更新已暂停。请在官方页面检查状态后手动恢复。',
});
const SAFE_ERROR_CODES = new Set([...Object.keys(STOP_MESSAGES),
  'RATE_LIMIT', 'TIMEOUT', 'SERVER_ERROR', 'ABORTED', 'NETWORK', 'GENERIC']);

function safeErrorCode(code) {
  return code === '' ? '' : typeof code === 'string' && SAFE_ERROR_CODES.has(code) ? code : 'GENERIC';
}

function validInterval(value) {
  if (!Number.isSafeInteger(value) || value < MIN_INTERVAL_MS || value > MAX_INTERVAL_MS) {
    throw new TypeError('自动更新间隔须为 5 秒至 24 小时之间的整数毫秒数。');
  }
  return value;
}

function secondsDelay(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const text = String(value).trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  return Math.ceil(Number(text) * 1000);
}

function retryDelay(error, now) {
  const candidates = [];
  if (typeof error?.retryAfterMs === 'number' && error.retryAfterMs >= 0) candidates.push(Math.ceil(error.retryAfterMs));
  const seconds = secondsDelay(error?.retryAfterSeconds);
  if (seconds !== null) candidates.push(seconds);
  const header = error?.retryAfter;
  const numeric = secondsDelay(header);
  if (numeric !== null) candidates.push(numeric);
  else if (typeof header === 'string' && header.trim()) {
    const date = Date.parse(header);
    if (Number.isFinite(date)) candidates.push(Math.max(0, date - now));
  }
  return candidates.length ? Math.max(...candidates) : 0;
}

// Never forward server text, transport errors, tokens, URLs or message content
// through the status channel. Even known error codes receive fixed local copy.
function classify(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (Object.prototype.hasOwnProperty.call(STOP_MESSAGES, code)) return { kind: 'stop', code, message: STOP_MESSAGES[code] };
  for (const [status, safeCode] of [[401, 'AUTH_REQUIRED'], [403, 'ACCESS_DENIED']]) {
    if (error?.status === status || error?.statusCode === status) return { kind: 'stop', code: safeCode, message: STOP_MESSAGES[safeCode] };
  }
  if (code === 'BUSY' || code === 'SYNC_BUSY') return { kind: 'busy' };
  if (code === 'RATE_LIMIT' || error?.status === 429 || error?.statusCode === 429) {
    return { kind: 'rate', code: 'RATE_LIMIT', message: '微博暂时限流，自动更新将遵守服务器要求的等待时间。' };
  }
  if (code === 'TIMEOUT') return { kind: 'retry', code, message: '微博读取超时，将稍后自动重试。' };
  if (code === 'SERVER_ERROR') return { kind: 'retry', code, message: '微博服务暂时不可用，将稍后自动重试。' };
  if (code === 'ABORTED') return { kind: 'retry', code, message: '本次自动更新已取消，将稍后重试。' };
  return { kind: 'retry', code: code === 'NETWORK' ? code : 'GENERIC', message: '自动更新未完成，请检查网络；程序将稍后重试。' };
}

class AutoSync {
  constructor({ run, isBusy = () => false, isEligible = () => true, onChange = () => {},
    now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, intervalMs = MIN_INTERVAL_MS } = {}) {
    for (const callback of [run, isBusy, isEligible, onChange, now, setTimer, clearTimer]) {
      if (typeof callback !== 'function') throw new TypeError('自动更新控制器需要有效的回调函数。');
    }
    this.run = run; this.isBusy = isBusy; this.isEligible = isEligible; this.onChange = onChange;
    this.now = now; this.setTimer = setTimer; this.clearTimer = clearTimer;
    this.intervalMs = validInterval(intervalMs);
    this.enabled = false; this.started = false; this.running = false;
    this.lastSuccessAt = null; this.nextRunAt = null; this.error = ''; this.errorCode = '';
    this.blocked = ''; this.holdReason = ''; this.cooldownUntil = 0;
    this.failures = 0; this.generation = 0; this.timer = null;
    this.policyErrors = new WeakSet();
  }

  status() {
    return { enabled: this.enabled, intervalMs: this.intervalMs, running: this.running,
      lastSuccessAt: this.lastSuccessAt, nextRunAt: this.nextRunAt, error: this.error,
      blocked: Boolean(this.blocked), errorCode: safeErrorCode(this.errorCode),
      pausedReason: !this.enabled ? '自动更新未启用。' : !this.started ? '自动更新已停止。' : this.blocked || this.holdReason };
  }

  emit() { try { this.onChange(this.status()); } catch { /* UI observers cannot stop or repeat synchronization. */ } }
  clear() { if (this.timer !== null) this.clearTimer(this.timer); this.timer = null; this.nextRunAt = null; }
  active() { return this.started && this.enabled && !this.blocked; }

  // The same account policy also applies to manual synchronization while the
  // automatic timer is stopped or disabled. This is a guard, not a new failure.
  assertAllowed() {
    const time = this.now(); let error;
    if (this.blocked) {
      error = Object.assign(new Error(this.blocked), { code: safeErrorCode(this.errorCode) || 'GENERIC' });
    } else if (this.cooldownUntil > time) {
      error = Object.assign(new Error('微博要求等待后再同步，请在冷却结束后重试。'),
        { code: 'RATE_LIMIT', retryAfterMs: this.cooldownUntil - time });
    }
    if (error) { this.policyErrors.add(error); throw error; }
    return true;
  }

  // Only a manual request's owner calls this. Automatic requests already call
  // failed() in wake(); recording the same request in both places is incorrect.
  recordFailure(error) {
    if (!this.policyErrors.has(error)) this.failed(error);
    return this.status();
  }

  // Explicit user enabling also resumes a recoverable security pause.
  // A server cooldown survives pause/resume and cannot be shortened this way.
  configure(options = {}) {
    const { enabled = this.enabled, intervalMs: requestedInterval = this.intervalMs } = options;
    if (typeof enabled !== 'boolean') throw new TypeError('自动更新开关必须是布尔值。');
    const intervalMs = validInterval(requestedInterval);
    this.clear(); this.generation++; this.enabled = enabled; this.intervalMs = intervalMs;
    this.holdReason = '';
    if (Object.prototype.hasOwnProperty.call(options, 'enabled') && enabled) {
      this.failures = 0; this.error = ''; this.blocked = '';
      this.errorCode = this.cooldownUntil > this.now() ? 'RATE_LIMIT' : '';
    }
    if (!Number.isFinite(this.cooldownUntil)) this.blocked = '微博要求的等待时间超出可安全计时范围，自动更新已暂停。';
    this.plan(this.intervalMs);
    return this.status();
  }

  // A successfully verified login proves only authentication recovery. It is
  // not a general security reset, and must not change a user's saved switch or
  // discard a server cooldown. Repeated successful login is idempotent when
  // neither this narrow block nor the persisted preference needs changing.
  authenticationRestored({ enabled = this.enabled } = {}) {
    if (typeof enabled !== 'boolean') throw new TypeError('自动更新开关必须是布尔值。');
    const recovered = !!this.blocked && this.errorCode === 'AUTH_REQUIRED';
    if (!recovered && this.enabled === enabled) return this.status();
    this.clear(); this.generation++; this.enabled = enabled;
    if (recovered) {
      this.error = ''; this.blocked = ''; this.failures = 0; this.holdReason = '';
      this.errorCode = this.cooldownUntil > this.now() ? 'RATE_LIMIT' : '';
    }
    this.plan(this.intervalMs);
    return this.status();
  }

  start() {
    if (this.started) return this.status();
    this.started = true;
    this.plan(this.intervalMs);
    return this.status();
  }

  // Stopping only controls future runs. An already-started run remains occupied
  // until it settles; its caller owns cancellation and the shared business lock.
  stop() {
    this.started = false; this.generation++; this.clear(); this.emit();
    return this.status();
  }

  plan(delay, reason = '') {
    this.clear(); this.holdReason = reason;
    if (!Number.isFinite(this.cooldownUntil) || this.cooldownUntil > MAX_DATE_MS) {
      this.blocked = '微博要求的等待时间超出可安全计时范围，自动更新已暂停。';
      this.errorCode = 'RATE_LIMIT'; this.cooldownUntil = Infinity; this.emit(); return;
    }
    if (!this.active()) { this.emit(); return; }
    try {
      if (this.isEligible() !== true) this.holdReason = '等待已登录的微博账号和已选择的群聊。';
    } catch { this.holdReason = '暂时无法确认同步条件，稍后会再次检查。'; }
    const time = this.now();
    const due = Math.max(time + delay, this.cooldownUntil);
    if (!Number.isFinite(due) || due > MAX_DATE_MS) {
      this.blocked = '微博要求的等待时间超出可安全计时范围，自动更新已暂停。';
      this.errorCode = 'RATE_LIMIT';
      this.cooldownUntil = Infinity; this.emit(); return;
    }
    if (this.cooldownUntil > time + delay && !this.holdReason) this.holdReason = '正在遵守微博要求的限流等待时间。';
    this.nextRunAt = due; this.arm(due); this.emit();
  }

  arm(due) {
    const generation = this.generation;
    this.timer = this.setTimer(() => {
      if (generation !== this.generation || this.nextRunAt !== due) return;
      this.timer = null;
      void this.wake(due);
    }, Math.min(MAX_TIMER_MS, Math.max(0, due - this.now())));
  }

  async wake(due) {
    if (!this.active() || this.nextRunAt !== due) return;
    if (this.now() < due) { this.arm(due); return; } // Long timers and backward clock changes.
    this.nextRunAt = null;
    const generation = this.generation;
    try {
      if (this.isEligible() !== true) { this.plan(this.intervalMs, '等待已登录的微博账号和已选择的群聊。'); return; }
      if (this.running || this.isBusy()) { this.plan(BUSY_DELAY_MS, '正在等待当前操作完成。'); return; }
    } catch (error) { this.failed(error); return; }
    this.running = true; this.holdReason = ''; this.emit();
    if (generation !== this.generation || !this.active()) { this.running = false; this.emit(); return; }
    let error, succeeded = false;
    try { await this.run(); succeeded = true; }
    catch (failure) { error = failure; }
    this.running = false;
    if (generation !== this.generation || !this.active()) {
      // The controller belongs to one account for its whole lifetime. Discard
      // stale display results, but a response received after pause/resume still
      // imposes that account's server cooldown or security stop.
      if (!succeeded) {
        const failure = classify(error);
        if (failure.kind === 'stop') {
          this.error = failure.message; this.errorCode = failure.code; this.blocked = failure.message; this.clear(); this.emit(); return;
        }
        if (failure.kind === 'rate') {
          this.error = failure.message; this.errorCode = failure.code;
          this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + Math.max(RATE_LIMIT_MIN_MS, retryDelay(error, this.now())));
          this.plan(this.intervalMs, '正在遵守微博要求的限流等待时间。'); return;
        }
      }
      // A configure/start during the request may have armed a timer using the
      // configuration time. Replace it after settlement so a late success
      // cannot run again immediately, and transient failures retain backoff.
      // A stopped/disabled controller must remain stopped; only its security
      // failures and server cooldowns above survive the inactive generation.
      if (this.active()) {
        if (succeeded) this.plan(this.intervalMs);
        else this.failed(error);
      } else this.emit();
      return;
    }
    if (succeeded) {
      this.lastSuccessAt = this.now(); this.error = ''; this.errorCode = ''; this.failures = 0; this.cooldownUntil = 0;
      this.plan(this.intervalMs);
    } else this.failed(error);
  }

  failed(error) {
    if (this.policyErrors.has(error)) {
      this.plan(Math.max(0, this.cooldownUntil - this.now())); return;
    }
    const failure = classify(error);
    if (failure.kind === 'busy') { this.plan(BUSY_DELAY_MS, '正在等待当前操作完成。'); return; }
    this.error = failure.message; this.errorCode = failure.code;
    if (failure.kind === 'stop') {
      this.blocked = failure.message; this.clear(); this.emit(); return;
    }
    this.failures++;
    let delay = Math.min(MAX_BACKOFF_MS, FAILURE_BASE_MS * 2 ** Math.min(this.failures - 1, 10));
    if (failure.kind === 'rate') {
      delay = Math.max(delay, RATE_LIMIT_MIN_MS, retryDelay(error, this.now()));
      this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + delay);
    }
    this.plan(delay, failure.kind === 'rate' ? '正在遵守微博要求的限流等待时间。' : '等待下次自动重试。');
  }
}

module.exports = { AutoSync, MIN_INTERVAL_MS, MAX_INTERVAL_MS, BUSY_DELAY_MS, MAX_BACKOFF_MS, FAILURE_BASE_MS, RATE_LIMIT_MIN_MS };
