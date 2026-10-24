'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Store } = require('../app/core/store.cjs');
const { createMessageCleanupController } = require('../app/core/message-cleanup-controller.cjs');

const START = Date.parse('2026-10-21T09:00:00+08:00');
const selection = extra => ({ accountId: 'alice', groupId: 'g', startMinute: '2026-10-21T09:00', endMinute: '2026-10-21T09:10', ...extra });
const msg = (id, extra) => ({ id: String(id), groupId: 'g', senderId: 'synthetic-member', senderName: '合成成员', text: `合成正文 ${id}`, time: START + Number(id) * 60000, ...extra });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function setup(t, { messages, taskOptions, onChange } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weiyue-cleanup-worker-'));
  assert(root.startsWith(path.resolve(os.tmpdir()) + path.sep));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  for (const id of ['alice', 'bob']) {
    store.ensureAccount({ id, name: `合成 ${id}`, kind: 'import' });
    store.mergeMessages(id, [{ id: 'g', name: '合成群' }, { id: 'other', name: '合成其他群' }], messages || Array.from({ length: 11 }, (_, i) => msg(i)));
  }
  let context = { accountId: 'alice', epoch: 1, busy: false, closing: false };
  const events = [], controller = createMessageCleanupController({ store, getContext: () => context, taskOptions,
    onChange: result => { events.push(result); if (onChange) onChange(result); } });
  return { root, store, controller, events, file: store._file('alice'), switchContext: value => { context = { ...context, ...value }; } };
}
async function apply(controller, input = selection()) {
  const plan = await controller.preview(input);
  return controller.apply({ accountId: input.accountId, groupId: input.groupId, confirmationToken: plan.confirmationToken, confirmed: true });
}
async function rejectsCall(call, pattern) { await assert.rejects(Promise.resolve().then(call), pattern); }

test('real worker preview/info/list and cancellation leave file bytes and schema untouched', async t => {
  const { store, controller, file, events } = setup(t); const before = fs.readFileSync(file);
  const info = await controller.info({ accountId: 'alice', groupId: 'g' }); assert.equal(info.activeCount, 11); assert.equal(info.permanentCount, 0);
  const plan = await controller.preview(selection({ mode: 'permanent' })); assert.equal(plan.deleteCount, 11);
  assert.match(plan.confirmationToken, /^[a-f0-9]{64}$/); controller.clear();
  assert.deepEqual(await controller.list({ accountId: 'alice', groupId: 'g' }), []);
  assert.deepEqual(fs.readFileSync(file), before); assert.equal(store.getSnapshot('alice').schemaVersion, 1); assert.equal(events.length, 0);
  await rejectsCall(() => controller.apply({ accountId: 'alice', groupId: 'g', confirmationToken: plan.confirmationToken, confirmed: true }), /失效/);
  await controller.whenIdle(); assert.equal(controller.isBusy(), false);
});

test('worker permanent commit removes content, persists minimum markers and suppresses restart re-import', async t => {
  const { store, controller, root, file, events } = setup(t);
  const result = await apply(controller, selection({ mode: 'permanent', endMinute: '2026-10-21T09:02' }));
  assert.equal(result.deletedCount, 3); assert.equal(result.mode, 'permanent'); assert.equal(result.commitState, 'committed');
  const persisted = new Store(root).get('alice'); assert.equal(persisted.schemaVersion, 3);
  assert.deepEqual(persisted.messageTombstones, [0, 1, 2].map(id => ({ groupId: 'g', id: String(id), time: START + id * 60000 })));
  assert.equal(persisted.messages.length, 8); assert(!persisted.messages.some(m => ['0', '1', '2'].includes(m.id)));
  assert(!fs.readFileSync(file, 'utf8').includes('合成正文 0'));
  assert.equal(store.importData('alice', { groups: [], messages: [msg(0, { text: '再次导入的合成正文' })] }), 0);
  const reopened = new Store(root); assert.equal(reopened.queryMessages('alice', { keyword: '再次导入' }).total, 0);
  assert.equal(reopened.queryMessages('bob').total, 11); assert.equal(events.length, 1);
  assert.equal(controller.status({ accountId: 'alice' }).commitState, 'committed');
});

