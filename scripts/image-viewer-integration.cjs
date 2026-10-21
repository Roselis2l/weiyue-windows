'use strict';
// Exercises the real isolated Electron viewer using generated checkerboard
// pixels and a mocked Save dialog. No login, browser profile or remote request.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const output = path.resolve(process.env.WEIYUE_VIEWER_TEST_OUTPUT || path.join(__dirname, '../artifacts/image-viewer-1.1.9'));
const root = path.resolve(__dirname, '..');
if (!process.versions.electron) {
  const executable = path.resolve(process.env.WEIYUE_ELECTRON || path.join(root, 'vendor/runtime/electron.exe'));
  require('./windows-runtime-check.cjs').assertWindowsRuntimeReadable(executable);
  fs.mkdirSync(output, { recursive: true });
  const result = require('node:child_process').spawnSync(executable, [__filename], {
    env: { ...process.env, WEIYUE_VIEWER_TEST_OUTPUT: output }, stdio: 'inherit', windowsHide: true, timeout: 60000,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} else {
  const { app, BrowserWindow, ipcMain, protocol, net, nativeImage, session, screen } = require('electron');
  const { pathToFileURL } = require('node:url');
  const { createImageViewer } = require('../app/core/image-viewer.cjs');
  fs.mkdirSync(output, { recursive: true });
  app.setPath('userData', path.join(output, 'isolated-browser'));
  protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
  const source = 'app://media/' + 'a'.repeat(32) + '/test/1/message/0/original';
  const results = [], record = (name, details = {}) => { results.push({ name, passed: true, ...details }); };
  let manager, owner = 'synthetic|1', cancelSave = true, failImage = false, dialogCalls = 0;
  const savedFile = path.join(output, 'saved-original-' + require('node:crypto').randomUUID() + '.png');
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function wait(check, message) {
    for (let i = 0; i < 100; i++) { if (await check()) return; await delay(30); }
    throw new Error(message);
  }
  app.whenReady().then(async () => {
    const width = 1600, height = 1100, bitmap = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4, tile = ((Math.floor(x / 80) + Math.floor(y / 80)) % 2) === 0;
      bitmap[index] = tile ? 120 : 75; bitmap[index + 1] = tile ? 172 : 125; bitmap[index + 2] = tile ? 108 : 62; bitmap[index + 3] = 255;
    }
    const png = nativeImage.createFromBitmap(bitmap, { width, height }).toPNG();
    protocol.handle('app', request => {
      const url = new URL(request.url);
      if (url.host !== 'local' || !['/image-viewer.html', '/image-viewer.js', '/image-viewer.css'].includes(url.pathname)) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(path.join(root, 'app/renderer', url.pathname.slice(1))).href);
    });
    session.defaultSession.setPermissionRequestHandler((_w, _p, cb) => cb(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.on('will-download', event => event.preventDefault());
    let externalRequests = 0;
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, cb) => { externalRequests++; cb({ cancel: true }); });
    manager = createImageViewer({ BrowserWindow, ipcMain, appRoot: path.join(root, 'app'),
      getOwner: () => owner, getWorkArea: () => screen.getPrimaryDisplay().workAreaSize,
      readImage: async () => { if (failImage) throw new Error('synthetic failure'); return { bytes: png, mime: 'image/png' }; },
      dialog: { showSaveDialog: async (_window, options) => {
        dialogCalls++; assert.deepEqual(options.filters, [{ name: 'PNG 图片', extensions: ['png'] }]);
        assert.ok(options.properties.includes('showOverwriteConfirmation'));
        return cancelSave ? { canceled: true } : { canceled: false, filePath: savedFile };
      } },
    });
    await manager.open({ source, title: '模拟原图 · 仅测试', caption: '虚构成员 · 生成的棋盘格' });
    let window = BrowserWindow.getAllWindows()[0], wc = window.webContents;
    const run = expression => wc.executeJavaScript(expression);
    await wait(() => run('!document.getElementById("image").hidden && document.getElementById("image").naturalWidth===1600'), 'Image did not decode');
    const prefs = wc.getLastWebPreferences();
    assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false);
    assert.equal(await run('typeof require'), 'undefined');
    assert.equal(window.isResizable(), true);
    record('real sandboxed image window loads generated PNG', { width, height });
    const fitScale = await run('Number(document.getElementById("zoom-value").textContent.replace("%",""))');
    assert.ok(fitScale > 0 && fitScale < 100);
    await run('document.getElementById("actual").click()');
    assert.equal(await run('document.getElementById("zoom-value").textContent'), '100%');
    await run('document.getElementById("zoom-in").click()');
    assert.equal(await run('document.getElementById("zoom-value").textContent'), '125%');
    await run('document.getElementById("zoom-out").click()');
    assert.equal(await run('document.getElementById("zoom-value").textContent'), '100%');
    record('zoom in, out and original-size controls');
    const beforePan = await run('document.getElementById("image").style.transform');
    await run('document.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}))');
    assert.notEqual(await run('document.getElementById("image").style.transform'), beforePan);
    record('keyboard panning moves enlarged image');
    const beforeDrag = await run('document.getElementById("image").style.transform');
    wc.sendInputEvent({ type: 'mouseDown', x: 400, y: 350, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseMove', x: 460, y: 390, movementX: 60, movementY: 40 });
    wc.sendInputEvent({ type: 'mouseUp', x: 460, y: 390, button: 'left', clickCount: 1 });
    await wait(async () => (await run('document.getElementById("image").style.transform')) !== beforeDrag, 'Pointer drag did not pan');
    record('native mouse input pans enlarged image');
    await run('document.getElementById("viewport").dispatchEvent(new WheelEvent("wheel",{deltaY:-120,clientX:500,clientY:350,bubbles:true,cancelable:true}))');
    assert.ok((await run('Number(document.getElementById("zoom-value").textContent.replace("%",""))')) > 100);
    record('wheel zoom enters the actual renderer');
    await run('document.getElementById("fit").click()');
    window.setSize(850, 650);
    await delay(150);
    const fitBounds = await run('(()=>{const i=document.getElementById("image").getBoundingClientRect(),v=document.getElementById("viewport").getBoundingClientRect();return {iw:i.width,ih:i.height,vw:v.width,vh:v.height}})()');
    assert.ok(fitBounds.iw <= fitBounds.vw + 1 && fitBounds.ih <= fitBounds.vh + 1);
    record('fit follows native window resize', fitBounds);
    await run('document.getElementById("save").click()');
    await wait(() => run('document.getElementById("save-status").textContent.includes("已取消")'), 'Cancel message not shown');
    assert.equal(fs.existsSync(savedFile), false);
    record('canceling Save dialog makes no file');
    cancelSave = false;
    await run('document.getElementById("save").click()');
    await wait(() => run('document.getElementById("save-status").textContent.includes("已保存")'), 'Saved message not shown');
    assert.deepEqual(fs.readFileSync(savedFile), png);
    assert.equal(dialogCalls, 2);
    record('Save dialog-selected path preserves original PNG byte-for-byte');
    window.setSize(1180, 850); await delay(150);
    fs.writeFileSync(path.join(output, 'image-viewer.png'), (await wc.capturePage()).toPNG());
    failImage = true;
    await run('window.imageViewer.call("retry").catch(()=>{})');
    await run('document.getElementById("retry").click()');
    await wait(() => run('!document.getElementById("status-panel").hidden && !document.getElementById("retry").hidden'), 'Failure not shown');
    assert.equal(await run('document.getElementById("save").disabled'), true);
    record('image failure is visible and disables saving');
    failImage = false;
    await run('document.getElementById("retry").click()');
    await wait(() => run('!document.getElementById("image").hidden'), 'Retry failed');
    record('explicit image retry restores viewer');
    owner = 'synthetic|2'; manager.closeAll();
    await wait(() => BrowserWindow.getAllWindows().length === 0, 'Account change did not close viewer');
    record('account change closes image window');
    await manager.open({ source, title: 'Esc 关闭测试' });
    window = BrowserWindow.getAllWindows()[0]; wc = window.webContents;
    await wait(() => wc.executeJavaScript('!document.getElementById("image").hidden'), 'Second image did not decode');
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    await wait(() => window.isDestroyed(), 'Escape did not close viewer');
    record('native Escape closes frameless viewer');
    assert.equal(externalRequests, 0); record('no external network request', { externalRequests });
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: results.length, failed: 0, tests: results }, null, 2));
    console.log(JSON.stringify({ passed: results.length, failed: 0, output }));
    manager.dispose(); app.quit();
  }).catch(error => {
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: results.length, failed: 1, error: error.stack, tests: results }, null, 2));
    console.error(error); manager?.dispose(); app.exit(1);
  });
  app.on('window-all-closed', () => {});
}
