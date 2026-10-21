'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createHash } = require('node:crypto');
const { deflateSync } = require('node:zlib');
const { createEmoticonAssets, MAX_BYTES, MAX_EDGE, MAX_GIF_FRAMES, MAX_CACHE_BYTES } = require('../app/core/emoticon-assets.cjs');
const root = path.resolve(__dirname, '../app/renderer');
const manifest = require('../app/renderer/emoticon-manifest.js');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const serve = (service, src, method = 'GET', argument = src) => service.serve({ method, url: src }, new URL(argument));

function crc(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes = Buffer.alloc(0)) {
  const body = Buffer.concat([Buffer.from(type), bytes]), output = Buffer.alloc(body.length + 8);
  output.writeUInt32BE(bytes.length); body.copy(output, 4); output.writeUInt32BE(crc(body), output.length - 4);
  return output;
}
function png(width = 1, height = 1, padding = 0) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    ...(padding ? [chunk('tEXt', Buffer.alloc(padding, 65))] : []),
    chunk('IDAT', deflateSync(rows)), chunk('IEND')]);
}
function synthetic(bytes, readFile = () => bytes, descriptor = {}) {
  const src = 'app://local/emoticons/test.png';
  return { src, service: createEmoticonAssets({ root, manifest: { test: { src, sha256: hash(bytes), ...descriptor } }, readFile }) };
}

test('complete public official catalogue matches every bundled mapping and serves its verified local PNG bytes', async () => {
  const sourceBytes=fs.readFileSync(path.join(root,'emoticons/catalog-source.json'));
  const source=JSON.parse(sourceBytes),catalog=JSON.parse(fs.readFileSync(path.join(root,'emoticons/catalog-manifest.json')));
  assert.equal(hash(sourceBytes),catalog.source.sha256);
  assert.equal(sourceBytes.length,catalog.source.bytes);
  assert.equal(catalog.source.url,'https://h5.sinaimg.cn/m/emoticon/all.json');
  assert.deepEqual(Object.keys(manifest).sort(),Object.keys(source).sort());
  assert.equal(catalog.mappingCount,308);
  assert.equal(catalog.mappingCount,Object.keys(manifest).length);
  assert.equal(catalog.uniqueResourceCount,307);
  assert.equal(catalog.chatDirectory.publicAccess,false);
  assert.equal(catalog.chatDirectory.errorCode,21301);
  const categories={},unique=new Map();
  for(const [name,descriptor] of Object.entries(manifest)){
    assert.equal(descriptor.sourceUrl,'https:'+source[name].source);
    assert.equal(descriptor.group,source[name].group);
    assert.deepEqual(catalog.entries.find(entry=>entry.name===name),{name,...descriptor});
    assert.equal(descriptor.format,'png');assert.equal(descriptor.animated,false);
    assert.equal(descriptor.width,64);assert.equal(descriptor.height,64);
    categories[descriptor.group]=(categories[descriptor.group]||0)+1;
    unique.set(descriptor.src,descriptor);
  }
  assert.deepEqual(categories,catalog.categories);
  assert.equal(unique.size,catalog.uniqueResourceCount);
  assert.equal(manifest['航天员'].src,manifest['宇航员'].src);
  assert.equal(manifest['航天员'].sha256,manifest['宇航员'].sha256);
  assert.notEqual(manifest['航天员'].sourceUrl,manifest['宇航员'].sourceUrl);
  assert.deepEqual(['二哈','笑cry','哈哈'].map(name=>manifest[name].src),
    ['erha.png','xiaoku.png','haha.png'].map(name=>'app://local/emoticons/'+name));
  const reads = [], service = createEmoticonAssets({ root, manifest, readFile: filename => {
    reads.push(filename); return fs.readFileSync(filename);
  } });
  assert.equal(reads.length,0,'Loading the catalogue must not preload hundreds of image files');
  for (const descriptor of unique.values()) {
    const response = serve(service, descriptor.src);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(hash(bytes), descriptor.sha256);
    assert.equal(bytes.length,descriptor.bytes);
    assert.ok(bytes.length <= MAX_BYTES);
    assert.ok(bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(16) <= MAX_EDGE);
    assert.ok(bytes.readUInt32BE(20) > 0 && bytes.readUInt32BE(20) <= MAX_EDGE);
    const again = serve(service, descriptor.src);
    assert.equal(hash(Buffer.from(await again.arrayBuffer())), descriptor.sha256);
  }
  assert.equal(reads.length,unique.size,'Each distinct image should be read once during its adjacent requests');
  assert.deepEqual(reads.sort(),[...unique.keys()].map(src=>path.join(root,'emoticons',path.basename(src))).sort());
});

