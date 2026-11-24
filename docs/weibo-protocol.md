# 微博读取协议与验证边界

实现参考 MIT 项目 [ylj5244-dot/weiyue](https://github.com/ylj5244-dot/weiyue)，固定提交 `7b6c7203490b9110f3b109e53b0e24b4aad1ccac`。参考版权为 Copyright (c) 2026 ylj5244-dot，保留 [参考许可证](REFERENCE-LICENSE.txt)。参考仓库与公开网页脚本作为文本审读，未直接执行其脚本或二进制。

接口依据还包括 [官方聊天入口](https://api.weibo.com/chat) 引用的公开客户端代码。以下是当前实现约束，不是平台稳定 SDK 的承诺；接口和权限可能变化。

| 用途 | 固定接口 |
| --- | --- |
| 当前身份 | `GET https://api.weibo.com/webim/query_primary_info.json` |
| 会话列表 | `GET https://api.weibo.com/webim/2/direct_messages/contacts.json?special_source=3` |
| 群消息 | `GET https://api.weibo.com/webim/groupchat/query_messages.json` |
| 单条详情 | `GET https://api.weibo.com/webim/groupchat/query_message.json` |
| 附件元数据 | `GET https://upload.api.weibo.com/2/mss/meta_query.json` |
| 附件文件 | `GET https://upload.api.weibo.com/2/mss/msget` |

消息接口使用公开客户端标识 `source=209678993`，它不是用户密钥。群消息含 `convert_emoji=1`、`query_sender=1`；不猜测额外查询参数。群及消息 ID 必须来自当前账号已授权数据。

## 会话与请求

用户在官方页面登录，主进程按账号注入 session.fetch，不导出、打印或借用 Cookie。消息 API 固定 Referer 为 `https://api.weibo.com/chat`，媒体为 `https://api.weibo.com/`；renderer 不能自定义认证头和请求来源。

仅允许核准的 HTTPS 目标和路由，拒绝意外重定向、越权标识、超时与过大响应。401/403、明确拒绝或风控应停止，不轮换身份。只读同步对允许的暂时错误有限重试并尊重 Retry-After；切账号、退出或取消使旧任务失效。

JSON 中超出安全整数范围的数字在解析前保护为原始词法文本。消息、群、账号及附件 ID 按十进制字符串传递，拒绝已丢精度的 Number。历史 max_mid 以 BigInt 计算本页最小 ID 减一，不依赖返回顺序。

## 消息与媒体

保留原话，不用摘要卡片替换；无效时间不以当前时间代替，明确属于其他群的记录拒收。每页去重并按账号保存，重复同步不以较差响应抹掉更完整内容。

图片描述来自返回的安全 URL 或明确图片附件 ID，原图候选须有来源证据。JPEG/PNG/GIF/WebP 继续核对声明类型与字节签名；HEIC 仅在图片显示链路显式允许，严格识别后由本地沙箱 Worker 转 PNG，另存保留原字节。头像与 AI 输入不继承 HEIC 显示权限。

PDF/视频以合法 FID 和返回的附件元数据为依据。JSONP 只作数据拆包，不 eval；FID、扩展名、大小与文件类型须匹配。查看器支持 PDF、MP4、WebM；PDF 使用本地 PDF.js，视频编码取决于 Electron。缺失、过期、拒绝和不支持的附件保留失败原因，不当作图片或猜外部下载地址。

HEIC 原图上限 20 MiB、显示 PNG 64 MiB、PDF 50 MiB、视频 200 MiB；另有超时、像素和缓存限制。资源绑定账号及窗口来源，切账号后旧窗口不能继续读旧媒体。显示或保存不触发 AI/Notion。

分享微博只使用返回的可核实正文、作者、图片与原帖链接。纯通知保持通知，不按发送者或通知句子猜原文；截断、不可用和缺失保留提示。

## 同步与阅读

游标必须向历史推进；重复页、异常 ID 和矛盾空页不能当作完整同步。有效页逐页原子落盘，后续失败保留已成功页。增量追平与历史结束不同，达到页数上限不得标成完整历史。

coverage 描述实际时间范围和接口结束信号，即使完成，也不能证明已删除、隐藏、权限变化或未返回媒体全部完整。摘要保留这一边界，不按 ID 间隔猜缺失条数。

阅读与同步分离。恢复锚点不推进 readThrough；后台同步、媒体更新和筛选不冒充阅读。具体输入、停留及跳转规则见 [使用说明](使用说明.md)。

## 复验

运行 `scripts/test.ps1` 覆盖合成协议、存储、媒体及附件测试；桌面方法见 [TESTING.md](TESTING.md)。真实身份、权限、平台限制、历史覆盖和具体附件须分别验证，不能由合成结果推定通过。公开资料不包含真实账号统计、媒体指纹或内部诊断。
