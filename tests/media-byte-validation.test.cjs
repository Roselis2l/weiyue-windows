'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {Readable} = require('node:stream');
const {fetchImage} = require('../app/core/media.cjs');

// All bytes are synthetic and every request is injected. No network or files.
const URL = 'https://wx1.sinaimg.cn/large/synthetic-private.jpg?token=fixture-secret';
const JPEG = Buffer.from([255, 216, 255, 224, 0, 2, 255, 217]);
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const SECRET = 'fixture-secret-private-response';
const foreignBytes = bytes => vm.runInNewContext('new Uint8Array(bytes)', {bytes: [...bytes]});
const response = (body, mime = 'image/jpeg', extraHeaders = {}) =>
  new Response(body, {status: 200, headers: {'content-type': mime, ...extraHeaders}});
const stream = chunks => new ReadableStream({start(controller) {
  for (const chunk of chunks) controller.enqueue(chunk);
  controller.close();
}});
const run = (value, options = {}) => fetchImage({url: URL, fetch: async () => value, ...options});

function validation(stage, declaredMime, detectedMime = 'unknown', byteLength = 0) {
  return error => {
    assert.equal(error.name, 'MediaError');
    assert.equal(error.code, 'MEDIA_TYPE');
    assert.equal(error.message, '图片内容或格式不受支持。');
    assert.deepEqual(error.validation, {validationStage: stage, declaredMime, detectedMime, byteLength});
    assert.equal(Object.isFrozen(error.validation), true);
    assert.equal(Number.isSafeInteger(error.validation.byteLength), true);
    assert.equal(error.validation.byteLength >= 0, true);
    assert.doesNotMatch(JSON.stringify(error), /fixture-secret|https?:|Cookie|Bearer/);
    assert.deepEqual(Object.keys(error.validation).sort(), ['byteLength', 'declaredMime', 'detectedMime', 'validationStage']);
    return true;
  };
}

test('cross-realm JPEG and PNG byte arrays pass without changing bytes or declared MIME', async () => {
  for (const [mime, bytes] of [['image/jpeg', JPEG], ['image/png', PNG]]) {
    const foreign = foreignBytes(bytes);
    assert.equal(foreign instanceof Uint8Array, false, 'regression fixture must come from another realm');
    const value = await run(response(stream([foreign]), mime));
    assert.equal(value.mime, mime); assert.equal(Buffer.isBuffer(value.bytes), true);
    assert.deepEqual(value.bytes, bytes);
  }
});

test('native Buffer and cross-realm arrays pass the Node Readable to Web Response adapter', async () => {
  for (const chunks of [[JPEG], [foreignBytes(JPEG)], [JPEG.subarray(0, 1), foreignBytes(JPEG.subarray(1))]]) {
    const value = await run(response(Readable.toWeb(Readable.from(chunks))));
    assert.equal(value.mime, 'image/jpeg'); assert.deepEqual(value.bytes, JPEG);
  }
});

test('byte views copy only their offset and length, excluding surrounding buffer bytes', async () => {
  const wrapped = Buffer.concat([Buffer.from(SECRET), JPEG, Buffer.from(SECRET)]);
  const local = wrapped.subarray(Buffer.byteLength(SECRET), Buffer.byteLength(SECRET) + JPEG.length);
  const foreign = vm.runInNewContext(
    'new Uint8Array(new Uint8Array(bytes).buffer, offset, length)',
    {bytes: [...wrapped], offset: Buffer.byteLength(SECRET), length: JPEG.length});
  for (const view of [local, foreign]) {
    const value = await run(response(stream([view])));
    assert.deepEqual(value.bytes, JPEG);
    assert.equal(value.bytes.length, JPEG.length);
  }
});

test('magic bytes may be split across any number of chunks, including zero-length chunks', async () => {
  for (const [mime, bytes] of [['image/jpeg', JPEG], ['image/png', PNG]]) {
    const chunks = [foreignBytes([]), ...[...bytes].map(byte => foreignBytes([byte])), new Uint8Array(0)];
    assert.deepEqual((await run(response(stream(chunks), mime))).bytes, bytes);
  }
});

test('non-byte typed arrays, ArrayBuffer, DataView, strings and spoofed tags remain rejected', async () => {
  const badValues = [
    new Uint8ClampedArray(JPEG), new Uint16Array(JPEG), new Int8Array(JPEG), new ArrayBuffer(8),
    new DataView(new ArrayBuffer(8)), [...JPEG], SECRET, {byteLength: 8, [Symbol.toStringTag]: 'Uint8Array'},
    Object.create(Uint8Array.prototype), new Proxy(new Uint8Array(JPEG), {}),
    vm.runInNewContext('new Uint16Array([255,216,255])'),
  ];
  for (const value of badValues) {
    await assert.rejects(run(response(stream([value]))), validation('chunk', 'image/jpeg'));
  }
});

test('invalid chunks report only the number of preceding validated bytes', async () => {
  const bad = {get byteLength() {throw new Error('must not inspect invalid chunk: ' + SECRET);}, secret: SECRET};
  await assert.rejects(run(response(stream([foreignBytes(JPEG.subarray(0, 2)), bad]))),
    validation('chunk', 'image/jpeg', 'unknown', 2));
});

test('empty body and an empty readable stream have distinct safe validation stages', async () => {
  await assert.rejects(run(response(null)), validation('body', 'image/jpeg'));
  await assert.rejects(run(response(stream([]))), validation('magic', 'image/jpeg', 'unknown', 0));
  await assert.rejects(run({status: 200, headers: new Headers({'content-type': 'image/png'}), body: {}}),
    validation('body', 'image/png'));
});

