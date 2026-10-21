'use strict';

// Protocol and lexical-ID handling informed by weiyue (MIT),
// Copyright (c) 2026 ylj5244-dot. See docs/REFERENCE-LICENSE.txt and
// docs/weibo-protocol.md. This module never reads or returns cookies.
const ORIGIN = 'https://api.weibo.com';
const {normalizeImage, safeImageUrl, safePostUrl} = require('./media.cjs');
const {firstAvatarUrl} = require('./avatar.cjs');
const {normalizeMessageAttachments}=require('./attachments.cjs');
const {postPermalink,collectPostReferences,normalizeMessageContext}=require('./message-references.cjs');
const PATHS = Object.freeze({
  identity: '/webim/query_primary_info.json',
  groups: '/webim/2/direct_messages/contacts.json',
  messages: '/webim/groupchat/query_messages.json',
  message: '/webim/groupchat/query_message.json'
});
const MAX_BODY = 8 * 1024 * 1024;

class WeiboError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'WeiboError';
    this.code = code;
    Object.assign(this, details);
  }
}
const invalid = (message = '微博响应格式无法确认，本批未保存。') => new WeiboError('INVALID_RESPONSE', message);
const cancelled = () => new WeiboError('ABORTED', '同步已取消，已保存的页面仍保留。');
function checkAbort(signal) { if (signal?.aborted) throw cancelled(); }

// Protect number tokens BEFORE JSON.parse. Decimal/exponent lexemes stay
// strings too: an ID such as 1.00000000000000001 must never round into 1.
function parsePrecisionJson(source) {
  if (typeof source !== 'string' || source.length > MAX_BODY) throw invalid();
  let protectedJson = '';
  for (let i = 0; i < source.length;) {
    const start = i;
    if (source[i] === '"') {
      i++;
      while (i < source.length) {
        const ch = source[i++];
        if (ch === '\\') i++;
        else if (ch === '"') break;
      }
      protectedJson += source.slice(start, i);
    } else if (source[i] === '-' || /[0-9]/.test(source[i])) {
      const match = source.slice(i).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
      if (!match) throw invalid();
      const token = match[0];
      const fractional = /[.eE]/.test(token);
      const digits = token[0] === '-' ? token.slice(1) : token;
      const unsafe = !fractional && (digits.length > 16 || (digits.length === 16 && digits > '9007199254740991'));
      protectedJson += fractional || unsafe ? JSON.stringify(token) : token;
      i += token.length;
    } else protectedJson += source[i++];
  }
  try { return JSON.parse(protectedJson); } catch { throw invalid(); }
}

function identifier(value, allowZero = false) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw invalid('消息标识精度无法确认，本批未保存。');
  if (typeof value !== 'string' && typeof value !== 'number') throw invalid('微博标识无效。');
  const text = String(value);
  if (text.length > 64 || !(allowZero ? /^(?:0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/).test(text)) throw invalid('微博标识必须是十进制整数字符串。');
  return text;
}
function previousId(id) { return (BigInt(identifier(id)) - 1n).toString(); }
function compareIds(a, b) { return BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0; }

