> **本页保留原有应用与 Electron 运行时通知。** 1.1.23 另含 [FFmpeg 本机兼容组件及对应源码](FFMPEG-THIRD-PARTY.md)（GPL-2.0-or-later）、[HEIC 解码库](HEIF-THIRD-PARTY.md)、[PDF.js](PDFJS-THIRD-PARTY.md)及[官方表情资源](WEIBO-EMOTICONS.md)。不能将整套分发包视为完全 MIT；各组件完整许可和材料均须保留。

# 来源、版权与第三方组件

## WeiYue Windows 与原项目

WeiYue Windows 是参考 [ylj5244-dot/weiyue](https://github.com/ylj5244-dot/weiyue) 的产品思路和微博群聊协议实现而开发的 Windows/Electron 重写。原项目采用 Swift、AppKit 和 WebKit，面向 macOS；本项目采用 Electron、Node.js 与 HTML/CSS/JavaScript。

参考提交为 [`7b6c7203490b9110f3b109e53b0e24b4aad1ccac`](https://github.com/ylj5244-dot/weiyue/tree/7b6c7203490b9110f3b109e53b0e24b4aad1ccac)。协议适配与 JSON 大整数标识符处理参考了原作；这不是 clean-room 实现。相关源码保留了出处说明。

原项目版权：

> Copyright (c) 2026 ylj5244-dot

本应用源码以 MIT 许可发布。源码仓库根目录的 `LICENSE` 及 [REFERENCE-LICENSE.txt](REFERENCE-LICENSE.txt) 保留原作完整 MIT 许可和版权通知。`WeiYue Windows contributors` 用于描述 Windows 实现贡献，不替换原作署名，也不代表已经核实某个个人或组织是全部代码的权利人。

MIT 允许使用、修改、复制和分发，包括商业使用；分发副本或实质部分时须保留版权及许可声明。MIT 不要求使用 GitHub fork，也不要求公开仓库。本项目使用独立仓库组织 Windows 开发，同时保留原项目的来源关系。

## 应用源码和 portable 的许可证范围

应用源码的 MIT 许可不意味着 portable 包内所有组件都使用 MIT。Windows portable 包还包含官方 Electron 运行时及其 Chromium、Node.js、FFmpeg 等依赖，各组件按其各自许可分发。

请保留 portable 根目录的下列文件：

| 文件 | 作用 |
| --- | --- |
| `LICENSE` | 官方 Electron 版权和 MIT 许可。 |
| `LICENSES.chromium.html` | 官方运行时附带的完整第三方版权及许可通知，包含多种许可证。 |
| `LICENSE-WeiYue.txt` | 本应用源码的 MIT 通知。 |
| `LICENSE-Reference-WeiYue.txt` | 原 WeiYue 项目的完整 MIT 通知。 |
| `BUILD-INFO.json` | 应用版本、Electron 版本及原始运行时 archive 的校验信息。 |

Electron 自身的版权声明为 Electron contributors 与 GitHub Inc.，详见 [Electron 44.9.0 LICENSE](https://github.com/electron/electron/blob/v44.9.0/LICENSE)。本项目打包时保留其官方 `LICENSE` 和 `LICENSES.chromium.html` 原文；如再次分发 portable，请一并保留这些文件，不能仅留下本项目的 MIT 文本。

## 本版运行时来源

| 组件 | 本版来源 |
| --- | --- |
| Electron | [`v44.9.0`](https://github.com/electron/electron/releases/tag/v44.9.0)，官方 `electron-v44.9.0-win32-x64.zip`。 |
| Chromium | `152.0.7977.167`，由 [Electron 44.9.0 DEPS](https://github.com/electron/electron/blob/v44.9.0/DEPS) 固定。 |
| Node.js | `v24.22.0`，同样由 Electron DEPS 固定。 |
| FFmpeg | `2b68d2babae73714846961fb0ee47e3b3d2e39a9`，由 [Chromium 152.0.7977.167 DEPS](https://github.com/chromium/chromium/blob/152.0.7977.167/DEPS) 固定，再应用该 Electron tag 规定的补丁。 |

原始 Electron Windows x64 archive 的 SHA256：

```text
88e08039d0ef359bab9f674e8051fa103bd8628ea7c5a5e1daaa610a8a0c6931
```

本项目没有改编译 Electron/Chromium/Node/FFmpeg；打包脚本校验官方 archive，解压后将 `electron.exe` 重命名为 `WeiYue.exe`，再放入本应用源码。

## FFmpeg 及对应源码入口

FFmpeg 的通知和 LGPL 2.1 许可全文包含在官方 `LICENSES.chromium.html` 中。FFmpeg 主体适用 LGPL 2.1 或更高版本，部分可选组件使用其他许可，具体以该版本源码及附带通知为准。不能仅凭 Electron 的 MIT 声明替代 FFmpeg 的许可条件。参见 [FFmpeg 官方许可说明](https://www.ffmpeg.org/legal.html)。

portable 保留独立的 `ffmpeg.dll`，不将它合并、隐藏或设置应用层替换限制。使用者可以按相关许可修改并替换为与该 Electron 版本兼容的库；替换后的功能与兼容性需要自行验证。本应用的 MIT 许可不加入禁止相关修改或调试的限制。

可从以下固定来源查阅和取得本版相关源码及构建材料：

- [Electron 44.9.0 源码树](https://github.com/electron/electron/tree/v44.9.0) 与 [tag 源码 tar.gz](https://github.com/electron/electron/archive/refs/tags/v44.9.0.tar.gz)。
- [Electron 44.9.0 DEPS](https://github.com/electron/electron/blob/v44.9.0/DEPS)：依赖版本及获取位置。
- [Chromium 152.0.7977.167 DEPS](https://github.com/chromium/chromium/blob/152.0.7977.167/DEPS)：包括精确 FFmpeg revision。
- [FFmpeg 精确源码树](https://chromium.googlesource.com/chromium/third_party/ffmpeg/+/2b68d2babae73714846961fb0ee47e3b3d2e39a9/) 与 [该 revision 的 tar.gz 入口](https://chromium.googlesource.com/chromium/third_party/ffmpeg/+archive/2b68d2babae73714846961fb0ee47e3b3d2e39a9.tar.gz)；Git 源为 `https://chromium.googlesource.com/chromium/third_party/ffmpeg.git`。
- [Electron FFmpeg 补丁清单](https://github.com/electron/electron/blob/v44.9.0/patches/ffmpeg/.patches) 与 [link_with_loader_path.patch](https://github.com/electron/electron/blob/v44.9.0/patches/ffmpeg/link_with_loader_path.patch)。该清单仅列出此补丁，内容涉及 macOS dylib 链接路径；应与精确依赖版本一并保留来源记录。
- [补丁应用配置](https://github.com/electron/electron/blob/v44.9.0/patches/config.json)、[公共构建参数](https://github.com/electron/electron/blob/v44.9.0/build/args/all.gn) 和 [Release 构建参数](https://github.com/electron/electron/blob/v44.9.0/build/args/release.gn)。
- [Electron 44.9.0 构建说明](https://github.com/electron/electron/blob/v44.9.0/docs/development/build-instructions-gn.md)：说明如何按 DEPS 获取依赖及生成构建配置。应固定到 `v44.9.0`，不要用最新主分支代替。

Electron 的 tag 源码归档本身不包含所有外部依赖；对应来源需结合 DEPS、补丁和构建说明获取。该版构建参数采用共享 FFmpeg，且默认启用 proprietary codecs；这项构建设置不等同于所有使用场景都获得了专利或商标许可。

已核对本版的精确依赖链、源码页面、补丁及运行时附带通知；未在本项目中下载并重新构建完整 Electron 依赖树，亦未将上述入口重新打成一份经过重建验证的源码归档。这份说明用于准确提供来源和通知，不宣称是所有组件、所有使用场景的完整合规判定，也不代表发布者作出了额外的长期源码托管承诺。
