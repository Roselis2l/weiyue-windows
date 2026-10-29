'use strict';

// Local recycling deliberately preserves the original records and synchronization
// frontier. Only an explicit restore makes a recycled record visible again.
const { createHash, randomUUID } = require('node:crypto');
const { parseChinaMinuteRange } = require('../renderer/filter-controls.js');

const MAX_TIME = 8640000000000000;
const MAX_BATCHES = 100000;
const MAX_RECORDS = 500000;
const keyOf = message => JSON.stringify([message.groupId, message.id]);
const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value);
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && value === value.trim() && !/[\u0000-\u001f]/.test(value);
const validTime = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIME;
const visibleMessages = messages => messages.filter(message => !message.localDeletion);
const REASONS = Object.freeze({
  bookmark: '收藏原文', summaryReference: '摘要引用原文', exportReference: '导出关联原文',
  readPosition: '阅读位置', unread: '未读消息', syncAnchor: '同步续扫起点',
  retainedMember: '指定保留成员', summaryRange: '摘要或 AI 总结时段',
  uncertainSummary: '摘要来源不完整，保守保留', uncertainExport: '导出来源无法追溯，保守保留',
});

function rangeIndex(ranges) {
  const index = new Map();
  for (const range of ranges) {
    if (!index.has(range.groupId)) index.set(range.groupId, []);
    index.get(range.groupId).push([range.start, range.end]);
  }
  for (const [groupId, values] of index) {
    values.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const value of values) {
      const last = merged.at(-1);
      if (last && value[0] <= last[1]) last[1] = Math.max(last[1], value[1]);
      else merged.push([...value]);
    }
    index.set(groupId, merged);
  }
  return index;
}
function rangeContains(index, message) {
  const ranges = index.get(message.groupId) || [];
  let low = 0, high = ranges.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2), range = ranges[middle];
    if (message.time < range[0]) high = middle - 1;
    else if (message.time >= range[1]) low = middle + 1;
    else return true;
  }
  return false;
}

function normalizeSelection(input) {
  if (!isRecord(input) || !validId(input.groupId)) throw new Error('请选择有效的群聊。');
  if (typeof input.startMinute !== 'string' || !input.startMinute || typeof input.endMinute !== 'string' || !input.endMinute)
    throw new Error('请选择开始和结束的北京时间，精确到分钟。');
  const { start, end } = parseChinaMinuteRange(input.startMinute, input.endMinute);
  if (!validTime(start) || !validTime(end) || start >= end) throw new Error('清理时段无效，请检查北京时间范围。');
  if (input.retainSenderIds !== undefined && (!Array.isArray(input.retainSenderIds) || input.retainSenderIds.length > 100000 || Array.from(input.retainSenderIds).some(id => !validId(id))))
    throw new Error('保留成员必须使用有效的成员 ID。');
  if (input.retainSummaryRanges !== undefined && typeof input.retainSummaryRanges !== 'boolean') throw new Error('保留摘要时段选项无效。');
  const mode = input.mode === undefined ? 'recycle' : input.mode;
  if (mode !== 'recycle' && mode !== 'permanent') throw new Error('清理方式无效，请选择本地回收或永久删除。');
  return { groupId: input.groupId, startMinute: input.startMinute, endMinute: input.endMinute,
    retainSenderIds: [...new Set(input.retainSenderIds || [])].sort(), retainSummaryRanges: input.retainSummaryRanges !== false, mode };
}

function validateMessageTombstones(raw, messages, groups) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_RECORDS || raw.length + messages.length > MAX_RECORDS)
    throw new Error('永久删除标记超过本地保存上限，请保留原文件后检查。');
  const groupIds = new Set(groups.map(group => group.id)), keys = new Set(messages.map(keyOf));
  return Array.from(raw, marker => {
    if (!isRecord(marker) || Object.keys(marker).length !== 3 || !Object.hasOwn(marker, 'groupId') || !Object.hasOwn(marker, 'id') || !Object.hasOwn(marker, 'time')
      || !validId(marker.groupId) || !groupIds.has(marker.groupId) || !validId(marker.id) || !validTime(marker.time))
      throw new Error('永久删除标记无效；仅允许保存群 ID、消息 ID 和原始时间。');
    const key = keyOf(marker);
    if (keys.has(key)) throw new Error('永久删除标记重复或与现存消息冲突，请保留原文件后检查。');
    keys.add(key);
    return { groupId: marker.groupId, id: marker.id, time: marker.time };
  });
}

