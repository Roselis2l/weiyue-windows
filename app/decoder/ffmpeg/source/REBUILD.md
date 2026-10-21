# FFmpeg WASM 0.12.10 — source and rebuild materials

The adjacent `../ffmpeg-core.js` and `../ffmpeg-core.wasm` are unmodified UMD files from the official npm package `@ffmpeg/core@0.12.10`. They are the single-thread build, with SIMD. Its GPL license is `../LICENSE.GPL-2.0.txt`; component notices are in `../licenses/`. This directory is distributed in both the application and full source package.

`SOURCE-MANIFEST.json` records the npm SHA512, binary SHA256, upstream release, exact source commits, archive sizes and SHA256. `SHA256SUMS.txt` covers all 21 source archives. All source licenses, copyright notices and applicable patent notices remain in the complete archives; readable copies of principal notices are also supplied in `../licenses/`.

## Provenance and limits

- The official [v12.15 release](https://github.com/ffmpegwasm/ffmpeg.wasm/releases/tag/v12.15) explicitly identifies core/core-mt 0.12.10. Its source commit is `71aa99d37c02a7b4c435275ca9ef50e612f6efa1` and `packages/core/package.json` is 0.12.10. **The similarly named v0.12.10 tag belongs to an older wrapper/core combination and is not this source.**
- The matching Dockerfile uses FFmpeg n5.1.4, Emscripten 3.1.40 and the 15 external codec/text/image libraries listed in the manifest. Their complete source archives are included. Mutable x264 `4-cores` and LAME `master` refs have been resolved to commits whose timestamps predate the package release; the manifest preserves their exact hashes.
- SDL 2.24.2 is the Emscripten 3.1.40 port used by `-sUSE_SDL=2`. Its source ZIP SHA512 matches the hash embedded in that Emscripten port definition. The Emscripten runtime/standard-library source, SDK release manifests, and zimg's recursive GoogleTest submodule are included. Emscripten's optional test-suite submodules are not part of the core build and are not included.
- The upstream npm record does not contain `gitHead` or a reproducible-build attestation. Correspondence is established from the official release/package/build files. We verified downloads and inspected the build materials; **we did not rebuild this FFmpeg core or establish a bit-for-bit reproducible build**. The Docker base and Linux package repository are versioned inputs, not frozen filesystem images. No claim of a legal audit is made.

## Verify and prepare

Use Node.js and `tar` on a Linux filesystem (a Linux host or WSL, then Docker Desktop's Linux backend). The preparer performs hash checks and local archive extraction only. It does not install or execute upstream code, compile anything, or download files. Choose a new destination; it refuses to overwrite an existing directory. `--verify` also works on native Windows. Full preparation rejects native Windows before writing because upstream zimg sources include symbolic links that Windows tar cannot reliably create; source archives are kept intact.

```sh
node prepare-rebuild.cjs --verify
node prepare-rebuild.cjs /tmp/weiyue-ffmpeg-core-build
cd /tmp/weiyue-ffmpeg-core-build
```

`build-materials/upstream/` retains the original Dockerfile, Makefile, all build scripts, C bindings, custom ffmpeg/ffprobe sources and package metadata. The preparer substitutes `Dockerfile.local`, which uses the bundled source trees instead of fetching the codec library refs. `Dockerfile.pinned` is an additional reference that replaces upstream library refs with their exact commit hashes. Neither changes codec settings.

Review the source and scripts, then use Docker Buildx with the original production single-thread flags:

```sh
docker buildx build --build-arg FFMPEG_ST=yes --build-arg EXTRA_CFLAGS="-O3 -msimd128" -o ./rebuilt .
```

This explicit build step runs the reviewed upstream build scripts. It requires the official `emscripten/emsdk:3.1.40` toolchain image and standard build utilities from the base distribution. Emscripten may fetch its SDL port from the official URL; the exact matching source archive is already supplied here, and the port verifies its SHA512. The image, Linux toolchain packages and LLVM executable are standard build tools, not bundled executables. Their versions/manifests are recorded by the SDK source. Preserve the selected image digest and tool versions when recording a reproduction attempt.

Outputs are `rebuilt/dist/umd/ffmpeg-core.js` and `.wasm` (plus the unused ESM build). To use a reviewed modified core, replace both application files and update their byte lengths and SHA256 values in `../assets.json`. The application's integrity check verifies these values before serving the local decoder. No signature or private key is required to replace it. Run the isolated decoder/media regressions before distributing a modified build.

The source package also contains WeiYue's caller, isolated renderer/worker and build files. Keep the corresponding source and notices together when redistributing this GPL component; do not label the entire portable distribution as MIT-only. Original WeiYue source and upstream MIT notices remain preserved, while this core and its linked dependencies retain their own licenses. There is no warranty, including merchantability or fitness for a particular purpose, to the extent allowed by the applicable licenses.
