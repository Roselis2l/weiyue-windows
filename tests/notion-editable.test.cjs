'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const os = require('node:os');
const path = require('node:path');
const { NotionClient, buildPreview, buildEditablePreview, resolveNotionSource, MAX_DRAFT_BODY_CHARS } = require('../app/core/notion.cjs');
const { localSummary, prepareSummary } = require('../app/core/summary.cjs');
const { Store } = require('../app/core/store.cjs');

const target = '11111111-1111-4111-8111-111111111111';
const pageId = '22222222-2222-4222-8222-222222222222';
const start = Date.parse('2026-10-20T00:00:00Z');
const message = (id, text = `原文 ${id}`, time = start + 1, groupId = 'g1') => ({ id, groupId, text, time, senderId: 'u1', senderName: '模拟成员' });
const summary = () => ({ id: 's1', title: '原摘要', body: '原摘要正文 [M1]', mode: 'ai', start, end: start + 3600000, warning: '覆盖与核查提示：仅本地保留', refs: [{ ...message('9007199254740993001'), label: 'M1' }] });
const state = () => ({
  summaries: [summary()], exports: {}, groups: [{ id: 'g1', name: '模拟群' }],
  messages: [message('9007199254740993002'), message('9007199254740993001'), message('4', '较晚消息', start + 2)],
  bookmarks: [
    { id: 'b1', groupId: 'g1', messageIds: ['4', '9007199254740993002', '9007199254740993001'], note: '保留备注', tags: ['项目'] },
    { id: 'b2', groupId: 'g1', messageIds: ['9007199254740993001'], note: '另一备注', tags: [] },
  ],
});
const draft = (extra = {}) => ({ title: '编辑标题', body: '编辑后的正文', includeReferences: true, ...extra });
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });
const createResponse = () => response({ id: pageId, url: `https://www.notion.so/${pageId}` });
const appendResponse = options => response({ results: JSON.parse(options.body).children.map((_, i) => ({ id: String(i) })) });
const client = fetch => new NotionClient({ token: 'offline-fixture-token', fetch, sleep: async () => {} });
const blockText = blocks => blocks.map(block => block[block.type].rich_text.map(part => part.text.content).join('')).join('\n');

test('editable preview removes generated warnings but preserves original summary and user draft literally', () => {
  const original = summary(), copy = structuredClone(original);
  const preview = buildPreview(original, target, { editable: true });
  assert.equal(preview.body, original.body);
  assert.equal(preview.includeReferences, true);
  assert.doesNotMatch(blockText(preview.blocks), /覆盖与核查提示|请核查原文/);
  const arbitrary = '<script>alert(1)</script>\n{"type":"embed","url":"https://evil.invalid"}\n覆盖与核查提示：用户保留';
  const edited = buildPreview(original, target, { draft: draft({ body: arbitrary, includeReferences: false }) });
  assert.equal(edited.body, arbitrary);
  assert.ok(edited.blocks.every(block => ['paragraph', 'heading_2'].includes(block.type)));
  assert.ok(edited.blocks.every(block => !JSON.stringify(block).includes('"type":"embed"')));
  assert.doesNotMatch(blockText(edited.blocks), /原文 9007199254740993001|群 ID：/);
  assert.deepEqual(original, copy);
});

test('local default export removes only generated warning slot and never deletes authored drafts or references', () => {
  const prepared = prepareSummary({ messages: [message('1', '覆盖提示：\n这是聊天原话')], group: { id: 'g1', name: '群', coverage: null }, start, end: start + 3600000 });
  const source = localSummary(prepared), before = structuredClone(source);
  const preview = buildPreview(source, target, { editable: true });
  assert.ok(source.body.includes(`覆盖提示：\n${source.warning}`));
  assert.ok(!preview.body.includes(`覆盖提示：\n${source.warning}`));
  assert.ok(preview.body.includes('这是聊天原话'));
  assert.ok(preview.referencesText.includes('这是聊天原话'));
  assert.deepEqual(source, before);
  assert.equal(buildPreview(source, target, { draft: draft({ body: source.body }) }).body, source.body);
});

