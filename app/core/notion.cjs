'use strict';

const { createHash } = require('node:crypto');
const { safePrefix, readJsonResponse } = require('./summary.cjs');
const { compareMessages } = require('./store.cjs');

const NOTION_VERSION = '2026-03-11';
const API_ORIGIN = 'https://api.notion.com/v1';
const MAX_BATCH_BYTES = 350000;
const MAX_DRAFT_BODY_CHARS = 200000;
const MAX_EXPORT_BLOCKS = 2000;
const MAX_EXPORT_BYTES = 4 * 1024 * 1024;
const MAX_BOOKMARKS = 100;
let exportBusy = false;

class NotionError extends Error {
  constructor(message, { code = 'NOTION_ERROR', uncertain = false, retryAfterSeconds, pageId } = {}) {
    super(message);
    this.name = 'NotionError'; this.code = code; this.uncertain = uncertain;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
    if (pageId) this.pageId = pageId;
  }
}

function normalizePageId(value) {
  if (typeof value !== 'string') throw new NotionError('Notion 目标必须是页面 ID。');
  const compact = value.replace(/-/g, '');
  if (!/^[a-f0-9]{32}$/i.test(compact) || !/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(value)) {
    throw new NotionError('Notion 页面 ID 格式无效；请选择搜索结果中的页面。');
  }
  const lower = compact.toLowerCase();
  return `${lower.slice(0, 8)}-${lower.slice(8, 12)}-${lower.slice(12, 16)}-${lower.slice(16, 20)}-${lower.slice(20)}`;
}

function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function textBlock(text, type = 'paragraph') {
  return { object: 'block', type, [type]: { rich_text: [{ type: 'text', text: { content: text } }] } };
}
function textBlocks(text) {
  if (!text) return [];
  const blocks = [];
  let remaining = text;
  while (remaining) {
    const part = safePrefix(remaining, 1800);
    blocks.push(textBlock(part)); remaining = remaining.slice(part.length);
  }
  return blocks;
}

function safeNotionUrl(value) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password &&
      /^(?:[a-z0-9-]+\.)*(?:notion\.so|notion\.com)$/i.test(url.hostname)) return url.href;
  } catch {}
  return '';
}

function plainText(value, label, max, { empty = true } = {}) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new NotionError(`${label}须为${empty ? '' : '非空'}纯文本，且不超过 ${max} 个字符。`);
  }
  return value;
}

function validTime(value) { return Number.isFinite(value) && Math.abs(value) <= 8.64e15; }

