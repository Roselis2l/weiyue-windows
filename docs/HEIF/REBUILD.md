# 重建和替换 HEIC 解码库

本说明用于行使第三方库许可授予的修改、重建和替换权利。随包提供对应源码，而不是仅提供将来获取源码的承诺。应用自身代码位于源码包 `app/`，按根目录 `LICENSE` 分发。

## 版本关系

1. npm 包 `libheif-js@1.23.5` 的 `gitHead` 为 `d8ec4bc3bc5bf8055975577bccbbc7e1d7313c2d`。
2. 该提交的 `scripts/install.js` 指向 `libheif-emscripten` 的 `v1.23.5` 发布产物。
3. 构建仓库该标签的提交为 `5c8968a44e9c68ae677e24790d77d001ed7fe7cc`，其 `libheif` 子模块固定为 `413e2a87e6a70b3eccc3a3adc5801179dd2d9e00`。
4. 对应 `build-emscripten.sh` 默认使用 libde265 1.0.15。随包提供其官方发布源码归档。

所有来源与压缩包 SHA-256 见本目录 `SOURCE-MANIFEST.json`。将每个压缩包解压到独立、空的开发目录中；不要解压到正在使用的 portable 程序或数据目录。

## 上游构建方式

官方构建工作流副本位于 `build-materials/emscripten.yml`，完整仓库在 `sources/libheif-emscripten-v1.23.5-5c8968a.tar.gz`。工作流使用 Ubuntu 22.04、Emscripten 3.1.61、Node.js 24 和 TypeScript 5；CMake、编译器及常规构建工具由上游安装/准备脚本指定。

按照归档中的工作流布局，将 libheif 对应源码放进构建仓库的 `libheif/` 子目录，以补齐源码归档不自动包含的 Git 子模块。将随附 `libde265-1.0.15.tar.gz` 放到 libheif 构建工作目录，供脚本读取；不必再次下载该依赖。

对 WASM 构建，官方工作流把 `libheif/scripts/run-ci.sh` 中的 `USE_WASM=0` 替换成 `USE_WASM=1 USE_UNSAFE_EVAL=0`，并把 `USE_TYPESCRIPT=0` 改成 `USE_TYPESCRIPT=1`。因此使用的发布流程关闭 JavaScript 动态执行。直接调用 `build-emscripten.sh` 时也应明确保留：

```sh
USE_WASM=1 USE_UNSAFE_EVAL=0 USE_TYPESCRIPT=1 ./build-emscripten.sh .
```

该命令是假定已按官方流程准备好 Emscripten 环境、当前目录为独立构建的 libheif 源码目录的重建步骤；不是 Windows 应用启动步骤。需要的通用编译工具不随应用分发。请先审查脚本再在自己的开发环境执行。

上游 `build-emscripten.sh` 的相关默认配置为：

- libde265 1.0.15 解码器开启；AOM、WebCodecs、OpenJPEG 和未压缩编码的可选路径关闭。
- 禁用原生插件动态加载，关闭多线程支持。
- WASM 允许内存增长；微阅在外层另行实施输入、像素、并发和时间限制。

再使用 `libheif-emscripten` 的 `dist-prep.sh` 所示布局，生成 `libheif-wasm/libheif.js` 与 `libheif-wasm/libheif.wasm`。

## JavaScript bundle

将生成的 `libheif-wasm/` 放入随附 `libheif-js` 源码根目录。该项目的 `scripts/bundle.js` 将本地 WASM 字节传入初始化函数；`scripts/install.js` 后半部列出 esbuild 打包选项，包括 `libheif-wasm/libheif-bundle.js` 的 IIFE 输出和 CommonJS 兼容导出。

可按源代码中的 esbuild 配置重新生成兼容 bundle。`scripts/install.js` 也接受本地产物归档路径；它会重建包装器输出目录，执行前应在独立源码副本中审查其文件操作。这里没有代用户运行该脚本。

`libheif-js` 源码的 `package.json` 保留其构建依赖范围；上游未在此提交中提供锁定全部打包工具版本的锁文件。本交付提供产生兼容替代库所需的对应库源码和构建材料，但没有声称已在本机从源码重建，或能得到与 npm 产物逐字节一致的结果。实际交付使用固定 npm 包及其校验值审查后的产物。

## 替换与验证

微阅以独立、可替换的文件加载解码库，没有把它封入不可替换的可执行文件。关闭微阅后，保留原库备份，替换应用 `app/decoder/libheif/libheif-bundle.js`；portable 版本中的对应位置在 `resources/app/` 下面。

替代库须保留 libheif-js 的 `libheif` 初始化函数，以及 `heif_context_alloc`、`heif_context_read_from_memory`、`heif_context_get_primary_image_handle`、`heif_context_free` 和 `HeifImage` 接口。微阅只读取主图，使用 `HeifImage.get_width`、`get_height`、`display` 和 `free`；不依赖枚举全部缩略图/辅助图的 `HeifDecoder` 路径。实际接口调用以 `app/decoder/heif-worker.js` 为准。重建应用或替换兼容库后，运行随源码提供的 HEIF 测试与 Windows 解码/UI验收。不要关闭应用的沙箱、网络阻断或来源检查来容纳不兼容的替代库。

更改第三方库时应标注所作修改，并按其适用许可随新分发包继续提供对应源码、许可和版权声明。SHA-256 清单是发布材料核对依据，不用于阻止用户在自己的副本中替换兼容库。