function progress(callback, phase, processed, total) {
  if (typeof callback === 'function') callback({ phase, processed, total });
}

function normalizePurgeSelection(input) {
  if (!isRecord(input) || !validId(input.groupId)) throw new Error('请选择有效的回收区群聊。');
  if (!Array.isArray(input.batchIds) || !input.batchIds.length || input.batchIds.length > MAX_BATCHES
    || Array.from(input.batchIds).some(id => !validId(id))) throw new Error('请至少选择一个有效回收批次。');
  const batchIds = [...new Set(input.batchIds)].sort();
  if (batchIds.length !== input.batchIds.length) throw new Error('不能重复选择回收批次。');
  return { groupId: input.groupId, batchIds };
}

function normalizeLocalDeletion(value) {
  if (!isRecord(value) || !validId(value.batchId) || !validTime(value.deletedAt)) throw new Error('本地回收标记无效，请保留账号文件后检查。');
  return { batchId: value.batchId, deletedAt: value.deletedAt };
}

function validateMessageTrash(raw, messages, groups) {
  if (raw === undefined) {
    if (messages.some(message => message.localDeletion)) throw new Error('本地回收标记缺少对应批次，请保留数据后检查。');
    return [];
  }
  if (!Array.isArray(raw) || raw.length > MAX_BATCHES) throw new Error('本地回收批次无效。');
  const groupIds = new Set(groups.map(group => group.id));
  const messageMap = new Map(messages.map(message => [keyOf(message), message]));
  const batches = new Map();
  const result = raw.map(item => {
    if (!isRecord(item) || !validId(item.id) || batches.has(item.id) || !groupIds.has(item.groupId) || !validTime(item.createdAt)) throw new Error('本地回收批次信息无效。');
    if (item.restoredAt !== null && !validTime(item.restoredAt)) throw new Error('本地回收恢复时间无效。');
    if (!Array.isArray(item.messageIds) || !item.messageIds.length || item.messageIds.length > 500000 || item.messageIds.some(id => !validId(id))) throw new Error('本地回收消息列表无效。');
    const messageIds = [...new Set(item.messageIds)];
    if (messageIds.length !== item.messageIds.length || messageIds.some(id => !messageMap.has(keyOf({ groupId: item.groupId, id })))) throw new Error('本地回收消息关联无效。');
    const selection = normalizeSelection(item.selection);
    if (selection.groupId !== item.groupId) throw new Error('本地回收群聊不匹配。');
    if (selection.mode !== 'recycle') throw new Error('本地回收批次不能使用永久删除方式。');
    // Reading an older batch must not introduce a persisted field on the next
    // unrelated read-position/settings save. New batches explicitly store mode.
    if (!Object.hasOwn(item.selection, 'mode')) delete selection.mode;
    const normalized = { id: item.id, groupId: item.groupId, createdAt: item.createdAt, restoredAt: item.restoredAt, selection, messageIds };
    batches.set(item.id, { ...normalized, messageIdSet: new Set(messageIds) });
    return normalized;
  });
  for (const message of messages) if (message.localDeletion) {
    const batch = batches.get(message.localDeletion.batchId);
    if (!batch || batch.groupId !== message.groupId || batch.restoredAt !== null || !batch.messageIdSet.has(message.id) || batch.createdAt !== message.localDeletion.deletedAt)
      throw new Error('本地回收标记与批次不一致，请保留数据后检查。');
  }
  for (const batch of batches.values()) if (batch.restoredAt === null) {
    for (const id of batch.messageIds) if (messageMap.get(keyOf({ groupId: batch.groupId, id })).localDeletion?.batchId !== batch.id)
      throw new Error('本地回收批次存在未标记消息，请保留数据后检查。');
  }
  return result;
}

