'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Electron 44.9.0 checks icudtl.dat with a newly restricted, low-integrity
// impersonation token and the kernel's AccessCheck(FILE_GENERIC_READ):
// https://github.com/electron/electron/blob/v44.9.0/shell/browser/win/install_dir_access.cc
// Its fatal message is fixed text; inspecting ACL SID names cannot reproduce
// that access check. This is deliberately a conservative TEST-HOST preflight,
// not an equivalent access check or a promise that Electron cannot fail later.
// It rejects GUI launches from the restricted executor where our fatal startup
// was reproduced. It never modifies ACLs, tokens, privileges or sandbox flags.

class RuntimePreflightError extends Error {
  constructor(code, message, target) {
    super(message);
    this.name = 'RuntimePreflightError';
    this.code = code;
    if (target) this.target = target;
  }
}

const TOKEN_PROBE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$source = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class WeiYueReadOnlyTokenProbe {
  [DllImport("advapi32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool IsTokenRestricted(IntPtr token);
  [DllImport("kernel32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool CloseHandle(IntPtr handle);
  public static bool Read() {
    IntPtr token;
    // TOKEN_QUERY only. No token creation, duplication, elevation or impersonation.
    if (!OpenProcessToken(new IntPtr(-1), 0x0008, out token))
      throw new Win32Exception(Marshal.GetLastWin32Error());
    try { return IsTokenRestricted(token); }
    finally { CloseHandle(token); }
  }
}
'@
Add-Type -TypeDefinition $source -ErrorAction Stop
@{ restricted = [WeiYueReadOnlyTokenProbe]::Read() } | ConvertTo-Json -Compress
`;

function probeWindowsToken({ execFile = execFileSync, env = process.env } = {}) {
  const powershell = path.win32.join(env.SystemRoot || env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    const output = execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', TOKEN_PROBE_SCRIPT], {
      windowsHide: true, timeout: 10000, maxBuffer: 128 * 1024,
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...env },
    });
    const result = JSON.parse(String(output).replace(/^\uFEFF/, '').trim());
    if (!result || typeof result.restricted !== 'boolean') throw new Error('Invalid probe result');
    return { restricted: result.restricted };
  } catch {
    // Native/compiler/transport diagnostics can contain environment information.
    // An unverified result must never silently allow a GUI process to start.
    throw new RuntimePreflightError('WINDOWS_RUNTIME_TOKEN_CHECK_FAILED', '无法只读确认 Windows 测试宿主的令牌状态，已停止 GUI 启动。请在已授权的普通 Windows 用户执行环境中重试。');
  }
}

function inspectReadableFile(target) {
  if (!fs.statSync(target).isFile()) throw new Error('Not a file');
  fs.accessSync(target, fs.constants.R_OK);
}

function assertWindowsRuntimeReadable(executablePath, {
  platform = process.platform, inspectFile = inspectReadableFile, probeToken = probeWindowsToken,
} = {}) {
  if (platform !== 'win32') return { status: 'skipped', platform, reason: 'Windows-only test-host check' };
  if (typeof executablePath !== 'string' || !executablePath || executablePath.includes('\0')) {
    throw new RuntimePreflightError('WINDOWS_RUNTIME_PATH_INVALID', 'Windows 测试运行时路径无效，已停止 GUI 启动。');
  }
  const executable = path.win32.resolve(executablePath);
  const icuData = path.win32.join(path.win32.dirname(executable), 'icudtl.dat');
  for (const target of [executable, icuData]) {
    try { inspectFile(target); }
    catch { throw new RuntimePreflightError('WINDOWS_RUNTIME_FILE_UNREADABLE', 'Windows 测试运行时文件不存在或当前宿主无法读取，已停止 GUI 启动：' + target, target); }
  }
  let token;
  try { token = probeToken(); }
  catch {
    throw new RuntimePreflightError('WINDOWS_RUNTIME_TOKEN_CHECK_FAILED', '无法只读确认 Windows 测试宿主的令牌状态，已停止 GUI 启动。请在已授权的普通 Windows 用户执行环境中重试。');
  }
  if (!token || typeof token.restricted !== 'boolean') {
    throw new RuntimePreflightError('WINDOWS_RUNTIME_TOKEN_CHECK_FAILED', 'Windows 测试宿主令牌检查未返回有效结果，已停止 GUI 启动。');
  }
  if (token.restricted) {
    throw new RuntimePreflightError('WINDOWS_RUNTIME_RESTRICTED_HOST', '当前 Windows 测试宿主持有限制令牌，曾导致 Electron 在初始化时原生崩溃；已在启动 GUI 前停止。请使用已授权的普通 Windows 用户执行环境，不要修改 ACL 或关闭沙箱。', executable);
  }
  return {
    status: 'checked', platform, executablePath: executable, icuDataPath: icuData,
    checks: { runtimeFilesReadable: true, hostTokenRestricted: false },
    scope: 'Conservative test-host preflight; not Electron sandbox AccessCheck',
  };
}

module.exports = { assertWindowsRuntimeReadable, probeWindowsToken, RuntimePreflightError };
