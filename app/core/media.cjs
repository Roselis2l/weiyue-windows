'use strict';

const { types: { isUint8Array } } = require('node:util');
const { isHeic } = require('./image-format.cjs');
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get;
const byteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset').get;
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get;

const MAX_URL_LENGTH = 4096;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
// Image hosts are cross-origin to the official chat page. Chromium's default
// strict-origin-when-cross-origin policy accepts only the origin here; supplying
// /chat as a raw Referer makes URLRequest reject the request before transport.
// Keep the default policy and disclose no page path. Same-origin chat API calls
// continue to use their existing full official Referer in weibo.cjs.
const OFFICIAL_REFERER = 'https://api.weibo.com/';
const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
// The official image endpoint can declare image/jpeg for HEIC bytes. Opt in
// only at call sites that provide a bounded local HEIC decoder; avatar and AI
// callers retain the existing four-format behavior by default.
const HEIC_DECLARED_MIMES = new Set(['image/jpeg', 'image/heic', 'image/heif']);
const VALIDATION_STAGES = new Set(['mime', 'body', 'chunk', 'magic']);
const MESSAGES = Object.freeze({
  MEDIA_URL: '图片地址不在允许范围。',
  MEDIA_CONFIG: '图片加载设置无效。',
  MEDIA_FETCH: '图片加载失败，请稍后重试。',
  MEDIA_TIMEOUT: '图片加载超时。',
  MEDIA_ABORT: '图片加载已取消。',
  MEDIA_TOO_LARGE: '图片超过大小限制。',
  MEDIA_TYPE: '图片内容或格式不受支持。',
  MEDIA_REDIRECT: '图片跳转不被允许。',
  MEDIA_HTTP: '图片服务暂不可用。',
});

class MediaError extends Error {
  constructor(code, details) {
    super(MESSAGES[code]); this.name = 'MediaError'; this.code = code;
    if (code === 'MEDIA_TYPE' && VALIDATION_STAGES.has(details?.validationStage)) {
      // Fixed diagnostic vocabulary only: never attach response text, a URL,
      // arbitrary header values, raw bytes, or upstream error details.
      this.validation = Object.freeze({
        validationStage: details.validationStage,
        declaredMime: ALLOWED_MIMES.has(details.declaredMime) ? details.declaredMime : 'other',
        detectedMime: ALLOWED_MIMES.has(details.detectedMime) ? details.detectedMime : 'unknown',
        byteLength: Number.isSafeInteger(details.byteLength) && details.byteLength >= 0 ? details.byteLength : 0,
      });
    }
  }
}
function fail(code, details) { throw new MediaError(code, details); }

function parseUrl(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_URL_LENGTH || /[\s\u0000-\u001f\u007f\\]/.test(value)) return null;
  // Inspect the authority before URL normalization, which otherwise removes :443.
  const match = value.match(/^https?:\/\/([^/?#]+)/i);
  if (!match || !/^[a-z0-9.-]+$/i.test(match[1])) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.port || !/^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/.test(url.hostname)) return null;
    if (url.hostname.split('.').some(label => !label || label.startsWith('-') || label.endsWith('-'))) return null;
    return url;
  } catch { return null; }
}
function domain(host, root) { return host === root || host.endsWith('.' + root); }

function safeImageUrl(value) {
  try {
    const url = parseUrl(value);
    if (!url) return null;
    if (domain(url.hostname, 'sinaimg.cn')) {
      url.protocol = 'https:';
      url.hash = '';
      return url.href;
    }
    if (url.protocol !== 'https:' || url.hostname !== 'upload.api.weibo.com' || url.pathname !== '/2/mss/msget') return null;
    const fid = url.searchParams.getAll('fid');
    const source = url.searchParams.getAll('source');
    const imageType = url.searchParams.getAll('imageType');
    if (fid.length !== 1 || !/^\d{1,128}$/.test(fid[0]) || source.length !== 1 || source[0] !== '209678993' || imageType.length !== 1 || imageType[0] !== 'origin') return null;
    url.search = new URLSearchParams({ fid: fid[0], source: '209678993', imageType: 'origin' }).toString();
    url.hash = '';
    return url.href;
  } catch { return null; }
}

function safePostUrl(value) {
  const url = parseUrl(value);
  if (!url || url.protocol !== 'https:' || !['weibo.com', 'weibo.cn'].some(root => domain(url.hostname, root))) return null;
  return url.href;
}

function normalizeImage(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const originalUrl = safeImageUrl(value.originalUrl);
    const thumbnailUrl = safeImageUrl(value.thumbnailUrl);
    const url = safeImageUrl(value.url) || originalUrl || thumbnailUrl;
    if (!url) return null;
    const image = { url };
    if (originalUrl) image.originalUrl = originalUrl;
    if (thumbnailUrl) image.thumbnailUrl = thumbnailUrl;
    for (const dimension of ['width', 'height']) {
      if (Number.isSafeInteger(value[dimension]) && value[dimension] > 0 && value[dimension] <= 32768) image[dimension] = value[dimension];
    }
    return image;
  } catch { return null; }
}

function detectedMime(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP' && bytes.readUInt32LE(4) >= 4) return 'image/webp';
  return null;
}

function cancelBody(body) {
  try { if (body?.cancel) Promise.resolve(body.cancel()).catch(() => {}); } catch { /* best effort only */ }
}

