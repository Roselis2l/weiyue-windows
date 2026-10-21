# 测试与 Windows 复核

## 1.1.16 验证范围

本次核心测试 673 项通过；最终 portable 的补扫界面 11 项、版本与沙箱启动校验通过。补扫回归使用隔离数据，覆盖大缺口、重复页、乱序、续传、退避以及阅读边界。真实服务限流、风控和长期运行不由合成结果证明。

表情 8 项、摘要删除 8 项、mock Notion 10 项桌面回归在最后一项详情补全请求限制补丁前完成，对应功能未改动；补丁后重新执行全部核心测试、最终补扫 UI 和启动校验。

当前结果及限制见 [1.1.16 更新说明](1.1.16更新说明.md) 和同次交付报告。下面只说明可复现方法，不预报尚未执行的检查。

本轮重点覆盖每份摘要右上角垃圾桶入口、默认取消的应用内确认、按稳定 ID 删除、取消与持久化失败保留、跨账号与同名摘要隔离、重启恢复。删除不改变聊天、收藏、阅读位置、导出日志或已经存在的 Notion 页面；不请求真实 AI/Notion。Notion 导出使用模拟远端，覆盖摘要与多选收藏从预览按钮直接提交、字段校验、防重复、失败提示和成功链接；没有额外发送勾选或二次确认弹窗。

完整公开表情目录须逐项验证全部名称的两种括号写法、所有去重资源的本地响应/格式/哈希、各分类、长代码和六种原有代码的加载失败原文回退、重复及混合代码、未知代码、链接混合、原文复制、缓存和稳定布局。官方图片随应用本地提供，来源与权利说明见 [WEIBO-EMOTICONS.md](WEIBO-EMOTICONS.md)。本次官方公开目录没有动画 GIF；合成 GIF 能力测试不能冒充真实官方动态表情验收。表情显示不得改变搜索、收藏、导出、摘要输入或用户分享图片列表。

同时回归分钟级起止时间（北京时间、结束分钟包含整分钟）、可搜索成员多选、最新已读位置、未读数量文案和清除筛选恢复阅读位置。同步、媒体加载、筛选和还原位置不得代替真实阅读行为。

合成阅读集成还应覆盖新消息到达时的阅读高水位、重启持久化、真实定时回调与筛选期间不推进已读。日期范围及成员选择不得跨账号泄漏。

保留 HEIC、PDF、视频、原件保存和 HTTP/HTTPS 链接。新阅读功能不能破坏独立查看器、账号隔离或安全渲染。HEIF 对应源码与许可证、PDF.js 全部运行资源继续包含在发行包。

## 核心测试

```powershell
.\scripts\test.ps1
```

## Windows 界面与合成集成

准备独立 Electron 运行时和 Playwright；以各脚本参数约定传入本次 portable EXE。下面的集成只使用合成消息、隔离测试 profile 和模拟服务，不登录真实账号、不调用付费 AI/Notion。

```powershell
node .\scripts\ui-smoke.cjs .\dist-public-1.1.16\WeiYue-Windows-x64\WeiYue.exe
node .\scripts\reading-filters-integration.cjs
node .\scripts\emoticons-integration.cjs
node .\scripts\summary-delete-integration.cjs
node .\scripts\notion-direct-export-integration.cjs
node .\scripts\image-viewer-integration.cjs
node .\scripts\attachment-viewer-integration.cjs
node .\scripts\links-ui-regression.cjs
```

各脚本实际参数、环境变量和运行范围以源码注释为准。若脚本启动源码应用，应将其结果明确记为源码级检查；最终 portable 验收须真实启动未替换 resources/app 的 EXE，并记录版本、文件 hash、沙箱、表情显示与复制、分钟和多成员筛选、已读高水位及重启。故障注入只能在独立测试副本中完成，不得改写最终发布包。

测试产生的 artifacts、profile、备份和截图不随源码或 portable 分发。真实登录、平台风控、真实 AI 服务和 Notion 写入不由合成结果证明。浏览器真实交接与目标页面加载也分开记录。
