'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cleanup = require('../app/core/message-cleanup.cjs');
const START = Date.parse('2026-10-21T09:00:00+08:00');
const clone = value => structuredClone(value);
const selection = extra => ({ groupId: 'g', startMinute: '2026-10-21T09:00', endMinute: '2026-10-21T09:10', ...extra });
const msg = (id, extra) => ({ id: String(id), groupId: 'g', senderId: 'member', senderName: '合成成员', text: `合成正文 ${id}`, time: START + Number(id) * 60000, ...extra });
function state() {
  return { schemaVersion: 1, account: { id: 'synthetic', name: '合成', kind: 'import' }, groups: [{ id: 'g', name: '合成群' }, { id: 'other', name: '合成另一群' }],
    messages: Array.from({ length: 11 }, (_, i) => msg(i)), messageTrash: [], bookmarks: [], summaries: [], readStates: {}, readPositions: {}, exports: {} };
}
function apply(s, input = selection(), options) {
  const plan = cleanup.previewMessageCleanup(s, input);
  return cleanup.applyMessageCleanup(s, plan.selection, plan.fingerprint, options);
}
function purge(s, ids, options) {
  const plan = cleanup.previewMessagePurge(s, { groupId: 'g', batchIds: ids });
  return cleanup.applyMessagePurge(s, plan.selection, plan.fingerprint, options);
}

test('mode defaults to reversible recycling and rejects unknown/destructive aliases', () => {
  assert.equal(cleanup.normalizeSelection(selection()).mode, 'recycle');
  assert.equal(cleanup.normalizeSelection(selection({ mode: 'permanent' })).mode, 'permanent');
  for (const mode of ['purge', 'delete', true, null, 1]) assert.throws(() => cleanup.normalizeSelection(selection({ mode })));
});

test('permanent preview is read-only and binds mode and exact minute scope', () => {
  const s = state(), before = clone(s), input = selection({ mode: 'permanent', endMinute: '2026-10-21T09:00' });
  s.messages.push(msg('edge', { time: START + 59999 })); before.messages = clone(s.messages);
  const plan = cleanup.previewMessageCleanup(s, input);
  assert.equal(plan.mode, 'permanent'); assert.equal(plan.deleteCount, 2);
  assert.deepEqual(plan.sample.map(row => row.action), ['permanent', 'permanent']);
  assert.match(plan.recycleNote, /不能从本地回收区恢复/);
  assert.deepEqual(s, before);
  assert.throws(() => cleanup.applyMessageCleanup(s, { ...plan.selection, mode: 'recycle' }, plan.fingerprint), /重新预览/);
  assert.deepEqual(s, before);
});

test('permanent deletion removes body sender and media, retains only minimal stable identity', () => {
  const s = state(); s.messages[0].images = [{ url: 'https://example.invalid/synthetic.png' }];
  const removed = clone(s.messages[0]);
  const result = apply(s, selection({ mode: 'permanent', endMinute: '2026-10-21T09:00' }));
  assert.equal(result.deletedCount, 1); assert.equal(result.mode, 'permanent'); assert.equal(result.batchId, null);
  assert.equal(s.messages.length, 10); assert(!s.messages.some(m => m.id === '0')); assert.equal(s.schemaVersion, 3);
  assert.deepEqual(s.messageTombstones, [{ groupId: 'g', id: '0', time: removed.time }]);
  assert.equal(s.messageTrash.length, 0);
  assert(!JSON.stringify(s).includes(removed.text)); assert(!JSON.stringify(s).includes('synthetic.png'));
});

test('permanent mode retains all protected references, stable members, unread and sync anchors', () => {
  const s = state();
  s.bookmarks = [{ id: 'saved', groupId: 'g', messageIds: ['0'] }];
  s.summaries = [{ id: 'summary', groupId: 'g', start: START + 60000, end: START + 2 * 60000, refs: [{ id: '1', groupId: 'g', time: START + 60000 }] }];
  s.exports = { exported: { sourceType: 'summary', sourceIds: ['summary'] } };
  s.readPositions = { g: '2' }; s.readStates = { g: { anchorId: '3', readThroughId: '4', unreadIds: ['5'] } };
  s.groups[0].latestPendingRanges = [{ arrivalAfterId: '6' }]; s.messages[7].senderId = 'keep';
  const before = clone(s); const plan = cleanup.previewMessageCleanup(s, selection({ mode: 'permanent', retainSenderIds: ['keep'] }));
  assert.equal(plan.deleteCount, 3);
  cleanup.applyMessageCleanup(s, plan.selection, plan.fingerprint);
  assert.deepEqual(s.messages.map(m => m.id), ['0', '1', '2', '3', '4', '5', '6', '7']);
  for (const key of ['bookmarks', 'summaries', 'exports', 'readPositions', 'readStates', 'groups']) assert.deepEqual(s[key], before[key]);
});

