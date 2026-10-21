'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const { AccountSessionRegistry } = require('../app/core/account-session.cjs');
const { safeImageUrl } = require('../app/core/media.cjs');

// Exercise the actual protocol handler with fake storage, sessions and image
// transport. Loading the Electron entry point itself would open a real app.
const source = fs.readFileSync(path.join(__dirname, '../app/main.cjs'), 'utf8');
const handler = source.slice(source.indexOf('async function serveImage('), source.indexOf('async function enrichMessages('));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settle = () => new Promise(resolve => setImmediate(resolve));
const image = { bytes: Buffer.from([137, 80, 78, 71]), mime: 'image/png' };
function fixture({ kind = 'import', accountSession, fetchImage, createHeifDecoder = () => { throw new Error('Unexpected HEIC decoder'); } }) {
  const state = { account: { kind }, messages: Array.from({ length: 105 }, (_, i) => ({
    id: String(i + 1), groupId: 'g', images: [{ url: 'https://wx1.sinaimg.cn/large/' + (i + 1) + '.jpg' }],
  })) };
  const scope = {
    activeId: 'weibo-test', accountEpoch: 0, store: { get: () => state }, Response, URL, AbortController,
    safeImageUrl, session: { defaultSession: {} }, imageCache: new Map(), imageJobs: new Map(),
    cachedImageBytes: 0, activeImages: 0, imageWaiters: [], fetchImage, accountSession, imageRequest() {}, closing: () => false,
    heifDecoder: null, createHeifDecoder, BrowserWindow: class {}, ipcMain: {}, __dirname: path.resolve(__dirname, '../app'),
    mediaToken: id => crypto.createHash('sha256').update(id).digest('hex').slice(0, 32),
  };
  vm.createContext(scope);
  vm.runInContext(handler + ';globalThis.run=serveImage;', scope);
  scope.request = n => scope.run({ method: 'GET' }, new URL('app://media/' + scope.mediaToken(scope.activeId) + '/g/' + n + '/message/0/preview'));
  scope.original = n => scope.run({ method: 'GET' }, new URL('app://media/' + scope.mediaToken(scope.activeId) + '/g/' + n + '/message/0/original'), true);
  return scope;
}

test('a full image queue rejects without poisoning later retries or leaking jobs', async () => {
  const gate = deferred(); let fetched = 0, running = 0, peak = 0;
  const f = fixture({ fetchImage: async () => { fetched++; running++; peak = Math.max(peak, running); await gate.promise; running--; return image; } });
  const tasks = Array.from({ length: 105 }, (_, i) => f.request(i + 1));
  await settle();
  assert.equal((await tasks[104]).status, 502);
  assert.equal(f.imageJobs.size, 104);
  gate.resolve();
  const results = await Promise.all(tasks);
  assert.equal(results.filter(result => result.status === 200).length, 104);
  assert.equal(f.imageJobs.size, 0);
  assert.equal(f.activeImages, 0);
  assert.equal(peak, 4);
  assert.equal((await f.request(105)).status, 200);
  assert.equal(fetched, 105);
});

test('first parallel images share the same restored session and all load successfully', async () => {
  const gate = deferred(); let created = 0;
  const registry = new AccountSessionRegistry({ createSession: () => { created++; return { cookies: { set: () => gate.promise } }; },
    readCookies: () => [{ domain: '.weibo.com', name: 'mock', value: 'mock-only' }], officialUrl: () => true });
  const f = fixture({ kind: 'weibo', accountSession: (id, options) => registry.restore(id, options), fetchImage: async () => image });
  const tasks = [1, 2, 3, 4].map(n => f.request(n));
  assert.equal(created, 1);
  gate.resolve();
  assert.deepEqual((await Promise.all(tasks)).map(result => result.status), [200, 200, 200, 200]);
  assert.equal(f.imageJobs.size, 0);
});

