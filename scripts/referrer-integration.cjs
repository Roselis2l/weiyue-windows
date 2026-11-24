'use strict';

// Real Electron networking against two local HTTP origins. No application
// account, credential, Weibo endpoint, webRequest hook or policy override is used.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { assertWindowsRuntimeReadable } = require('./windows-runtime-check.cjs');

const root = path.resolve(__dirname, '..');
const evidence = path.join(root, 'artifacts', 'referrer-integration');
const report = {
  startedAt: new Date().toISOString(),
  scope: 'Native Electron net.request/session.fetch; loopback only; fresh runtime and profile; default referrer policy and sandbox',
  applicationFilesChanged: false,
  policyOverridden: false,
  nativeWebRequestHooks: false,
  serverRequests: [],
};

// This function is serialized into an isolated, minimal Electron main process.
function electronMain(configPath) {
  const fs = require('node:fs');
  const { app, net, session } = require('electron');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  app.setPath('userData', config.userData);
  app.setPath('sessionData', config.sessionData);
  const result = { versions: process.versions, processId: process.pid, cases: [] };
  let finishing = false;
  function finish(error) {
    if (finishing) return;
    finishing = true;
    if (error) result.failure = String(error.stack || error);
    fs.writeFileSync(config.output, JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ finished: true, cases: result.cases.length, error: Boolean(error) }));
    if (error) app.exit(1); else app.quit();
  }
  process.on('uncaughtException', finish);
  process.on('unhandledRejection', finish);
  const ensureLocal = value => {
    const url = new URL(value);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !config.ports.includes(url.port)) {
      throw new Error('Test refuses a destination outside its loopback listeners');
    }
  };
  async function runCase(test) {
    ensureLocal(test.url);
    if (test.referer) ensureLocal(test.referer);
    const s = session.fromPartition('referrer-test-' + test.id);
    const headers = test.referer ? { Referer: test.referer } : {};
    const started = Date.now();
    try {
      let status, body;
      if (test.transport === 'session.fetch') {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        try {
          const response = await s.fetch(test.url, { method: 'GET', headers,
            credentials: 'include', redirect: 'manual', signal: controller.signal });
          status = response.status;
          body = await response.text();
        } finally { clearTimeout(timer); }
      } else {
        ({ status, body } = await new Promise((resolve, reject) => {
          const request = net.request({ url: test.url, session: s, method: 'GET',
            credentials: 'include', redirect: 'manual' });
          let settled = false;
          const done = (error, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error); else resolve(value);
          };
          const timer = setTimeout(() => { done(new Error('Local request timeout')); request.abort(); }, 5000);
          for (const [name, value] of Object.entries(headers)) request.setHeader(name, value);
          request.on('error', error => done(error));
          request.on('abort', () => done(new Error('Local request aborted')));
          request.on('redirect', () => { done(new Error('Unexpected local redirect')); request.abort(); });
          request.on('response', response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(Buffer.from(chunk)));
            response.on('error', error => done(error));
            response.on('end', () => done(null, { status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
          });
          request.end();
        }));
      }
      return { ...test, outcome: 'response', status, body, elapsedMs: Date.now() - started };
    } catch (error) {
      // Only synthetic local URLs occur in these errors. Preserve the native
      // network error text to distinguish policy rejection from HTTP failure.
      return { ...test, outcome: 'error', error: String(error.message || error), elapsedMs: Date.now() - started };
    } finally { await s.closeAllConnections(); }
  }
  app.whenReady().then(async () => {
    for (const test of config.cases) result.cases.push(await runCase(test));
    finish();
  }).catch(finish);
}

