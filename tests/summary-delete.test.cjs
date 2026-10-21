'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { Store } = require('../app/core/store.cjs');
const { SummaryDeletePreviewStore, fingerprint: summaryFingerprint, TTL_MS, MAX_ENTRIES } = require('../app/core/summary-delete-preview.cjs');

const accountId = 'summary-delete-fixture-a';
const otherAccountId = 'summary-delete-fixture-b';
const messageId = '9007199254740993001';
const unreadId = '9007199254740993002';
const start = Date.parse('2026-10-20T00:00:00+08:00');
const payload = () => ({ accountId, summaryId: 's1', groupId: 'g1' });
const plain = value => JSON.parse(JSON.stringify(value));
const summary = (id = 's1', groupId = 'g1') => ({
  id, groupId, title: '同名摘要', body: '合成摘要 [M1]', mode: 'local',
  start, end: start + 3600000, createdAt: start + 3600001,
  refs: [{ id: messageId, groupId, label: 'M1', time: start, text: '合成原文', senderName: '模拟成员' }],
});

function fixture(t) {
  const base = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(base, 'weiyue-summary-delete-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), base);
    assert.ok(path.basename(root).startsWith('weiyue-summary-delete-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const store = new Store(root);
  for (const id of [accountId, otherAccountId]) {
    store.ensureAccount({ id, name: '独立合成测试账号', kind: 'import' });
    store.mergeMessages(id, [{ id: 'g1', name: '测试群一' }, { id: 'g2', name: '测试群二' }], [
      { id: messageId, groupId: 'g1', time: start, senderId: 'u1', senderName: '模拟成员', text: '合成原文' },
      { id: unreadId, groupId: 'g1', time: start + 1000, senderId: 'u2', senderName: '模拟成员', text: '合成未读' },
      { id: messageId, groupId: 'g2', time: start, senderId: 'u1', senderName: '模拟成员', text: '另一个群' },
    ]);
    store.update(id, state => {
      state.summaries = [summary(), summary('s2'), summary('s3', 'g2')];
      state.bookmarks = [{ id: 'b1', groupId: 'g1', messageIds: [messageId], note: '保留备注', tags: ['标签'], createdAt: start }];
      state.readPositions = { g1: messageId };
      state.readStates.g1 = { anchorId: messageId, anchorOffset: 32, atBottom: false, readThroughId: messageId, unreadIds: [unreadId], updatedAt: start };
      state.importantMembers = ['u1'];
      state.settings = { interval: 60, ai: { model: 'offline-only' } };
      state.exports = {
        completed: { status: 'complete', summaryId: 's1', pageId: 'synthetic-page-id' },
        partial: { status: 'partial', summaryId: 's1', writtenBlocks: 3 },
      };
    });
  }
  return { root, store, bytes: (id = accountId) => fs.readFileSync(store._file(id), 'utf8') };
}

const mainSource = fs.readFileSync(require.resolve('../app/main.cjs'), 'utf8');
const deletionSource = mainSource.slice(mainSource.indexOf('function summaryDeleteSelection(p){'), mainSource.indexOf('\nfunction saveSummary'));
const handleSource = mainSource.slice(mainSource.indexOf('async function handle(action,p){'), mainSource.indexOf('\nasync function start(){'));

function mainHarness(store, options) {
  const summaryDeletePreviews = new SummaryDeletePreviewStore(options);
  const context = vm.createContext({
    store, activeId: accountId, accountEpoch: 7, busy: false, revision: 10,
    win: { fixture: true }, closing: () => false,
    summaryDeletePreviews, summaryFingerprint,
    dialog: { showMessageBox: () => { throw new Error('deletion must not open a native dialog'); } },
  });
  vm.runInContext(`${deletionSource}\n${handleSource}`, context);
  return {
    context, summaryDeletePreviews,
    preview: input => context.handle('summary.delete.preview', input === undefined ? payload() : input),
    delete: input => context.handle('summary.delete', input),
    async confirmed() { const preview = await this.preview(); return { ...payload(), confirmationToken: preview.confirmationToken, confirmed: true }; },
  };
}

test('store deletes only the stable ID and persists across restart, preserving all unrelated data and accounts', t => {
  const { root, store, bytes } = fixture(t);
  const original = store.get(accountId), otherBytes = bytes(otherAccountId);
  assert.deepEqual(store.removeSummary(accountId, 's1', 'g1'), { deleted: true, summaryCount: 2 });
  const persisted = new Store(root).get(accountId);
  assert.deepEqual(persisted.summaries, [original.summaries[1], original.summaries[2]]);
  assert.deepEqual({ ...persisted, summaries: original.summaries }, original);
  assert.equal(bytes(otherAccountId), otherBytes);
});

test('missing IDs and repeated deletion are idempotent and do not rewrite the account', t => {
  const { store, bytes } = fixture(t);
  const before = bytes();
  const write = t.mock.method(store, '_write');
  assert.deepEqual(store.removeSummary(accountId, 'missing', 'g1'), { deleted: false, summaryCount: 3 });
  assert.equal(write.mock.callCount(), 0);
  assert.equal(bytes(), before);
  assert.equal(store.removeSummary(accountId, 's1', 'g1').deleted, true);
  const once = bytes();
  assert.deepEqual(store.removeSummary(accountId, 's1', 'g1'), { deleted: false, summaryCount: 2 });
  assert.equal(write.mock.callCount(), 1);
  assert.equal(bytes(), once);
});

test('malformed identifiers, another group, and duplicate IDs fail without modifying either account', t => {
  const { store, bytes } = fixture(t);
  const before = bytes(), otherBytes = bytes(otherAccountId);
  for (const invalid of [null, undefined, 1, {}, '', ' ', ' s1', 's1 ', 'x\u0000y', 'x'.repeat(257)]) {
    assert.throws(() => store.removeSummary(accountId, invalid, 'g1'));
    assert.throws(() => store.removeSummary(accountId, 's1', invalid));
    assert.throws(() => store.removeSummary(invalid, 's1', 'g1'));
  }
  assert.throws(() => store.removeSummary(accountId, 's1', 'g2'), /所属群/);
  assert.equal(bytes(), before);
  assert.equal(bytes(otherAccountId), otherBytes);
  store.update(accountId, state => state.summaries.push(summary('s1', 'g2')));
  const duplicated = bytes();
  assert.throws(() => store.removeSummary(accountId, 's1', 'g1'), /ID 重复/);
  assert.equal(bytes(), duplicated);
});

test('failed atomic publication keeps original bytes and caller state, removes temporary file, then permits retry', t => {
  const { root, store, bytes } = fixture(t);
  const before = bytes(), original = store.get(accountId), file = store._file(accountId);
  const originalRename = fs.renameSync;
  const rename = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === file) throw Object.assign(new Error('simulated disk failure'), { code: 'EACCES' });
    return originalRename(from, to);
  });
  assert.throws(() => store.removeSummary(accountId, 's1', 'g1'), /保存本地数据失败/);
  assert.equal(bytes(), before);
  assert.deepEqual(store.get(accountId), original);
  assert.equal(original.summaries.length, 3);
  assert.equal(fs.readdirSync(root).some(name => name.endsWith('.tmp')), false);
  rename.mock.restore();
  assert.equal(store.removeSummary(accountId, 's1', 'g1').deleted, true);
});

