> **历史文档（1.1.8） / Historical documentation (1.1.8)**
>
> 本页原文保留作 1.1.8 历史记录。下文声称打包脚本强制读取 runtime-lock.json 的流程属于旧版，不适用于当前 scripts/package.ps1。请以[当前源码测试与构建说明](../README.md#源码测试与构建)为准。
>
> This page preserves the original 1.1.8 documentation. The runtime-lock.json enforcement described below belongs to the old build workflow and does not apply to the current scripts/package.ps1. Use the [current source testing and build instructions](../README.md#源码测试与构建) for the current release.

# 从源码构建 Windows 应用

在 Windows x64 上，从源码根目录执行以下步骤。源码 ZIP 解压后应能在当前目录看到 `package.json`、`app`、`scripts`、`tests` 和 `runtime-lock.json`。

## 工具与依赖

- PowerShell 5.1 或更高版本。当前记录的打包工具链为 PowerShell 7.6.5。
- Node.js 22 或更高版本用于核心测试；当前记录的测试版本为 24.19.0。
- Electron 44.9.0 的官方 Windows x64 ZIP。版本、文件名和 SHA256 固定在 `runtime-lock.json`。
- GUI 验收另外需要 Playwright 1.62.1，见 [TESTING.md](TESTING.md)。

应用和核心测试没有 npm runtime/dev 依赖，不需要 `npm install`，也没有需要锁定的 npm 应用依赖图。Electron 使用单独校验的二进制归档。Playwright 是外部测试工具；其完整传递依赖尚未通过本仓库锁文件固定。

`npm start` 假定 PATH 中已有 `electron`；本项目不会自动安装它。建议先完成下方打包，再启动生成的程序。

## 准备并校验 Electron

从 [Electron v44.9.0 官方 release](https://github.com/electron/electron/releases/tag/v44.9.0) 下载：

- [electron-v44.9.0-win32-x64.zip](https://github.com/electron/electron/releases/download/v44.9.0/electron-v44.9.0-win32-x64.zip)
- [SHASUMS256.txt](https://github.com/electron/electron/releases/download/v44.9.0/SHASUMS256.txt)

将两份文件放到源码根目录的 `vendor` 文件夹。运行时归档不保存在源码仓库中。

```powershell
New-Item -ItemType Directory -Path '.\vendor' -Force | Out-Null
# 将从官方 release 下载的两份文件放入 vendor 后继续。
$runtimeLock = Get-Content -LiteralPath '.\runtime-lock.json' -Raw -Encoding UTF8 | ConvertFrom-Json
$archive = Join-Path '.\vendor' $runtimeLock.archive
$actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $runtimeLock.sha256) {
    throw 'Electron archive hash mismatch'
}
```

固定归档 SHA256：

```text
88e08039d0ef359bab9f674e8051fa103bd8628ea7c5a5e1daaa610a8a0c6931
```

该值记录已审查归档的内容标识。构建者仍应确认下载来源；本说明不声称已在准备发布时重新在线校验官方 ZIP。打包脚本同时检查归档与 `SHASUMS256.txt`、`runtime-lock.json` 是否一致。仅替换归档和 checksum 文件不能绕过固定 hash。

## 核心测试与打包

```powershell
.\scripts\test.ps1
.\scripts\package.ps1 -ElectronVersion 44.9.0 -OutputDirectory dist-public-1.1.8
```

如果 Node 不在 PATH，可以传入自己的 Node 可执行文件路径：

```powershell
.\scripts\test.ps1 -NodePath '<Node executable>'
```

遵守主机现有 PowerShell 执行策略；不需要为应用关闭系统安全设置。`OutputDirectory` 是源码根目录下的单层名称，可由字母、数字、点和连字符组成；例如 `dist-public-1.1.8`。输出必须全新，脚本拒绝覆盖现有程序目录、ZIP 和 checksum 文件。再次构建时使用另一个新名称。

构建完成后得到：

```text
dist-public-1.1.8/
  WeiYue-Windows-x64/
    WeiYue.exe
    BUILD-INFO.json
    resources/app/
  WeiYue-Windows-x64.zip
  WeiYue-Source.zip
  SHA256SUMS.txt
```

程序由已校验的 Electron 与源码组合，不编译第三方原生扩展。打包白名单排除用户数据、凭据、运行时下载、依赖目录、Git 历史和内部测试产物。Electron/Chromium 许可保留在 portable 内，并附应用及参考仓库许可。

启动 portable 前，先按 [TESTING.md](TESTING.md) 对实际生成的 EXE 进行隔离验收。普通使用时运行 `WeiYue.exe`，无需另装 Node 或 Electron。

## 重建范围

这些步骤支持重建可运行的应用，并利用 hash 核对输入与输出。它们不保证两次构建生成完全相同字节的 ZIP：

- `BUILD-INFO.json` 包含当次 `packagedAtUtc`。
- 源文件修改时间和 ZIP 条目元数据没有统一。
- PowerShell/.NET 的压缩环境和条目顺序没有进行确定性规范化。

因此，应称为可验证的功能重建，而非逐字节可复现构建。`SHA256SUMS.txt` 用于检验某次构建产物是否完整，不能独自证明另一次构建会得到相同 hash。若将来需要逐字节复现，应统一时间、顺序、编码和压缩工具链，并比较两个独立洁净构建。
