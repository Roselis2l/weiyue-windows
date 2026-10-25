# 微博表情来源与显示

1.1.26 共收录 413 个经过核实的映射、412 份去重官方原图，不使用近似 Unicode 表情。来源分为保留的公开字典、官方聊天默认表情选择器及十三个明确的旧路径代码；这不是全部聊天分类、活动、付费、自定义或动态图的覆盖承诺。

保留的 308 项来自微博官方公开字典 `https://h5.sinaimg.cn/m/emoticon/all.json`。字典在 2026-10-20 匿名读取成功，HTTP 200，无 Cookie、Key 或重定向；原始 40,490 字节 SHA-256 为 `dbb40c5d913027d90d8ef09ab20943553d84baccbf0967f5c26689a107b304db`。

该公开目录含七个分类，308 个确切官方图片 URL 全部返回 HTTP 200 并通过图片结构核验，全部为 PNG。`航天员` 与 `宇航员` 的两个官方 URL 返回相同字节，因此去重为 307 份独立原图；这不是按相似外观猜测别名。

2026-10-21 经用户授权，在官方 `https://api.weibo.com/chat/` 已登录页面正常打开默认表情选择器，读取可见表情的名称和图片地址，共 182 个名称。其中旧目录已有 90 个名称沿用原映射，新增 92 个名称均按选择器提供的 `face.t.sinajs.cn` 图片地址下载，全部 HTTP 200、PNG、96×96，逐项核验结构与 SHA-256。页面提取记录只保留官方表情名称和资源地址，不含群聊、账号或登录凭据。

本次新增覆盖：`苦涩、流鼻血、老师好、卡皮巴拉、泪奔、无聊、666、淡淡的、送花花、拜托、努力、捂嘴哭、手指比心、呵呵、流汗、融化`。`呵呵` 与 `微笑`、`流汗` 与 `汗` 是分别核实的不同官方资源，没有按含义猜测合并。

`[/ee8192.png]`、`[/ee8cb0.png]`、`[/ee9092.png]`、`[/ee808e.png]`、`[/ee819a.png]`、`[/ee858c.png]`、`[/ee88a6.png]`、`[/ee84a5.png]`、`[/ee88ab.png]` 及下述四个新增代码的映射依据官方聊天前端 `https://h5.sinaimg.cn/m/pcweibochat/js/app.48f8ddda.js` 中的 `convertEmoji` 路由。该脚本 SHA-256 为 `572ee8cdb4a0d4b9401ab4f5aca0c5bd1f043fe310063632694a47d76bb30aae`。十三个确切地址均在 `https://img.t.sinajs.cn/t4/appstyle/expression/emimage/` 下，逐项返回 HTTP 200、PNG、20×20，已保存原始字节和哈希。应用只识别这些已确认路径，不把任意文件名拼成网络请求。

1.1.17 的 92 个名称和 6 个路径合计增加 98 份原图、789,071 字节。1.1.18 再新增 `[/ee88a6.png]` 一项映射和一份原图，893 字节。1.1.19 新增 `[/ee84a5.png]` 一项映射和一份原图，696 字节。1.1.20 新增 `[/ee88ab.png]` 一项映射和一份原图，1,023 字节；后三项分别与其已有资源没有相同哈希。四轮新增资源全部为静态 PNG；未将其声称为动画。未再次请求之前报错的表情 API。