test('canceling all images during restoration prevents a late session cache and image request', async () => {
  const gate = deferred(); let fetched = 0;
  const registry = new AccountSessionRegistry({ createSession: () => ({ cookies: { set: () => gate.promise } }),
    readCookies: () => [{ domain: '.weibo.com', name: 'mock', value: 'mock-only' }], officialUrl: () => true });
  const f = fixture({ kind: 'weibo', accountSession: (id, options) => registry.restore(id, options), fetchImage: async () => { fetched++; return image; } });
  const tasks = [1, 2, 3, 4].map(n => f.request(n));
  f.accountEpoch++;
  for (const job of f.imageJobs.values()) job.controller.abort();
  gate.resolve();
  assert.ok((await Promise.all(tasks)).every(result => result.status === 502));
  assert.equal(registry.sessions.size, 0);
  assert.equal(registry.flights.size, 0);
  assert.equal(fetched, 0);
  assert.equal(f.imageJobs.size, 0);
});

test('account changes abort active images and drain queued jobs without fetching or caching them', async () => {
  let fetched = 0;
  const f = fixture({ fetchImage: ({ signal }) => { fetched++; return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Canceled')), { once: true })); } });
  const tasks = [1, 2, 3, 4, 5, 6].map(n => f.request(n));
  f.accountEpoch++;
  for (const job of f.imageJobs.values()) job.controller.abort();
  assert.ok((await Promise.all(tasks)).every(result => result.status === 502));
  assert.equal(fetched, 4);
  assert.equal(f.imageCache.size, 0);
  assert.equal(f.imageJobs.size, 0);
  assert.equal(f.imageWaiters.length, 0);
  assert.equal(f.activeImages, 0);
});

const heicBytes = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 104, 101, 105, 99,
  0, 0, 0, 0, 109, 105, 102, 49, 104, 101, 105, 120]);
const heicImage = { bytes: heicBytes, mime: 'image/heic' };

test('HEIC media explicitly opts in, responds with PNG, and exposes original only to internal viewer access', async () => {
  let fetches = 0, decodes = 0, creates = 0;
  let observedOptions, decoderOptions;
  const f = fixture({
    fetchImage: async options => { fetches++; observedOptions = options; return heicImage; },
    createHeifDecoder: options => {
      creates++; decoderOptions = options;
      return { decode: async (bytes, options) => {
        decodes++; assert.equal(bytes, heicBytes); assert.equal(options.signal, observedOptions.signal);
        return image;
      } };
    },
  });
  const response = await f.request(1);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), image.bytes);
  assert.equal(observedOptions.allowHeif, true);
  assert.equal(observedOptions.signal instanceof AbortSignal, true);
  assert.equal(decoderOptions.BrowserWindow, f.BrowserWindow);
  assert.equal(decoderOptions.ipcMain, f.ipcMain);
  assert.equal(decoderOptions.session, f.session);
  assert.equal(decoderOptions.appRoot, f.__dirname);
  const value = await f.original(1);
  assert.equal(value.mime, 'image/png'); assert.deepEqual(value.bytes, image.bytes);
  assert.equal(value.original.mime, 'image/heic'); assert.deepEqual(value.original.bytes, heicBytes);
  assert.equal(fetches, 1); assert.equal(decodes, 1); assert.equal(creates, 1);
  assert.equal(f.cachedImageBytes, image.bytes.length + heicBytes.length);
  assert.equal(f.imageCache.size, 1); assert.equal(f.imageJobs.size, 0);
});

test('parallel preview and original accesses share the HEIC decode, while separate images reuse the decoder', async () => {
  let fetches = 0, decodes = 0, creates = 0;
  const gate = deferred();
  const f = fixture({
    fetchImage: async () => { fetches++; return heicImage; },
    createHeifDecoder: () => { creates++; return { decode: async () => { decodes++; await gate.promise; return image; } }; },
  });
  const preview = f.request(1), original = f.original(1);
  await settle();
  assert.equal(fetches, 1); assert.equal(decodes, 1); assert.equal(creates, 1);
  gate.resolve();
  assert.equal((await preview).status, 200); assert.equal((await original).original.mime, 'image/heic');
  assert.equal((await f.request(2)).status, 200);
  assert.equal(fetches, 2); assert.equal(decodes, 2); assert.equal(creates, 1);
  assert.equal(f.cachedImageBytes, 2 * (image.bytes.length + heicBytes.length));
});

