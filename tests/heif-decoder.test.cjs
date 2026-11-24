'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const vm = require('node:vm');
const { createHeifDecoder, exactBytes, pngResult, validDimensions, allowedResource,
  MAX_BYTES, MAX_OUTPUT_BYTES, PAGE, QUEUE_LIMIT, CSP } = require('../app/core/heif-decoder.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function png(width = 1, height = 1) {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.write('IHDR', 12); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  return { bytes, mime: 'image/png', width, height };
}
function harness() {
  const windows = [], sessions = [], ipcMain = new EventEmitter();
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.dead = false; this.webContents = new EventEmitter();
      this.webContents.mainFrame = { url: PAGE };
      this.webContents.setWindowOpenHandler = fn => { this.openHandler = fn; };
      this.webContents.send = (channel, payload) => { this.sent = { channel, payload }; };
      windows.push(this);
    }
    loadURL(url) { this.url = url; return Promise.resolve(); }
    isDestroyed() { return this.dead; }
    destroy() { this.dead = true; this.emit('closed'); }
  }
  const session = { fromPartition(name, options) {
    const s = new EventEmitter(); s.name = name; s.options = options;
    s.setPermissionRequestHandler = fn => s.permission = fn;
    s.setPermissionCheckHandler = fn => s.permissionCheck = fn;
    s.webRequest = { onBeforeRequest(fn) { s.before = fn; } };
    s.protocol = { handle(_scheme, fn) { s.handler = fn; }, unhandle() { s.unhandled = true; } };
    s.clearStorageData = () => { s.cleared = (s.cleared || 0) + 1; return Promise.resolve(); };
    sessions.push(s); return s;
  }};
  const service = createHeifDecoder({ BrowserWindow, ipcMain, session, appRoot: path.resolve('app') });
  const channel = ipcMain.eventNames()[0];
  function send(window, payload, event = {}) {
    ipcMain.emit(channel, { sender: window.webContents, senderFrame: window.webContents.mainFrame, ...event }, payload);
  }
  function ready(window = windows.at(-1)) { send(window, { type: 'ready' }); return window.sent.payload; }
  function result(window = windows.at(-1), value = png()) {
    send(window, { type: 'result', id: window.sent.payload.id, ...value });
  }
  return { service, windows, sessions, ipcMain, channel, send, ready, result, BrowserWindow, session };
}
test('byte inputs use intrinsic exact view boundaries and reject spoofed/non-byte/oversized data', () => {
  const original = Buffer.from([7, 1, 2, 3, 8]);
  assert.deepEqual(exactBytes(original.subarray(1, 4)), Buffer.from([1, 2, 3]));
  assert.deepEqual(exactBytes(vm.runInNewContext('new Uint8Array([4,5])')), Buffer.from([4, 5]));
  const shadowed = Uint8Array.from([8, 9]);
  for (const field of ['length', 'byteLength', 'byteOffset', 'buffer']) Object.defineProperty(shadowed, field, { get() { throw Error('private'); } });
  assert.deepEqual(exactBytes(shadowed), Buffer.from([8, 9]));
  for (const value of ['secret', [], new DataView(new ArrayBuffer(4)), { [Symbol.toStringTag]: 'Uint8Array' }, Buffer.alloc(0), Buffer.alloc(MAX_BYTES + 1)])
    assert.throws(() => exactBytes(value), error => ['HEIF_INVALID', 'HEIF_TOO_LARGE'].includes(error.code));
});
test('dimensions and PNG responses remain bounded and must agree with IHDR', () => {
  assert.equal(validDimensions(32768, 1), true); assert.equal(validDimensions(32769, 1), false);
  assert.equal(validDimensions(8192, 8192), false); assert.equal(validDimensions(1, 0), false);
  assert.deepEqual(pngResult(png()), png());
  for (const payload of [{ ...png(), width: 2 }, { ...png(), mime: 'image/jpeg' }, { ...png(), bytes: Buffer.alloc(24) },
    { ...png(), bytes: Buffer.alloc(MAX_OUTPUT_BYTES + 1) }]) assert.throws(() => pngResult(payload));
});
test('only fixed local decoder resource paths are allowed; CSP permits WASM but not JS eval', () => {
  for (const url of [PAGE, 'app://decoder/heif.js', 'app://decoder/heif-worker.js', 'app://decoder/libheif/libheif-bundle.js'])
    assert.equal(allowedResource(url), true);
  for (const url of ['https://example.test', 'file:///C:/secret', 'app://local/index.html', PAGE + '?x=1', PAGE + '#x',
    'app://decoder/private.json', 'app://user@decoder/heif.html']) assert.equal(allowedResource(url), false);
  assert.equal(CSP.includes("'wasm-unsafe-eval'"), true); assert.equal(CSP.includes("'unsafe-eval'"), false);
});
test('decoder creates nonpersistent isolated sandbox and denies permissions/network/downloads', async () => {
  const h = harness(), promise = h.service.decode(Buffer.from([1]));
  const w = h.windows[0], s = h.sessions[0];
  assert.equal(s.name.startsWith('persist:'), false);
  assert.equal(w.options.show, false); assert.equal(w.options.webPreferences.sandbox, true);
  assert.equal(w.options.webPreferences.nodeIntegration, false); assert.equal(w.options.webPreferences.contextIsolation, true);
  assert.equal(w.options.webPreferences.session, s); assert.equal(s.permissionCheck(), false);
  let permitted; s.permission(null, 'camera', value => permitted = value); assert.equal(permitted, false);
  let blocked; s.before({ url: 'https://example.test' }, result => blocked = result.cancel); assert.equal(blocked, true);
  let stopped = false; s.emit('will-download', { preventDefault() { stopped = true; } }); assert.equal(stopped, true);
  h.ready(); h.result(); await promise; assert.equal(w.dead, true); assert.equal(s.cleared, 1); h.service.dispose();
});
test('wrong renderer/frame/id never starts or completes job; ready may send bytes only once', async () => {
  const h = harness(), promise = h.service.decode(Buffer.from([1, 2, 3])), w = h.windows[0];
  h.send(w, { type: 'ready' }, { senderFrame: { url: PAGE } }); assert.equal(w.sent, undefined);
  h.send(w, { type: 'ready' }, { sender: new EventEmitter() }); assert.equal(w.sent, undefined);
  h.ready(); const sent = w.sent; h.ready(); assert.equal(w.sent, sent);
  h.send(w, { type: 'result', id: 'wrong', ...png() }); assert.equal(w.dead, false);
  h.result(); await promise; h.service.dispose();
});
test('concurrent jobs run serially with new windows and a bounded reusable decoder-only session', async () => {
  const h = harness(), first = h.service.decode(Buffer.from([1])), second = h.service.decode(Buffer.from([2]));
  assert.equal(h.windows.length, 1); h.ready(); h.result(); await first; await tick();
  assert.equal(h.windows.length, 2); assert.equal(h.sessions.length, 1);
  assert.equal(h.windows[0].options.webPreferences.session, h.windows[1].options.webPreferences.session);
  assert.deepEqual(Buffer.from(h.ready().bytes), Buffer.from([2])); h.result(); await second; h.service.dispose();
});
test('abort active and queued work destroys process and never delivers late output', async () => {
  const h = harness(), a = new AbortController(), b = new AbortController();
  const first = h.service.decode(Buffer.from([1]), { signal: a.signal });
  const second = h.service.decode(Buffer.from([2]), { signal: b.signal });
  const rejects = [assert.rejects(first, { code: 'HEIF_ABORT' }), assert.rejects(second, { code: 'HEIF_ABORT' })];
  b.abort(); a.abort(); await Promise.all(rejects); await tick();
  assert.equal(h.windows.length, 1); assert.equal(h.windows[0].dead, true); h.service.dispose();
});
test('close wipes all work, may reuse service; dispose removes listener and rejects future input', async () => {
  const h = harness(), first = h.service.decode(Buffer.from([1])), second = h.service.decode(Buffer.from([2]));
  const rejects = [assert.rejects(first, { code: 'HEIF_ABORT' }), assert.rejects(second, { code: 'HEIF_ABORT' })];
  h.service.close(); await Promise.all(rejects); await tick(); assert.equal(h.windows.length, 1);
  const next = h.service.decode(Buffer.from([3])); h.ready(); h.result(); await next;
  h.service.dispose(); assert.equal(h.ipcMain.listenerCount(h.channel), 0);
  await assert.rejects(h.service.decode(Buffer.from([4])), { code: 'HEIF_ABORT' });
});
test('queue limit prevents unlimited byte retention and errors remain fixed', async () => {
  const h = harness(), jobs = [];
  for (let i = 0; i <= QUEUE_LIMIT; i++) jobs.push(h.service.decode(Buffer.from([i])));
  await assert.rejects(h.service.decode(Buffer.from([3])), { code: 'HEIF_BUSY' });
  const rejected = jobs.map(job => assert.rejects(job, { code: 'HEIF_ABORT' }));
  h.service.dispose(); await Promise.all(rejected);
});
test('20 second absolute timeout destroys a stalled decoder and clears queued work', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(), first = h.service.decode(Buffer.from([1])), second = h.service.decode(Buffer.from([2]));
  const rejected = [assert.rejects(first, { code: 'HEIF_TIMEOUT' }), assert.rejects(second, { code: 'HEIF_TIMEOUT' })];
  t.mock.timers.tick(20000);
  await Promise.all(rejected); await tick();
  assert.equal(h.windows.length, 1); assert.equal(h.windows[0].dead, true);
  h.service.dispose();
});
test('account service replacement reuses one session and does not multiply download listeners', async () => {
  const h = harness(), first = h.service.decode(Buffer.from([1]));
  h.ready(); h.result(); await first; h.service.dispose();
  const replacement = createHeifDecoder({ BrowserWindow: h.BrowserWindow, ipcMain: h.ipcMain,
    session: h.session, appRoot: path.resolve('app') });
  const second = replacement.decode(Buffer.from([2])), window = h.windows.at(-1);
  const channel = h.ipcMain.eventNames()[0];
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  h.ipcMain.emit(channel, event, { type: 'ready' });
  h.ipcMain.emit(channel, event, { type: 'result', id: window.sent.payload.id, ...png() });
  await second;
  assert.equal(h.sessions.length, 1); assert.equal(h.sessions[0].listenerCount('will-download'), 1);
  assert.equal(h.sessions[0].cleared, 2); replacement.dispose();
});
