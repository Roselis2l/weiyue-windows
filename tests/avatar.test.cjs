'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { safeAvatarUrl, firstAvatarUrl, avatarGroupUpdates, MAX_AVATAR_URL_LENGTH } = require('../app/core/avatar.cjs');
const { Store, normalizeMessage } = require('../app/core/store.cjs');
const { prepareSummary, localSummary } = require('../app/core/summary.cjs');
const { normalizeGroups, normalizeMessages, parsePrecisionJson } = require('../app/core/weibo.cjs');

test('manual avatar refresh keeps selected group identity, selection and coverage without adding unrelated groups',()=>{
  const old=[{id:'1',name:'同名',selected:true,coverage:{oldest:1,newest:2}},
    {id:'2',name:'同名',selected:false},{id:'3',name:'同名',selected:true}];
  const url='https://tvax1.sinaimg.cn/profile.jpg';
  const fresh=[{id:'1',name:'远端名称',avatarUrl:url},{id:'2',avatarUrl:url},
    {id:'3',avatarUrl:url},{id:'4',avatarUrl:url}];
  assert.deepEqual(avatarGroupUpdates(old,fresh,'1'),[{...old[0],avatarUrl:url}]);
  assert.equal(avatarGroupUpdates(old,[{id:'1',avatarUrl:'https://evil.example/a'}]).length,0);
  assert.deepEqual(avatarGroupUpdates(old,fresh).map(g=>g.id),['1','3']);
  assert.equal(old[0].avatarUrl,undefined);
});

const avatarA = 'https://tvax1.sinaimg.cn/crop.0.0.100.100.180/mock-a.jpg';
const avatarB = 'https://wx2.sinaimg.cn/large/mock-b.jpg';
const message = (id = '1', extra = {}) => ({
  id, groupId: 'g1', senderId: 'member-1', senderName: '相同昵称', text: '仅模拟群聊正文', time: 1000, ...extra,
});
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weiyue-avatar-test-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(root).startsWith('weiyue-avatar-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const store = new Store(root);
  store.ensureAccount({ id: 'mock-account', name: '模拟账户', kind: 'import' });
  return { root, store };
}

test('avatar URLs accept only bounded approved CDN origins and normalize fragment/host safely', () => {
  assert.equal(safeAvatarUrl(avatarA), avatarA);
  assert.equal(safeAvatarUrl('https://TVAX1.SINAIMG.CN/a.jpg#fragment'), 'https://tvax1.sinaimg.cn/a.jpg');
  assert.equal(firstAvatarUrl(null, 'javascript:alert(1)', avatarA, avatarB), avatarA);
  assert.equal(firstAvatarUrl('', null), null);
  for (const value of [
    undefined, null, {}, [], '', 'https://tvax1.sinaimg.cn/a' + 'x'.repeat(MAX_AVATAR_URL_LENGTH),
    'http://tvax1.sinaimg.cn/a.jpg', 'file:///avatar.png', 'data:image/png;base64,AAAA', 'javascript:alert(1)',
    '//tvax1.sinaimg.cn/a.jpg', 'https://sinaimg.cn.evil.example/a.jpg', 'https://evil-sinaimg.cn/a.jpg',
    'https://tvax1.sinaimg.cn@evil.example/a.jpg', 'https://user:secret@tvax1.sinaimg.cn/a.jpg',
    'https://tvax1.sinaimg.cn:443/a.jpg', 'https://tvax1.sinaimg.cn:8443/a.jpg',
    'https://tvax1.sinaimg.cn./a.jpg', 'https://tvax1..sinaimg.cn/a.jpg',
    'https://-bad.sinaimg.cn/a.jpg', 'https://bad-.sinaimg.cn/a.jpg',
    'https://tvax1.sinaimg.cn\\@evil.example/a.jpg', 'https://tvax1.sinaimg.cn/\na.jpg',
    'https://tva1.sinaimg.com/a.jpg', 'https://upload.api.weibo.com/2/mss/msget?fid=1',
    'https://127.0.0.1/avatar.png', 'https://[::1]/avatar.png',
  ]) assert.equal(safeAvatarUrl(value), null, String(value));
});

test('safe sender avatar remains metadata while invalid or unknown sender avatars are omitted', () => {
  const source = message('1', { senderAvatarUrl: avatarA });
  const normalized = normalizeMessage(source);
  assert.equal(normalized.senderAvatarUrl, avatarA);
  assert.equal(Object.hasOwn(normalized, 'images'), false);
  assert.equal(Object.hasOwn(normalized, 'sharedPost'), false);
  assert.equal(normalized.text, source.text);
  assert.equal(Object.hasOwn(normalizeMessage(message('1', { senderAvatarUrl: 'https://evil.example/a.jpg' })), 'senderAvatarUrl'), false);
  assert.equal(Object.hasOwn(normalizeMessage(message('1', { senderId: 'unknown:1', senderAvatarUrl: avatarA })), 'senderAvatarUrl'), false);
});

