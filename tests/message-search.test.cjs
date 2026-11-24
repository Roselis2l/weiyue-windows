'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store, normalizeMessage, filterMessages } = require('../app/core/store.cjs');

const currentGroup = '9007199254740993101';
const otherGroup = '9007199254740993102';
const rows = [
  ['1', currentGroup, '今天的产品周会讨论中文输入法。'],
  ['2', currentGroup, '产品周会：搜索支持中文词句与 OpenAI API v2。'],
  ['3', currentGroup, '逐字删除、继续输入：中文测试完成。'],
  ['4', currentGroup, '粘贴第一行\n第二行：你好，Windows！😀'],
  ['5', otherGroup, '今天的产品周会讨论中文输入法。'],
].map(([id, groupId, text], index) => normalizeMessage({
  id, groupId, senderId: 'synthetic-author', senderName: '虚构成员',
  text, time: 1000 + index,
}));
const ids = keyword => filterMessages(rows, { groupId: currentGroup, keyword }).map(row => row.id);

test('current-group search matches complete Chinese words and committed sentences', () => {
  assert.deepEqual(ids('产品周会'), ['1', '2']);
  assert.deepEqual(ids('今天的产品周会讨论中文输入法。'), ['1']);
  assert.deepEqual(ids('中文输入法'), ['1']);
});

test('successive Chinese edits and deletion remain scoped to the selected group', () => {
  for (const keyword of ['中', '中文', '中文输', '中文输入', '中文输入法', '中文输入', '中文']) {
    const found = filterMessages(rows, { groupId: currentGroup, keyword });
    assert.ok(found.length > 0, keyword);
    assert.ok(found.every(row => row.groupId === currentGroup));
  }
  assert.deepEqual(ids('中文测试完成'), ['3']);
  assert.deepEqual(ids('没有这个词'), []);
});

test('Chinese and Latin mixed queries retain punctuation and case-insensitive matching', () => {
  assert.deepEqual(ids('中文词句与 openai api V2'), ['2']);
  assert.deepEqual(ids('  产品周会：搜索支持中文词句  '), ['2']);
  assert.deepEqual(ids('你好，windows！😀'), ['4']);
});

test('pasted multiline Chinese text is matched as text without altering messages', () => {
  const before = JSON.stringify(rows);
  assert.deepEqual(ids('粘贴第一行\n第二行：你好，Windows！😀'), ['4']);
  assert.equal(JSON.stringify(rows), before);
});

test('clearing Chinese search restores only the current group and preserves long group IDs', () => {
  assert.deepEqual(ids(''), ['1', '2', '3', '4']);
  assert.deepEqual(ids('   '), ['1', '2', '3', '4']);
  assert.deepEqual(filterMessages(rows, { groupId: otherGroup, keyword: '产品周会' }).map(row => row.id), ['5']);
});

test('persisted Chinese searches and clearing are read-only, including reading state', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weiyue-chinese-search-test-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const store = new Store(root);
  store.ensureAccount({ id: 'synthetic-search', name: '虚构搜索测试', kind: 'import' });
  store.mergeMessages('synthetic-search', [
    { id: currentGroup, name: '当前虚构群', selected: true },
    { id: otherGroup, name: '另一个虚构群', selected: true },
  ], rows);
  const file = path.join(root, fs.readdirSync(root)[0]);
  const bytes = fs.readFileSync(file), before = store.getReadStats('synthetic-search', currentGroup);
  for (const keyword of ['中文', '中文输入法', '中文词句与 OpenAI API v2', '粘贴第一行\n第二行', '']) {
    const result = store.queryMessages('synthetic-search', { groupId: currentGroup, keyword });
    assert.ok(result.messages.every(row => row.groupId === currentGroup));
  }
  assert.deepEqual(store.getReadStats('synthetic-search', currentGroup), before);
  assert.deepEqual(fs.readFileSync(file), bytes);
});
