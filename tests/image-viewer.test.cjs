'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { createImageViewer, normalizeSource, validateImage, defaultFilename, VIEWER_URL, CHANNEL } = require('../app/core/image-viewer.cjs');
const geometry = require('../app/renderer/image-viewer.js');

const source = 'app://media/' + 'a'.repeat(32) + '/group/123/message/0/original';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGpsAAAAASUVORK5CYII=', 'base64');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function heicHeader() {
  const bytes = Buffer.alloc(24); bytes.writeUInt32BE(24); bytes.write('ftyp', 4);
  bytes.write('heic', 8); bytes.write('mif1', 16); bytes.write('heix', 20); return bytes;
}

function fixture(options = {}) {
  const windows = [], handlers = new Map(), writes = [], dialogs = [];
  let owner = 'account-one|1', readCount = 0;
  class Window extends EventEmitter {
    constructor(config) {
      super(); this.config = config; this.destroyed = false; this.maximized = false; this.minimized = false; this.focused = false;
      this.wc = new EventEmitter(); this.wc.mainFrame = { url: VIEWER_URL }; this.wc.setWindowOpenHandler = handler => { this.openHandler = handler; };
      windows.push(this);
    }
    get webContents() { if (this.destroyed) throw new Error('Object destroyed'); return this.wc; }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return this.minimized; }
    restore() { this.minimized = false; }
    focus() { this.focused = true; }
    async loadURL(url) { this.url = url; if (options.loadURL) await options.loadURL(url); }
    show() { this.shown = true; }
    close() { if (!this.destroyed) { this.destroyed = true; this.emit('closed'); } }
    isMaximized() { return this.maximized; }
    maximize() { this.maximized = true; }
    unmaximize() { this.maximized = false; }
    minimize() { this.minimized = true; }
  }
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) };
  const manager = createImageViewer({
    BrowserWindow: Window, ipcMain, appRoot: path.join(__dirname, '../app'), getOwner: () => owner,
    getWorkArea: options.getWorkArea,
    dialog: { showSaveDialog: async (win, config) => { dialogs.push({ win, config }); return options.dialog ? options.dialog(win, config) : { canceled: true }; } },
    readImage: input => { readCount++; return options.readImage ? options.readImage(input) : { bytes: png, mime: 'image/png' }; },
    writeFile: options.writeFile || (async (file, bytes) => { writes.push({ file, bytes: Buffer.from(bytes) }); }),
  });
  return {
    manager, windows, handlers, writes, dialogs,
    setOwner: value => { owner = value; }, reads: () => readCount,
    event: (win = windows.at(-1)) => ({ sender: win.wc, senderFrame: win.wc.mainFrame }),
    call: (action, event) => handlers.get(CHANNEL)(event || { sender: windows.at(-1).wc, senderFrame: windows.at(-1).wc.mainFrame }, action),
  };
}

test('viewer source accepts only canonical original-image app proxies', () => {
  assert.equal(normalizeSource(source), source);
  assert.equal(normalizeSource(source.replace('/message/', '/post/')), source.replace('/message/', '/post/'));
  const encodedIds = source.replace('/group/123/', '/group%2Fa/message%2Fb/');
  assert.equal(normalizeSource(encodedIds), encodedIds);
  for (const invalid of [
    'https://wx1.sinaimg.cn/large/test.png', 'file:///C:/secret.png', 'data:image/png;base64,AA==',
    source.replace('media/', 'local/'), source.replace('/original', '/preview'), source + '?retry=1', source + '#anchor',
    source.replace('/group/', '/%00/'), source.replace('/0/', '/9999/'),
    source.replace('a'.repeat(32), 'another-account'), source.replace('app://', 'app://user@'),
  ]) assert.equal(normalizeSource(invalid), null, invalid);
});

