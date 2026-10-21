'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../app/core/store.cjs');
const { createMessageCleanupController, TTL_MS, MAX_PREVIEWS } = require('../app/core/message-cleanup-controller.cjs');

const start = Date.parse('2026-10-21T09:00:00+08:00');
const payload = (overrides = {}) => ({ accountId: 'synthetic-a', groupId: 'g', startMinute: '2026-10-21T09:00', endMinute: '2026-10-21T09:02', retainSenderIds: [], retainSummaryRanges: true, ...overrides });

function fixture(t) {
  const base = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(base, 'weiyue-cleanup-controller-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), base);
    assert.ok(path.basename(root).startsWith('weiyue-cleanup-controller-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const store = new Store(root);
  for (const id of ['synthetic-a', 'synthetic-b']) {
    store.ensureAccount({ id, name: '隔离合成账号', kind: 'import' });
    store.mergeMessages(id, [{ id: 'g', name: '合成群' }, { id: 'other', name: '其他合成群' }], ['g', 'other'].flatMap(groupId => Array.from({ length: 3 }, (_, index) => ({
      id: String(9007199254740993000n + BigInt(index)), groupId, time: start + index * 60000,
      senderId: index % 2 ? 'u2' : 'u1', senderName: '同名合成成员', text: `隔离合成正文 ${index}`,
    }))));
  }
  let clock = start + 30 * 60000, context = { accountId: 'synthetic-a', epoch: 1, busy: false, closing: false };
  const changes = [];
  const controller = createMessageCleanupController({ store, getContext: () => context, now: () => clock,
    onChange: () => changes.push({ count: store.queryMessages(context.accountId, { groupId: 'g' }).total }) });
  return { root, store, controller, changes, context, setClock: value => { clock = value; }, getClock: () => clock,
    bytes: (id = 'synthetic-a') => fs.readFileSync(store._file(id)),
    confirm: (overrides) => { const preview = controller.preview(payload(overrides)); return { ...payload(overrides), confirmationToken: preview.confirmationToken, confirmed: true }; } };
}

test('info and preview are read-only and disclose only this group with stable member IDs', t => {
  const f = fixture(t), before = f.bytes(), other = f.bytes('synthetic-b');
  const info = f.controller.info(payload());
  assert.equal(info.activeCount, 3); assert.equal(info.deletedCount, 0); assert.equal(info.oldest, start); assert.equal(info.newest, start + 120000);
  assert.deepEqual(info.members.map(member => member.id).sort(), ['u1', 'u2']);
  const preview = f.controller.preview(payload());
  assert.match(preview.confirmationToken, /^[a-f0-9]{64}$/); assert.equal(preview.deleteCount, 3);
  assert.deepEqual(f.bytes(), before); assert.deepEqual(f.bytes('synthetic-b'), other); assert.equal(f.changes.length, 0);
  // Closing/canceling the UI never invokes apply: clearing capabilities is read-only.
  f.controller.clear(); assert.deepEqual(f.bytes(), before);
});

test('a valid confirmation persists exactly once and callback observes committed state', t => {
  const f = fixture(t), input = f.confirm(), other = f.bytes('synthetic-b');
  const result = f.controller.apply(input);
  assert.equal(result.deleted, true); assert.equal(result.deletedCount, 3); assert.equal(result.accountId, 'synthetic-a'); assert.equal(result.groupId, 'g');
  assert.deepEqual(f.changes, [{ count: 0 }]);
  assert.equal(new Store(f.root).queryMessages('synthetic-a', { groupId: 'g' }).total, 0);
  const beforeReplay = f.bytes();
  assert.throws(() => f.controller.apply(input), /失效/); assert.deepEqual(f.bytes(), beforeReplay);
  assert.equal(f.changes.length, 1); assert.deepEqual(f.bytes('synthetic-b'), other);
  assert.equal(f.store.queryMessages('synthetic-a', { groupId: 'other' }).total, 3);
});

test('mutation uses saved preview selection instead of renderer supplied replacement range or members', t => {
  const f = fixture(t), input = f.confirm({ endMinute: '2026-10-21T09:00' });
  const result = f.controller.apply({ ...input, endMinute: '2026-10-21T09:59', retainSenderIds: ['u1', 'u2'], retainSummaryRanges: false });
  assert.equal(result.deletedCount, 1); assert.equal(f.store.queryMessages('synthetic-a', { groupId: 'g' }).total, 2);
});

test('explicit confirmation and well-formed capability are required before store mutation', t => {
  const f = fixture(t), valid = f.confirm(), before = f.bytes();
  for (const override of [{ confirmed: false }, { confirmed: 'true' }, { confirmed: 1 }, { confirmationToken: '' }, { confirmationToken: 'a'.repeat(63) }, { confirmationToken: 'Z'.repeat(64) }])
    assert.throws(() => f.controller.apply({ ...valid, ...override }), /预览筛选结果/);
  assert.deepEqual(f.bytes(), before); assert.equal(f.changes.length, 0);
  assert.equal(f.controller.apply(valid).deletedCount, 3);
});

test('capability expires exactly at the five-minute boundary and cannot be replayed', t => {
  const f = fixture(t), input = f.confirm(), before = f.bytes();
  f.setClock(f.getClock() + TTL_MS);
  assert.throws(() => f.controller.apply(input), /失效/); assert.deepEqual(f.bytes(), before);
  f.setClock(f.getClock() - 1); assert.throws(() => f.controller.apply(input), /失效/);
  assert.equal(f.changes.length, 0);
});

test('bounded preview storage evicts oldest token without modifying messages', t => {
  const f = fixture(t), first = f.confirm(), before = f.bytes(); let latest;
  for (let i = 0; i < MAX_PREVIEWS; i++) latest = f.confirm();
  assert.throws(() => f.controller.apply(first), /失效/); assert.deepEqual(f.bytes(), before);
  assert.equal(f.controller.apply(latest).deletedCount, 3);
});

test('epoch change invalidates prior confirmation even when account ID returns to the original', t => {
  const f = fixture(t), input = f.confirm(), before = f.bytes();
  f.context.epoch++;
  assert.throws(() => f.controller.apply(input), /失效/); assert.deepEqual(f.bytes(), before);
  f.context.epoch--; assert.throws(() => f.controller.apply(input), /失效/);
  assert.equal(f.changes.length, 0);
});

test('account mismatch and window closing reject all controller routes without writes', t => {
  const f = fixture(t), input = f.confirm(), before = f.bytes(), other = f.bytes('synthetic-b');
  f.context.accountId = 'synthetic-b';
  for (const method of ['info', 'preview', 'apply', 'list', 'restore']) assert.throws(() => f.controller[method](input), /当前账号已变化/);
  f.context.accountId = 'synthetic-a'; f.context.closing = true;
  for (const method of ['info', 'preview', 'apply', 'list', 'restore']) assert.throws(() => f.controller[method](input), /窗口正在关闭/);
  assert.deepEqual(f.bytes(), before); assert.deepEqual(f.bytes('synthetic-b'), other); assert.equal(f.changes.length, 0);
});

test('token cannot be moved to another valid group or another account', t => {
  const f = fixture(t), input = f.confirm(), before = f.bytes();
  assert.throws(() => f.controller.apply({ ...input, groupId: 'other' }), /失效/);
  assert.throws(() => f.controller.apply(input), /失效/);
  const next = f.confirm(); f.context.accountId = 'synthetic-b';
  assert.throws(() => f.controller.apply({ ...next, accountId: 'synthetic-b' }), /失效/);
  assert.deepEqual(f.bytes(), before); assert.equal(f.store.queryMessages('synthetic-b').total, 6);
});

test('busy blocks apply and restore before persistence while read-only info/preview remains usable', t => {
  const f = fixture(t), input = f.confirm(), before = f.bytes();
  f.context.busy = true;
  assert.equal(f.controller.info(payload()).activeCount, 3);
  assert.equal(f.controller.preview(payload()).deleteCount, 3);
  assert.throws(() => f.controller.apply(input), /已有操作/);
  assert.throws(() => f.controller.restore({ ...payload(), batchId: 'not-yet-created' }), /已有操作/);
  assert.deepEqual(f.bytes(), before); assert.equal(f.changes.length, 0);
  // Busy is rejected before consuming a capability; once idle it is still
  // bounded by the same expiry and a fresh store fingerprint.
  f.context.busy = false; assert.equal(f.controller.apply(input).deleted, true);
});

test('new bookmark makes saved preview stale, consumes token, and gives no false change notification', t => {
  const f = fixture(t), input = f.confirm();
  f.store.bookmark('synthetic-a', { groupId: 'g', messageIds: ['9007199254740993000'], note: '预览后新增收藏' });
  const before = f.bytes();
  assert.throws(() => f.controller.apply(input), /重新预览/); assert.deepEqual(f.bytes(), before); assert.equal(f.changes.length, 0);
  assert.throws(() => f.controller.apply(input), /失效/);
  const next = f.confirm(); assert.equal(f.controller.apply(next).deletedCount, 2);
  assert.equal(f.store.bookmarks('synthetic-a')[0].messages.length, 1);
});

test('failed atomic save consumes confirmation and preserves exact account bytes', t => {
  const f = fixture(t), input = f.confirm(), before = f.bytes(), write = f.store._write;
  f.store._write = () => { throw new Error('synthetic persistence failure'); };
  assert.throws(() => f.controller.apply(input), /synthetic persistence failure/);
  f.store._write = write;
  assert.deepEqual(f.bytes(), before); assert.equal(f.changes.length, 0);
  assert.throws(() => f.controller.apply(input), /失效/);
  assert.equal(f.controller.apply(f.confirm()).deletedCount, 3);
});

test('zero eligible records report deleted:false and preserve data bytes', t => {
  const f = fixture(t), input = f.confirm({ retainSenderIds: ['u1', 'u2'] }), before = f.bytes();
  const result = f.controller.apply(input);
  assert.equal(result.deleted, false); assert.equal(result.deletedCount, 0); assert.equal(result.batchId, null);
  assert.deepEqual(f.bytes(), before); assert.equal(f.controller.list(payload()).length, 0);
  assert.equal(f.changes.length, 0);
});

test('clear invalidates every pending confirmation without a store mutation', t => {
  const f = fixture(t), first = f.confirm(), second = f.confirm(), before = f.bytes();
  f.controller.clear();
  assert.throws(() => f.controller.apply(first), /失效/); assert.throws(() => f.controller.apply(second), /失效/);
  assert.deepEqual(f.bytes(), before); assert.equal(f.changes.length, 0);
});

test('restore binds exact batch to current account and group, retaining other group and account', t => {
  const f = fixture(t), deleted = f.controller.apply(f.confirm());
  const before = f.bytes(), other = f.bytes('synthetic-b');
  assert.throws(() => f.controller.restore({ ...payload({ groupId: 'other' }), batchId: deleted.batchId }), /不在当前群/);
  f.context.accountId = 'synthetic-b';
  assert.throws(() => f.controller.restore({ ...payload({ accountId: 'synthetic-b' }), batchId: deleted.batchId }), /不在当前群/);
  assert.deepEqual(f.bytes(), before); assert.deepEqual(f.bytes('synthetic-b'), other);
  f.context.accountId = 'synthetic-a';
  const result = f.controller.restore({ ...payload(), batchId: deleted.batchId });
  assert.equal(result.restored, true); assert.equal(result.restoredCount, 3);
  assert.equal(new Store(f.root).queryMessages('synthetic-a', { groupId: 'g' }).total, 3);
  const restored = f.bytes(), changesBeforeReplay = f.changes.length; const repeated = f.controller.restore({ ...payload(), batchId: deleted.batchId });
  assert.equal(repeated.restored, false); assert.equal(repeated.restoredCount, 0); assert.deepEqual(f.bytes(), restored);
  assert.equal(f.changes.length, changesBeforeReplay);
});

test('restore failure preserves tombstones and gives no false success callback', t => {
  const f = fixture(t), deleted = f.controller.apply(f.confirm()), before = f.bytes(), changedBefore = f.changes.length;
  const write = f.store._write; f.store._write = () => { throw new Error('synthetic restore write failure'); };
  assert.throws(() => f.controller.restore({ ...payload(), batchId: deleted.batchId }), /synthetic restore write failure/);
  f.store._write = write;
  assert.deepEqual(f.bytes(), before); assert.equal(f.changes.length, changedBefore);
  assert.equal(f.controller.list(payload())[0].recoverableCount, 3);
});

test('cleanup info reflects recycled counts and keeps all group member choices available for recovery', t => {
  const f = fixture(t); f.controller.apply(f.confirm());
  const info = f.controller.info(payload());
  assert.equal(info.activeCount, 0); assert.equal(info.deletedCount, 3); assert.equal(info.oldest, null); assert.equal(info.newest, null);
  assert.deepEqual(info.members.map(member => member.id).sort(), ['u1', 'u2']);
  assert.equal(f.controller.info(payload({ groupId: 'other' })).activeCount, 3);
});

test('invalid identity/group/batch inputs reject before changing files', t => {
  const f = fixture(t), before = f.bytes();
  for (const bad of [null, {}, payload({ accountId: 1 }), payload({ accountId: 'synthetic-a\n' }), payload({ groupId: '' }), payload({ groupId: 'unknown' }), payload({ groupId: ' g' })]) {
    assert.throws(() => f.controller.info(bad)); assert.throws(() => f.controller.preview(bad)); assert.throws(() => f.controller.list(bad));
  }
  for (const batchId of ['', 1, 'x\n', 'missing']) assert.throws(() => f.controller.restore({ ...payload(), batchId }), /回收记录不在当前群/);
  assert.deepEqual(f.bytes(), before);
});
