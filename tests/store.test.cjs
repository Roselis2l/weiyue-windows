'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store, normalizeMessage, filterMessages, createDemoData } = require('../app/core/store.cjs');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weiyue-store-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  store.ensureAccount({ id: 'alice', name: '阿梨', kind: 'import' });
  return { root, store };
}
const group = (id = 'g') => ({ id, name: `群 ${id}` });
const message = (id = '1', overrides = {}) => ({ id, groupId: 'g', senderId: 'u1', senderName: '林间', text: '认真阅读，保留出处。', time: 1000, ...overrides });

test('account storage survives restart and hashed paths isolate accounts', t => {
  const { root, store } = setup(t);
  store.ensureAccount({ id: '../outside', name: '第二个账号', kind: 'import' });
  assert.equal(store.mergeMessages('alice', [group()], [message()]), 1);
  store.mergeMessages('../outside', [group()], [message('1', { text: '另一个账号的消息' })]);
  const reopened = new Store(root);
  assert.equal(reopened.get('alice').messages[0].text, '认真阅读，保留出处。');
  assert.equal(reopened.get('../outside').messages[0].text, '另一个账号的消息');
  assert.equal(reopened.accounts().length, 2);
  assert.ok(fs.readdirSync(root).every(name => /^account-[a-f0-9]{64}\.json$/.test(name)));
  assert.equal(store.account('missing'), null);
  assert.throws(() => store.get('missing'), /账号不存在/);
});

test('returned objects cannot modify persisted state and account type cannot change', t => {
  const { store } = setup(t);
  const state = store.get('alice'); state.account.name = '变更'; state.groups.push(group());
  assert.equal(store.get('alice').account.name, '阿梨');
  assert.equal(store.get('alice').groups.length, 0);
  const account = store.ensureAccount({ id: 'alice', name: '新名称', kind: 'import' });
  assert.deepEqual(account, { id: 'alice', name: '新名称', kind: 'import' });
  assert.throws(() => store.ensureAccount({ id: 'alice', name: '真实用户', kind: 'weibo' }), /账号类型/);
});

test('messages retain large string IDs and reject unsafe numeric IDs before writing', t => {
  const { store } = setup(t);
  store.mergeMessages('alice', [group()], [message('900719925474099312345678')]);
  assert.equal(store.get('alice').messages[0].id, '900719925474099312345678');
  assert.throws(() => store.importData('alice', { groups: [group('new')], messages: [message(Number.MAX_SAFE_INTEGER + 1)] }), /长数字 ID/);
  assert.equal(store.get('alice').groups.length, 1);
  assert.equal(store.get('alice').messages.length, 1);
  assert.equal(normalizeMessage(message(12, { senderId: 34 })).id, '12');
  assert.equal(normalizeMessage(message(12, { senderId: 34 })).senderId, '34');
});

test('merge deduplicates within each group, counts only new rows and preserves selection', t => {
  const { store } = setup(t);
  assert.equal(store.mergeMessages('alice', [{ ...group(), selected: true }, group('g2')], [message('1'), message('1'), message('1', { groupId: 'g2' })]), 2);
  assert.equal(store.mergeMessages('alice', [{ ...group(), name: '更名' }], [message('1', { text: '已修改' }), message('2')]), 1);
  const state = store.get('alice');
  assert.equal(state.messages.length, 3);
  assert.equal(state.messages.find(item => item.groupId === 'g' && item.id === '1').text, '已修改');
  assert.equal(state.groups[0].selected, true);
  assert.equal(state.groups[0].name, '更名');
  assert.equal(state.groups[1].selected, false);
});

