'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AccountSessionRegistry } = require('../app/core/account-session.cjs');
const { LoginFlow } = require('../app/core/login-flow.cjs');
const { officialUrl } = require('../app/core/security.cjs');

const cookie = { domain: '.weibo.com', path: '/', name: 'mock', value: 'mock-cookie-only', httpOnly: true };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture(cookies = [cookie]) {
  const sessions = new Map(), writes = [], waits = [], created = [];
  const registry = new AccountSessionRegistry({ sessions, officialUrl, readCookies: () => cookies,
    createSession: () => {
      const session = { cookies: { set: item => { writes.push(item); const wait = deferred(); waits.push(wait); return wait.promise; } } };
      created.push(session); return session;
    },
  });
  return { registry, sessions, writes, waits, created };
}

test('restoration preserves official cookie attributes and caches only after all writes', async () => {
  const f = fixture([cookie, { ...cookie, domain: 'weibo.com.evil.invalid' }, { ...cookie, domain: 'api.weibo.com', hostOnly: true, expirationDate: 2000000000 }]);
  const task = f.registry.restore('a');
  assert.equal(f.sessions.has('a'), false);
  assert.equal(f.writes[0].url, 'https://weibo.com/');
  assert.equal(f.writes[0].domain, '.weibo.com');
  assert.equal(f.writes[0].httpOnly, true);
  f.waits[0].resolve(); await settle();
  assert.equal(f.writes.length, 2);
  assert.equal(f.writes[1].domain, undefined);
  assert.equal(f.writes[1].expirationDate, 2000000000);
  assert.equal(f.sessions.has('a'), false);
  f.waits[1].resolve();
  assert.equal(await task, f.created[0]);
  assert.equal(await f.registry.restore('a'), f.created[0]);
  assert.equal(f.created.length, 1);
});

test('cancel during cookie restoration cannot cache a late session or save login data', async () => {
  const f = fixture(), flow = new LoginFlow();
  let saved = 0, identities = 0;
  const task = flow.run({ client: async ({ check }) => {
    await f.registry.restore('a', { check }); check();
    return { identity: async () => { identities++; return { id: 'a' }; }, groups: async () => [] };
  }, save: async () => { saved++; } });
  flow.cancel();
  await assert.rejects(task, error => error.code === 'LOGIN_CANCELED');
  f.registry.invalidate('a'); // Logout while the non-abortable cookie operation is outstanding.
  f.waits[0].resolve(); await settle();
  assert.equal(f.sessions.has('a'), false);
  assert.equal(saved, 0); assert.equal(identities, 0);
});

test('logout or credential reset invalidates restoration without a LoginFlow signal', async () => {
  const f = fixture();
  const task = f.registry.restore('a'); // The official-window open path also restores sessions.
  const rejected = assert.rejects(task, error => error.code === 'SESSION_RESTORE_INVALIDATED' && !error.message.includes(cookie.value));
  f.registry.invalidate('a');
  f.waits[0].resolve(); await rejected;
  assert.equal(f.sessions.has('a'), false);
});

test('late restoration cannot overwrite a newly verified login or a newer restoration', async () => {
  const f = fixture();
  const old = f.registry.restore('a');
  const rejected = assert.rejects(old, error => error.code === 'SESSION_RESTORE_INVALIDATED');
  const verified = { verified: true };
  f.registry.adopt('a', verified);
  f.waits[0].resolve(); await rejected;
  assert.equal(f.sessions.get('a'), verified);
  assert.equal(f.registry.invalidate('a'), verified);
  const first = f.registry.restore('a');
  const superseded = assert.rejects(first, error => error.code === 'SESSION_RESTORE_INVALIDATED');
  f.registry.invalidate('a');
  const second = f.registry.restore('a');
  f.waits[2].resolve(); const current = await second;
  f.waits[1].resolve(); await superseded;
  assert.equal(f.sessions.get('a'), current);
});

test('timeout during restoration cannot cache late data; another account remains independent', async () => {
  const f = fixture(), flow = new LoginFlow({ timeoutMs: 10 });
  const task = flow.run({ client: async ({ check }) => { await f.registry.restore('a', { check }); return {}; }, save: async () => assert.fail('must not save') });
  await assert.rejects(task, error => error.code === 'LOGIN_TIMEOUT');
  const other = { independent: true }; f.registry.adopt('b', other);
  f.waits[0].resolve(); await settle();
  assert.equal(f.sessions.has('a'), false);
  assert.equal(f.sessions.get('b'), other);
});

test('invalid cookies fail quietly but cancellation and generation checks are not swallowed', async () => {
  const f = fixture();
  const task = f.registry.restore('a');
  f.waits[0].reject(new Error('mock-cookie-only must never be surfaced'));
  assert.equal(await task, f.created[0]);
  const error = new Error('canceled before using cached credentials');
  await assert.rejects(f.registry.restore('a', { check: () => { throw error; } }), value => value === error);
  assert.equal(f.created.length, 1);
});

test('concurrent readers share one restoration while accounts remain independent', async () => {
  const f = fixture();
  const tasks = Array.from({ length: 4 }, () => f.registry.restore('a'));
  const other = f.registry.restore('b');
  assert.equal(f.created.length, 2);
  assert.equal(f.writes.length, 2);
  f.waits[0].resolve();
  const restored = await Promise.all(tasks);
  assert.ok(restored.every(value => value === f.created[0]));
  assert.equal(f.sessions.get('a'), f.created[0]);
  assert.equal(f.sessions.has('b'), false);
  f.waits[1].resolve();
  assert.equal(await other, f.created[1]);
  assert.equal(f.registry.flights.size, 0);
});

test('canceling one shared reader does not cancel a still-authorized reader', async () => {
  const f = fixture();
  let canceled = false;
  const cancelError = Object.assign(new Error('Canceled test caller'), { code: 'TEST_ABORT' });
  const abandoned = f.registry.restore('a', { check: () => { if (canceled) throw cancelError; } });
  const surviving = f.registry.restore('a');
  const rejected = assert.rejects(abandoned, error => error === cancelError);
  canceled = true; f.waits[0].resolve();
  assert.equal(await surviving, f.created[0]);
  await rejected;
  assert.equal(f.sessions.get('a'), f.created[0]);
  assert.equal(f.created.length, 1);
});

test('all canceled readers leave no cache or failed flight, and retry can restore', async () => {
  const f = fixture();
  let canceled = false;
  const check = () => { if (canceled) throw Object.assign(new Error('Canceled'), { code: 'TEST_ABORT' }); };
  const tasks = [f.registry.restore('a', { check }), f.registry.restore('a', { check })];
  const rejected = tasks.map(task => assert.rejects(task, error => error.code === 'TEST_ABORT'));
  canceled = true; f.waits[0].resolve(); await Promise.all(rejected);
  assert.equal(f.sessions.has('a'), false);
  assert.equal(f.registry.flights.size, 0);
  const retry = f.registry.restore('a'); f.waits[1].resolve();
  assert.equal(await retry, f.created[1]);
});

test('credential-read failure clears its flight so a subsequent configured retry succeeds', async () => {
  const f = fixture();
  f.registry.readCookies = () => { throw new Error('Credentials unavailable'); };
  await assert.rejects(f.registry.restore('a'), /Credentials unavailable/);
  assert.equal(f.registry.flights.size, 0);
  assert.equal(f.sessions.has('a'), false);
  f.registry.readCookies = () => [];
  assert.equal(await f.registry.restore('a'), f.created[1]);
  assert.equal(f.registry.flights.size, 0);
});