test('default readFile serves a valid temporary fixture and only the immutable byte copy is cached', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'weiyue-emoticon-assets-'));
  t.after(() => {
    fs.unlinkSync(path.join(temp, 'emoticons/test.png'));
    fs.rmdirSync(path.join(temp, 'emoticons'));
    fs.rmdirSync(temp);
  });
  fs.mkdirSync(path.join(temp, 'emoticons'));
  const bytes = png(), src = 'app://local/emoticons/test.png';
  fs.writeFileSync(path.join(temp, 'emoticons/test.png'), bytes);
  const service = createEmoticonAssets({ root: temp, manifest: { test: { src, sha256: hash(bytes) } } });
  assert.deepEqual(Buffer.from(await serve(service, src).arrayBuffer()), bytes);
  fs.writeFileSync(path.join(temp, 'emoticons/test.png'), Buffer.from('changed after verified read'));
  assert.deepEqual(Buffer.from(await serve(service, src).arrayBuffer()), bytes);
  const mutable = Buffer.from(bytes), fixture = synthetic(bytes, () => mutable);
  const first = Buffer.from(await serve(fixture.service, fixture.src).arrayBuffer());
  mutable.fill(0); first.fill(0);
  assert.deepEqual(Buffer.from(await serve(fixture.service, fixture.src).arrayBuffer()), bytes);
});

test('unknown paths, hosts, methods, queries, hashes and traversal never read a file', async () => {
  let reads = 0;
  const bytes = png(), { service, src } = synthetic(bytes, () => { reads++; return bytes; });
  const targets = [
    'app://local/emoticons/missing.png', 'app://local/emoticons/test.gif', 'app://local/other/test.png',
    'app://other/emoticons/test.png', 'https://local/emoticons/test.png',
    'app://local:80/emoticons/test.png', 'app://user@local/emoticons/test.png',
    src + '?v=1', src + '#anchor', src + '\n', 'app://local/emoticons/../emoticons/test.png',
    'app://local/emoticons/%2e%2e/emoticons/test.png', 'app://local/emoticons/%74est.png',
    'app://local/emoticons/sub/../test.png', 'app://local/emoticons\\test.png',
    'app://local/emoticons/test.png/', 'app://LOCAL/emoticons/test.png',
  ];
  for (const target of targets) {
    const response = serve(service, target);
    assert.equal(response.status, 404, target);
    assert.equal(await response.text(), 'Not found');
  }
  for (const method of ['HEAD', 'POST', 'PUT', 'get', '', undefined]) {
    const response = service.serve({ method, url: src }, new URL(src));
    assert.equal(response.status, 404);
  }
  assert.equal(serve(service, src, 'GET', 'app://local/emoticons/missing.png').status, 404);
  assert.equal(service.serve(null, new URL(src)).status, 404);
  assert.equal(reads, 0);
});