test('real worker recycles two batches, purges exact selected batch and restores the other', async t => {
  const { store, controller } = setup(t);
  const first = await apply(controller, selection({ endMinute: '2026-10-21T09:01' }));
  const second = await apply(controller, selection({ startMinute: '2026-10-21T09:02', endMinute: '2026-10-21T09:03' }));
  assert.equal(store.queryMessages('alice').total, 7);
  const plan = await controller.purgePreview({ accountId: 'alice', groupId: 'g', batchIds: [first.batchId] });
  assert.equal(plan.deleteCount, 2); assert.equal(plan.batchCount, 1);
  const purged = await controller.purgeApply({ accountId: 'alice', groupId: 'g', confirmationToken: plan.confirmationToken, confirmed: true });
  assert.equal(purged.purgedCount, 2); assert.equal(store.listMessageTrash('alice').length, 1);
  assert.equal(store.listMessageTrash('alice')[0].id, second.batchId);
  const restored = await controller.restore({ accountId: 'alice', groupId: 'g', batchId: second.batchId });
  assert.equal(restored.restoredCount, 2); assert.equal(store.queryMessages('alice').total, 9);
  assert.equal(store.get('alice').schemaVersion, 3);
});

test('token captures mode and operation; stale protected rows consume token without writing', async t => {
  const { store, controller, file } = setup(t);
  const recycle = await controller.preview(selection({ endMinute: '2026-10-21T09:00' }));
  const result = await controller.apply({ accountId: 'alice', groupId: 'g', confirmationToken: recycle.confirmationToken, confirmed: true, mode: 'permanent' });
  assert.equal(result.mode, 'recycle'); assert.equal(store.get('alice').messageTombstones, undefined); assert.equal(store.get('alice').messages.length, 11);
  const plan = await controller.preview(selection({ mode: 'permanent' }));
  store.bookmark('alice', { groupId: 'g', messageIds: ['2'], note: '合成备注', tags: ['测试'] });
  const protectedBytes = fs.readFileSync(file), request = { accountId: 'alice', groupId: 'g', confirmationToken: plan.confirmationToken, confirmed: true };
  await rejectsCall(() => controller.apply(request), /重新预览/); assert.deepEqual(fs.readFileSync(file), protectedBytes);
  await rejectsCall(() => controller.apply(request), /失效/);
  const purge = await controller.purgePreview({ accountId: 'alice', groupId: 'g', batchIds: [result.batchId] });
  await rejectsCall(() => controller.apply({ ...request, confirmationToken: purge.confirmationToken }), /失效/);
  assert.deepEqual(fs.readFileSync(file), protectedBytes);
});

test('mutation locks account across Store instances, allows another account, and whenIdle waits through commit', async t => {
  const entered = deferred(), finish = deferred();
  const { root, store, controller, file } = setup(t, { taskOptions: { rename: async (from, to) => { entered.resolve(); await finish.promise; return fs.promises.rename(from, to); } } });
  const before = fs.readFileSync(file), plan = await controller.preview(selection({ mode: 'permanent', endMinute: '2026-10-21T09:00' }));
  const run = controller.apply({ accountId: 'alice', groupId: 'g', confirmationToken: plan.confirmationToken, confirmed: true });
  const second = new Store(root);
  assert.equal(controller.isBusy('alice'), true); assert.equal(controller.isBusy('bob'), false); assert.equal(store.isWriteLocked('alice'), true);
  let idle = false; const idlePromise = controller.whenIdle().then(() => { idle = true; });
  await entered.promise;
  assert.equal(controller.status({ accountId: 'alice' }).phase, 'committing'); assert.equal(idle, false);
  assert.throws(() => store.update('alice', state => { state.settings.x = 1; }), error => error.code === 'CLEANUP_BUSY');
  assert.throws(() => second.update('alice', state => { state.settings.x = 2; }), error => error.code === 'CLEANUP_BUSY');
  second.update('bob', state => { state.settings.synthetic = true; });
  assert.deepEqual(fs.readFileSync(file), before);
  controller.clear(); assert.equal(controller.isBusy(), true);
  finish.resolve(); const result = await run; await idlePromise;
  assert.equal(result.deletedCount, 1); assert.equal(idle, true); assert.equal(store.isWriteLocked('alice'), false);
  assert.equal(store.get('alice').settings.x, undefined); assert.equal(second.get('bob').settings.synthetic, true);
});

