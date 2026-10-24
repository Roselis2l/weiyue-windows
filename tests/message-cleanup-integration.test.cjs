'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Store, visibleMessages } = require('../app/core/store.cjs');
const { syncAccount } = require('../app/core/sync-service.cjs');
const { prepareSummary, localSummary } = require('../app/core/summary.cjs');
const { resolveNotionSource, buildPreview } = require('../app/core/notion.cjs');
const { createMessageCleanupController } = require('../app/core/message-cleanup-controller.cjs');

const START = Date.parse('2026-10-21T09:00:00+08:00');
const TARGET = '11111111-1111-4111-8111-111111111111';
const message = (id, groupId = 'g') => ({ id: String(id), groupId, senderId: 'synthetic-member', senderName: 'Synthetic member', text: `Synthetic message ${id}`, time: START + (Number(id) - 100) * 60000 });
const payload = { accountId: 'synthetic-a', groupId: 'g', startMinute: '2026-10-21T09:00', endMinute: '2026-10-21T09:06', retainSummaryRanges: true, retainSenderIds: [] };

function fixture(t) {
  const base = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'weiyue-recycle-integration-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), base);
    assert.ok(path.basename(root).startsWith('weiyue-recycle-integration-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const store = new Store(root);
  for (const accountId of ['synthetic-a', 'synthetic-b']) {
    store.ensureAccount({ id: accountId, name: 'Synthetic account', kind: 'weibo' });
    store.mergeMessages(accountId, [{ id: 'g', name: 'Synthetic group', selected: true, nextCursor: '90' }, { id: 'h', name: 'Other synthetic group', selected: false }], [100, 101, 102, 103, 104, 105, 106].map(id => message(id)).concat(message(100, 'h')));
  }
  store.setReadPosition('synthetic-a', 'g', '100', { seenId: '100', offset: 19, followTail: false });
  const bookmark = store.bookmark('synthetic-a', { groupId: 'g', messageIds: ['101'], note: 'Synthetic note', tags: ['Synthetic tag'] });
  const state = store.get('synthetic-a');
  const summary = localSummary(prepareSummary({ messages: state.messages, group: state.groups[0], start: START + 120000, end: START + 240000 }));
  store.update('synthetic-a', s => {
    s.summaries.push(summary);
    s.exports.synthetic = { summaryId: summary.id, sourceType: 'summary', sourceIds: [summary.id], status: 'completed' };
    s.readStates.g.unreadIds = ['104'];
    s.groups[0].latestPendingRanges = [{ cursor: '103', baselineId: '100', arrivalAfterId: '100', status: 'pending' }];
  });
  const sourceHashes = store => [
    buildPreview(resolveNotionSource(store.get('synthetic-a'), { summaryId: summary.id }), TARGET, { editable: true }).sourceHash,
    buildPreview(resolveNotionSource(store.get('synthetic-a'), { bookmarkIds: [bookmark.id] }), TARGET, { editable: true }).sourceHash,
  ];
  return { root, store, bookmark, summary, sourceHashes };
}

test('recycle/restart/continuous sync preserve the raw frontier, unread/anchors and both export source paths', async t => {
  const f = fixture(t), before = f.store.get('synthetic-a'), otherBytes = fs.readFileSync(f.store._file('synthetic-b'));
  const hashes = f.sourceHashes(f.store), groupOther = before.groups.find(g => g.id === 'h');
  const controller = createMessageCleanupController({ store: f.store, asyncOperations:false, getContext: () => ({ accountId: 'synthetic-a', epoch: 1, busy: false, closing: false }) });
  const preview = controller.preview(payload);
  assert.equal(preview.deleteCount, 2);
  assert.deepEqual(preview.sample.filter(m => m.action === 'recycle').map(m => m.id), ['105', '106']);
  assert.equal(preview.reasonCounts.bookmark, 1); assert.equal(preview.reasonCounts.summaryReference, 2);
  assert.equal(preview.reasonCounts.exportReference, 2); assert.equal(preview.reasonCounts.unread, 1);
  const applied = controller.apply({ ...payload, confirmed: true, confirmationToken: preview.confirmationToken });
  const reopened = new Store(f.root);
  assert.equal(reopened.getReadStats('synthetic-a', 'g').latestMessageId, '104');
  assert.deepEqual(reopened.get('synthetic-a').readStates, before.readStates);
  const calls = [], pages = [[107, 106], [103, 100]];
  let clock = START + 3600000;
  const result = await syncAccount({ store: reopened, accountId: 'synthetic-a', continuous: true,
    maxPages: 2, now: () => clock, sleep: async ms => { clock += ms; }, pageDelayMs: 600,
    client: { async syncGroup(groupId, options) {
      calls.push({ groupId, before: options.before, stopAtId: options.stopAtId });
      const ids = pages.shift(); assert.ok(ids, 'No unexpected network-like requests');
      await options.onPage({ messages: ids.map(id => message(id, groupId)), nextCursor: String(Math.min(...ids) - 1), reachedStop: true,
        coverage: { oldest: message(Math.min(...ids)).time, newest: message(Math.max(...ids)).time, complete: false, note: 'Synthetic page' } });
      return { pages: 1 };
    } },
  });
  assert.deepEqual(calls, [{ groupId: 'g', before: undefined, stopAtId: '106' }, { groupId: 'g', before: '103', stopAtId: '100' }]);
  assert.equal(result.count, 1); assert.equal(result.pages, 2);
  const synced = new Store(f.root), after = synced.get('synthetic-a'), read = synced.getReadStats('synthetic-a', 'g');
  assert.equal(after.schemaVersion, 2);
  assert.deepEqual(after.messages.filter(m => m.localDeletion).map(m => m.id), ['105', '106']);
  assert.deepEqual(read.unreadIds, ['104', '107']);
  assert.equal(read.anchorId, '100'); assert.equal(read.readThroughId, '100'); assert.equal(read.anchorOffset, 19);
  assert.equal(after.groups.find(g => g.id === 'g').latestPending, null);
  assert.equal(after.groups.find(g => g.id === 'g').nextCursor, '90');
  assert.deepEqual(after.groups.find(g => g.id === 'h'), groupOther);
  assert.deepEqual(after.bookmarks, before.bookmarks); assert.deepEqual(after.summaries, before.summaries); assert.deepEqual(after.exports, before.exports);
  assert.deepEqual(f.sourceHashes(synced), hashes);
  const freshSummary = prepareSummary({ messages: visibleMessages(after.messages), group: after.groups[0], start: START, end: START + 480000 });
  assert.ok(!localSummary(freshSummary).refs.some(ref => ['105', '106'].includes(ref.id)));
  const readBeforeRestore = after.readStates;
  assert.equal(synced.restoreMessageTrash('synthetic-a', applied.batchId).restoredCount, 2);
  assert.deepEqual(synced.get('synthetic-a').readStates, readBeforeRestore);
  assert.deepEqual(f.sourceHashes(synced), hashes);
  assert.equal(synced.queryMessages('synthetic-a', { groupId: 'g' }).total, 8);
  assert.deepEqual(fs.readFileSync(synced._file('synthetic-b')), otherBytes);
});

test('removing a saved export source makes recycling conservative across reload without touching the journal', t => {
  const f = fixture(t), initialJournal = f.store.get('synthetic-a').exports;
  assert.equal(f.store.removeSummary('synthetic-a', f.summary.id, 'g').deleted, true);
  const store = new Store(f.root), before = fs.readFileSync(store._file('synthetic-a'));
  const preview = store.previewMessageCleanup('synthetic-a', { ...payload, retainSummaryRanges: false });
  assert.equal(preview.deleteCount, 0); assert.equal(preview.reasonCounts.uncertainExport, 7);
  assert.equal(preview.warnings.length, 1);
  const result = store.applyMessageCleanup('synthetic-a', preview.selection, preview.fingerprint);
  assert.equal(result.deleted, false);
  assert.deepEqual(store.get('synthetic-a').exports, initialJournal);
  assert.deepEqual(fs.readFileSync(store._file('synthetic-a')), before);
});
