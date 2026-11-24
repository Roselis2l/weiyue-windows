'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { isHeic } = require('../app/core/image-format.cjs');
const { fetchImage } = require('../app/core/media.cjs');

// Synthetic container headers only, not private files or valid image fixtures.
const URL = 'https://wx1.sinaimg.cn/large/synthetic.jpg';
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const JPEG = Buffer.from([255, 216, 255, 224, 0, 2, 255, 217]);
function box(type, payload = Buffer.alloc(0)) {
  const result = Buffer.alloc(8 + payload.length);
  result.writeUInt32BE(result.length); result.write(type, 4, 'ascii'); payload.copy(result, 8);
  return result;
}
function ftyp(major = 'heic', compatible = ['mif1']) {
  return box('ftyp', Buffer.concat([Buffer.from(major), Buffer.alloc(4), Buffer.from(compatible.join(''))]));
}
const response = (bytes, mime) => new Response(bytes, { headers: { 'content-type': mime } });
const run = (bytes, mime = 'image/jpeg', options = {}) =>
  fetchImage({ url: URL, fetch: async () => response(bytes, mime), ...options });
const code = expected => error => { assert.equal(error.code, expected); return true; };

test('HEIC requires an exact HEVC brand in the bounded ftyp major or compatible fields', () => {
  for (const brand of ['heic', 'heix', 'hevc', 'hevx']) {
    assert.equal(isHeic(ftyp(brand)), true);
    assert.equal(isHeic(ftyp('mif1', [brand])), true);
  }
  for (const bytes of [
    ftyp('mif1'), ftyp('msf1', ['mif1']), ftyp('avif'), ftyp('avis'), ftyp('heic', ['avif']),
    ftyp('avif', ['heix']), ftyp('heic', ['    ']), ftyp('heic', ['\0\0\0\0']),
    Buffer.concat([box('mdat', Buffer.from('heic')), ftyp()]),
  ]) assert.equal(isHeic(bytes), false);
  const minor = ftyp('mif1'); minor.write('heic', 12);
  assert.equal(isHeic(minor), false, 'minor version is not a brand field');
  assert.equal(isHeic(Buffer.concat([ftyp('mif1'), ftyp()])), false, 'later ftyp cannot upgrade the first');
});

test('only bounded padding boxes may precede ftyp, including correctly bounded extended sizes', () => {
  const extended = Buffer.alloc(32);
  extended.writeUInt32BE(1); extended.write('ftyp', 4); extended.writeBigUInt64BE(32n, 8);
  extended.write('heic', 16); extended.write('mif1', 24); extended.write('heix', 28);
  assert.equal(isHeic(extended), true);
  assert.equal(isHeic(Buffer.concat([box('free'), box('skip'), box('wide'), ftyp()])), true);
  const toEnd = ftyp(); toEnd.writeUInt32BE(0);
  assert.equal(isHeic(toEnd), true);
  for (const size of [0n, 8n, 33n, 9007199254740993n, 0xffffffffffffffffn]) {
    const bad = Buffer.from(extended); bad.writeBigUInt64BE(size, 8);
    assert.equal(isHeic(bad), false);
  }
  const hugeFtyp = box('ftyp', Buffer.concat([Buffer.from('heic'), Buffer.alloc(4), Buffer.from('mif1'.repeat(1024))]));
  assert.equal(isHeic(hugeFtyp), false);
  assert.equal(isHeic(Buffer.concat([box('free', Buffer.alloc(64 * 1024)), ftyp()])), false);
  assert.equal(isHeic(Buffer.concat([...Array.from({length: 31}, () => box('free')), ftyp()])), true);
  assert.equal(isHeic(Buffer.concat([...Array.from({length: 32}, () => box('free')), ftyp()])), false);
});

test('truncated, unaligned and oversized BMFF boxes are rejected without scanning payload', () => {
  const valid = ftyp();
  for (let length = 0; length < valid.length; length++) assert.equal(isHeic(valid.subarray(0, length)), false);
  for (const size of [2, 8, 15, valid.length + 1, 0xffffffff]) {
    const bytes = Buffer.from(valid); bytes.writeUInt32BE(size);
    assert.equal(isHeic(bytes), false);
  }
  assert.equal(isHeic(box('ftyp', Buffer.concat([Buffer.from('heic'), Buffer.alloc(5)]))), false);
  const zeroPadding = box('free'); zeroPadding.writeUInt32BE(0);
  assert.equal(isHeic(Buffer.concat([zeroPadding, valid])), false);
});