test('group avatar candidates are read only from the exact type-2 group profile', () => {
  const groups = normalizeGroups({ contacts: [
    { user: { type: 2, id: '101', name: '同名群', avatar_large: avatarA }, message: { from_user: { id: '71', avatar_large: avatarB } } },
    { user: { type: 2, id: '102', name: '同名群', profile_image_url: avatarB } },
    { user: { type: 1, id: '103', name: '相同昵称', avatar_large: avatarA } },
    { user: { type: 2, id: '104', name: '无群头像' }, message: { from_user: { id: '71', avatar_large: avatarA } }, avatar_large: avatarB },
    { user: { type: 2, id: '105', name: '头像备用字段', avatar_large: 'https://evil.example/a.jpg', profileImageUrl: avatarA } },
    { user: { type: 2, id: '106', idstr: '107', name: '资料ID不一致', avatar_large: avatarA } },
  ] });
  assert.deepEqual(groups.map(g => [g.id, g.avatarUrl]), [
    ['101', avatarA], ['102', avatarB], ['104', undefined], ['105', avatarA], ['106', undefined],
  ]);
  assert.equal(Object.hasOwn(groups[0], 'images'), false);
});

test('a duplicate group entry may fill an omitted avatar only by the same stable group ID', () => {
  const groups = normalizeGroups({ contacts: [
    { user: { type: 2, id: '101', name: '原名称' } },
    { user: { type: 2, id: '102', name: '原名称', avatar_large: avatarB } },
    { user: { type: 2, id: '101', name: '重复名称', profile_image_url: avatarA } },
    { user: { type: 2, id: '101', name: '重复名称', profile_image_url: avatarB } },
  ] });
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0], { id: '101', name: '原名称', selected: false, avatarUrl: avatarA });
  assert.equal(groups[1].avatarUrl, avatarB);
});

test('message avatars require explicit from_user ID agreement and never infer identity from names', () => {
  const raw = (id, sender, extra = {}) => ({ id, gid: '101', from_uid: '71', from_user: sender, time: 1700000000, content: '模拟消息', ...extra });
  const messages = normalizeMessages({ messages: [
    raw('1', { id: '71', screen_name: '同名成员', avatar_large: avatarA }),
    raw('2', { idstr: '72', screen_name: '同名成员', avatar_large: avatarB }, { from_uid: '72' }),
    raw('3', { id: '72', screen_name: '同名成员', avatar_large: avatarB }),
    raw('4', { screen_name: '同名成员', avatar_large: avatarA }),
    raw('5', { id: '71', idstr: '72', avatar_large: avatarA }),
    raw('6', { id: '71', avatar_large: avatarA }, { from_uid: '0' }),
    raw('7', { idstr: '71', profileImageUrl: avatarA }, { from_uid: undefined }),
    raw('8', { id: '71', avatar_large: 'javascript:alert(1)', profile_image_url: avatarB }),
  ] }, '101');
  assert.deepEqual(messages.map(m => m.senderAvatarUrl), [avatarA, avatarB, undefined, undefined, undefined, undefined, avatarA, avatarB]);
  assert.equal(messages[5].senderId, 'unknown:6');
  assert.equal(messages[6].senderId, '71');
  assert.ok(messages.every(m => !m.images && !m.sharedPost));
});

test('avatar identity comparisons preserve large decimal IDs and reject unsafe profile identifiers', () => {
  const parsed = parsePrecisionJson('{"messages":[{"id":9007199254740993001,"gid":101,"from_uid":9007199254740993002,"from_user":{"id":9007199254740993002,"avatar_large":"' + avatarA + '"},"time":1700000000,"content":"模拟"}]}');
  const normalized = normalizeMessages(parsed, '101')[0];
  assert.equal(normalized.senderId, '9007199254740993002');
  assert.equal(normalized.senderAvatarUrl, avatarA);
  parsed.messages[0].from_user.id = Number.MAX_SAFE_INTEGER + 1;
  assert.equal(normalizeMessages(parsed, '101')[0].senderAvatarUrl, undefined);
  parsed.messages[0].from_user.id = '9.007199254740993e15';
  assert.equal(normalizeMessages(parsed, '101')[0].senderAvatarUrl, undefined);
});

