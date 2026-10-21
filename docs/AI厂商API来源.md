# AI 厂商 API 来源与预设范围

核查日期：2026-10-20。本文对应 1.1.7 的厂商设置，说明应用采用的目的地址和官方文档依据。核查是公开文档阅读，没有使用用户 Key、测试真实服务或发送群聊；预设可填写不代表每个账号、地区、套餐和模型均已联调成功。

应用只使用 HTTPS JSON、Bearer API Key 与 Chat Completions 协议；精确本机地址可使用 HTTP。模型名称或 API ID 由用户自由填写，没有默认模型、不自动列举或测试。预设地址由主进程固定；其他地区、专属域名和套餐需要选择“自定义”，明确输入对应地址与 Key。以下顺序与界面一致。

| 厂商 | 应用预设地址 | 官方来源与使用范围 |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | [API 概览](https://developers.openai.com/api/reference/overview)说明 Bearer 认证。先确认所在地属于[官方支持地区](https://help.openai.com/en/articles/5347006-openai-api-supported-countries-and-territories)；API 与 ChatGPT 的订阅和计费分别管理，见[官方计费说明](https://help.openai.com/en/articles/9039756-managing-billing-for-chatgpt-and-the-api-platform)。 |
| DeepSeek | `https://api.deepseek.com/chat/completions` | 使用[官方 Chat Completions 接口](https://api-docs.deepseek.com/api/create-chat-completion/)的完整地址，不再拼接 `/v1`；认证见[API 说明](https://api-docs.deepseek.com/api/deepseek-api/)。未据此宣称全球地区均可用；以用户账号与服务要求为准。 |
| Kimi | `https://api.moonshot.cn/v1` | 采用[中国站快速开始](https://platform.kimi.com/docs/get-api-key)的基址。国际站官方示例为 `https://api.moonshot.ai/v1`，见[国际站快速开始](https://platform.kimi.ai/docs/overview)，应选择自定义。按对应站点使用账号、余额和 Key；Kimi API、Kimi Code 与 Kimi 会员的权益和 Key 不互通，见[问题排查](https://platform.kimi.com/docs/guide/troubleshooting)。模型参数请查[官方模型参考](https://platform.kimi.com/docs/api/models-overview)。 |
| 智谱 | `https://open.bigmodel.cn/api/paas/v4` | 采用[HTTP API 文档](https://docs.bigmodel.cn/cn/guide/develop/http/introduction)的通用接口与 Bearer 认证。Coding 套餐使用专属端点，不把标准 Key 或地址当作所有套餐通用；其他服务按其官方说明选择自定义。本应用不支持 Responses 协议，不能仅把 `/api/v1` 地址当作兼容替代。 |
| MiniMax | `https://api.minimax.cn/v1` | 使用[中国站 OpenAI SDK 文档](https://platform.minimax.cn/docs/api-reference/text-openai-api)的标准 API。国际站文档使用 `https://api.minimax.io/v1`，见[国际站文档](https://platform.minimax.io/docs/api-reference/text-openai-api)，应选择自定义并使用对应平台或套餐的凭据。 |
| 混元 | `https://api.hunyuan.cloud.tencent.com/v1` | [OpenAI 兼容调用示例](https://cloud.tencent.com/document/product/1729/111007)列出此基址与完整 `/chat/completions` 接口；使用[专用 API Key](https://cloud.tencent.com/document/product/1729/111008)，不填写腾讯云 SecretId/SecretKey。此预设用于现有混元兼容服务；TokenHub 用户按本人控制台提供的兼容地址选择自定义，应用不自动迁移。 |
| 千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 此处是北京地域现有兼容域名。[中文兼容接口说明](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope)建议使用业务空间专属域名；[地域与端点说明](https://www.alibabacloud.com/help/en/model-studio/regions)写明旧域名自 2026-09-30 起不再支持新增功能。新业务空间或其他地域请使用自定义，见下文。 |
| 小米 | `https://api.xiaomimimo.com/v1` | 来自 [MiMo OpenAI Chat Completions 文档](https://mimo.mi.com/docs/zh-CN/api/chat/openai-api)，用于按量付费接口；官方允许 `api-key` 或 Bearer，本应用使用 Bearer。Token Plan 使用独立端点与 Key，不能与按量凭据混用，见[套餐快速接入](https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/quick-access)。 |
| 自定义 | 无默认地址 | 用户明确填写服务官方文档或本人控制台给出的 Chat Completions 基址或完整接口，并核对实际发送目标；不会根据厂商名称猜测地域、模型或工作空间 ID。 |

## 地域与套餐需要对应

千问官方目前列出的北京业务空间格式为 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`，新加坡格式为 `https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`。花括号是说明占位符，不可原样保存；应从本人控制台复制实际地址。Key 与地域绑定，业务空间专属域名还要求相应工作空间。应用不会为旧配置静默换域名，也不会猜测 ID。依据：[中文兼容说明](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope)、[地域表](https://www.alibabacloud.com/help/en/model-studio/regions)。

小米 Token Plan 的官方 OpenAI 兼容基址分别为中国 `https://token-plan-cn.xiaomimimo.com/v1`、新加坡 `https://token-plan-sgp.xiaomimimo.com/v1`、欧洲 `https://token-plan-ams.xiaomimimo.com/v1`。应以本人套餐页面显示为准，选择自定义并使用该套餐 Key，不能拿按量 Key 互换。依据：[套餐快速接入](https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/quick-access)。

同名厂商可能提供多种协议或套餐。本应用不会因为选择了厂商就转换成 Responses、Messages 或其他专有 API，也不承诺所有模型参数兼容。实际模型权限、地区可用性、费用和数据处理规则需由用户在对应服务核对。

1.1.7 对精确 Kimi 官方来源 `https://api.moonshot.cn` 与 `https://api.moonshot.ai` 不发送固定 `temperature`，以免覆盖模型要求；仍保留每段 4,096 token 请求预算，不自动调整推理设置或模型。其依据是[官方模型参数参考](https://platform.kimi.com/docs/api/models-overview)对固定采样值及省略该参数的说明，不能据此声称所有 Kimi 模型已实调成功。

## 凭据与发送边界

Key 按当前应用账号受 Windows DPAPI 保护，绑定“厂商 ID + 规范化后的 Chat Completions 完整请求地址”。更换任一项须重新输入对应 Key；同一范围内修改模型可以保留原 Key。旧配置没有厂商字段时按自定义兼容，保留原模型、地址和 Key，不在启动时改写。眼睛按钮仅显隐本次输入，已保存秘密不返回界面。

这些预设只配置目的地址，保存不产生 API 请求。每次生成仍要看清最终 URL、模型、消息范围与预算并完成原生确认；没有自动测试、自动更换模型或失败重试。不读取其他应用配置或借用其凭据。详细操作和 HTTP 400 边界见 [AI 配置与错误排查](AI配置与错误排查.md)。