test('container inspection honors byte offset, cross-realm identity and intrinsic view properties', () => {
  const valid = ftyp(), outside = Buffer.concat([Buffer.from('private'), valid, Buffer.from('private')]);
  const view = outside.subarray(7, 7 + valid.length);
  assert.equal(isHeic(view), true);
  assert.equal(isHeic(vm.runInNewContext('new Uint8Array(bytes)', { bytes: [...valid] })), true);
  const shadowed = Uint8Array.from(valid);
  for (const key of ['byteLength', 'byteOffset', 'buffer', 'length']) {
    Object.defineProperty(shadowed, key, { get() { throw new Error('private'); } });
  }
  assert.equal(isHeic(shadowed), true);
  for (const bad of [null, {}, [], valid.buffer, new DataView(valid.buffer), new Uint16Array([1, 2]),
    { [Symbol.toStringTag]: 'Uint8Array' }, new Proxy(Uint8Array.from(valid), {}), Buffer.alloc(20 * 1024 * 1024 + 1)]) {
    assert.equal(isHeic(bad), false);
  }
  assert.equal(isHeic(outside), false);
});

test('HEIC opt-in preserves the original bytes and canonicalizes only supported declared MIME', async () => {
  const heic = ftyp();
  for (const mime of ['image/jpeg', 'image/heic', 'image/heif', ' IMAGE/JPEG ; charset=binary']) {
    const value = await run(heic, mime, { allowHeif: true });
    assert.equal(value.mime, 'image/heic'); assert.deepEqual(value.bytes, heic);
    assert.deepEqual(Object.keys(value).sort(), ['bytes', 'mime']);
  }
  for (const mime of ['image/jpeg', 'image/heic', 'image/heif']) {
    await assert.rejects(run(heic, mime), code('MEDIA_TYPE'));
    await assert.rejects(run(heic, mime, { allowHeif: false }), code('MEDIA_TYPE'));
  }
});

test('HEIC opt-in never relaxes old raster MIME consistency or accepts arbitrary non-images', async () => {
  for (const [bytes, mime] of [
    [PNG, 'image/jpeg'], [JPEG, 'image/png'], [PNG, 'image/heic'], [JPEG, 'image/heif'],
    [ftyp(), 'application/octet-stream'], [ftyp(), 'image/png'], [ftyp(), 'text/html'], [ftyp(), ''],
    [ftyp('avif'), 'image/jpeg'], [ftyp('mif1'), 'image/jpeg'], [Buffer.from('<html>private</html>'), 'image/jpeg'],
  ]) await assert.rejects(run(bytes, mime, { allowHeif: true }), code('MEDIA_TYPE'));
  for (const [bytes, mime] of [[JPEG, 'image/jpeg'], [PNG, 'image/png']]) {
    assert.deepEqual(await run(bytes, mime, { allowHeif: true }), { bytes, mime });
  }
  for (const allowHeif of ['true', 1, null, {}]) {
    await assert.rejects(run(ftyp(), 'image/jpeg', { allowHeif }), code('MEDIA_CONFIG'));
  }
});

test('HEIC streamed size, HTTP status and cancellation retain the same rejection boundaries', async () => {
  const bytes = ftyp(), opts = { allowHeif: true };
  await assert.rejects(run(bytes, 'image/jpeg', { ...opts, maxBytes: bytes.length - 1 }), code('MEDIA_TOO_LARGE'));
  await assert.rejects(fetchImage({ url: URL, ...opts, fetch: async () => new Response(bytes, {
    headers: {'content-type': 'image/jpeg', 'content-length': '9999999999999999'},
  }) }), code('MEDIA_TOO_LARGE'));
  for (const status of [401, 403, 429]) {
    await assert.rejects(fetchImage({ url: URL, ...opts, fetch: async () => new Response(bytes, {
      status, headers: {'content-type': 'image/jpeg'},
    }) }), code('MEDIA_HTTP'));
  }
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  await assert.rejects(fetchImage({ url: URL, ...opts, signal: controller.signal, fetch: async () => { calls++; } }), code('MEDIA_ABORT'));
  assert.equal(calls, 0);
});

test('streamed byte limits and copying ignore shadowed typed-array fields', async () => {
  const bytes = Uint8Array.from(ftyp());
  for (const key of ['byteLength', 'byteOffset', 'buffer', 'length']) {
    Object.defineProperty(bytes, key, {get() { throw new Error('private'); }});
  }
  const makeResponse = () => ({status: 200, headers: new Headers({'content-type': 'image/jpeg'}),
    body: new ReadableStream({start(c) {c.enqueue(bytes); c.close();}})});
  const value = await fetchImage({ url: URL, allowHeif: true, fetch: async () => makeResponse() });
  assert.deepEqual(value.bytes, ftyp()); assert.equal(value.mime, 'image/heic');
  await assert.rejects(fetchImage({url: URL, allowHeif: true, maxBytes: ftyp().length - 1, fetch: async () => makeResponse()}), code('MEDIA_TOO_LARGE'));
});
