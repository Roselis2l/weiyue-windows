'use strict';

// Lifecycle regressions for 1.1.2's anchor-first reader. These exercise the
// existing storage contract; actual scroll geometry and trusted input belong
// to the Windows UI integration test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../app/core/store.cjs');

const ids = Array.from({ length: 12 }, (_, index) => String(9007199254740993123400n + BigInt(index)));
const message = (index, groupId = 'g', extra = {}) => ({
  id: ids[index], groupId, senderId: 'member', senderName: '模拟成员',
  text: `本地回归消息 ${index}`, time: 1000, ...extra
});
const group = id => ({ id, name: `模拟群 ${id}`, selected: true });
function setup(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(parent, 'weiyue-anchor-lifecycle-'));
  t.after(() => {
    const resolved = fs.realpathSync(directory);
    assert.equal(path.dirname(resolved).toLowerCase(), parent.toLowerCase());
    assert.ok(path.basename(resolved).startsWith('weiyue-anchor-lifecycle-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const store = new Store(directory);
  store.ensureAccount({ id: 'alice', name: '本地模拟账号', kind: 'import' });
  return { store, directory };
}
function fileFor(directory, accountId) {
  return fs.readdirSync(directory).map(name => path.join(directory, name))
    .find(file => JSON.parse(fs.readFileSync(file, 'utf8')).account.id === accountId);
}

test('old tail state can reopen at its anchor, survive enrichment and arrivals, then restart without consuming unread', t => {
  const { store, directory } = setup(t);
  store.mergeMessages('alice', [group('g')], [message(0), message(1), message(2)]);
  store.setReadPosition('alice', 'g', ids[1], { offset: -27.5, followTail: true, seenId: ids[1] });
  const savedBookmark = store.bookmark('alice', { groupId: 'g', messageIds: [ids[0]], note: '保留原收藏', tags: ['回归'] });
  store.update('alice', state => {
    state.settings.autoSyncEnabled = true;
    state.importantMembers = ['member'];
    state.exports.completed = { pageId: 'local-mock-id' };
  });
  store.mergeMessages('alice', [], [message(3)]);
  const beforeOpen = store.getReadStats('alice', 'g');
  assert.equal(beforeOpen.atBottom, true);
  assert.deepEqual(beforeOpen.unreadIds, [ids[3]]);

  // Opening/restoring changes geometry only, including normalization of a
  // legacy tail hint. It deliberately supplies no seenId.
  store.setReadPosition('alice', 'g', beforeOpen.anchorId, { offset: 0, followTail: false });
  store.mergeMessages('alice', [], [message(0, 'g', {
    mediaVersion: 1,
    images: [{ url: 'https://wx1.sinaimg.cn/mw690/local-regression.jpg', width: 640, height: 1600 }]
  })], { history: true });
  store.mergeMessages('alice', [], [message(4)]);
  store.setReadPosition('alice', 'g', ids[1], { offset: 0, followTail: false });

  const file = fileFor(directory, 'alice'), bytesBeforeReopen = fs.readFileSync(file);
  const reopened = new Store(directory), stats = reopened.getReadStats('alice', 'g');
  assert.equal(stats.anchorId, ids[1]);
  assert.equal(stats.anchorOffset, 0);
  assert.equal(stats.atBottom, false);
  assert.equal(stats.readThroughId, ids[1]);
  assert.deepEqual(stats.unreadIds, [ids[3], ids[4]]);
  assert.equal(stats.unreadCount, 2);
  const state = reopened.get('alice');
  assert.equal(state.readPositions.g, ids[1]);
  assert.deepEqual(state.messages.map(row => row.id), ids.slice(0, 5));
  assert.equal(state.messages[0].images[0].height, 1600);
  assert.deepEqual(state.bookmarks, [savedBookmark]);
  assert.equal(state.settings.autoSyncEnabled, true);
  assert.deepEqual(state.importantMembers, ['member']);
  assert.deepEqual(state.exports.completed, { pageId: 'local-mock-id' });
  assert.deepEqual(fs.readFileSync(file), bytesBeforeReopen, 'reading persisted state must not rewrite the account');
});

test('an explicit seen snapshot cannot consume arrivals after that snapshot, and later passive saves preserve them', t => {
  const { store, directory } = setup(t);
  store.mergeMessages('alice', [group('g')], [message(0)]);
  store.setReadPosition('alice', 'g', ids[0], { offset: 0, followTail: false, seenId: ids[0] });
  store.mergeMessages('alice', [], [1, 2, 3, 4, 5].map(index => message(index)));

  const actuallySeen = ids[2];
  store.mergeMessages('alice', [], [message(6)]);
  store.setReadPosition('alice', 'g', ids[1], { offset: -10, followTail: false, seenId: actuallySeen });
  assert.deepEqual(store.getReadStats('alice', 'g').unreadIds, ids.slice(3, 7));
  // A delayed passive anchor save does not rewind the high-water mark or mark
  // the newly received message read, even when its anchor is much earlier.
  store.setReadPosition('alice', 'g', ids[0], { offset: 0, followTail: false });
  let stats = new Store(directory).getReadStats('alice', 'g');
  assert.equal(stats.anchorId, ids[0]);
  assert.equal(stats.readThroughId, actuallySeen);
  assert.deepEqual(stats.unreadIds, ids.slice(3, 7));

  store.setReadPosition('alice', 'g', ids[6], { offset: 0, followTail: false, seenId: ids[6] });
  assert.equal(store.getReadStats('alice', 'g').unreadCount, 0);
  store.mergeMessages('alice', [], [message(7)]);
  store.setReadPosition('alice', 'g', ids[5], { offset: 0, followTail: false, seenId: null });
  stats = new Store(directory).getReadStats('alice', 'g');
  assert.equal(stats.readThroughId, ids[6]);
  assert.deepEqual(stats.unreadIds, [ids[7]]);
});

test('switching and reopening anchors is independent for two groups and accounts sharing the same message IDs', t => {
  const { store, directory } = setup(t);
  store.ensureAccount({ id: 'bob', name: '另一模拟账号', kind: 'import' });
  for (const owner of ['alice', 'bob']) {
    store.mergeMessages(owner, [group('g'), group('h')], [message(0), message(1), message(0, 'h'), message(1, 'h')]);
    for (const groupId of ['g', 'h']) {
      store.setReadPosition(owner, groupId, ids[0], { offset: -13, followTail: true, seenId: ids[0] });
      store.mergeMessages(owner, [], [message(2, groupId), message(3, groupId)]);
    }
  }
  const otherFile = fileFor(directory, 'bob'), otherBytes = fs.readFileSync(otherFile);
  for (const groupId of ['g', 'h', 'g', 'h', 'g']) {
    const state = store.getReadStats('alice', groupId);
    store.setReadPosition('alice', groupId, state.anchorId, { offset: 0, followTail: false });
  }
  const reopened = new Store(directory);
  for (const groupId of ['g', 'h']) {
    const actual = reopened.getReadStats('alice', groupId);
    assert.equal(actual.anchorId, ids[0]);
    assert.equal(actual.anchorOffset, 0);
    assert.equal(actual.readThroughId, ids[0]);
    assert.equal(actual.atBottom, false);
    assert.deepEqual(actual.unreadIds, [ids[2], ids[3]]);
  }
  assert.deepEqual(fs.readFileSync(otherFile), otherBytes);
  assert.equal(reopened.getReadStats('bob', 'g').atBottom, true);
  assert.equal(reopened.getReadStats('bob', 'g').anchorOffset, -13);
});