test('JSON or HTML marked as JPEG still fails magic validation without leaking content', async () => {
  for (const text of ['{"error_code":21301,"error":"' + SECRET + '"}', '<html>' + SECRET + '</html>']) {
    const bytes = Buffer.from(text);
    await assert.rejects(run(response(stream([foreignBytes(bytes)]))),
      validation('magic', 'image/jpeg', 'unknown', bytes.length));
  }
});

test('recognized images with a different declared MIME are still rejected', async () => {
  const fixtures = [
    ['image/jpeg', PNG, 'image/png'], ['image/png', JPEG, 'image/jpeg'],
    ['image/jpeg', Buffer.from('GIF89a'), 'image/gif'],
    ['image/jpeg', Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBP')]), 'image/webp'],
  ];
  for (const [mime, bytes, detected] of fixtures) {
    await assert.rejects(run(response(stream([foreignBytes(bytes)]), mime)), validation('magic', mime, detected, bytes.length));
  }
});

test('unsupported or absent MIME is reported only as other before reading body', async () => {
  for (const mime of ['text/html; private=' + SECRET, 'image/svg+xml', SECRET, '']) {
    let reads = 0;
    const body = {getReader() {reads++; throw new Error(SECRET);}};
    await assert.rejects(run({status: 200, headers: new Headers({'content-type': mime}), body}),
      validation('mime', 'other'));
    assert.equal(reads, 0);
  }
});

test('allowed MIME parameters are normalized and cannot enter diagnostic details', async () => {
  const bytes = Buffer.from(SECRET);
  await assert.rejects(run(response(bytes, ' IMAGE/JPEG ; private=' + SECRET)),
    validation('magic', 'image/jpeg', 'unknown', bytes.length));
});

test('declared and streamed size limits remain enforced for cross-realm byte arrays', async () => {
  for (const value of [
    response(stream([foreignBytes(JPEG)]), 'image/jpeg', {'content-length': '99999999999999999999'}),
    response(stream([foreignBytes(JPEG)])),
  ]) {
    await assert.rejects(run(value, {maxBytes: JPEG.length - 1}), error => {
      assert.equal(error.code, 'MEDIA_TOO_LARGE'); assert.equal(error.validation, undefined); return true;
    });
  }
  assert.deepEqual((await run(response(stream([foreignBytes(JPEG)])), {maxBytes: JPEG.length})).bytes, JPEG);
});

test('abort before a request preserves no-request behavior and reveals no abort reason', async () => {
  const controller = new AbortController(); controller.abort(SECRET);
  let calls = 0;
  await assert.rejects(fetchImage({url: URL, signal: controller.signal, fetch: async () => {calls++; return response(JPEG);}}),
    error => {assert.equal(error.code, 'MEDIA_ABORT'); assert.equal(error.validation, undefined); assert.doesNotMatch(error.message, /fixture-secret/); return true;});
  assert.equal(calls, 0);
});

test('abort while reading cross-realm bytes cancels a pending read and ignores late success', async () => {
  const controller = new AbortController();
  let reads = 0, finishLate, canceled = 0, announceRead;
  const readStarted = new Promise(resolve => {announceRead = resolve;});
  const body = {getReader: () => ({
    read() {
      if (++reads === 1) return Promise.resolve({value: foreignBytes(JPEG.subarray(0, 3)), done: false});
      announceRead();
      return new Promise(resolve => {finishLate = resolve;});
    },
    cancel() {canceled++; return Promise.resolve();}, releaseLock() {},
  })};
  const pending = run({status: 200, headers: new Headers({'content-type': 'image/jpeg'}), body}, {signal: controller.signal});
  await readStarted; controller.abort(SECRET);
  await assert.rejects(pending, error => {assert.equal(error.code, 'MEDIA_ABORT'); assert.equal(error.validation, undefined); return true;});
  finishLate({value: foreignBytes(JPEG.subarray(3)), done: false});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 2); assert.equal(canceled, 1);
});

test('timeout still bounds a stalled body after valid cross-realm bytes', async () => {
  let reads = 0, canceled = 0;
  const body = {getReader: () => ({
    read() {return ++reads === 1 ? Promise.resolve({value: foreignBytes(JPEG), done: false}) : new Promise(() => {});},
    cancel() {canceled++; return Promise.resolve();}, releaseLock() {},
  })};
  await assert.rejects(run({status: 200, headers: new Headers({'content-type': 'image/jpeg'}), body}, {timeoutMs: 20}),
    error => {assert.equal(error.code, 'MEDIA_TIMEOUT'); assert.equal(error.validation, undefined); return true;});
  assert.equal(reads, 2); assert.equal(canceled, 1);
});

test('HTTP rejection and disallowed URLs still fail without reading purported image content', async () => {
  let reads = 0, calls = 0;
  const body = {getReader() {reads++; throw new Error(SECRET);}};
  await assert.rejects(run({status: 403, headers: new Headers({'content-type': 'image/jpeg'}), body}),
    error => {assert.equal(error.code, 'MEDIA_HTTP'); assert.equal(error.validation, undefined); return true;});
  assert.equal(reads, 0);
  await assert.rejects(fetchImage({url: 'https://evil.invalid/' + SECRET, fetch: async () => {calls++; return response(JPEG);}}),
    error => {assert.equal(error.code, 'MEDIA_URL'); assert.equal(error.validation, undefined); return true;});
  assert.equal(calls, 0);
});
