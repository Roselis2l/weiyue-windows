# PDF.js 6.4.299

本应用随附 Mozilla PDF.js，用于本地 PDF 页面渲染。上游采用 Apache-2.0 许可，原版权声明保留在脚本中。CMaps 与标准字体的附加许可位于 app/pdfjs/cmaps/LICENSE、app/pdfjs/standard_fonts/LICENSE_FOXIT 和 LICENSE_LIBERATION。

- 项目：https://github.com/mozilla/pdf.js
- 文档：https://mozilla.github.io/pdf.js/
- 固定发布包：https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.4.299.tgz
- 发布包 SHA-512 SRI：sha512-AVl138zALtfaAPvADulE0PZThbYzCBS79nL4pOSL/6Sm/4AH5A21BD9VHt97OlCuzJuCpmeZtAtkinisF4Vb1g==
- 发布包 SHA-256：86269b40170eb41740ea05ad2102d71d33de4f122b34eb2f478be0ea7779c415

仅解包 build/pdf.mjs、build/pdf.worker.mjs、CMaps、标准字体及许可；未运行 npm 安装或构建脚本。文件摘要清单为 app/pdfjs/assets.json。文档通过内存字节传入独立 PDF worker，仅渲染页面，不启用 PDF 脚本、XFA、注释交互或文档内的外部链接。本版本禁用动态求值与额外 WASM 加载。