test('missing summary/export provenance conservatively prevents permanent content loss', () => {
  const s = state(); s.summaries = [{ id: 'legacy', groupId: 'g', refs: [] }];
  const before = clone(s), plan = cleanup.previewMessageCleanup(s, selection({ mode: 'permanent' }));
  assert.equal(plan.deleteCount, 0); assert.equal(plan.reasonCounts.uncertainSummary, 11);
  assert.equal(cleanup.applyMessageCleanup(s, plan.selection, plan.fingerprint).deleted, false); assert.deepEqual(s, before);
  s.summaries = []; s.exports = { old: { sourceType: 'summary', sourceIds: ['missing'] } };
  assert.equal(cleanup.previewMessageCleanup(s, selection({ mode: 'permanent' })).deleteCount, 0);
});

test('purge exact selected batch leaves other batch/group untouched and removes target content', () => {
  const s = state(); s.messages.push(msg('0', { groupId: 'other', text: '另群合成正文' }));
  const first = apply(s, selection({ endMinute: '2026-10-21T09:01' }));
  const second = apply(s, selection({ startMinute: '2026-10-21T09:02', endMinute: '2026-10-21T09:03' }));
  const secondBefore = clone(s.messageTrash.find(b => b.id === second.batchId));
  const result = purge(s, [first.batchId]);
  assert.equal(result.purgedCount, 2); assert.equal(result.batchCount, 1);
  assert.deepEqual(s.messageTrash, [secondBefore]);
  assert(s.messages.some(m => m.groupId === 'other' && m.id === '0'));
  assert.deepEqual(s.messageTombstones.map(m => m.id), ['0', '1']);
  assert.equal(cleanup.validateMessageTrash(s.messageTrash, s.messages, s.groups).length, 1);
});

test('purge multiple batches reports exact envelope, batch count and immutable preview', () => {
  const s = state();
  const first = apply(s, selection({ endMinute: '2026-10-21T09:00' }));
  const second = apply(s, selection({ startMinute: '2026-10-21T09:09', endMinute: '2026-10-21T09:10' }));
  const before = clone(s), plan = cleanup.previewMessagePurge(s, { groupId: 'g', batchIds: [second.batchId, first.batchId] });
  assert.equal(plan.batchCount, 2); assert.equal(plan.matchedCount, 3); assert.equal(plan.deleteCount, 3);
  assert.deepEqual(plan.range, { start: START, end: START + 11 * 60000 }); assert.deepEqual(s, before);
  cleanup.applyMessagePurge(s, plan.selection, plan.fingerprint);
  assert.equal(s.messageTrash.length, 0); assert.equal(s.messageTombstones.length, 3);
});

test('purge rejects another group, restored, missing or repeated batches without mutation', () => {
  const s = state(); const batch = apply(s, selection({ endMinute: '2026-10-21T09:00' }));
  for (const input of [{ groupId: 'other', batchIds: [batch.batchId] }, { groupId: 'g', batchIds: ['missing'] }, { groupId: 'g', batchIds: [] }, { groupId: 'g', batchIds: [batch.batchId, batch.batchId] }]) {
    const before = clone(s); assert.throws(() => cleanup.previewMessagePurge(s, input)); assert.deepEqual(s, before);
  }
  cleanup.restoreMessageTrash(s, batch.batchId);
  assert.throws(() => cleanup.previewMessagePurge(s, { groupId: 'g', batchIds: [batch.batchId] }), /已恢复/);
});

test('purge stale preview rejects newly protected summary citations and permits only unprotected subset after re-preview', () => {
  const s = state(), batch = apply(s, selection({ endMinute: '2026-10-21T09:02' }));
  const plan = cleanup.previewMessagePurge(s, { groupId: 'g', batchIds: [batch.batchId] });
  s.summaries.push({ id: 'new', groupId: 'g', start: START, end: START + 60000, refs: [{ id: '0', groupId: 'g', time: START }] });
  const before = clone(s);
  assert.throws(() => cleanup.applyMessagePurge(s, plan.selection, plan.fingerprint), /重新预览/); assert.deepEqual(s, before);
  const current = cleanup.previewMessagePurge(s, plan.selection); assert.equal(current.retainedCount, 1); assert.equal(current.deleteCount, 2);
  cleanup.applyMessagePurge(s, current.selection, current.fingerprint);
  assert.deepEqual(s.messageTrash[0].messageIds, ['0']); assert(s.messages.find(m => m.id === '0').localDeletion);
  assert.deepEqual(s.summaries, before.summaries); cleanup.validateMessageTrash(s.messageTrash, s.messages, s.groups);
});

