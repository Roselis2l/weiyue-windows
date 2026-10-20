'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { safeImageUrl, safePostUrl, normalizeImage, fetchImage } = require('../app/core/media.cjs');

const URL = 'https://wx1.sinaimg.cn/large/example.jpg';
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0xff, 0xd9]);
function response(bytes = JPEG, mime = 'image/jpeg', extra = {}) {
  return new Response(bytes, { status: 200, headers: { 'content-type': mime, ...(extra.headers || {}) }, ...extra });
}
function code(expected) { return error => { assert.equal(error.code, expected); assert.doesNotMatch(error.message, /https?:|secret|Cookie|Bearer/); return true; }; }
function stalledBody() { return new ReadableStream({ pull() { return new Promise(() => {}); } }); }

test('image URL allowlist upgrades official CDN HTTP and rejects spoofing, secrets and every explicit port', () => {
  assert.equal(safeImageUrl('http://wx1.sinaimg.cn/large/x.jpg#preview'), 'https://wx1.sinaimg.cn/large/x.jpg');
  assert.equal(safeImageUrl('https://sinaimg.cn/a'), 'https://sinaimg.cn/a');
  for (const url of [
    'https://sinaimg.cn.evil.test/a', 'https://evilsinaimg.cn/a', 'https://evil.test/a',
    'https://secret@sinaimg.cn/a', 'https://sinaimg.cn:443/a', 'http://sinaimg.cn:80/a',
    'https://sinaimg.cn:444/a', 'https://sinaimg.cn./a', 'https://.sinaimg.cn/a',
    'https://-bad.sinaimg.cn/a', 'https://wx1..sinaimg.cn/a', 'https://sinaimg.cn\\@evil.test/a',
    'file:///x.png', 'data:image/png;base64,abc', 'javascript:alert(1)', '//sinaimg.cn/a',
    ' https://sinaimg.cn/a', 'https://sinaimg.cn/a\n', 'https://sinaimg.cn/' + 'a'.repeat(4096),
    undefined, {}, 1,
  ]) assert.equal(safeImageUrl(url), null);
});

test('MSS accepts only exact download path and canonical decimal fid/source/type parameters', () => {
  const base = 'https://upload.api.weibo.com/2/mss/msget';
  const query = '?fid=9007199254740993999&source=209678993&imageType=origin';
  assert.equal(safeImageUrl(base + query + '&token=secret#x'), base + query);
  for (const url of [
    base.replace('https:', 'http:') + query, base + '/other' + query,
    base.replace('/msget', '/delete') + query, base.replace('upload.', 'other.') + query,
    base + query + '&fid=2', base + query + '&source=1', base + query.replace('209678993', '123'),
    base + query.replace('origin', 'thumb'), base + '?fid=1',
    base + query.replace('9007199254740993999', '-1'), base + query.replace('9007199254740993999', '1e10'),
  ]) assert.equal(safeImageUrl(url), null);
});

test('post URLs are display-only HTTPS official weibo domains without short-link resolution', () => {
  for (const url of ['https://weibo.com/123/abc', 'https://m.weibo.cn/status/123', 'https://www.weibo.com/u/1']) assert.equal(safePostUrl(url), url);
  for (const url of ['http://weibo.com/123', 'https://t.cn/abc', 'https://weibo.com.evil.test/a', 'https://evil@weibo.cn/a', 'https://weibo.com:443/a', 'https://sinaimg.cn/a']) assert.equal(safePostUrl(url), null);
});

test('image descriptors contain only safe known fields and valid bounded dimensions', () => {
  assert.deepEqual(normalizeImage({ url: URL, originalUrl: 'https://evil.test/a', thumbnailUrl: 'http://sinaimg.cn/t.jpg', width: 640, height: 480, cookie: 'secret' }), {
    url: URL, thumbnailUrl: 'https://sinaimg.cn/t.jpg', width: 640, height: 480,
  });
  assert.deepEqual(normalizeImage({ url: 'bad', originalUrl: URL, width: -1, height: 100000 }), { url: URL, originalUrl: URL });
  assert.equal(normalizeImage({ url: 'https://evil.test/a' }), null);
  assert.equal(normalizeImage(null), null);
  assert.equal(normalizeImage([]), null);
});