test('failed import validates all rows and leaves previous file byte-identical', t => {
  const { root, store } = setup(t);
  store.mergeMessages('alice', [group()], [message()]);
  const file = path.join(root, fs.readdirSync(root)[0]), before = fs.readFileSync(file, 'utf8');
  assert.throws(() => store.importData('alice', { groups: [group('g2')], messages: [message('2', { groupId: 'g2' }), message('3', { groupId: 'unknown' })] }), /所属群不存在/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.throws(() => store.importData('alice', { groups: [], messages: [message('4', { time: '2026-10-20' })] }), /毫秒时间戳/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.readdirSync(root).length, 1);
});

test('history cursor and exhaustion status persist, survive group refresh and reject unsafe values', t => {
  const { root, store } = setup(t);
  store.mergeMessages('alice', [{ ...group(), nextCursor: '9007199254740993999', historyExhausted: false }], []);
  store.mergeMessages('alice', [{ ...group(), name: '刷新群名' }], []);
  let actual = new Store(root).get('alice').groups[0];
  assert.equal(actual.nextCursor, '9007199254740993999');
  assert.equal(actual.historyExhausted, false);
  store.update('alice', state => { state.groups[0].nextCursor = null; state.groups[0].historyExhausted = true; });
  actual = new Store(root).get('alice').groups[0];
  assert.equal(actual.nextCursor, null); assert.equal(actual.historyExhausted, true);
  assert.throws(() => store.mergeMessages('alice', [{ ...group(), nextCursor: Number.MAX_SAFE_INTEGER }], []), /数字字符串/);
  assert.throws(() => store.mergeMessages('alice', [{ ...group(), nextCursor: '-1' }], []), /数字字符串/);
  assert.throws(() => store.mergeMessages('alice', [{ ...group(), historyExhausted: 1 }], []), /布尔值/);
});

test('latest pending cursor persists independently from history pagination and survives group refresh', t => {
  const { root, store } = setup(t);
  const id = '9007199254740993000';
  const pending = { cursor: '9007199254740993999', baselineId: id, arrivalAfterId: id };
  store.mergeMessages('alice', [{ ...group(), nextCursor: '500', historyExhausted: false, latestPending: pending }], [message(id)]);
  store.mergeMessages('alice', [{ ...group(), name: '重新抓取的群名称' }], []);
  let actual = new Store(root).get('alice').groups[0];
  assert.deepEqual(actual.latestPending, pending);
  assert.equal(actual.nextCursor, '500'); assert.equal(actual.historyExhausted, false);
  store.update('alice', state => { state.groups[0].latestPending.cursor = '9007199254740993499'; });
  actual = new Store(root).get('alice').groups[0];
  assert.equal(actual.latestPending.cursor, '9007199254740993499');
  assert.equal(actual.latestPending.baselineId, id); assert.equal(actual.nextCursor, '500');
  store.update('alice', state => { state.groups[0].latestPending = null; });
  actual = new Store(root).get('alice').groups[0];
  assert.equal(actual.latestPending, null); assert.equal(actual.nextCursor, '500');
  store.update('alice', state => { state.groups[0].latestPending = undefined; });
  actual = new Store(root).get('alice').groups[0];
  assert.equal(Object.hasOwn(actual, 'latestPending'), false); assert.equal(actual.nextCursor, '500');
});

test('latest pending validates decimal strings and allows a zero baseline without unsafe ID conversion', t => {
  const { store } = setup(t);
  store.mergeMessages('alice', [group()], [message('7')]);
  store.mergeMessages('alice', [{ ...group(), latestPending: { cursor: '1', baselineId: '0', arrivalAfterId: 7 } }], []);
  assert.deepEqual(store.get('alice').groups[0].latestPending, { cursor: '1', baselineId: '0', arrivalAfterId: '7' });
  const invalid = [
    { cursor: '0', baselineId: '0', arrivalAfterId: '7' },
    { cursor: '-1', baselineId: '0', arrivalAfterId: '7' },
    { cursor: '1.5', baselineId: '0', arrivalAfterId: '7' },
    { cursor: 9, baselineId: '0', arrivalAfterId: '7' },
    { cursor: '9', baselineId: 0, arrivalAfterId: '7' },
    { cursor: '9', baselineId: '-1', arrivalAfterId: '7' },
    { cursor: '9', baselineId: '0', arrivalAfterId: Number.MAX_SAFE_INTEGER + 1 },
    { cursor: '9', baselineId: '0' },
    { cursor: '1'.repeat(257), baselineId: '0', arrivalAfterId: '7' },
    [],
  ];
  for (const latestPending of invalid) assert.throws(() => store.mergeMessages('alice', [{ ...group(), latestPending }], []));
  assert.deepEqual(store.get('alice').groups[0].latestPending, { cursor: '1', baselineId: '0', arrivalAfterId: '7' });
});

test('missing or cross-group latest arrival references fail atomically and preserve history cursors', t => {
  const { root, store } = setup(t);
  store.mergeMessages('alice', [{ ...group(), nextCursor: '55' }, group('g2')], [message('1'), message('2', { groupId: 'g2' })]);
  const file = path.join(root, fs.readdirSync(root)[0]), before = fs.readFileSync(file, 'utf8');
  for (const arrivalAfterId of ['missing', '2']) {
    assert.throws(() => store.update('alice', state => { state.groups[0].latestPending = { cursor: '100', baselineId: '1', arrivalAfterId }; }), /同群消息不存在/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
  assert.equal(store.get('alice').groups[0].nextCursor, '55');
});

test('query applies half-open boundaries, sender, keyword, important filters and numeric pagination', t => {
  const { store } = setup(t);
  store.mergeMessages('alice', [group(), group('g2')], [message('9007199254740993999'), message('9007199254740993000'), message('10'), message('2'), message('3', { time: 2000, senderId: 'u2', text: '结束边界' }), message('4', { time: 0 }), message('5', { groupId: 'g2', text: '其他群' })]);
  const query = { groupId: 'g', start: 1000, end: 2000, limit: 2 };
  assert.deepEqual(store.queryMessages('alice', query).messages.map(item => item.id), ['2', '10']);
  assert.equal(store.queryMessages('alice', query).total, 4);
  assert.deepEqual(store.queryMessages('alice', { ...query, offset: 2 }).messages.map(item => item.id), ['9007199254740993000', '9007199254740993999']);
  assert.equal(store.queryMessages('alice', { groupId: 'g', senderId: 'u2' }).total, 1);
  assert.equal(store.queryMessages('alice', { groupId: 'g', keyword: '林间' }).total, 6);
  assert.equal(store.queryMessages('alice', { keyword: '其他群' }).total, 1);
  assert.equal(store.queryMessages('alice', { importantOnly: true }).total, 0);
  store.setImportant('alice', 'u2', true);
  assert.equal(store.queryMessages('alice', { importantOnly: true }).messages[0].id, '3');
  assert.throws(() => store.queryMessages('alice', { start: 2, end: 1 }), /开始时间/);
  assert.throws(() => store.queryMessages('alice', { limit: 2001 }), /每页条数/);
  assert.throws(() => store.queryMessages('alice', { offset: -1 }), /分页位置/);
  assert.equal(store.queryMessages('alice', { start: 1000, end: 1000 }).total, 0);
});

test('single and multi-message bookmarks enrich original text, search and update exact selections', t => {
  const { store } = setup(t);
  store.mergeMessages('alice', [group()], [message('1'), message('2', { text: '保留上下文', time: 2000 })]);
  const one = store.bookmark('alice', { groupId: 'g', messageIds: ['1'], note: '下周分享', tags: ['  阅读 ', '阅读', '实践'] });
  assert.deepEqual(one.tags, ['阅读', '实践']);
  const many = store.bookmark('alice', { groupId: 'g', messageIds: ['2', '1', '2'], note: '完整讨论', tags: ['资料'] });
  assert.equal(store.bookmarks('alice').length, 2);
  assert.deepEqual(store.bookmarks('alice', { keyword: '完整讨论' })[0].messages.map(item => item.id), ['1', '2']);
  assert.equal(store.bookmarks('alice', '上下文').length, 1);
  assert.equal(store.bookmarks('alice', { tag: '阅读' }).length, 1);
  assert.equal(store.bookmarks('alice', { groupId: 'other' }).length, 0);
  const edited = store.bookmark('alice', { groupId: 'g', messageIds: ['1', '2'], note: '新的备注', tags: [] });
  assert.equal(edited.id, many.id);
  assert.equal(store.bookmarks('alice', '新的备注').length, 1);
  assert.equal(store.removeBookmark('alice', one.id), true);
  assert.equal(store.removeBookmark('alice', one.id), false);
  assert.equal(store.bookmarks('alice').length, 1);
  assert.throws(() => store.bookmark('alice', { groupId: 'g', messageIds: ['missing'] }), /不存在/);
  assert.throws(() => store.bookmark('alice', { groupId: 'g', messageIds: [] }), /至少一条/);
});

test('read position and important members persist per account and group', t => {
  const { root, store } = setup(t);
  store.ensureAccount({ id: 'bob', name: '小波', kind: 'import' });
  store.mergeMessages('alice', [group(), group('g2')], [message('1'), message('2', { groupId: 'g2' })]);
  store.setReadPosition('alice', 'g', '1'); store.setReadPosition('alice', 'g2', '2');
  store.setImportant('alice', 'u1', true); store.setImportant('alice', 'u1', true);
  const state = new Store(root).get('alice');
  assert.deepEqual(state.readPositions, { g: '1', g2: '2' });
  assert.deepEqual(state.importantMembers, ['u1']);
  assert.deepEqual(store.get('bob').readPositions, {});
  assert.deepEqual(store.get('bob').importantMembers, []);
  store.setImportant('alice', 'u1', false);
  assert.deepEqual(store.get('alice').importantMembers, []);
  assert.throws(() => store.setReadPosition('alice', 'g2', '1'), /不存在/);
});

test('reserved object keys do not mutate object prototypes or lose read positions', t => {
  const { store } = setup(t);
  store.mergeMessages('alice', [group('__proto__')], [message('1', { groupId: '__proto__' })]);
  store.setReadPosition('alice', '__proto__', '1');
  const state = store.get('alice');
  assert.ok(Object.hasOwn(state.readPositions, '__proto__'));
  assert.equal(state.readPositions.__proto__, '1');
  assert.equal({}.polluted, undefined);
});

test('ordinary settings refuse nested credentials and invalid updates roll back', t => {
  const { store } = setup(t);
  store.update('alice', state => { state.settings = { aiEndpoint: 'https://example.com', model: 'user-model', hasAiKey: true }; });
  assert.throws(() => store.update('alice', state => { state.settings.ai = { apiKey: 'test-secret' }; }), /凭据不能/);
  assert.equal(store.get('alice').settings.ai, undefined);
  assert.throws(() => store.update('alice', state => { state.settings.cookie = 'test-cookie'; }), /凭据不能/);
  assert.throws(() => store.update('alice', state => { state.messages = [message()]; }), /所属群不存在/);
  assert.throws(() => store.update('alice', () => Promise.resolve()), /同步操作/);
  assert.throws(() => store.update('alice', state => { state.settings.invalid = Infinity; }), /不能保存/);
  assert.equal(store.get('alice').messages.length, 0);
});

test('corrupt files are reported and never silently reset', t => {
  const { root, store } = setup(t);
  const file = path.join(root, fs.readdirSync(root)[0]);
  fs.writeFileSync(file, '{broken', 'utf8');
  assert.throws(() => store.get('alice'), /保留原文件/);
  assert.throws(() => store.ensureAccount({ id: 'alice', name: '新账号', kind: 'import' }), /保留原文件/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('atomic write failure preserves previous state and cleans own temporary file', t => {
  const { root, store } = setup(t);
  const file = path.join(root, fs.readdirSync(root)[0]), before = fs.readFileSync(file, 'utf8');
  const original = fs.renameSync;
  fs.renameSync = () => { throw new Error('simulated disk failure'); };
  try { assert.throws(() => store.update('alice', state => { state.account.name = '未完成'; }), /保存本地数据失败/); }
  finally { fs.renameSync = original; }
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.readdirSync(root).length, 1);
});

test('demo has Chinese multi-group multi-day data, large IDs and remains idempotent', t => {
  const { store } = setup(t);
  const account = store.seedDemo(), state = store.get(account.id);
  assert.equal(account.kind, 'demo');
  assert.equal(state.groups.length, 3);
  assert.ok(state.messages.length > 500);
  assert.equal(state.messages.filter(item => item.groupId === 'demo-reading').length, 256);
  assert.ok(new Set(state.messages.map(item => item.senderId)).size > 5);
  assert.ok(state.messages.at(-1).time - state.messages[0].time > 2 * 86400000);
  assert.ok(state.messages.every(item => typeof item.id === 'string' && item.time < Date.now()));
  assert.ok(state.messages.some(item => BigInt(item.id) > BigInt(Number.MAX_SAFE_INTEGER)));
  assert.ok(state.bookmarks.length > 0);
  store.seedDemo();
  assert.equal(store.get(account.id).messages.length, state.messages.length);
  assert.equal(store.get(account.id).bookmarks.length, state.bookmarks.length);
});

test('demo recent messages and pure helpers respect caller inputs', () => {
  const now = new Date('2026-10-20T12:00:00Z').getTime();
  const data = createDemoData(now), original = JSON.stringify(data.messages);
  assert.equal(data.messages.at(-1).time, now - 1000);
  const recent = filterMessages(data.messages, { start: now - 3600000, end: now });
  assert.ok(recent.length >= 3);
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  assert.ok(filterMessages(data.messages, { groupId: 'demo-reading', start: today.getTime(), end: now }).length >= 16);
  assert.equal(JSON.stringify(data.messages), original);
  assert.throws(() => normalizeMessage(message('id', { time: NaN })), /毫秒时间戳/);
  assert.throws(() => normalizeMessage(message('id', { text: {} })), /消息正文/);
});

test('schema 1 read positions migrate without rewriting files or losing other data', t => {
  const { root, store } = setup(t);
  store.mergeMessages('alice', [group()], [message('1'), message('2', { time: 2000 })]);
  store.setReadPosition('alice', 'g', '1');
  store.update('alice', state => { state.settings.model = 'kept'; state.exports.completed = { pageId: 'saved' }; });
  const file = path.join(root, fs.readdirSync(root)[0]);
  const old = JSON.parse(fs.readFileSync(file, 'utf8')); delete old.readStates;
  fs.writeFileSync(file, JSON.stringify(old), 'utf8');
  const bytes = fs.readFileSync(file, 'utf8'), reopened = new Store(root), current = reopened.get('alice');
  assert.deepEqual(current.readStates.g, { anchorId: '1', anchorOffset: 0, atBottom: false, readThroughId: '1', unreadIds: [], updatedAt: 0 });
  assert.equal(current.schemaVersion, 1); assert.equal(current.settings.model, 'kept');
  assert.equal(current.exports.completed.pageId, 'saved');
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  reopened.mergeMessages('alice', [], [message('3', { time: 3000 })]);
  assert.equal(reopened.getReadStats('alice', 'g').unreadCount, 1);
  assert.equal(reopened.get('alice').readPositions.g, '1');
});

test('only new arrivals become unread; history, duplicate sync and initial loads do not', t => {
  const { store } = setup(t);
  store.mergeMessages('alice', [group()], [message('100', { time: 10000 })]);
  assert.equal(store.getReadStats('alice', 'g').unreadCount, 0);
  store.mergeMessages('alice', [], [message('200', { time: 20000 }), message('150', { time: 15000 })]);
  let stats = store.getReadStats('alice', 'g');
  assert.equal(stats.unreadCount, 2); assert.equal(stats.firstUnreadId, '150');
  assert.equal(stats.latestMessageId, '200'); assert.equal(stats.messageCount, 3);
  store.mergeMessages('alice', [], [message('50', { time: 5000 }), message('300', { time: 30000 })], { history: true });
  store.mergeMessages('alice', [], [message('200', { time: 20000, text: '补充内容' }), message('25', { time: 2500 })]);
  stats = store.getReadStats('alice', 'g');
  assert.equal(stats.unreadCount, 2); assert.equal(stats.messageCount, 6);
  assert.equal(stats.anchorId, null); assert.equal(stats.readThroughId, null);
  assert.equal(stats.atBottom, false);
});

test('one arrival frontier covers all sync pages and null frontier keeps initial pages quiet', t => {
  const { store } = setup(t);
  store.mergeMessages('alice', [group()], [message('100', { time: 10000 })]);
  const options = { arrivalAfter: { g: '100' } };
  store.mergeMessages('alice', [], [message('200', { time: 20000 })], options);
  store.mergeMessages('alice', [], [message('150', { time: 15000 }), message('90', { time: 9000 })], options);
  assert.deepEqual(new Set(store.getReadStats('alice', 'g').unreadIds), new Set(['200', '150']));
  store.mergeMessages('alice', [group('empty')], [message('a', { groupId: 'empty' })], { arrivalAfter: { empty: null } });
  store.mergeMessages('alice', [], [message('b', { groupId: 'empty', time: 2000 })], { arrivalAfter: { empty: null } });
  assert.equal(store.getReadStats('alice', 'empty').unreadCount, 0);
  assert.throws(() => store.mergeMessages('alice', [], [message('400')], { arrivalAfter: { g: 'missing' } }), /同步起点消息不存在/);
});

test('viewport anchor moves backwards independently from monotonic seen high-water', t => {
  const { root, store } = setup(t);
  const ids = ['900719925474099312340', '900719925474099312341', '900719925474099312342', '900719925474099312343'];
  store.mergeMessages('alice', [group()], [message(ids[0])]);
  store.mergeMessages('alice', [], ids.slice(1).map(id => message(id)));
  store.setReadPosition('alice', 'g', ids[1], { offset: -18.75, followTail: false, seenId: ids[2] });
  let stats = store.getReadStats('alice', 'g');
  assert.equal(stats.anchorId, ids[1]); assert.equal(stats.readThroughId, ids[2]);
  assert.equal(stats.anchorOffset, -18.75); assert.equal(stats.unreadCount, 1);
  assert.equal(stats.firstUnreadId, ids[3]);
  store.setReadPosition('alice', 'g', ids[0], { offset: -12, followTail: false, seenId: ids[0] });
  stats = new Store(root).getReadStats('alice', 'g');
  assert.equal(stats.anchorId, ids[0]); assert.equal(stats.readThroughId, ids[2]);
  assert.equal(stats.anchorOffset, -12); assert.equal(stats.unreadCount, 1);
  assert.equal(store.get('alice').readPositions.g, ids[0]);
  assert.ok(stats.updatedAt > 0);
});

test('anchor-only saves and atBottom never imply reading unseen messages', t => {
  const { store } = setup(t);
  store.mergeMessages('alice', [group()], [message('1')]);
  store.setReadPosition('alice', 'g', '1');
  store.mergeMessages('alice', [], [message('2', { time: 2000 }), message('3', { time: 3000 })]);
  store.setReadPosition('alice', 'g', '2', { offset: 15, followTail: true });
  store.setReadPosition('alice', 'g', '3', { seenId: null });
  let stats = store.getReadStats('alice', 'g');
  assert.equal(stats.readThroughId, '1'); assert.equal(stats.unreadCount, 2); assert.equal(stats.atBottom, true);
  store.mergeMessages('alice', [], [message('4', { time: 4000 })]);
  stats = store.getReadStats('alice', 'g');
  assert.equal(stats.anchorId, '3'); assert.equal(stats.readThroughId, '1'); assert.equal(stats.unreadCount, 3);
  store.setReadPosition('alice', 'g', '4');
  stats = store.getReadStats('alice', 'g');
  assert.equal(stats.readThroughId, '4'); assert.equal(stats.unreadCount, 0);
});

test('read stats remain independent per account/group and restored after restart', t => {
  const { root, store } = setup(t);
  store.ensureAccount({ id: 'bob', name: '小波', kind: 'import' });
  for (const accountId of ['alice', 'bob']) store.mergeMessages(accountId, [group(), group('g2')], [message('1'), message('1', { groupId: 'g2' })]);
  store.mergeMessages('alice', [], [message('2', { time: 2000 }), message('2', { groupId: 'g2', time: 2000 })]);
  store.setReadPosition('alice', 'g', '2', { offset: -8, followTail: true, seenId: '2' });
  store.setReadPosition('alice', 'g2', '1', { offset: -14, followTail: false });
  const reopened = new Store(root), all = reopened.getReadStats('alice');
  assert.equal(all.g.unreadCount, 0); assert.equal(all.g2.unreadCount, 1);
  assert.equal(all.g.anchorOffset, -8); assert.equal(all.g2.anchorOffset, -14);
  assert.equal(reopened.getReadStats('bob', 'g').unreadCount, 0);
  assert.equal(reopened.getReadStats('bob', 'g').anchorId, null);
  assert.throws(() => reopened.getReadStats('alice', 'unknown'), /所属群不存在/);
});

test('read state rejects malformed values and missing references without damaging stored state', t => {
  const { store } = setup(t);
  store.mergeMessages('alice', [group()], [message('1')]);
  const before = store.getReadStats('alice', 'g');
  assert.throws(() => store.setReadPosition('alice', 'g', '1', { offset: Infinity }), /像素值/);
  assert.throws(() => store.setReadPosition('alice', 'g', '1', { followTail: 1 }), /布尔值/);
  assert.throws(() => store.setReadPosition('alice', 'g', '1', { seenId: 'missing' }), /可见末行/);
  assert.throws(() => store.update('alice', state => { state.readStates.g.unreadIds = ['missing']; }), /引用的消息不存在/);
  assert.throws(() => store.update('alice', state => { state.readStates.g.anchorId = 'missing'; }), /引用的消息不存在/);
  assert.throws(() => store.update('alice', state => { state.readStates.g.updatedAt = 'today'; }), /毫秒时间戳/);
  assert.deepEqual(store.getReadStats('alice', 'g'), before);
});

const photo = (name = 'a') => ({ url: `https://wx1.sinaimg.cn/mw690/demo-${name}.jpg`, originalUrl: `https://wx1.sinaimg.cn/large/demo-${name}.jpg`, thumbnailUrl: `https://wx1.sinaimg.cn/thumbnail/demo-${name}.jpg`, width: 640, height: 480 });
const shared = (overrides = {}) => ({ id: '900719925474099312345', url: 'https://weibo.com/1234567890/AbCdEfGhi', author: '青岚', text: '这是一段比通知文本更有价值的微博正文，包含城市观察与阅读方法。', images: [photo('post')], state: 'ready', ...overrides });

test('media and shared posts validate, persist, search and stay attached to bookmark originals', t => {
  const { root, store } = setup(t);
  const input = message('1', { text: '我发布了新微博，快来围观吧！', images: [photo(), photo()], sharedPost: shared(), mediaVersion: 1 });
  store.mergeMessages('alice', [group()], [input]);
  const actual = new Store(root).queryMessages('alice', { groupId: 'g' }).messages[0];
  assert.equal(actual.mediaVersion, 1); assert.equal(actual.images.length, 1);
  assert.deepEqual(actual.images[0], photo()); assert.deepEqual(actual.sharedPost, shared());
  assert.equal(store.queryMessages('alice', { keyword: '城市观察' }).total, 1);
  assert.equal(store.queryMessages('alice', { keyword: '青岚' }).total, 1);
  store.bookmark('alice', { groupId: 'g', messageIds: ['1'], tags: ['微博'] });
  assert.equal(store.bookmarks('alice', '城市观察')[0].messages[0].sharedPost.id, shared().id);
});

test('legacy repeated text cannot erase rich content or add unread rows', t => {
  const { store } = setup(t);
  store.mergeMessages('alice', [group()], [message('1', { text: '保留通知', images: [photo()], sharedPost: shared(), mediaVersion: 1 })]);
  store.setReadPosition('alice', 'g', '1', { offset: -7, followTail: false, seenId: '1' });
  assert.equal(store.mergeMessages('alice', [], [message('1', { text: '', senderName: '未知成员' })]), 0);
  const actual = store.queryMessages('alice', {}).messages[0];
  assert.equal(actual.text, '保留通知'); assert.equal(actual.senderName, '林间');
  assert.equal(actual.mediaVersion, 1); assert.deepEqual(actual.images, [photo()]);
  assert.deepEqual(actual.sharedPost, shared());
  const stats = store.getReadStats('alice', 'g');
  assert.equal(stats.unreadCount, 0); assert.equal(stats.anchorOffset, -7); assert.equal(stats.readThroughId, '1');
});

test('new media enriches old messages while empty v1 metadata and unavailable shares retain cached content', t => {
  const { store } = setup(t);
  store.mergeMessages('alice', [group()], [message('1')]);
  store.mergeMessages('alice', [], [message('1', { images: [photo()], sharedPost: shared(), mediaVersion: 1 })]);
  store.mergeMessages('alice', [], [message('1', { images: [photo('b')], sharedPost: shared({ images: [photo('post-b')] }), mediaVersion: 1 })]);
  let actual = store.queryMessages('alice', {}).messages[0];
  assert.equal(actual.images.length, 2); assert.equal(actual.sharedPost.images.length, 2);
  store.mergeMessages('alice', [], [message('1', { images: [], sharedPost: { text: '', images: [], state: 'unavailable', reason: '原微博当前无法读取' }, mediaVersion: 1 })]);
  actual = new Store(store.root).queryMessages('alice', {}).messages[0];
  assert.equal(actual.images.length, 2); assert.equal(actual.sharedPost.images.length, 2);
  assert.equal(actual.sharedPost.text, shared().text); assert.equal(actual.sharedPost.id, shared().id);
  assert.equal(actual.sharedPost.author, '青岚'); assert.equal(actual.sharedPost.state, 'unavailable');
  assert.equal(actual.sharedPost.reason, '原微博当前无法读取');
  assert.equal(store.getReadStats('alice', 'g').unreadCount, 0);
});

test('truncated metadata cannot replace a full cached post or claim full current readability', t => {
  const { store } = setup(t);
  store.mergeMessages('alice', [group()], [message('1', { sharedPost: shared(), mediaVersion: 1 })]);
  store.mergeMessages('alice', [], [message('1', { sharedPost: shared({ text: '这是一段…', images: [], truncated: true }), mediaVersion: 1 })]);
  let post = store.get('alice').messages[0].sharedPost;
  assert.equal(post.text, shared().text); assert.equal(post.images.length, 1);
  assert.equal(post.state, 'unavailable'); assert.match(post.reason, /缓存/);
  store.mergeMessages('alice', [], [message('1', { sharedPost: shared(), mediaVersion: 1 })]);
  post = store.get('alice').messages[0].sharedPost;
  assert.equal(post.state, 'ready'); assert.equal(post.reason, undefined);
});

test('invalid media, unsafe numeric post IDs and malformed rich fields fail atomically', t => {
  const { root, store } = setup(t);
  store.mergeMessages('alice', [group()], [message('1')]);
  const file = path.join(root, fs.readdirSync(root)[0]), before = fs.readFileSync(file, 'utf8');
  const bad = [
    { images: [{ url: 'javascript:alert(1)' }] },
    { images: [{ url: 'https://attacker.example/image.jpg' }] },
    { sharedPost: shared({ url: 'https://weibo.com.attacker.example/123/abc' }) },
    { sharedPost: shared({ id: Number.MAX_SAFE_INTEGER + 1 }) },
    { sharedPost: shared({ state: 'maybe' }) },
    { sharedPost: shared({ truncated: 'yes' }) },
    { sharedPost: shared({ author: {} }) },
    { mediaVersion: 2 },
  ];
  for (const patch of bad) {
    assert.throws(() => store.mergeMessages('alice', [], [message('1', patch)]));
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
});