test('actual MIME detection rejects HTML/SVG and mislabeled bytes, retaining supported original bytes', () => {
  assert.deepEqual(validateImage({ bytes: png, mime: 'image/png' }).bytes, png);
  const gif = Buffer.from('GIF89a mock animated bytes unchanged');
  assert.deepEqual(validateImage({ bytes: gif, mime: 'image/gif' }).bytes, gif);
  const webp = Buffer.from([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80]);
  assert.equal(validateImage({ bytes: webp, mime: 'image/webp' }).mime, 'image/webp');
  for (const value of [
    { bytes: Buffer.from('<svg/>'), mime: 'image/svg+xml' },
    { bytes: Buffer.from('<html>login</html>'), mime: 'image/png' },
    { bytes: png, mime: 'image/jpeg' },
    { bytes: new Uint8Array(png), mime: 'image/png' },
    { bytes: Buffer.alloc(21 * 1024 * 1024), mime: 'image/png' },
  ]) assert.throws(() => validateImage(value), /格式不受支持/);
});

test('suggested filename follows actual MIME rather than the remote URL extension', () => {
  assert.equal(defaultFilename('image/png', new Date('2026-10-20T10:20:30Z')), '微博图片-20261020-102030.png');
  assert.match(defaultFilename('image/jpeg'), /\.jpg$/);
});

test('HEIC original requires a validated PNG display and copies both byte sets', () => {
  const original = heicHeader(), display = Buffer.from(png);
  const value = validateImage({bytes: display, mime: 'image/png', original: {bytes: original, mime: 'image/heic'}});
  original.fill(0); display.fill(0);
  assert.deepEqual(value.bytes, png); assert.deepEqual(value.original.bytes, heicHeader());
  assert.equal(value.original.mime, 'image/heic');
  for (const original of [
    null, {}, {mime: 'image/heic'}, {bytes: png, mime: 'image/heic'},
    {bytes: heicHeader(), mime: 'image/jpeg'}, {bytes: Buffer.from('<html/>'), mime: 'image/heic'},
    {bytes: Buffer.alloc(20 * 1024 * 1024 + 1), mime: 'image/heic'},
  ]) assert.throws(() => validateImage({bytes: png, mime: 'image/png', original}));
  assert.throws(() => validateImage({bytes: heicHeader(), mime: 'image/heic'}));
  assert.throws(() => validateImage({bytes: Buffer.from('GIF89a'), mime: 'image/gif',
    original: {bytes: heicHeader(), mime: 'image/heic'}}));
});

test('converted PNG and downloaded HEIC have separate bounded sizes', () => {
  const largeDisplay = Buffer.alloc(21 * 1024 * 1024); png.copy(largeDisplay);
  assert.throws(() => validateImage({bytes: largeDisplay, mime: 'image/png'}));
  const value = validateImage({bytes: largeDisplay, mime: 'image/png', original: {bytes: heicHeader(), mime: 'image/heic'}});
  assert.equal(value.bytes.length, largeDisplay.length);
  const tooLarge = Buffer.alloc(64 * 1024 * 1024 + 1); png.copy(tooLarge);
  assert.throws(() => validateImage({bytes: tooLarge, mime: 'image/png', original: {bytes: heicHeader(), mime: 'image/heic'}}));
});

test('viewer renders converted PNG but saves unchanged HEIC with its actual extension', async () => {
  for (const extension of ['heic', 'heif']) {
    const original = heicHeader(), target = path.resolve(os.tmpdir(), 'converted.' + extension);
    const f = fixture({readImage: () => ({bytes: png, mime: 'image/png', original: {bytes: original, mime: 'image/heic'}}),
      dialog: () => ({canceled: false, filePath: target})});
    await f.manager.open({source});
    const loaded = await f.call('load');
    assert.equal(loaded.ok, true); assert.equal(loaded.value.mime, 'image/png');
    assert.equal(loaded.value.originalMime, 'image/heic'); assert.equal(loaded.value.byteLength, original.length);
    assert.equal(loaded.value.dataUrl, 'data:image/png;base64,' + png.toString('base64'));
    original.fill(0);
    const saved = await f.call('save');
    assert.equal(saved.ok, true); assert.equal(saved.value.mime, 'image/heic');
    assert.deepEqual(f.writes[0].bytes, heicHeader());
    assert.match(f.dialogs[0].config.defaultPath, /\.heic$/);
    assert.deepEqual(f.dialogs[0].config.filters[0].extensions, ['heic', 'heif']);
    f.manager.dispose();
  }
  const f = fixture({readImage: () => ({bytes: png, mime: 'image/png', original: {bytes: heicHeader(), mime: 'image/heic'}}),
    dialog: () => ({canceled: false, filePath: path.resolve(os.tmpdir(), 'wrong.jpg')})});
  await f.manager.open({source}); await f.call('load');
  assert.equal((await f.call('save')).ok, false); assert.equal(f.writes.length, 0); f.manager.dispose();
});