// Resolve IDs only against the account selected by the main process. Renderer
// payloads never supply source records, account IDs, credentials or Notion blocks.
function resolveNotionSource(state, { summaryId, bookmarkIds } = {}) {
  if (!state || !Array.isArray(state.summaries) || !Array.isArray(state.bookmarks) || !Array.isArray(state.messages)) throw new NotionError('当前本地工作区不可用。');
  if ((summaryId !== undefined) === (bookmarkIds !== undefined)) throw new NotionError('请选择一份摘要或至少一项收藏，不能混合导出。');
  if (summaryId !== undefined) {
    if (typeof summaryId !== 'string' || !summaryId || summaryId.length > 256) throw new NotionError('摘要 ID 无效。');
    const summary = state.summaries.find(item => item.id === summaryId);
    if (!summary) throw new NotionError('所选摘要不在当前账号中，请重新选择。');
    return { ...summary, sourceType: 'summary', sourceIds: [summary.id] };
  }
  if (!Array.isArray(bookmarkIds) || !bookmarkIds.length || bookmarkIds.length > MAX_BOOKMARKS || bookmarkIds.some(id => typeof id !== 'string' || !id || id.length > 256) || new Set(bookmarkIds).size !== bookmarkIds.length) throw new NotionError(`请选择 1–${MAX_BOOKMARKS} 项不重复的收藏。`);
  const ids = [...bookmarkIds].sort();
  const bookmarks = new Map(state.bookmarks.map(item => [item.id, item]));
  const messages = new Map(state.messages.map(item => [JSON.stringify([item.groupId, item.id]), item]));
  const groups = new Map((state.groups || []).map(item => [item.id, item.name]));
  const refs = [], seen = new Map(), parts = []; let bodyLength = 0;
  const add = value => {
    bodyLength += value.length + 2;
    if (bodyLength > MAX_DRAFT_BODY_CHARS) throw new NotionError('所选收藏正文过长，请减少本次选择的收藏。');
    parts.push(value);
  };
  ids.forEach((id, index) => {
    const bookmark = bookmarks.get(id);
    if (!bookmark) throw new NotionError('所选收藏不在当前账号中，请重新选择。');
    if (!Array.isArray(bookmark.messageIds) || !bookmark.messageIds.length || !Array.isArray(bookmark.tags)) throw new NotionError('收藏格式无效。');
    add(`收藏 ${index + 1} · ${plainText(groups.get(bookmark.groupId) || '群聊', '群名', 1000)}`);
    if (bookmark.tags.length) add(`标签：${bookmark.tags.map(tag => plainText(tag, '标签', 80)).join(' · ')}`);
    if (bookmark.note) add(`备注：${plainText(bookmark.note, '收藏备注', 100000)}`);
    const selectedMessages = bookmark.messageIds.map(messageId => {
      const message = messages.get(JSON.stringify([bookmark.groupId, messageId]));
      if (!message || !validTime(message.time)) throw new NotionError('收藏引用的本地消息已不可用，请重新选择。');
      return message;
    }).sort(compareMessages);
    for (const message of selectedMessages) {
      const key = JSON.stringify([message.groupId, message.id]);
      if (!seen.has(key)) {
        if (refs.length >= 10000) throw new NotionError('本次引用过多，请减少选择的收藏。');
        const label = `M${refs.length + 1}`;seen.set(key, label);
        refs.push({ id: message.id, groupId: message.groupId, time: message.time, senderName: message.senderName, text: message.text, label });
      }
      add(`[${seen.get(key)}] ${plainText(message.senderName, '成员名称', 512)} · ${new Date(message.time).toISOString()}\n${plainText(message.text, '消息正文', 1000000)}`);
    }
  });
  return { id: `bookmarks:${digest(JSON.stringify(ids))}`, sourceType: 'bookmarks', sourceIds: ids, title: `微阅收藏 · ${ids.length} 项`, body: parts.join('\n\n'), refs, mode: 'bookmarks' };
}