function protection(state, selection) {
  const groupIds = new Set(state.groups.map(group => group.id));
  const reasons = new Map(), warnings = [], summaryRanges = [];
  const conservativeGroups = new Set();
  let protectAllExport = false;
  const add = (groupId, id, reason) => {
    if (!validId(groupId) || !validId(id)) return;
    const key = keyOf({ groupId, id });
    if (!reasons.has(key)) reasons.set(key, new Set());
    reasons.get(key).add(reason);
  };
  const bookmarks = new Map((state.bookmarks || []).map(bookmark => [bookmark.id, bookmark]));
  const summaries = new Map((state.summaries || []).filter(isRecord).map(summary => [summary.id, summary]));
  for (const bookmark of bookmarks.values()) for (const id of bookmark.messageIds || []) add(bookmark.groupId, id, 'bookmark');
  for (const summary of state.summaries || []) {
    const knownGroups = new Set();
    const summaryGroup = isRecord(summary) && groupIds.has(summary.groupId) ? summary.groupId : null;
    if (summaryGroup) knownGroups.add(summaryGroup);
    const hasRange = summaryGroup && validTime(summary.start) && validTime(summary.end) && summary.start < summary.end;
    let consistentRange = !!hasRange;
    let completeReferences = isRecord(summary) && Array.isArray(summary.refs);
    for (const ref of (completeReferences ? summary.refs : [])) {
      if (!isRecord(ref) || !validId(ref.id) || !groupIds.has(ref.groupId)) { completeReferences = false; continue; }
      knownGroups.add(ref.groupId);
      add(ref.groupId, ref.id, 'summaryReference');
      if (!hasRange || ref.groupId !== summaryGroup || !validTime(ref.time) || ref.time < summary.start || ref.time >= summary.end) consistentRange = false;
    }
    if (selection.retainSummaryRanges && consistentRange && completeReferences) summaryRanges.push({ groupId: summaryGroup, start: summary.start, end: summary.end, summaryId: validId(summary.id) ? summary.id : null });
    // Missing citations cannot safely be reconstructed from prose or a title.
    // Missing explicit ranges cannot be inferred from min/max citation times.
    if (!completeReferences || (selection.retainSummaryRanges && !consistentRange)) {
      if (!knownGroups.size) for (const groupId of groupIds) conservativeGroups.add(groupId);
      else for (const groupId of knownGroups) conservativeGroups.add(groupId);
    }
  }
  if (conservativeGroups.has(selection.groupId)) warnings.push('部分摘要缺少可核对的来源或起止时段，或引用与时段信息不一致；无法从标题、正文或引用首尾推断完整范围，本群消息将保守保留。');

  // Notion journals do not retain message IDs/ranges independently of their
  // source records. A deleted source therefore cannot be guessed or narrowed.
  for (const entry of Object.values(state.exports || {})) {
    if (!isRecord(entry)) { protectAllExport = true; continue; }
    const type = entry.sourceType === 'bookmarks' ? 'bookmarks' : entry.sourceType === 'summary' || entry.sourceType === undefined ? 'summary' : null;
    const ids = Array.isArray(entry.sourceIds) && entry.sourceIds.length ? entry.sourceIds : type === 'summary' && validId(entry.summaryId) ? [entry.summaryId] : [];
    if (!type || !ids.length || ids.some(id => !validId(id))) { protectAllExport = true; continue; }
    for (const id of ids) {
      const source = (type === 'bookmarks' ? bookmarks : summaries).get(id);
      if (!source) { protectAllExport = true; continue; }
      if (type === 'bookmarks') for (const mid of source.messageIds || []) add(source.groupId, mid, 'exportReference');
      else if (Array.isArray(source.refs)) for (const ref of source.refs) {
        if (isRecord(ref) && validId(ref.id) && groupIds.has(ref.groupId)) add(ref.groupId, ref.id, 'exportReference');
        else protectAllExport = true;
      } else protectAllExport = true;
    }
  }
  if (protectAllExport) warnings.push('存在已导出但本地来源已删除或无法追溯的记录；导出日志没有独立保存原文 ID 或时段，因此本账号消息将保守保留。');
  for (const [groupId, stateRead] of Object.entries(state.readStates || {})) {
    add(groupId, stateRead.anchorId, 'readPosition'); add(groupId, stateRead.readThroughId, 'readPosition');
    for (const id of stateRead.unreadIds || []) add(groupId, id, 'unread');
  }
  for (const [groupId, id] of Object.entries(state.readPositions || {})) add(groupId, id, 'readPosition');
  for (const group of state.groups) for (const pending of group.latestPendingRanges || (group.latestPending ? [group.latestPending] : [])) add(group.id, pending.arrivalAfterId, 'syncAnchor');
  const retainedMembers = new Set(selection.retainSenderIds);
  const ranges = rangeIndex(summaryRanges);
  for (const message of state.messages) {
    if (retainedMembers.has(message.senderId)) add(message.groupId, message.id, 'retainedMember');
    if (conservativeGroups.has(message.groupId)) add(message.groupId, message.id, 'uncertainSummary');
    if (protectAllExport) add(message.groupId, message.id, 'uncertainExport');
    if (rangeContains(ranges, message)) add(message.groupId, message.id, 'summaryRange');
  }
  return { reasons, warnings, summaryRanges };
}