test('group and sender avatars survive restart and sparse refresh with stable IDs', t => {
  const { root, store } = setup(t);
  store.mergeMessages('mock-account', [{ id: 'g1', name: '同名群', selected: true, avatarUrl: avatarA }], [message('1', { senderAvatarUrl: avatarB })]);
  store.mergeMessages('mock-account', [{ id: 'g1', name: '群更名' }], [message('1', { text: '刷新正文' })]);
  const restored = new Store(root).get('mock-account');
  assert.equal(restored.groups[0].avatarUrl, avatarA);
  assert.equal(restored.groups[0].name, '群更名');
  assert.equal(restored.groups[0].selected, true);
  assert.equal(restored.messages[0].senderAvatarUrl, avatarB);
  assert.equal(restored.messages[0].text, '刷新正文');
  store.mergeMessages('mock-account', [{ id: 'g1', name: '群更名', avatarUrl: avatarB }], [message('1', { senderAvatarUrl: avatarA })]);
  assert.equal(store.get('mock-account').groups[0].avatarUrl, avatarB);
  assert.equal(store.get('mock-account').messages[0].senderAvatarUrl, avatarA);
});

test('same names and message IDs do not share avatars across groups, sender IDs or accounts', t => {
  const { store } = setup(t);
  store.ensureAccount({ id: 'other-account', name: '模拟账户', kind: 'import' });
  store.mergeMessages('mock-account', [{ id: 'g1', name: '同名群', avatarUrl: avatarA }, { id: 'g2', name: '同名群', avatarUrl: avatarB }], [
    message('1', { senderAvatarUrl: avatarA }),
    message('2', { senderId: 'member-2', senderAvatarUrl: avatarB }),
    message('1', { groupId: 'g2', senderId: 'member-3' }),
  ]);
  store.mergeMessages('other-account', [{ id: 'g1', name: '同名群' }], [message()]);
  const state = store.get('mock-account');
  assert.equal(state.groups.find(g => g.id === 'g1').avatarUrl, avatarA);
  assert.equal(state.groups.find(g => g.id === 'g2').avatarUrl, avatarB);
  assert.equal(state.messages.find(m => m.groupId === 'g1' && m.id === '1').senderAvatarUrl, avatarA);
  assert.equal(state.messages.find(m => m.groupId === 'g1' && m.id === '2').senderAvatarUrl, avatarB);
  assert.equal(state.messages.find(m => m.groupId === 'g2').senderAvatarUrl, undefined);
  assert.equal(store.get('other-account').groups[0].avatarUrl, undefined);
  assert.equal(store.get('other-account').messages[0].senderAvatarUrl, undefined);
});

test('a changed stable sender ID cannot inherit an earlier sender avatar', t => {
  const { store } = setup(t);
  store.mergeMessages('mock-account', [{ id: 'g1', name: '模拟群' }], [message('1', { senderAvatarUrl: avatarA })]);
  store.mergeMessages('mock-account', [], [message('1', { senderId: 'member-2' })]);
  assert.equal(store.get('mock-account').messages[0].senderAvatarUrl, undefined);
  store.mergeMessages('mock-account', [], [message('1', { senderId: 'member-3', senderAvatarUrl: avatarB })]);
  assert.equal(store.get('mock-account').messages[0].senderAvatarUrl, avatarB);
  store.mergeMessages('mock-account', [], [message('1', { senderId: 'unknown:1', senderAvatarUrl: avatarA })]);
  assert.equal(store.get('mock-account').messages[0].senderAvatarUrl, undefined);
});

test('unapproved avatar metadata is dropped without failing or overwriting safe message content', t => {
  const { store } = setup(t);
  store.mergeMessages('mock-account', [{ id: 'g1', name: '模拟群', avatarUrl: 'https://evil.example/group.jpg' }], [message('1', { senderAvatarUrl: 'data:image/svg+xml,script' })]);
  const state = store.get('mock-account');
  assert.equal(state.groups[0].avatarUrl, undefined);
  assert.equal(state.messages[0].senderAvatarUrl, undefined);
  assert.equal(state.messages[0].text, '仅模拟群聊正文');
});

test('summary preparation and citations never include avatar metadata as content or attachments', () => {
  const prepared = prepareSummary({
    messages: [message('1', { senderAvatarUrl: avatarA })],
    group: { id: 'g1', name: '模拟群', avatarUrl: avatarB }, start: 0, end: 2000,
  });
  const result = localSummary(prepared);
  assert.equal(JSON.stringify(prepared).includes('sinaimg.cn'), false);
  assert.equal(JSON.stringify(result).includes('sinaimg.cn'), false);
  assert.equal(result.refs[0].text, '仅模拟群聊正文');
});