test('HEIC original cannot be saved after an account change during its save dialog', async () => {
  const gate = deferred(), f = fixture({
    readImage: () => ({bytes: png, mime: 'image/png', original: {bytes: heicHeader(), mime: 'image/heic'}}),
    dialog: () => gate.promise,
  });
  await f.manager.open({source}); await f.call('load');
  const pending = f.call('save'); f.setOwner('other-account');
  gate.resolve({canceled: false, filePath: path.resolve(os.tmpdir(), 'stale.heic')});
  assert.equal((await pending).ok, false); assert.equal(f.writes.length, 0); f.manager.dispose();
});

test('opens large, frameless but resizable isolated viewer with a dedicated preload', async () => {
  const f = fixture(); await f.manager.open({ source, title: '图片 <script>', caption: '测试成员' });
  const win = f.windows[0];
  assert.equal(win.config.frame, false); assert.equal(win.config.resizable, true);
  assert.equal(win.config.width, 1280); assert.equal(win.config.height, 920);
  assert.equal(win.config.minWidth, 640); assert.equal(win.config.minHeight, 480);
  assert.equal(win.config.webPreferences.sandbox, true); assert.equal(win.config.webPreferences.contextIsolation, true);
  assert.equal(win.config.webPreferences.nodeIntegration, false); assert.equal(win.config.webPreferences.webSecurity, true);
  assert.match(win.config.webPreferences.preload, /image-viewer-preload\.cjs$/);
  assert.equal(win.url, VIEWER_URL); assert.equal(win.shown, true); assert.deepEqual(win.openHandler(), { action: 'deny' });
  let prevented = 0;
  win.wc.emit('will-navigate', { preventDefault: () => prevented++ });
  win.wc.emit('will-attach-webview', { preventDefault: () => prevented++ });
  assert.equal(prevented, 2);
  const result = await f.call('load');
  assert.equal(result.ok, true); assert.equal(result.value.title, '图片 <script>');
  assert.deepEqual(Buffer.from(result.value.dataUrl.split(',')[1], 'base64'), png);
  f.manager.dispose();
});

test('viewer adapts to available small screen, not larger than its work area', async () => {
  const f = fixture({ getWorkArea: () => ({ width: 1024, height: 720 }) });
  await f.manager.open({ source });
  assert.equal(f.windows[0].config.width, 984); assert.equal(f.windows[0].config.height, 680);
  f.manager.dispose();
});

test('untrusted webContents, wrong frame and wrong document cannot load or save', async () => {
  const f = fixture(); await f.manager.open({ source });
  assert.equal((await f.call('load', { sender: {}, senderFrame: {} })).ok, false);
  assert.equal((await f.call('load', { sender: f.windows[0].wc, senderFrame: { url: VIEWER_URL } })).ok, false);
  f.windows[0].wc.mainFrame.url = 'https://example.com/';
  assert.equal((await f.call('save')).ok, false);
  assert.equal(f.reads(), 0); assert.equal(f.dialogs.length, 0); assert.equal(f.writes.length, 0);
  f.manager.dispose();
});

test('account change invalidates a viewer even if caller forgot to close it', async () => {
  const f = fixture(); await f.manager.open({ source }); f.setOwner('account-two|2');
  assert.match((await f.call('load')).error, /账号或图片窗口已变化/);
  assert.equal(f.reads(), 0); f.manager.dispose();
});

