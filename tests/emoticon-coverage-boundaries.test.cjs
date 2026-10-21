'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const manifest = require('../app/renderer/emoticon-manifest.js');
const { create } = require('../app/renderer/emoticons.js');
const links = require('../app/renderer/linkify.js');
const display = create({ manifest, links });

test('legacy image filenames keep their official image identity instead of a similarly named modern emoji', () => {
  const names = ['/ee8192.png', '/ee8cb0.png', '/ee9092.png', '/ee808e.png', '/ee819a.png', '/ee858c.png', '/ee88a6.png', '/ee84a5.png', '/ee88ab.png'];
  const text = names.map(name => `[${name}]【${name}】`).join('，') + ' [doge][笑cry][赞][便便]';
  const parts = display.tokenize(text), images = parts.filter(part => part.type === 'emoticon');
  assert.equal(images.length, 22);
  assert.equal(parts.map(part => part.text).join(''), text);
  for (const name of names) {
    const filename = name.slice(1);
    assert.equal(manifest[name].sourceUrl, 'https://img.t.sinajs.cn/t4/appstyle/expression/emimage/' + filename);
    assert.equal(manifest[name].src, 'app://local/emoticons/' + filename);
    assert.equal(manifest[name].width, 20);
    assert.equal(manifest[name].height, 20);
    for (const image of images.filter(part => part.name === name)) assert.equal(image.src, manifest[name].src);
  }
  for (const [legacy, named] of [['/ee8192.png', 'doge'], ['/ee9092.png', '笑cry'], ['/ee808e.png', '赞'], ['/ee819a.png', '便便']]) {
    assert.notEqual(manifest[legacy].src, manifest[named].src);
    assert.notEqual(manifest[legacy].sha256, manifest[named].sha256);
  }
});

test('third-party-only names stay literal beside confirmed names, links and punctuation', () => {
  const unverified = ['点亮橙色', '看涨', '看跌', '带着微博去旅行', '最右', '花心', '喵', '神兽', '睡觉', '舔', '捂', '笑哭'];
  const verified = ['喵喵', '睡', '舔屏', '笑cry'];
  const text = unverified.flatMap(name => [`[${name}]`, `【${name}】`]).join('，') + '。\n'
    + verified.map(name => `[${name}]`).join('') + ' https://example.com/[喵喵]?q=【睡觉】';
  const parts = display.tokenize(text);
  assert.equal(parts.map(part => part.text).join(''), text);
  assert.deepEqual(parts.filter(part => part.type === 'emoticon').map(part => part.name), verified);
  assert.equal(parts.filter(part => part.type === 'link').length, 1);
  for (const name of unverified) {
    assert.equal(Object.hasOwn(manifest, name), false, 'Require official evidence before adding ' + name);
    assert.deepEqual(display.tokenize(`[${name}]【${name}】`), [{ type: 'text', text: `[${name}]【${name}】` }]);
  }
});

test('already covered historical candidates retain original official images in both bracket forms', () => {
  const names = ['浪', '肥皂', '牛年大吉', '牛大发', '牛哞哞', '武汉加油'];
  const text = names.flatMap(name => [`[${name}]`, `【${name}】`]).join('');
  const parts = display.tokenize(text);
  assert.equal(parts.map(part => part.text).join(''), text);
  assert.equal(parts.length, names.length * 2);
  for (const part of parts) {
    assert.equal(part.type, 'emoticon');
    assert.equal(new URL(manifest[part.name].sourceUrl).hostname, 'h5.sinaimg.cn');
    assert.equal(part.src, manifest[part.name].src);
  }
});
