'use strict';

const {tokenize} = require('../renderer/linkify.js');

const MAX_STANDALONE_EMOTICONS = 16;
// Confirmed by the user in the official, normally authenticated website on
// 2026-11-24: the short link opens this standalone emoticon page, whose only
// displayed media is this animated 256 x 256 GIF. These are observed addresses,
// not a rule for constructing CDN URLs from arbitrary compic IDs. The table is
// intentionally finite; new entries need independent official-page evidence.
const CONFIRMED = Object.freeze({
  sourceUrl: 'https://t.cn/RgFE2Px',
  // The stored real sample uses HTTP. A cookie-free header-only check on
  // 2026-11-24 returned 302 to the exact confirmed HTTPS page below.
  httpSourceUrl: 'http://t.cn/RgFE2Px',
  pageUrl: 'https://photo.weibo.com/h5/comment/compic_id/1022:2305976005EGbicly1ftcu7q36u3g30740740u4?emoticon=1',
  url: 'https://wx2.sinaimg.cn/bmiddle/005EGbicly1ftcu7q36u3g30740740u4.gif',
  label: '动态表情',
  width: 256,
  height: 256,
});

function resolveStandaloneEmoticonUrl(value) {
  // Match the original token, not URL.href: normalization would hide ports,
  // dot segments or other unverified spellings. No page requests or redirects
  // are performed here, and even direct GIF links retain ordinary link behavior.
  if (typeof value !== 'string' ||
      (value !== CONFIRMED.sourceUrl && value !== CONFIRMED.httpSourceUrl && value !== CONFIRMED.pageUrl)) return null;
  return {sourceUrl: value, pageUrl: CONFIRMED.pageUrl,
    url: CONFIRMED.url, originalUrl: CONFIRMED.url,
    label: CONFIRMED.label, width: CONFIRMED.width, height: CONFIRMED.height};
}

function standaloneEmoticonsForMessage(message) {
  // Input must already be the current edition's visible projection. Never read
  // archived originals, share metadata or saved images, and never alter text or
  // message.images. Thus old saved messages work without a write migration and
  // these decorative GIFs do not enter the AI image/attachment collection.
  if (!message || typeof message !== 'object' || Array.isArray(message) ||
      typeof message.text !== 'string' || message.localDeletion || message.contentUnavailable ||
      (message.recall && message.recall.originalAvailable !== true)) return [];
  const result = [], seen = new Set();
  for (const part of tokenize(message.text)) {
    if (part.type !== 'link') continue;
    const descriptor = resolveStandaloneEmoticonUrl(part.text);
    if (!descriptor || seen.has(descriptor.sourceUrl)) continue;
    seen.add(descriptor.sourceUrl); result.push(descriptor);
    if (result.length >= MAX_STANDALONE_EMOTICONS) break;
  }
  return result;
}

module.exports = {resolveStandaloneEmoticonUrl, standaloneEmoticonsForMessage, MAX_STANDALONE_EMOTICONS};
