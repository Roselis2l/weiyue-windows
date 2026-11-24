'use strict';

// Isolated local HEIC decoding. The decoder process receives only an exact
// byte copy, never a filename, account, remote URL or authenticated session.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { types } = require('node:util');
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_PIXELS = 32000000;
const MAX_EDGE = 32768;
const TIMEOUT_MS = 20000;
const QUEUE_LIMIT = 8;
const PAGE = 'app://decoder/heif.html';
const MIME = 'image/png';
const CSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'none'; img-src 'none'; style-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
const ASSETS = Object.freeze({
  '/heif.html': ['heif.html', 'text/html; charset=utf-8'],
  '/heif.js': ['heif.js', 'text/javascript; charset=utf-8'],
  '/heif-worker.js': ['heif-worker.js', 'text/javascript; charset=utf-8'],
  '/libheif/libheif-bundle.js': ['libheif/libheif-bundle.js', 'text/javascript; charset=utf-8'],
});
const SAFE_CODES = new Set(['HEIF_INVALID', 'HEIF_TOO_LARGE', 'HEIF_DECODE', 'HEIF_ABORT', 'HEIF_TIMEOUT', 'HEIF_BUSY']);
const byteArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const getLength = Object.getOwnPropertyDescriptor(byteArrayPrototype, 'byteLength').get;
const getOffset = Object.getOwnPropertyDescriptor(byteArrayPrototype, 'byteOffset').get;
const getBuffer = Object.getOwnPropertyDescriptor(byteArrayPrototype, 'buffer').get;
// Electron retains a BrowserContext for each partition until process exit.
// Reuse one decoder-only memory session per application root, including after
// account switches create a fresh service. Each task still gets a new window
// and Worker, both destroyed on completion/cancellation.
const decoderSessions = new WeakMap();
class HeifError extends Error {
  constructor(code) {
    super(code === 'HEIF_TIMEOUT' ? 'HEIC 图片解码超时。' :
      code === 'HEIF_ABORT' ? 'HEIC 图片解码已取消。' :
      code === 'HEIF_TOO_LARGE' ? 'HEIC 图片尺寸或大小超出限制。' :
      code === 'HEIF_BUSY' ? 'HEIC 图片队列已满，请稍后重试。' : 'HEIC 图片无法解码。');
    this.name = 'HeifError'; this.code = SAFE_CODES.has(code) ? code : 'HEIF_DECODE';
  }
}
function exactBytes(value, maxBytes = MAX_BYTES) {
  if (!types.isUint8Array(value)) throw new HeifError('HEIF_INVALID');
  const length = Reflect.apply(getLength, value, []);
  if (!length || length > maxBytes) throw new HeifError('HEIF_TOO_LARGE');
  return Buffer.from(new Uint8Array(Reflect.apply(getBuffer, value, []), Reflect.apply(getOffset, value, []), length));
}
function validDimensions(width, height) {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) &&
    width > 0 && height > 0 && width <= MAX_EDGE && height <= MAX_EDGE && width * height <= MAX_PIXELS;
}
function pngResult(payload) {
  if (!payload || typeof payload !== 'object' || payload.mime !== MIME ||
      !validDimensions(payload.width, payload.height)) throw new HeifError('HEIF_DECODE');
  const bytes = exactBytes(payload.bytes, MAX_OUTPUT_BYTES);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.toString('ascii', 12, 16) !== 'IHDR' ||
      bytes.readUInt32BE(16) !== payload.width || bytes.readUInt32BE(20) !== payload.height) throw new HeifError('HEIF_DECODE');
  return { bytes, mime: MIME, width: payload.width, height: payload.height };
}
function allowedResource(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'app:' && u.host === 'decoder' && !u.username && !u.password && !u.port &&
      !u.search && !u.hash && Object.hasOwn(ASSETS, u.pathname);
  } catch { return false; }
}
function getDecoderSession(session, appRoot) {
  let roots = decoderSessions.get(session);
  if (!roots) { roots = new Map(); decoderSessions.set(session, roots); }
  const root = path.resolve(appRoot);
  if (roots.has(root)) return roots.get(root);
  const name = 'weiyue-heif-offline-' + crypto.createHash('sha256').update(root).digest('hex').slice(0, 16);
  const decoderSession = session.fromPartition(name, { cache: false });
  decoderSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  decoderSession.setPermissionCheckHandler(() => false);
  decoderSession.on('will-download', event => event.preventDefault());
  decoderSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !allowedResource(details.url) }));
  decoderSession.protocol.handle('app', request => {
    if (request.method !== 'GET' || !allowedResource(request.url)) return new Response('', { status: 404 });
    const asset = ASSETS[new URL(request.url).pathname];
    try {
      return new Response(fs.readFileSync(path.join(root, 'decoder', asset[0])), {
        headers: { 'Content-Type': asset[1], 'Content-Security-Policy': CSP,
          'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' },
      });
    } catch { return new Response('', { status: 404 }); }
  });
  roots.set(root, decoderSession);
  return decoderSession;
}