test('loading twice shares one in-flight read and closed viewer cannot receive late content', async () => {
  const gate = deferred(), f = fixture({ readImage: () => gate.promise });
  await f.manager.open({ source }); const one = f.call('load'), two = f.call('load');
  await Promise.resolve();
  assert.equal(f.reads(), 1);
  f.manager.closeAll(); gate.resolve({ bytes: png, mime: 'image/png' });
  assert.match((await one).error, /账号或图片窗口已变化/);
  assert.match((await two).error, /账号或图片窗口已变化/);
  assert.equal(f.windows[0].destroyed, true); f.manager.dispose();
});

test('manual retry performs a new read after a failure and does not expose transport details', async () => {
  let reads = 0;
  const f = fixture({ readImage: () => { if (++reads === 1) throw new Error('Cookie=secret https://private'); return { bytes: png, mime: 'image/png' }; } });
  await f.manager.open({ source });
  const failed = await f.call('load'); assert.equal(failed.ok, false); assert.doesNotMatch(failed.error, /secret|private/);
  assert.equal((await f.call('retry')).ok, true); assert.equal(reads, 2);
  assert.equal((await f.call('load')).ok, true); assert.equal(reads, 2);
  f.manager.dispose();
});

test('canceling native save dialog writes nothing and keeps original loaded image', async () => {
  const f = fixture(); await f.manager.open({ source }); await f.call('load');
  assert.deepEqual((await f.call('save')).value, { canceled: true });
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.dialogs[0].config.filters, [{ name: 'PNG 图片', extensions: ['png'] }]);
  assert.ok(f.dialogs[0].config.properties.includes('showOverwriteConfirmation'));
  assert.equal(f.dialogs[0].win, f.windows[0]);
  assert.equal((await f.call('load')).ok, true);
  f.manager.dispose();
});

test('system-selected path receives original bytes unchanged, with no renderer-selected path', async () => {
  const target = path.resolve(os.tmpdir(), 'weiyue-viewer-original.png');
  const f = fixture({ dialog: () => ({ canceled: false, filePath: target }) });
  await f.manager.open({ source }); await f.call('load');
  const result = await f.call('save');
  assert.deepEqual(result.value, { saved: true, name: 'weiyue-viewer-original.png', mime: 'image/png', bytes: png.length });
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].file, target); assert.deepEqual(f.writes[0].bytes, png);
  f.manager.dispose();
});

test('an account change while native save dialog is open cannot write the previous image', async () => {
  const gate = deferred(), f = fixture({ dialog: () => gate.promise });
  await f.manager.open({ source }); await f.call('load');
  const saving = f.call('save'); f.setOwner('new-account|3');
  gate.resolve({ canceled: false, filePath: path.resolve(os.tmpdir(), 'old-account.png') });
  assert.match((await saving).error, /账号或图片窗口已变化/); assert.equal(f.writes.length, 0);
  f.manager.dispose();
});

test('save dialogs cannot overlap, and reload during an open save dialog does not replace saved bytes', async () => {
  const gate = deferred(), f = fixture({ dialog: () => gate.promise });
  await f.manager.open({ source }); await f.call('load');
  const saving = f.call('save');
  assert.equal((await f.call('save')).ok, false); assert.equal((await f.call('retry')).ok, false);
  assert.equal(f.dialogs.length, 1); assert.equal(f.reads(), 1);
  gate.resolve({ canceled: true }); await saving; f.manager.dispose();
});

test('wrong extension and write failures do not pretend to succeed or disclose filesystem paths', async () => {
  const f = fixture({ dialog: () => ({ canceled: false, filePath: path.resolve(os.tmpdir(), 'image.jpg') }) });
  await f.manager.open({ source }); await f.call('load');
  assert.match((await f.call('save')).error, /请使用 \.png/); assert.equal(f.writes.length, 0); f.manager.dispose();
  const g = fixture({ dialog: () => ({ canceled: false, filePath: path.resolve(os.tmpdir(), 'image.png') }),
    writeFile: () => { throw new Error('permission denied C:/private/secret'); } });
  await g.manager.open({ source }); await g.call('load');
  assert.match((await g.call('save')).error, /保存失败/); assert.doesNotMatch((await g.call('save')).error, /private|secret/);
  g.manager.dispose();
});