test('IPC preview is read-only and holds no busy lock, so dismissing it changes no data', async t => {
  const { store, bytes } = fixture(t);
  const before = bytes(), app = mainHarness(store);
  const preview = await app.preview();
  assert.deepEqual(plain(preview), { ...payload(), title: '同名摘要', confirmationToken: preview.confirmationToken });
  assert.match(preview.confirmationToken, /^[a-f0-9]{64}$/);
  assert.equal(bytes(), before);
  assert.equal(app.context.revision, 10);
  assert.equal(app.context.busy, false);
  app.context.busy = true;
  await app.preview();
  assert.equal(app.context.busy, true);
  assert.equal(bytes(), before);
});

test('IPC confirmed deletion returns durable count without a post-write read and updates revision once', async t => {
  const { root, store } = fixture(t);
  const app = mainHarness(store), input = await app.confirmed();
  const originalRemove = store.removeSummary.bind(store);
  const originalGet = store.get.bind(store);
  store.removeSummary = (...args) => {
    const result = originalRemove(...args);
    store.get = () => { throw new Error('must not reread after durable write'); };
    return result;
  };
  assert.deepEqual(plain(await app.delete(input)), { ...payload(), deleted: true, summaryCount: 2 });
  store.get = originalGet;
  assert.equal(app.context.revision, 11);
  assert.equal(app.context.busy, false);
  assert.equal(new Store(root).get(accountId).summaries.some(item => item.id === 's1'), false);
});

