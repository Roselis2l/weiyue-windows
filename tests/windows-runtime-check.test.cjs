'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertWindowsRuntimeReadable, probeWindowsToken } = require('../scripts/windows-runtime-check.cjs');

const executable = 'C:\\mock runtime\\electron.exe';
const readable = () => {};

test('non-Windows hosts skip the check without reading files or invoking PowerShell', () => {
  const result = assertWindowsRuntimeReadable('/mock/electron', { platform: 'linux',
    inspectFile: () => assert.fail('No file reads'), probeToken: () => assert.fail('No native token query') });
  assert.equal(result.status, 'skipped');
});

test('restricted Windows test host stops before the caller can launch Electron', () => {
  let launched = false;
  assert.throws(() => {
    assertWindowsRuntimeReadable(executable, { platform: 'win32', inspectFile: readable, probeToken: () => ({ restricted: true }) });
    launched = true;
  }, error => error.code === 'WINDOWS_RUNTIME_RESTRICTED_HOST' && /普通 Windows 用户/.test(error.message));
  assert.equal(launched, false);
});

test('ordinary Windows host checks both native target files and reports only limited scope', () => {
  const files = [];
  const result = assertWindowsRuntimeReadable(executable, { platform: 'win32', inspectFile: target => files.push(target), probeToken: () => ({ restricted: false }) });
  assert.deepEqual(files, [executable, 'C:\\mock runtime\\icudtl.dat']);
  assert.equal(result.status, 'checked');
  assert.deepEqual(result.checks, { runtimeFilesReadable: true, hostTokenRestricted: false });
  assert.match(result.scope, /not Electron sandbox AccessCheck/);
});

test('missing or unreadable ICU data rejects before token probing; invalid paths also reject', () => {
  assert.throws(() => assertWindowsRuntimeReadable(executable, { platform: 'win32',
    inspectFile: target => { if (target.endsWith('icudtl.dat')) throw new Error('Sensitive native detail'); },
    probeToken: () => assert.fail('No token query after unreadable file'),
  }), error => error.code === 'WINDOWS_RUNTIME_FILE_UNREADABLE' && !error.message.includes('Sensitive'));
  assert.throws(() => assertWindowsRuntimeReadable('bad\0path', { platform: 'win32' }), error => error.code === 'WINDOWS_RUNTIME_PATH_INVALID');
});

test('token query failures and malformed replies fail closed without exposing raw diagnostics', () => {
  for (const probeToken of [() => { throw new Error('Private environment detail'); }, () => ({}), () => ({ restricted: 'false' })]) {
    assert.throws(() => assertWindowsRuntimeReadable(executable, { platform: 'win32', inspectFile: readable, probeToken }),
      error => error.code === 'WINDOWS_RUNTIME_TOKEN_CHECK_FAILED' && !error.message.includes('Private'));
  }
});

test('native probe uses a hidden bounded PowerShell process and read-only TOKEN_QUERY calls', () => {
  let invoked = false;
  const env = { SystemRoot: 'C:\\Windows', FIXTURE: 'not-a-shell-command' };
  const result = probeWindowsToken({ env, execFile: (program, args, options) => {
    invoked = true;
    assert.equal(program, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.deepEqual(args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
    assert.match(args[4], /OpenProcessToken\(new IntPtr\(-1\), 0x0008, out token\)/);
    assert.match(args[4], /IsTokenRestricted\(token\)/);
    assert.match(args[4], /finally \{ CloseHandle\(token\); \}/);
    assert.doesNotMatch(args[4], /Set-Acl|icacls|SetTokenInformation|CreateRestrictedToken|DuplicateToken|Impersonate|AdjustTokenPrivileges/);
    assert.equal(options.windowsHide, true);
    assert.equal(options.timeout, 10000);
    assert.equal(options.shell, undefined);
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.deepEqual(options.env, env);
    return '{"restricted":false}';
  } });
  assert.equal(invoked, true);
  assert.deepEqual(result, { restricted: false });
});

test('native probe timeout or invalid output is controlled and never treated as unrestricted', () => {
  for (const execFile of [() => { throw new Error('Private PowerShell stderr'); }, () => 'not-json', () => '{"restricted":null}']) {
    assert.throws(() => probeWindowsToken({ execFile }), error => error.code === 'WINDOWS_RUNTIME_TOKEN_CHECK_FAILED' && !error.message.includes('Private'));
  }
});
