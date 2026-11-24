'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  prepareSummary, prepareAiSummary, inspectAiVision, inspectAiImage, aiSummary,
  MAX_CHUNK_CHARS, MAX_AI_IMAGE_BYTES, MAX_AI_TOTAL_IMAGE_BYTES, MAX_AI_IMAGES,
  MAX_AI_CHUNK_IMAGE_BYTES, MAX_AI_CHUNK_IMAGES,
} = require('../app/core/summary.cjs');
const { prepareAiSettingsSave } = require('../app/core/ai-settings.cjs');

// Synthetic fixtures only. Every request below is captured by an injected mock.
const start = 1700000000000, end = start + 10000;
const group = { id: 'mock-group', name: '模拟群', coverage: { oldest: start, newest: end, complete: true } };
const message = (id, text = '模拟群聊正文') => ({ id, groupId: group.id, time: start + 1, senderId: 'mock-member', senderName: '模拟成员', text });
const prepare = (messages = [message('1')]) => prepareSummary({ messages, group, start, end });
const config = { endpoint: 'https://api.openai.com/v1', model: 'gpt-6-astra', aiVisionMode: 'auto' };
const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const png = `data:image/png;base64,${pngBytes.toString('base64')}`;
// Add a harmless trailing fixture marker to distinguish mock byte payloads.
const image = (number = 0, bytes = pngBytes.length + 1) => ({
  dataUrl: `data:image/png;base64,${Buffer.concat([pngBytes, Buffer.alloc(Math.max(1, bytes - pngBytes.length), number + 1)]).toString('base64')}`,
  sourceUrl: `https://example.invalid/private-picture-${number}.png?signature=LOCAL-MOCK-DO-NOT-SEND`,
});
const content = (extra = {}) => [{ messageId: '1', text: '[分享微博 @模拟作者]\n已取得完整模拟微博正文。', postCount: 1, images: [image()], ...extra }];
const build = (data = content(), options = config, prepared = prepare()) => prepareAiSummary(prepared, { ...options, content: data });
const success = text => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: text || '模拟摘要 [M1]' } }] }), { status: 200 });

test('vision auto detection is exact official evidence, not a model-name or endpoint-prefix guess', () => {
  for (const model of ['gpt-6-astra', 'GPT-6 Astra', 'gpt-4.1', 'gpt-4o']) assert.equal(inspectAiVision({ ...config, model }).supported, true);
  for (const options of [
    { ...config, endpoint: 'https://api.openai.com.evil.invalid/v1' },
    { ...config, endpoint: 'https://api.openai.com:444/v1' },
    { ...config, endpoint: 'https://custom.invalid/v1' },
    { ...config, model: 'gpt-6-astra-something-new' },
    { ...config, model: 'user-text-only-model' },
  ]) {
    const actual = inspectAiVision(options);
    assert.equal(actual.supported, false); assert.equal(actual.source, 'unknown');
  }
  assert.equal(inspectAiVision({ ...config, aiVisionMode: 'disabled' }).supported, false);
  assert.equal(inspectAiVision({ ...config, endpoint: 'https://custom.invalid/v1', aiVisionMode: 'enabled' }).source, 'user');
  assert.throws(() => inspectAiVision({ ...config, aiVisionMode: 'yes' }), /设置无效/);
});

test('prepared and returned citations contain accessible shared post text, without mutating the source message', async () => {
  const source = prepare(), before = structuredClone(source);
  const value = build(content(), config, source);
  assert.deepEqual(source, before);
  assert.equal(value.contentScope.postCount, 1);
  assert.match(value.messages[0].text, /已取得完整模拟微博正文/);
  const result = await aiSummary(value, { ...config, fetch: async () => success() });
  assert.match(result.refs[0].text, /模拟群聊正文/);
  assert.match(result.refs[0].text, /已取得完整模拟微博正文/);
  assert.equal(result.contentScope.imageCount, 1);
  assert.ok(!JSON.stringify(result).includes('data:image/'), 'saved summary scope and refs must not persist image bytes');
  assert.ok(!JSON.stringify(result).includes('signature='), 'source URLs are not added to scope or model prompt');
});

