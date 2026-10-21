'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Store, filterMessages, visibleMessages } = require('../app/core/store.cjs');
const cleanup = require('../app/core/message-cleanup.cjs');
const { prepareSummary, localSummary } = require('../app/core/summary.cjs');

const START = Date.parse('2026-10-21T09:00:00+08:00');
const selection = (overrides = {}) => ({ groupId: 'g', startMinute: '2026-10-21T09:00', endMinute: '2026-10-21T09:10', retainSenderIds: [], retainSummaryRanges: true, ...overrides });
const msg = (id, overrides = {}) => ({ id: String(id), groupId: 'g', senderId: 'u1', senderName: '合成成员', text: `合成原文 ${id}`, time: START + Number(id) * 60000, ...overrides });
function setup(t, messages = Array.from({ length: 11 }, (_, i) => msg(i))) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weiyue-cleanup-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  store.ensureAccount({ id: 'alice', name: '合成账号', kind: 'import' });
  store.mergeMessages('alice', [{ id: 'g', name: '合成群' }, { id: 'g2', name: '合成群二' }], messages);
  return { root, store, file: store._file('alice') };
}
function apply(store, input = selection()) {
  const preview = store.previewMessageCleanup('alice', input);
  return store.applyMessageCleanup('alice', preview.selection, preview.fingerprint);
}
function saveSummary(store, overrides = {}) {
  const state = store.get('alice');
  const prepared = prepareSummary({ messages: state.messages, group: state.groups[0], start: overrides.start ?? START + 2 * 60000, end: overrides.end ?? START + 4 * 60000 });
  const summary = { ...localSummary(prepared), ...overrides };
  store.update('alice', state => state.summaries.push(summary));
  return summary;
}