function normalizeIdentity(data) {
  if (!data?.profile || typeof data.profile !== 'object') throw invalid('未确认微博登录身份，请先在官方网页完成登录。');
  return {id: identifier(data.profile.id), name: typeof data.profile.screen_name === 'string' ? data.profile.screen_name : '微博账号'};
}
function normalizeGroups(data) {
  if (!Array.isArray(data?.contacts)) throw invalid('微博群列表格式无法确认。');
  const groups = new Map();
  for (const contact of data.contacts) {
    const user = contact?.user;
    if (!user || user.type !== 2) continue;
    const id = identifier(user.id);
    const name = typeof user.name === 'string' && user.name.trim() ? user.name : user.screen_name;
    if (typeof name !== 'string' || !name.trim()) throw invalid('微博群名称缺失。');
    const avatarUrl = profileAvatarUrl(user, id);
    if (!groups.has(id)) groups.set(id, {id, name, selected: false, ...(avatarUrl ? {avatarUrl} : {})});
    else if (avatarUrl && !groups.get(id).avatarUrl) groups.get(id).avatarUrl = avatarUrl;
  }
  return [...groups.values()];
}
function messageTime(message) {
  let time;
  if (message.time !== undefined && message.time !== null) {
    const raw = message.time;
    if ((typeof raw !== 'number' && typeof raw !== 'string') || !/^[0-9]+(?:\.[0-9]+)?$/.test(String(raw))) throw invalid('消息时间无效。');
    time = Number(raw) * 1000;
  } else if (typeof message.created_at === 'string') time = Date.parse(message.created_at);
  if (!Number.isFinite(time) || time < 0 || time > 8640000000000000) throw invalid('消息时间缺失或无效，本批未保存。');
  return Math.trunc(time);
}
function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : null; }
function optionalIdentifier(value) {
  try { return identifier(value); } catch { return undefined; }
}
function profileAvatarUrl(profile, expectedId) {
  if (!object(profile)) return null;
  // Require explicit matching profile IDs before attaching metadata to a
  // message sender. A nickname or a neighbouring member profile is not proof.
  const ids = [profile.idstr, profile.id].filter(value => value !== undefined && value !== null);
  if (!ids.length || ids.some(value => optionalIdentifier(value) !== expectedId)) return null;
  // Explicit avatar field spellings only. The public reference documents
  // profileImageUrl for identity responses; snake-case names are compatibility
  // candidates and are accepted only with matching IDs and approved CDN URLs.
  return firstAvatarUrl(profile.avatar_large, profile.profile_image_url, profile.profileImageUrl);
}
function imageMetadata(picture) {
  if (typeof picture === 'string') return normalizeImage({url: picture, originalUrl: picture});
  if (!object(picture)) return null;
  // Check each explicitly supplied variant before choosing it. An invalid or
  // empty higher-priority field must not hide another safe URL in this record.
  // This is metadata selection only, never a retry after an HTTP rejection.
  const candidates = [
    {url: picture.original_pic, dimensions: picture},
    ...['largest', 'original', 'large'].map(key => ({url: object(picture[key])?.url, dimensions: object(picture[key])})),
    ...['url', 'pic', 'bmiddle_pic', 'thumbnail_pic'].map(key => ({url: picture[key], dimensions: picture})),
    {url: object(picture.thumbnail)?.url, dimensions: object(picture.thumbnail)}
  ];
  const selected = candidates.map(candidate => ({...candidate, url: safeImageUrl(candidate.url)})).find(candidate => candidate.url);
  if (!selected) return null;
  // Preserve a supplied middle-size preview when there is no safe thumbnail;
  // the original URL remains the first safe high-priority candidate above.
  const thumbnail = [picture.thumbnail_pic, object(picture.thumbnail)?.url, picture.bmiddle_pic].map(safeImageUrl).find(Boolean);
  const dimensions = selected.dimensions || picture;
  const size = value => typeof value === 'number' ? value : typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : undefined;
  return normalizeImage({url: selected.url, originalUrl: selected.url, thumbnailUrl: thumbnail,
    width: size(dimensions.width ?? picture.width), height: size(dimensions.height ?? picture.height)});
}
function normalizeImages(message, {allowFids = true} = {}) {
  const images = [], seen = new Set();
  const add = picture => {
    if (images.length >= 50) return;
    const image = imageMetadata(picture);
    if (!image || seen.has(image.originalUrl || image.url)) return;
    seen.add(image.originalUrl || image.url); images.push(image);
  };
  // The official web client calls the first pic_infos item pic_gifs when it
  // builds a display record. Preserve its explicit original resource, never
  // infer an animated URL from a thumbnail filename or FID.
  if (object(message.pic_gifs)) add(message.pic_gifs);
  const infos = Array.isArray(message.pic_infos) ? message.pic_infos : object(message.pic_infos) ? Object.values(message.pic_infos) : [];
  infos.forEach(add);
  if (Array.isArray(message.pic_urls)) message.pic_urls.forEach(add);
  if (Array.isArray(message.pics)) message.pics.forEach(add);
  if (message.original_pic || message.bmiddle_pic || message.thumbnail_pic) add(message);
  if (message.pic) add(message.pic);
  // Official card9 metadata carries an explicit GIF resource in
  // url_objects[].object.object.{gif_name,url}. A collection with only pic_ids
  // needs an official lookup; no CDN path is guessed from those IDs here.
  if (Array.isArray(message.url_objects)) for (const entry of message.url_objects.slice(0, 50)) {
    const outer = object(entry?.object);
    const gif = object(outer?.object) || outer;
    if (typeof gif?.gif_name === 'string' && gif.gif_name.trim()) add(gif.url);
  }
  // Explicit originals take priority over constructing a second URL for the same
  // attachment. FIDs remain lexical; unsafe Number values are skipped.
  if (!images.length && allowFids && (message.media_type === 1 || message.media_type === '1')) {
    for (const raw of [message.att_ids, message.fids]) {
      const fids = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [raw];
      for (const value of fids.slice(0, 50)) {
        const fid = optionalIdentifier(typeof value === 'string' ? value.trim() : value);
        if (!fid) continue;
        const url = new URL('https://upload.api.weibo.com/2/mss/msget');
        url.searchParams.set('source', '209678993'); url.searchParams.set('fid', fid); url.searchParams.set('imageType', 'origin');
        add(url.href);
      }
      // Retain att_ids precedence when it provides valid attachments. Empty or
      // invalid att_ids may fall back only to the response's explicit fids.
      if (images.length) break;
    }
  }
  return images;
}

