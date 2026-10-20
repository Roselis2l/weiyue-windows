'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const SCHEMA_VERSION = 1;
const MAX_MESSAGES = 500000;
const MAX_TIME = 8640000000000000;
const FILE_PATTERN = /^account-[a-f0-9]{64}\.json$/;
const SECRET_KEY = /^(?:api[_-]?key|key|token|access[_-]?token|refresh[_-]?token|notion[_-]?token|ai[_-]?key|cookie|cookies|password|secret|authorization)$/i;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const clone = value => JSON.parse(JSON.stringify(value));

function fail(message) { throw new Error(message); }
function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}必须是对象`);
  return value;
}
function identifier(value, label = 'ID') {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) fail(`${label}必须是字符串或非负安全整数；长数字 ID 请加双引号`);
    value = String(value);
  }
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\u0000-\u001f]/.test(value)) fail(`${label}无效`);
  return value.trim();
}
function stringValue(value, label, max = 100000, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || value.length > max) fail(`${label}必须是长度不超过 ${max} 的文本`);
  return value;
}
function timestamp(value, label = '时间') {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TIME) fail(`${label}必须是有效的毫秒时间戳`);
  return value;
}
function array(value, label, max = MAX_MESSAGES) {
  if (!Array.isArray(value) || value.length > max) fail(`${label}必须是数组，且不超过 ${max} 项`);
  return value;
}
function compareIds(a, b) {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const aa = BigInt(a), bb = BigInt(b);
    if (aa < bb) return -1;
    if (aa > bb) return 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}
function compareMessages(a, b) {
  return a.time - b.time || compareIds(a.id, b.id) || compareIds(a.groupId, b.groupId);
}
function messageKey(message) { return JSON.stringify([message.groupId, message.id]); }
function setProperty(object, key, value) {
  Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true });
}
function assertJson(value, label = '数据', depth = 0, secrets = false) {
  if (depth > 30) fail(`${label}层级过深`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { for (const item of value) assertJson(item, label, depth + 1, secrets); return; }
  if (value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    for (const [key, item] of Object.entries(value)) {
      if (secrets && SECRET_KEY.test(key) && item !== '' && item !== null) fail('凭据不能保存在普通设置中，请使用 Windows 保护存储');
      assertJson(item, label, depth + 1, secrets);
    }
    return;
  }
  fail(`${label}含有不能保存的值`);
}

function normalizeMessage(message) {
  record(message, '消息');
  const normalized = {
    id: identifier(message.id, '消息 ID'),
    groupId: identifier(message.groupId, '群 ID'),
    senderId: identifier(message.senderId, '成员 ID'),
    senderName: stringValue(message.senderName, '成员名称', 512, '未知成员'),
    text: stringValue(message.text, '消息正文', 1000000, ''),
    time: timestamp(message.time, '消息时间'),
  };
  if (message.mediaVersion !== undefined) {
    if (message.mediaVersion !== 1) fail('媒体数据版本不受支持');
    normalized.mediaVersion = 1;
  }
  if (message.images !== undefined) normalized.images = normalizeImages(message.images);
  if (message.sharedPost !== undefined) normalized.sharedPost = normalizeSharedPost(message.sharedPost);
  return normalized;
}
function normalizeImages(images) {
  const { normalizeImage } = require('./media.cjs');
  return mergeImages([], array(images, '图片列表', 100).map(image => {
    record(image, '图片');
    const safe = normalizeImage(image);
    if (!safe) fail('图片地址不受支持，仅允许已核实的微博图片来源');
    return { ...safe, originalUrl: safe.originalUrl || safe.url };
  }));
}
function normalizeSharedPost(post) {
  record(post, '分享微博');
  if (!['ready', 'unavailable'].includes(post.state)) fail('分享微博状态无效');
  const result = { text: stringValue(post.text, '分享微博正文', 1000000), images: normalizeImages(post.images), state: post.state };
  if (post.id !== undefined) result.id = identifier(post.id, '分享微博 ID');
  if (post.url !== undefined) {
    const safe = require('./media.cjs').safePostUrl(post.url);
    if (!safe) fail('分享微博链接无效');
    result.url = safe;
  }
  if (post.author !== undefined) result.author = stringValue(post.author, '分享微博作者', 512);
  if (post.reason !== undefined) result.reason = stringValue(post.reason, '分享微博提示', 10000);
  if (post.truncated !== undefined) {
    if (typeof post.truncated !== 'boolean') fail('分享微博截断标志必须是布尔值');
    result.truncated = post.truncated;
  }
  return result;
}
function mergeImages(previous = [], incoming = []) {
  const images = new Map(previous.map(image => [image.originalUrl || image.url, image]));
  for (const image of incoming) {
    const key = image.originalUrl || image.url;
    images.set(key, { ...images.get(key), ...image });
  }
  if (images.size > 100) fail('单条消息的图片数量超过本地保存上限');
  return [...images.values()];
}
function mergeSharedPost(previous, incoming) {
  if (!previous) return incoming;
  if (!incoming) return previous;
  const result = { ...previous, ...incoming, images: mergeImages(previous.images, incoming.images) };
  for (const key of ['id', 'url', 'author']) if (!incoming[key] && previous[key]) result[key] = previous[key];
  const retainText = previous.text && (!incoming.text.trim() || incoming.text.length < previous.text.length
    || (incoming.truncated && !previous.truncated) || incoming.state === 'unavailable');
  if (retainText) {
    result.text = previous.text;
    if (previous.truncated !== undefined) result.truncated = previous.truncated; else delete result.truncated;
    if (incoming.state === 'ready' && incoming.text !== previous.text) {
      result.state = 'unavailable';
      result.reason = '本次仅返回不完整的分享信息；下方保留已缓存内容，请核对原微博。';
    }
  }
  if (result.state === 'ready' && !incoming.reason) delete result.reason;
  return result;
}
function mergeRichMessage(previous, incoming) {
  if (!previous) return incoming;
  const result = { ...previous, ...incoming };
  if (!incoming.text.trim()) result.text = previous.text;
  if (!incoming.senderName.trim() || incoming.senderName === '未知成员') result.senderName = previous.senderName;
  if (previous.images !== undefined || incoming.images !== undefined) result.images = mergeImages(previous.images, incoming.images);
  if (previous.sharedPost !== undefined || incoming.sharedPost !== undefined) result.sharedPost = mergeSharedPost(previous.sharedPost, incoming.sharedPost);
  return result;
}
function searchableMessage(message) {
  return [message.text, message.senderName, message.sharedPost?.text || '', message.sharedPost?.author || ''].join('\n');
}
function normalizeGroup(group) {
  record(group, '群');
  const normalized = { id: identifier(group.id, '群 ID'), name: stringValue(group.name, '群名称', 512) };
  if (group.selected !== undefined) {
    if (typeof group.selected !== 'boolean') fail('群选择状态必须是布尔值');
    normalized.selected = group.selected;
  }
  if (group.nextCursor !== undefined) {
    if (group.nextCursor !== null && (typeof group.nextCursor !== 'string' || !/^\d+$/.test(group.nextCursor) || group.nextCursor.length > 256)) fail('历史消息游标必须是数字字符串或 null');
    normalized.nextCursor = group.nextCursor;
  }
  if (group.historyExhausted !== undefined) {
    if (typeof group.historyExhausted !== 'boolean') fail('历史同步完成状态必须是布尔值');
    normalized.historyExhausted = group.historyExhausted;
  }
  if (group.latestPending !== undefined) {
    if (group.latestPending === null) normalized.latestPending = null;
    else {
      const pending = record(group.latestPending, '最近消息续读状态');
      const decimal = (value, label) => {
        if (typeof value !== 'string' || value.length > 256 || !/^\d+$/.test(value)) fail(`${label}必须是十进制数字字符串`);
        return value;
      };
      const cursor = decimal(pending.cursor, '最近消息续读游标');
      if (BigInt(cursor) <= 0n) fail('最近消息续读游标必须大于零');
      normalized.latestPending = {
        cursor,
        baselineId: decimal(pending.baselineId, '最近消息续读边界'),
        arrivalAfterId: identifier(pending.arrivalAfterId, '最近消息到达起点'),
      };
    }
  }
  if (group.coverage !== undefined) {
    const coverage = record(group.coverage, '覆盖范围');
    const oldest = timestamp(coverage.oldest, '最早时间'), newest = timestamp(coverage.newest, '最新时间');
    if (oldest > newest) fail('覆盖范围的最早时间不能晚于最新时间');
    if (typeof coverage.complete !== 'boolean') fail('覆盖范围必须说明是否完整');
    normalized.coverage = { oldest, newest, complete: coverage.complete, note: stringValue(coverage.note, '覆盖提示', 10000, '') };
  }
  return normalized;
}
function normalizeAccount(account) {
  record(account, '账号');
  if (!['demo', 'import', 'weibo'].includes(account.kind)) fail('账号类型无效');
  return { id: identifier(account.id, '账号 ID'), name: stringValue(account.name, '账号名称', 512), kind: account.kind };
}
function normalizeTags(tags = []) {
  return [...new Set(array(tags, '标签', 50).map(tag => stringValue(tag, '标签', 80).trim()).filter(Boolean))];
}
function initialState(account) {
  return { schemaVersion: SCHEMA_VERSION, account, groups: [], messages: [], bookmarks: [], summaries: [], readPositions: {}, readStates: {}, importantMembers: [], settings: {}, exports: {} };
}
function pixelOffset(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1000000) fail('阅读锚点偏移必须是有效的像素值');
  return value;
}
function normalizeReadState(input, groupId, messages, legacyId = null) {
  if (input === undefined) input = {};
  record(input, '群阅读状态');
  const reference = (value, label) => {
    if (value === null) return null;
    const id = identifier(value, label);
    if (!messages.has(messageKey({ groupId, id }))) fail(`${label}引用的消息不存在`);
    return id;
  };
  const anchorId = reference(input.anchorId === undefined ? legacyId : input.anchorId, '阅读锚点');
  const readThroughId = reference(input.readThroughId === undefined ? legacyId : input.readThroughId, '已读位置');
  const anchorOffset = pixelOffset(input.anchorOffset === undefined ? 0 : input.anchorOffset);
  const atBottom = input.atBottom === undefined ? false : input.atBottom;
  if (typeof atBottom !== 'boolean') fail('尾部跟随状态必须是布尔值');
  const unreadIds = [...new Set(array(input.unreadIds === undefined ? [] : input.unreadIds, '未读消息').map(id => reference(id, '未读消息')))];
  if (unreadIds.includes(null)) fail('未读消息 ID 不能为 null');
  const through = readThroughId === null ? null : messages.get(messageKey({ groupId, id: readThroughId }));
  if (through && unreadIds.some(id => compareMessages(messages.get(messageKey({ groupId, id })), through) <= 0)) fail('未读消息不能位于已读高水位之前');
  return { anchorId, anchorOffset, atBottom, readThroughId, unreadIds, updatedAt: timestamp(input.updatedAt === undefined ? 0 : input.updatedAt, '阅读状态更新时间') };
}
function validateState(state, expectedId) {
  record(state, '本地数据');
  // An explicitly undefined optional pending cursor is the same as omission.
  // Normalize only this field before the general JSON-value validation.
  if (Array.isArray(state.groups)) state = { ...state, groups: state.groups.map(group => {
    if (group && typeof group === 'object' && !Array.isArray(group) && own(group, 'latestPending') && group.latestPending === undefined) {
      const copy = { ...group }; delete copy.latestPending; return copy;
    }
    return group;
  }) };
  assertJson(state);
  if (state.schemaVersion !== SCHEMA_VERSION) fail('本地数据版本不受支持，请保留原文件并升级应用');
  const account = normalizeAccount(state.account);
  if (account.id !== expectedId) fail('账号数据不匹配');
  const groups = array(state.groups, '群列表', 10000).map(normalizeGroup);
  const groupIds = new Set(groups.map(group => group.id));
  if (groupIds.size !== groups.length) fail('群列表含重复 ID');
  const messages = array(state.messages, '消息').map(normalizeMessage);
  const messageKeys = new Set();
  for (const message of messages) {
    if (!groupIds.has(message.groupId)) fail('消息所属群不存在');
    const key = messageKey(message);
    if (messageKeys.has(key)) fail('消息含重复 ID');
    messageKeys.add(key);
  }
  for (const group of groups) {
    if (group.latestPending && !messageKeys.has(messageKey({ groupId: group.id, id: group.latestPending.arrivalAfterId }))) fail('最近消息续读起点引用的同群消息不存在；请保留原文件后检查数据');
  }
  const bookmarks = array(state.bookmarks, '收藏', 100000).map(bookmark => {
    record(bookmark, '收藏'); identifier(bookmark.id, '收藏 ID');
    const groupId = identifier(bookmark.groupId, '收藏群 ID');
    if (!groupIds.has(groupId)) fail('收藏所属群不存在');
    if (!array(bookmark.messageIds, '收藏消息', 10000).length) fail('收藏必须包含消息');
    for (const id of bookmark.messageIds) if (!messageKeys.has(messageKey({ groupId, id: identifier(id) }))) fail('收藏引用的消息不存在');
    stringValue(bookmark.note, '备注', 100000); normalizeTags(bookmark.tags); timestamp(bookmark.createdAt, '收藏时间');
    return { ...bookmark, id: identifier(bookmark.id), groupId, messageIds: [...new Set(bookmark.messageIds.map(id => identifier(id)))], tags: normalizeTags(bookmark.tags) };
  });
  if (new Set(state.bookmarks.map(item => item.id)).size !== state.bookmarks.length) fail('收藏含重复 ID');
  array(state.summaries, '摘要', 100000);
  record(state.readPositions, '阅读位置');
  const readPositions = {};
  for (const [groupId, id] of Object.entries(state.readPositions)) {
    if (!messageKeys.has(messageKey({ groupId, id: identifier(id) }))) fail('阅读位置引用的消息不存在');
    setProperty(readPositions, groupId, identifier(id));
  }
  const readStates = {}, rawReadStates = state.readStates === undefined ? {} : record(state.readStates, '阅读状态');
  if (Object.keys(rawReadStates).some(id => !groupIds.has(id))) fail('阅读状态所属群不存在');
  const messageMap = new Map(messages.map(message => [messageKey(message), message]));
  for (const groupId of groupIds) {
    // Schema 1 files predate readStates: migrate in memory, without changing their bytes on read.
    const legacyId = own(readPositions, groupId) ? readPositions[groupId] : null;
    setProperty(readStates, groupId, normalizeReadState(own(rawReadStates, groupId) ? rawReadStates[groupId] : undefined, groupId, messageMap, legacyId));
  }
  const importantMembers = [...new Set(array(state.importantMembers, '重点成员', 100000).map(item => identifier(item, '重点成员 ID')))];
  record(state.settings, '设置'); assertJson(state.settings, '设置', 0, true);
  record(state.exports, '导出记录');
  // Normalize identifiers even when update() callers supply safe numeric IDs.
  return { ...state, account, groups, messages, bookmarks, readPositions, readStates, importantMembers };
}

function filterMessages(messages, query = {}, importantMembers = []) {
  record(query, '筛选条件');
  const groupId = query.groupId === undefined || query.groupId === '' ? null : identifier(query.groupId, '群 ID');
  const senderId = query.senderId === undefined || query.senderId === '' ? null : identifier(query.senderId, '成员 ID');
  const keyword = stringValue(query.keyword, '关键词', 10000, '').trim().toLocaleLowerCase();
  const start = query.start === undefined || query.start === null || query.start === '' ? 0 : timestamp(query.start, '开始时间');
  const end = query.end === undefined || query.end === null || query.end === '' ? MAX_TIME : timestamp(query.end, '结束时间');
  if (start > end) fail('开始时间不能晚于结束时间');
  const important = new Set(importantMembers);
  return messages.filter(message => (!groupId || message.groupId === groupId)
    && (!senderId || message.senderId === senderId)
    && message.time >= start && message.time < end
    && (!query.importantOnly || important.has(message.senderId))
    && (!keyword || searchableMessage(message).toLocaleLowerCase().includes(keyword)))
    .sort(compareMessages);
}

class Store {
  constructor(root) {
    if (typeof root !== 'string' || !root) fail('本地数据目录无效');
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }
  _file(id) {
    return path.join(this.root, `account-${createHash('sha256').update(identifier(id, '账号 ID')).digest('hex')}.json`);
  }
  _read(file, expectedId) {
    let state;
    try {
      if (fs.statSync(file).size > 512 * 1024 * 1024) fail('数据文件过大');
      state = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      fail('无法读取本地账号数据；请保留原文件后检查或恢复备份');
    }
    return validateState(state, expectedId || state.account?.id);
  }
  _write(id, state) {
    const normalized = validateState(state, id);
    const file = this._file(id), temporary = `${file}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(normalized), 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, file);
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch { /* original state remains intact */ }
      fail('保存本地数据失败；请检查磁盘空间和目录权限');
    }
    return clone(normalized);
  }
  accounts() {
    return fs.readdirSync(this.root).filter(name => FILE_PATTERN.test(name)).map(name => {
      const file = path.join(this.root, name), state = this._read(file);
      if (this._file(state.account.id) !== file) fail('账号文件名称与内容不匹配');
      return state.account;
    }).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  }
  account(id) { return this._read(this._file(id), identifier(id))?.account || null; }
  ensureAccount(account) {
    account = normalizeAccount(account);
    const existing = this._read(this._file(account.id), account.id);
    if (existing) {
      if (existing.account.kind !== account.kind) fail('同一账号 ID 不能使用不同账号类型');
      if (existing.account.name !== account.name) this.update(account.id, state => { state.account.name = account.name; });
    } else this._write(account.id, initialState(account));
    return clone(account);
  }
  get(id) {
    const state = this._read(this._file(id), identifier(id));
    if (!state) fail('账号不存在，请先创建或登录账号');
    return state;
  }
  update(id, mutator) {
    if (typeof mutator !== 'function') fail('更新操作无效');
    const state = this.get(id), result = mutator(state);
    if (result && typeof result.then === 'function') fail('本地数据更新必须是同步操作');
    return this._write(identifier(id), state);
  }
  mergeMessages(accountId, groups, messages, options = {}) {
    groups = array(groups, '群列表', 10000).map(normalizeGroup);
    messages = array(messages, '消息').map(normalizeMessage);
    record(options, '同步选项');
    if (options.history !== undefined && typeof options.history !== 'boolean') fail('历史同步标志必须是布尔值');
    const arrivalAfter = options.arrivalAfter === undefined ? {} : record(options.arrivalAfter, '本轮同步起点');
    for (const [groupId, id] of Object.entries(arrivalAfter)) {
      identifier(groupId, '同步群 ID');
      if (id !== null) identifier(id, '同步起点消息 ID');
    }
    let inserted = 0;
    this.update(accountId, state => {
      const groupMap = new Map(state.groups.map(group => [group.id, group]));
      for (const group of groups) groupMap.set(group.id, { selected: false, ...groupMap.get(group.id), ...group });
      const messageMap = new Map(state.messages.map(message => [messageKey(message), message]));
      const latestByGroup = new Map();
      for (const message of state.messages) {
        const current = latestByGroup.get(message.groupId);
        if (!current || compareMessages(message, current) > 0) latestByGroup.set(message.groupId, message);
      }
      const arrivalFloors = new Map();
      if (Object.keys(arrivalAfter).some(groupId => !groupMap.has(groupId))) fail('本轮同步起点所属群不存在');
      for (const groupId of groupMap.keys()) {
        if (!own(state.readStates, groupId)) setProperty(state.readStates, groupId, normalizeReadState(undefined, groupId, messageMap));
        let floor = latestByGroup.get(groupId) || null;
        if (own(arrivalAfter, groupId)) {
          floor = arrivalAfter[groupId] === null ? null : messageMap.get(messageKey({ groupId, id: identifier(arrivalAfter[groupId]) }));
          if (floor === undefined) fail('本轮同步起点消息不存在，请重新开始同步');
        }
        arrivalFloors.set(groupId, floor);
      }
      for (const message of messages) {
        if (!groupMap.has(message.groupId)) fail('导入消息所属群不存在，请在 groups 中提供群信息');
        const key = messageKey(message);
        if (!messageMap.has(key)) {
          inserted++;
          const readState = state.readStates[message.groupId], floor = arrivalFloors.get(message.groupId);
          const through = readState.readThroughId === null ? null : messageMap.get(messageKey({ groupId: message.groupId, id: readState.readThroughId }));
          // Only fresh arrivals above the original sync frontier become unread. Older
          // history, initial loads and repeated/enriched records never increment it.
          if (!options.history && floor && compareMessages(message, floor) > 0 && (!through || compareMessages(message, through) > 0)) readState.unreadIds.push(message.id);
        }
        messageMap.set(key, mergeRichMessage(messageMap.get(key), message));
      }
      state.groups = [...groupMap.values()]; state.messages = [...messageMap.values()].sort(compareMessages);
    });
    return inserted;
  }
  queryMessages(accountId, query = {}) {
    const state = this.get(accountId), found = filterMessages(state.messages, query, state.importantMembers);
    const limit = query.limit === undefined ? 200 : query.limit;
    const offset = query.offset === undefined ? 0 : query.offset;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2000) fail('每页条数必须是 1 到 2000 的整数');
    if (!Number.isSafeInteger(offset) || offset < 0) fail('分页位置必须是非负整数');
    return { messages: found.slice(offset, offset + limit), total: found.length };
  }
  bookmark(accountId, input) {
    record(input, '收藏');
    const groupId = identifier(input.groupId, '群 ID');
    const messageIds = [...new Set(array(input.messageIds, '收藏消息', 10000).map(id => identifier(id, '消息 ID')))];
    if (!messageIds.length) fail('请先选择至少一条消息');
    const note = stringValue(input.note, '备注', 100000, ''), tags = normalizeTags(input.tags);
    let saved;
    this.update(accountId, state => {
      const known = new Set(state.messages.filter(message => message.groupId === groupId).map(message => message.id));
      if (messageIds.some(id => !known.has(id))) fail('收藏包含当前群中不存在的消息');
      const signature = [...messageIds].sort(compareIds).join('\u0000');
      const existing = state.bookmarks.find(item => item.groupId === groupId && [...item.messageIds].sort(compareIds).join('\u0000') === signature);
      if (existing) { existing.note = note; existing.tags = tags; saved = existing; }
      else { saved = { id: randomUUID(), groupId, messageIds, note, tags, createdAt: Date.now() }; state.bookmarks.push(saved); }
    });
    return clone(saved);
  }
  bookmarks(accountId, query = {}) {
    if (typeof query === 'string') query = { keyword: query };
    record(query, '收藏筛选');
    const keyword = stringValue(query.keyword, '关键词', 10000, '').trim().toLocaleLowerCase();
    const tag = stringValue(query.tag, '标签', 80, '').trim().toLocaleLowerCase();
    const groupId = query.groupId ? identifier(query.groupId, '群 ID') : null;
    const state = this.get(accountId), messages = new Map(state.messages.map(message => [messageKey(message), message]));
    return state.bookmarks.map(bookmark => ({ ...bookmark, messages: bookmark.messageIds.map(id => messages.get(messageKey({ groupId: bookmark.groupId, id }))).sort(compareMessages) }))
      .filter(bookmark => (!groupId || bookmark.groupId === groupId)
        && (!tag || bookmark.tags.some(item => item.toLocaleLowerCase() === tag))
        && (!keyword || [bookmark.note, ...bookmark.tags, ...bookmark.messages.map(searchableMessage)].join('\n').toLocaleLowerCase().includes(keyword)))
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  }
  removeBookmark(accountId, id) {
    id = identifier(id, '收藏 ID'); let removed = false;
    this.update(accountId, state => { const before = state.bookmarks.length; state.bookmarks = state.bookmarks.filter(item => item.id !== id); removed = before !== state.bookmarks.length; });
    return removed;
  }
  setReadPosition(accountId, groupId, messageId, options) {
    const legacyCall = arguments.length < 4;
    options = options === undefined ? {} : record(options, '阅读选项');
    groupId = identifier(groupId, '群 ID'); messageId = identifier(messageId, '消息 ID');
    if (options.offset !== undefined) pixelOffset(options.offset);
    if (options.followTail !== undefined && typeof options.followTail !== 'boolean') fail('尾部跟随状态必须是布尔值');
    const seenId = legacyCall ? messageId : options.seenId === undefined || options.seenId === null ? null : identifier(options.seenId, '可见末行 ID');
    this.update(accountId, state => {
      const messages = new Map(state.messages.filter(message => message.groupId === groupId).map(message => [message.id, message]));
      if (!messages.has(messageId)) fail('阅读位置对应的消息不存在');
      if (seenId !== null && !messages.has(seenId)) fail('可见末行引用的消息不存在');
      const current = state.readStates[groupId];
      const previousAnchor = current.anchorId;
      current.anchorId = messageId;
      current.anchorOffset = options.offset === undefined ? previousAnchor === messageId ? current.anchorOffset : 0 : options.offset;
      if (options.followTail !== undefined) current.atBottom = options.followTail;
      if (seenId !== null && (current.readThroughId === null || compareMessages(messages.get(seenId), messages.get(current.readThroughId)) > 0)) current.readThroughId = seenId;
      if (current.readThroughId !== null) current.unreadIds = current.unreadIds.filter(id => compareMessages(messages.get(id), messages.get(current.readThroughId)) > 0);
      current.updatedAt = Date.now();
      setProperty(state.readPositions, groupId, messageId);
    });
    return messageId;
  }
  getReadStats(accountId, groupId) {
    const state = this.get(accountId), byGroup = new Map(state.groups.map(group => [group.id, []]));
    for (const message of state.messages) byGroup.get(message.groupId).push(message);
    const stats = {};
    for (const [id, messages] of byGroup) {
      messages.sort(compareMessages);
      const current = state.readStates[id], unread = new Set(current.unreadIds);
      setProperty(stats, id, { ...current, unreadCount: unread.size, firstUnreadId: messages.find(message => unread.has(message.id))?.id || null, latestMessageId: messages.at(-1)?.id || null, messageCount: messages.length });
    }
    if (groupId === undefined) return stats;
    groupId = identifier(groupId, '群 ID');
    if (!own(stats, groupId)) fail('阅读状态所属群不存在');
    return stats[groupId];
  }
  setImportant(accountId, senderId, enabled) {
    senderId = identifier(senderId, '成员 ID');
    if (typeof enabled !== 'boolean') fail('重点成员状态必须是布尔值');
    const state = this.update(accountId, state => {
      const members = new Set(state.importantMembers);
      if (enabled) members.add(senderId); else members.delete(senderId);
      state.importantMembers = [...members];
    });
    return state.importantMembers;
  }
  importData(accountId, data) {
    record(data, '导入数据');
    return this.mergeMessages(accountId, data.groups, data.messages);
  }
  seedDemo() {
    const account = { id: 'demo', name: '本地演示 · 星河', kind: 'demo' };
    if (this.account(account.id)) return account;
    this.ensureAccount(account);
    const { groups, messages } = createDemoData();
    this.mergeMessages(account.id, groups, messages);
    this.setImportant(account.id, 'member-lin', true);
    this.bookmark(account.id, { groupId: groups[0].id, messageIds: messages.filter(message => message.groupId === groups[0].id).slice(3, 6).map(message => message.id), note: '下一次整理时复用这些方法，记得回看上下文。', tags: ['阅读方法', '待实践'] });
    return account;
  }
}