test('actual PNG bytes and shared post text enter official Chat Completions content, not mere URLs or counts', async () => {
  const value = build(); let calls = 0;
  await aiSummary(value, { ...config, key: 'LOCAL-MOCK-KEY', fetch: async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(options.body), parts = body.messages[1].content;
    assert.ok(Array.isArray(parts));
    assert.match(parts[0].text, /已取得完整模拟微博正文/);
    const visual = parts.find(part => part.type === 'image_url');
    assert.equal(visual.image_url.url, image().dataUrl);
    assert.deepEqual(Buffer.from(visual.image_url.url.split(',')[1], 'base64'), Buffer.from(image().dataUrl.split(',')[1], 'base64'));
    assert.match(parts.find(part => part.type === 'text' && part.text.includes('图像 I1')).text, /\[M1\]/);
    assert.ok(!options.body.includes('private-picture-'));
    assert.ok(!options.body.includes('LOCAL-MOCK-DO-NOT-SEND'));
    assert.ok(!('tools' in body)); assert.ok(!('temperature' in body));
    assert.match(body.messages[0].content, /图片内文字/);
    return success();
  } });
  assert.equal(calls, value.contentScope.chunkCount);
});

test('a declared compatible model receives real image data using the existing protocol without switching providers', async () => {
  const options = { endpoint: 'https://compat.example.test/v1', model: 'vision-api-id', aiVisionMode: 'enabled' };
  const value = build(content(), options);
  await aiSummary(value, { ...options, fetch: async (url, request) => {
    assert.equal(url, 'https://compat.example.test/v1/chat/completions');
    const body = JSON.parse(request.body);
    assert.equal(body.model, options.model);
    assert.equal(body.max_tokens, 4096); assert.equal(body.temperature, 0.2);
    assert.equal(body.messages[1].content.find(item => item.type === 'image_url').image_url.url, image().dataUrl);
    return success();
  } });
});

test('unknown or disabled vision is explicitly omitted before sending and never uses an image URL fallback', async () => {
  for (const options of [{ ...config, model: 'unknown-model' }, { ...config, aiVisionMode: 'disabled' }]) {
    const value = build(content(), options);
    assert.equal(value.contentScope.imageCount, 0);
    assert.equal(value.contentScope.omissions.length, 1);
    assert.deepEqual(Object.keys(value.contentScope.omissions[0]).sort(), ['groupId', 'kind', 'label', 'messageId', 'reason']);
    assert.equal(value.contentScope.omissions[0].label, 'M1');
    assert.equal(value.contentScope.omissions[0].kind, 'image');
    assert.match(value.warning, /未纳入 AI 请求/);
    await aiSummary(value, { ...options, fetch: async (_url, request) => {
      const parts = JSON.parse(request.body).messages[1].content;
      assert.equal(typeof parts, 'string');
      assert.ok(!request.body.includes('data:image'));
      assert.match(parts, /已取得完整模拟微博正文/);
      return success();
    } });
  }
});

test('failed fetch omissions carry source references and post/image omissions remain distinct', () => {
  const value = build([{ messageId: '1', text: '', images: [], omissions: [
    { kind: 'image', reason: '图片读取失败，未发送。' }, { kind: 'post', reason: '分享微博正文不可访问。' },
  ] }]);
  assert.equal(value.contentScope.postCount, 0);
  assert.equal(value.contentScope.imageCount, 0);
  assert.deepEqual(value.contentScope.omissions.map(item => [item.kind, item.messageId, item.label]), [['image', '1', 'M1'], ['post', '1', 'M1']]);
});

test('the same fetched image bytes are sent once across messages and source text stays fully represented', async () => {
  const value = build([
    { messageId: '1', images: [image()] },
    { messageId: '2', text: '另一处分享文字', images: [image()] },
  ], config, prepare([message('1'), message('2', '第二条')]));
  assert.equal(value.contentScope.imageCandidates, 2);
  assert.equal(value.contentScope.imageCount, 1);
  assert.equal(value.contentScope.duplicateImages, 1);
  let visuals = 0;
  await aiSummary(value, { ...config, fetch: async (_url, request) => {
    const body = JSON.parse(request.body), parts = body.messages[1].content;
    if (Array.isArray(parts)) visuals += parts.filter(p => p.type === 'image_url').length;
    return success();
  } });
  assert.equal(visuals, 1);
  assert.ok(value.chunks.map(chunk => chunk.text).join('\n').includes('另一处分享文字'));
});

test('many repetitions of an identical image do not overflow the textual chunk budget', () => {
  const value = build(content({ images: Array.from({ length: 1000 }, () => image()) }));
  assert.equal(value.contentScope.imageCount, 1);
  assert.equal(value.contentScope.duplicateImages, 999);
  assert.ok(value.chunks.every(chunk => chunk.text.length <= MAX_CHUNK_CHARS));
  assert.equal(value.chunks.flatMap(chunk => chunk.images).length, 1);
});