function decodeEntities(text) {
  const named = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', emsp: '  '};
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos|nbsp|hellip|mdash|ndash|emsp);/gi, (entity, key) => {
    if (key[0] !== '#') return named[key.toLowerCase()] ?? entity;
    const point = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return Number.isInteger(point) && point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : '�';
  });
}
function postText(status) {
  const long = object(status.longText)?.longTextContent ?? status.longTextContent;
  if (!(typeof long === 'string' && long.trim()) && typeof status.text_raw === 'string') return status.text_raw.trim();
  const raw = typeof long === 'string' && long.trim() ? long : typeof status.text === 'string' ? status.text : '';
  // Produce plain text only. The renderer must still use textContent, never HTML.
  return decodeEntities(raw.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?\s*>|<\/(?:p|div)\s*>/gi, '\n')
    .replace(/<img\b[^>]*>/gi, tag => tag.match(/\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)?.slice(1).find(value => value !== undefined) || '')
    .replace(/<\/?[a-z][^>]*>/gi, '')).replace(/\r\n?/g, '\n').trim();
}
function postIncomplete(status) {
  if (!object(status)) return false;
  const long = object(status.longText)?.longTextContent ?? status.longTextContent;
  return status.truncated === true || status.truncated === 1 || status.truncated === '1' ||
    ((status.isLongText === true || status.isLongText === 1 || status.isLongText === '1') && !(typeof long === 'string' && long.trim())) ||
    /<a\b[^>]*>\s*(?:展开全文|查看全文|全文)\s*<\/a>/i.test(String(status.text || ''));
}
function isPublishedPostNotification(value) {
  return /^我发布了新微博(?:[，,]\s*快来围观吧)?[！!。.]?$/.test(String(value || '').trim());
}
function shareUrl(entry, status = {}) {
  const info = object(entry?.info) || {};
  for (const value of [info.url_long, entry?.url_ori, status.url, status.permalink, info.url_short, entry?.url]) {
    const url = safePostUrl(value);
    if (url) return url;
  }
  return undefined;
}
function normalizeSharedPost(message) {
  const entries = Array.isArray(message.url_objects) ? message.url_objects.filter(object) : [];
  const entry = entries.find(item => object(item.status));
  const status = object(entry?.status) || object(message.status);
  const notification = isPublishedPostNotification(message.content ?? message.text);
  if (!status && !notification) return undefined;
  const url = shareUrl(entry, status || {}) || postPermalink(status) || (notification ? entries.map(item => shareUrl(item)).find(Boolean) || safePostUrl(message.url) || undefined : undefined);
  if (!status && !url) return undefined;
  if (!status) return {text: '', images: [], state: 'unavailable', url,
    reason: '分享通知未附微博正文，请打开原微博查看'};
  const id = optionalIdentifier(status.idstr ?? status.id ?? status.mid);
  const author = typeof status.user?.screen_name === 'string' ? status.user.screen_name : typeof status.user?.name === 'string' ? status.user.name : undefined;
  let text = postText(status);
  const images = normalizeImages(status, {allowFids: false});
  const repost = object(status.retweeted_status);
  const incompleteReasons = [];
  if (repost) {
    const repostDeleted = repost.deleted === true || repost.deleted === 1 || repost.deleted === '1' || !!repost.error;
    const repostText = repostDeleted ? '' : postText(repost);
    const repostImages = repostDeleted ? [] : normalizeImages(repost, {allowFids: false});
    const repostAuthor = typeof repost.user?.screen_name === 'string' ? repost.user.screen_name : '';
    if (repostText) text += (text ? '\n\n' : '') + (repostAuthor ? '转发 @' + repostAuthor + '：\n' : '转发原文：\n') + repostText;
    const seen = new Set(images.map(image => image.originalUrl));
    for (const image of repostImages) if (images.length < 50 && !seen.has(image.originalUrl)) {images.push(image); seen.add(image.originalUrl);}
    if (repostDeleted || (!repostText && !repostImages.length)) incompleteReasons.push('转发原微博已删除或当前返回内容不可读');
    else if (postIncomplete(repost)) incompleteReasons.push('转发原微博正文可能被截断');
  }
  const deleted = status.deleted === true || status.deleted === 1 || status.deleted === '1' || !!status.error;
  const unavailable = deleted || (!text && !images.length);
  if (postIncomplete(status)) incompleteReasons.push('原微博正文可能被截断');
  const truncated = incompleteReasons.length > 0;
  return {text: deleted ? '' : text, images: deleted ? [] : images, state: unavailable ? 'unavailable' : 'ready',
    ...(id ? {id} : {}), ...(url ? {url} : {}), ...(author ? {author} : {}), ...(truncated ? {truncated: true} : {}),
    ...(unavailable ? {reason: deleted ? '原微博已删除或当前账号无法访问' : '消息未附可读取的微博正文或配图，请打开原微博查看'}
      : incompleteReasons.length ? {reason: incompleteReasons.join('；')} : {})};
}