test('preview uses China minutes, includes entire end minute, and never changes bytes', t => {
  const { store, file } = setup(t, [msg('1', { time: START - 1 }), msg('2', { time: START }), msg('3', { time: START + 59999 }), msg('4', { time: START + 60000 })]);
  const before = fs.readFileSync(file);
  const preview = store.previewMessageCleanup('alice', selection({ endMinute: '2026-10-21T09:00' }));
  assert.deepEqual(preview.range, { start: START, end: START + 60000 });
  assert.equal(preview.matchedCount, 2); assert.equal(preview.deleteCount, 2);
  assert.deepEqual(preview.sample.map(row => row.id), ['2', '3']);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('invalid dates, missing bounds, reversed minutes, unsafe member IDs and group IDs reject', t => {
  const { store, file } = setup(t); const before = fs.readFileSync(file);
  for (const input of [selection({ startMinute: '' }), selection({ endMinute: '' }), selection({ startMinute: '2026-02-30T01:00' }), selection({ startMinute: '2026-10-21T10:00' }), selection({ groupId: 'missing' }), selection({ retainSenderIds: [Number.MAX_SAFE_INTEGER + 1] }), selection({ retainSummaryRanges: 'yes' }), selection({ startMinute: '2026-10-21T09:00:01' })])
    assert.throws(() => store.previewMessageCleanup('alice', input));
  assert.deepEqual(fs.readFileSync(file), before);
});

test('recycling persists original bytes as records, hides queries, and restores one exact batch', t => {
  const { store, root } = setup(t);
  const originals = store.get('alice').messages;
  const result = apply(store, selection({ startMinute: '2026-10-21T09:02', endMinute: '2026-10-21T09:04' }));
  assert.equal(result.deletedCount, 3);
  const reopened = new Store(root);
  assert.equal(reopened.get('alice').messages.length, 11);
  assert.equal(reopened.queryMessages('alice').total, 8);
  assert.equal(visibleMessages(reopened.get('alice').messages).length, 8);
  assert.equal(filterMessages(reopened.get('alice').messages, { keyword: '原文' }).length, 8);
  assert.equal(reopened.getReadStats('alice', 'g').messageCount, 8);
  assert.equal(reopened.listMessageTrash('alice')[0].recoverableCount, 3);
  const restored = reopened.restoreMessageTrash('alice', result.batchId);
  assert.equal(restored.restoredCount, 3);
  assert.deepEqual(reopened.get('alice').messages, originals);
  assert.equal(new Store(root).queryMessages('alice').total, 11);
  assert.equal(reopened.listMessageTrash('alice')[0].recoverableCount, 0);
  assert.equal(reopened.restoreMessageTrash('alice', result.batchId).restored, false);
});

test('repeated sync/import never restores tombstones and retained rich edits survive explicit restore', t => {
  const { store, root } = setup(t);
  const result = apply(store, selection({ endMinute: '2026-10-21T09:00' }));
  assert.equal(store.mergeMessages('alice', [], [msg('0', { text: '已授权同步的更新正文' })]), 0);
  store.importData('alice', { groups: [], messages: [msg('0', { text: '再次导入更新', localDeletion: null })] });
  const restarted = new Store(root);
  assert.equal(restarted.queryMessages('alice', { keyword: '再次导入' }).total, 0);
  assert.equal(restarted.get('alice').messages.find(m => m.id === '0').localDeletion.batchId, result.batchId);
  restarted.restoreMessageTrash('alice', result.batchId);
  assert.equal(restarted.queryMessages('alice', { keyword: '再次导入' }).total, 1);
});

test('untrusted imported local tombstone fields cannot hide a fresh message', t => {
  const { store } = setup(t);
  store.importData('alice', { groups: [], messages: [msg('100', { localDeletion: { batchId: 'forged', deletedAt: START } })] });
  assert.equal(store.queryMessages('alice', { keyword: '100' }).total, 1);
  assert.equal(store.get('alice').messages.at(-1).localDeletion, undefined);
});

test('bookmarks, read anchor/highwater, unread IDs, sync anchors and member IDs are retained without edits', t => {
  const { store } = setup(t);
  store.bookmark('alice', { groupId: 'g', messageIds: ['1'], note: '保留备注', tags: ['合成'] });
  store.setReadPosition('alice', 'g', '3', { seenId: '2', offset: 17, followTail: false });
  store.update('alice', state => {
    state.readStates.g.unreadIds = ['4', '5'];
    state.groups[0].latestPendingRanges = [{ cursor: '9', baselineId: '6', arrivalAfterId: '6', status: 'pending' }];
    state.messages.find(m => m.id === '7').senderId = 'keep';
    state.messages.find(m => m.id === '8').senderName = '合成成员';
    state.messages.find(m => m.id === '8').senderId = 'other-same-name';
  });
  const before = store.get('alice');
  const input = selection({ retainSenderIds: ['keep'] });
  const preview = store.previewMessageCleanup('alice', input);
  assert.equal(preview.reasonCounts.bookmark, 1);
  assert.equal(preview.reasonCounts.readPosition, 2);
  assert.equal(preview.reasonCounts.unread, 2);
  assert.equal(preview.reasonCounts.syncAnchor, 1);
  assert.equal(preview.reasonCounts.retainedMember, 1);
  assert.equal(preview.deleteCount, 4);
  apply(store, input);
  const after = store.get('alice');
  assert.deepEqual(after.readStates, before.readStates); assert.deepEqual(after.readPositions, before.readPositions);
  assert.deepEqual(after.bookmarks, before.bookmarks); assert.deepEqual(after.groups, before.groups);
  assert.equal(store.getReadStats('alice', 'g').unreadCount, 2);
  assert.equal(store.queryMessages('alice', { senderId: 'other-same-name' }).total, 0);
  assert.equal(store.queryMessages('alice', { senderId: 'keep' }).total, 1);
});

test('summary citations always retained; optional summary ranges protect newly synchronized records in the original range', t => {
  const { store } = setup(t);
  const summary = saveSummary(store);
  store.mergeMessages('alice', [], [msg('new', { time: START + 2 * 60000 + 30000, text: '迟到的时段消息' })], { history: true });
  const withRange = store.previewMessageCleanup('alice', selection());
  assert.equal(withRange.reasonCounts.summaryReference, 2);
  assert.equal(withRange.reasonCounts.summaryRange, 3);
  const withoutRange = store.previewMessageCleanup('alice', selection({ retainSummaryRanges: false }));
  assert.equal(withoutRange.reasonCounts.summaryRange, undefined);
  assert.equal(withoutRange.reasonCounts.summaryReference, 2);
  apply(store, selection({ retainSummaryRanges: false }));
  assert.deepEqual(store.get('alice').summaries, [summary]);
  assert.deepEqual(store.queryMessages('alice').messages.map(m => m.id), ['2', '3']);
});

test('overlapping local/AI summary ranges remain half-open without inferred min/max coverage', t => {
  const { store } = setup(t);
  saveSummary(store, { mode: 'ai', start: START + 2 * 60000, end: START + 5 * 60000 });
  saveSummary(store, { start: START + 4 * 60000, end: START + 7 * 60000 });
  const preview = store.previewMessageCleanup('alice', selection());
  assert.equal(preview.reasonCounts.summaryRange, 5);
  assert.equal(preview.sample.find(m => m.id === '7').action, 'recycle');
});

test('missing summary provenance protects only known group and explains limitation', t => {
  const { store } = setup(t, [msg('1'), msg('2', { groupId: 'g2' })]);
  store.update('alice', state => state.summaries.push({ id: 'legacy', groupId: 'g', title: '旧摘要', body: '不能推断其范围', refs: [] }));
  const preview = store.previewMessageCleanup('alice', selection());
  assert.equal(preview.deleteCount, 0); assert.equal(preview.reasonCounts.uncertainSummary, 1); assert.equal(preview.warnings.length, 1);
  assert.equal(store.previewMessageCleanup('alice', selection({ groupId: 'g2' })).deleteCount, 1);
  assert.equal(store.previewMessageCleanup('alice', selection({ retainSummaryRanges: false })).deleteCount, 1);
});

test('malformed references protect conservatively even if optional range preservation is disabled', t => {
  const { store } = setup(t);
  saveSummary(store, { refs: [{ id: '2' }], mode: 'ai' });
  const preview = store.previewMessageCleanup('alice', selection({ retainSummaryRanges: false }));
  assert.equal(preview.deleteCount, 0); assert.equal(preview.reasonCounts.uncertainSummary, 11);
});

test('unbound old summary protects account instead of guessing a group from title', t => {
  const { store } = setup(t, [msg('1'), msg('2', { groupId: 'g2' })]);
  store.update('alice', state => state.summaries.push({ id: 'legacy', title: '合成群 二', refs: [] }));
  assert.equal(store.previewMessageCleanup('alice', selection()).deleteCount, 0);
  assert.equal(store.previewMessageCleanup('alice', selection({ groupId: 'g2' })).deleteCount, 0);
});

test('existing Notion summary/bookmark sources keep associations, and unknown old export blocks conservatively', t => {
  const { store } = setup(t);
  const summary = saveSummary(store);
  const bookmark = store.bookmark('alice', { groupId: 'g', messageIds: ['0'] });
  store.update('alice', state => { state.exports = {
    a: { sourceType: 'summary', sourceIds: [summary.id], summaryId: summary.id, status: 'completed' },
    b: { sourceType: 'bookmarks', sourceIds: [bookmark.id], status: 'partial' },
  }; });
  const before = store.get('alice'); const preview = store.previewMessageCleanup('alice', selection());
  assert.equal(preview.reasonCounts.exportReference, 3); assert.equal(preview.warnings.length, 0);
  apply(store); assert.deepEqual(store.get('alice').exports, before.exports);
  store.update('alice', state => { state.exports.c = { summaryId: 'already-deleted', status: 'completed' }; });
  const unknown = store.previewMessageCleanup('alice', selection());
  assert.equal(unknown.deleteCount, 0); assert.match(unknown.warnings.join(''), /来源已删除或无法追溯/);
});

test('stale previews reject after new matching arrivals, newly bookmarked rows or summary coverage changes', t => {
  const { store, file } = setup(t);
  let preview = store.previewMessageCleanup('alice', selection());
  store.mergeMessages('alice', [], [msg('arrival', { time: START + 1200 })], { history: true });
  let before = fs.readFileSync(file);
  assert.throws(() => store.applyMessageCleanup('alice', preview.selection, preview.fingerprint), /重新预览/);
  assert.deepEqual(fs.readFileSync(file), before);
  preview = store.previewMessageCleanup('alice', selection());
  store.bookmark('alice', { groupId: 'g', messageIds: ['0'] }); before = fs.readFileSync(file);
  assert.throws(() => store.applyMessageCleanup('alice', preview.selection, preview.fingerprint), /重新预览/);
  assert.deepEqual(fs.readFileSync(file), before);
  preview = store.previewMessageCleanup('alice', selection());
  saveSummary(store); before = fs.readFileSync(file);
  assert.throws(() => store.applyMessageCleanup('alice', preview.selection, preview.fingerprint), /重新预览/);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('fingerprint binds account, group, exact member selection and original message content', t => {
  const { store, file } = setup(t);
  store.ensureAccount({ id: 'bob', name: '合成账号乙', kind: 'import' });
  store.mergeMessages('bob', [{ id: 'g', name: '合成群' }], Array.from({ length: 11 }, (_, i) => msg(i)));
  const preview = store.previewMessageCleanup('alice', selection());
  assert.throws(() => store.applyMessageCleanup('bob', preview.selection, preview.fingerprint), /重新预览/);
  assert.throws(() => store.applyMessageCleanup('alice', selection({ retainSenderIds: ['nobody'] }), preview.fingerprint), /重新预览/);
  store.mergeMessages('alice', [], [msg('0', { text: '改变了预览正文' })]);
  const before = fs.readFileSync(file);
  assert.throws(() => store.applyMessageCleanup('alice', preview.selection, preview.fingerprint), /重新预览/);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('unrelated new group arrivals do not force a new cleanup preview', t => {
  const { store } = setup(t); const preview = store.previewMessageCleanup('alice', selection());
  store.mergeMessages('alice', [], [msg('g2-new', { groupId: 'g2', time: START })]);
  assert.equal(store.applyMessageCleanup('alice', preview.selection, preview.fingerprint).deletedCount, 11);
});

test('delete and restore persistence failures report error and leave account bytes identical', t => {
  const { store, file } = setup(t);
  const preview = store.previewMessageCleanup('alice', selection()); const before = fs.readFileSync(file);
  const write = store._write;
  store._write = () => { throw new Error('synthetic save failure'); };
  assert.throws(() => store.applyMessageCleanup('alice', preview.selection, preview.fingerprint), /synthetic save failure/);
  assert.deepEqual(fs.readFileSync(file), before);
  store._write = write;
  const result = apply(store); const deleted = fs.readFileSync(file);
  store._write = () => { throw new Error('synthetic restore failure'); };
  assert.throws(() => store.restoreMessageTrash('alice', result.batchId), /synthetic restore failure/);
  assert.deepEqual(fs.readFileSync(file), deleted);
  store._write = write;
});

test('restore is account scoped, idempotent, and old restored batch cannot restore a later re-deletion', t => {
  const { store } = setup(t); const first = apply(store);
  store.ensureAccount({ id: 'bob', name: '乙', kind: 'import' });
  assert.throws(() => store.restoreMessageTrash('bob', first.batchId), /找不到/);
  store.restoreMessageTrash('alice', first.batchId);
  const second = apply(store);
  assert.notEqual(first.batchId, second.batchId);
  assert.equal(store.restoreMessageTrash('alice', first.batchId).restored, false);
  assert.equal(store.queryMessages('alice').total, 0);
  store.restoreMessageTrash('alice', second.batchId); assert.equal(store.queryMessages('alice').total, 11);
});

test('same message IDs in other group/account are untouched and numeric strings retain precision', t => {
  const id = '9007199254740993123456789';
  const { store } = setup(t, [msg(id, { time: START }), msg(id, { time: START, groupId: 'g2' })]);
  store.ensureAccount({ id: 'bob', name: '乙', kind: 'import' }); store.mergeMessages('bob', [{ id: 'g', name: '乙群' }], [msg(id, { time: START })]);
  const result = apply(store);
  assert.equal(result.deletedCount, 1); assert.equal(store.queryMessages('alice', { groupId: 'g2' }).total, 1); assert.equal(store.queryMessages('bob').total, 1);
  assert.deepEqual(store.get('alice').messageTrash[0].messageIds, [id]);
});

test('reading or bookmarking recycled messages rejects without mutation', t => {
  const { store, file } = setup(t); apply(store);
  const before = fs.readFileSync(file);
  assert.throws(() => store.setReadPosition('alice', 'g', '0', { seenId: '0' }), /不存在/);
  assert.throws(() => store.bookmark('alice', { groupId: 'g', messageIds: ['0'] }), /不存在/);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('no-op empty cleanup and repeated restoration do not rewrite persistent bytes', t => {
  const { store, file } = setup(t);
  const result = apply(store); let before = fs.readFileSync(file);
  const preview = store.previewMessageCleanup('alice', selection());
  assert.equal(preview.alreadyDeletedCount, 11); assert.equal(preview.matchedCount, 0);
  assert.equal(store.applyMessageCleanup('alice', preview.selection, preview.fingerprint).deleted, false);
  assert.deepEqual(fs.readFileSync(file), before);
  store.restoreMessageTrash('alice', result.batchId); before = fs.readFileSync(file);
  assert.equal(store.restoreMessageTrash('alice', result.batchId).restored, false); assert.deepEqual(fs.readFileSync(file), before);
});

test('new arrivals above a recycled latest record still become unread and restored history does not add unread', t => {
  const { store } = setup(t);
  const result = apply(store);
  assert.equal(store.queryMessages('alice').total, 0);
  store.mergeMessages('alice', [], [msg('11')]);
  assert.equal(store.getReadStats('alice', 'g').unreadCount, 1);
  assert.equal(store.getReadStats('alice', 'g').firstUnreadId, '11');
  const before = store.get('alice').readStates;
  store.restoreMessageTrash('alice', result.batchId);
  assert.deepEqual(store.get('alice').readStates, before);
  assert.equal(store.getReadStats('alice', 'g').unreadCount, 1);
});

test('local recycle schema rejects corrupt batches atomically, preserves source files', t => {
  const { store, file } = setup(t); const deleted = apply(store); const before = fs.readFileSync(file);
  for (const mutate of [
    state => { state.messages[0].localDeletion.batchId = 'unknown'; },
    state => { state.messageTrash[0].messageIds.push('missing'); },
    state => { state.messageTrash[0].restoredAt = START; },
    state => { state.messageTrash[0].groupId = 'g2'; },
    state => { delete state.messages[0].localDeletion; },
    state => { state.messageTrash[0].messageIds.push(state.messageTrash[0].messageIds[0]); },
  ]) {
    assert.throws(() => store.update('alice', mutate), /回收/);
    assert.deepEqual(fs.readFileSync(file), before);
  }
  assert.equal(store.listMessageTrash('alice')[0].id, deleted.batchId);
});

test('large preview truncates samples without truncating deletion decisions', t => {
  const { store } = setup(t, Array.from({ length: 2500 }, (_, i) => msg(i, { time: START + i })));
  const preview = store.previewMessageCleanup('alice', selection());
  assert.equal(preview.deleteCount, 2500); assert.equal(preview.sample.length, 100); assert.equal(preview.sampleTruncated, true);
  const result = apply(store); assert.equal(result.deletedCount, 2500);
  assert.equal(store.restoreMessageTrash('alice', result.batchId).restoredCount, 2500);
});

test('cleanup helpers reject malformed fingerprints and batch IDs before any mutation', t => {
  const { store, file } = setup(t); const before = fs.readFileSync(file);
  assert.throws(() => store.applyMessageCleanup('alice', selection(), ''), /先预览/);
  assert.throws(() => store.restoreMessageTrash('alice', '../anything\n'), /ID 无效/);
  assert.throws(() => store.listMessageTrash('alice', { groupId: 1 }), /无效/);
  assert.deepEqual(fs.readFileSync(file), before);
  const state = store.get('alice'), preview = cleanup.previewMessageCleanup(state, selection());
  assert.throws(() => cleanup.applyMessageCleanup(state, selection(), preview.fingerprint, { now: () => -1 }), /有效/);
  assert.equal(state.messages.some(m => m.localDeletion), false);
});

test('nested post references persist/search/merge and survive local recycling without changing original text', t => {
  const reference = { kind: 'post', relation: 'repost', id: '9007199254740993123', url: 'https://m.weibo.cn/detail/9007199254740993123',
    author: '合成原作者', text: '引用原文可检索', images: [], state: 'ready' };
  const { store, root } = setup(t, [msg('0', { referenceVersion: 1, references: [reference] })]);
  assert.equal(store.queryMessages('alice', { keyword: '引用原文' }).total, 1);
  assert.equal(store.queryMessages('alice', { keyword: '合成原作者' }).total, 1);
  const result = apply(store);
  store.mergeMessages('alice', [], [msg('0', { referenceVersion: 1, references: [{ ...reference, text: '', state: 'unavailable' }] })]);
  const restarted = new Store(root);
  assert.equal(restarted.queryMessages('alice').total, 0);
  restarted.restoreMessageTrash('alice', result.batchId);
  const message = restarted.queryMessages('alice').messages[0];
  assert.equal(message.text, '合成原文 0'); assert.equal(message.referenceVersion, 1);
  assert.equal(message.references[0].text, '引用原文可检索');
  assert.equal(message.references[0].state, 'unavailable');
});

test('invalid reference metadata rejects before persistence', t => {
  const { store, file } = setup(t); const before = fs.readFileSync(file);
  assert.throws(() => store.mergeMessages('alice', [], [msg('100', { referenceVersion: 2 })]), /版本不受支持/);
  assert.throws(() => store.mergeMessages('alice', [], [msg('100', { references: [{ kind: 'post', relation: 'repost', state: 'ready', text: '', images: [], url: 'javascript:alert(1)' }] })]), /引用内容格式无效/);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('contradictory summary range or citation times never claim reliable coverage', t => {
  for (const overrides of [
    { refs: [{ id: '3', groupId: 'g', time: START + 5 * 60000 }] },
    { refs: [{ id: '3', groupId: 'g' }] },
    { refs: [{ id: '3', groupId: 'g2', time: START + 3 * 60000 }] },
  ]) {
    const { store } = setup(t);
    saveSummary(store, overrides);
    const preview = store.previewMessageCleanup('alice', selection());
    assert.equal(preview.deleteCount, 0); assert.equal(preview.summaryRanges.length, 0);
    assert.match(preview.warnings.join(''), /不一致/);
    assert.equal(preview.reasonCounts.uncertainSummary, 11);
  }
});

test('account serialized-byte budget rejects recycle before publishing an unreadable file', t => {
  const { store, file } = setup(t), before = fs.readFileSync(file);
  const preview = store.previewMessageCleanup('alice', selection());
  const realByteLength = Buffer.byteLength;
  const mocked = t.mock.method(Buffer, 'byteLength', (value, encoding) => {
    // Simulate the platform-reported serialized size without allocating 512MiB.
    return typeof value === 'string' && value.includes('"messageTrash":[{') ? 512 * 1024 * 1024 + 1 : realByteLength(value, encoding);
  });
  assert.throws(() => store.applyMessageCleanup('alice', preview.selection, preview.fingerprint), /512 MiB/);
  mocked.mock.restore();
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.readdirSync(path.dirname(file)).length, 1);
});

test('schema 2 activates only after actual recycling and survives restore, normal updates, sync and imports', t => {
  const { store, file, root } = setup(t);
  assert.equal(store.get('alice').schemaVersion, 1);
  const before = fs.readFileSync(file);
  store.previewMessageCleanup('alice', selection());
  assert.deepEqual(fs.readFileSync(file), before);
  apply(store, selection({ retainSenderIds: ['u1'] }));
  assert.equal(store.get('alice').schemaVersion, 1);
  const recycled = apply(store);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).schemaVersion, 2);
  store.update('alice', state => { state.settings.sample = 'retained'; });
  store.mergeMessages('alice', [], [msg('0', { text: '补全后的合成文字' })]);
  store.importData('alice', { groups: [], messages: [msg('1')] });
  assert.equal(store.get('alice').schemaVersion, 2);
  store.restoreMessageTrash('alice', recycled.batchId);
  const reopened = new Store(root);
  assert.equal(reopened.get('alice').schemaVersion, 2);
  assert.equal(reopened.queryMessages('alice').total, 11);
  reopened.update('alice', state => { state.schemaVersion = 1; });
  assert.equal(reopened.get('alice').schemaVersion, 2);
});

test('unreleased schema-1 recycled fixture normalizes in memory without write and upgrades on next save', t => {
  const { store, file, root } = setup(t); apply(store);
  const oldFixture = JSON.parse(fs.readFileSync(file, 'utf8')); oldFixture.schemaVersion = 1;
  fs.writeFileSync(file, JSON.stringify(oldFixture));
  const before = fs.readFileSync(file), reopened = new Store(root);
  assert.equal(reopened.get('alice').schemaVersion, 2); assert.equal(reopened.queryMessages('alice').total, 0);
  assert.deepEqual(fs.readFileSync(file), before);
  reopened.setImportant('alice', 'u1', true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).schemaVersion, 2);
});
