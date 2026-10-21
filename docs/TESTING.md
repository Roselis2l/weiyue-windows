# 测试与 Windows 复核

本文件记录 1.1.21 的本地验收与复核方法。公开包仅更新 README、文档与合成示例图；应用、测试脚本、运行库和 EXE 与已验收程序逐字节一致，附件完整性以同批次 SHA256SUMS.txt 为准。没有用构建成功代替 EXE 验收，也不声称 GitHub CI 已运行。

[1.1.16 更新说明](1.1.16更新说明.md)及更早文档中的数量是历史记录，不能作为 1.1.21 的通过依据。

## 核心测试

```powershell
.\scripts\test.ps1
```

本轮复核滚轮触底一次及空白拖动触底松开后一次追加当前筛选的 160 条本地消息、原内容/选区/阅读锚点与未看消息保持、手动更多从已加载范围之后替换窗口、失败重试、稳定 startId/afterId 处理历史补入位移、后台刷新保留追加窗口、程序性跳转不冒充用户触底、重复触发与没有后页的边界；紧凑气泡的字号、正文选择与媒体尺寸；系统通知无框小字、透明背景且无边框阴影尾角、长通知展开及深浅聊天背景下文字清晰；六项颜色独立设置、严格 #RGB/#RRGGBB 与颜色选择器一致性、局部合成预览、当前账号保存/取消/草稿恢复默认、普通正文与自动重点正文至少 4.5:1 对比、显式重点正文低对比仅提示并保留值、链接可读性、昵称低对比提示、旧五项配置保持及缺失正文项自动模式；账号数据、阅读位置与现有功能保持。具体源码级及 EXE 结果写入独立验证报告，不以旧版数量代替本轮验收。

冻结前已完成全量单元 943/943、源码布局 26/26、外观设置 17/17、六色媒体气泡 50/50、触底自动翻页 13/13。专项结果与全量单元可能重叠，不相加作为新的测试总数。以上是源码级证据，与下方成包 EXE 结果分别记录。

回收测试只使用合成数据。须核验收藏、摘要来源、导出关联、未读、阅读及同步锚点保护；缺失来源时保守保留；自动同步、补扫或导入不恢复已回收消息；失败不伪称成功。首次实际回收将账号格式升为 2，仅预览不升级，恢复全部仍为 2；旧版应拒绝读取该格式。

## 最终 Windows EXE 验收

在未改写运行代码的最终 1.1.21 portable 上完成 126 项检查，各进程正常退出，程序哈希未变：

| 套件 | 通过数量 |
| --- | ---: |
| 布局与交互 | 26/26 |
| 六色设置与无框系统通知 | 15/15 |
| 触底本地续页 | 10/10 |
| 媒体气泡与配色 | 50/50 |
| 媒体导航、预览与原文件保存 | 25/25 |

媒体气泡包含 170 组几何核对，重点默认红粉、自动对比与显式低对比提示均核验；媒体覆盖 HEVC 本机准备后自动播放、原生 WebM、HEIF、PDF、PNG、引用与 ZIP。沙箱和上下文隔离开启，渲染器 Node 集成关闭。没有外部请求、真实 AI 调用或真实 Notion 写入。故障注入只在独立源码测试执行，不能把源码检查数与 EXE 检查数直接相加。

## Windows 界面与隔离集成

使用独立测试 profile、合成消息和模拟服务，不登录真实账号、不删除真实聊天、不调用付费 AI 或写入真实 Notion。脚本的实际参数、环境变量和运行范围以各文件注释为准。相关入口包括：

- `scripts/ui-smoke.cjs`：版本与启动。
- `scripts/appearance-121-integration.cjs`：六项颜色、默认色、自动与显式正文色、预览/保存/取消/恢复默认及旧配置保留。
- `scripts/auto-page-121-integration.cjs`：滚轮与拖动触底追加、筛选、锚点与未读、后台刷新、手动分页、错误重试及状态边界。
- `scripts/layout-121-integration.cjs`：本轮紧凑气泡、默认配色、通知外观及交互；结果以实际执行为准。
- `scripts/bubble-media-121-integration.cjs`：本轮媒体气泡、配色与几何边界，使用独立安全导航；结果以实际执行为准。
- `scripts/media-121-packaged.cjs`：本轮媒体查看、保存、格式边界及隔离验收，支持实际 EXE 目标；结果以实际执行为准。
- `scripts/layout-120-integration.cjs`：普通与重点气泡、内容宽度、框外拖滚/框内选择、通知例外及跨视图状态。
- `scripts/layout-119-integration.cjs`：既有空白区域拖动、正文选择、通知展开和状态组合。
- `scripts/media-119-packaged.cjs`：受支持聊天图片 MIME 与签名不一致的显示、保存和安全边界；支持独立源码或 EXE 目标，按实际运行目标区分结果。
- `scripts/layout-117-integration.cjs`：既有底部分页、头像下操作和不同视图。
- `scripts/message-cleanup-integration.cjs`：回收、保护规则、预览确认与恢复。
- `scripts/emoticon-extensions-ui.cjs`、`scripts/emoticons-integration.cjs`：官方图像映射、混排、文本回退和原文语义。
- `scripts/reading-filters-integration.cjs`、`scripts/reading-position-integration.cjs`：筛选、已读高水位、未读与跨群恢复。
- `scripts/image-viewer-integration.cjs`、`scripts/attachment-viewer-integration.cjs`、`scripts/animated-images-integration.cjs`：媒体查看及合成异常情况。
- `scripts/summary-delete-integration.cjs`、`scripts/notion-direct-export-integration.cjs`：摘要删除及 mock Notion 单次提交。

若脚本启动源码应用，应将结果标为源码级检查。最终 portable 验收须实际启动未改写 `resources/app` 的 EXE，记录版本、文件哈希、沙箱、布局、媒体、表情、阅读与回收结果。故障注入只在独立测试副本中执行，不改写最终候选。

## 依赖和分发核验

核对源码、staging 和 ZIP 条目的字节哈希及完整清单。确认没有 `data/`、凭据、真实群聊、阅读状态、私人路径、诊断样本或备份。合成示例图需逐张检查，旧版结构参考图不得当成本轮验收截图。

官方表情以映射和资源清单为准：本版共 409 个映射、408 份官方原图，未核实的代码回退原文。合成 GIF 测试不能冒充真实官方动态表情验收。HEIF、PDF.js 及 FFmpeg 运行资源、许可证和对应源码材料应完整保留；FFmpeg 源码只放在 `app/decoder/ffmpeg/source/`，不重复放入 docs。

## 验证边界

真实登录、平台风控、服务器可见历史、真实 AI 模型兼容性、Notion 权限与写入不由模拟测试证明。自动化中文组合测试不等同于 Windows 原生输入法人工验收。已获授权的真实媒体只读验证应单独记录结果，原始文件不进入源码或便携包。

测试产生的 artifacts、profile、备份和诊断截图不随软件分发。软件不会自动升级日常安装或执行历史目录清理。
