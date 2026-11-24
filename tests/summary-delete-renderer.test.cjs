'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Exercise the shipped result-handling functions, with only their UI side
// effects replaced. No Electron process, user profile, or persisted data is used.
const renderer = fs.readFileSync(require.resolve('../app/renderer/app.js'), 'utf8');
const start = renderer.indexOf('function summaryDeleteContextCurrent(');
const end = renderer.indexOf('\nasync function confirmDeleteSummary(', start);
assert.ok(start >= 0 && end > start, 'the renderer deletion result handler must exist');
const source = renderer.slice(start, end);
const plain = value => JSON.parse(JSON.stringify(value));
const summary = (id, groupId = 'g1') => ({ id, groupId, title: '同名摘要', body: `合成正文 ${id}` });

function harness() {
  const calls = [];
  const model = {
    state: { account: { id: 'fixture-a' }, stats: { summaries: 3, messages: 50, bookmarks: 2 } },
    accountEpoch: 4, switching: false, view: 'summaries', groupId: 'g1',
    summary: null, summaries: [summary('s1'), summary('s2'), summary('s3', 'g2')],
    aiRequest: null, filters: { keyword: '保留', senderIds: ['member-1'] },
    readStates: { g1: { anchorId: '9007199254740993001', unreadCount: 7 } }
  };
  const operation = {
    accountId: 'fixture-a', summaryId: 's2', groupId: 'g1', epoch: 4,
    view: 'summaries', viewGroupId: 'g1', detailId: undefined,
    scrollTop: 145, cardIndex: 1
  };
  model.summaryDeletion = operation;
  const focusable = id => ({ focus: options => calls.push({ name: 'focus', id, options: plain(options) }) });
  const scroll = { scrollTop: 32 };
  let choices = model.summaries.map(s => focusable(s.id));
  const emptyAction = focusable('empty-action');
  const workspace = {
    querySelector(selector) {
      if (selector === '.content-scroll') return model.summaries.length ? scroll : null;
      if (selector === '.empty-actions button') return model.summaries.length ? null : emptyAction;
      throw new Error(`Unexpected workspace selector: ${selector}`);
    }
  };
  const context = vm.createContext({
    model,
    $: id => {
      assert.equal(id, 'workspace-content');
      return workspace;
    },
    document: {
      querySelectorAll(selector) {
        assert.equal(selector, '.summary-open');
        return choices;
      }
    },
    renderSidebar: () => calls.push({ name: 'sidebar' }),
    renderHeader: () => calls.push({ name: 'header' }),
    renderSummaries: () => {
      choices = model.summaries.map(s => focusable(s.id));
      calls.push({ name: 'summaries', ids: model.summaries.map(s => s.id) });
    },
    renderInspector: () => calls.push({ name: 'inspector' }),
    toast: message => calls.push({ name: 'toast', message })
  });
  vm.runInContext(source, context, { filename: 'summary-delete-renderer-functions.js' });
  return {
    model, operation, calls, scroll,
    result: extra => ({ accountId: 'fixture-a', summaryId: 's2', groupId: 'g1', deleted: true, summaryCount: 2, ...extra }),
    apply(result) { context.applySummaryDeletion(result === undefined ? this.result() : result, operation); },
    current: () => context.summaryDeleteContextCurrent(operation)
  };
}

test('successful deletion removes only its stable ID and updates summary count without changing other local state', () => {
  const h = harness();
  const before = plain(h.model);
  h.apply();
  assert.deepEqual(h.model.summaries.map(s => s.id), ['s1', 's3']);
  assert.deepEqual(plain(h.model.summaries), [before.summaries[0], before.summaries[2]]);
  assert.deepEqual(h.model.state.stats, { summaries: 2, messages: 50, bookmarks: 2 });
  assert.deepEqual(h.model.filters, before.filters);
  assert.deepEqual(h.model.readStates, before.readStates);
  assert.equal(h.scroll.scrollTop, 145);
  assert.deepEqual(h.calls.find(c => c.name === 'focus'), { name: 'focus', id: 's3', options: { preventScroll: true } });
  assert.match(h.calls.find(c => c.name === 'toast').message, /已从本机删除/);
});

test('deleting the open detail returns to the saved summary list and focuses its remaining entry', () => {
  const h = harness();
  h.model.summary = h.model.summaries[1];
  h.operation.detailId = 's2';
  h.apply();
  assert.equal(h.model.summary, null);
  assert.equal(h.model.view, 'summaries');
  assert.equal(h.model.groupId, 'g1');
  assert.equal(h.calls.filter(c => c.name === 'summaries').length, 1);
  assert.equal(h.calls.filter(c => c.name === 'inspector').length, 1);
  assert.equal(h.calls.find(c => c.name === 'focus').id, 's3');
});