function buildPreview(summary, targetId, { draft, editable = false } = {}) {
  const target = normalizePageId(targetId);
  if (!summary || typeof summary.id !== 'string' || !summary.id || typeof summary.title !== 'string' ||
      typeof summary.body !== 'string' || !Array.isArray(summary.refs) || summary.refs.length > 10000 ||
      (summary.sourceType !== 'bookmarks' && (!validTime(summary.start) || !validTime(summary.end) || summary.start >= summary.end))) {
    throw new NotionError('摘要格式无效，无法预览导出。');
  }
  const sourceType = summary.sourceType === 'bookmarks' ? 'bookmarks' : 'summary';
  const sourceIds = sourceType === 'bookmarks' ? summary.sourceIds : [summary.id];
  if (!Array.isArray(sourceIds) || !sourceIds.length || sourceIds.length > MAX_BOOKMARKS || sourceIds.some(id => typeof id !== 'string' || !id || id.length > 256) || new Set(sourceIds).size !== sourceIds.length) throw new NotionError('导出来源 ID 无效。');
  const contextText = sourceType === 'bookmarks' ? `来源：本地价值收藏 · ${sourceIds.length} 项` :
    `时段（左闭右开）：${new Date(summary.start).toISOString()} ≤ 消息时间 < ${new Date(summary.end).toISOString()}\n来源：${summary.mode === 'ai' ? 'AI 分段摘要' : '本地摘录式综述，未调用 AI'}`;
  const referenceParts = []; let referencesLength = 0;
  summary.refs.forEach((ref, index) => {
    if (!ref || typeof ref.id !== 'string' || !ref.id || ref.id.length > 512 || typeof ref.groupId !== 'string' || !ref.groupId || ref.groupId.length > 512 || !validTime(ref.time)) throw new NotionError('摘要引用格式无效。');
    plainText(ref.text, '引用原文', 1000000);
    const label = typeof ref.label === 'string' && /^M\d{1,8}$/.test(ref.label) ? ref.label : `M${index + 1}`;
    const reference = `[${label}] 群 ID：${ref.groupId}；消息 ID：${ref.id}\n${new Date(ref.time).toISOString()}${typeof ref.senderName === 'string' ? ` · ${plainText(ref.senderName, '成员名称', 512)}` : ''}\n${ref.text}`;
    referencesLength += reference.length + 2;
    if (referencesLength > MAX_EXPORT_BYTES) throw new NotionError('引用原文过长，请缩小本次导出范围。');
    referenceParts.push(reference);
  });
  const referencesText = referenceParts.join('\n\n');
  if (referencesText.length > MAX_EXPORT_BYTES) throw new NotionError('引用原文过长，请缩小本次导出范围。');
  const sourceHash = digest(JSON.stringify({ sourceType, sourceIds, title: summary.title, body: summary.body, warning: summary.warning, contextText, referencesText }));
  const edited = editable || draft !== undefined;
  if (draft !== undefined && (!draft || typeof draft !== 'object' || Array.isArray(draft) || typeof draft.includeReferences !== 'boolean')) throw new NotionError('请提交有效的编辑正文及引用原文选项。');
  const title = draft === undefined ? safePrefix(summary.title, 180) || '微阅时段摘要' : plainText(draft.title, '导出标题', 180, { empty: false }).trim();
  if (/[\r\n\t]/.test(title)) throw new NotionError('导出标题须为单行文本。');
  let initialBody = summary.body;
  // Remove only our generated local-summary warning from its known header slot.
  // User-edited drafts and quoted message text are always kept verbatim.
  if (summary.mode === 'local' && typeof summary.warning === 'string' && summary.warning && initialBody.startsWith('本地摘录式综述（未调用 AI）\n')) {
    const generated = `\n覆盖提示：\n${summary.warning}`, at = initialBody.indexOf(generated), next = at + generated.length;
    if (at >= 0 && (next === initialBody.length || /^\n\n第 \d+ 段 ·/.test(initialBody.slice(next))) && !initialBody.slice(0, at).includes('\n\n第 ')) initialBody = initialBody.slice(0, at) + initialBody.slice(next);
  }
  const body = plainText(draft === undefined ? initialBody : draft.body, '导出正文', edited ? MAX_DRAFT_BODY_CHARS : 1000000);
  const includeReferences = draft === undefined ? true : draft.includeReferences;
  const sourceKey = digest(JSON.stringify([sourceType, sourceIds, target]));
  const legacyKey = sourceType === 'summary' ? digest(JSON.stringify([summary.id, target])) : null;
  const key = edited ? digest(JSON.stringify(['editable-v2', sourceKey, sourceHash, title, body, includeReferences])) : legacyKey || sourceKey;
  const blocks = [textBlock(`微阅导出标识：${key}`), textBlock(contextText), ...textBlocks(body)];
  if (includeReferences) {
    blocks.push(textBlock('引用原文与本地定位', 'heading_2'));
    for (const reference of referenceParts) blocks.push(...textBlocks(reference));
  }
  const byteCount = Buffer.byteLength(JSON.stringify(blocks));
  if (blocks.length > MAX_EXPORT_BLOCKS || byteCount > MAX_EXPORT_BYTES) throw new NotionError(`导出内容超过 ${MAX_EXPORT_BLOCKS} 块或 4 MiB，请缩小范围或取消引用原文。`);
  const contentHash = digest(JSON.stringify({ title, blocks }));
  return {
    title, body, includeReferences, referencesText, contextText, sourceHash, sourceType, sourceIds,
    targetId: target, blocks, blockCount: blocks.length, byteCount, sourceCount: summary.refs.length,
    key, contentHash, sourceKey, legacyKey,
    limits: { titleChars: 180, bodyChars: MAX_DRAFT_BODY_CHARS, bookmarkCount: MAX_BOOKMARKS },
    notice: `确认后会向所选 Notion 页面创建子页面，发送当前编辑正文${includeReferences ? '及下方全部引用原文' : '，不附引用原文与本地定位'}；不会定时发送。`,
  };
}

