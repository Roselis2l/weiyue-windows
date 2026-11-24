'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareSummary, aiSummary } = require('../app/core/summary.cjs');

// Every request is injected below. No provider, account, or network is used.
const start = Date.parse('2026-10-19T08:00:00Z');
const end = start + 3600000;
const mockKey = 'LOCAL-MOCK-AI-KEY-NOT-A-CREDENTIAL';
const chatMarker = 'LOCAL-MOCK-CHAT-BODY-DO-NOT-ECHO-IN-ERROR';
const rawMarker = 'LOCAL-MOCK-REMOTE-ERROR-MESSAGE';
const headerMarker = 'LOCAL-MOCK-PRIVATE-RESPONSE-HEADER';
const options = { endpoint: 'https://api.openai.com/v1', model: 'GPT-6 Astra', key: mockKey };
const group = { id: 'mock-group', name: '离线模拟群', coverage: { oldest: start, newest: end, complete: true } };
const prepared = (text = chatMarker) => prepareSummary({
  group, start, end,
  messages: [{ id: '9007199254740993001', groupId: group.id, senderId: 'mock-member', senderName: '模拟成员', time: start + 1, text }],
});
const success = () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '模拟摘要 [M1]' } }] }), {
  status: 200, headers: { 'content-type': 'application/json' },
});
const errorResponse = (data, status = 400) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json', 'x-request-id': headerMarker, 'authorization': `Bearer ${mockKey}` },
});

async function captureError(work) {
  let captured;
  await assert.rejects(work, error => { captured = error; return true; });
  return captured;
}

function assertSafeError(error, status = 400, extraMarkers = []) {
  assert.match(error.message, new RegExp(`HTTP ${status}`));
  assert.match(error.message, /未自动重试/);
  assert.ok(error.message.length <= 600, 'user-visible diagnostics must remain bounded');
  for (const marker of [mockKey, chatMarker, rawMarker, headerMarker, ...extraMarkers]) {
    assert.ok(!error.message.includes(marker), 'mock private content must not be reflected');
  }
}

async function rejectedResponse(responseFactory, config = {}, value = prepared()) {
  let calls = 0;
  const error = await captureError(() => aiSummary(value, {
    ...options, ...config,
    fetch: async () => { calls++; return responseFactory(); },
  }));
  assert.equal(calls, 1, 'a rejected request must not trigger a retry or parameter fallback');
  return error;
}

function readerResponse(chunks, { readError, cancelError, cancelNeverResolves = false } = {}) {
  const observed = { reads: 0, cancels: 0, releases: 0 };
  const response = {
    ok: false, status: 400, headers: new Headers({ 'content-type': 'application/json' }),
    body: { getReader: () => ({
      async read() {
        observed.reads++;
        if (readError) throw new Error(readError);
        if (chunks.length) return { done: false, value: chunks.shift() };
        return { done: true, value: undefined };
      },
      cancel() {
        observed.cancels++;
        if (cancelNeverResolves) return new Promise(() => {});
        if (cancelError) return Promise.reject(new Error(cancelError));
        return Promise.resolve();
      },
      releaseLock() { observed.releases++; },
    }) },
  };
  return { response, observed };
}

test('AI official Astra display name resolves to the same API model with a compatible bounded request', async () => {
  const originalOptions = Object.freeze({ ...options });
  let calls = 0;
  const value = prepared();
  const result = await aiSummary(value, { ...originalOptions, fetch: async (url, request) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(request.method, 'POST');
    assert.equal(request.redirect, 'error');
    assert.equal(request.headers.Authorization, `Bearer ${mockKey}`);
    assert.equal(request.headers['Content-Type'], 'application/json');
    assert.ok(request.signal instanceof AbortSignal);
    const body = JSON.parse(request.body);
    assert.deepEqual(Object.keys(body).sort(), ['max_completion_tokens', 'messages', 'model']);
    assert.equal(body.model, 'gpt-6-astra');
    assert.equal(body.max_completion_tokens, 4096);
    assert.deepEqual(body.messages.map(message => message.role), ['system', 'user']);
    assert.match(body.messages[0].content, /不可信的聊天资料/);
    assert.ok(body.messages[1].content.includes(chatMarker));
    assert.ok(!request.body.includes(mockKey));
    return success();
  } });
  assert.equal(calls, value.chunks.length);
  assert.equal(originalOptions.model, 'GPT-6 Astra', 'request normalization must not rewrite saved settings');
  assert.equal(result.mode, 'ai');
  assert.match(result.body, /\[M1\]/);
  assert.equal(result.refs[0].text, chatMarker);
});