async function listen(name) {
  const server = http.createServer((request, response) => {
    report.serverRequests.push({ listener: name, url: request.url, method: request.method,
      referer: request.headers.referer || null, origin: request.headers.origin || null,
      receivedAt: new Date().toISOString() });
    response.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
    response.end(JSON.stringify({ marker: 'local-loopback', path: request.url }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server;
}

async function main() {
  fs.mkdirSync(evidence, { recursive: true });
  const servers = [];
  try {
    const harness = fs.mkdtempSync(path.join(os.tmpdir(), 'weiyue-referrer-integration-'));
    report.harness = harness;
    fs.cpSync(path.join(root, 'vendor', 'runtime'), path.join(harness, 'runtime'), { recursive: true });
    const executablePath = path.join(harness, 'runtime', 'electron.exe');
    // Fail in Node before any native GUI/runtime spawn from a restricted host.
    report.preflight = assertWindowsRuntimeReadable(executablePath);
    const serverA = await listen('destination'); servers.push(serverA);
    const serverB = await listen('other-origin'); servers.push(serverB);
    const originA = 'http://127.0.0.1:' + serverA.address().port;
    const originB = 'http://127.0.0.1:' + serverB.address().port;
    const variants = [
      { name: 'cross-origin-full-path', referer: originB + '/chat', expectBlocked: true },
      { name: 'cross-origin-origin-only', referer: originB + '/', expectBlocked: false },
      { name: 'same-origin-full-path', referer: originA + '/chat', expectBlocked: false },
      { name: 'no-referer', referer: null, expectBlocked: false },
    ];
    const cases = ['net.request', 'session.fetch'].flatMap(transport => variants.map(variant => {
      const id = transport + '-' + variant.name;
      return { ...variant, transport, id, url: originA + '/case/' + id };
    }));
    const config = { cases, ports: [String(serverA.address().port), String(serverB.address().port)],
      userData: path.join(harness, 'user-data'), sessionData: path.join(harness, 'session-data'),
      output: path.join(harness, 'electron-result.json') };
    fs.mkdirSync(config.userData); fs.mkdirSync(config.sessionData);
    const configPath = path.join(harness, 'config.json');
    const mainPath = path.join(harness, 'main.cjs');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    fs.writeFileSync(mainPath, '(' + electronMain.toString() + ')(' + JSON.stringify(configPath) + ');\n');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    report.nativeStartedAt = new Date().toISOString();
    let stdout = '', stderr = '';
    await new Promise((resolve, reject) => {
      const child = spawn(executablePath, [mainPath], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      report.nativeProcessId = child.pid;
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 55000);
      child.stdout.on('data', data => { stdout += data.toString(); });
      child.stderr.on('data', data => { stderr += data.toString(); });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('close', (code, signal) => {
        clearTimeout(timeout);
        report.nativeExit = { code, signal, timedOut, at: new Date().toISOString() };
        fs.writeFileSync(path.join(evidence, 'native.stdout.log'), stdout);
        fs.writeFileSync(path.join(evidence, 'native.stderr.log'), stderr);
        resolve();
      });
    });
    if (fs.existsSync(config.output)) report.electron = JSON.parse(fs.readFileSync(config.output, 'utf8'));
    const actualCases = report.electron?.cases || [];
    report.checks = cases.map(test => {
      const actual = actualCases.find(item => item.id === test.id);
      const received = report.serverRequests.filter(item => item.url === '/case/' + test.id);
      const passed = test.expectBlocked
        ? actual?.outcome === 'error' && actual.error.includes('ERR_BLOCKED_BY_CLIENT') && received.length === 0
        : actual?.outcome === 'response' && actual.status === 200 && received.length === 1 && received[0].referer === test.referer;
      return { id: test.id, passed, expected: test.expectBlocked ? 'ERR_BLOCKED_BY_CLIENT before server receives request' : 'HTTP 200; server receives unchanged specified Referer', receivedCount: received.length };
    });
    report.passed = report.nativeExit?.code === 0 && !report.nativeExit?.signal && !report.nativeExit?.timedOut
      && !report.electron?.failure && actualCases.length === cases.length && report.checks.every(check => check.passed)
      && report.serverRequests.every(item => item.listener === 'destination');
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    report.passed = false;
    report.failure = { code: error.code, message: String(error.message || error) };
    process.exitCode = 1;
  } finally {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: report.passed, checks: report.checks?.length || 0,
      report: path.join(evidence, 'result.json'), nativeExit: report.nativeExit,
      failure: report.failure }, null, 2));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
