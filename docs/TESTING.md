# 测试与 Windows 验收

以下命令均从源码根目录执行。测试分为 Node 核心测试、Electron 桌面回归和真实服务人工联调。命令的存在不代表已在读者的机器执行通过；应保留实际结果，并说明所用版本和环境。

## 核心测试

需要 Node.js 22 或更高版本，当前记录的工具链为 Node 24.19.0。核心测试不需要 npm 安装：

```powershell
.\scripts\test.ps1
```

脚本按文件名枚举 `tests/*.test.cjs`，拒绝空测试集，并对测试失败返回错误。若 Node 不在 PATH：

```powershell
.\scripts\test.ps1 -NodePath '<Node executable>'
```

这一步覆盖存储、同步、分页/去重、阅读状态、媒体、摘要、Notion 导出等核心行为；不能代替实际 Windows 程序验收。

## 桌面回归准备

需要普通、获准使用的 Windows 交互桌面、Electron 44.9.0 和 Playwright 1.62.1。先完成 [BUILD.md](BUILD.md) 中的下载与 hash 校验，然后创建证据目录并将运行时解压到一个全新目录：

```powershell
New-Item -ItemType Directory -Path '.\artifacts' -Force | Out-Null
if (Test-Path -LiteralPath '.\vendor\runtime') {
    throw 'vendor/runtime already exists; use a fresh source workspace'
}
Expand-Archive -LiteralPath '.\vendor\electron-v44.9.0-win32-x64.zip' -DestinationPath '.\vendor\runtime'
```

不要把不同 Electron 版本解压到同一目录。源码包不包含 `vendor/runtime` 或 `artifacts`，这两个准备步骤不能省略。

GUI 脚本读取 `PLAYWRIGHT_MODULE`，否则尝试加载 Node 能解析到的 `playwright`。若已有 Playwright 1.62.1，可指定 package 根目录：

```powershell
$env:PLAYWRIGHT_MODULE = '<absolute-path-to-playwright-package>'
node -p "require(process.env.PLAYWRIGHT_MODULE + '/package.json').version"
```

如需自行安装外部测试工具，可在源码目录外新建工具目录；以下操作会访问 npm 并写入该工具目录，不由应用自动执行：

```powershell
$toolsRoot = Join-Path $env:TEMP 'weiyue-playwright-1.62.1'
if (Test-Path -LiteralPath $toolsRoot) {
    throw 'Tool directory already exists; choose a new toolsRoot'
}
New-Item -ItemType Directory -Path $toolsRoot | Out-Null
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
npm install --prefix $toolsRoot --save-exact --ignore-scripts playwright@1.62.1
if ($LASTEXITCODE -ne 0) {
    throw 'Playwright installation failed'
}
$env:PLAYWRIGHT_MODULE = Join-Path $toolsRoot 'node_modules\playwright'
node -p "require(process.env.PLAYWRIGHT_MODULE + '/package.json').version"
```

这些测试驱动已下载的 Electron，不需要执行 `playwright install` 下载浏览器。上述命令固定顶层 Playwright 版本；本仓库未固定外部测试工具的完整传递依赖。保存工具目录生成的 lockfile 及实际版本，有助于记录自己的验收环境，不能将其误称为本仓库已提供的依赖锁。

## 对最终 portable 验收

先按 BUILD.md 生成 `dist-public-1.1.8`。以下脚本使用独立演示/合成 profile，不需要登录真实微博、配置 AI Key 或授权 Notion：

```powershell
node .\scripts\verify-package.cjs .\dist-public-1.1.8\WeiYue-Windows-x64\WeiYue.exe .\artifacts\package-verification.json
node .\scripts\ui-smoke.cjs .\dist-public-1.1.8\WeiYue-Windows-x64\WeiYue.exe
node .\scripts\login-integration.cjs .\dist-public-1.1.8\WeiYue-Windows-x64\WeiYue.exe
```

如果使用了其他 `OutputDirectory`，将三条命令中的 `dist-public-1.1.8` 换成实际名称。`login-integration.cjs` 必须显式传入当前 EXE，避免使用它的历史默认位置。

`verify-package.cjs` 核对当前 app 源码与 portable 中的文件 hash、版本、演示数据、渲染隔离及默认关闭自动网络的状态。`ui-smoke.cjs` 在实际 EXE 中走界面流程。登录脚本使用模拟网络和测试身份，不验证真实微博服务是否仍兼容。

## 源码级桌面回归

准备好 `artifacts`、`vendor/runtime` 和 Playwright 后运行：

```powershell
node .\scripts\native-reading-input-integration.cjs
node .\scripts\reading-refresh-integration.cjs
node .\scripts\reading-position-integration.cjs
node .\scripts\reading-ui-regression.cjs
node .\scripts\media-integration.cjs
node .\scripts\message-search-ime-integration.cjs
node .\scripts\ai-settings-workflow-smoke.cjs
node .\scripts\export-workflow-smoke.cjs
node .\scripts\login-ui-regression.cjs
node .\scripts\referrer-integration.cjs
```

这些脚本将源码及运行时复制到临时 harness，建立隔离资料，并模拟外部传输。`referrer-integration.cjs` 使用本机回环 HTTP 服务。需要旧版私有基线的历史布局比较不属于此公开套件。

`windows-runtime-check.cjs` 是随源码提供的只读检查 helper。测试宿主 token 受限、运行时不可读或桌面不可用时，应保留失败原因并改用获准的测试环境；不要禁用 Electron 沙箱、修改 ACL 或变更安全设置来制造通过结果。

## 输入法与真实服务边界

`message-search-ime-integration.cjs` 驱动 Chromium/CDP composition 管线，并区分模拟兼容事件；它没有自动操作真实 Windows 拼音候选窗口。对原生候选窗、候选选择、组合取消、中文标点及多次组合提交，需要另行人工验收，不能由 CDP 测试结果替代。

真实微博登录和群聊同步应由使用者自行完成，只访问其有权限的群。AI 和 Notion 必须由使用者明确配置并主动确认调用；开发/CI 测试不应传入真实群聊、密钥或工作区。公开报告应只包含合成结果和必要工具版本，避免上传 profile、日志中的账号信息或原始内部证据。
