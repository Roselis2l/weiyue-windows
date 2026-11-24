'use strict';

const { classifyMessageAuthorship } = require('./message-authorship.cjs');
const { NOTICE } = require('./message-recalls.cjs');

const TYPE_LABELS = Object.freeze({
  'member-message': '成员消息',
  'system-notice': '系统通知',
  'withdrawn-unavailable': '撤回占位（无可用原文）',
  unknown: '未知（旧记录未保存类型）',
});

// Export only the current edition's visible message. editionData is deliberately
// neither inspected nor copied; it is not an exportable source of identity/text.
function exportRecord(message) {
  const identity = classifyMessageAuthorship(message);
  const value = identity.messageType === 'withdrawn-unavailable'
    ? { id: message.id, groupId: message.groupId, time: message.time,
      senderId: message.senderId, senderName: message.senderName, text: NOTICE,
      ...(message.systemNotice ? { systemNotice: message.systemNotice } : {}),
      ...(message.recall ? { recall: { ...message.recall, originalAvailable: false } } : {}) }
    : { ...message };
  delete value.editionData;
  delete value.standaloneEmoticons;
  return { ...value, actualSenderId: identity.senderId, messageType: identity.messageType,
    recordIdentity: { ...identity } };
}

// Old summaries lack sender/type metadata. Resolve by exact group+message+time
// from the account's visible projection when available; never infer from names.
function referenceWithIdentity(reference, visibleMessage) {
  const exact = visibleMessage && visibleMessage.id === reference.id &&
    visibleMessage.groupId === reference.groupId && visibleMessage.time === reference.time;
  if (exact) {
    const record = exportRecord(visibleMessage);
    return { ...reference, ...(record.messageType === 'withdrawn-unavailable' ? { text: record.text } : {}),
      senderId: visibleMessage.senderId, actualSenderId: record.actualSenderId,
      messageType: record.messageType, recordIdentity: record.recordIdentity };
  }
  if (reference.recordIdentity) return { ...reference };
  if (typeof reference.senderId === 'string' || reference.systemNotice || reference.recall) return exportRecord(reference);
  return { ...reference, actualSenderId: null, messageType: 'unknown',
    recordIdentity: { messageType: 'unknown', senderId: null, associatedSenderId: null,
      withdrawn: false, originalAvailable: false, authored: false } };
}

function metadataLine(record) {
  const identity = record.recordIdentity || classifyMessageAuthorship(record);
  const type = TYPE_LABELS[identity.messageType] ? identity.messageType : 'unknown';
  const value = value => typeof value === 'string' ? value.replace(/[\r\n\u0000-\u001f\u007f]/g, ' ') : '';
  const sender = identity.senderId ? value(identity.senderId) : '未提供';
  const associated = identity.associatedSenderId ? ` · 关联成员 ID：${value(identity.associatedSenderId)}（非发送者）` : '';
  const recalled = identity.withdrawn && identity.originalAvailable ? ' · 已撤回（本机留存原文）' : '';
  return `发送者 ID：${sender} · 消息类型：${TYPE_LABELS[type]} [${type}]${associated}${recalled}`;
}

function exportBookmarks(items, format = 'md') {
  const records = items.map(item => ({ ...item, messages: item.messages.map(exportRecord) }));
  if (format === 'json') return JSON.stringify(records, null, 2);
  return '# 微阅收藏\n\n' + records.map(bookmark => '## ' + bookmark.tags.join(' · ') + '\n\n' + bookmark.note + '\n\n' +
    bookmark.messages.map(message => `- ${new Date(message.time).toISOString()} ${message.senderName} · ${message.groupId}/${message.id}\n\n  ${metadataLine(message)}\n\n  ${message.text.replace(/\n/g, '\n  ')}`).join('\n\n')).join('\n\n---\n\n');
}

module.exports = { exportRecord, referenceWithIdentity, metadataLine, exportBookmarks };
