'use strict';

// Store-level regressions only: all accounts/messages live in a fresh temporary
// directory. Trusted input, dwell, and UI navigation are tested by UI suites.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Store } = require('../app/core/store.cjs');

const group = id => ({ id, name: `合成群 ${id}`, selected: true });
const message = (id, time, extra = {}) => ({
  id, time, groupId: 'g', senderId: 'member-a', senderName: '合成成员',
  text: `合成消息 ${id}`, ...extra
});
const fileFor = (root, id) => path.join(root,
  `account-${createHash('sha256').update(id).digest('hex')}.json`);
function setup(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'weiyue-read-highwater-'));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved).toLowerCase(), parent.toLowerCase());
    assert.ok(path.basename(resolved).startsWith('weiyue-read-highwater-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const store = new Store(root);
  store.ensureAccount({ id: 'alice', name: '合成账号 A', kind: 'import' });
  return { store, root };
}
function checkpoint(store, accountId = 'alice', groupId = 'g') {
  const { readThroughId, unreadIds, unreadCount, firstUnreadId } =
    store.getReadStats(accountId, groupId);
  return { readThroughId, unreadIds, unreadCount, firstUnreadId };
}
function seen(store, id, accountId = 'alice', groupId = 'g') {
  store.setReadPosition(accountId, groupId, id, { seenId: id, offset: 0, followTail: false });
}

test('high water follows message time even when later messages have smaller decimal IDs', t => {
  const { store } = setup(t);
  const early = message('99999999999999999999999999', 1000);
  const middle = message('2', 2000), latest = message('1', 3000);
  store.mergeMessages('alice', [group('g')], [early]);
  seen(store, early.id);
  store.mergeMessages('alice', [], [latest, middle]);
  assert.equal(store.getReadStats('alice', 'g').firstUnreadId, middle.id);
  seen(store, middle.id);
  assert.deepEqual(checkpoint(store), {
    readThroughId: middle.id, unreadIds: [latest.id], unreadCount: 1, firstUnreadId: latest.id
  });
  seen(store, early.id);
  assert.equal(store.getReadStats('alice', 'g').anchorId, early.id);
  assert.equal(store.getReadStats('alice', 'g').readThroughId, middle.id);
  seen(store, latest.id);
  seen(store, middle.id);
  assert.equal(store.getReadStats('alice', 'g').readThroughId, latest.id);
  assert.equal(store.getReadStats('alice', 'g').unreadCount, 0);
});

test('equal-time decimal IDs advance numerically without losing unsafe-integer precision', t => {
  const { store } = setup(t);
  const ids = ['9', '10', '9007199254740993123400', '9007199254740993123401'];
  store.mergeMessages('alice', [group('g')], [message(ids[0], 1000)]);
  seen(store, ids[0]);
  store.mergeMessages('alice', [], [3, 1, 2].map(index => message(ids[index], 1000)));
  assert.deepEqual(store.queryMessages('alice', { groupId: 'g' }).messages.map(row => row.id), ids);
  seen(store, ids[1]);
  seen(store, ids[0]);
  assert.equal(store.getReadStats('alice', 'g').readThroughId, ids[1]);
  seen(store, ids[2]);
  assert.deepEqual(checkpoint(store), {
    readThroughId: ids[2], unreadIds: [ids[3]], unreadCount: 1, firstUnreadId: ids[3]
  });
  seen(store, ids[3]);
  seen(store, ids[2]);
  assert.equal(store.getReadStats('alice', 'g').readThroughId, ids[3]);
  assert.equal(store.getReadStats('alice', 'g').unreadCount, 0);
});

test('equal-time nondecimal IDs preserve string order and cannot rewind high water', t => {
  const { store } = setup(t);
  const ids = ['alpha-10', 'alpha-2', 'beta-1'];
  store.mergeMessages('alice', [group('g')], [message(ids[0], 1000)]);
  seen(store, ids[0]);
  store.mergeMessages('alice', [], [message(ids[2], 1000), message(ids[1], 1000)]);
  seen(store, ids[1]);
  seen(store, ids[0]);
  assert.deepEqual(checkpoint(store), {
    readThroughId: ids[1], unreadIds: [ids[2]], unreadCount: 1, firstUnreadId: ids[2]
  });
  assert.deepEqual(store.queryMessages('alice', { groupId: 'g' }).messages.map(row => row.id), ids);
});

test('a delayed old seen snapshot neither rewinds high water nor consumes a newer arrival', t => {
  const { store } = setup(t);
  store.mergeMessages('alice', [group('g')], [message('1', 1000)]);
  seen(store, '1');
  store.mergeMessages('alice', [], ['2', '3', '4'].map(id => message(id, 1000)));
  seen(store, '3');
  const beforeArrival = checkpoint(store);
  store.mergeMessages('alice', [], [message('5', 1000)]);
  const expected = { ...beforeArrival, unreadIds: ['4', '5'], unreadCount: 2 };
  for (const oldSeen of ['2', '1', '3', '2']) {
    store.setReadPosition('alice', 'g', oldSeen, { offset: -20, seenId: oldSeen });
    assert.deepEqual(checkpoint(store), expected);
    assert.equal(store.getReadStats('alice', 'g').anchorId, oldSeen);
  }
});

test('explicit options without seenId save only the anchor including latest jumps and tail hints', t => {
  const { store } = setup(t);
  store.mergeMessages('alice', [group('g')], [message('1', 1000)]);
  seen(store, '1');
  store.mergeMessages('alice', [], ['2', '3', '4'].map(id => message(id, 1000)));
  const before = checkpoint(store);
  const cases = [
    { id: '4', options: undefined },
    { id: '2', options: {} },
    { id: '4', options: { followTail: true, offset: -11 } },
    { id: '3', options: { seenId: null, followTail: false, offset: 25 } },
    { id: '1', options: { seenId: undefined, offset: 0 } }
  ];
  for (const entry of cases) {
    // Fourth argument is intentional, even when undefined. The legacy
    // three-argument call carries a distinct explicit-read compatibility contract.
    store.setReadPosition('alice', 'g', entry.id, entry.options);
    assert.equal(store.getReadStats('alice', 'g').anchorId, entry.id);
    assert.deepEqual(checkpoint(store), before);
  }
});

test('queries and member/date/keyword filters are read-only and do not clear unread', t => {
  const { store, root } = setup(t);
  store.mergeMessages('alice', [group('g')], [message('1', 1000)]);
  seen(store, '1');
  store.mergeMessages('alice', [], [
    message('2', 2000, { senderId: 'member-b', text: '合成关键词' }),
    message('3', 3000, { text: '另一条合成关键词' }),
    message('4', 4000)
  ]);
  store.setImportant('alice', 'member-b', true);
  const before = checkpoint(store), bytes = fs.readFileSync(fileFor(root, 'alice'));
  const cases = [
    [{ groupId: 'g', limit: 1, offset: 3 }, ['4']],
    [{ groupId: 'g', senderId: 'member-b' }, ['2']],
    [{ groupId: 'g', senderIds: ['member-b', 'member-b'] }, ['2']],
    [{ groupId: 'g', senderIds: ['member-a', 'member-b'] }, ['1', '2', '3', '4']],
    [{ groupId: 'g', senderId: 'member-a', senderIds: ['member-b'] }, []],
    [{ groupId: 'g', keyword: '关键词' }, ['2', '3']],
    [{ groupId: 'g', start: 2000, end: 3000 }, ['2']],
    [{ groupId: 'g', importantOnly: true }, ['2']],
    [{ groupId: 'g', keyword: '没有这个合成词' }, []],
    [{ groupId: 'g' }, ['1', '2', '3', '4']]
  ];
  for (const [query, expectedIds] of cases) {
    assert.deepEqual(store.queryMessages('alice', query).messages.map(row => row.id), expectedIds);
    assert.deepEqual(checkpoint(store), before);
    assert.deepEqual(fs.readFileSync(fileFor(root, 'alice')), bytes);
  }
});

test('older history and repeated detail enrichment do not advance read state or create unread', t => {
  const { store } = setup(t);
  store.mergeMessages('alice', [group('g')], [message('20', 2000), message('30', 3000)]);
  seen(store, '20');
  store.mergeMessages('alice', [], [message('40', 4000), message('50', 5000)]);
  const before = checkpoint(store);
  assert.equal(store.mergeMessages('alice', [], [
    message('10', 1000), message('15', 1500)
  ], { history: true }), 2);
  assert.deepEqual(checkpoint(store), before);
  assert.equal(store.mergeMessages('alice', [], [
    message('20', 2000, { mediaVersion: 1, text: '合成历史消息详情',
      images: [{ url: 'https://wx1.sinaimg.cn/large/synthetic-highwater.jpg' }] }),
    message('40', 4000, { mediaVersion: 1, text: '合成未读消息详情' })
  ]), 0);
  assert.deepEqual(checkpoint(store), before);
  store.mergeMessages('alice', [], [message('15', 1500), message('40', 4000)], { history: true });
  assert.deepEqual(checkpoint(store), before);
  assert.equal(store.queryMessages('alice', { groupId: 'g' }).total, 6);
  assert.equal(store.queryMessages('alice', { groupId: 'g', keyword: '历史消息详情' })
    .messages[0].images.length, 1);
});

test('fresh arrival pages deduplicate above their captured frontier without moving high water', t => {
  const { store } = setup(t);
  store.mergeMessages('alice', [group('g')], [message('100', 1000)]);
  seen(store, '100');
  store.mergeMessages('alice', [], [message('104', 1000), message('105', 1000)]);
  store.mergeMessages('alice', [], [
    message('102', 1000), message('103', 1000), message('104', 1000)
  ], { arrivalAfter: { g: '100' } });
  let stats = store.getReadStats('alice', 'g');
  assert.equal(stats.readThroughId, '100');
  assert.equal(stats.firstUnreadId, '102');
  assert.equal(stats.unreadCount, 4);
  assert.deepEqual(new Set(stats.unreadIds), new Set(['102', '103', '104', '105']));
  seen(store, '103');
  store.mergeMessages('alice', [], [message('101', 1000), message('106', 1000)], {
    arrivalAfter: { g: '100' }
  });
  stats = store.getReadStats('alice', 'g');
  assert.equal(stats.readThroughId, '103');
  assert.equal(stats.firstUnreadId, '104');
  assert.deepEqual(stats.unreadIds, ['104', '105', '106']);
  store.mergeMessages('alice', [], [message('106', 1000), message('103', 1000)]);
  assert.deepEqual(checkpoint(store), {
    readThroughId: '103', unreadIds: ['104', '105', '106'], unreadCount: 3, firstUnreadId: '104'
  });
});

test('high water and anchor remain independent across groups, accounts, and schema-1 restarts', t => {
  const { store, root } = setup(t);
  store.ensureAccount({ id: 'bob', name: '合成账号 B', kind: 'import' });
  for (const accountId of ['alice', 'bob']) {
    store.mergeMessages(accountId, [group('g'), group('h')], [
      message('1', 1000), message('1', 1000, { groupId: 'h' })
    ]);
    for (const groupId of ['g', 'h']) seen(store, '1', accountId, groupId);
    store.mergeMessages(accountId, [], ['g', 'h'].flatMap(groupId =>
      ['2', '3', '4'].map(id => message(id, 1000, { groupId }))));
  }
  seen(store, '3', 'alice', 'g');
  seen(store, '2', 'alice', 'h');
  seen(store, '4', 'bob', 'g');
  const bobBefore = fs.readFileSync(fileFor(root, 'bob'));
  const expected = {
    alice: { g: checkpoint(store, 'alice', 'g'), h: checkpoint(store, 'alice', 'h') },
    bob: { g: checkpoint(store, 'bob', 'g'), h: checkpoint(store, 'bob', 'h') }
  };
  for (const groupId of ['h', 'g', 'h', 'g']) {
    store.setReadPosition('alice', groupId, '1', { seenId: '1', offset: -8, followTail: false });
  }
  assert.deepEqual(fs.readFileSync(fileFor(root, 'bob')), bobBefore);
  const snapshots = Object.fromEntries(['alice', 'bob'].map(id =>
    [id, fs.readFileSync(fileFor(root, id))]));
  const restarted = new Store(root);
  for (const accountId of ['alice', 'bob']) {
    assert.equal(restarted.get(accountId).schemaVersion, 1);
    for (const groupId of ['g', 'h']) {
      assert.deepEqual(checkpoint(restarted, accountId, groupId), expected[accountId][groupId]);
    }
    assert.deepEqual(fs.readFileSync(fileFor(root, accountId)), snapshots[accountId],
      'restart and read queries must not migrate or rewrite an existing schema-1 file');
  }
  assert.equal(restarted.getReadStats('alice', 'g').anchorId, '1');
  assert.equal(restarted.getReadStats('alice', 'g').readThroughId, '3');
  assert.equal(restarted.getReadStats('bob', 'g').anchorId, '4');
});

test('more than 2000 sorted records can be paged and boundary-located without changing read state', t => {
  const { store, root } = setup(t);
  const count = 4217, timeGroups = Math.ceil(count / 3), base = 9007199254740993123400n;
  // Ordered by time and then exact decimal ID. IDs drop at each new timestamp,
  // so sorting solely by ID or by Number cannot produce this expected order.
  const ordered = Array.from({ length: count }, (_, index) => message(
    String(base + BigInt((timeGroups - Math.floor(index / 3)) * 100 + index % 3)),
    1000 + Math.floor(index / 3)
  ));
  store.mergeMessages('alice', [group('g')], [ordered[0]]);
  seen(store, ordered[0].id);
  store.mergeMessages('alice', [], ordered.slice(1).reverse());
  const throughIndex = 3107, throughId = ordered[throughIndex].id;
  seen(store, throughId);
  store.setReadPosition('alice', 'g', ordered[4050].id, { offset: -19, followTail: false });
  // A schema-1 file need not store its raw array in chronological order. Query
  // offsets must refer to the sorted query, never raw storage indices.
  store.update('alice', state => { state.messages.reverse(); });
  const before = checkpoint(store), bytes = fs.readFileSync(fileFor(root, 'alice'));
  assert.equal(before.readThroughId, throughId);
  assert.equal(before.firstUnreadId, ordered[throughIndex + 1].id);
  assert.equal(before.unreadCount, count - throughIndex - 1);
  const ids = [];
  let boundaryOffset = null;
  for (let offset = 0; offset < count; offset += 2000) {
    const page = store.queryMessages('alice', { groupId: 'g', offset, limit: 2000 });
    assert.equal(page.total, count);
    const localIndex = page.messages.findIndex(row => row.id === throughId);
    if (localIndex >= 0) boundaryOffset = offset + localIndex;
    ids.push(...page.messages.map(row => row.id));
    assert.deepEqual(checkpoint(store), before);
  }
  assert.equal(boundaryOffset, throughIndex);
  assert.deepEqual(ids, ordered.map(row => row.id));
  assert.equal(new Set(ids).size, count);
  const around = store.queryMessages('alice', {
    groupId: 'g', offset: boundaryOffset - 2, limit: 6
  });
  assert.deepEqual(around.messages.map(row => row.id),
    ordered.slice(throughIndex - 2, throughIndex + 4).map(row => row.id));
  assert.equal(around.messages[2].id, before.readThroughId);
  assert.equal(around.messages[3].id, before.firstUnreadId);
  assert.deepEqual(fs.readFileSync(fileFor(root, 'alice')), bytes);
  assert.deepEqual(checkpoint(new Store(root)), before);
});