test('IPC missing summary preview returns accurate count without write or revision change', async t => {
  const { store, bytes } = fixture(t);
  const app = mainHarness(store), before = bytes();
  assert.deepEqual(plain(await app.preview({ ...payload(), summaryId: 'missing' })), { ...payload(), summaryId: 'missing', deleted: false, missing: true, summaryCount: 3 });
  assert.equal(app.summaryDeletePreviews.entries.size, 0);
  assert.equal(bytes(), before);
  assert.equal(app.context.revision, 10);
});

test('IPC validates identities and rejects another account before reading it', async t => {
  const { store, bytes } = fixture(t);
  const app = mainHarness(store), before = bytes(), otherBytes = bytes(otherAccountId);
  const read = t.mock.method(store, 'get');
  for (const input of [null, {}, [], { ...payload(), accountId: otherAccountId }, ...['accountId', 'summaryId', 'groupId'].flatMap(key => [undefined, 1, ' ', ' s1', 'x\u0000y', 'x'.repeat(257)].map(value => ({ ...payload(), [key]: value })))]) {
    await assert.rejects(app.preview(input), /标识无效|当前账号已变化/);
    await assert.rejects(app.delete(input), /标识无效|当前账号已变化/);
  }
  assert.equal(read.mock.callCount(), 0);
  assert.equal(bytes(), before);
  assert.equal(bytes(otherAccountId), otherBytes);
});

test('IPC rejects a wrong group or duplicated ID before presenting a confirmation', async t => {
  const { store, bytes } = fixture(t);
  const app = mainHarness(store), before = bytes();
  await assert.rejects(app.preview({ ...payload(), groupId: 'g2' }), /所属群/);
  assert.equal(bytes(), before);
  store.update(accountId, state => state.summaries.push(summary('s1', 'g2')));
  const duplicated = bytes();
  await assert.rejects(app.preview(), /ID 重复/);
  assert.equal(bytes(), duplicated);
  assert.equal(app.summaryDeletePreviews.entries.size, 0);
});

test('IPC confirmation tokens require explicit confirmation and cannot be replayed or guessed', async t => {
  const { store, bytes } = fixture(t), app = mainHarness(store), before = bytes();
  const input = await app.confirmed();
  for (const invalid of [
    { ...input, confirmed: false }, { ...input, confirmed: 'true' },
    { ...input, confirmationToken: '' }, { ...input, confirmationToken: 'f'.repeat(64) },
    payload(),
  ]) await assert.rejects(app.delete(invalid), /重新打开删除确认|删除确认已失效/);
  assert.equal(bytes(), before);
  assert.equal((await app.delete(input)).deleted, true);
  await assert.rejects(app.delete(input), /删除确认已失效/);
  assert.equal(app.context.busy, false);
  assert.equal(app.context.revision, 11);
});

