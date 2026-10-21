'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { isHeic } = require('./image-format.cjs');
const VIEWER_URL = 'app://local/image-viewer.html';
const CHANNEL = 'weiyue:image-viewer';
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_DECODED_BYTES = 64 * 1024 * 1024;
const FORMATS = Object.freeze({
  'image/heic': { name: 'HEIC 图片', extension: 'heic', extensions: ['heic', 'heif'] },
  'image/jpeg': { name: 'JPEG 图片', extension: 'jpg', extensions: ['jpg', 'jpeg'] },
  'image/png': { name: 'PNG 图片', extension: 'png', extensions: ['png'] },
  'image/gif': { name: 'GIF 图片', extension: 'gif', extensions: ['gif'] },
  'image/webp': { name: 'WebP 图片', extension: 'webp', extensions: ['webp'] },
});
const ERRORS = Object.freeze({
  source: '原图地址无效，请返回群聊重新打开。',
  expired: '账号或图片窗口已变化，请重新打开原图。',
  image: '图片加载失败、格式不受支持或超出大小限制。支持 JPEG、PNG、GIF、WebP 和本地解码的 HEIC。',
  busy: '图片正在处理，请稍后再试。',
  save: '图片保存失败，请检查所选文件夹的写入权限。',
  sender: '图片窗口来源不受信任。',
  action: '不支持的图片操作。',
});

function normalizeSource(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\s\\\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== 'app:' || u.host !== 'media' || u.username || u.password || u.port || u.search || u.hash) return null;
    const pieces = u.pathname.slice(1).split('/').map(decodeURIComponent);
    if (pieces.length !== 6 || !/^[a-f0-9]{32}$/.test(pieces[0]) || !pieces[1] || !pieces[2] ||
        !/^(?:message|post|reference-(?:[0-9]|1[0-9]))$/.test(pieces[3]) || !/^\d{1,3}$/.test(pieces[4]) || pieces[5] !== 'original' ||
        pieces.some(x => /[\u0000-\u001f\u007f]/.test(x)) || pieces[1].length > 256 || pieces[2].length > 256) return null;
    return u.href;
  } catch { return null; }
}

function actualMime(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP' && bytes.readUInt32LE(4) >= 4) return 'image/webp';
  return null;
}

function validateImage(value) {
  const hasOriginal = value?.original !== undefined;
  if (!value || !Buffer.isBuffer(value.bytes) || !value.bytes.length ||
      value.bytes.length > (hasOriginal ? MAX_DECODED_BYTES : MAX_BYTES) ||
      !FORMATS[value.mime] || actualMime(value.bytes) !== value.mime) throw new Error(ERRORS.image);
  if (hasOriginal) {
    const original = value.original;
    // Only a decoded PNG may accompany a HEIC original. Do not render original
    // HEIC data or trust a declared type/extension when saving the downloaded file.
    if (value.mime !== 'image/png' || !original || original.mime !== 'image/heic' ||
        !Buffer.isBuffer(original.bytes) || !original.bytes.length || original.bytes.length > MAX_BYTES ||
        !isHeic(original.bytes)) throw new Error(ERRORS.image);
    return { bytes: Buffer.from(value.bytes), mime: value.mime,
      original: { bytes: Buffer.from(original.bytes), mime: 'image/heic' } };
  }
  // Keep the downloaded bytes untouched: saving does not re-encode animated or
  // transparent images, alter metadata, or convert a format based on its URL.
  return { bytes: Buffer.from(value.bytes), mime: value.mime };
}
function text(value, fallback, limit) {
  return typeof value === 'string' && value.trim() ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, limit) : fallback;
}
function defaultFilename(mime, date = new Date()) {
  const stamp = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '').replace('T', '-');
  return '微博图片-' + stamp + '.' + FORMATS[mime].extension;
}