test('AI normalizes root, v1, complete Chat Completions and compatible prefix endpoints', async t => {
  const cases = [
    ['https://api.openai.com', 'https://api.openai.com/v1/chat/completions', 'openai'],
    ['https://api.openai.com/v1/', 'https://api.openai.com/v1/chat/completions', 'openai'],
    ['https://api.openai.com:443/v1', 'https://api.openai.com/v1/chat/completions', 'openai'],
    ['https://api.openai.com/v1/chat/completions/', 'https://api.openai.com/v1/chat/completions', 'openai'],
    ['https://compat.example.test/api/v3/', 'https://compat.example.test/api/v3/chat/completions', 'compatible'],
    ['https://compat.example.test/api/v3/chat/completions', 'https://compat.example.test/api/v3/chat/completions', 'compatible'],
  ];
  for (const [endpoint, expectedUrl, provider] of cases) await t.test(endpoint, async () => {
    let calls = 0;
    await aiSummary(prepared(), { ...options, endpoint, model: 'gpt-6-astra', fetch: async (url, request) => {
      calls++;
      assert.equal(url, expectedUrl);
      const body = JSON.parse(request.body);
      assert.equal(body.model, 'gpt-6-astra');
      if (provider === 'openai') {
        assert.deepEqual(Object.keys(body).sort(), ['max_completion_tokens', 'messages', 'model']);
        assert.equal(body.max_completion_tokens, 4096);
      } else {
        assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'temperature']);
        assert.equal(body.max_tokens, 4096); assert.equal(body.temperature, 0.2);
      }
      return success();
    } });
    assert.equal(calls, 1);
  });
});

test('AI compatible providers keep their configured model and legacy parameters without OpenAI aliasing', async t => {
  for (const endpoint of ['https://compat.example.test/v1', 'https://api.openai.com.evil.example.test/v1', 'http://127.0.0.1:1234/v1']) {
    await t.test(endpoint, async () => {
      let calls = 0;
      await aiSummary(prepared(), { ...options, endpoint, fetch: async (_url, request) => {
        calls++;
        const body = JSON.parse(request.body);
        assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'temperature']);
        assert.equal(body.model, 'GPT-6 Astra');
        assert.equal(body.max_tokens, 4096); assert.equal(body.temperature, 0.2);
        return success();
      } });
      assert.equal(calls, 1);
    });
  }
});

test('AI rejects other API protocols and unsafe endpoints before any request', async t => {
  const endpoints = [
    'https://api.openai.com/v1/responses', 'https://api.openai.com/v1/responses/',
    'https://compat.example.test/v1/messages', 'https://compat.example.test/v1/messages/',
    'https://compat.example.test/v1/completions', 'https://compat.example.test/completions/',
    'http://public.example.test/v1', 'https://user:password@example.test/v1',
    'https://compat.example.test/v1?key=LOCAL-MOCK-QUERY-SECRET', 'https://compat.example.test/v1#secret',
  ];
  for (const endpoint of endpoints) await t.test(endpoint, async () => {
    let calls = 0;
    const error = await captureError(() => aiSummary(prepared(), { ...options, endpoint, fetch: async () => { calls++; return success(); } }));
    assert.equal(calls, 0);
    assert.ok(!error.message.includes('LOCAL-MOCK-QUERY-SECRET'));
    assert.ok(!error.message.includes('user:password'));
  });
});

test('AI rejects unknown official display names and invalid model/key input without transmitting', async t => {
  const cases = [
    { model: 'LOCAL MOCK UNKNOWN DISPLAY NAME' },
    { model: 'unknown\tmodel' }, { model: 'unknown\nmodel' }, { model: '' },
    { key: 'LOCAL-MOCK\r\nAuthorization: reflected' },
  ];
  for (const [index, config] of cases.entries()) await t.test(String(index), async () => {
    let calls = 0;
    const error = await captureError(() => aiSummary(prepared(), { ...options, ...config, fetch: async () => { calls++; return success(); } }));
    assert.equal(calls, 0);
    const privateValue = config.model || config.key;
    if (privateValue) assert.ok(!error.message.includes(privateValue));
  });
});