function createHeifDecoder({ BrowserWindow, ipcMain, session, appRoot } = {}) {
  if (typeof BrowserWindow !== 'function' || typeof ipcMain?.on !== 'function' ||
      typeof ipcMain?.removeListener !== 'function' || typeof appRoot !== 'string' || !path.isAbsolute(appRoot))
    throw new HeifError('HEIF_INVALID');
  session ||= require('electron').session;
  if (typeof session?.fromPartition !== 'function') throw new HeifError('HEIF_INVALID');
  const channel = 'weiyue:heif:' + crypto.randomUUID();
  const queue = [];
  let active;
  function finish(job, error, value) {
    if (job.settled) return;
    job.settled = true; clearTimeout(job.timer);
    job.signal?.removeEventListener('abort', job.onAbort);
    const index = queue.indexOf(job); if (index >= 0) queue.splice(index, 1);
    job.bytes = null;
    if (job.window && !job.window.isDestroyed()) job.window.destroy();
    // The decoder does not create cookies/storage, but clear any renderer-side
    // state as defense in depth. This session is never shared with the app UI,
    // a login window, or an authenticated account.
    try { Promise.resolve(job.session?.clearStorageData()).catch(() => {}); } catch {}
    if (active === job) active = null;
    error ? job.reject(error) : job.resolve(value);
    queueMicrotask(startNext);
  }
  function startNext() {
    if (active || !queue.length) return;
    const job = queue.shift();
    if (job.settled) { queueMicrotask(startNext); return; }
    active = job;
    if (job.signal?.aborted) { finish(job, new HeifError('HEIF_ABORT')); return; }
    try {
      const decoderSession = getDecoderSession(session, appRoot);
      job.session = decoderSession;
      const window = new BrowserWindow({
        show: false, width: 32, height: 32, skipTaskbar: true,
        webPreferences: { session: decoderSession, preload: path.join(appRoot, 'heif-decoder-preload.cjs'),
          additionalArguments: ['--weiyue-heif-channel=' + channel],
          contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
          backgroundThrottling: false, devTools: false, spellcheck: false },
      });
      job.window = window;
      const contents = window.webContents;
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      contents.on('will-navigate', event => event.preventDefault());
      contents.on('will-attach-webview', event => event.preventDefault());
      contents.on('render-process-gone', () => finish(job, new HeifError('HEIF_DECODE')));
      window.on('closed', () => finish(job, new HeifError('HEIF_ABORT')));
      Promise.resolve(window.loadURL(PAGE)).catch(() => finish(job, new HeifError('HEIF_DECODE')));
    } catch { finish(job, new HeifError('HEIF_DECODE')); }
  }
  const receive = (event, payload) => {
    const job = active;
    if (!job || job.settled || !job.window || event.sender !== job.window.webContents ||
        event.senderFrame !== event.sender.mainFrame || event.senderFrame?.url !== PAGE ||
        !payload || typeof payload !== 'object') return;
    if (payload.type === 'ready') {
      if (job.sent) return;
      job.sent = true;
      try { event.sender.send(channel, { id: job.id, bytes: job.bytes }); }
      catch { finish(job, new HeifError('HEIF_DECODE')); }
      return;
    }
    if (!job.sent || payload.id !== job.id) return;
    if (payload.type === 'error') {
      finish(job, new HeifError(SAFE_CODES.has(payload.code) ? payload.code : 'HEIF_DECODE')); return;
    }
    if (payload.type === 'result') {
      try { finish(job, null, pngResult(payload)); }
      catch { finish(job, new HeifError('HEIF_DECODE')); }
    }
  };
  ipcMain.on(channel, receive);
  function decode(value, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(new HeifError('HEIF_ABORT'));
    if (signal && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function'))
      return Promise.reject(new HeifError('HEIF_INVALID'));
    if (queue.length >= QUEUE_LIMIT) return Promise.reject(new HeifError('HEIF_BUSY'));
    let bytes; try { bytes = exactBytes(value); } catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      const job = { id: crypto.randomUUID(), bytes, signal, resolve, reject, settled: false };
      job.onAbort = () => finish(job, new HeifError('HEIF_ABORT'));
      job.timer = setTimeout(() => finish(job, new HeifError('HEIF_TIMEOUT')), TIMEOUT_MS);
      signal?.addEventListener('abort', job.onAbort, { once: true });
      queue.push(job);
      if (signal?.aborted) job.onAbort(); else startNext();
    });
  }
  // close() cancels and wipes this account's work; the service can be reused
  // after an account switch. dispose() is final and removes the IPC listener.
  function close() {
    const all = [...queue]; if (active) all.push(active);
    for (const job of all) finish(job, new HeifError('HEIF_ABORT'));
  }
  let disposed = false;
  return {
    decode(value, options) { return disposed ? Promise.reject(new HeifError('HEIF_ABORT')) : decode(value, options); },
    close,
    dispose() { disposed = true; close(); ipcMain.removeListener(channel, receive); },
  };
}
module.exports = { createHeifDecoder, HeifError, exactBytes, validDimensions, pngResult, allowedResource,
  MAX_BYTES, MAX_OUTPUT_BYTES, MAX_PIXELS, MAX_EDGE, TIMEOUT_MS, QUEUE_LIMIT, PAGE, CSP };