function previewMessageCleanup(state, input, { onProgress } = {}) {
  progress(onProgress, 'planning', 0, state.messages.length);
  const selection = normalizeSelection(input);
  const group = state.groups.find(group => group.id === selection.groupId);
  if (!group) throw new Error('所选群聊不存在，请刷新后重新选择。');
  const { start, end } = parseChinaMinuteRange(selection.startMinute, selection.endMinute);
  const { reasons, warnings, summaryRanges } = protection(state, selection);
  const matched = state.messages.filter(message => message.groupId === selection.groupId && message.time >= start && message.time < end)
    .sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  const existing = matched.filter(message => message.localDeletion), active = visibleMessages(matched);
  const candidates = active.filter(message => !reasons.get(keyOf(message))?.size);
  const retained = active.filter(message => reasons.get(keyOf(message))?.size);
  const reasonCounts = {};
  for (const message of retained) for (const reason of reasons.get(keyOf(message))) reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
  const rows = active.slice(0, 100).map(message => ({ id: message.id, groupId: message.groupId, time: message.time, senderId: message.senderId,
    senderName: message.senderName, text: require('./edition-policy.cjs').projectMessage(message).text.slice(0, 240), action: reasons.get(keyOf(message))?.size ? 'retain' : selection.mode,
    reasons: [...(reasons.get(keyOf(message)) || [])] }));
  const fingerprint = createHash('sha256').update(JSON.stringify({ accountId: state.account.id, groupName: group.name, selection, matched,
    decisions: active.map(message => [message.id, [...(reasons.get(keyOf(message)) || [])]]), warnings,
    summaryRanges: summaryRanges.filter(range => range.groupId === selection.groupId) })).digest('hex');
  progress(onProgress, 'planning', state.messages.length, state.messages.length);
  return { accountId: state.account.id, groupId: selection.groupId, groupName: group.name, mode: selection.mode, selection, range: { start, end }, fingerprint,
    matchedCount: active.length, deleteCount: candidates.length, retainedCount: retained.length, alreadyDeletedCount: existing.length,
    reasonCounts, reasonLabels: REASONS, warnings, summaryRanges: summaryRanges.filter(range => range.groupId === selection.groupId),
    sample: rows, sampleTruncated: active.length > rows.length,
    retentionNote: '收藏、摘要引用、导出关联、未读消息、阅读位置和同步续扫起点始终保留。保留原因可能重叠。',
    recycleNote: selection.mode === 'permanent'
      ? '永久删除会从当前账号数据中移除所选消息正文、成员和媒体记录，不能从本地回收区恢复；仅保留群 ID、消息 ID 和原始时间，防止同步或导入立即补回。不删除微博服务端消息，也不会清理既有备份或媒体缓存。'
      : '仅移入本账号的本地回收区，可按批次恢复；不会删除微博服务端消息或立即释放磁盘空间。同步和导入不会自动恢复已回收消息。',
  };
}