function normalizeMessageReferences(message) {
  return collectPostReferences(message,(status,entry)=>normalizeSharedPost({
    status,
    ...(entry ? {url_objects:[{...entry,status}]} : {})
  }));
}

function normalizeMessages(data, groupId) {
  groupId = identifier(groupId);
  if (!Array.isArray(data?.messages)) throw invalid('微博消息列表格式无法确认。');
  if (data.messages.length > 1000) throw invalid('微博单页消息数量异常，本批未保存。');
  return data.messages.map(message => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw invalid();
    if (message.gid !== undefined && identifier(message.gid) !== groupId) throw invalid('返回消息所属群不匹配，本批未保存。');
    const id = identifier(message.id ?? message.mid ?? message.message_id);
    const sender = message.from_user || {};
    const senderId = message.from_uid ?? sender.idstr ?? sender.id;
    const unknownSender = senderId === undefined || senderId === null || senderId === '' || senderId === 0 || senderId === '0';
    const normalizedSenderId = unknownSender ? 'unknown:' + id : identifier(senderId);
    const senderAvatarUrl = unknownSender ? null : profileAvatarUrl(sender, normalizedSenderId);
    const senderName = typeof sender.screen_name === 'string' && sender.screen_name.trim() ? sender.screen_name : sender.name;
    const text = message.content ?? message.text ?? '';
    if (typeof text !== 'string') throw invalid('消息正文格式无法确认。');
    const images = normalizeImages(message);
    const sharedPost = normalizeSharedPost(message);
    const references = normalizeMessageReferences(message);
    const attachments = normalizeMessageAttachments(message);
    const context = normalizeMessageContext(message);
    return {id, groupId, senderId: normalizedSenderId,
      senderName: typeof senderName === 'string' && senderName.trim() ? senderName : '发送者待确认',
      text: text || (images.length ? '分享图片' : '[非文字或空消息；未返回可显示的媒体，请在微博官方查看。]'), time: messageTime(message), mediaVersion: 1, referenceVersion: 1,
      ...(images.length ? {images} : {}), ...(sharedPost ? {sharedPost} : {}),
      ...(references.length ? {references} : {}),
      ...(attachments.length ? {attachments,attachmentVersion:1} : {}),
      ...context,
      ...(senderAvatarUrl ? {senderAvatarUrl} : {})};
  });
}