test('captured running job hides status after account switch and notifies original owner exactly once', async t => {
  const entered = deferred(), finish = deferred();
  const { store, controller, switchContext, events } = setup(t, { taskOptions: { rename: async (from, to) => { entered.resolve(); await finish.promise; return fs.promises.rename(from, to); } } });
  const plan = await controller.preview(selection({ mode: 'permanent', endMinute: '2026-10-21T09:00' }));
  const running = controller.apply({ accountId: 'alice', groupId: 'g', confirmationToken: plan.confirmationToken, confirmed: true });
  await entered.promise; switchContext({ accountId: 'bob', epoch: 2 }); controller.clear();
  assert.equal(controller.status({ accountId: 'alice' }).phase, 'idle');
  assert.equal(controller.status({ accountId: 'bob' }).phase, 'idle');
  assert.equal(controller.status({ accountId: 'bob' }).jobId, undefined);
  finish.resolve(); await running; await controller.whenIdle();
  assert.equal(events.length, 1); assert.equal(events[0].accountId, 'alice'); assert.equal(events[0].groupId, 'g');
  assert.equal(store.queryMessages('alice').total, 10); assert.equal(store.queryMessages('bob').total, 11);
});

test('real worker emits real stages and bounded message/byte counts without blocking main event loop', async t => {
  const messages = Array.from({ length: 5001 }, (_, i) => msg(i, { time: START + i }));
  const { store, controller } = setup(t, { messages }); const phases = [];
  const runCleanupTask = store.runCleanupTask.bind(store);
  store.runCleanupTask = (id, action, payload, options) => runCleanupTask(id, action, payload, { ...options, onProgress: progress => { phases.push(progress); options.onProgress(progress); } });
  const plan = await controller.preview(selection({ mode: 'permanent' })); phases.length = 0;
  const running = controller.apply({ accountId: 'alice', groupId: 'g', confirmationToken: plan.confirmationToken, confirmed: true });
  let yielded = false; await new Promise(resolve => setImmediate(() => { yielded = true; resolve(); })); assert(yielded);
  const result = await running; assert.equal(result.deletedCount, 5001);
  for (const phase of ['reading', 'validating', 'planning', 'processing', 'writing', 'committing']) assert(phases.some(item => item.phase === phase), phase);
  const processing = phases.filter(item => item.phase === 'processing'); assert.deepEqual(processing.map(p => p.processed), [0, 2048, 4096, 5001]);
  for (const entry of phases) if (entry.processed !== null && entry.processed !== undefined) assert(entry.processed >= 0 && entry.processed <= entry.total);
  const status = controller.status({ accountId: 'alice' }); assert.equal(status.phase, 'completed'); assert.equal(status.processed, 5001); assert.equal(status.total, 5001);
  assert.equal(status.running, false); assert.equal(status.completed, true); assert.equal(status.error, null);
});