test('deleting the last summary updates count to zero and focuses the empty state action', () => {
  const h = harness();
  h.model.summaries = [summary('s2')];
  h.model.state.stats.summaries = 1;
  h.operation.cardIndex = 0;
  h.apply(h.result({ summaryCount: 0 }));
  assert.equal(h.model.summaries.length, 0);
  assert.equal(h.model.state.stats.summaries, 0);
  assert.deepEqual(h.calls.find(c => c.name === 'summaries').ids, []);
  assert.equal(h.calls.find(c => c.name === 'focus').id, 'empty-action');
});

test('the last card chooses the preceding surviving card without moving the viewport', () => {
  const h = harness();
  h.operation.cardIndex = 2;
  h.operation.summaryId = 's3';
  h.operation.groupId = 'g2';
  h.apply(h.result({ summaryId: 's3', groupId: 'g2' }));
  assert.deepEqual(h.model.summaries.map(s => s.id), ['s1', 's2']);
  assert.equal(h.calls.find(c => c.name === 'focus').id, 's2');
  assert.equal(h.scroll.scrollTop, 145);
});

test('a missing persisted target removes its stale card and reports the distinct missing result', () => {
  const h = harness();
  h.apply(h.result({ deleted: false, missing: true }));
  assert.deepEqual(h.model.summaries.map(s => s.id), ['s1', 's3']);
  assert.equal(h.model.state.stats.summaries, 2);
  assert.match(h.calls.find(c => c.name === 'toast').message, /已不存在/);
  assert.doesNotMatch(h.calls.find(c => c.name === 'toast').message, /已从本机删除/);
});

for (const [name, change] of [
  ['different current account', h => { h.model.state.account.id = 'fixture-b'; }],
  ['new account epoch', h => { h.model.accountEpoch++; }]
]) {
  test(`${name} ignores the old deletion result without rendering, focusing, or changing current data`, () => {
    const h = harness();
    change(h);
    const before = plain(h.model);
    h.apply();
    assert.deepEqual(plain(h.model), before);
    assert.deepEqual(h.calls, []);
  });
}

test('navigation to another group while deletion resolves never forces the reading pane back to summaries', () => {
  const h = harness();
  h.model.view = 'read';
  h.model.groupId = 'g2';
  h.apply();
  assert.equal(h.model.view, 'read');
  assert.equal(h.model.groupId, 'g2');
  assert.deepEqual(h.model.summaries.map(s => s.id), ['s1', 's3']);
  assert.equal(h.model.state.stats.summaries, 2);
  assert.equal(h.scroll.scrollTop, 32);
  assert.ok(!h.calls.some(c => ['summaries', 'inspector', 'focus'].includes(c.name)));
});

test('a different open detail remains open when an earlier card deletion finishes', () => {
  const h = harness();
  h.model.summary = h.model.summaries[2];
  h.model.groupId = 'g2';
  const current = h.model.summary;
  h.apply();
  assert.equal(h.model.summary, current);
  assert.equal(h.model.view, 'summaries');
  assert.equal(h.model.groupId, 'g2');
  assert.ok(!h.calls.some(c => ['summaries', 'inspector', 'focus'].includes(c.name)));
});

test('deleting an AI completion clears the cached completion so its old button cannot reopen it', () => {
  const h = harness();
  h.model.aiRequest = { accountId: 'fixture-a', status: 'complete', summary: h.model.summaries[1] };
  h.apply();
  assert.equal(h.model.aiRequest, null);
  assert.ok(h.calls.some(c => c.name === 'header'));
});

for (const [name, accountId, summaryId] of [
  ['another summary', 'fixture-a', 's1'],
  ['another account with the same summary ID', 'fixture-b', 's2']
]) {
  test(`deletion preserves the AI completion for ${name}`, () => {
    const h = harness();
    h.model.aiRequest = { accountId, status: 'complete', summary: summary(summaryId) };
    const request = h.model.aiRequest;
    h.apply();
    assert.equal(h.model.aiRequest, request);
  });
}

test('malformed or mismatched results fail before mutating data or repainting success', () => {
  const invalid = [
    null, {},
    { accountId: 'wrong' }, { summaryId: 'wrong' }, { groupId: 'wrong' },
    { deleted: false }, { summaryCount: -1 }, { summaryCount: 1.5 }, { summaryCount: '2' }
  ];
  for (const item of invalid) {
    const h = harness();
    const before = plain(h.model);
    const result = item === null || Object.keys(item).length === 0 ? item : h.result(item);
    assert.throws(() => h.apply(result), /删除结果无法核对/);
    assert.deepEqual(plain(h.model), before);
    assert.deepEqual(h.calls, []);
  }
});

test('confirmation context becomes stale for owner, account, view, group, detail or switching changes', () => {
  const mutations = [
    h => { h.model.summaryDeletion = { ...h.operation }; },
    h => { h.model.switching = true; },
    h => { h.model.accountEpoch++; },
    h => { h.model.state.account.id = 'fixture-b'; },
    h => { h.model.view = 'read'; },
    h => { h.model.groupId = 'g2'; },
    h => { h.model.summary = h.model.summaries[0]; }
  ];
  for (const mutate of mutations) {
    const h = harness();
    assert.equal(h.current(), true);
    mutate(h);
    assert.equal(h.current(), false);
  }
});