function assertEnvelope(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalid();
  const code = data.error_code === undefined ? '' : String(data.error_code);
  if ((code && code !== '0') || data.error || data.result === false || data.ok === 0) {
    if (/^213\d{2}$/.test(code)) throw new WeiboError('AUTH_REQUIRED', '微博登录已失效，请在官方网页重新登录后再同步。');
    if (code === '10012') throw new WeiboError('PAGE_SOURCE_REJECTED', '微博未接受页面来源，请更新应用或重新打开官方登录页后重试。');
    // Never interpret or surface a server error string; it may contain account
    // data. All unknown business errors, including risk checks, stop immediately.
    throw new WeiboError('API_REJECTED', '微博拒绝本次读取，请在官方页面确认权限或风控提示后重试。');
  }
  return data;
}

function retryDelay(header, attempt, now = Date.now()) {
  const fallback = Math.min(8000, 750 * 2 ** attempt);
  if (typeof header !== 'string' || !header.trim()) return fallback;
  const seconds = /^\d+(?:\.\d+)?$/.test(header.trim()) ? Number(header) * 1000 : Date.parse(header) - now;
  return Number.isFinite(seconds) ? Math.max(fallback, seconds) : fallback;
}
function sleep(ms, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(cancelled()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, {once: true});
  });
}

async function readBody(response) {
  const length = Number(response.headers?.get('content-length'));
  if (Number.isFinite(length) && length > MAX_BODY) throw invalid('微博响应过大，本批未保存。');
  // Bound streaming reads instead of first allocating an unbounded text body.
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0, output = '';
    try {
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY) { await reader.cancel(); throw invalid('微博响应过大，本批未保存。'); }
        output += decoder.decode(value, {stream: true});
      }
      return output + decoder.decode();
    } finally { reader.releaseLock(); }
  }
  const raw = await response.text();
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_BODY) throw invalid('微博响应过大，本批未保存。');
  return raw;
}

