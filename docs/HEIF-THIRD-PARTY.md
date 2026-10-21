# HEIF / HEIC 解码依赖与对应源码

微阅使用本地 `libheif-js 1.23.5` WebAssembly 解码库，处理实际为 HEIC、却被上游标记为 JPEG 的图片。库在本机运行，不向解码库作者或第三方服务器发送图片。主应用的 MIT 许可不替代下列第三方组件的许可。

| 组件 | 固定版本或提交 | 许可与用途 |
| --- | --- | --- |
| libheif-js | 1.23.5；`d8ec4bc3bc5bf8055975577bccbbc7e1d7313c2d` | LGPL-3.0；JavaScript 包装和本地 WASM bundle |
| libheif-emscripten 构建材料 | v1.23.5；`5c8968a44e9c68ae677e24790d77d001ed7fe7cc` | 保留上游构建文件及其声明；用于定位官方构建方式 |
| libheif | 1.23.5；`413e2a87e6a70b3eccc3a3adc5801179dd2d9e00` | 库为 LGPL-3.0-or-later；个别辅助文件按原文件许可 |
| libde265 | 1.0.15 官方发布源码包 | 库为 LGPL-3.0-or-later；HEVC 解码 |
| Emscripten 运行时声明 | 3.1.61 | 完整许可说明随附，包含 MIT、NCSA 等适用声明 |

libheif、libde265 的源文件保留 struktur AG、Dirk Farin、Joachim Bauch 及其他上游贡献者的版权声明。libheif-js 的上游作者为 Kiril Vatev。具体作者、年份及每个文件适用的许可，以随附完整源码和许可文本为准。

本地解码依赖保留上游许可，不提供适销性或特定用途适用性的保证。允许按适用许可修改解码库，以及为调试这些修改进行逆向工程。微阅未对这种修改施加额外限制。

## 随包材料

`docs/HEIF/` 随源码包及 portable 包交付：

- `licenses/`：完整 LGPL v3、GPL v3、相关 MIT 及 Emscripten 许可文本。
- `sources/`：上述四个解码器/包装器/构建仓库的固定版本源码压缩包，包括 C/C++ 源码、JavaScript 包装、构建配置和源文件版权声明。
- `build-materials/`：便于审查的官方构建工作流、构建脚本和 JavaScript 打包入口副本；完整版本也在源码压缩包内。
- `SOURCE-MANIFEST.json` 与 `SHA256SUMS.txt`：每份下载材料的官方来源、版本、大小和 SHA-256。
- `REBUILD.md`：重建兼容库、替换应用所用库及验证的方法。

这些材料属于公开上游代码；不包含群聊、账号会话、Cookie、AI 密钥或本机测试图片。开发过程中仅下载、校验和审读这些上游脚本，没有执行它们。

解码器文件位于 `app/decoder/libheif/libheif-bundle.js`，按上游产物原样复制；portable 中该路径位于 `resources/app/` 下面。同目录保留上游 `LICENSE` 和 `provenance.json`。

- 官方 npm 包：`https://registry.npmjs.org/libheif-js/-/libheif-js-1.23.5.tgz`
- npm 包 SHA-256：`d0bfe7198bd624c524cef8ccf78e15ceb42683c87598c64c2e13ced0d8680932`
- 实际 bundle SHA-256：`074b2b55ef3de477ba9f794ca381f3f0324c1cba8c91b4af07395f39c22d54cc`

## 官方来源

- [libheif-js 固定源码](https://github.com/catdad-experiments/libheif-js/tree/d8ec4bc3bc5bf8055975577bccbbc7e1d7313c2d)
- [libheif-js 1.23.5 npm 分发](https://www.npmjs.com/package/libheif-js/v/1.23.5)
- [对应 Emscripten 构建仓库](https://github.com/catdad-experiments/libheif-emscripten/tree/5c8968a44e9c68ae677e24790d77d001ed7fe7cc)
- [libheif 固定源码](https://github.com/strukturag/libheif/tree/413e2a87e6a70b3eccc3a3adc5801179dd2d9e00)
- [libde265 1.0.15](https://github.com/strukturag/libde265/releases/tag/v1.0.15)
- [Emscripten 3.1.61 许可](https://github.com/emscripten-core/emscripten/blob/3.1.61/LICENSE)

上游构建流程默认启用 libde265，并未启用 AOM。这里的 HEIC 解码支持不代表已实现 AVIF 或其他 HEIF 编码方式。
