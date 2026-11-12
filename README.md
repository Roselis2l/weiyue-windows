# 微阅 Windows

**WeiYue Windows 1.1.45 · GitHub 版**

本地优先的微博群聊阅读工具，支持重点成员、搜索收藏、离线补齐、AI 总结和 Notion 导出。

[下载 Windows 版](https://github.com/Roselis2l/weiyue-windows/releases/latest) · [使用说明](docs/使用说明.md) · [更新记录](CHANGELOG.md)

## 主要功能

- **群聊阅读**：自动更新、双向翻页、阅读位置记忆，按关键词、成员和北京时间筛选。
- **重点成员与收藏**：高亮关注成员，收藏单条或多条消息，添加备注和标签，回查原文。
- **离线补齐**：选择自动补至本地衔接、只取最新消息，或补至指定日期。
- **图片与附件**：查看图片、HEIC、实况照片、PDF、视频及分享语音，预览 XLSX、CSV 和 Markdown，保存原文件及压缩附件。
- **摘要与导出**：生成本地摘录，或使用自选 AI 服务总结；编辑预览后导出至 Notion。
- **数据管理**：按群和时段预览删除，设置保留起点；可按群自动清理 1–3650 天前的消息，默认保护未读、收藏及相关引用。
- **界面设置**：收起左右栏，自定义主题、昵称、正文和气泡颜色，直接勾选开机自启动。

离线补扫显示已检查页数、回溯时间和新增条数，检查最新消息时保留补扫进度。[查看本版说明](docs/1.1.45更新说明.md)

## 开始使用

1. 下载 Windows x64 便携包，核对 `SHA256SUMS.txt`，完整解压后运行 `WeiYue-Windows-x64/WeiYue.exe`。运行时已包含在包内。
2. 首次启动可体验演示数据，或导入自己的 JSON 记录。
3. 连接微博时，在官方登录窗口完成登录和验证，再选择要同步的群聊。
4. 需要 AI 总结或 Notion 导出时，再配置相应服务。

自动更新优先当前阅读群，成功批次结束后 5 秒再检查；其他群最新页至少间隔 60 秒轮转。实际速度受群数、网络、补扫和平台限流影响，可随时暂停。微博连接用于读取群聊。

## 升级与数据

请固定一个日常安装目录。便携版的数据保存在 `WeiYue.exe` 同级的 `data/`，每个安装目录独立保存记录。升级前退出应用并备份整个现有目录，再更新程序文件、保留原 `data/`。迁移时使用完整的最新备份，避免多个副本产生分叉。

- 聊天、收藏、摘要及导出文件以未整体加密的本地文件保存；Cookie、AI Key 和 Notion Token 使用 Windows 保护存储。跨用户或设备迁移后，可能需要重新登录或配置凭据。
- **首次保存新的删除边界或重新获取任务后，账号升级至格式 5；读取该格式需要 1.1.38 或更新版本。** 降级请使用格式升级前的备份。
- 删除作用于当前账号的本地记录，保留最小删除标记和补齐边界；历史备份、外部导出及服务器记录需另行管理。删除属于应用数据清理，磁盘安全擦除需使用专门工具。
- GitHub 版收到官方明确撤回通知后，隐藏原文及关联摘录。撤回识别依赖平台返回的通知，已导出内容和历史备份保持原样。
- 本地摘录在本机生成。AI 发送范围由用户核对确认，Notion 在编辑预览确认后写入。媒体按需读取，完整离线归档需另外保存；AI 图片范围以发送前预览为准。
- 便携包尚无代码签名证书，请核对下载来源和校验值，并遵循设备安全策略。

## 媒体支持

| 类型 | 文件上限 |
| --- | --- |
| 普通图片、HEIC、XLSX | 20 MiB |
| PDF | 50 MiB |
| 视频、压缩文件 | 200 MiB |
| Markdown、CSV | 5 MiB |

预览另有像素、时长、行列及展开量限制。原生播放失败的短 HEVC 可在本机生成兼容预览，范围为 100 MiB、60 秒以内且通过尺寸等校验的文件。

内容可用性取决于账号权限、平台返回信息和链接有效期。缺失原帖或原图信息、加密及损坏文件可能无法打开；表情覆盖已收录的静态资源。详细格式、数据保护和联网范围见[使用说明](docs/使用说明.md)及[安全与限制](docs/安全与限制.md)。

## 界面示例

以下为 1.1.16 的合成数据示例，供了解阅读与整理流程：

[阅读界面](docs/images/reading-backfill-weibo-sample.png) · [摘要界面](docs/images/summaries-weibo-sample.png) · [Notion 预览](docs/images/notion-weibo-sample.png)

## 源码与构建

需要 Node.js 22+、PowerShell 5.1+。运行核心测试：

```powershell
./scripts/test.ps1
```

将已核验的 Electron 44.9.0 官方 Windows x64 ZIP 和同版 `SHASUMS256.txt` 放入干净源码副本的 `vendor/`，选择新的输出目录打包：

```powershell
./scripts/package.ps1 -ElectronVersion 44.9.0 -OutputDirectory dist-1.1.40
```

依赖随包提供。发布包仅包含程序、文档及所需组件，个人数据、凭据、真实截图和备份请独立保存。打包后按[复验说明](docs/TESTING.md)验证实际程序；真实服务兼容性与原生输入法体验需现场验证。

## 项目与许可

本项目是参考 [ylj5244-dot/weiyue](https://github.com/ylj5244-dot/weiyue) 的独立 Windows 实现，参考提交为 `7b6c7203490b9110f3b109e53b0e24b4aad1ccac`。

项目源码采用 [MIT](LICENSE)，保留[上游版权许可](docs/REFERENCE-LICENSE.txt)。便携包中的 Electron、Chromium、[HEIC](docs/HEIF-THIRD-PARTY.md)、[PDF.js](docs/PDFJS-THIRD-PARTY.md) 等组件遵循各自许可；[FFmpeg](docs/FFMPEG-THIRD-PARTY.md) 为 GPL-2.0-or-later，[文档组件 sax](docs/DOCUMENT-THIRD-PARTY.md) 为 BlueOak-1.0.0。对应许可、源码及构建材料随包提供，微博表情资产权利归原权利人。