test('pre-rename save failure preserves original bytes/cache, consumes token and permits fresh retry', async t => {
  let attempts = 0;
  const { store, controller, file } = setup(t, { taskOptions: { rename: async (from, to) => { if (++attempts === 1) throw Error('synthetic failure'); return fs.promises.rename(from, to); } } });
  const cached = store.getSnapshot('alice'), before = fs.readFileSync(file);
  const plan = await controller.preview(selection({ mode: 'permanent', endMinute: '2026-10-21T09:00' }));
  const request = { accountId: 'alice', groupId: 'g', confirmationToken: plan.confirmationToken, confirmed: true };
  await rejectsCall(() => controller.apply(request), /保存本地数据失败/);
  assert.deepEqual(fs.readFileSync(file), before); assert.strictEqual(store.getSnapshot('alice'), cached);
  assert.equal(controller.status({ accountId: 'alice' }).phase, 'failed'); assert.equal(controller.status({ accountId: 'alice' }).commitState, 'not-committed');
  assert.equal(store.isWriteLocked('alice'), false); await controller.whenIdle();
  await rejectsCall(() => controller.apply(request), /失效/);
  const result = await apply(controller, selection({ mode: 'permanent', endMinute: '2026-10-21T09:00' }));
  assert.equal(result.deletedCount, 1); assert.equal(attempts, 2); assert.equal(store.getSnapshot('alice').messages.length, 10);
});

test('rename succeeded then wrapper throws is reconciled as committed exactly once', async t => {
  let attempts = 0;
  const { store, controller, events } = setup(t, { taskOptions: { rename: async (from, to) => { attempts++; await fs.promises.rename(from, to); throw Error('synthetic postcommit failure'); } } });
  const cached = store.getSnapshot('alice');
  const result = await apply(controller, selection({ mode: 'permanent', endMinute: '2026-10-21T09:00' }));
  assert.equal(result.commitState, 'committed'); assert.equal(result.deletedCount, 1); assert.equal(attempts, 1); assert.equal(events.length, 1);
  assert.notStrictEqual(store.getSnapshot('alice'), cached); assert.equal(store.getSnapshot('alice').messages.length, 10);
  const status = controller.status({ accountId: 'alice' }); assert.equal(status.phase, 'completed'); assert.equal(status.commitState, 'committed'); assert.equal(status.error, null);
});

test('notification failure cannot convert a committed mutation into a failed result', async t => {
  const { store, controller, events } = setup(t, { onChange: () => { throw Error('synthetic notification failure'); } });
  const result = await apply(controller, selection({ mode: 'permanent', endMinute: '2026-10-21T09:00' }));
  assert.equal(result.commitState, 'committed'); assert.equal(events.length, 1); assert.equal(store.queryMessages('alice').total, 10);
  const status = controller.status({ accountId: 'alice' }); assert.equal(status.completed, true); assert.equal(status.phase, 'completed');
  assert.equal(status.notificationError, true); assert.equal(status.commitState, 'committed'); assert.equal(status.error, null);
});

test('Windows case aliases of the same account directory share the mutation lock', { skip: process.platform !== 'win32' }, async t => {
  const entered = deferred(), finish = deferred();
  const { root, store, controller } = setup(t, { taskOptions: { rename: async (from, to) => { entered.resolve(); await finish.promise; return fs.promises.rename(from, to); } } });
  const alias = new Store(root.toUpperCase());
  const plan = await controller.preview(selection({ mode: 'permanent', endMinute: '2026-10-21T09:00' }));
  const running = controller.apply({ accountId: 'alice', groupId: 'g', confirmationToken: plan.confirmationToken, confirmed: true });
  const settled = running.then(value => ({ value }), error => ({ error }));
  try {
    await entered.promise;
    assert.equal(alias.isWriteLocked('alice'), true);
    assert.throws(() => alias.update('alice', state => { state.settings.caseAlias = true; }), error => error.code === 'CLEANUP_BUSY');
  } finally { finish.resolve(); await settled; }
  const outcome = await settled; assert.equal(outcome.error, undefined); assert.equal(outcome.value.deletedCount, 1);
  assert.equal(store.get('alice').settings.caseAlias, undefined);
});
