'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const file = path.resolve(__dirname, '../app/renderer/filter-controls.js');
const { parseChinaMinuteRange: range, createMemberPicker } = require(file);

test('China local minutes use fixed UTC+08 and include the complete selected end minute', () => {
  assert.deepEqual(range('2026-10-20T18:42', '2026-10-20T18:42'), {
    start: Date.parse('2026-10-20T10:42:00Z'), end: Date.parse('2026-10-20T10:43:00Z'),
  });
  const value = range('2026-10-20T23:59', '2026-10-20T23:59');
  assert.equal(value.end, Date.parse('2026-10-20T16:00:00Z'));
  assert.equal(value.end - value.start, 60000);
  for (const delta of [0, 1, 59999]) assert.ok(value.start + delta < value.end);
  assert.equal(value.start + 60000 < value.end, false);
});

test('empty optional bounds are omitted and epoch zero remains a real bound', () => {
  assert.deepEqual(range('', ''), {});
  assert.deepEqual(range(), {});
  assert.deepEqual(range(null, undefined), {});
  assert.deepEqual(range('1970-01-01T08:00', ''), { start: 0 });
  assert.deepEqual(range('', '1970-01-01T07:59'), { end: 0 });
});

test('valid leap days, year changes and early four-digit years remain exact', () => {
  assert.deepEqual(range('2024-02-29T23:59', '2024-03-01T00:00'), {
    start: Date.parse('2024-02-29T15:59:00Z'), end: Date.parse('2024-02-29T16:01:00Z'),
  });
  assert.equal(range('', '2026-12-31T23:59').end, Date.parse('2026-12-31T16:00:00Z'));
  assert.equal(new Date(range('0099-01-02T08:00', '').start).toISOString(), '0099-01-02T00:00:00.000Z');
});

test('nonexistent dates and out-of-range clock components are rejected with Chinese errors', () => {
  for (const value of [
    '0000-01-01T00:00', '2023-02-29T00:00', '2024-02-30T00:00', '2026-04-31T12:00',
    '2026-00-20T00:00', '2026-13-20T00:00', '2026-10-00T00:00', '2026-10-32T00:00',
    '2026-10-20T24:00', '2026-10-20T18:60',
  ]) {
    assert.throws(() => range(value, ''), /开始时间不是有效的日期或分钟/);
    assert.throws(() => range('', value), /结束时间不是有效的日期或分钟/);
  }
});

test('seconds, timezone suffixes, whitespace and partially formatted values are rejected', () => {
  for (const value of [
    '2026-10-20', '2026-1-20T18:42', '2026-10-2T18:42', '2026-10-20T8:42',
    '2026-10-20T18:2', '2026-10-20T18:42:00', '2026-10-20T18:42Z',
    '2026-10-20T18:42+08:00', '2026-10-20 18:42', ' 2026-10-20T18:42',
    '2026-10-20T18:42\n', '2026-10-20t18:42', '02026-10-20T18:42',
    0, false, {}, ['2026-10-20T18:42'],
  ]) assert.throws(() => range(value, ''), /开始时间格式无效/);
});

test('inverted ranges fail clearly rather than swapping or broadening the chosen bounds', () => {
  assert.throws(() => range('2026-10-20T18:43', '2026-10-20T18:42'), /开始时间不能晚于结束时间/);
  assert.throws(() => range('2027-01-01T00:00', '2026-12-31T23:59'), /开始时间不能晚于结束时间/);
  assert.equal(range('2026-10-20T18:41', '2026-10-20T18:42').end -
    range('2026-10-20T18:41', '2026-10-20T18:42').start, 120000);
});

test('results are identical under UTC, Los Angeles and Shanghai host timezones', () => {
  const code = `process.stdout.write(JSON.stringify(require(${JSON.stringify(file)}).parseChinaMinuteRange('2026-10-20T18:42','2026-10-20T19:01')))`;
  const outputs = ['UTC', 'America/Los_Angeles', 'Asia/Shanghai'].map(TZ =>
    execFileSync(process.execPath, ['-e', code], { encoding: 'utf8', env: { ...process.env, TZ } }));
  assert.equal(outputs[0], outputs[1]); assert.equal(outputs[1], outputs[2]);
  assert.deepEqual(JSON.parse(outputs[0]), {
    start: Date.parse('2026-10-20T10:42:00Z'), end: Date.parse('2026-10-20T11:02:00Z'),
  });
});

test('browser UMD export loads without DOM access and invalid picker containers fail clearly', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  assert.equal(typeof context.WeiyueFilters.parseChinaMinuteRange, 'function');
  assert.equal(typeof context.WeiyueFilters.createMemberPicker, 'function');
  assert.throws(() => createMemberPicker(), /成员筛选需要有效的容器/);
  assert.throws(() => createMemberPicker({ container: {} }), /成员筛选需要有效的容器/);
});