test('many images split by both count and bytes; no chunk silently exceeds the declared budget', async () => {
  const items = Array.from({ length: 7 }, (_, index) => image(index, 3 * 1024 * 1024));
  const value = build(content({ images: items }));
  assert.equal(value.contentScope.imageCount, 7);
  assert.equal(value.contentScope.imageBytes, 21 * 1024 * 1024);
  assert.ok(value.chunks.length >= 4);
  assert.ok(value.chunks.every(chunk => chunk.text.length <= MAX_CHUNK_CHARS && chunk.images.length <= MAX_AI_CHUNK_IMAGES && chunk.imageBytes <= MAX_AI_CHUNK_IMAGE_BYTES));
  let sent = 0;
  await aiSummary(value, { ...config, fetch: async (_url, request) => {
    const body = JSON.parse(request.body);
    const parts = body.messages[1].content;
    if (Array.isArray(parts)) sent += parts.filter(part => part.type === 'image_url').length;
    return success();
  } });
  assert.equal(sent, 7);
});

test('total image byte/count caps explicitly list every excluded image', () => {
  const count = build(content({ images: Array.from({ length: MAX_AI_IMAGES + 2 }, (_, i) => image(i)) }));
  assert.equal(count.contentScope.imageCount, MAX_AI_IMAGES);
  assert.equal(count.contentScope.omissions.length, 2);
  assert.ok(count.contentScope.omissions.every(item => /24 张/.test(item.reason)));
  const bytes = build(content({ images: Array.from({ length: 7 }, (_, i) => image(i, MAX_AI_IMAGE_BYTES)) }));
  assert.equal(bytes.contentScope.imageBytes, MAX_AI_TOTAL_IMAGE_BYTES);
  assert.equal(bytes.contentScope.imageCount, 6);
  assert.equal(bytes.contentScope.omissions.length, 1);
  assert.match(bytes.contentScope.omissions[0].reason, /24 MiB/);
});

test('unsupported, oversized, malformed, URL-only and mismatched-format candidates are omissions, not visual inputs', () => {
  const oversized = { dataUrl: `data:image/png;base64,${Buffer.alloc(MAX_AI_IMAGE_BYTES + 1).toString('base64')}` };
  const value = build(content({ images: [
    { dataUrl: 'https://example.invalid/picture.png' },
    { dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' },
    { dataUrl: png.replace('image/png', 'image/jpeg') },
    { dataUrl: 'data:image/png;base64,not-valid' },
    { dataUrl: `data:image/gif;base64,${Buffer.from('GIF89a').toString('base64')}` }, oversized,
  ] }));
  assert.equal(value.contentScope.imageCount, 0);
  assert.equal(value.contentScope.omissions.length, 6);
  assert.ok(value.chunks.every(chunk => chunk.images.length === 0));
});

test('animated PNG/WebP are explicitly excluded rather than being described as full visual content', () => {
  const apng = Buffer.concat([pngBytes.subarray(0, 8), Buffer.from([0, 0, 0, 8]), Buffer.from('acTL'), Buffer.alloc(12)]);
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.from('ANIM'), Buffer.alloc(8)]);
  assert.throws(() => inspectAiImage(`data:image/png;base64,${apng.toString('base64')}`), /动态/);
  assert.throws(() => inspectAiImage(`data:image/webp;base64,${webp.toString('base64')}`), /动态/);
});

test('enrichment cannot add an unselected message or repeated source item', () => {
  assert.throws(() => build([{ messageId: 'other', text: 'unrelated private data', images: [image()] }]), /不属于/);
  assert.throws(() => build([...content(), ...content()]), /重复/);
  const scoped = prepareSummary({ messages: [message('1'), { ...message('2'), groupId: 'other' }, { ...message('3'), time: end }], group, start, end });
  assert.throws(() => build([{ messageId: '2' }], config, scoped), /不属于/);
  assert.throws(() => build([{ messageId: '3' }], config, scoped), /不属于/);
});

test('long shared text is segmented losslessly while original stable refs are preserved', () => {
  const text = '模拟转发正文😀\n'.repeat(4000);
  const value = build(content({ text, images: [image()] }));
  const combined = value.chunks.flatMap(chunk => chunk.segments).filter(segment => !segment.attachmentOnly && !segment.attachmentIndex).map(segment => segment.text).join('');
  assert.equal(combined, value.messages[0].text);
  assert.ok(value.chunks.every(chunk => chunk.text.length <= MAX_CHUNK_CHARS));
  assert.ok(value.chunks.every(chunk => chunk.refs.includes('M1')));
  assert.equal(value.contentScope.postCount, 1);
});

