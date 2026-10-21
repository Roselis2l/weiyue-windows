'use strict';

// Only explicit status / retweeted_status objects are references. The official
// web reply UI can produce quoted plain text without a target ID; text, member
// names, notification wording and surrounding messages are never used to guess
// that target. This module performs no requests.
const {normalizeImage, safePostUrl} = require('./media.cjs');
const {classifySystemNotice} = require('./system-notices.cjs');
const MAX_REFERENCES = 20;
const MAX_REFERENCE_DEPTH = 4;
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const fail = () => { throw new TypeError('引用内容格式无效'); };
function text(value, maximum, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || value.length > maximum) fail();
  return value;
}
function postId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) value = String(value);
  return typeof value === 'string' && /^[1-9][0-9]{0,63}$/.test(value) ? value : null;
}
function postPermalink(status) {
  if (!object(status)) return undefined;
  // A returned post ID identifies the official mobile detail route. This is
  // deliberately unavailable for generic chat IDs and notification text.
  const id = postId(status.idstr ?? status.id ?? status.mid);
  return id ? 'https://m.weibo.cn/detail/' + id : undefined;
}
function referenceKey(value) {
  if (value.id) return 'id:' + value.id;
  if (value.url) return 'url:' + value.url;
  return 'snapshot:' + JSON.stringify([value.text, value.author || '', value.images.map(image => image.originalUrl || image.url)]);
}
function normalizeReference(value) {
  if (!object(value) || value.kind !== 'post' || !['shared', 'repost'].includes(value.relation) || !['ready', 'unavailable'].includes(value.state)) fail();
  if (!Array.isArray(value.images) || value.images.length > 100) fail();
  const images = [], seen = new Set();
  for (const source of value.images) {
    const image = normalizeImage(source); if (!image) fail();
    const key = image.originalUrl || image.url;
    if (!seen.has(key)) { seen.add(key); images.push(image); }
  }
  const result = {kind:'post', relation:value.relation, text:text(value.text,1000000), images, state:value.state};
  if (value.id !== undefined) { result.id = postId(value.id); if (!result.id) fail(); }
  if (value.url !== undefined) { result.url = safePostUrl(value.url); if (!result.url) fail(); }
  if (value.author !== undefined) result.author = text(value.author,512);
  if (value.reason !== undefined) result.reason = text(value.reason,10000);
  if (value.truncated !== undefined) { if (typeof value.truncated !== 'boolean') fail(); result.truncated = value.truncated; }
  return result;
}
function normalizeReferences(values) {
  if (!Array.isArray(values) || values.length > MAX_REFERENCES) fail();
  const result = [], seen = new Set();
  for (const value of values) {
    const reference = normalizeReference(value), key = referenceKey(reference);
    if (!seen.has(key)) { seen.add(key); result.push(reference); }
  }
  return result;
}
function mergeReferences(previous = [], incoming = []) {
  const records = new Map(normalizeReferences(previous).map(value => [referenceKey(value),value]));
  for (const value of normalizeReferences(incoming)) {
    const key = referenceKey(value), old = records.get(key);
    if (!old) { if(records.size < MAX_REFERENCES) records.set(key,value); continue; }
    const images = new Map(old.images.map(image => [image.originalUrl || image.url,image]));
    for (const image of value.images) if (images.size < 100 || images.has(image.originalUrl || image.url)) images.set(image.originalUrl || image.url,image);
    const merged = {...old,...value,images:[...images.values()]};
    for (const field of ['id','url','author']) if (!value[field] && old[field]) merged[field] = old[field];
    if (old.text && (!value.text.trim() || value.text.length < old.text.length || value.state === 'unavailable' || value.truncated && !old.truncated)) {
      merged.text = old.text;
      if (old.truncated !== undefined) merged.truncated = old.truncated; else delete merged.truncated;
      if (value.state === 'ready' && value.text !== old.text) { merged.state = 'unavailable'; merged.reason = '本次引用内容不完整，保留已缓存内容，请核对原微博。'; }
    }
    if (merged.state === 'ready' && !value.reason) delete merged.reason;
    records.set(key,merged);
  }
  return [...records.values()];
}
function collectPostReferences(message, normalizePost) {
  if (!object(message) || typeof normalizePost !== 'function') return [];
  const entries = Array.isArray(message.url_objects) ? message.url_objects.slice(0,50).filter(entry => object(entry) && object(entry.status)) : [];
  const primary = entries[0]?.status || object(message.status);
  if (!primary) return [];
  const references = [], visited = new Set(), seen = new Set();
  const primaryId = postId(primary.idstr ?? primary.id ?? primary.mid);
  if (primaryId) seen.add('id:' + primaryId);
  function visit(status, relation, depth, include, entry) {
    if (!object(status) || visited.has(status) || depth > MAX_REFERENCE_DEPTH || references.length >= MAX_REFERENCES) return;
    visited.add(status);
    if (include) {
      // Normalize this exact node without flattening its child into it. The
      // bounded traversal emits child originals separately below.
      const shallow = {...status}; delete shallow.retweeted_status;
      const post = normalizePost(shallow,entry);
      if (post) {
        const value = normalizeReference({kind:'post',relation,...post}), key = referenceKey(value);
        if (!seen.has(key)) { seen.add(key); references.push(value); }
      }
    }
    // Deleted originals must not expose residual nested cached payloads as if
    // they were currently available.
    if (status.deleted === true || status.deleted === 1 || status.deleted === '1' || status.error) return;
    visit(status.retweeted_status,'repost',depth+1,true);
  }
  visit(primary,'shared',0,false,entries[0]);
  for (const entry of entries.slice(1)) visit(entry.status,'shared',0,true,entry);
  return references;
}

// The current official web response can contain this literal reply preview but
// omit the referenced message ID and image. Recognizing the preview is not a
// target lookup: neither the current message's pictures nor a nearby message
// may be promoted to the quoted original. Keep this separate from post refs.
function isImageQuoteText(value) {
  return typeof value === 'string' && value.length <= 1000000 &&
    /^「(?:@[^\r\n:]{1,256}:)?图片」\r?\n- - - - - - - - - - - - - - -\r?\n/.test(value);
}
function normalizeQuotePreview(value) {
  if (!object(value) || value.kind !== 'image' || value.state !== 'unavailable' || value.reasonCode !== 'WEB_REFERENCE_TARGET_UNAVAILABLE') {
    throw new TypeError('引用预览信息无效');
  }
  return {kind:'image',state:'unavailable',reasonCode:'WEB_REFERENCE_TARGET_UNAVAILABLE'};
}
function normalizeMessageContext(message) {
  if (!object(message)) throw new TypeError('消息上下文格式无效');
  const systemNotice = classifySystemNotice(message);
  const sourceText = typeof message.content === 'string' ? message.content : message.text;
  return {contextVersion:1,
    ...(systemNotice ? {systemNotice} : {}),
    ...(!systemNotice && isImageQuoteText(sourceText) ? {quotePreview:normalizeQuotePreview({kind:'image',state:'unavailable',reasonCode:'WEB_REFERENCE_TARGET_UNAVAILABLE'})} : {})};
}

module.exports = {MAX_REFERENCES,MAX_REFERENCE_DEPTH,postPermalink,normalizeReference,normalizeReferences,mergeReferences,collectPostReferences,isImageQuoteText,normalizeQuotePreview,normalizeMessageContext};
