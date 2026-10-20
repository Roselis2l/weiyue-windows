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
function fixture({ kind = 'import', accountSession, fetchImage }) {
  const state = { account: { kind }, messages: Array.from({ length: 105 }, (_, i) => ({
    id: String(i + 1), groupId: 'g', images: [{ url: 'https://wx1.sinaimg.cn/large/' + (i + 1) + '.jpg' }],
  })) };
  const scope = {
    activeId: 'weibo-test', accountEpoch: 0, store: { get: () => state }, Response, URL, AbortController,
    safeImageUrl, session: { defaultSession: {} }, imageCache: new Map(), imageJobs: new Map(),
    cachedImageBytes: 0, activeImages: 0, imageWaiters: [], fetchImage, accountSession, imageRequest() {}, closing: () => false,
    mediaToken: id => crypto.createHash('sha256').update(id).digest('hex').slice(0, 32),
  };
  vm.createContext(scope);
  vm.runInContext(handler + ';globalThis.run=serveImage;', scope);
  scope.request = n => scope.run({ method: 'GET' }, new URL('app://media/' + scope.mediaToken(scope.activeId) + '/g/' + n + '/message/0/preview'));
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
