'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getEventListeners } = require('node:events');
const { AiPreviewStore, waitForAiOperation } = require('../app/core/ai-preview.cjs');
const settings = { endpoint: 'https://example.test/v1', model: 'fixture-model', aiVisionMode: 'enabled' };
function entry(store) { return store.put({ owner: 'account-a|1', settings, prepared: { immutableSnapshot: true }, profile: { model: settings.model } }); }
test('AI preview requires explicit consent and is consumed once', () => {
  const store = new AiPreviewStore(), token = entry(store);
  assert.throws(() => store.take({ token, owner: 'account-a|1', settings }), /确认/);
  assert.equal(store.take({ token, owner: 'account-a|1', settings, confirmed: true }).prepared.immutableSnapshot, true);
  assert.throws(() => store.take({ token, owner: 'account-a|1', settings, confirmed: true }), /失效/);
});
test('AI preview rejects another account epoch and changed service/model/vision', () => {
  for (const change of [{ owner: 'account-b|1' }, { owner: 'account-a|2' }, { settings: { ...settings, model: 'other' } }, { settings: { ...settings, endpoint: 'https://other.test/v1' } }, { settings: { ...settings, aiVisionMode: 'disabled' } }]) {
    const store = new AiPreviewStore(), token = entry(store);
    assert.throws(() => store.take({ token, owner: 'account-a|1', settings, confirmed: true, ...change }), /变化/);
  }
});
test('AI preview expires and explicit cancellation removes the body', () => {
  let now = 100; const store = new AiPreviewStore({ now: () => now, ttlMs: 50 });
  const token = entry(store); now = 151;
  assert.throws(() => store.take({ token, owner: 'account-a|1', settings, confirmed: true }), /变化/);
  const next = entry(store); store.clear(next);
  assert.equal(store.value, null);
  assert.throws(() => store.take({ token: next, owner: 'account-a|1', settings, confirmed: true }), /失效/);
});
test('a fresh preview releases the previous body and cannot consume with a wrong token', () => {
  const store = new AiPreviewStore(), old = entry(store), next = entry(store);
  assert.throws(() => store.take({ token: old, owner: 'account-a|1', settings, confirmed: true }), /失效/);
  assert.equal(store.take({ token: next, owner: 'account-a|1', settings, confirmed: true }).token, next);
});

test('AI operation cancellation immediately releases a permanently stalled native operation', { timeout: 1000 }, async () => {
  const controller = new AbortController();
  const waiting = waitForAiOperation(new Promise(() => {}), controller.signal);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  controller.abort(new Error('private native abort reason'));
  await assert.rejects(waiting, { message: '本次 AI 操作已取消。' });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('late native resolution and rejection cannot resume canceled AI preparation or leak an unhandled rejection', { timeout: 1000 }, async () => {
  for (const lateFailure of [false, true]) {
    const controller = new AbortController();
    let resolveNative, rejectNative, resumed = 0;
    const native = new Promise((resolve, reject) => { resolveNative = resolve; rejectNative = reject; });
    const waiting = waitForAiOperation(native, controller.signal).then(value => { resumed++; return value; });
    controller.abort();
    await assert.rejects(waiting, { message: '本次 AI 操作已取消。' });
    if (lateFailure) rejectNative(new Error('private late native error'));
    else resolveNative({ privateSession: true });
    await new Promise(setImmediate);
    assert.equal(resumed, 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    await assert.rejects(waiting, { message: '本次 AI 操作已取消。' });
  }
});

test('a pre-aborted AI operation still consumes an already rejected native promise', { timeout: 1000 }, async () => {
  const controller = new AbortController();
  controller.abort();
  const waiting = waitForAiOperation(Promise.reject(new Error('private native error')), controller.signal);
  await assert.rejects(waiting, { message: '本次 AI 操作已取消。' });
  await new Promise(setImmediate);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('completed AI operation waits preserve their result and remove cancellation listeners', async () => {
  const controller = new AbortController(), value = { session: 'mock' };
  const waiting = waitForAiOperation(Promise.resolve(value), controller.signal);
  assert.equal(await waiting, value);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  controller.abort();
  assert.equal(await waiting, value);
  assert.equal(await waitForAiOperation(Promise.resolve(value)), value);
  const other = new AbortController(), failure = new Error('controlled failure');
  await assert.rejects(waitForAiOperation(Promise.reject(failure), other.signal), error => error === failure);
  assert.equal(getEventListeners(other.signal, 'abort').length, 0);
});
