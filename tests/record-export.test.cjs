'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { exportRecord, referenceWithIdentity, metadataLine, exportBookmarks } = require('../app/core/record-export.cjs');
const { prepareSummary, localSummary } = require('../app/core/summary.cjs');
const { exportSummaryMarkdown } = require('../app/core/summary-export.cjs');
const { resolveNotionSource, buildPreview } = require('../app/core/notion.cjs');
const start = Date.parse('2026-11-23T00:00:00+08:00'), end = start + 86400000;
const group = { id: 'synthetic-group', name: 'Synthetic', coverage: { oldest: start, newest: end - 1, complete: true } };
const msg = (id, patch = {}) => ({ id, groupId: group.id, time: start + 1, senderId: 'member-a', senderName: 'Same name', text: 'Original first\nsecond line', ...patch });
const recall = { state: 'withdrawn', protocol: 'weibo-group-344', observedAt: start + 2 };
const notice = { kind: 'weibo-system', type: 345, subType: 0 };
const missing = msg('missing', { recall: { ...recall, originalAvailable: false }, systemNotice: { kind: 'weibo-system', type: 344, subType: 331 }, text: 'DO NOT EXPORT', images: [{ url: 'https://example.invalid/private' }], editionData: { received: { text: 'NEVER READ' } } });
const retained = msg('retained', { recall: { ...recall, originalAvailable: true }, text: 'Synthetic retained text' });
const bookmark = messages => ({ id: 'b', groupId: group.id, messageIds: messages.map(m => m.id), tags: ['tag'], note: 'note', messages });
const prepared = messages => prepareSummary({ messages, group, start, end });
const target = '11111111-1111-4111-8111-111111111111';

test('each record exports stable actual IDs without merging same-name members or quoted identities', () => {
  const a = msg('a', { reply: { senderId: 'quoted-other' }, sharedPost: { author: 'Forwarded name', authorId: 'forwarded-other' } });
  const b = msg('b', { senderId: 'member-b' });
  const records = JSON.parse(exportBookmarks([bookmark([a, b])], 'json'))[0].messages;
  assert.deepEqual(records.map(r => r.actualSenderId), ['member-a', 'member-b']);
  assert.ok(records.every(r => r.messageType === 'member-message'));
  assert.deepEqual(records.map(r => r.text), [a.text, b.text]);
  assert.equal(records[0].senderId, a.senderId);
  assert.equal(records[0].groupId, group.id);
  assert.equal(records[0].id, 'a');
});

test('Markdown preserves existing identity header and indented body while adding explicit metadata', () => {
  const a = msg('9007199254740993001');
  const markdown = exportBookmarks([bookmark([a, msg('system', { systemNotice: notice }), retained, missing])]);
  assert.ok(markdown.includes(`${a.senderName} · ${a.groupId}/${a.id}`));
  assert.ok(markdown.includes('  Original first\n  second line'));
  assert.match(markdown, /发送者 ID：member-a · 消息类型：成员消息 \[member-message\]/);
  assert.match(markdown, /发送者 ID：未提供 · 消息类型：系统通知 \[system-notice\] · 关联成员 ID：member-a（非发送者）/);
  assert.match(markdown, /已撤回（本机留存原文）/);
  assert.match(markdown, /withdrawn-unavailable/);
  assert.doesNotMatch(markdown, /DO NOT EXPORT|NEVER READ/);
});

test('system association IDs remain compatible JSON fields but never claim actual authorship', () => {
  const source = msg('system', { systemNotice: notice }), exported = exportRecord(source);
  assert.equal(exported.senderId, source.senderId);
  assert.equal(exported.actualSenderId, null);
  assert.equal(exported.recordIdentity.senderId, null);
  assert.equal(exported.recordIdentity.associatedSenderId, source.senderId);
  assert.equal(exported.messageType, 'system-notice');
  assert.deepEqual(source, msg('system', { systemNotice: notice }));
});

test('missing, placeholder, malformed and same-name IDs never get invented', () => {
  for (const senderId of [undefined, '', 'unknown:legacy', '0', 'member-a\nmember-b']) {
    const exported = exportRecord(msg('bad', { senderId }));
    assert.equal(exported.actualSenderId, null);
    assert.match(metadataLine(exported), /发送者 ID：未提供/);
  }
  assert.equal(exportRecord(msg('blank-name', { senderName: '' })).actualSenderId, 'member-a');
});