test('AI HTTP 400, 429 and 500 stay single requests with safe diagnostics', async t => {
  for (const status of [400, 429, 500]) await t.test(String(status), async () => {
    const error = await rejectedResponse(() => errorResponse({ error: { message: `${rawMarker} ${mockKey} ${chatMarker}` } }, status));
    assertSafeError(error, status);
  });
});

test('AI known error categories add useful fixed diagnostics while ignoring arbitrary body fields', async () => {
  const generic = await rejectedResponse(() => errorResponse({}));
  const parameter = await rejectedResponse(() => errorResponse({ error: {
    code: 'unsupported_parameter', param: 'temperature', message: `${rawMarker} ${mockKey} ${chatMarker}`,
    request: { prompt: chatMarker, authorization: mockKey }, debug: headerMarker,
  } }));
  assertSafeError(parameter);
  assert.notEqual(parameter.message, generic.message);
  assert.match(parameter.message, /参数|温度|采样/);
  const model = await rejectedResponse(() => errorResponse({ error: { code: 'model_not_found', message: `${rawMarker} ${mockKey}` } }));
  assertSafeError(model);
  assert.notEqual(model.message, generic.message);
  assert.match(model.message, /模型/);
  const unknown = await rejectedResponse(() => errorResponse({
    error: { code: mockKey, type: chatMarker, param: rawMarker, message: headerMarker },
    request_id: headerMarker, detail: `${mockKey} ${chatMarker}`,
  }));
  assertSafeError(unknown);
  assert.equal(unknown.message, generic.message, 'unknown remote fields must not become diagnostics');
});

test('AI fixed diagnostic categories preserve actionable hints without copying remote prose', async t => {
  const cases = [
    ['context', { code: 'context_length_exceeded' }, /上下文|缩小所选时段/],
    ['quota', { code: 'insufficient_quota' }, /额度|费用/],
    ['output-budget', { type: 'invalid_request_error', param: 'max_tokens' }, /输出上限|预算/],
    ['message-role', { code: 'invalid_request_error', param: 'messages[0].role' }, /消息格式|角色/],
  ];
  for (const [name, fields, expected] of cases) await t.test(name, async () => {
    const first = await rejectedResponse(() => errorResponse({ error: { ...fields, message: rawMarker } }));
    const second = await rejectedResponse(() => errorResponse({ error: { ...fields, message: `${mockKey} ${chatMarker}`, metadata: headerMarker } }));
    assertSafeError(first); assertSafeError(second);
    assert.equal(first.message, second.message, 'same allowlisted category must give fixed diagnostics');
    assert.match(first.message, expected);
  });
});

test('AI diagnostic allowlists require complete string matches instead of prefixes or arbitrary objects', async t => {
  const generic = await rejectedResponse(() => errorResponse({}));
  const cases = [
    { code: `model_not_found ${mockKey}`, param: `temperature ${chatMarker}` },
    { code: 'model_not_found\n', param: 'temperature\n' },
    { code: ['model_not_found'], param: ['temperature'] },
    { code: { value: 'model_not_found' }, param: { value: 'temperature' } },
    { message: 'model_not_found temperature', unrelated: { code: 'model_not_found', param: 'temperature' } },
  ];
  for (const [index, fields] of cases.entries()) await t.test(String(index), async () => {
    const error = await rejectedResponse(() => errorResponse({ error: fields }));
    assertSafeError(error);
    assert.equal(error.message, generic.message);
  });
});

test('AI error JSON is bounded at 16 KiB including ignored padding', async () => {
  const base = JSON.stringify({ error: { code: 'unsupported_parameter', param: 'temperature' }, padding: '' });
  const exact = base.replace('"padding":""', `"padding":"${'x'.repeat(16384 - Buffer.byteLength(base))}"`);
  assert.equal(Buffer.byteLength(exact), 16384);
  const atLimit = readerResponse([Buffer.from(exact)]);
  const known = await rejectedResponse(() => atLimit.response);
  assertSafeError(known); assert.match(known.message, /参数|温度|采样/);
  assert.equal(atLimit.observed.releases, 1);
  const tooLarge = readerResponse([Buffer.from(exact.slice(0, -1) + ' }')]);
  const fallback = await rejectedResponse(() => tooLarge.response);
  const generic = await rejectedResponse(() => errorResponse({}));
  assertSafeError(fallback);
  assert.equal(fallback.message, generic.message);
  assert.equal(tooLarge.observed.cancels, 1);
  assert.equal(tooLarge.observed.releases, 1);
});