test('permanent deletion trims restored historical batch references without harming another active batch', () => {
  const s = state(), first = apply(s, selection({ endMinute: '2026-10-21T09:02' }));
  cleanup.restoreMessageTrash(s, first.batchId);
  const second = apply(s, selection({ startMinute: '2026-10-21T09:01', endMinute: '2026-10-21T09:01' }));
  apply(s, selection({ mode: 'permanent', endMinute: '2026-10-21T09:00' }));
  assert.deepEqual(s.messageTrash.find(b => b.id === first.batchId).messageIds, ['1', '2']);
  assert.deepEqual(s.messageTrash.find(b => b.id === second.batchId).messageIds, ['1']);
  cleanup.validateMessageTrash(s.messageTrash, s.messages, s.groups);
  purge(s, [second.batchId]);
  assert.deepEqual(s.messageTrash.find(b => b.id === first.batchId).messageIds, ['2']);
  cleanup.validateMessageTrash(s.messageTrash, s.messages, s.groups);
});

test('schema3 survives later recycle and restore, and zero-op does not migrate schema', () => {
  const s = state(); apply(s, selection({ mode: 'permanent', endMinute: '2026-10-21T09:00' }));
  const batch = apply(s, selection({ startMinute: '2026-10-21T09:01', endMinute: '2026-10-21T09:01' }));
  assert.equal(s.schemaVersion, 3); cleanup.restoreMessageTrash(s, batch.batchId); assert.equal(s.schemaVersion, 3);
  const untouched = state(), before = clone(untouched);
  const plan = cleanup.previewMessageCleanup(untouched, selection({ mode: 'permanent', retainSenderIds: ['member'] }));
  assert.equal(cleanup.applyMessageCleanup(untouched, plan.selection, plan.fingerprint).deleted, false); assert.deepEqual(untouched, before);
});

test('minimal markers reject duplicate/overlap/invalid fields/unsafe IDs and preserve long string identity', () => {
  const s = state(), valid = { groupId: 'g', id: '900719925474099312345', time: START };
  assert.deepEqual(cleanup.validateMessageTombstones(undefined, s.messages, s.groups), []);
  assert.deepEqual(cleanup.validateMessageTombstones([valid], s.messages, s.groups), [valid]);
  for (const raw of [[valid, valid], [{ ...valid, id: '0' }], [{ ...valid, groupId: 'missing' }], [{ ...valid, time: NaN }], [{ ...valid, id: Number.MAX_SAFE_INTEGER + 1 }], [{ ...valid, text: 'leak' }], [{ ...valid, senderId: 'leak' }], [{ ...valid, id: ' padded' }], [null], new Array(1), {}])
    assert.throws(() => cleanup.validateMessageTombstones(raw, s.messages, s.groups));
});

test('permanent deletion validates all markers before changing state and emits real bounded progress', () => {
  const s = state(); s.messageTombstones = [{ groupId: 'g', id: '0', time: START }];
  const before = clone(s), plan = cleanup.previewMessageCleanup(s, selection({ mode: 'permanent' }));
  assert.throws(() => cleanup.applyMessageCleanup(s, plan.selection, plan.fingerprint), /重复|冲突/); assert.deepEqual(s, before);
  const large = state(); large.messages = Array.from({ length: 5001 }, (_, i) => msg(i, { time: START + i }));
  const observations = [], largePlan = cleanup.previewMessageCleanup(large, selection({ mode: 'permanent' }));
  cleanup.applyMessageCleanup(large, largePlan.selection, largePlan.fingerprint, { onProgress: value => observations.push(value) });
  const processing = observations.filter(value => value.phase === 'processing');
  assert.deepEqual(processing.map(p => p.processed), [0, 2048, 4096, 5001]);
  assert(processing.every(p => p.total === 5001)); assert.equal(large.messageTombstones.length, 5001);
});

test('recycle batch validator rejects forged permanent selections', () => {
  const s = state(); apply(s, selection({ endMinute: '2026-10-21T09:00' }));
  s.messageTrash[0].selection.mode = 'permanent';
  assert.throws(() => cleanup.validateMessageTrash(s.messageTrash, s.messages, s.groups), /永久删除/);
});

test('legacy recycle selection remains byte-equivalent on normalization, without a new mode field', () => {
  const s = state(); apply(s, selection({ endMinute: '2026-10-21T09:00' }));
  delete s.messageTrash[0].selection.mode;
  const before = clone(s.messageTrash);
  const normalized = cleanup.validateMessageTrash(s.messageTrash, s.messages, s.groups);
  assert.deepEqual(normalized, before);
  assert.equal(Object.hasOwn(normalized[0].selection, 'mode'), false);
  const plan = cleanup.previewMessagePurge(s, { groupId: 'g', batchIds: [s.messageTrash[0].id] });
  assert.equal(plan.deleteCount, 1);
});