test('post text beyond the bounded enrichment size is clearly omitted instead of silently truncated', () => {
  const value = build(content({ text: 'x'.repeat(200001), images: [] }));
  assert.equal(value.messages[0].text, '模拟群聊正文');
  assert.equal(value.contentScope.postCount, 0);
  assert.equal(value.contentScope.omissions[0].kind, 'post');
});

test('changing the selected service/model/vision setting invalidates a prepared sending snapshot', async () => {
  const value = build(); let calls = 0;
  for (const change of [
    { endpoint: 'https://other.invalid/v1' }, { model: 'gpt-4o' }, { aiVisionMode: 'disabled' },
  ]) await assert.rejects(aiSummary(value, { ...config, ...change, fetch: async () => { calls++; return success(); } }), /已改变/);
  assert.equal(calls, 0);
});

test('cancel before send, during request and between chunks never reissues data or saves partial output', async () => {
  const before = new AbortController(); before.abort();
  let calls = 0;
  await assert.rejects(aiSummary(build(), { ...config, signal: before.signal, fetch: async () => { calls++; return success(); } }), /已取消/);
  assert.equal(calls, 0);
  const during = new AbortController();
  await assert.rejects(aiSummary(build(), { ...config, signal: during.signal, fetch: async (_url, request) => {
    calls++; during.abort();
    assert.equal(request.signal.aborted, true);
    throw new Error('PRIVATE-MOCK-TRANSPORT');
  } }), /已取消.*是否计费未知/);
  assert.equal(calls, 1);
  const after = new AbortController();
  const value = build(content({ text: '长模拟消息'.repeat(7000), images: [] }));
  assert.ok(value.chunks.length > 1);
  calls = 0;
  await assert.rejects(aiSummary(value, { ...config, signal: after.signal, fetch: async () => {
    calls++; after.abort(); return success();
  } }), /已取消/);
  assert.equal(calls, 1);
});

test('cancel while reading a stalled response is prompt even when stream cancellation stalls', { timeout: 1000 }, async () => {
  const controller = new AbortController(); let calls = 0, cancellations = 0;
  await assert.rejects(aiSummary(build(), { ...config, signal: controller.signal, fetch: async () => {
    calls++;
    return {
      ok: true, status: 200,
      body: { getReader: () => ({
        read: () => { queueMicrotask(() => controller.abort()); return new Promise(() => {}); },
        cancel: () => { cancellations++; return new Promise(() => {}); },
        releaseLock: () => {},
      }) },
    };
  } }), /已取消.*是否计费未知/);
  assert.equal(calls, 1); assert.ok(cancellations >= 1);
});

test('a provider rejecting multimodal input is one request, with no fallback model, OCR or text-only retry', async () => {
  let calls = 0;
  await assert.rejects(aiSummary(build(), { ...config, fetch: async () => {
    calls++;
    return new Response(JSON.stringify({ error: { code: 'invalid_request_error', param: 'messages', message: 'MOCK-PRIVATE-IMAGE-BODY' } }), { status: 400 });
  } }), error => /HTTP 400/.test(error.message) && /未自动重试/.test(error.message) && !error.message.includes('MOCK-PRIVATE'));
  assert.equal(calls, 1);
});

test('vision capability declaration saves explicitly, validates input, and does not silently follow changed model/service', () => {
  const initial = { endpoint: 'https://custom.invalid/v1', model: 'vision-model', aiProviderId: 'custom', aiVisionMode: 'enabled' };
  const credentials = { aiKey: 'LOCAL-MOCK-KEY', aiKeyScope: { providerId: 'custom', endpoint: 'https://custom.invalid/v1/chat/completions' } };
  const payload = { providerId: 'custom', endpoint: initial.endpoint, model: initial.model, keyAction: 'keep' };
  assert.equal(prepareAiSettingsSave(initial, credentials, payload).settings.aiVisionMode, 'enabled');
  assert.equal(prepareAiSettingsSave(initial, credentials, { ...payload, model: 'another-model' }).settings.aiVisionMode, 'auto');
  assert.equal(prepareAiSettingsSave(initial, credentials, { ...payload, model: 'another-model', aiVisionMode: 'enabled' }).settings.aiVisionMode, 'enabled');
  assert.equal(prepareAiSettingsSave(initial, credentials, { ...payload, aiVisionMode: 'disabled' }).settings.aiVisionMode, 'disabled');
  assert.throws(() => prepareAiSettingsSave(initial, credentials, { ...payload, aiVisionMode: true }), /设置无效/);
});