function applyMessageCleanup(state, input, expectedFingerprint, { now = Date.now, uuid = randomUUID, onProgress } = {}) {
  if (typeof expectedFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(expectedFingerprint)) throw new Error('请先预览本地清理结果，再明确确认。');
  const preview = previewMessageCleanup(state, input, { onProgress });
  if (preview.fingerprint !== expectedFingerprint) throw new Error('消息或保留条件已变化，请重新预览后确认；尚未清理任何消息。');
  if (!preview.deleteCount) return { deleted: false, deletedCount: 0, batchId: null, groupId: preview.groupId, mode: preview.mode, preview };
  if (preview.mode === 'recycle' && (state.messageTrash || []).length >= MAX_BATCHES) throw new Error('本地回收批次数已达上限，请保留数据并联系维护者。');
  const { reasons } = protection(state, preview.selection), createdAt = now();
  if (!validTime(createdAt)) throw new Error('无法建立有效的本地清理时间。');
  const messages = state.messages.filter(message => !message.localDeletion && message.groupId === preview.groupId && message.time >= preview.range.start && message.time < preview.range.end && !reasons.get(keyOf(message))?.size);
  if (preview.mode === 'permanent') {
    removePermanently(state, messages, onProgress);
    return { deleted: true, deletedCount: messages.length, batchId: null, mode: 'permanent', groupId: preview.groupId, createdAt };
  }
  const batchId = uuid();
  if (!validId(batchId) || (state.messageTrash || []).some(batch => batch.id === batchId)) throw new Error('无法建立有效的本地回收批次。');
  progress(onProgress, 'processing', 0, messages.length);
  let processed = 0;
  for (const message of messages) {
    message.localDeletion = { batchId, deletedAt: createdAt };
    if (++processed % 2048 === 0 || processed === messages.length) progress(onProgress, 'processing', processed, messages.length);
  }
  const batch = { id: batchId, groupId: preview.groupId, createdAt, restoredAt: null, selection: preview.selection, messageIds: messages.map(message => message.id) };
  state.messageTrash = [...(state.messageTrash || []), batch];
  state.schemaVersion = Math.max(2, state.schemaVersion || 1);
  return { deleted: true, deletedCount: messages.length, batchId, mode: 'recycle', groupId: preview.groupId, createdAt };
}

// Keep only identities needed to suppress re-import and maintain synchronization
// frontiers. No original text, sender, attachment or URL survives in this marker.
function removePermanently(state, messages, onProgress) {
  const removed = new Set(messages.map(keyOf)), markers = [...(state.messageTombstones || [])];
  progress(onProgress, 'processing', 0, messages.length);
  let processed = 0;
  for (const message of messages) {
    markers.push({ groupId: message.groupId, id: message.id, time: message.time });
    if (++processed % 2048 === 0 || processed === messages.length) progress(onProgress, 'processing', processed, messages.length);
  }
  const remaining = state.messages.filter(message => !removed.has(keyOf(message)));
  const normalizedMarkers = validateMessageTombstones(markers, remaining, state.groups);
  // A restored message can also occur in older restored batches. Trim every
  // historical association, so no batch references a permanently removed row.
  const trash = (state.messageTrash || []).map(batch => ({ ...batch,
    messageIds: batch.messageIds.filter(id => !removed.has(keyOf({ groupId: batch.groupId, id })))
  })).filter(batch => batch.messageIds.length);
  state.messages = remaining;
  state.messageTombstones = normalizedMarkers;
  state.messageTrash = trash;
  state.schemaVersion = Math.max(3, state.schemaVersion || 1);
}

