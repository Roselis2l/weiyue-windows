'use strict';

const {createHash} = require('node:crypto');
const {safeImageUrl, safePostUrl} = require('./media.cjs');
const {isPublishedPostNotification} = require('./weibo.cjs');

const MAX_IMAGES = 24;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 24 * 1024 * 1024;
const MAX_POST_LOOKUPS = 24;
const MAX_POST_CHARS = 1000000;
const PREPARATION_BUDGET_MS = 90000;
const OPERATION_TIMEOUT_MS = 10000;
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

class SummaryContentError extends Error {
  constructor(code) {
    super(code === 'SUMMARY_CONTENT_ABORT' ? '内容准备已取消，未发送 AI 请求。' :
      code === 'SUMMARY_CONTENT_TIMEOUT' ? '内容读取超过本次时间预算。' : '摘要内容快照无效，请重新选择时段。');
    this.name = 'SummaryContentError';
    this.code = code;
  }
}
function checkAbort(signal) { if (signal?.aborted) throw new SummaryContentError('SUMMARY_CONTENT_ABORT'); }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : null; }
function key(message) { return JSON.stringify([message.groupId, message.id]); }
function boundedSetting(value, fallback, max) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new SummaryContentError('SUMMARY_CONTENT_INVALID');
  return value;
}
function incompletePost(post) {
  return post?.truncated === true || /(?:展开全文|查看全文|全文)\s*(?:https?:\/\/\S+)?\s*$/.test(String(post?.text || ''));
}
function knownPostPermalink(value) {
  const safe = safePostUrl(value);
  if (!safe) return null;
  const url = new URL(safe);
  if ((['weibo.com', 'www.weibo.com'].includes(url.hostname) && /^\/[1-9]\d*\/[a-zA-Z0-9]+\/?$/.test(url.pathname)) ||
    (url.hostname === 'm.weibo.cn' && /^\/(?:detail|status)\/[a-zA-Z0-9]+\/?$/.test(url.pathname)) ||
    (url.hostname === 'weibo.cn' && /^\/comment\/[a-zA-Z0-9]+\/?$/.test(url.pathname))) return safe;
  return null;
}
function inferredPost(message) {
  if (object(message.sharedPost)) return message.sharedPost;
  if (isPublishedPostNotification(message.text)) return null;
  const links = String(message.text || '').match(/https:\/\/[^\s<>"'，。！？；）)]+/g) || [];
  const url = links.map(knownPostPermalink).find(Boolean);
  return url ? {state: 'unavailable', text: '', images: [], url} : null;
}
function pureNotification(message, post) {
  return isPublishedPostNotification(message.text) &&
    (!post || (!String(post.text || '').trim() && !(Array.isArray(post.images) && post.images.length)));
}
function postMatches(previous, next) {
  if (previous?.id && next?.id && previous.id !== next.id) return false;
  const a = knownPostPermalink(previous?.url), b = knownPostPermalink(next?.url);
  if (a && b) {
    const aa = new URL(a), bb = new URL(b);
    if (aa.hostname === bb.hostname && aa.pathname.replace(/\/$/, '') !== bb.pathname.replace(/\/$/, '')) return false;
  }
  return true;
}
function recognizedMime(bytes) {
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}
async function boundedRead(operation, signal, timeoutMs) {
  checkAbort(signal);
  const controller = new AbortController();
  let timer, onAbort;
  const interrupted = new Promise((_, reject) => {
    onAbort = () => { controller.abort(); reject(new SummaryContentError('SUMMARY_CONTENT_ABORT')); };
    signal?.addEventListener('abort', onAbort, {once: true});
    timer = setTimeout(() => { controller.abort(); reject(new SummaryContentError('SUMMARY_CONTENT_TIMEOUT')); }, timeoutMs);
    if (signal?.aborted) onAbort();
  });
  try {
    return await Promise.race([Promise.resolve().then(() => {checkAbort(signal); return operation(controller.signal);}), interrupted]);
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
  }
}

// Only data in the chosen immutable chat snapshot can be enriched. This module
// never calls an AI service, opens arbitrary post links or persists image bytes.
// client is an already authenticated account-scoped WeiboClient, supplied only
// for Weibo accounts. loadImage(url, options) uses the existing safe media proxy.
async function prepareSummaryContent(prepared, {
  messages = [], client, loadImage, includeImages = true, signal,
  maxImages, maxImageBytes, maxTotalImageBytes, maxPostLookups,
  timeoutMs, operationTimeoutMs,
} = {}) {
  if (!prepared || !Array.isArray(prepared.messages) || !Array.isArray(messages) ||
    !prepared.range || !Number.isFinite(prepared.range.start) || !Number.isFinite(prepared.range.end) ||
    prepared.range.start >= prepared.range.end || typeof prepared.groupId !== 'string' ||
    typeof includeImages !== 'boolean') throw new SummaryContentError('SUMMARY_CONTENT_INVALID');
  const limits = {
    images: boundedSetting(maxImages, MAX_IMAGES, MAX_IMAGES),
    imageBytes: boundedSetting(maxImageBytes, MAX_IMAGE_BYTES, MAX_IMAGE_BYTES),
    totalBytes: boundedSetting(maxTotalImageBytes, MAX_TOTAL_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES),
    postLookups: boundedSetting(maxPostLookups, MAX_POST_LOOKUPS, MAX_POST_LOOKUPS),
    duration: boundedSetting(timeoutMs, PREPARATION_BUDGET_MS, PREPARATION_BUDGET_MS),
    operation: boundedSetting(operationTimeoutMs, OPERATION_TIMEOUT_MS, 20000),
  };
  const raw = new Map();
  for (const message of messages) {
    if (!message || message.groupId !== prepared.groupId || message.time < prepared.range.start || message.time >= prepared.range.end) continue;
    const itemKey = key(message);
    if (raw.has(itemKey) && JSON.stringify(raw.get(itemKey)) !== JSON.stringify(message)) throw new SummaryContentError('SUMMARY_CONTENT_INVALID');
    raw.set(itemKey, message);
  }
  const selected = prepared.messages.map(message => {
    const match = raw.get(key(message));
    if (!match || message.groupId !== prepared.groupId || match.time !== message.time || match.text !== message.text ||
      match.senderId !== message.senderId || match.senderName !== message.senderName) throw new SummaryContentError('SUMMARY_CONTENT_INVALID');
    return match;
  });
  const deadline = Date.now() + limits.duration;
  const content = [];
  const imageCache = new Map(), uniqueImages = new Map();
  let totalBytes = 0, lookups = 0, postCount = 0, notificationCount = 0;
  const omissions = [];
  function omit(item, kind, reason, sourceUrl) {
    const omission = {kind, reason, messageId: item.messageId, groupId: prepared.groupId};
    const safe = kind === 'image' ? safeImageUrl(sourceUrl) : safePostUrl(sourceUrl);
    if (safe) omission.sourceUrl = safe;
    item.omissions.push(omission); omissions.push(omission);
  }
  for (const message of selected) {
    checkAbort(signal);
    const item = {messageId: message.id, text: '', images: [], omissions: [], postCount: 0};
    content.push(item);
    if(message.recall?.state==='withdrawn'){
      // A withdrawn source is a fixed local snapshot. Never re-fetch its post,
      // image or attachment while preparing an explicitly requested summary.
      if(message.sharedPost?.text){item.text='[本机已保存的分享微博]\n'+message.sharedPost.text.slice(0,MAX_POST_CHARS);item.postCount=1;postCount++;}
      omit(item,'post','撤回消息仅使用本机已保存的文字，不补取原帖或媒体。');
      continue;
    }
    let post = inferredPost(message);
    let detailRead = false;
    const notification = pureNotification(message, post);
    if (notification) { notificationCount++; post = null; }
    const pictures = Array.isArray(message.images) ? [...message.images] : [];
    if (post) {
      const needsRead = post.state !== 'ready' || !String(post.text || '').trim() || incompletePost(post);
      if (needsRead && client && typeof client.messageDetail === 'function') {
        if (lookups >= limits.postLookups) omit(item, 'post', '分享微博补全达到本次条数上限，仅使用已有内容。', post.url);
        else if (Date.now() >= deadline) omit(item, 'post', '分享微博补全超过本次时间预算，仅使用已有内容。', post.url);
        else {
          lookups++;
          detailRead = true;
          try {
            const detail = await boundedRead(innerSignal => client.messageDetail(message.groupId, message.id, {signal: innerSignal}), signal,
              Math.max(1, Math.min(limits.operation, deadline - Date.now())));
            checkAbort(signal);
            if (!detail || detail.id !== message.id || detail.groupId !== message.groupId || detail.time !== message.time ||
              !postMatches(post, detail.sharedPost)) throw new SummaryContentError('SUMMARY_CONTENT_INVALID');
            if (object(detail.sharedPost)) post = detail.sharedPost;
            if (Array.isArray(detail.images)) pictures.push(...detail.images);
          } catch (error) {
            checkAbort(signal);
            if (error?.code === 'SUMMARY_CONTENT_ABORT' || error?.code === 'ABORTED') throw new SummaryContentError('SUMMARY_CONTENT_ABORT');
            omit(item, 'post', ['SUMMARY_CONTENT_TIMEOUT', 'TIMEOUT'].includes(error?.code) ? '分享微博读取超时，仅使用已有内容。' : '分享微博无法通过当前登录会话补全，仅使用已有内容。', post.url);
          }
        }
      }
      const text = typeof post.text === 'string' ? post.text.trim() : '';
      if (post.state === 'ready' && text) {
        const author = typeof post.author === 'string' ? post.author.slice(0, 512) : '';
        item.text = `[分享微博${author ? ' @' + author : ''}${incompletePost(post) ? '，已知内容不完整' : ''}]\n${text.slice(0, MAX_POST_CHARS)}`;
        item.postCount = 1; postCount++;
        if (text.length > MAX_POST_CHARS) omit(item, 'post', '分享微博正文超过本次长度上限，后半部分未包含。', post.url);
      } else omit(item, 'post', '分享微博正文未返回、已删除或当前账号不可读；未把链接当成正文。', post.url);
      if (incompletePost(post)) omit(item, 'post', '分享微博或转发正文仍不完整，仅包含已读取部分。', post.url);
      if (post.state === 'ready' && Array.isArray(post.images)) pictures.push(...post.images);
    }
    const missingAttachment = !pictures.length && /^(?:分享图片|\[图片\])$/.test(String(message.text || '').trim());
    let missingAttachmentReason = '图片消息未返回可读取的图片地址，图片未发送。';
    if (missingAttachment && includeImages && !detailRead && client && typeof client.messageDetail === 'function') {
      if (lookups >= limits.postLookups) missingAttachmentReason = '图片消息补全达到本次条数上限，图片未发送。';
      else if (Date.now() >= deadline) missingAttachmentReason = '图片消息补全超过本次时间预算，图片未发送。';
      else {
        lookups++;
        try {
          const detail = await boundedRead(innerSignal => client.messageDetail(message.groupId, message.id, {signal: innerSignal}), signal,
            Math.max(1, Math.min(limits.operation, deadline - Date.now())));
          checkAbort(signal);
          if (!detail || detail.id !== message.id || detail.groupId !== message.groupId || detail.time !== message.time) throw new SummaryContentError('SUMMARY_CONTENT_INVALID');
          if (Array.isArray(detail.images)) pictures.push(...detail.images);
        } catch (error) {
          checkAbort(signal);
          if (error?.code === 'SUMMARY_CONTENT_ABORT' || error?.code === 'ABORTED') throw new SummaryContentError('SUMMARY_CONTENT_ABORT');
          missingAttachmentReason = ['SUMMARY_CONTENT_TIMEOUT', 'TIMEOUT'].includes(error?.code) ?
            '图片消息补全读取超时，图片未发送。' : '图片消息无法通过当前登录会话补全，图片未发送。';
        }
      }
    }
    if (missingAttachment && !pictures.length) omit(item, 'image', includeImages ?
      missingAttachmentReason : '所选模型未启用已确认的视觉能力，图片未发送。');
    const messageUrls = new Set();
    for (const image of pictures) {
      checkAbort(signal);
      const url = safeImageUrl(image?.originalUrl || image?.url);
      if (!url) { omit(item, 'image', '图片地址不在允许范围，未读取也未发送。'); continue; }
      if (messageUrls.has(url)) continue;
      messageUrls.add(url);
      if (!includeImages) { omit(item, 'image', '所选模型未启用已确认的视觉能力，图片未发送。', url); continue; }
      if (typeof loadImage !== 'function') { omit(item, 'image', '当前工作区没有可用的图片读取会话，图片未发送。', url); continue; }
      if (imageCache.has(url)) {
        const cached = imageCache.get(url);
        if (cached.image) item.images.push(cached.image);
        else omit(item, 'image', cached.reason, url);
        continue;
      }
      let loaded, reason;
      if (uniqueImages.size >= limits.images) reason = '图片数量达到本次上限，后续图片未发送。';
      else if (totalBytes >= limits.totalBytes) reason = '图片总大小达到本次上限，后续图片未发送。';
      else if (Date.now() >= deadline) reason = '图片准备超过本次时间预算，图片未发送。';
      else {
        try {
          loaded = await boundedRead(innerSignal => loadImage(url, {
            signal: innerSignal, maxBytes: Math.min(limits.imageBytes, limits.totalBytes - totalBytes),
            timeoutMs: Math.max(1, Math.min(limits.operation, deadline - Date.now())),
          }), signal, Math.max(1, Math.min(limits.operation, deadline - Date.now())));
          checkAbort(signal);
          const bytes = loaded?.bytes instanceof Uint8Array ? Buffer.from(loaded.bytes) : null;
          if (!bytes || !IMAGE_MIMES.has(loaded.mime) || recognizedMime(bytes) !== loaded.mime) reason = '图片格式不支持视觉请求（仅 JPEG、PNG、WebP）；图片未发送。';
          else if (bytes.length > limits.imageBytes) reason = '单张图片超过本次大小上限，图片未发送。';
          else {
            const hash = createHash('sha256').update(bytes).digest('hex');
            const existing = uniqueImages.get(hash);
            if (existing) loaded = {...existing, sourceUrl: url};
            else if (totalBytes + bytes.length > limits.totalBytes) reason = '图片总大小超过本次上限，图片未发送。';
            else {
              loaded = {dataUrl: `data:${loaded.mime};base64,${bytes.toString('base64')}`, sourceUrl: url, label: `I${uniqueImages.size + 1}`};
              uniqueImages.set(hash, loaded); totalBytes += bytes.length;
            }
          }
        } catch (error) {
          checkAbort(signal);
          if (error?.code === 'SUMMARY_CONTENT_ABORT' || error?.code === 'MEDIA_ABORT') throw new SummaryContentError('SUMMARY_CONTENT_ABORT');
          reason = ['MEDIA_TOO_LARGE'].includes(error?.code) ? '图片超过本次大小上限，图片未发送。' :
            ['SUMMARY_CONTENT_TIMEOUT', 'MEDIA_TIMEOUT'].includes(error?.code) ? '图片读取超时，图片未发送。' : '图片无法读取或格式不支持，图片未发送。';
        }
      }
      if (reason) {
        imageCache.set(url, {reason}); omit(item, 'image', reason, url);
      } else {
        imageCache.set(url, {image: loaded}); item.images.push(loaded);
      }
    }
  }
  checkAbort(signal);
  return {content, coverage: {messageCount: selected.length, postCount, imageCount: uniqueImages.size, imageBytes: totalBytes, notificationCount,
    postLookups: lookups, omissions}};
}

module.exports = {prepareSummaryContent, SummaryContentError, knownPostPermalink, pureNotification,
  MAX_IMAGES, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES, MAX_POST_LOOKUPS};
