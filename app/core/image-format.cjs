'use strict';

const { types: { isUint8Array } } = require('node:util');
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_BOXES = 32, MAX_PREFIX = 64 * 1024, MAX_FTYP = 4096;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const lengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get;
const offsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset').get;
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get;

function byteView(value) {
  if (!isUint8Array(value)) return null;
  try {
    const length = Reflect.apply(lengthGetter, value, []);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_IMAGE_BYTES) return null;
    return new Uint8Array(Reflect.apply(bufferGetter, value, []), Reflect.apply(offsetGetter, value, []), length);
  } catch { return null; }
}
function ascii(bytes, at, text) {
  if (at < 0 || at + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i++) if (bytes[at + i] !== text.charCodeAt(i)) return false;
  return true;
}
function uint32(bytes, at) {
  return bytes[at] * 0x1000000 + bytes[at + 1] * 0x10000 + bytes[at + 2] * 0x100 + bytes[at + 3];
}
function plausibleBrand(bytes, at) {
  let nonSpace = false;
  for (let i = 0; i < 4; i++) {
    const value = bytes[at + i];
    if (value < 0x20 || value > 0x7e) return false;
    if (value !== 0x20) nonSpace = true;
  }
  return nonSpace;
}

// Recognize HEVC-specific HEIF brands only. Generic mif1/msf1 do not establish
// an image codec. This is a bounded container signature check, not a decoder.
// An isolated decoder must still validate the complete image before display.
function isHeic(input) {
  const bytes = byteView(input);
  if (!bytes) return false;
  let at = 0;
  for (let count = 0; count < MAX_BOXES; count++) {
    if (at + 8 > bytes.length || at + 8 > MAX_PREFIX) return false;
    const remaining = bytes.length - at, shortSize = uint32(bytes, at);
    let header = 8, size = shortSize;
    if (shortSize === 1) {
      header = 16;
      if (remaining < header || at + header > MAX_PREFIX) return false;
      const longSize = BigInt(uint32(bytes, at + 8)) * 0x100000000n + BigInt(uint32(bytes, at + 12));
      if (longSize < BigInt(header) || longSize > BigInt(remaining)) return false;
      size = Number(longSize);
    } else if (shortSize === 0) size = remaining;
    if (size < header || size > remaining) return false;
    const end = at + size;
    if (ascii(bytes, at + 4, 'ftyp')) {
      const payload = at + header, payloadLength = size - header;
      if (size > MAX_FTYP || end > MAX_PREFIX || payloadLength < 8 || (payloadLength - 8) % 4 !== 0) return false;
      let heic = false, avif = false;
      for (const brandAt of [payload, ...Array.from({ length: (payloadLength - 8) / 4 }, (_, i) => payload + 8 + i * 4)]) {
        if (!plausibleBrand(bytes, brandAt)) return false;
        heic ||= ['heic', 'heix', 'hevc', 'hevx'].some(brand => ascii(bytes, brandAt, brand));
        avif ||= ['avif', 'avis'].some(brand => ascii(bytes, brandAt, brand));
      }
      return heic && !avif;
    }
    // Padding can precede ftyp, but never search arbitrary payload for a brand.
    if (!['free', 'skip', 'wide'].some(type => ascii(bytes, at + 4, type)) || shortSize === 0 ||
        end + 8 > MAX_PREFIX) return false;
    at = end;
  }
  return false;
}

module.exports = { isHeic, MAX_IMAGE_BYTES };
