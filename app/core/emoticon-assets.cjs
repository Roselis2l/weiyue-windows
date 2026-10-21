'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { types } = require('node:util');

const MAX_BYTES = 128 * 1024;
const MAX_EDGE = 256;
const MAX_GIF_FRAMES = 256;
const MAX_CACHE_BYTES = 1024 * 1024;
const SOURCE = /^app:\/\/local\/emoticons\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,127}\.(?:png|gif))$/;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])\.(?:png|gif)$/i;
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const bytePrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(bytePrototype, 'byteLength').get;
const byteOffset = Object.getOwnPropertyDescriptor(bytePrototype, 'byteOffset').get;
const byteBuffer = Object.getOwnPropertyDescriptor(bytePrototype, 'buffer').get;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function exactBytes(value) {
  if (!types.isUint8Array(value)) return null;
  const length = Reflect.apply(byteLength, value, []);
  if (length < 13 || length > MAX_BYTES) return null;
  return Buffer.from(new Uint8Array(Reflect.apply(byteBuffer, value, []),
    Reflect.apply(byteOffset, value, []), length));
}
function validPng(bytes) {
  if (!bytes || !bytes.subarray(0, 8).equals(SIGNATURE)) return false;
  let offset = 8, header = false, dataBytes = 0;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) return false;
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) return false;
    const end = offset + 12 + length;
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) return false;
    if (!header) {
      if (type !== 'IHDR' || length !== 13) return false;
      const width = bytes.readUInt32BE(offset + 8), height = bytes.readUInt32BE(offset + 12);
      const depth = bytes[offset + 16], color = bytes[offset + 17];
      const validDepth = color === 0 ? [1, 2, 4, 8, 16] : color === 3 ? [1, 2, 4, 8] :
        [2, 4, 6].includes(color) ? [8, 16] : [];
      if (width < 1 || height < 1 || width > MAX_EDGE || height > MAX_EDGE ||
          !validDepth.includes(depth) || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 ||
          bytes[offset + 20] > 1) return false;
      header = true;
    } else if (type === 'IHDR') return false;
    if (type === 'IDAT') dataBytes += length;
    if (type === 'IEND') return length === 0 && dataBytes > 0 && end === bytes.length;
    offset = end;
  }
  return false;
}
function validGif(bytes) {
  if (!bytes || !['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)) || bytes.length < 13) return false;
  const width = bytes.readUInt16LE(6), height = bytes.readUInt16LE(8);
  if (!width || !height || width > MAX_EDGE || height > MAX_EDGE) return false;
  const packed = bytes[10];
  let offset = 13 + (packed & 128 ? 3 * 2 ** ((packed & 7) + 1) : 0), frames = 0;
  if (offset > bytes.length) return false;
  function skipSubBlocks() {
    let dataBytes = 0;
    while (offset < bytes.length) {
      const count = bytes[offset++];
      if (count === 0) return dataBytes;
      if (offset + count > bytes.length) return -1;
      offset += count; dataBytes += count;
    }
    return -1;
  }
  while (offset < bytes.length) {
    const marker = bytes[offset++];
    if (marker === 0x3b) return frames > 0 && offset === bytes.length;
    if (marker === 0x21) {
      if (offset >= bytes.length) return false;
      const label = bytes[offset++];
      // Only defined GIF metadata/control extensions are accepted. None are
      // interpreted as application code; image decoding remains Chromium's job.
      if (![0xf9, 0xfe, 0xff, 0x01].includes(label)) return false;
      if (label === 0xf9) {
        if (offset + 6 > bytes.length || bytes[offset] !== 4 || bytes[offset + 5] !== 0) return false;
        offset += 6;
      } else if (skipSubBlocks() < 0) return false;
      continue;
    }
    if (marker !== 0x2c || offset + 9 > bytes.length || ++frames > MAX_GIF_FRAMES) return false;
    const left = bytes.readUInt16LE(offset), top = bytes.readUInt16LE(offset + 2);
    const frameWidth = bytes.readUInt16LE(offset + 4), frameHeight = bytes.readUInt16LE(offset + 6);
    if (!frameWidth || !frameHeight || left + frameWidth > width || top + frameHeight > height) return false;
    const framePacked = bytes[offset + 8]; offset += 9;
    if (framePacked & 128) offset += 3 * 2 ** ((framePacked & 7) + 1);
    if (offset >= bytes.length || bytes[offset] < 2 || bytes[offset] > 8) return false;
    offset++;
    if (skipSubBlocks() <= 0) return false;
  }
  return false;
}
function notFound() {
  return new Response('Not found', { status: 404, headers: {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  } });
}

function createEmoticonAssets({ root, manifest, readFile = fs.readFileSync } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || typeof readFile !== 'function')
    throw new Error('表情资源配置无效。');
  const assets = new Map(), rejected = new Set(), cache = new Map();
  let cacheBytes = 0;
  if (manifest && typeof manifest === 'object' && !Array.isArray(manifest))
    for (const descriptor of Object.values(manifest)) {
      if (!descriptor || typeof descriptor !== 'object') continue;
      const src = descriptor.src, match = typeof src === 'string' ? SOURCE.exec(src) : null;
      if (!match || WINDOWS_DEVICE.test(match[1]) || rejected.has(src)) continue;
      const sha256 = typeof descriptor.sha256 === 'string' && /^[a-fA-F0-9]{64}$/.test(descriptor.sha256)
        ? descriptor.sha256.toLowerCase() : null;
      if (!sha256 || assets.has(src) && assets.get(src).sha256 !== sha256) {
        assets.delete(src); rejected.add(src); continue;
      }
      assets.set(src, { filename: path.join(path.resolve(root), 'emoticons', match[1]), sha256,
        format: match[1].endsWith('.gif') ? 'gif' : 'png' });
    }

  function requestedAsset(request, url) {
    if (request?.method !== 'GET') return null;
    const given = url instanceof URL ? url.href : typeof url === 'string' ? url : undefined;
    const src = typeof request.url === 'string' ? request.url : given;
    if (typeof src !== 'string' || !SOURCE.test(src) || given !== undefined && given !== src) return null;
    return assets.has(src) ? src : null;
  }
  function readAsset(src) {
    if (cache.has(src)) {
      const bytes = cache.get(src); cache.delete(src); cache.set(src, bytes);
      return bytes;
    }
    let bytes = null;
    try {
      const descriptor = assets.get(src);
      const candidate = exactBytes(readFile(descriptor.filename));
      const valid = descriptor.format === 'gif' ? validGif(candidate) : validPng(candidate);
      if (valid && createHash('sha256').update(candidate).digest('hex') === descriptor.sha256)
        bytes = candidate;
    } catch { /* Invalid/missing local assets expose no paths or request data. */ }
    const needed = bytes?.length || 0;
    while (cacheBytes + needed > MAX_CACHE_BYTES && cache.size) {
      const oldest = cache.keys().next().value;
      cacheBytes -= cache.get(oldest)?.length || 0; cache.delete(oldest);
    }
    cache.set(src, bytes); cacheBytes += needed;
    return bytes;
  }
  return Object.freeze({
    serve(request, url) {
      try {
        const src = requestedAsset(request, url);
        if (!src) return notFound();
        const bytes = readAsset(src);
        if (!bytes) return notFound();
        return new Response(Buffer.from(bytes), { status: 200, headers: {
          'Content-Type': assets.get(src).format === 'gif' ? 'image/gif' : 'image/png',
          'Cache-Control': 'public, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
        } });
      } catch { return notFound(); }
    },
  });
}

module.exports = { createEmoticonAssets, MAX_BYTES, MAX_EDGE, MAX_GIF_FRAMES, MAX_CACHE_BYTES };