`[/ee88a6.png]` 的 [官方原图](https://img.t.sinajs.cn/t4/appstyle/expression/emimage/ee88a6.png) 于 2026-10-21 单次公开读取返回 HTTP 200、`image/png`，无 Cookie、Key 或重定向。PNG SHA-256 为 `663f97e1ce619f72d02f3d901c5b3d70a56da67db1f6114dbc7c7bfe99991573`。Windows Bitmap 实际解码为 20×20、1 帧并逐点读取 400 像素；视觉核对为橙色“得”图案。[Google 官方历史编码资料](https://raw.githubusercontent.com/google/emoji4unicode/master/data/emoji4unicode.xml) 将 UTF-8 十六进制 `ee88a6` 对应的私用区 `E226` 映射到 Unicode `1F250`（圈“得”）。该资料只作为含义旁证，显示仍使用新浪原图，不添加猜测的 `[得]` 别名，也不改写消息中的原始代码。

`[/ee84a5.png]` 的 [官方原图](https://img.t.sinajs.cn/t4/appstyle/expression/emimage/ee84a5.png) 于 2026-10-21 单次公开读取返回 HTTP 200、`image/png`，无 Cookie、Key 或重定向。PNG SHA-256 为 `b280fb9d9deb94883731533aa4251e22b1bfcb5b1a857d63b8c938108d9c8114`。Windows Bitmap 实际解码为 20×20、1 帧并逐点读取 400 像素；视觉核对为浅蓝色票券图案。同一 Google 官方历史资料将 UTF-8 十六进制 `ee84a5` 对应的私用区 `E125` 映射到 Unicode `1F3AB`（票券）。显示使用官方 PNG，不替换为 Unicode 字符或猜测的 `[票券]` 别名；复制、搜索、收藏和导出仍使用原始 `[/ee84a5.png]` 文本。

`[/ee88ab.png]` 的 [官方原图](https://img.t.sinajs.cn/t4/appstyle/expression/emimage/ee88ab.png) 于 2026-10-21 单次公开读取返回 HTTP 200、`image/png`，无 Cookie、Key 或重定向。PNG SHA-256 为 `7b8f4e08f3f704b1470e4c2191f8cf1ecf4f395796e1c719730f8b3e16332533`。Windows Bitmap 实际解码为 20×20、1 帧并逐点读取 400 像素；视觉核对为紫色方框“空”图案。同一 Google 官方历史资料将 UTF-8 十六进制 `ee88ab` 对应的私用区 `E22B` 映射到 Unicode `1F233`（方框“空”，空位）。显示使用新浪原图，不替换为 Unicode 字符，也不添加猜测的 `[空]` 别名；半角、全角及连续代码保持原文语义。

2026-10-25 为 1.1.26 新增下列四项精确代码及四份官方 PNG，共 3,788 字节，均单次匿名读取 HTTP 200、`image/png`、20×20，无 Cookie、Key 或重定向；SHA-256 与已有资源均不同。用 Electron 实际解码并逐张视觉核对。Google 历史映射仅帮助说明含义，显示仍为新浪原图；不添加推测的中文别名，不改写消息文字。

| 代码与官方原图 | 历史映射（SoftBank → Unicode） | PNG 字节 | SHA-256 |
| --- | --- | ---: | --- |
| [`[/ee9095.png]`](https://img.t.sinajs.cn/t4/appstyle/expression/emimage/ee9095.png) | E415 → 1F604，笑眼张嘴笑脸 | 1,113 | `7eb8c1055f0124c787afc62964a811fbe638d6e0fc5c227178db07155c8bddae` |
| [`[/ee8cbe.png]`](https://img.t.sinajs.cn/t4/appstyle/expression/emimage/ee8cbe.png) | E33E → 1F35A，米饭 | 1,060 | `f29906390d86a7e449b8425d4a9cb428770c78676fa4f15a19aa526198a2d68e` |
| [`[/ee84bc.png]`](https://img.t.sinajs.cn/t4/appstyle/expression/emimage/ee84bc.png) | E13C → 1F4A4，睡眠符号 | 512 | `50091d7fe5d3bfdab5e1ff32aceb5bba2c6a4fd57c71eb48bfb93ff5d316f443` |
| [`[/ee9094.png]`](https://img.t.sinajs.cn/t4/appstyle/expression/emimage/ee9094.png) | E414 → 263A，微笑脸 | 1,103 | `2d41a3ace30bcd62e505a8e3875f35c87b731d7022e3c059117032ea2937e592` |

上述四个代码支持半角、全角括号和连续混排；`[/ee9094.png]` 后的变化选择符 U+FE0F（以及 U+FE0E）不影响图像识别，复制时仍保留该字符和原始代码。未知代码、URL 内片段不替换。此次核对的 [Google 历史 XML](https://raw.githubusercontent.com/google/emoji4unicode/master/data/emoji4unicode.xml) 为 162,744 字节，SHA-256 `221369d8cabd3f6f217ba82cf25d41c0f97d283cefa6a9a66de1af69121418d3`；元数据只记录四条精确对应，不引入任意私用区转换。

完整原始公开字典保存在 `app/renderer/emoticons/catalog-source.json`，其映射记录保存在同目录 `catalog-manifest.json`。新增来源保存在 `extensions-source.json`，逐项官方 URL、本地路径、格式、尺寸和 SHA-256 保存在 `extensions-manifest.json`。合并后的实际显示映射为 `app/renderer/emoticon-manifest.js`。验收逐项比较两组来源的名称集合、URL、映射与本地资源哈希，并核对源码和 portable 一致。以下是沿用的三项示例：

| 原始代码 | 官方字典的图片地址 | PNG SHA-256 |
| --- | --- | --- |
| `[二哈]` | https://h5.sinaimg.cn/m/emoticon/icon/others/d_erha-139d0e07bd.png | `7eed8489760eb9867999735f3513ae1bba70bbbefd372500b3bc383b1b9f6485` |
| `[笑cry]` | https://h5.sinaimg.cn/m/emoticon/icon/default/d_xiaoku-f2bd11b506.png | `99375ee3d8d6c1206f36dba4b5de1e63e409ae7c561d1b2dcc9d7923ea378ede` |
| `[哈哈]` | https://h5.sinaimg.cn/m/emoticon/icon/default/d_haha-0ec05e6dad.png | `11a8f895968e10a0868994b204fc567ac3d60bf91f1bdcb658035db27f67e637` |

原图字节保持不变。所有目录名称均接受 `[名称]` 与 `【名称】` 两种括号形式；全角写法是本应用的兼容输入别名，显示同一对应图像，不改写原始文字。

表情使用稳定的内联占位。资源由应用本地提供并缓存，显示时不请求微博、第三方 CDN、AI 或 Notion。缺失、损坏或加载失败时在相同位置显示原始代码，鼠标悬停可查看完整代码。表情不是用户分享的图片，不加入 AI 图片输入；搜索、复制、收藏、导出和摘要使用原始文本。URL 内的代码及未知括号文本保持原样。

这些微博表情图的版权归微博及相应权利人所有，不属于本项目或参考项目 MIT 许可授予的原创代码。这里记录来源和对应关系，不声称取得额外的表情再许可。

官方聊天页面的公开客户端使用 `/webim/emotions.json`。该接口匿名请求返回 `21301` 认证错误后已停止；获得用户新的明确授权后，使用其已有登录的 Chrome 正常导航该地址一次，页面返回 `10012` 服务异常，随后停止。此结果不能证明该 API 已接受浏览器认证，未读取或导出凭据，也未继续猜测参数或重试。

以上 API 的历史失败不影响从正常可见官方选择器核实默认名称；本次没有重试该 API。当前收录资源中官方动画 GIF 为零。除已经明确核实的名称和十三个路径外，未识别代码保留原文；其余聊天分类、付费、自定义和动态目录仍未完整核验。

开发验收使用独立合成消息，不读取真实群聊或推进真实阅读位置。完整目录显示、长代码回退、图片延迟加载及最终 EXE 的实际测试结果，以同次交付报告为准。

## 补充目录核对

2026-10-21 按用户提供的 [Emojipedia 页面](https://emojipedia.org/pt/sina-weibo) 和 [Emojiall 页面](https://www.emojiall.com/zh-hans/platform-weibo) 逐项核对。Emojipedia 的 2021 年 6 月快照明确列出 127 个代码，其中 123 个已有映射；缺少精确对应的是 `点亮橙色、看涨、看跌、带着微博去旅行`。Emojiall 明确标出名称的 81 个代码中，73 个已有映射；余下为 `最右、花心、喵、神兽、睡觉、舔、捂、笑哭`。不将该页面未标出代码名称的图片计入数量。

`浪、肥皂、牛年大吉、牛大发、牛哞哞、武汉加油` 已由现有官方来源覆盖。上述 12 个缺失名称尚无可确认的官方名称与资源对应证据，因此没有将 `喵、睡觉、舔、笑哭` 猜作 `喵喵、睡、舔屏、笑cry`，没有搬用第三方图片。该次第三方目录补充研究新增映射为 0，1.1.17 当时总数为 406；未知代码继续保留原文。

[Google 官方历史编码资料](https://raw.githubusercontent.com/google/emoji4unicode/master/data/emoji4unicode.xml) 可辅助核对原有六个旧路径的含义：`ee8192` 为 SoftBank `E052`、Unicode `1F436`（狗脸，不是 doge）；`ee8cb0 / ee9092 / ee808e / ee819a / ee858c` 分别对应 `1F4A8 / 1F602 / 1F44D / 1F4A9 / 1F4AA`。这些是历史编码旁证，不代表新浪支持全部旧编码。应用使用已核实的新浪原图，不引入整份 Unicode 替换表。
