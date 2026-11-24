'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store, filterMessages } = require('../app/core/store.cjs');

const start = Date.parse('2026-10-20T17:25:00+08:00');
const memberA = '9007199254740993123401';
const memberB = '9007199254740993123402';
const memberC = 'member-c';
function message(id, senderId = memberA, extra = {}) {
  return { id: String(id), groupId: 'g', senderId, senderName: '同名成员',
    text: '合成讨论 关键词', time: start, ...extra };
}
const ids = result => result.map(item => item.id);
function setup(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'weiyue-reading-filters-'));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved).toLowerCase(), parent.toLowerCase());
    assert.ok(path.basename(resolved).startsWith('weiyue-reading-filters-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const store = new Store(root);
  store.ensureAccount({ id: 'synthetic', name: '合成筛选账号', kind: 'import' });
  return { store, root };
}

test('multi-member selection uses exact stable IDs and does not collapse duplicate names', () => {
  const messages = [message('1'), message('2', memberB), message('3', memberC)];
  assert.deepEqual(ids(filterMessages(messages, { senderIds: [memberA, memberA, memberB] })), ['1', '2']);
  assert.deepEqual(ids(filterMessages(messages, { senderIds: [memberB] })), ['2']);
  assert.deepEqual(filterMessages(messages, { senderIds: ['同名成员'] }), []);
  assert.deepEqual(filterMessages(messages, { senderIds: ['900719925474099312340'] }), []);
  assert.deepEqual(ids(filterMessages(messages, { senderIds: [memberA] })), ['1']);
  messages[0].senderName = '改名后';
  assert.deepEqual(ids(filterMessages(messages, { senderIds: [memberA] })), ['1']);
});

test('empty or omitted multi-selection adds no restriction and legacy senderId remains compatible', () => {
  const messages = [message('1'), message('2', memberB), message('3', memberC)];
  for (const query of [{}, { senderIds: [] }, { senderIds: undefined }]) {
    assert.deepEqual(ids(filterMessages(messages, query)), ['1', '2', '3']);
  }
  assert.deepEqual(ids(filterMessages(messages, { senderId: memberB })), ['2']);
  assert.deepEqual(ids(filterMessages(messages, { senderId: memberB, senderIds: [] })), ['2']);
  assert.deepEqual(ids(filterMessages(messages, { senderId: '', senderIds: [memberA, memberC] })), ['1', '3']);
});

test('legacy and multi-member selectors intersect instead of widening or overriding a restriction', () => {
  const messages = [message('1'), message('2', memberB), message('3', memberC)];
  assert.deepEqual(ids(filterMessages(messages, { senderId: memberB, senderIds: [memberA, memberB] })), ['2']);
  assert.deepEqual(filterMessages(messages, { senderId: memberC, senderIds: [memberA, memberB] }), []);
});

test('multi-member IDs retain existing identifier normalization without accepting unsafe values', () => {
  const messages = [message('1', '7'), message('2', memberA)];
  const selected = [7, ' 7 ', memberA];
  assert.deepEqual(ids(filterMessages(messages, { senderIds: selected })), ['1', '2']);
  assert.deepEqual(selected, [7, ' 7 ', memberA]);
  const invalid = [null, '7', {}, true, [null], [''], [' '], [{}], [true], [-1],
    [Number(memberA)], ['x'.repeat(257)], ['member\u0000id'], Array(1), Array(100001).fill('7')];
  for (const senderIds of invalid) {
    assert.throws(() => filterMessages(messages, { senderIds }), /成员 ID/);
  }
});

test('member OR selection combines with group, keyword, important members and time using AND', () => {
  const messages = [
    message('1'),
    message('2', memberB, { time: start + 1000 }),
    message('3', memberC),
    message('4', memberA, { groupId: 'other' }),
    message('5', memberA, { text: '其他主题' }),
    message('6', memberA, { time: start - 1 }),
    message('7', memberB, { time: start + 60000 }),
  ];
  const query = { groupId: 'g', senderIds: [memberA, memberB], keyword: '关键词',
    importantOnly: true, start, end: start + 60000 };
  assert.deepEqual(ids(filterMessages(messages, query, [memberB])), ['2']);
  assert.deepEqual(ids(filterMessages(messages, { ...query, importantOnly: false })), ['1', '2']);
});

test('China-minute endpoints are exact milliseconds and include the entire supplied ending minute', () => {
  // The UI sends [17:25:00, 17:27:00) for inclusive ending minute 17:26.
  const end = Date.parse('2026-10-20T17:26:00+08:00') + 60000;
  const messages = [
    message('before', memberA, { time: start - 1 }),
    message('start', memberA, { time: start }),
    message('ending-minute', memberB, { time: end - 60000 }),
    message('last-ms', memberB, { time: end - 1 }),
    message('exclusive-end', memberA, { time: end }),
  ];
  assert.equal(start, Date.UTC(2026, 9, 20, 9, 25));
  assert.deepEqual(ids(filterMessages(messages, { start, end, senderIds: [memberA, memberB] })),
    ['start', 'ending-minute', 'last-ms']);
  assert.deepEqual(ids(filterMessages(messages, { start, end: start + 60000 })), ['start']);
  assert.deepEqual(filterMessages(messages, { start, end: start }), []);
});

test('inverted or invalid millisecond time ranges fail instead of returning unrelated messages', () => {
  const messages = [message('1')];
  assert.throws(() => filterMessages(messages, { start: start + 60000, end: start }), /开始时间不能晚于结束时间/);
  for (const value of [NaN, Infinity, -1, start + 0.5, '2026-10-20T17:25', false, 8640000000000001]) {
    assert.throws(() => filterMessages(messages, { start: value }), /开始时间/);
    assert.throws(() => filterMessages(messages, { end: value }), /结束时间/);
  }
});

test('all selected messages remain accessible across every page in exact time/ID order', t => {
  const { store, root } = setup(t);
  const messages = Array.from({ length: 6205 }, (_, i) => message(
    (9007199254740993123000n + BigInt(i)).toString(), [memberA, memberB, memberC][i % 3],
    { time: start + Math.floor(i / 5), text: i % 11 === 0 ? '不参与' : '关键词' }
  ));
  store.mergeMessages('synthetic', [{ id: 'g', name: '合成分页群' }], [...messages].reverse());
  const query = { groupId: 'g', senderIds: [memberA, memberB, memberA], keyword: '关键词', start, end: start + 60000 };
  const expected = messages.filter(m => [memberA, memberB].includes(m.senderId) && m.text === '关键词');
  const files = fs.readdirSync(root).map(name => path.join(root, name));
  const before = files.map(file => fs.readFileSync(file));
  const readBefore = store.getReadStats('synthetic', 'g');
  const found = [];
  for (let offset = 0; offset < expected.length; offset += 2000) {
    const result = store.queryMessages('synthetic', { ...query, offset, limit: 2000 });
    assert.equal(result.total, expected.length);
    assert.ok(result.messages.length > 0 && result.messages.length <= 2000);
    found.push(...result.messages);
  }
  assert.ok(found.length > 2000);
  assert.deepEqual(ids(found), ids(expected));
  assert.equal(new Set(ids(found)).size, expected.length);
  assert.deepEqual(store.queryMessages('synthetic', { ...query, offset: expected.length, limit: 2000 }),
    { messages: [], total: expected.length });
  assert.deepEqual(store.getReadStats('synthetic', 'g'), readBefore);
  assert.deepEqual(files.map(file => fs.readFileSync(file)), before);
  assert.deepEqual(new Store(root).queryMessages('synthetic', { ...query, offset: 2000, limit: 2000 }).messages,
    expected.slice(2000, 4000));
});