test('IPC busy rejection preserves the other operation lock and permits retry with the unused token', async t => {
  const { store } = fixture(t), app = mainHarness(store), input = await app.confirmed();
  app.context.busy = true;
  await assert.rejects(app.delete(input), /已有操作正在进行/);
  assert.equal(app.context.busy, true);
  app.context.busy = false;
  assert.equal((await app.delete(input)).deleted, true);
  assert.equal(app.context.busy, false);
});

test('IPC aborts if account, session epoch, or close state changes after preview', async t => {
  const { store, bytes } = fixture(t), before = bytes(), otherBytes = bytes(otherAccountId);
  for (const change of [
    context => { context.activeId = otherAccountId; },
    context => { context.accountEpoch++; },
    context => { context.closing = () => true; },
  ]) {
    const app = mainHarness(store), input = await app.confirmed();
    change(app.context);
    await assert.rejects(app.delete(input), /当前账号已变化|窗口正在关闭|当前账号或摘要已变化/);
    assert.equal(app.context.busy, false);
    assert.equal(app.context.revision, 10);
    assert.equal(bytes(), before);
    assert.equal(bytes(otherAccountId), otherBytes);
  }
});

test('IPC refuses to delete changed, duplicated, or substituted confirmed targets', async t => {
  const { store, bytes } = fixture(t);
  for (const change of [
    state => { state.summaries[0].body += '已更新'; },
    state => { state.summaries[0].groupId = 'g2'; },
    state => { state.summaries.push(summary()); },
  ]) {
    store.update(accountId, state => { state.summaries = [summary(), summary('s2'), summary('s3', 'g2')]; });
    const app = mainHarness(store), input = await app.confirmed();
    store.update(accountId, change);
    const afterConcurrentChange = bytes();
    await assert.rejects(app.delete(input), /摘要内容已变化|所属群|ID 重复/);
    assert.equal(bytes(), afterConcurrentChange);
    assert.equal(app.context.busy, false);
    assert.equal(app.context.revision, 10);
  }
  store.update(accountId, state => { state.summaries = [summary(), summary('s2'), summary('s3', 'g2')]; });
  const app = mainHarness(store), input = await app.confirmed(), before = bytes();
  await assert.rejects(app.delete({ ...input, summaryId: 's3', groupId: 'g2' }), /当前账号或摘要已变化/);
  assert.equal(bytes(), before);
  await assert.rejects(app.delete(input), /删除确认已失效/);
});

test('IPC disappearance after preview returns missing without extra write', async t => {
  const { store, bytes } = fixture(t), app = mainHarness(store), input = await app.confirmed();
  store.removeSummary(accountId, 's1', 'g1');
  const afterConcurrentDeletion = bytes(), writes = t.mock.method(store, '_write');
  assert.deepEqual(plain(await app.delete(input)), { ...payload(), deleted: false, missing: true, summaryCount: 2 });
  assert.equal(writes.mock.callCount(), 0);
  assert.equal(bytes(), afterConcurrentDeletion);
  assert.equal(app.context.revision, 10);
});

test('IPC stable IDs preserve new and reordered summaries while the preview is open', async t => {
  const { store } = fixture(t), app = mainHarness(store), input = await app.confirmed();
  store.update(accountId, state => { state.summaries.reverse(); state.summaries.unshift(summary('s4', 'g2')); });
  assert.deepEqual(plain(await app.delete(input)), { ...payload(), deleted: true, summaryCount: 3 });
  assert.deepEqual(store.get(accountId).summaries.map(item => item.id), ['s4', 's3', 's2']);
  assert.equal(store.get(otherAccountId).summaries.length, 3);
});

test('IPC five-minute expiry rejects without data changes or a held lock', async t => {
  const { store, bytes } = fixture(t), before = bytes();
  let now = 1000;
  const app = mainHarness(store, { now: () => now }), input = await app.confirmed();
  now += TTL_MS;
  await assert.rejects(app.delete(input), /删除确认已失效/);
  assert.equal(bytes(), before);
  assert.equal(app.context.busy, false);
  assert.equal(app.context.revision, 10);
});