test('bookmark source is scoped, deterministic, ordered with large IDs, deduplicates references and preserves sources', () => {
  const source = state(), before = structuredClone(source);
  const a = resolveNotionSource(source, { bookmarkIds: ['b2', 'b1'] });
  const b = resolveNotionSource(source, { bookmarkIds: ['b1', 'b2'] });
  assert.deepEqual(a, b);
  assert.deepEqual(a.refs.map(item => item.id), ['9007199254740993001', '9007199254740993002', '4']);
  assert.match(a.body, /保留备注/); assert.match(a.body, /项目/); assert.match(a.body, /另一备注/);
  assert.equal(a.refs.length, 3);
  assert.deepEqual(source, before);
  assert.deepEqual(buildPreview(a, target, { editable: true }).sourceIds, ['b1', 'b2']);
  assert.equal(resolveNotionSource(source, { bookmarkIds: ['b2'] }).refs.length, 1);
  for (const payload of [{}, { bookmarkIds: [] }, { bookmarkIds: ['missing'] }, { bookmarkIds: ['b1', 'b1'] }, { summaryId: 's1', bookmarkIds: ['b1'] }, { summaryId: 'other-account' }, { bookmarkIds: Array.from({ length: 101 }, (_, i) => `b${i}`) }]) assert.throws(() => resolveNotionSource(source, payload));
});

test('editable limits reject malformed values before any network and accept exact body boundary', async () => {
  const source = summary();
  assert.equal(buildPreview(source, target, { draft: draft({ body: 'a'.repeat(MAX_DRAFT_BODY_CHARS) }) }).body.length, MAX_DRAFT_BODY_CHARS);
  let calls = 0; const n = client(async () => { calls++; return createResponse(); });
  for (const value of [
    draft({ body: 'a'.repeat(MAX_DRAFT_BODY_CHARS + 1) }), draft({ title: 'a'.repeat(181) }),
    draft({ title: ' ' }), draft({ title: 'a\nb' }), draft({ body: '\u0000' }),
    draft({ includeReferences: 'true' }), draft({ body: {} }), null,
  ]) await assert.rejects(n.exportSummary(source, target, { draft: value, journal: {}, saveJournal: async () => {} }));
  const excessive = { ...source, refs: Array.from({ length: 2001 }, (_, i) => ({ ...source.refs[0], id: String(i), text: '' })) };
  assert.throws(() => buildPreview(excessive, target, { editable: true }), /2000/);
  const huge = { ...source, refs: Array.from({ length: 5 }, (_, i) => ({ ...source.refs[0], id: String(i), text: 'a'.repeat(1000000) })) };
  assert.throws(() => buildPreview(huge, target, { editable: true }), /缩小/);
  assert.equal(calls, 0);
});

test('actual write uses edited title/body and reference choice; exact duplicates reuse, edits make new keys', async () => {
  const source = summary(), journal = {}, requests = [];
  const n = client(async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return createResponse(); });
  const saveJournal = async () => {};
  const body = '<b>编辑正文</b>\n[M1] 保留引用标记';
  const edited = draft({ body, includeReferences: false });
  const sourceHash = buildPreview(source, target, { editable: true }).sourceHash;
  await n.exportSummary(source, target, { journal, saveJournal, draft: edited, sourceHash });
  await n.exportSummary(source, target, { journal, saveJournal, draft: edited, sourceHash });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.properties.title.title[0].text.content, edited.title);
  assert.ok(blockText(requests[0].body.children).includes(body));
  assert.doesNotMatch(blockText(requests[0].body.children), /引用原文与本地定位|群 ID：|覆盖与核查/);
  await n.exportSummary(source, target, { journal, saveJournal, draft: { ...edited, includeReferences: true }, sourceHash });
  assert.equal(requests.length, 2);
  assert.match(blockText(requests[1].body.children), /原文 9007199254740993001|群 ID：/);
  await n.exportSummary(source, target, { journal, saveJournal, draft: { ...edited, body: '另一稿' }, sourceHash });
  assert.equal(requests.length, 3);
  assert.equal(Object.keys(journal).length, 3);
});

