'use strict';
// Local source preparation only. This file does not run downloaded build scripts,
// install tools, contact a network service, or compile FFmpeg.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'SOURCE-MANIFEST.json'), 'utf8'));
for (const entry of manifest.sources) {
  if (!/^[a-zA-Z0-9._-]+$/.test(entry.file)) throw new Error('Invalid source filename');
  const bytes = fs.readFileSync(path.join(root, 'archives', entry.file));
  if (bytes.length !== entry.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
    throw new Error('Source integrity mismatch: ' + entry.file);
  }
}
if (process.argv[2] === '--verify') {
  console.log('Verified ' + manifest.sources.length + ' source archives. No files changed.');
} else {
  if (!process.argv[2]) throw new Error('Usage: node prepare-rebuild.cjs --verify OR <new-build-directory>');
  if (process.platform === 'win32') throw new Error('Source preparation requires a Linux filesystem for upstream symbolic links. Use Linux/WSL; --verify works on Windows.');
  const output = path.resolve(process.argv[2]);
  if (fs.existsSync(output)) throw new Error('Build directory already exists; choose a new directory.');
  fs.mkdirSync(output, { recursive: true });
  fs.cpSync(path.join(root, 'build-materials', 'upstream'), output, { recursive: true });
  fs.copyFileSync(path.join(root, 'build-materials', 'Dockerfile.local'), path.join(output, 'Dockerfile'));
  for (const entry of manifest.sources) {
    if (entry.repository === 'ffmpegwasm/ffmpeg.wasm' || entry.repository.startsWith('emscripten-core/') || entry.repository === 'libsdl-org/SDL' || entry.repository === 'google/googletest') continue;
    const folder = path.join(output, 'vendor', entry.repository.replace('/', '-'));
    fs.mkdirSync(folder, { recursive: true });
    execFileSync('tar', ['-xzf', path.join(root, 'archives', entry.file), '-C', folder, '--strip-components=1'], { stdio: 'inherit' });
  }
  const googletest = manifest.sources.find(entry => entry.repository === 'google/googletest');
  const submoduleFolder = path.join(output, 'vendor', 'sekrit-twc-zimg', 'test', 'extra', 'googletest');
  fs.mkdirSync(submoduleFolder, { recursive: true });
  execFileSync('tar', ['-xzf', path.join(root, 'archives', googletest.file), '-C', submoduleFolder, '--strip-components=1'], { stdio: 'inherit' });
  console.log('Prepared local build context: ' + output);
  console.log('Review REBUILD.md and the scripts before building. Nothing was compiled.');
}
