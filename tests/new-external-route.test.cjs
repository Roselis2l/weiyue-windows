'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { normalizeHttpUrl } = require('../app/renderer/linkify.js');

// Evaluate the actual external.open branch, with a shell recorder. The Electron
// entry point is never launched and no browser, profile or network is used.
const source = fs.readFileSync(path.join(__dirname, '../app/main.cjs'), 'utf8');
const marker = "case 'external.open':{";
const start = source.indexOf(marker);
const end = source.indexOf("\n    default:", start);
assert.ok(start > 0 && end > start, 'external.open branch must be extracted from actual main');
const branch = source.slice(start + marker.length, end).trim();
assert.ok(branch.endsWith('}'));
function fixture(openExternal = async () => {}) {
  const calls = [];
  const route = vm.runInNewContext('(async function(p){' + branch.slice(0, -1) + '})', {
    normalizeHttpUrl,
    shell: { openExternal: async url => { calls.push(url); return openExternal(url); } },
  });
  return { calls, route };
}

test('actual main external route independently normalizes legal HTTP and HTTPS URLs', async () => {
  const f = fixture();
  for (const url of [
    'https://example.com/a?one=1&two=2#section',
    'HTTP://EXAMPLE.COM/中文?q=一',
    'https://weibo.com/123/AbCd?from=chat',
    'http://[::1]:8080/a(b)',
  ]) {
    assert.equal(await f.route({ url }), true);
    assert.equal(f.calls.at(-1), new URL(url).href);
  }
  assert.equal(f.calls.length, 4);
});

test('actual main route rejects unsafe schemes before shell invocation', async () => {
  const f = fixture();
  for (const url of [
    'javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'file:///C:/Windows/System32/cmd.exe',
    'data:text/html,<script>alert(1)</script>', 'mailto:test@example.com', 'ftp://example.com',
    'app://local/index.html', 'ms-settings:privacy', 'shell:AppsFolder', '//example.com',
    'https:example.com', ' https://example.com', 'https://', '',
  ]) await assert.rejects(f.route({ url }), /HTTP/);
  assert.deepEqual(f.calls, []);
});

test('actual main route rejects credentials, backslashes, newline and control character tricks', async () => {
  const f = fixture();
  for (const url of [
    'https://user:pass@example.com/a', 'https://trusted.example@evil.example',
    'https://example.com\\@evil.example', 'https://example.com\n',
    '\nhttps://example.com', 'https://example.com/\r\n--command',
    'https://example.com/\t', 'https://example.com/\u0000', 'https://example.com/\u0085',
    'https://example.com/' + 'a'.repeat(4096),
  ]) await assert.rejects(f.route({ url }), /HTTP/);
  assert.deepEqual(f.calls, []);
});

test('actual main route rejects non-string payloads without coerced user code', async () => {
  const f = fixture();
  let coerced = false;
  for (const url of [undefined, null, 1, ['https://example.com'], {
    toString() { coerced = true; return 'https://example.com'; },
  }]) await assert.rejects(f.route({ url }), /HTTP/);
  assert.equal(coerced, false);
  assert.deepEqual(f.calls, []);
});

test('actual main route opens exactly once and waits for shell completion', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const f = fixture(() => pending);
  let finished = false;
  const task = f.route({ url: 'https://example.com/' }).then(value => { finished = true; return value; });
  await Promise.resolve();
  assert.equal(finished, false);
  assert.deepEqual(f.calls, ['https://example.com/']);
  resolve();
  assert.equal(await task, true);
  assert.equal(finished, true);
});

test('shell failures remain failures and are never treated as successful browser opens', async () => {
  const f = fixture(async () => { throw Error('synthetic shell failure'); });
  await assert.rejects(f.route({ url: 'https://example.com/' }), /synthetic shell failure/);
  assert.equal(f.calls.length, 1);
});

function ipcFixture() {
  const prefix = "ipcMain.handle('weiyue:call',";
  const a = source.indexOf(prefix), b = source.indexOf('\n  });', a);
  assert.ok(a > 0 && b > a, 'actual main IPC boundary must be extracted');
  const callback = source.slice(a + prefix.length, b + 4);
  const frame = { url: 'app://local/index.html' };
  const contents = { mainFrame: frame };
  const calls = [];
  const handler = vm.runInNewContext('(' + callback + ')', {
    win: { webContents: contents },
    handle: async (action, payload) => { calls.push({ action, payload }); return true; },
    secrets: () => ({}), redact: value => value,
  });
  return { handler, frame, contents, calls };
}

test('actual main IPC boundary allows external route only from trusted main renderer frame', async () => {
  const f = ipcFixture(), payload = { url: 'https://example.com/' };
  const allowed = await f.handler({ sender: f.contents, senderFrame: f.frame }, 'external.open', payload);
  assert.equal(allowed.ok, true);
  assert.equal(f.calls.length, 1);
  for (const event of [
    { sender: {}, senderFrame: f.frame },
    { sender: f.contents, senderFrame: { url: 'app://local/index.html' } },
    { sender: f.contents, senderFrame: { url: 'https://example.com/' } },
  ]) assert.equal((await f.handler(event, 'external.open', payload)).ok, false);
  f.frame.url = 'app://local/image-viewer.html';
  assert.equal((await f.handler({ sender: f.contents, senderFrame: f.frame }, 'external.open', payload)).ok, false);
  assert.equal(f.calls.length, 1);
});

test('actual main IPC boundary rejects malformed payloads before routing', async () => {
  const f = ipcFixture(), event = { sender: f.contents, senderFrame: f.frame };
  for (const payload of [null, 'https://example.com', [], { url: 'a'.repeat(100001) }]) {
    assert.equal((await f.handler(event, 'external.open', payload)).ok, false);
  }
  assert.equal(f.calls.length, 0);
});
