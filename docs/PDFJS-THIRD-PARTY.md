# PDF.js 第三方组件

微阅 1.1.12 随包提供固定版本 **PDF.js 6.4.299** 的本地 PDF 渲染资源。PDF 文档在本机解析并绘制到画布；应用不从运行时 CDN 下载 PDF.js，也不将文档发给 PDF.js 作者或其他服务。

- 上游项目：[Mozilla PDF.js](https://github.com/mozilla/pdf.js)。
- 固定分发包：[pdfjs-dist 6.4.299](https://www.npmjs.com/package/pdfjs-dist/v/6.4.299)。
- 主许可：Apache License 2.0，完整文本保留在 `app/pdfjs/LICENSE`。
- 随附字符映射许可：`app/pdfjs/cmaps/LICENSE`。
- 随附字体许可：`app/pdfjs/standard_fonts/LICENSE_FOXIT` 与 `LICENSE_LIBERATION`。
- 随附文件清单、大小与 SHA-256：`app/pdfjs/assets.json`。

源码包中的相对路径在 portable 中位于 `resources/app/` 下。第三方文件及各文件原有版权声明按其适用许可保留，应用自身 MIT 许可不替代第三方许可。修改或重新分发组件时，应继续保留这些声明并按适用许可处理改动。

本地 PDF.js 预览不执行文档脚本，也不承诺复现所有 PDF 表单、动画、附件或交互效果。加密、损坏或超出应用资源限制的文档可能无法预览。此次使用的资源包括核心模块、worker、字符映射与基础字体，完整配置以应用代码和随附文件清单为准。