test('retained original metadata is separate from public or missing-original placeholders', () => {
  const original = exportRecord(retained), unavailable = exportRecord(missing);
  assert.equal(original.actualSenderId, 'member-a');
  assert.equal(original.messageType, 'member-message');
  assert.equal(original.recordIdentity.originalAvailable, true);
  assert.equal(original.text, retained.text);
  assert.equal(unavailable.actualSenderId, null);
  assert.equal(unavailable.messageType, 'withdrawn-unavailable');
  assert.doesNotMatch(JSON.stringify(unavailable), /DO NOT EXPORT|NEVER READ|example.invalid|editionData/);
  assert.doesNotMatch(JSON.stringify(exportRecord(msg('safe', { editionData: { received: { text: 'NEVER READ' } }, standaloneEmoticons: [{ url: 'display-only' }] }))), /NEVER READ|display-only|editionData/);
});

test('new summary refs persist identity and local speaking statistics exclude system associations', () => {
  const source = [msg('a'), msg('b', { senderId: 'member-b' }), msg('system', { systemNotice: notice, senderName: 'System label' }), retained, missing];
  const pre = prepared(source), summary = localSummary(pre);
  assert.equal(pre.participantCount, 2);
  assert.equal(summary.refs.length, 4);
  assert.deepEqual(summary.refs.map(r => r.actualSenderId), ['member-a', 'member-b', 'member-a', null]);
  assert.equal(summary.refs.find(r => r.id === 'retained').recordIdentity.originalAvailable, true);
  assert.equal(summary.refs.find(r => r.id === 'system').messageType, 'system-notice');
  assert.match(summary.body, /发言成员：2 人/);
  assert.doesNotMatch(summary.body.split('主要发言成员：')[1].split('\n')[0], /System label/);
  assert.doesNotMatch(JSON.stringify(summary), /DO NOT EXPORT|NEVER READ/);
});

test('participant preview counts all selected records, excluding system and unavailable recalls, beyond its first 20 display rows', () => {
  const messages = Array.from({ length: 25 }, (_, n) => msg(String(n), { senderId: 'member-' + n }));
  messages.push(msg('system', { senderId: 'system-associated-only', systemNotice: notice }), missing, retained);
  assert.equal(prepared(messages).participantCount, 26);
});

test('legacy summary refs resolve only exact local visible message identity and never a same-name guess', async () => {
  const ref = { id: 'a', groupId: group.id, time: start + 1, senderName: 'Same name', text: 'Saved text', label: 'M1' };
  assert.equal(referenceWithIdentity(ref).messageType, 'unknown');
  assert.equal(referenceWithIdentity(ref, msg('wrong')).actualSenderId, null);
  assert.equal(referenceWithIdentity(ref, msg('a', { groupId: 'other' })).actualSenderId, null);
  assert.equal(referenceWithIdentity(ref, msg('a', { time: start + 2 })).actualSenderId, null);
  assert.equal(referenceWithIdentity(ref, msg('a')).actualSenderId, 'member-a');
  assert.equal(referenceWithIdentity(ref, msg('a')).text, 'Saved text');
  let output;
  await exportSummaryMarkdown({ summaryId: 's', getSummary: () => ({ id: 's', body: 'Summary', refs: [ref] }),
    getMessage: (gid, id) => { assert.equal(gid, group.id); assert.equal(id, 'a'); return msg('a'); },
    stillCurrent: () => true, choosePath: async () => ({ filePath: 'memory.md' }), write: (_, value) => { output = value; } });
  assert.ok(output.includes(`[M1] ${group.id}/a ${new Date(start + 1).toISOString()}`));
  assert.match(output, /发送者 ID：member-a/);
  assert.ok(output.endsWith('Saved text'));
});

test('Notion summary and bookmark previews carry actual ID/type without mutating source or executing requests', () => {
  const messages = [msg('a'), msg('system', { systemNotice: notice }), retained, missing];
  const state = { messages, groups: [group], summaries: [localSummary(prepared(messages))], bookmarks: [bookmark(messages)] };
  const copy = structuredClone(state);
  for (const payload of [{ summaryId: state.summaries[0].id }, { bookmarkIds: ['b'] }]) {
    const source = resolveNotionSource(state, payload), preview = buildPreview(source, target, { editable: true });
    assert.match(preview.referencesText, /发送者 ID：member-a/);
    assert.match(preview.referencesText, /系统通知 \[system-notice\]/);
    assert.match(preview.referencesText, /关联成员 ID：member-a（非发送者）/);
    assert.doesNotMatch(preview.referencesText, /DO NOT EXPORT|NEVER READ/);
    assert.doesNotMatch(source.body, /DO NOT EXPORT|NEVER READ/);
  }
  assert.deepEqual(state, copy);
});