test('IPC write failure rejects without reporting success, preserves data, and allows later confirmation', async t => {
  const { store, bytes } = fixture(t), before = bytes(), otherBytes = bytes(otherAccountId);
  const app = mainHarness(store), input = await app.confirmed();
  const originalRename = fs.renameSync, file = store._file(accountId);
  const rename = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === file) throw new Error('simulated publication failure');
    return originalRename(from, to);
  });
  await assert.rejects(app.delete(input), /保存本地数据失败/);
  assert.equal(bytes(), before);
  assert.equal(bytes(otherAccountId), otherBytes);
  assert.equal(app.context.busy, false);
  assert.equal(app.context.revision, 10);
  rename.mock.restore();
  await assert.rejects(app.delete(input), /删除确认已失效/);
  assert.deepEqual(plain(await app.delete(await app.confirmed())), { ...payload(), deleted: true, summaryCount: 2 });
  assert.equal(app.context.revision, 11);
});

test('confirmation cache has random unique tokens, a bounded capacity, expiring entries, and explicit invalidation', () => {
  let now = 1000;
  const previews = new SummaryDeletePreviewStore({ now: () => now }), tokens = [];
  for (let i = 0; i < MAX_ENTRIES + 1; i++) tokens.push(previews.create(payload(), 7, summary()));
  assert.equal(new Set(tokens).size, MAX_ENTRIES + 1);
  assert.equal(previews.entries.size, MAX_ENTRIES);
  assert.throws(() => previews.take(payload(), 7, tokens[0], true), /删除确认已失效/);
  assert.equal(previews.take(payload(), 7, tokens[1], true), summaryFingerprint(summary()));
  assert.throws(() => previews.take(payload(), 7, tokens[1], true), /删除确认已失效/);
  now += TTL_MS;
  const current = previews.create(payload(), 7, summary());
  assert.equal(previews.entries.size, 1);
  assert.equal(previews.take(payload(), 7, current, true), summaryFingerprint(summary()));
  const cleared = previews.create(payload(), 7, summary());
  previews.clear();
  assert.throws(() => previews.take(payload(), 7, cleared, true), /删除确认已失效/);
});

test('deleting the final summary produces zero count and a durable empty list', async t => {
  const { root, store } = fixture(t);
  store.update(accountId, state => { state.summaries = [summary()]; });
  const app = mainHarness(store);
  assert.deepEqual(plain(await app.delete(await app.confirmed())), { ...payload(), deleted: true, summaryCount: 0 });
  assert.deepEqual(new Store(root).get(accountId).summaries, []);
  assert.deepEqual(plain(await app.preview()), { ...payload(), deleted: false, missing: true, summaryCount: 0 });
});

test('preload exposes only the explicit deletion preview and commit actions and preserves their payloads', async () => {
  let api;
  const calls = [];
  vm.runInNewContext(fs.readFileSync(require.resolve('../app/preload.cjs'), 'utf8'), {
    require: name => {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, 'api'); api = value; } },
        ipcRenderer: {
          invoke: async (...args) => { calls.push(args); return { ok: true, value: { fixture: true } }; },
          on: () => {}, removeListener: () => {},
        },
      };
    },
  });
  const selection = payload(), confirmed = { ...selection, confirmationToken: 'a'.repeat(64), confirmed: true };
  assert.deepEqual(await api.call('summary.delete.preview', selection), { fixture: true });
  assert.deepEqual(await api.call('summary.delete', confirmed), { fixture: true });
  assert.deepEqual(calls, [
    ['weiyue:call', 'summary.delete.preview', selection],
    ['weiyue:call', 'summary.delete', confirmed],
  ]);
  await assert.rejects(api.call('summary.delete.all', {}), /不支持的操作/);
  assert.equal(calls.length, 2);
  assert.equal(Object.isFrozen(api), true);
});