test('missing files, mismatched hashes and non-byte results return fixed 404 without leaked file paths', async () => {
  const bytes = png();
  for (const fixture of [
    synthetic(bytes, () => { throw Error('PRIVATE PATH ' + root); }),
    synthetic(bytes, () => bytes, { sha256: '0'.repeat(64) }),
    synthetic(bytes, () => 'not bytes'), synthetic(bytes, () => new ArrayBuffer(bytes.length)),
    synthetic(bytes, () => null),
  ]) {
    const response = serve(fixture.service, fixture.src);
    assert.equal(response.status, 404); assert.equal(await response.text(), 'Not found');
    assert.match(response.headers.get('content-type'), /^text\/plain/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  }
});

test('PNG magic, header, dimensions, CRC, truncation, ending and byte budgets are checked despite matching SHA', () => {
  const valid = png(), badCrc = Buffer.from(valid), badMagic = Buffer.from(valid);
  badCrc[badCrc.length - 1] ^= 1; badMagic[0] = 0;
  const invalid = [badCrc, badMagic, valid.subarray(0, 24), valid.subarray(0, valid.length - 1),
    Buffer.concat([valid, Buffer.from('trailing')]), png(0, 1), png(1, 0),
    png(MAX_EDGE + 1, 1), png(1, MAX_EDGE + 1), png(1, 1, MAX_BYTES),
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'),
  ];
  for (const bytes of invalid) {
    const fixture = synthetic(bytes);
    assert.equal(serve(fixture.service, fixture.src).status, 404);
  }
  const largestDimension = synthetic(png(MAX_EDGE, MAX_EDGE));
  assert.equal(serve(largestDimension.service, largestDimension.src).status, 200);
});

test('same-source aliases share one read and conflicting or invalid duplicate hashes fail closed', () => {
  const bytes = png(), src = 'app://local/emoticons/test.png', good = { src, sha256: hash(bytes) };
  let reads = 0;
  const readFile = () => { reads++; return bytes; };
  const alias = createEmoticonAssets({ root, manifest: { one: good, two: { ...good } }, readFile });
  assert.equal(serve(alias, src).status, 200); assert.equal(serve(alias, src).status, 200); assert.equal(reads, 1);
  for (const entries of [
    { one: good, two: { src, sha256: '0'.repeat(64) } },
    { one: { src, sha256: 'bad' }, two: good },
    { one: good, two: { src }, three: good },
  ]) {
    const service = createEmoticonAssets({ root, manifest: entries, readFile });
    assert.equal(serve(service, src).status, 404);
  }
  assert.equal(reads, 1, 'Conflicting descriptors must not attempt a read');
});

test('manifest unsafe filenames, inherited entries and malformed hashes never become readable routes', () => {
  let reads = 0; const bytes = png(), readFile = () => { reads++; return bytes; };
  for (const src of [
    'app://local/emoticons/../../secret.png', 'app://local/emoticons/%2fsecret.png',
    'app://local/emoticons/x.png?q=1', 'app://local/emoticons/x.webp',
    'file:///C:/secret.png', 'app://local/emoticons/x..png',
    'app://local/emoticons/CON.png', 'app://local/emoticons/NUL.png', 'app://local/emoticons/COM1.png',
  ]) {
    const service = createEmoticonAssets({ root, manifest: { bad: { src, sha256: hash(bytes) } }, readFile });
    assert.equal(serve(service, src).status, 404);
  }
  const inherited = Object.create({ hidden: { src: 'app://local/emoticons/test.png', sha256: hash(bytes) } });
  assert.equal(serve(createEmoticonAssets({ root, manifest: inherited, readFile }), 'app://local/emoticons/test.png').status, 404);
  assert.equal(reads, 0);
  assert.throws(() => createEmoticonAssets({ root: 'relative', manifest }), /表情资源配置无效/);
});

function animatedGif(frames=2){
  const header=Buffer.from('47494638396101000100800000000000ffffff','hex');
  const loop=Buffer.from('21ff0b4e45545343415045322e300301000000','hex');
  const image=Buffer.from('21f904000a0000002c0000000001000100000202440100','hex');
  const parts=[header,loop];
  for(let index=0;index<frames;index++){
    const frame=Buffer.from(image);frame[frame.length-3]=index%2?0x4c:0x44;parts.push(frame);
  }
  parts.push(Buffer.from([0x3b]));return Buffer.concat(parts);
}
test('synthetic two-frame GIF preserves original animated bytes and uses a verified local image/gif route',async()=>{
  const bytes=animatedGif(),src='app://local/emoticons/synthetic-animation.gif';let reads=0;
  const service=createEmoticonAssets({root,manifest:{test:{src,sha256:hash(bytes)}},readFile:()=>{reads++;return bytes;}});
  for(let index=0;index<2;index++){
    const response=serve(service,src);
    assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/gif');
    assert.equal(response.headers.get('x-content-type-options'),'nosniff');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
  }
  assert.equal(reads,1);
});
test('GIF corruption, cross-format bytes, bounds, truncated blocks and excess frame budgets fail closed',()=>{
  const valid=animatedGif(),large=Buffer.from(valid),outside=Buffer.from(valid),badSubblock=Buffer.from(valid);
  large.writeUInt16LE(MAX_EDGE+1,6);
  const imageOffset=valid.indexOf(Buffer.from([0x2c]));
  outside.writeUInt16LE(2,imageOffset+1);
  badSubblock[imageOffset+11]=255;
  const fixtures=[Buffer.from('GIF90a'),valid.subarray(0,12),valid.subarray(0,valid.length-1),
    Buffer.concat([valid,Buffer.from('tail')]),large,outside,badSubblock,animatedGif(0),animatedGif(MAX_GIF_FRAMES+1),png()];
  const src='app://local/emoticons/bad.gif';
  for(const bytes of fixtures){
    const service=createEmoticonAssets({root,manifest:{test:{src,sha256:hash(bytes)}},readFile:()=>bytes});
    assert.equal(serve(service,src).status,404);
  }
  const wrongPng=synthetic(valid);
  assert.equal(serve(wrongPng.service,wrongPng.src).status,404);
});

test('typed-array subviews use their exact underlying range and ignore shadowed size properties', async () => {
  const bytes = png(), backing = Buffer.concat([Buffer.from('prefix'), bytes, Buffer.from('suffix')]);
  const view = new Uint8Array(backing.buffer, backing.byteOffset + 6, bytes.length);
  Object.defineProperties(view, { byteLength: { value: 1 }, byteOffset: { value: 0 }, buffer: { value: new ArrayBuffer(1) } });
  const fixture = synthetic(bytes, () => view);
  assert.deepEqual(Buffer.from(await serve(fixture.service, fixture.src).arrayBuffer()), bytes);
});

test('small-image cache evicts old bytes when its bounded budget is reached', () => {
  const bytes = png(1, 1, MAX_BYTES - 200), entries = {}, reads = [];
  const count = Math.floor(MAX_CACHE_BYTES / bytes.length) + 2;
  for (let index = 0; index < count; index++) entries[index] = {
    src: `app://local/emoticons/fixture-${index}.png`, sha256: hash(bytes),
  };
  const service = createEmoticonAssets({ root, manifest: entries, readFile: filename => { reads.push(filename); return bytes; } });
  for (const entry of Object.values(entries)) assert.equal(serve(service, entry.src).status, 200);
  assert.equal(reads.length, count);
  assert.equal(serve(service, entries[0].src).status, 200);
  assert.equal(reads.length, count + 1);
});