function sameSourceEntries(journal, preview) {
  return Object.entries(journal).filter(([key, entry]) => entry && typeof entry === 'object' &&
    (entry.sourceKey === preview.sourceKey || key === preview.legacyKey));
}

function buildEditablePreview(source, targetId, journal = {}) {
  if (!journal || typeof journal !== 'object' || Array.isArray(journal)) throw new NotionError('本地导出日志格式无效，已阻止导出。');
  const initial = buildPreview(source, targetId, { editable: true });
  const entries = sameSourceEntries(journal, initial);
  const uncertain = entries.find(([, entry]) => ['pending', 'uncertain'].includes(entry.status));
  if (uncertain) throw new NotionError('该来源上次 Notion 写入结果不确定，请先核对目标页面；程序不会重新发送，也不能通过编辑正文绕过。', { code: 'NOTION_UNCERTAIN', uncertain: true, pageId: uncertain[1].pageId });
  const incomplete = entries.filter(([, entry]) => entry.pageId && entry.status !== 'completed');
  if (!incomplete.length) return initial;
  if (incomplete.length !== 1) throw new NotionError('该来源存在多条未完成的导出记录，请先核对目标页面；已阻止创建重复页面。', { code: 'NOTION_PARTIAL_DRAFT' });
  const [key, saved] = incomplete[0];
  if (!['partial', 'failed'].includes(saved.status) || !saved.draft || typeof saved.sourceHash !== 'string') throw new NotionError('旧导出已有部分内容写入，但本地未保留可恢复的编辑稿。请核对目标页面；程序不会重新创建页面。', { code: 'NOTION_PARTIAL_DRAFT', pageId: saved.pageId });
  if (saved.sourceHash !== initial.sourceHash) throw new NotionError('未完成导出的来源已变化，不能用新来源续写旧页面。请核对目标页面和本地导出记录。', { code: 'NOTION_SOURCE_CHANGED', pageId: saved.pageId });
  const restored = buildPreview(source, targetId, { draft: saved.draft });
  if (key !== restored.key || saved.contentHash !== restored.contentHash) throw new NotionError('本地保存的编辑稿与未完成导出记录不一致，已阻止续写。', { code: 'NOTION_PARTIAL_DRAFT', pageId: saved.pageId });
  return { ...restored, resumeNotice: '已恢复此目标下未完成的原编辑稿及引用选项。再次确认后仅向原页面续传尚未完成的内容；修改稿件会被阻止，不会另建页面。' };
}

function nextBatch(blocks, offset) {
  const result = []; let bytes = 0;
  for (let index = offset; index < blocks.length && result.length < 100; index++) {
    const size = Buffer.byteLength(JSON.stringify(blocks[index])) + 1;
    if (result.length && bytes + size > MAX_BATCH_BYTES) break;
    if (size > MAX_BATCH_BYTES) throw new NotionError('单条 Notion 内容过大。');
    result.push(blocks[index]); bytes += size;
  }
  return result;
}

function resultFromEntry(entry) {
  return { pageId: entry.pageId, url: entry.url || '', status: 'completed' };
}