test('AI error-body parse, read and cancellation failures safely retain HTTP status', async t => {
  const cases = [
    ['html', () => new Response(`<html>${rawMarker} ${mockKey} ${chatMarker}</html>`, { status: 400 })],
    ['invalid-json', () => new Response(`{"error":${mockKey}`, { status: 400 })],
    ['read-rejected', () => readerResponse([], { readError: `${mockKey} ${rawMarker}` }).response],
    ['cancel-rejected', () => readerResponse([Buffer.alloc(16385)], { cancelError: `${mockKey} ${rawMarker}` }).response],
  ];
  const generic = await rejectedResponse(() => errorResponse({}));
  for (const [name, factory] of cases) await t.test(name, async () => {
    const error = await rejectedResponse(factory);
    assertSafeError(error);
    assert.equal(error.message, generic.message);
  });
});

test('AI error diagnostics never invoke unbounded text/json fallback readers', async () => {
  let textCalls = 0, jsonCalls = 0;
  const error = await rejectedResponse(() => ({ ok: false, status: 400, headers: new Headers(),
    text: async () => { textCalls++; throw new Error(mockKey); },
    json: async () => { jsonCalls++; throw new Error(chatMarker); },
  }));
  assertSafeError(error);
  assert.equal(textCalls, 0); assert.equal(jsonCalls, 0);
});

test('AI stalled error read and stalled cancellation are bounded without network or retries', { timeout: 6500 }, async () => {
  const observed = { cancels: 0, releases: 0 };
  const stalledRead = { ok: false, status: 400, headers: new Headers(), body: { getReader: () => ({
    read: () => new Promise(() => {}),
    cancel: () => { observed.cancels++; return Promise.resolve(); },
    releaseLock: () => { observed.releases++; },
  }) } };
  const stalledCancel = readerResponse([Buffer.alloc(16385)], { cancelNeverResolves: true });
  const began = performance.now();
  const errors = await Promise.all([
    rejectedResponse(() => stalledRead),
    rejectedResponse(() => stalledCancel.response),
  ]);
  assert.ok(performance.now() - began < 3000, 'the 2-second diagnostic deadline allows only a small scheduling margin');
  for (const error of errors) assertSafeError(error);
  assert.equal(observed.cancels, 1); assert.equal(observed.releases, 1);
  assert.equal(stalledCancel.observed.cancels, 1); assert.equal(stalledCancel.observed.releases, 1);
});

test('AI stops on a rejected second chunk and never returns a partial summary or retries parameters', async () => {
  const value = prepared(`${chatMarker} `.repeat(1500));
  assert.ok(value.chunks.length > 2);
  let calls = 0;
  const error = await captureError(() => aiSummary(value, { ...options, fetch: async (_url, request) => {
    calls++;
    const body = JSON.parse(request.body);
    assert.equal(body.max_completion_tokens, 4096);
    assert.equal(body.temperature, undefined); assert.equal(body.max_tokens, undefined);
    return calls === 1 ? success() : errorResponse({ error: { code: 'unsupported_parameter', param: 'temperature', message: chatMarker } });
  } }));
  assert.equal(calls, 2);
  assertSafeError(error);
  assert.match(error.message, /第 2\/\d+ 段/);
  assert.match(error.message, /此前 1 段已完成/);
});

test('AI transport rejection is private and never automatically reissued', async () => {
  let calls = 0;
  const error = await captureError(() => aiSummary(prepared(), { ...options, fetch: async () => {
    calls++; throw new Error(`Authorization: Bearer ${mockKey}; ${chatMarker}`);
  } }));
  assert.equal(calls, 1);
  assert.match(error.message, /未自动重试/);
  assert.ok(!error.message.includes(mockKey)); assert.ok(!error.message.includes(chatMarker));
});