function createImageViewer({ BrowserWindow, ipcMain, dialog, appRoot, getParent, getWorkArea, getOwner, readImage, writeFile = fs.writeFile } = {}) {
  if (typeof BrowserWindow !== 'function' || typeof ipcMain?.handle !== 'function' ||
      typeof dialog?.showSaveDialog !== 'function' || typeof readImage !== 'function' ||
      typeof getOwner !== 'function' || typeof appRoot !== 'string') throw new Error('图片查看器配置无效。');
  const records = new Map();
  let disposed = false;
  function current(record) {
    return !disposed && !record.window.isDestroyed() && records.get(record.webContents) === record && record.owner === getOwner();
  }
  function check(record) { if (!current(record)) throw new Error(ERRORS.expired); }
  async function load(record, retry) {
    check(record);
    if (record.pending) return record.pending;
    if (record.image && !retry) return record.image;
    record.image = null;
    record.pending = (async () => {
      try {
        // Install record.pending before invoking a transport that might throw
        // synchronously, so a failed read can always be retried explicitly.
        const image = validateImage(await Promise.resolve().then(() => readImage(record.source)));
        check(record);
        record.image = image;
        return image;
      } catch (error) {
        if (!current(record)) throw new Error(ERRORS.expired);
        throw new Error(ERRORS.image);
      } finally { record.pending = null; }
    })();
    return record.pending;
  }
  async function save(record) {
    check(record);
    if (record.saving || record.pending || !record.image) throw new Error(ERRORS.busy);
    record.saving = true;
    const image = record.image.original || record.image, format = FORMATS[image.mime];
    try {
      const result = await dialog.showSaveDialog(record.window, {
        title: '将原图另存为', buttonLabel: '保存原图',
        defaultPath: defaultFilename(image.mime),
        filters: [{ name: format.name, extensions: [...format.extensions] }],
        // Windows' native Save dialog already confirms replacement. This
        // property additionally requests the equivalent prompt on Linux.
        properties: ['showOverwriteConfirmation', 'dontAddToRecent'],
      });
      if (result.canceled || !result.filePath) return { canceled: true };
      check(record);
      if (!path.isAbsolute(result.filePath)) throw new Error(ERRORS.save);
      const ext = path.extname(result.filePath).slice(1).toLowerCase();
      if (!format.extensions.includes(ext)) throw new Error(`原图是 ${format.name}，请使用 .${format.extension} 文件名后重试。`);
      await writeFile(result.filePath, image.bytes);
      return { saved: true, name: path.basename(result.filePath), mime: image.mime, bytes: image.bytes.length };
    } catch (error) {
      if (!current(record)) throw new Error(ERRORS.expired);
      if (error.message?.startsWith('原图是 ')) throw error;
      throw new Error(ERRORS.save);
    } finally { record.saving = false; }
  }
  async function route(event, action) {
    const record = records.get(event.sender);
    if (!record || record.window.isDestroyed() || event.senderFrame !== record.webContents.mainFrame || event.senderFrame?.url !== VIEWER_URL) {
      return { ok: false, error: ERRORS.sender };
    }
    try {
      check(record);
      if (!['load', 'retry', 'save', 'close', 'maximize', 'minimize'].includes(action)) throw new Error(ERRORS.action);
      if (action === 'close') { record.window.close(); return { ok: true, value: true }; }
      if (action === 'maximize') { record.window.isMaximized() ? record.window.unmaximize() : record.window.maximize(); return { ok: true, value: true }; }
      if (action === 'minimize') { record.window.minimize(); return { ok: true, value: true }; }
      if (action === 'save') return { ok: true, value: await save(record) };
      if (record.saving) throw new Error(ERRORS.busy);
      const image = await load(record, action === 'retry');
      check(record);
      return { ok: true, value: { title: record.title, caption: record.caption, mime: image.mime,
        ...(image.original ? { originalMime: image.original.mime } : {}), byteLength: (image.original || image).bytes.length,
        dataUrl: 'data:' + image.mime + ';base64,' + image.bytes.toString('base64') } };
    } catch (error) {
      // Only our own fixed messages cross this separate renderer bridge. Never
      // return a URL, Cookie, underlying transport error, or filesystem path.
      const message = Object.values(ERRORS).includes(error.message) || error.message?.startsWith('原图是 ') ? error.message : ERRORS.image;
      return { ok: false, error: message };
    }
  }
  ipcMain.handle(CHANNEL, route);
  async function open({ source, title, caption } = {}) {
    if (disposed) throw new Error(ERRORS.expired);
    const safeSource = normalizeSource(source);
    if (!safeSource) throw new Error(ERRORS.source);
    const owner = getOwner();
    for (const record of records.values()) {
      if (current(record) && record.source === safeSource) {
        if (record.window.isMinimized()) record.window.restore();
        record.window.focus();
        return { opened: true };
      }
    }
    closeAll();
    const area = getWorkArea?.();
    const width = Number.isFinite(area?.width) ? Math.min(1280, Math.max(640, area.width - 40)) : 1280;
    const height = Number.isFinite(area?.height) ? Math.min(920, Math.max(480, area.height - 40)) : 920;
    const window = new BrowserWindow({
      width, height, minWidth: 640, minHeight: 480, frame: false, resizable: true,
      show: false, parent: getParent?.(), title: '查看原图 · 微阅', backgroundColor: '#15191c',
      autoHideMenuBar: true,
      webPreferences: { preload: path.join(appRoot, 'image-viewer-preload.cjs'), contextIsolation: true,
        nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false },
    });
    const webContents = window.webContents;
    const record = { window, webContents, owner, source: safeSource, title: text(title, '查看原图', 150), caption: text(caption, '', 300), image: null, pending: null, saving: false };
    records.set(webContents, record);
    webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    webContents.on('will-navigate', e => e.preventDefault());
    webContents.on('will-attach-webview', e => e.preventDefault());
    webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') { event.preventDefault(); window.close(); }
    });
    window.on('closed', () => { records.delete(webContents); record.image = null; });
    try {
      await window.loadURL(VIEWER_URL);
      check(record);
      window.show();
      return { opened: true };
    } catch {
      if (!window.isDestroyed()) window.close();
      throw new Error(ERRORS.image);
    }
  }
  function closeAll() {
    for (const record of [...records.values()]) {
      record.image = null;
      records.delete(record.webContents);
      if (!record.window.isDestroyed()) record.window.close();
    }
  }
  function dispose() { closeAll(); disposed = true; ipcMain.removeHandler?.(CHANNEL); }
  return { open, closeAll, dispose };
}

module.exports = { createImageViewer, normalizeSource, validateImage, defaultFilename, FORMATS, VIEWER_URL, CHANNEL };