test('ordinary raster images avoid decoder creation and retain existing bytes and response type', async () => {
  let creates = 0;
  const f = fixture({
    fetchImage: async options => { assert.equal(options.allowHeif, true); return image; },
    createHeifDecoder: () => { creates++; throw new Error('Should not decode PNG'); },
  });
  const response = await f.request(1);
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), image.bytes);
  const value = await f.original(1);
  assert.equal(value.original, undefined);
  assert.equal(creates, 0); assert.equal(f.cachedImageBytes, image.bytes.length);
});

test('HEIC cache eviction accounts for both decoded display and downloaded original bytes', async () => {
  const largeOriginal = { bytes: Buffer.alloc(20 * 1024 * 1024), mime: 'image/heic' };
  const display = { bytes: Buffer.alloc(40 * 1024 * 1024), mime: 'image/png' };
  const raster = { bytes: Buffer.alloc(8 * 1024 * 1024), mime: 'image/png' };
  const f = fixture({
    fetchImage: async ({url}) => url.includes('/1.jpg') ? largeOriginal : raster,
    createHeifDecoder: () => ({ decode: async () => display }),
  });
  await f.original(1);
  assert.equal(f.cachedImageBytes, 60 * 1024 * 1024);
  assert.equal(f.imageCache.size, 1);
  await f.original(2);
  assert.equal(f.cachedImageBytes, 8 * 1024 * 1024);
  assert.equal(f.imageCache.size, 1);
  assert.equal([...f.imageCache.keys()].some(key => key.endsWith('/1.jpg')), false);
  assert.equal([...f.imageCache.keys()].some(key => key.endsWith('/2.jpg')), true);
});

test('HEIC display plus original over the 64 MiB cache budget is returned for this access without caching', async () => {
  const display = { bytes: Buffer.alloc(64 * 1024 * 1024), mime: 'image/png' };
  let fetches = 0, decodes = 0;
  const f = fixture({
    fetchImage: async () => { fetches++; return heicImage; },
    createHeifDecoder: () => ({ decode: async () => { decodes++; return display; } }),
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const value = await f.original(1);
    assert.equal(value.bytes, display.bytes); assert.equal(value.original.bytes, heicBytes);
    assert.equal(f.imageCache.size, 0); assert.equal(f.cachedImageBytes, 0); assert.equal(f.imageJobs.size, 0);
  }
  assert.equal(fetches, 2); assert.equal(decodes, 2);
});

test('account change during HEIC decode rejects late display and leaves no original or display cached', async () => {
  const gate = deferred(); let decodeSignal;
  const f = fixture({
    fetchImage: async () => heicImage,
    createHeifDecoder: () => ({ decode: async (_bytes, {signal}) => { decodeSignal = signal; return gate.promise; } }),
  });
  const pending = f.original(1);
  await settle(); assert.ok(decodeSignal);
  f.accountEpoch++; f.activeId = 'another-account';
  for (const job of f.imageJobs.values()) job.controller.abort();
  gate.resolve(image);
  assert.equal((await pending).status, 502); assert.equal(decodeSignal.aborted, true);
  assert.equal(f.imageCache.size, 0); assert.equal(f.cachedImageBytes, 0); assert.equal(f.imageJobs.size, 0);
  assert.equal(f.activeImages, 0);
});

test('HEIC decode failure cleans the job and an explicit later access can retry without leaking details', async () => {
  let decodes = 0, fetches = 0;
  const f = fixture({
    fetchImage: async () => { fetches++; return heicImage; },
    createHeifDecoder: () => ({ decode: async () => {
      if (++decodes === 1) throw new Error('private image body and credential');
      return image;
    } }),
  });
  const failed = await f.request(1);
  assert.equal(failed.status, 502); assert.doesNotMatch(await failed.text(), /private|credential/);
  assert.equal(f.imageCache.size, 0); assert.equal(f.imageJobs.size, 0); assert.equal(f.activeImages, 0);
  assert.equal((await f.request(1)).status, 200);
  assert.equal(fetches, 2); assert.equal(decodes, 2); assert.equal(f.imageCache.size, 1);
});