function previewMessagePurge(state, input, { onProgress } = {}) {
  const selection = normalizePurgeSelection(input);
  const group = state.groups.find(group => group.id === selection.groupId);
  if (!group) throw new Error('所选群聊不存在，请刷新后重新选择。');
  const batchMap = new Map((state.messageTrash || []).map(batch => [batch.id, batch]));
  const batches = selection.batchIds.map(id => {
    const batch = batchMap.get(id);
    if (!batch || batch.groupId !== selection.groupId || batch.restoredAt !== null)
      throw new Error('所选回收批次已恢复、不存在或不属于当前群聊，请刷新后重新选择。');
    return batch;
  });
  const messagesByKey = new Map(state.messages.map(message => [keyOf(message), message]));
  const matched = [], reasons = new Map(), warnings = new Set(), summaryRanges = [], protectionCache = new Map();
  const total = batches.reduce((sum, batch) => sum + batch.messageIds.length, 0);
  progress(onProgress, 'planning', 0, total);
  let processed = 0;
  for (const batch of batches) {
    const batchSelection = normalizeSelection(batch.selection);
    const cacheKey = String(batchSelection.retainSummaryRanges);
    if (!protectionCache.has(cacheKey)) {
      const plan = protection(state, { ...batchSelection, retainSenderIds: [] });
      protectionCache.set(cacheKey, plan);
      plan.warnings.forEach(warning => warnings.add(warning));
      summaryRanges.push(...plan.summaryRanges.filter(range => range.groupId === selection.groupId));
    }
    const protectedPlan = protectionCache.get(cacheKey), retainedMembers = new Set(batchSelection.retainSenderIds);
    for (const id of batch.messageIds) {
      const key = keyOf({ groupId: selection.groupId, id }), message = messagesByKey.get(key);
      if (!message || message.localDeletion?.batchId !== batch.id || reasons.has(key))
        throw new Error('所选回收批次记录不完整或重复，请保留数据后检查。');
      matched.push(message);
      const messageReasons = new Set(protectedPlan.reasons.get(key) || []);
      if (retainedMembers.has(message.senderId)) messageReasons.add('retainedMember');
      reasons.set(key, messageReasons);
      if (++processed % 2048 === 0 || processed === total) progress(onProgress, 'planning', processed, total);
    }
  }
  matched.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  const retained = matched.filter(message => reasons.get(keyOf(message)).size), candidates = matched.length - retained.length;
  const reasonCounts = {};
  for (const message of retained) for (const reason of reasons.get(keyOf(message))) reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
  const warningList = [...warnings];
  const fingerprint = createHash('sha256').update(JSON.stringify({ accountId: state.account.id, groupName: group.name,
    selection, batches, matched, decisions: matched.map(message => [message.id, [...reasons.get(keyOf(message))]]), warnings: warningList, summaryRanges })).digest('hex');
  const ranges = batches.map(batch => parseChinaMinuteRange(batch.selection.startMinute, batch.selection.endMinute));
  let start = ranges[0].start, end = ranges[0].end;
  for (const range of ranges) { start = Math.min(start, range.start); end = Math.max(end, range.end); }
  return { accountId: state.account.id, groupId: selection.groupId, groupName: group.name, mode: 'purge', selection,
    batchIds: selection.batchIds, batchCount: batches.length,
    batches: batches.map(batch => ({ id: batch.id, createdAt: batch.createdAt, selection: { ...batch.selection }, count: batch.messageIds.length })),
    range: { start, end }, fingerprint, matchedCount: matched.length, deleteCount: candidates, purgeCount: candidates,
    retainedCount: retained.length, alreadyDeletedCount: matched.length, reasonCounts, reasonLabels: REASONS,
    warnings: warningList, summaryRanges,
    sample: matched.slice(0, 100).map(message => ({ id: message.id, groupId: message.groupId, time: message.time, senderId: message.senderId,
      senderName: message.senderName, text: require('./edition-policy.cjs').projectMessage(message).text.slice(0, 240), action: reasons.get(keyOf(message)).size ? 'retain' : 'permanent', reasons: [...reasons.get(keyOf(message))] })),
    sampleTruncated: matched.length > 100,
    retentionNote: '重新核对所选批次的原保留规则及当前收藏、摘要、导出、未读、阅读位置和同步起点。受保护消息继续留在回收区；未选批次不受影响。',
    recycleNote: '永久删除不可从回收区恢复；将移除所选消息正文、成员和媒体记录，仅保留群 ID、消息 ID 和原始时间，防止同步或导入立即补回。既有备份、媒体缓存和微博服务端消息不受影响。',
  };
}