test('stale source hash is rejected without writes even when edited draft itself has not changed', async () => {
  const source = summary(), sourceHash = buildPreview(source, target, { editable: true }).sourceHash;
  let calls = 0;
  source.refs[0].text = '来源已变化';
  await assert.rejects(client(async () => { calls++; return createResponse(); }).exportSummary(source, target, { draft: draft(), sourceHash, journal: {}, saveJournal: async () => {} }), { code: 'NOTION_SOURCE_CHANGED' });
  assert.equal(calls, 0);
});

test('legacy and edited pending/uncertain journals block different drafts in both directions', async () => {
  for (const status of ['pending', 'uncertain']) {
    const source = summary(), legacy = buildPreview(source, target), edited = buildPreview(source, target, { draft: draft() });
    let calls = 0; const n = client(async () => { calls++; return createResponse(); });
    const previous = { status, contentHash: legacy.contentHash, pageId };
    await assert.rejects(n.exportSummary(source, target, { draft: draft(), journal: { [legacy.key]: previous }, saveJournal: async () => {} }), { code: 'NOTION_UNCERTAIN' });
    const newEntry = { status, sourceKey: edited.sourceKey, contentHash: edited.contentHash, pageId };
    await assert.rejects(n.exportSummary(source, target, { draft: draft({ body: '绕过稿' }), journal: { [edited.key]: newEntry }, saveJournal: async () => {} }), { code: 'NOTION_UNCERTAIN' });
    await assert.rejects(n.exportSummary(source, target, { journal: { [edited.key]: newEntry }, saveJournal: async () => {} }), { code: 'NOTION_UNCERTAIN' });
    assert.equal(calls, 0);
  }
});

test('legacy partial and failed-with-page block cross-draft writes but known create failure permits an edit', async () => {
  for (const status of ['partial', 'failed']) {
    const source = summary(), legacy = buildPreview(source, target);
    let calls = 0; const n = client(async () => { calls++; return createResponse(); });
    await assert.rejects(n.exportSummary(source, target, { draft: draft(), journal: { [legacy.key]: { status, pageId, contentHash: legacy.contentHash } }, saveJournal: async () => {} }), { code: 'NOTION_PARTIAL_DRAFT' });
    assert.equal(calls, 0);
  }
  const source = summary(), rejected = buildPreview(source, target, { draft: draft() });
  let calls = 0;
  await client(async () => { calls++; return createResponse(); }).exportSummary(source, target, { draft: draft({ body: '修正版' }), journal: { [rejected.key]: { status: 'failed', sourceKey: rejected.sourceKey, contentHash: rejected.contentHash } }, saveJournal: async () => {} });
  assert.equal(calls, 1);
});

test('partial edited draft resumes exact page and offset, blocks altered drafts, then duplicates make no writes', async () => {
  const source = resolveNotionSource(state(), { bookmarkIds: ['b1', 'b2'] }), edited = draft({ body: 'a'.repeat(190000) });
  const journal = {}, requests = []; let rejectAppend = true;
  const n = client(async (url, options) => {
    requests.push({ url, options });
    if (options.method === 'POST') return createResponse();
    if (rejectAppend) return response({ message: 'known rejection' }, 400);
    return appendResponse(options);
  });
  const options = { journal, saveJournal: async () => {}, draft: edited };
  await assert.rejects(n.exportSummary(source, target, options), /HTTP 400/);
  const first = Object.values(journal)[0]; assert.equal(first.status, 'failed'); assert.equal(first.pageId, pageId);
  assert.equal(first.nextBlock, 100); assert.equal(requests.length, 2);
  await assert.rejects(n.exportSummary(source, target, { ...options, draft: { ...edited, body: 'changed' } }), { code: 'NOTION_PARTIAL_DRAFT' });
  assert.equal(requests.length, 2);
  rejectAppend = false;
  await n.exportSummary(source, target, options);
  const count = requests.length;
  await n.exportSummary(source, target, options);
  assert.equal(requests.length, count);
  assert.equal(requests.filter(item => item.options.method === 'POST').length, 1);
  assert.ok(requests.slice(2).every(item => item.url.endsWith(`/blocks/${pageId}/children`)));
});