class WeiboClient {
  constructor({fetch, sleep: sleeper = sleep, timeoutMs = 20000, maxAttempts = 3} = {}) {
    if (typeof fetch !== 'function') throw new TypeError('WeiboClient requires an account-scoped session fetch.');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new TypeError('Invalid timeout.');
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) throw new TypeError('Invalid retry attempt limit.');
    this.fetch = fetch;
    this.sleep = sleeper;
    this.timeoutMs = timeoutMs;
    this.maxAttempts = maxAttempts;
  }
  async _once(path, parameters, signal) {
    checkAbort(signal);
    if (!Object.values(PATHS).includes(path)) throw new WeiboError('UNSAFE_ENDPOINT', '微博接口地址未获允许。');
    const url = new URL(path, ORIGIN);
    url.searchParams.set('source', '209678993');
    for (const [key, value] of Object.entries(parameters)) if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
    const controller = new AbortController();
    let timeout, onAbort;
    const interrupted = new Promise((_, reject) => {
      timeout = setTimeout(() => { controller.abort(); reject(new WeiboError('TIMEOUT', '微博读取超时，请稍后重试。', {retryable: true})); }, this.timeoutMs);
      onAbort = () => { controller.abort(); reject(cancelled()); };
      signal?.addEventListener('abort', onAbort, {once: true});
    });
    const task = (async () => {
      let response;
      try {
        response = await this.fetch(url.href, {method: 'GET', credentials: 'include', redirect: 'error', cache: 'no-store',
          // Electron session.fetch has no document context and does not forward
          // RequestInit.referrer. Use the actual official login/reader page for
          // these fixed same-site GETs; no arbitrary referrer is accepted.
          headers: {Accept: 'application/json', Referer: ORIGIN + '/chat'}, signal: controller.signal});
      } catch {
        checkAbort(signal);
        throw new WeiboError('NETWORK', '微博连接失败，请检查网络后重试。', {retryable: true});
      }
      checkAbort(signal);
      if (response.url) {
        let target;
        try { target = new URL(response.url); } catch { throw invalid(); }
        if (target.origin !== ORIGIN || target.pathname !== path || target.username || target.password) {
          throw new WeiboError('UNSAFE_REDIRECT', '微博响应地址发生变化，已停止读取。');
        }
      }
      if (response.status === 401) throw new WeiboError('AUTH_REQUIRED', '微博登录已失效，请在官方网页重新登录。');
      if (response.status === 403) throw new WeiboError('ACCESS_DENIED', '微博拒绝访问，请在官方网页确认权限或风控提示。');
      // A rate limit ends this batch immediately. The account scheduler owns
      // Retry-After and must not silently retry a refused page in this batch.
      if (response.status === 429) throw new WeiboError('RATE_LIMIT', '微博暂时限流，请稍后重试。', {retryAfter: response.headers?.get('retry-after')});
      if (response.status >= 500 && response.status <= 599) throw new WeiboError('SERVER_ERROR', '微博服务暂时不可用，请稍后重试。', {retryable: true});
      if (response.status < 200 || response.status >= 300) throw new WeiboError('HTTP_ERROR', '微博读取失败，请在官方网页检查状态。');
      let raw;
      try { raw = await readBody(response); }
      catch (error) {
        if (error instanceof WeiboError) throw error;
        throw new WeiboError('NETWORK', '微博响应未完整接收，请稍后重试。', {retryable: true});
      }
      checkAbort(signal);
      return assertEnvelope(parsePrecisionJson(raw));
    })();
    try { return await Promise.race([task, interrupted]); }
    finally { clearTimeout(timeout); signal?.removeEventListener('abort', onAbort); }
  }
  async _request(path, parameters = {}, signal) {
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      try { return await this._once(path, parameters, signal); }
      catch (error) {
        checkAbort(signal);
        if (!(error instanceof WeiboError) || !error.retryable || attempt === this.maxAttempts - 1) throw error;
        const delay = retryDelay(error.retryAfter, attempt);
        // Do not shorten a server-requested cooldown into an aggressive retry.
        if (delay > 60000) throw new WeiboError('RATE_LIMIT', '微博要求较长等待，本次已停止；请稍后手动重试。', {retryAfter: error.retryAfter});
        await this.sleep(delay, signal);
        checkAbort(signal);
      }
    }
  }
  // The login flow may perform several reads. Let its caller cancel the entire
  // operation rather than waiting for every endpoint's retry budget in turn.
  async identity({signal} = {}) { return normalizeIdentity(await this._request(PATHS.identity, {}, signal)); }
  async groups({signal} = {}) { return normalizeGroups(await this._request(PATHS.groups, {special_source: 3}, signal)); }

  async messageDetail(groupId, messageId, {signal} = {}) {
    groupId = identifier(groupId); messageId = identifier(messageId);
    const data = await this._request(PATHS.message, {id: groupId, mid: messageId}, signal);
    if (!object(data.message) || identifier(data.message.gid) !== groupId) throw invalid('单条消息所属群无法确认，本批未保存。');
    const message = normalizeMessages({messages: [data.message]}, groupId)[0];
    if (message.id !== messageId) throw invalid('返回消息标识不匹配，本批未保存。');
    return message;
  }

  async syncGroup(groupId, {maxPages = 20, onPage, before = null, stopAtId = null, pageDelayMs = 1000, signal} = {}) {
    groupId = identifier(groupId);
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new WeiboError('INVALID_ARGUMENT', '每次同步页数须为 1 至 100。');
    if (onPage !== undefined && typeof onPage !== 'function') throw new TypeError('onPage must be a function.');
    if (!Number.isSafeInteger(pageDelayMs) || pageDelayMs < 500 || pageDelayMs > 5000) throw new TypeError('Invalid page delay.');
    let cursor = before === null || before === undefined ? null : identifier(before, true);
    stopAtId = stopAtId === null || stopAtId === undefined ? null : identifier(stopAtId);
    const seen = new Map();
    let pages = 0, exhausted = false, reachedStop = false, reason = '已达到本次页数上限，可继续同步更早消息。';
    const coverage = () => {
      let oldest = null, newest = null;
      for (const message of seen.values()) {
        if (oldest === null || message.time < oldest) oldest = message.time;
        if (newest === null || message.time > newest) newest = message.time;
      }
      return {oldest, newest,
        complete: exhausted && before === null && (stopAtId === null || reachedStop),
        note: reason + ' 仅覆盖本次接口返回的记录；撤回、服务端不可见历史及未返回的媒体或分享内容无法保证完整。' +
          (before !== null ? ' 本次从历史游标开始，不能据此确认最新消息覆盖。' : '')};
    };
    while (pages < maxPages) {
      checkAbort(signal);
      const data = await this._request(PATHS.messages, {convert_emoji: 1, query_sender: 1, count: 20, id: groupId, max_mid: cursor}, signal);
      const pageMessages = normalizeMessages(data, groupId);
      const flag = data.has_more ?? data.hasMore;
      if (!pageMessages.length && (flag === true || flag === 1 || flag === '1')) {
        throw invalid('微博返回空页但标记仍有历史，完整性无法确认，请稍后重试。');
      }
      // A response above max_mid means the cursor was ignored. Reject the page
      // rather than loop forever or incorrectly label a gap as complete.
      if (cursor !== null && pageMessages.some(message => BigInt(message.id) > BigInt(cursor))) {
        throw new WeiboError('CURSOR_IGNORED', '微博历史游标未生效，已停止；已保存页面仍保留，请稍后重试。');
      }
      pages++;
      const uniquePage = new Map(pageMessages.map(message => [message.id, message]));
      const fresh = [...uniquePage.values()].filter(message => !seen.has(message.id));
      for (const message of uniquePage.values()) seen.set(message.id, message);
      if (pageMessages.length) {
        const minimum = [...uniquePage.keys()].sort(compareIds)[0];
        cursor = previousId(minimum);
        if (stopAtId !== null && BigInt(minimum) <= BigInt(stopAtId)) {
          reachedStop = true;
          reason = '已读取到本地最近同步位置，增量区间已衔接。';
        }
      }
      const explicitEnd = flag === false || flag === 0 || flag === '0';
      if (!pageMessages.length || explicitEnd || cursor === '0') {
        exhausted = true;
        reason = '已到达微博本次可返回历史的起点。';
      }
      // Keep the last safe cursor even when the server reports an early end.
      // An incremental interval is unresolved until its original baseline is
      // reached; a transient empty page must not erase restart information.
      const unresolved = exhausted && stopAtId !== null && !reachedStop;
      if (onPage) await onPage({messages: fresh.sort((a, b) => a.time - b.time || compareIds(a.id, b.id)), page: pages,
        nextCursor: exhausted ? null : cursor, resumeCursor: cursor, exhausted, unresolved, reachedStop, coverage: coverage()});
      checkAbort(signal);
      if (exhausted || reachedStop) break;
      if (pages < maxPages) await this.sleep(pageDelayMs, signal);
    }
    return {messages: [...seen.values()].sort((a, b) => a.time - b.time || compareIds(a.id, b.id)), coverage: coverage(),
      nextCursor: exhausted ? null : cursor, resumeCursor: cursor, exhausted,
      unresolved: exhausted && stopAtId !== null && !reachedStop, reachedStop, pages};
  }
}

module.exports = {WeiboClient, WeiboError, parsePrecisionJson, identifier, previousId, normalizeIdentity, normalizeGroups,
  normalizeMessages, normalizeImages, normalizeSharedPost, normalizeMessageReferences, postText, postIncomplete, isPublishedPostNotification, messageTime, retryDelay, ORIGIN, PATHS};