class NotionClient {
  constructor({ token, fetch: request = globalThis.fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    if (typeof token !== 'string' || !token.trim() || token.length > 8192 || /[\r\n\u0000]/.test(token)) throw new NotionError('请在设置中填写有效 Notion Token。');
    if (typeof request !== 'function') throw new NotionError('网络功能不可用。');
    Object.defineProperty(this, 'token', { value: token.trim(), enumerable: false });
    Object.defineProperty(this, 'fetch', { value: request, enumerable: false });
    Object.defineProperty(this, 'sleep', { value: sleep, enumerable: false });
  }

  async request(path, { method = 'GET', body, write = false } = {}) {
    // All paths are built internally. Secrets never reach an arbitrary host or redirect.
    if (!/^\/(?:search|pages|blocks)(?:\/[^?#]*)?$/.test(path)) throw new NotionError('Notion 请求地址无效。');
    for (let attempt = 0; attempt < 4; attempt++) {
      let response;
      try {
        response = await this.fetch(`${API_ORIGIN}${path}`, {
          method, redirect: 'error', signal: AbortSignal.timeout(30000),
          headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', 'Notion-Version': NOTION_VERSION },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch {
        if (!write && attempt < 3) { await this.sleep(1000 * 2 ** attempt); continue; }
        throw new NotionError(write ? 'Notion 写入请求中断或超时，执行结果不确定，已停止自动重发。' : 'Notion 读取失败，请检查网络。', { uncertain: write, code: write ? 'NOTION_UNCERTAIN' : 'NOTION_NETWORK' });
      }
      let data;
      try { data = await readJsonResponse(response, 12 * 1024 * 1024); }
      catch {
        throw new NotionError(write ? 'Notion 写入响应无法确认，已停止自动重发。' : 'Notion 返回了无效响应。', { uncertain: write, code: write ? 'NOTION_UNCERTAIN' : 'NOTION_RESPONSE' });
      }
      if (response.ok) return data;
      const status = Number(response.status);
      const blocked = status === 429 && data?.additional_data?.rate_limit_reason === 'public_api_request_blocked';
      if ((status === 429 || status === 529) && !blocked) {
        const header = response.headers?.get?.('retry-after');
        const raw = header ?? data?.additional_data?.retry_after;
        const seconds = raw !== null && raw !== undefined && /^\d+$/.test(String(raw)) ? Number(raw) : 2 ** attempt;
        // A long rate limit is surfaced, never shortened or silently ignored.
        if (attempt < 3 && Number.isFinite(seconds) && seconds <= 60) { await this.sleep(seconds * 1000); continue; }
        throw new NotionError(`Notion 请求限流，请至少等待 ${Number.isFinite(seconds) ? seconds : 60} 秒后重试。`, { code: 'NOTION_RATE_LIMIT', retryAfterSeconds: seconds });
      }
      if (!write && [500, 502, 503, 504].includes(status) && attempt < 3) { await this.sleep(1000 * 2 ** attempt); continue; }
      const uncertain = write && (status >= 500 || status === 408 || status === 409);
      let committedId;
      if (typeof data?.additional_data?.committed_resource_id === 'string') {
        try { committedId = normalizePageId(data.additional_data.committed_resource_id); } catch {}
      }
      const message = uncertain ? `Notion 返回 HTTP ${status}，写入可能已经保存；已停止自动重发，请核对页面。` :
        blocked ? 'Notion 已限制此连接的访问，程序不会重试，请在 Notion 检查连接状态。' :
        [401, 403].includes(status) ? `Notion 返回 HTTP ${status}，请检查 Token、目标页面权限或工作区限制。` :
        `Notion 返回 HTTP ${status}，请检查目标页面与请求配置。`;
      throw new NotionError(message, { uncertain, code: uncertain ? 'NOTION_UNCERTAIN' : 'NOTION_HTTP', pageId: committedId });
    }
    throw new NotionError('Notion 请求失败。');
  }

  async listTargets() {
    const targets = new Map(); const cursors = new Set();
    let cursor;
    for (let page = 0; page < 100; page++) {
      const data = await this.request('/search', { method: 'POST', body: { filter: { property: 'object', value: 'page' }, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) } });
      if (!Array.isArray(data.results)) throw new NotionError('Notion 页面列表响应无效。');
      for (const item of data.results) {
        if (item.object !== 'page' || item.archived || item.is_archived || item.in_trash) continue;
        let id; try { id = normalizePageId(item.id); } catch { continue; }
        const property = Object.values(item.properties || {}).find(value => value && (value.type === 'title' || Array.isArray(value.title)));
        const title = (property?.title || []).map(value => value?.plain_text ?? value?.text?.content ?? '').join('');
        targets.set(id, { id, title: title || '未命名页面' });
      }
      if (!data.has_more) return [...targets.values()];
      if (typeof data.next_cursor !== 'string' || !data.next_cursor || cursors.has(data.next_cursor)) throw new NotionError('Notion 分页响应无效；未返回不完整的目标列表。');
      cursor = data.next_cursor; cursors.add(cursor);
    }
    throw new NotionError('Notion 页面列表超过本次读取上限，请减少连接可访问的页面后重试。');
  }

  preview(summary, targetId, options) { return buildPreview(summary, targetId, options); }

  async exportSummary(summary, targetId, { journal, saveJournal, draft, sourceHash } = {}) {
    if (!journal || typeof journal !== 'object' || Array.isArray(journal) || typeof saveJournal !== 'function') throw new NotionError('缺少持久化导出日志，已阻止 Notion 写入。');
    const preview = this.preview(summary, targetId, { draft });
    if (sourceHash !== undefined && sourceHash !== preview.sourceHash) throw new NotionError('本地来源已变化，请重新打开导出预览并核对内容。', { code: 'NOTION_SOURCE_CHANGED' });
    {
      for (const [key, previous] of sameSourceEntries(journal, preview)) {
        if (key === preview.key) continue;
        if (['pending', 'uncertain'].includes(previous.status)) throw new NotionError('此来源上次 Notion 写入结果不确定，编辑正文也不会重新发送；请先核对目标页面。', { code: 'NOTION_UNCERTAIN', uncertain: true, pageId: previous.pageId });
        if (previous.pageId && previous.status !== 'completed') throw new NotionError('此来源有尚未完成的导出，请使用原编辑内容和引用选项继续，避免创建重复页面。', { code: 'NOTION_PARTIAL_DRAFT', pageId: previous.pageId });
      }
    }
    let entry = journal[preview.key];
    if (entry && entry.contentHash !== preview.contentHash) throw new NotionError('此摘要的已导出内容与当前内容不同；请另存新摘要，避免覆盖或重复导出。', { code: 'NOTION_CONTENT_CHANGED' });
    if (entry?.status === 'completed') return resultFromEntry(entry);
    if (entry && ['pending', 'uncertain'].includes(entry.status)) {
      throw new NotionError(`上次 Notion 写入结果不确定，程序不会重发。请在目标页面核对导出标识 ${preview.key}，并保留本地导出日志。`, { code: 'NOTION_UNCERTAIN', uncertain: true, pageId: entry.pageId });
    }
    if (entry && !['partial', 'failed'].includes(entry.status)) throw new NotionError('导出日志状态无效，已阻止写入。');
    if (Number.isFinite(entry?.retryAt) && entry.retryAt > Date.now()) {
      const seconds = Math.ceil((entry.retryAt - Date.now()) / 1000);
      throw new NotionError(`Notion 仍处于限流等待期，请至少等待 ${seconds} 秒后重试。`, { code: 'NOTION_RATE_LIMIT', retryAfterSeconds: seconds });
    }
    if (exportBusy) throw new NotionError('已有 Notion 导出正在进行，请等待完成。', { code: 'NOTION_BUSY' });
    exportBusy = true;
    const persist = async next => {
      const state = { ...journal, [preview.key]: next };
      try { await saveJournal(JSON.parse(JSON.stringify(state))); }
      catch { throw new NotionError('本地导出日志未能保存，已停止 Notion 写入；若请求已经提交，请核对目标页面。', { code: 'NOTION_JOURNAL' }); }
      journal[preview.key] = next; entry = next;
    };
    const writeBatch = async (phase, batch) => {
      const offset = entry.nextBlock;
      await persist({ ...entry, status: 'pending', phase, pendingBatch: { start: offset, end: offset + batch.length }, updatedAt: Date.now() });
      let data;
      try {
        data = phase === 'create'
          ? await this.request('/pages', { method: 'POST', write: true, body: { parent: { type: 'page_id', page_id: preview.targetId }, properties: { title: { type: 'title', title: [{ type: 'text', text: { content: preview.title } }] } }, children: batch } })
          : await this.request(`/blocks/${normalizePageId(entry.pageId)}/children`, { method: 'PATCH', write: true, body: { children: batch } });
        if (phase === 'create') {
          let pageId; try { pageId = normalizePageId(data.id); } catch { throw new NotionError('Notion 已接收创建请求但未返回有效页面 ID，结果不确定。', { uncertain: true, code: 'NOTION_UNCERTAIN' }); }
          data = { pageId, url: safeNotionUrl(data.url) };
        } else if (!Array.isArray(data.results) || data.results.length !== batch.length) {
          throw new NotionError('Notion 已接收追加请求但未确认全部内容，结果不确定。', { uncertain: true, code: 'NOTION_UNCERTAIN' });
        }
      } catch (error) {
        const uncertain = !(error instanceof NotionError) || error.uncertain;
        await persist({ ...entry, status: uncertain ? 'uncertain' : 'failed', ...(error.pageId && phase === 'create' ? { pageId: error.pageId } : {}), retryAt: Number.isFinite(error.retryAfterSeconds) ? Date.now() + error.retryAfterSeconds * 1000 : null, errorCode: error.code || 'NOTION_UNCERTAIN', updatedAt: Date.now() });
        throw error instanceof NotionError ? error : new NotionError('Notion 写入结果不确定，已停止自动重发。', { uncertain: true, code: 'NOTION_UNCERTAIN' });
      }
      // If this save fails, persisted 'pending' prevents a duplicate after restart.
      await persist({ ...entry, ...(phase === 'create' ? data : {}), status: 'partial', phase: 'append', nextBlock: offset + batch.length, pendingBatch: null, retryAt: null, errorCode: null, updatedAt: Date.now() });
    };
    try {
      if (!entry) entry = { summaryId: summary.id, sourceType: preview.sourceType, sourceIds: preview.sourceIds, sourceKey: preview.sourceKey, sourceHash: preview.sourceHash, ...(draft === undefined ? {} : { draft: { title: preview.title, body: preview.body, includeReferences: preview.includeReferences } }), targetId: preview.targetId, contentHash: preview.contentHash, title: preview.title, nextBlock: 0, status: 'partial', createdAt: Date.now() };
      if (!Number.isInteger(entry.nextBlock) || entry.nextBlock < 0 || entry.nextBlock > preview.blocks.length || (entry.nextBlock > 0 && !entry.pageId)) throw new NotionError('导出日志进度无效，已阻止写入。');
      if (entry.pageId) normalizePageId(entry.pageId);
      if (!entry.pageId) await writeBatch('create', nextBatch(preview.blocks, 0));
      while (entry.nextBlock < preview.blocks.length) await writeBatch('append', nextBatch(preview.blocks, entry.nextBlock));
      await persist({ ...entry, status: 'completed', pendingBatch: null, updatedAt: Date.now() });
      return resultFromEntry(entry);
    } finally { exportBusy = false; }
  }
}

module.exports = { NotionClient, NotionError, buildPreview, buildEditablePreview, resolveNotionSource, normalizePageId, nextBatch, NOTION_VERSION, MAX_BATCH_BYTES, MAX_DRAFT_BODY_CHARS, MAX_EXPORT_BLOCKS, MAX_EXPORT_BYTES };
