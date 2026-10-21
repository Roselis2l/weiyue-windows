# 本地 FFmpeg 视频兼容组件

微阅使用官方 `@ffmpeg/core 0.12.10` 单线程 WebAssembly 核心，为浏览器原生解码失败的短视频提供本地转换。处理在隔离 Worker 内完成；文件不会因此上传 AI、Notion 或其他远程转码服务。具体输入大小、时长及输出限制以应用实现和使用说明为准。

该核心按 **GPL-2.0-or-later** 分发；它不是 MIT 组件。微阅原有源码及 ffmpeg.wasm 的 JavaScript 包装层保留其 MIT 许可，第三方核心及链接库各自的许可证不会被项目根目录 MIT 文件替代。发布包应同时保留应用完整源码、以下对应源码和许可证，不应将整套便携包表述为“全部 MIT”。这份技术记录不是法律合规审计结论。

## 随包材料

运行文件位于 `app/decoder/ffmpeg/`；portable 中前缀为 `resources/app/app/decoder/ffmpeg/`：

- `ffmpeg-core.js` / `ffmpeg-core.wasm`：官方 npm UMD 文件，未经修改。
- `assets.json`：运行资源大小、SHA256、npm SHA512 完整性值与源码索引。
- `LICENSE.GPL-2.0.txt` / `licenses/`：GPL 全文及主要依赖的版权、许可、专利通知。
- `source/archives/`：21 份完整上游源码压缩包，包括 FFmpeg、15 个外部库、SDL2、Emscripten 运行时/SDK、ffmpeg.wasm 构建源码及 zimg 的构建子模块。
- `source/SOURCE-MANIFEST.json` / `SHA256SUMS.txt`：固定提交、来源和每个源码包的校验值。
- `source/build-materials/` / `REBUILD.md` / `prepare-rebuild.cjs`：原始构建脚本、固定提交/本地源码的 Dockerfile 及替换重建说明。

源码材料只存放一份，随应用和完整源码包一并提供；没有包含用户视频、群聊、账户或凭据。这里只核验、静态审读和整理上游材料，没有执行其构建脚本。没有声称已完成逐字节可复现构建。

## 主要组件及许可

| 组件 | 使用版本 | 许可/通知 |
| --- | --- | --- |
| FFmpeg | n5.1.4 | 启用 GPL 的构建；GPL-2.0-or-later，保留源文件中的其他许可 |
| x264 / x265 | 官方构建指定提交 / 3.4 | GPL v2，具体后续版本选项以各源文件为准 |
| libvpx / Ogg / Theora / Vorbis / Opus | 1.13.1 / 1.3.4 / 1.1.1 / 1.3.3 / 1.3.1 | BSD 类许可及随附版权/专利通知 |
| LAME / FriBidi | 固定 master 提交 / 1.0.9 | LGPL，详见 COPYING |
| zlib / libwebp / FreeType | 1.2.11 / 1.3.2 / 2.10.4 | zlib / BSD 类 / FreeType 或 GPL 选项，保留原文 |
| HarfBuzz / libass / zimg | 5.2.0 / 0.15.0 / 3.0.5 | MIT 类 / ISC / WTFPL 等，以源文件和完整 COPYING 为准 |
| SDL2 | 2.24.2 | zlib 许可 |
| Emscripten / emsdk | 3.1.40 | MIT、NCSA 及附带标准库/运行时各自许可 |
| ffmpeg.wasm 构建与绑定 / GoogleTest 子模块 | v12.15 / 固定提交 | MIT / BSD 类，保留原文 |

每个依赖的完整版权、许可选项、子组件许可和专利声明以随附原始源码为准。修改、重建、替换组件的步骤见 `source/REBUILD.md`；应用不要求额外签名密钥才能使用修改后的核心。

## 官方来源与核验

- [ffmpeg.wasm 官方 v12.15 发布](https://github.com/ffmpegwasm/ffmpeg.wasm/releases/tag/v12.15)明确对应 core 0.12.10；源码提交为 `71aa99d37c02a7b4c435275ca9ef50e612f6efa1`。
- [官方 npm 包元数据](https://registry.npmjs.org/@ffmpeg/core/0.12.10)的 tarball SHA512 已实际比对通过；npm 记录没有 `gitHead` 或可复现构建证明，因此这里只依据官方发布、版本与构建脚本建立对应关系。
- [官方许可说明](https://ffmpegwasm.netlify.app/docs/faq/)说明 core 继承 FFmpeg 及所链接依赖的许可，与 JavaScript 包装层的 MIT 许可不同。

WASM SHA256：`9f57947a5bd530d8f00c5b3f2cb2a3492faa7e5d823315342d6a8656d0a6b7b7`。

UMD JavaScript SHA256：`b266ab5b952555881dd6310663986994a182acb2b7ff25cf10a25f7a37ac2b21`。