function createDemoData(now = Date.now()) {
  const base = now - 1000;
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const todaySpan = Math.max(0, Math.min(6 * 3600000, now - today.getTime() - 2000));
  const definitions = [
    { id: 'demo-reading', name: '慢读俱乐部', members: [['member-lin', '林间'], ['member-lu', '鹿鸣'], ['member-yu', '余白'], ['member-xia', '夏禾']], lines: [
      '早上好！今天聊聊：怎样从热闹的群聊中留下真正有用的东西？',
      '我以前把整段对话截图，后来发现几乎不会再翻。现在更想留下结论和出处。',
      '收藏最好能补一句“为什么保存”。未来的自己未必还记得当时的背景。',
      '我的阅读流程：先按时段浏览，再看重点成员，最后把需要行动的内容存成一组。',
      '多条消息一起保存很重要。一个提问和后面的纠正，分开后可能完全变了意思。',
      '给收藏加少量标签：想法、资料、待实践。标签太多反而增加整理负担。',
      '今天的共读是《瓦尔登湖》。我们各选一段讨论，不追求把所有内容都读完。',
      '“少一点，但是更好”也适用于信息阅读。不是每条未读消息都需要处理。',
      '提议：每晚留出二十分钟回顾当天的讨论，挑出一个能实践的小动作。',
      '资料可以先收藏，在备注里写下一次使用的场景，例如：周五的分享会。',
      '我尝试了按日期筛选，找昨天上午的讨论比一直滚动方便很多。',
      '提醒：摘要只是阅读入口。如果要转述别人的观点，请先回到原文核对。',
      '重点成员并不是“只听一个人”，而是让自己关注的问题更容易被看到。',
      '有些链接已经失效了。正文和备注仍然保留在本地，这点让我安心。',
      '总结一下：保留上下文、写明用途、定期回顾。今天先实践这三件小事。',
      '明天继续聊读书笔记如何连接到实际行动。大家晚安！',
    ] },
    { id: 'demo-product', name: '产品与手艺', members: [['member-an', '安可'], ['member-lin', '林间'], ['member-zhou', '周宁']], lines: [
      '这一周的目标：把复杂的需求拆成可以验证的小步骤。',
      '先确认用户真正要完成的动作，再决定按钮放在哪里。',
      '今天观察到一个问题：用户完成收藏后，不知道以后在哪里找到。',
      '可以在收藏成功后给出轻量提示，并保留一个稳定的收藏入口。',
      '搜索需要同时覆盖原文、备注和标签。用户不一定记得原句。',
      '关于摘要功能，建议默认选择最近一天，提交前再展示确切起止时间。',
      '时间范围用开始包含、结束不包含，连续两段整理时就不会重复计数。',
      '长期聊天记录可能只同步了一部分。摘要应明确提示数据缺口。',
      '发送到外部 AI 服务前，应显示服务地址和将发送的消息数量。',
      '安全设计不必让界面复杂：清晰的说明和一次明确确认就很好。',
      '本周行动：完善空状态；检查小窗口布局；验证断网时仍可阅读和收藏。',
      '我把复盘要点整理好了，下周再看实际反馈。',
    ] },
    { id: 'demo-city', name: '城市散步观察', members: [['member-xia', '夏禾'], ['member-lu', '鹿鸣'], ['member-qing', '青岚']], lines: [
      '周末想沿河散步，有没有适合慢慢走的路线？',
      '可以从旧桥出发，经过图书馆，再到植物园门口折返。',
      '那段路下午的光很好。我上次在桥边看见一只白鹭。',
      '建议带水、穿舒服的鞋。如果下雨，就改去图书馆读书。',
      '途中有一小段台阶，推车的朋友可以绕行旁边的坡道。',
      '时间暂定周六上午九点。这只是演示讨论，不是真实活动安排。',
      '我想记录路上的声音：风吹树叶、自行车铃，还有远处的船。',
      '不用急着拍照片，先站一会儿，再决定想留下什么。',
      '散步后的观察也可以写成三句话：看见了什么、想到了什么、想再问什么。',
    ] },
  ];
  const messages = [];
  for (let gi = 0; gi < definitions.length; gi++) {
    const definition = definitions[gi];
    for (let repeat = 0; repeat < 16; repeat++) {
      definition.lines.forEach((text, index) => {
        const member = definition.members[(index + repeat) % definition.members.length];
        const time = repeat === 15
          ? base - Math.floor((definition.lines.length - 1 - index) * todaySpan / (definition.lines.length - 1)) - gi * 10
          : base - (15 - repeat) * 12 * 3600000 - (definition.lines.length - 1 - index) * 34 * 60000 - gi * 1000;
        messages.push({ id: (9007199254740993000n + BigInt(gi * 10000 + repeat * 100 + index)).toString(), groupId: definition.id, senderId: member[0], senderName: member[1], text: `【虚构演示 · ${repeat === 15 ? '今日讨论' : `第 ${repeat + 1} 轮回顾`}】${text}`, time });
      });
    }
  }
  const groups = definitions.map(definition => {
    const times = messages.filter(message => message.groupId === definition.id).map(message => message.time);
    return { id: definition.id, name: definition.name, selected: true, coverage: { oldest: Math.min(...times), newest: Math.max(...times), complete: false, note: '此处为虚构演示数据，仅覆盖近八天的片段，不代表真实群聊的完整历史。' } };
  });
  return { groups, messages: messages.sort(compareMessages) };
}

module.exports = { Store, normalizeMessage, filterMessages, compareIds, compareMessages, createDemoData };