test('disk journal survives restart and preview restores original edited draft and refs choice before append-only recovery', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'weiyue-notion-editable-test-'));
  try {
    const local = new Store(temp), accountId = 'isolated-mock';
    local.ensureAccount({ id: accountId, name: '模拟本地账号', kind: 'demo' });
    const group = { id: 'g1', name: '模拟群', coverage: null };
    const source = localSummary(prepareSummary({ messages: [message('1')], group, start, end: start + 3600000 }));
    local.update(accountId, saved => { saved.summaries = [source]; });
    const edited = draft({ body: 'long edited text '.repeat(11000), includeReferences: false });
    const firstClient = client(async (_url, options) => options.method === 'POST' ? createResponse() : response({ message: 'append rejected' }, 400));
    await assert.rejects(firstClient.exportSummary(source, target, { journal: local.get(accountId).exports, draft: edited, saveJournal: journal => local.update(accountId, saved => { saved.exports = journal; }) }), /HTTP 400/);
    const reopened = new Store(temp), saved = reopened.get(accountId);
    const original = structuredClone(saved.summaries[0]);
    const restored = buildEditablePreview(resolveNotionSource(saved, { summaryId: source.id }), target, saved.exports);
    assert.equal(restored.title, edited.title); assert.equal(restored.body, edited.body);
    assert.equal(restored.includeReferences, false); assert.match(restored.resumeNotice, /原编辑稿/);
    const calls = [];
    const nextClient = client(async (url, options) => { calls.push({ url, options }); return appendResponse(options); });
    await nextClient.exportSummary(saved.summaries[0], target, { journal: saved.exports, sourceHash: restored.sourceHash, draft: { title: restored.title, body: restored.body, includeReferences: restored.includeReferences }, saveJournal: journal => reopened.update(accountId, item => { item.exports = journal; }) });
    assert.ok(calls.length > 0); assert.ok(calls.every(call => call.options.method === 'PATCH' && call.url.endsWith(`/blocks/${pageId}/children`)));
    assert.deepEqual(reopened.get(accountId).summaries[0], original);
    assert.equal(Object.values(reopened.get(accountId).exports)[0].status, 'completed');
  } finally {
    const resolved = path.resolve(temp);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('weiyue-notion-editable-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test('recovery preview refuses unknown writes, legacy partial without draft, changed source and corrupt saved draft', () => {
  const source = summary(), edited = draft(), preview = buildPreview(source, target, { draft: edited });
  const saved = { status: 'failed', pageId, sourceKey: preview.sourceKey, contentHash: preview.contentHash, draft: edited, sourceHash: preview.sourceHash };
  assert.match(buildEditablePreview(source, target, { [preview.key]: saved }).resumeNotice, /续传/);
  for (const status of ['pending', 'uncertain']) assert.throws(() => buildEditablePreview(source, target, { [preview.key]: { ...saved, status } }), { code: 'NOTION_UNCERTAIN' });
  const legacy = buildPreview(source, target);
  assert.throws(() => buildEditablePreview(source, target, { [legacy.key]: { status: 'partial', pageId } }), { code: 'NOTION_PARTIAL_DRAFT' });
  assert.throws(() => buildEditablePreview({ ...source, body: 'source changed' }, target, { [preview.key]: saved }), { code: 'NOTION_SOURCE_CHANGED' });
  assert.throws(() => buildEditablePreview(source, target, { [preview.key]: { ...saved, draft: draft({ body: 'tampered' }) } }), { code: 'NOTION_PARTIAL_DRAFT' });
});

