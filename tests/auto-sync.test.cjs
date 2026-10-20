'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AutoSync, MIN_INTERVAL_MS, BUSY_DELAY_MS, MAX_BACKOFF_MS } = require('../app/core/auto-sync.cjs');

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
class Clock {
  constructor() { this.time = 1700000000000; this.sequence = 0; this.timers = new Map(); this.delays = []; }
  now = () => this.time;
  setTimer = (fn, delay) => { const id = ++this.sequence; this.timers.set(id, { at: this.time + delay, fn }); this.delays.push(delay); return id; };
  clearTimer = id => { this.timers.delete(id); };
  async advance(ms) {
    const end = this.time + ms;
    for (let count = 0; ; count++) {
      if (count > 10000) throw new Error('runaway fake timer');
      const next = [...this.timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.time = next[1].at; this.timers.delete(next[0]); next[1].fn(); await flush();
    }
    this.time = end; await flush();
  }
}
function fixture(options = {}) {
  const clock = new Clock(), changes = [];
  let calls = 0;
  const run = options.run || (async () => { calls++; return { count: 3 }; });
  const controller = new AutoSync({ run, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    onChange: status => changes.push(status), ...options });
  return { clock, controller, changes, calls: () => calls };
}
function enable(controller) { controller.configure({ enabled: true }); controller.start(); }
const failed = (code, properties = {}) => Object.assign(new Error('Cookie=secret-sentinel https://private.invalid Authorization: test'), { code, ...properties });

test('disabled by default; first update waits a full interval, and success repeats from completion', async () => {
  const f = fixture();
  assert.equal(f.controller.status().enabled, false);
  f.controller.start(); await f.clock.advance(120000); assert.equal(f.calls(), 0);
  f.controller.configure({ enabled: true }); const due = f.clock.time + 60000;
  assert.equal(f.controller.status().nextRunAt, due);
  await f.clock.advance(59999); assert.equal(f.calls(), 0);
  await f.clock.advance(1); assert.equal(f.calls(), 1);
  assert.equal(f.controller.status().lastSuccessAt, due);
  assert.equal(f.controller.status().nextRunAt, due + 60000);
  assert.equal(f.controller.status().error, '');
  await f.clock.advance(60000); assert.equal(f.calls(), 2);
});

test('configure resets countdown and start is idempotent; status is an independent safe snapshot', async () => {
  const f = fixture(); enable(f.controller); await f.clock.advance(30000);
  f.controller.configure({ enabled: true, intervalMs: 120000 });
  const due = f.clock.time + 120000;
  f.controller.start(); assert.equal(f.clock.timers.size, 1);
  const copy = f.controller.status(); copy.enabled = false;
  assert.equal(f.controller.status().enabled, true);
  await f.clock.advance(119999); assert.equal(f.calls(), 0);
  await f.clock.advance(1); assert.equal(f.calls(), 1);
  assert.equal(f.controller.status().lastSuccessAt, due);
});

test('ineligible accounts never run; eligibility changes are checked again without touching data', async () => {
  let eligible = false; const f = fixture({ isEligible: () => eligible }); enable(f.controller);
  assert.match(f.controller.status().pausedReason, /等待/);
  await f.clock.advance(180000); assert.equal(f.calls(), 0);
  eligible = true; await f.clock.advance(60000); assert.equal(f.calls(), 1);
  assert.equal(f.controller.status().pausedReason, '');
});

test('busy delays five seconds without consuming failure backoff; run-side lock contention is also honored', async () => {
  let busy = true, calls = 0;
  const f = fixture({ isBusy: () => busy, run: async () => { if (++calls === 1) throw failed('SYNC_BUSY'); } }); enable(f.controller);
  await f.clock.advance(60000); assert.equal(calls, 0);
  assert.equal(f.controller.status().nextRunAt, f.clock.time + BUSY_DELAY_MS);
  busy = false; await f.clock.advance(5000); assert.equal(calls, 1);
  assert.equal(f.controller.status().nextRunAt, f.clock.time + 5000);
  assert.equal(f.controller.status().error, '');
  await f.clock.advance(5000); assert.equal(calls, 2);
  assert.equal(f.controller.status().nextRunAt, f.clock.time + 60000);
});

test('a long run never overlaps; reconfigure while running schedules only after the previous run settles', async () => {
  const pending = deferred(); let calls = 0;
  const f = fixture({ run: async () => { calls++; if (calls === 1) await pending.promise; } }); enable(f.controller);
  await f.clock.advance(60000); assert.equal(calls, 1); assert.equal(f.controller.status().running, true);
  f.controller.configure({ enabled: true });
  await f.clock.advance(90000); assert.equal(calls, 1); assert.equal(f.controller.status().running, true);
  pending.resolve(); await flush(); assert.equal(f.controller.status().running, false);
  assert.equal(f.controller.status().lastSuccessAt, null); // Earlier configuration result was invalidated.
  await f.clock.advance(5000); assert.equal(calls, 2);
});

test('stop does not claim to cancel a running request, and its late success cannot restart scheduling', async () => {
  const pending = deferred(); let calls = 0;
  const f = fixture({ run: () => { calls++; return pending.promise; } }); enable(f.controller);
  await f.clock.advance(60000); f.controller.stop();
  assert.equal(f.controller.status().running, true); assert.equal(f.clock.timers.size, 0);
  pending.resolve(); await flush();
  assert.equal(f.controller.status().running, false); assert.equal(f.controller.status().lastSuccessAt, null);
  await f.clock.advance(600000); assert.equal(calls, 1); assert.equal(f.clock.timers.size, 0);
  f.controller.start(); assert.equal(f.controller.status().nextRunAt, f.clock.time + 60000);
});

test('failures back off from 60 seconds to 15 minutes; success resets the sequence', async () => {
  let fail = true, calls = 0;
  const f = fixture({ run: async () => { calls++; if (fail) throw failed('NETWORK'); } }); enable(f.controller);
  await f.clock.advance(60000);
  for (const expected of [60000, 120000, 240000, 480000, MAX_BACKOFF_MS, MAX_BACKOFF_MS]) {
    assert.equal(f.controller.status().nextRunAt - f.clock.time, expected);
    await f.clock.advance(expected);
  }
  assert.doesNotMatch(JSON.stringify(f.changes), /secret-sentinel|private.invalid|Authorization/);
  fail = false; await f.clock.advance(MAX_BACKOFF_MS); assert.equal(f.controller.status().error, '');
  fail = true; await f.clock.advance(60000);
  assert.equal(f.controller.status().nextRunAt - f.clock.time, MIN_INTERVAL_MS);
  assert.ok(calls > 7);
});

test('auth, access, risk and protocol safety errors pause until explicit user reconfiguration', async () => {
  for (const code of ['AUTH_REQUIRED', 'ACCESS_DENIED', 'API_REJECTED', 'RISK_CONTROL', 'ACCOUNT_MISMATCH', 'UNSAFE_REDIRECT', 'PAGE_SOURCE_REJECTED']) {
    let calls = 0, fail = true;
    const f = fixture({ run: async () => { calls++; if (fail) throw failed(code); } }); enable(f.controller);
    await f.clock.advance(60000); assert.equal(calls, 1);
    assert.equal(f.controller.status().enabled, true); assert.equal(f.controller.status().nextRunAt, null);
    assert.match(f.controller.status().pausedReason, /手动恢复/);
    assert.doesNotMatch(f.controller.status().error, /secret|private/);
    f.controller.stop(); f.controller.start(); await f.clock.advance(3600000); assert.equal(calls, 1);
    fail = false; f.controller.configure({ enabled: true });
    await f.clock.advance(59999); assert.equal(calls, 1);
    await f.clock.advance(1); assert.equal(calls, 2);
  }
});

test('429 numeric Retry-After can exceed the backoff ceiling and cannot be shortened by pause/resume', async () => {
  let calls = 0;
  const f = fixture({ run: async () => { calls++; if (calls === 1) throw failed('RATE_LIMIT', { retryAfter: '1800' }); } }); enable(f.controller);
  await f.clock.advance(60000); const due = f.clock.time + 1800000;
  assert.equal(f.controller.status().nextRunAt, due);
  await f.clock.advance(10000); f.controller.configure({ enabled: false }); f.controller.stop();
  f.controller.configure({ enabled: true }); f.controller.start();
  assert.equal(f.controller.status().nextRunAt, due);
  await f.clock.advance(due - f.clock.time - 1); assert.equal(calls, 1);
  await f.clock.advance(1); assert.equal(calls, 2); assert.equal(f.controller.status().error, '');
});

test('429 HTTP dates, explicit seconds and malformed headers retain a safe minimum wait', async () => {
  for (const variant of ['date', 'seconds', 'invalid', 'past']) {
    const f = fixture({ run: async () => {
      const properties = variant === 'date' ? { retryAfter: new Date(f.clock.time + 240000).toUTCString() }
        : variant === 'seconds' ? { retryAfterSeconds: 240 } : { retryAfter: variant === 'past' ? new Date(f.clock.time - 1000).toUTCString() : 'Cookie=secret-sentinel' };
      throw failed('RATE_LIMIT', properties);
    } }); enable(f.controller); await f.clock.advance(60000);
    assert.equal(f.controller.status().nextRunAt - f.clock.time, ['date', 'seconds'].includes(variant) ? 240000 : 60000);
    assert.doesNotMatch(JSON.stringify(f.controller.status()), /secret-sentinel/);
  }
});

test('a rate limit received after pause/resume still prevents an early retry', async () => {
  const pending = deferred(); let calls = 0;
  const f = fixture({ run: async () => { calls++; if (calls === 1) await pending.promise; } }); enable(f.controller);
  await f.clock.advance(60000);
  f.controller.configure({ enabled: false }); f.controller.stop();
  f.controller.configure({ enabled: true }); f.controller.start();
  pending.reject(failed('RATE_LIMIT', { retryAfter: '1800' })); await flush();
  assert.equal(f.controller.status().nextRunAt, f.clock.time + 1800000);
  await f.clock.advance(1799999); assert.equal(calls, 1);
  await f.clock.advance(1); assert.equal(calls, 2);
});

test('security failure received after a stop remains paused on start until user acknowledges it', async () => {
  const pending = deferred(); let calls = 0;
  const f = fixture({ run: async () => { calls++; if (calls === 1) await pending.promise; } }); enable(f.controller);
  await f.clock.advance(60000); f.controller.stop();
  pending.reject(failed('AUTH_REQUIRED')); await flush();
  f.controller.start(); await f.clock.advance(600000);
  assert.equal(calls, 1); assert.match(f.controller.status().pausedReason, /重新登录/);
  f.controller.configure({ enabled: true }); await f.clock.advance(60000); assert.equal(calls, 2);
});

test('cleared timer callbacks cannot cancel or use the timer for a later configuration', async () => {
  const f = fixture(); enable(f.controller);
  const old = [...f.clock.timers.values()][0].fn;
  await f.clock.advance(30000); f.controller.configure({ enabled: true });
  const due = f.controller.status().nextRunAt;
  old(); await flush(); assert.equal(f.controller.status().nextRunAt, due);
  f.controller.stop(); assert.equal(f.clock.timers.size, 0);
  await f.clock.advance(600000); assert.equal(f.calls(), 0);
});

test('very long Retry-After is split into safe timer segments, never wrapped to an immediate retry', async () => {
  const delay = 40 * 24 * 60 * 60 * 1000; let calls = 0;
  const f = fixture({ run: async () => { calls++; if (calls === 1) throw failed('RATE_LIMIT', { retryAfter: String(delay / 1000) }); } }); enable(f.controller);
  await f.clock.advance(60000); const due = f.clock.time + delay;
  assert.equal(f.controller.status().nextRunAt, due);
  await f.clock.advance(delay - 1); assert.equal(calls, 1);
  assert.ok(f.clock.delays.every(ms => ms <= 2147483647));
  await f.clock.advance(1); assert.equal(calls, 2);
});

test('unrepresentable server cooldown pauses safely, and invalid options never create timers', async () => {
  const f = fixture({ run: async () => { throw failed('RATE_LIMIT', { retryAfter: '9'.repeat(100) }); } }); enable(f.controller);
  await f.clock.advance(60000);
  assert.equal(f.controller.status().nextRunAt, null); assert.match(f.controller.status().pausedReason, /计时范围/);
  f.controller.configure({ enabled: true }); await f.clock.advance(3600000);
  assert.equal(f.controller.status().nextRunAt, null);
  for (const value of [0, -1, 59999, 86400001, NaN, Infinity, '60000']) assert.throws(() => f.controller.configure({ enabled: true, intervalMs: value }));
  assert.throws(() => f.controller.configure({ enabled: 'yes' }));
  assert.equal(f.clock.timers.size, 0);
});

test('observer failures never repeat or break a run, and raw thrown values remain private', async () => {
  let calls = 0;
  const f = fixture({ onChange: () => { throw new Error('observer failed'); }, run: async () => { calls++; throw 'private raw error'; } }); enable(f.controller);
  await f.clock.advance(60000); assert.equal(calls, 1);
  assert.equal(f.controller.status().running, false);
  assert.equal(f.controller.status().nextRunAt, f.clock.time + 60000);
  assert.doesNotMatch(f.controller.status().error, /private raw/);
});

test('a stop requested by the running status observer prevents starting the request', async () => {
  const f = fixture(); let observed = false;
  f.controller.onChange = status => { if (status.running && !observed) { observed = true; f.controller.stop(); } };
  enable(f.controller); await f.clock.advance(60000);
  assert.equal(f.calls(), 0); assert.equal(f.controller.status().running, false); assert.equal(f.clock.timers.size, 0);
});