test('fetch uses account cookies and cross-origin Referer, manual redirects, and returns validated binary', async () => {
  const calls = [];
  const result = await fetchImage({ url: URL, fetch: async (url, options) => { calls.push({ url, options }); return response(); } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.Referer, 'https://api.weibo.com/');
  assert.equal(calls[0].options.credentials, 'include');
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(Object.keys(calls[0].options.headers).some(x => x.toLowerCase() === 'cookie'), false);
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(result.mime, 'image/jpeg');
  assert.ok(Buffer.isBuffer(result.bytes));
  assert.deepEqual(result.bytes, JPEG);
});

test('all supported MIME and magic pairs pass, including MIME parameters', async () => {
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBP')]);
  for (const [mime, bytes] of [['image/jpeg', JPEG], ['image/png', PNG], ['image/gif', Buffer.from('GIF89a')], ['image/webp', webp]]) {
    const result = await fetchImage({ url: URL, fetch: async () => response(bytes, mime + '; charset=binary') });
    assert.equal(result.mime, mime);
    assert.deepEqual(result.bytes, bytes);
  }
});

test('redirects are limited to three hops and every destination is checked', async () => {
  let calls = 0;
  const result = await fetchImage({ url: URL, fetch: async () => ++calls <= 3 ? new Response(null, { status: 302, headers: { location: '/image' + calls } }) : response() });
  assert.equal(calls, 4);
  assert.equal(result.mime, 'image/jpeg');
  calls = 0;
  await assert.rejects(fetchImage({ url: URL, fetch: async () => { calls++; return new Response(null, { status: 302, headers: { location: '/again' } }); } }), code('MEDIA_REDIRECT'));
  assert.equal(calls, 4);
  for (const location of ['https://evil.test/secret', 'https://sinaimg.cn:443/a', '//sinaimg.cn:443/a', 'file:///x', 'https://secret@sinaimg.cn/a']) {
    calls = 0;
    await assert.rejects(fetchImage({ url: URL, fetch: async () => { calls++; return new Response(null, { status: 302, headers: { location } }); } }), code('MEDIA_REDIRECT'));
    assert.equal(calls, 1);
  }
});

test('missing location and already-auto-followed response cannot bypass redirect validation', async () => {
  await assert.rejects(fetchImage({ url: URL, fetch: async () => new Response(null, { status: 302 }) }), code('MEDIA_REDIRECT'));
  await assert.rejects(fetchImage({ url: URL, fetch: async () => ({ status: 200, redirected: true, headers: new Headers({ 'content-type': 'image/jpeg' }), body: response().body }) }), code('MEDIA_REDIRECT'));
});

test('HTML, SVG, missing MIME, mismatched MIME, empty and bogus magic are rejected', async () => {
  for (const [bytes, mime] of [[Buffer.from('<svg>bad</svg>'), 'image/svg+xml'], [Buffer.from('<html>secret</html>'), 'text/html'], [Buffer.from('<html>secret</html>'), 'image/jpeg'], [PNG, 'image/jpeg'], [JPEG, ''], [Buffer.alloc(0), 'image/png'], [Buffer.from('RIFFxxxxFAKE'), 'image/webp']]) {
    await assert.rejects(fetchImage({ url: URL, fetch: async () => response(bytes, mime) }), code('MEDIA_TYPE'));
  }
});

test('declared and streamed sizes are bounded, even without a Content-Length', async () => {
  await assert.rejects(fetchImage({ url: URL, maxBytes: 8, fetch: async () => new Response(JPEG, { headers: { 'content-type': 'image/jpeg', 'content-length': '99999999999999999999' } }) }), code('MEDIA_TOO_LARGE'));
  await assert.rejects(fetchImage({ url: URL, maxBytes: 8, fetch: async () => response(PNG, 'image/png') }), code('MEDIA_TOO_LARGE'));
  const result = await fetchImage({ url: URL, maxBytes: JPEG.length, fetch: async () => response() });
  assert.equal(result.bytes.length, JPEG.length);
});

test('timeout covers both headers and stalled body even if dependencies ignore abort', async () => {
  await assert.rejects(fetchImage({ url: URL, timeoutMs: 20, fetch: () => new Promise(() => {}) }), code('MEDIA_TIMEOUT'));
  await assert.rejects(fetchImage({ url: URL, timeoutMs: 20, fetch: async () => response(stalledBody()) }), code('MEDIA_TIMEOUT'));
});

test('one timeout budget includes request headers plus body rather than resetting per phase', async () => {
  await assert.rejects(fetchImage({ url: URL, timeoutMs: 35, fetch: async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
    return response(new ReadableStream({ async pull(controller) {
      await new Promise(resolve => setTimeout(resolve, 25));
      try { controller.enqueue(JPEG); controller.close(); } catch { /* deadline canceled this test stream */ }
    } }));
  } }), code('MEDIA_TIMEOUT'));
});

test('caller abort before request or while reading body stops and does not retry', async () => {
  const before = new AbortController(); before.abort('secret');
  let calls = 0;
  await assert.rejects(fetchImage({ url: URL, signal: before.signal, fetch: async () => { calls++; return response(); } }), code('MEDIA_ABORT'));
  assert.equal(calls, 0);
  const during = new AbortController();
  const pending = fetchImage({ url: URL, signal: during.signal, fetch: async () => { calls++; return response(stalledBody()); } });
  setTimeout(() => during.abort(new Error('secret')), 10);
  await assert.rejects(pending, code('MEDIA_ABORT'));
  assert.equal(calls, 1);
});

test('errors never expose URLs or upstream messages and transient errors are not retried', async () => {
  let calls = 0;
  await assert.rejects(fetchImage({ url: URL, fetch: async () => { calls++; throw new Error('https://secret Cookie=secret'); } }), code('MEDIA_FETCH'));
  assert.equal(calls, 1);
  await assert.rejects(fetchImage({ url: URL, fetch: async () => new Response('secret', { status: 503 }) }), code('MEDIA_HTTP'));
  await assert.rejects(fetchImage({ url: 'https://evil.test/secret', fetch: async () => response() }), code('MEDIA_URL'));
  await assert.rejects(fetchImage({ url: URL, fetch: async () => response(), maxBytes: 0 }), code('MEDIA_CONFIG'));
  await assert.rejects(fetchImage({ url: URL, fetch: async () => response(new ReadableStream({ pull(controller) { controller.error(new Error('https://secret Cookie=secret')); } })) }), code('MEDIA_FETCH'));
});