const mainSource = fs.readFileSync(require.resolve('../app/main.cjs'), 'utf8');
const handleSource = mainSource.slice(mainSource.indexOf('async function handle(action,p){'), mainSource.indexOf('\nasync function start(){'));
function mainHarness({ confirm = async () => {}, fetch = async () => createResponse() } = {}) {
  const local = state(), calls = { secrets: [], writes: 0, dialogs: [] };
  const context = vm.createContext({
    activeId: 'local-account', busy: false, cleanupBusy: () => false, account: () => local,
    store: { contentEpoch:()=>local.contentEpoch,getVisible: id => { assert.equal(id, 'local-account'); return local; }, update: (id, fn) => { assert.equal(id, 'local-account'); calls.writes++; fn(local); } },
    secrets: id => { calls.secrets.push(id); return { notionToken: 'offline-fixture-token' }; },
    confirmSend: async (...args) => { calls.dialogs.push(args); await confirm(local, context); },
    NotionClient, buildPreview, buildEditablePreview, resolveNotionSource, net: { fetch },
  });
  vm.runInContext(`${handleSource}\nglobalThis.handle = handle;`, context);
  return { context, local, calls, handle: context.handle };
}

test('main local preview can be dismissed without any token, network request, dialog or journal write', async () => {
  let requests = 0;
  const h = mainHarness({ confirm: async () => { throw new Error('Unexpected confirmation'); }, fetch: async () => { requests++; return createResponse(); } });
  const preview = await h.handle('notion.preview', { summaryId: 's1', targetId: target });
  assert.equal(preview.title, '原摘要');
  assert.equal(h.calls.secrets.length, 0); assert.equal(h.calls.dialogs.length, 0);
  assert.equal(requests, 0); assert.equal(h.calls.writes, 0); assert.equal(h.calls.secrets.length, 0); assert.equal(h.context.busy, false);
});

test('a content epoch change rejects an old Notion draft even when saved text is identical',async()=>{
  let requests=0;const h=mainHarness({fetch:async()=>{requests++;return createResponse();}});
  h.local.contentEpoch='before';const preview=await h.handle('notion.preview',{summaryId:'s1',targetId:target});
  h.local.contentEpoch='after';
  await assert.rejects(h.handle('notion.export',{summaryId:'s1',targetId:target,sourceHash:preview.sourceHash,draft:draft(),confirmed:true}),/来源已变化/);
  assert.equal(requests,0);assert.equal(h.calls.writes,0);
});

test('saving one projected export preserves unrelated private journal fields byte for byte',async()=>{
  const h=mainHarness();h.local.exports.unrelated={status:'completed',draft:{body:'synthetic retained draft',title:'synthetic',includeReferences:true}};
  const original=structuredClone(h.local.exports.unrelated);
  h.context.store.getVisible=()=>({...h.local,exports:{...h.local.exports,unrelated:{status:'completed'}}});
  const preview=await h.handle('notion.preview',{summaryId:'s1',targetId:target});
  await h.handle('notion.export',{summaryId:'s1',targetId:target,sourceHash:preview.sourceHash,draft:draft(),confirmed:true});
  assert.deepEqual(h.local.exports.unrelated,original);
});

test('main still requires explicit submit, valid target and source hash, and rejects changed preview source', async () => {
  let requests = 0;
  const h = mainHarness({ fetch: async () => { requests++; return createResponse(); } });
  const preview = await h.handle('notion.preview', { summaryId: 's1', targetId: target, accountId: 'attacker-account' });
  const payload = { summaryId: 's1', targetId: target, sourceHash: preview.sourceHash, draft: draft(), confirmed: true };
  await assert.rejects(h.handle('notion.export', { ...payload, confirmed: false }), /确认导出/);
  await assert.rejects(h.handle('notion.export', { ...payload, draft: undefined }), /确认导出/);
  await assert.rejects(h.handle('notion.export', { ...payload, summaryId: 'other-account' }), /当前账号/);
  await assert.rejects(h.handle('notion.export', { ...payload, targetId: 'invalid' }), /Notion.*ID|目标/);
  h.local.summaries[0].body = 'changed after preview';
  await assert.rejects(h.handle('notion.export', payload), /来源已变化/);
  assert.equal(requests, 0); assert.equal(h.calls.writes, 0); assert.equal(h.calls.secrets.length, 0); assert.equal(h.calls.dialogs.length, 0);
});