async function fetchImage({ url, fetch: request, signal, timeoutMs = 15000, maxBytes = DEFAULT_MAX_BYTES, allowHeif = false } = {}) {
  let currentUrl = safeImageUrl(url);
  if (!currentUrl) fail('MEDIA_URL');
  if (typeof request !== 'function' || typeof allowHeif !== 'boolean' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_MAX_BYTES) fail('MEDIA_CONFIG');
  if (signal && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) fail('MEDIA_CONFIG');
  if (signal?.aborted) fail('MEDIA_ABORT');

  const controller = new AbortController();
  let interruptError;
  let rejectInterrupted;
  const interrupted = new Promise((resolve, reject) => { rejectInterrupted = reject; });
  // Avoid an unhandled rejection if an interrupt arrives between awaited phases.
  interrupted.catch(() => {});
  function interrupt(code) {
    if (interruptError) return;
    interruptError = new MediaError(code);
    controller.abort(interruptError);
    rejectInterrupted(interruptError);
  }
  const onAbort = () => interrupt('MEDIA_ABORT');
  signal?.addEventListener('abort', onAbort, { once: true });
  // Cover an abort occurring between the initial check and listener registration.
  if (signal?.aborted) onAbort();
  const timer = setTimeout(() => interrupt('MEDIA_TIMEOUT'), timeoutMs);
  const withinBudget = operation => {
    if (interruptError) return Promise.reject(interruptError);
    return Promise.race([Promise.resolve().then(operation), interrupted]);
  };

  let reader;
  let response;
  try {
    let redirects = 0;
    for (;;) {
      response = await withinBudget(() => request(currentUrl, {
        method: 'GET',
        headers: { Referer: OFFICIAL_REFERER, Accept: 'image/jpeg, image/png, image/gif, image/webp' },
        credentials: 'include', redirect: 'manual', signal: controller.signal,
      }));
      if (!response || typeof response.status !== 'number' || typeof response.headers?.get !== 'function') fail('MEDIA_FETCH');
      if (response.redirected) fail('MEDIA_REDIRECT');
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirects >= 3) fail('MEDIA_REDIRECT');
        const location = response.headers.get('location');
        if (typeof location !== 'string' || !location || location.length > MAX_URL_LENGTH || /[\s\u0000-\u001f\u007f\\]/.test(location)) fail('MEDIA_REDIRECT');
        let next;
        try { next = safeImageUrl(new URL(location, currentUrl).href); } catch { next = null; }
        // Also inspect absolute URLs before URL() can erase their explicit port.
        if (/^[a-z][a-z0-9+.-]*:/i.test(location)) next = safeImageUrl(location);
        else if (location.startsWith('//')) next = safeImageUrl('https:' + location);
        if (!next) fail('MEDIA_REDIRECT');
        cancelBody(response.body);
        response = null;
        currentUrl = next;
        redirects++;
        continue;
      }
      if (response.status < 200 || response.status >= 300) fail('MEDIA_HTTP');
      break;
    }

    const mime = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_MIMES.has(mime) && !(allowHeif && HEIC_DECLARED_MIMES.has(mime))) fail('MEDIA_TYPE', { validationStage: 'mime', declaredMime: mime, byteLength: 0 });
    const length = response.headers.get('content-length');
    if (length !== null && /^\d+$/.test(length) && BigInt(length) > BigInt(maxBytes)) fail('MEDIA_TOO_LARGE');
    if (!response.body || typeof response.body.getReader !== 'function') fail('MEDIA_TYPE', {
      validationStage: 'body', declaredMime: mime, byteLength: 0,
    });
    reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const result = await withinBudget(() => reader.read());
      if (result.done) break;
      const value = result.value;
      // Electron and Node may create byte arrays in different JS realms.
      // This accepts actual Uint8Array/Buffer values without accepting other
      // views, strings, or objects that merely spoof their prototype/tag.
      if (!isUint8Array(value)) fail('MEDIA_TYPE', { validationStage: 'chunk', declaredMime: mime, byteLength: size });
      let view;
      try {
        view = new Uint8Array(Reflect.apply(bufferGetter, value, []),
          Reflect.apply(byteOffsetGetter, value, []), Reflect.apply(byteLengthGetter, value, []));
      } catch { fail('MEDIA_TYPE', { validationStage: 'chunk', declaredMime: mime, byteLength: size }); }
      size += view.byteLength;
      if (size > maxBytes) fail('MEDIA_TOO_LARGE');
      chunks.push(Buffer.from(view));
    }
    const bytes = Buffer.concat(chunks, size);
    const actualMime = detectedMime(bytes);
    if (allowHeif && HEIC_DECLARED_MIMES.has(mime) && !actualMime && isHeic(bytes)) {
      if (interruptError) throw interruptError;
      return { bytes, mime: 'image/heic' };
    }
    if (actualMime !== mime) fail('MEDIA_TYPE', {
      validationStage: 'magic', declaredMime: mime, detectedMime: actualMime, byteLength: size,
    });
    if (interruptError) throw interruptError;
    return { bytes, mime };
  } catch (error) {
    if (!controller.signal.aborted) controller.abort();
    try { if (reader) Promise.resolve(reader.cancel()).catch(() => {}); else cancelBody(response?.body); } catch { /* best effort only */ }
    if (interruptError) throw interruptError;
    if (error instanceof MediaError) throw error;
    throw new MediaError('MEDIA_FETCH');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    try { reader?.releaseLock(); } catch { /* a canceled mock may retain a pending read */ }
  }
}

module.exports = { safeImageUrl, safePostUrl, normalizeImage, fetchImage };