function applyMessagePurge(state, input, expectedFingerprint, { now = Date.now, onProgress } = {}) {
  if (typeof expectedFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(expectedFingerprint)) throw new Error('请先预览回收区永久删除范围，再明确确认。');
  const preview = previewMessagePurge(state, input, { onProgress });
  if (preview.fingerprint !== expectedFingerprint) throw new Error('回收批次或保留条件已变化，请重新预览后确认；尚未永久删除任何消息。');
  if (!preview.deleteCount) return { purged: false, purgedCount: 0, groupId: preview.groupId, mode: 'purge', preview };
  const createdAt = now();
  if (!validTime(createdAt)) throw new Error('永久删除时间无效。');
  const batchIds = new Set(preview.batchIds), protections = new Map(), protectionCache = new Map();
  for (const batch of state.messageTrash || []) if (batchIds.has(batch.id)) {
    const selection = normalizeSelection(batch.selection), cacheKey = String(selection.retainSummaryRanges);
    if (!protectionCache.has(cacheKey)) protectionCache.set(cacheKey, protection(state, { ...selection, retainSenderIds: [] }).reasons);
    protections.set(batch.id, { reasons: protectionCache.get(cacheKey), members: new Set(selection.retainSenderIds) });
  }
  const messages = state.messages.filter(message => message.groupId === preview.groupId && batchIds.has(message.localDeletion?.batchId)
    && !protections.get(message.localDeletion.batchId).reasons.get(keyOf(message))?.size
    && !protections.get(message.localDeletion.batchId).members.has(message.senderId));
  if (messages.length !== preview.deleteCount) throw new Error('永久删除范围无法一致核对，尚未修改数据。');
  removePermanently(state, messages, onProgress);
  return { purged: true, purgedCount: messages.length, deleted: true, deletedCount: messages.length,
    groupId: preview.groupId, batchIds: preview.batchIds, batchCount: preview.batchCount, mode: 'purge', createdAt };
}

function listMessageTrash(state, query = {}) {
  if (!isRecord(query) || (query.groupId !== undefined && !validId(query.groupId))) throw new Error('回收区筛选群聊无效。');
  return (state.messageTrash || []).filter(batch => !query.groupId || batch.groupId === query.groupId).map(batch => ({
    id: batch.id, groupId: batch.groupId, groupName: state.groups.find(group => group.id === batch.groupId)?.name || batch.groupId,
    createdAt: batch.createdAt, restoredAt: batch.restoredAt, count: batch.messageIds.length, selection: { ...batch.selection },
    recoverableCount: batch.restoredAt === null ? batch.messageIds.length : 0,
  })).sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

function restoreMessageTrash(state, batchId, { now = Date.now, onProgress } = {}) {
  if (!validId(batchId)) throw new Error('回收批次 ID 无效。');
  const batch = (state.messageTrash || []).find(batch => batch.id === batchId);
  if (!batch) throw new Error('当前账号中找不到该回收批次。');
  if (batch.restoredAt !== null) return { restored: false, restoredCount: 0, batchId, groupId: batch.groupId };
  const restoredAt = now(); if (!validTime(restoredAt)) throw new Error('恢复时间无效。');
  const messages = state.messages.filter(message => message.localDeletion?.batchId === batchId && message.groupId === batch.groupId);
  if (messages.length !== batch.messageIds.length) throw new Error('回收批次记录不完整，尚未恢复；请保留数据后检查。');
  progress(onProgress, 'processing', 0, messages.length);
  let count = 0;
  for (const message of messages) {
    delete message.localDeletion;
    if (++count % 2048 === 0 || count === messages.length) progress(onProgress, 'processing', count, messages.length);
  }
  batch.restoredAt = restoredAt;
  return { restored: true, restoredCount: count, batchId, groupId: batch.groupId, restoredAt };
}

module.exports = { visibleMessages, normalizeSelection, normalizeLocalDeletion, validateMessageTrash, validateMessageTombstones,
  normalizePurgeSelection, previewMessagePurge, applyMessagePurge,
  previewMessageCleanup, applyMessageCleanup, listMessageTrash, restoreMessageTrash, REASONS };