for (const [name, selection] of [['summary', { summaryId: 's1' }], ['multiple bookmarks', { bookmarkIds: ['b1', 'b2'] }]]) {
  test(`main directly submits edited ${name} once without a second confirmation, retaining busy protection and immutable content`, async () => {
    const requests = []; let release, arrived;
    const ready = new Promise(resolve => { arrived = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    const h = mainHarness({ confirm: async () => { throw new Error('Unexpected confirmation'); }, fetch: async (url, options) => {
      requests.push({ url, options }); arrived(); await held; return createResponse();
    } });
    const original = structuredClone({ summaries: h.local.summaries, bookmarks: h.local.bookmarks, messages: h.local.messages });
    const preview = await h.handle('notion.preview', { ...selection, targetId: target });
    const payload = { ...structuredClone(selection), targetId: target, sourceHash: preview.sourceHash, draft: draft({ includeReferences: false }), confirmed: true };
    const pending = h.handle('notion.export', payload);
    await ready;
    assert.equal(h.context.busy, true);
    await assert.rejects(h.handle('notion.export', payload), /已有操作/);
    payload.draft.body = 'unexpected late change'; payload.accountId = 'other'; payload.targetId = 'bad';
    if (payload.bookmarkIds) payload.bookmarkIds.splice(0);
    release(); const result = await pending;
    assert.equal(requests.length, 1); assert.equal(result.status, 'completed');
    const body = JSON.parse(requests[0].options.body);
    assert.equal(body.parent.page_id, target);
    assert.match(blockText(body.children), /编辑后的正文/);
    assert.doesNotMatch(blockText(body.children), /unexpected late change|原文 900719/);
    assert.deepEqual(h.calls.secrets, ['local-account']); assert.equal(h.calls.dialogs.length, 0);
    assert.deepEqual({ summaries: h.local.summaries, bookmarks: h.local.bookmarks, messages: h.local.messages }, original);
    assert.equal(h.context.busy, false);
  });
}

test('IPC large draft allowance is restricted to Notion actions and still checks sender and bounded payload', async () => {
  const from = mainSource.indexOf("  ipcMain.handle('weiyue:call'");
  const code = mainSource.slice(from, mainSource.indexOf('\n  });', from) + 6);
  let handler; const calls = [];
  const mainFrame = { url: 'app://local/index.html' }, webContents = { mainFrame };
  const context = vm.createContext({ win: { webContents }, ipcMain: { handle: (_name, fn) => { handler = fn; } }, handle: async (...args) => { calls.push(args); return true; }, secrets: () => ({}), redact: value => value });
  vm.runInContext(code, context);
  const event = { sender: webContents, senderFrame: mainFrame };
  const escaped = { draft: draft({ body: '\t'.repeat(MAX_DRAFT_BODY_CHARS) }) };
  assert.ok((await handler(event, 'notion.export', escaped)).ok);
  assert.ok((await handler(event, 'notion.preview', escaped)).ok);
  assert.equal((await handler(event, 'settings.save', escaped)).ok, false);
  assert.equal((await handler(event, 'notion.export', { body: 'a'.repeat(1250000) })).ok, false);
  assert.equal((await handler({ ...event, senderFrame: { url: mainFrame.url } }, 'notion.export', escaped)).ok, false);
  assert.equal((await handler(event, 'notion.export', [])).ok, false);
  assert.equal(calls.length, 2);
});