test('actual local save keeps every source byte, including metadata and animation payload', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'weiyue-viewer-test-'));
  const target = path.join(dir, 'animation.gif'), bytes = Buffer.from('GIF89a synthetic animation payload with metadata 0000');
  const f = fixture({ readImage: () => ({ bytes, mime: 'image/gif' }), dialog: () => ({ canceled: false, filePath: target }), writeFile: fs.writeFile });
  try {
    await f.manager.open({ source }); await f.call('load');
    assert.equal((await f.call('save')).ok, true);
    assert.deepEqual(await fs.readFile(target), bytes);
  } finally {
    f.manager.dispose();
    await fs.unlink(target).catch(() => {}); await fs.rmdir(dir);
  }
});

test('same image focuses existing viewer, different image replaces it, Esc and dispose release records', async () => {
  const f = fixture(); await f.manager.open({ source }); await f.manager.open({ source });
  assert.equal(f.windows.length, 1); assert.equal(f.windows[0].focused, true);
  await f.manager.open({ source: source.replace('/123/', '/456/') });
  assert.equal(f.windows.length, 2); assert.equal(f.windows[0].destroyed, true);
  let prevented = false;
  f.windows[1].wc.emit('before-input-event', { preventDefault: () => { prevented = true; } }, { type: 'keyDown', key: 'Escape' });
  assert.equal(prevented, true); assert.equal(f.windows[1].destroyed, true);
  f.manager.dispose(); assert.equal(f.handlers.has(CHANNEL), false);
  await assert.rejects(() => f.manager.open({ source }), /已变化/);
});

test('maximize, restore and minimize controls work through the isolated bridge', async () => {
  const f = fixture(); await f.manager.open({ source });
  await f.call('maximize'); assert.equal(f.windows[0].maximized, true);
  await f.call('maximize'); assert.equal(f.windows[0].maximized, false);
  await f.call('minimize'); assert.equal(f.windows[0].minimized, true);
  await f.manager.open({ source }); assert.equal(f.windows[0].minimized, false);
  await f.call('close'); assert.equal(f.windows[0].destroyed, true);
  f.manager.dispose();
});

test('fit centers small images at original size and fits tall images below one percent', () => {
  const small = geometry.fit(100, 50, 1000, 500);
  assert.equal(small.scale, 1); assert.equal(small.x, 450); assert.equal(small.y, 225);
  const tall = geometry.fit(1000, 100000, 1000, 500);
  assert.equal(tall.scale, .005); assert.equal(tall.ih * tall.scale, tall.vh);
  assert.equal(geometry.zoom(tall, 0).scale, .005);
});

test('zoom preserves cursor image location until pan bounds are reached', () => {
  let state = geometry.fit(2000, 1200, 1000, 600);
  state = geometry.zoom(state, 1, 400, 200);
  assert.equal(state.x, -400); assert.equal(state.y, -200);
  assert.equal((400 - state.x) / state.scale, 800);
  assert.equal((200 - state.y) / state.scale, 400);
});

test('pan clamps to image edges and resizing preserves center while enforcing bounds', () => {
  const fit = geometry.fit(2000, 1200, 1000, 600), original = geometry.zoom(fit, 1);
  const end = geometry.pan(original, -99999, -99999);
  assert.equal(end.x, -1000); assert.equal(end.y, -600);
  const start = geometry.pan(end, 99999, 99999);
  assert.equal(start.x, 0); assert.equal(start.y, 0);
  const resized = geometry.resize(original, 800, 400);
  assert.equal((400 - resized.x) / resized.scale, 1000);
  assert.equal((200 - resized.y) / resized.scale, 600);
  assert.equal(geometry.zoom(original, 100).scale, 16);
});
