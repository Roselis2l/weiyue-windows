'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {resolveStandaloneEmoticonUrl, standaloneEmoticonsForMessage} = require('../app/core/standalone-emoticons.cjs');
const {publicMessage} = require('../app/core/message-recalls.cjs');
const {tokenize} = require('../app/renderer/linkify.js');

const SHORT = 'https://t.cn/RgFE2Px';
const PAGE = 'https://photo.weibo.com/h5/comment/compic_id/1022:2305976005EGbicly1ftcu7q36u3g30740740u4?emoticon=1';
const GIF = 'https://wx2.sinaimg.cn/bmiddle/005EGbicly1ftcu7q36u3g30740740u4.gif';
const message = text => ({id:'90071992547409931',groupId:'synthetic-group',senderId:'synthetic-sender',senderName:'示例成员',time:1795449558000,text});

test('confirmed standalone short link and official page resolve to the observed GIF', () => {
  for (const sourceUrl of [SHORT, SHORT.replace('https:','http:'), PAGE]) {
    assert.deepEqual(resolveStandaloneEmoticonUrl(sourceUrl), {
      sourceUrl, pageUrl:PAGE, url:GIF, originalUrl:GIF, label:'动态表情', width:256, height:256,
    });
  }
});

test('ordinary pages, Weibo posts, video pages and arbitrary image links remain links', () => {
  for (const sourceUrl of [
    'https://example.com/article-with-images',
    'https://weibo.com/1234567890/AbCdEfGh',
    'https://weibo.com/tv/show/1034:1234567890123456',
    'https://video.weibo.com/show?fid=1034:1234567890123456',
    'https://t.cn/AnotherLink',
    'https://photo.weibo.com/h5/comment/compic_id/1022:230597another?emoticon=1',
    PAGE.replace('?emoticon=1', ''),
    PAGE.replace('?emoticon=1', '?emoticon=0'),
    'https://wx2.sinaimg.cn/bmiddle/another.gif', GIF,
  ]) {
    assert.equal(resolveStandaloneEmoticonUrl(sourceUrl), null, sourceUrl);
    assert.deepEqual(standaloneEmoticonsForMessage(message(sourceUrl)), [], sourceUrl);
    assert.deepEqual(tokenize(sourceUrl).map(part=>part.text).join(''), sourceUrl);
  }
});

test('unconfirmed URL variants, query parameters and authority tricks are rejected', () => {
  for (const sourceUrl of [
    SHORT+'?x=1', SHORT+'#', SHORT+'#image', SHORT+'/',
    SHORT.replace('RgFE2Px', 'rgfe2px'), SHORT.replace('t.cn', 'T.CN'), SHORT.replace('https:', 'HTTPS:'),
    SHORT.replace('t.cn', 't.cn:443'), SHORT.replace('t.cn', 't.cn.evil.example'),
    SHORT.replace('t.cn', 'user:password@t.cn'), SHORT.replace('t.cn', 'evil.example@t.cn'),
    SHORT.replace('t.cn', 't.cn@evil.example'), SHORT.replace('t.cn/', 't.cn/other/../'),
    SHORT.replace('RgFE2Px', 'RgFE2P%78'),
    PAGE+'&extra=1', PAGE+'&emoticon=1', PAGE.replace('emoticon=1', 'emoticon=true'),
    PAGE.replace('emoticon=1', 'emoticon=%31'), PAGE.replace('emoticon=1', 'Emoticon=1'),
    PAGE+'#view', PAGE.replace('photo.weibo.com', 'photo.weibo.com:443'),
    PAGE.replace('photo.weibo.com', 'photo.weibo.com.evil.example'),
    PAGE.replace('photo.weibo.com', 'user@photo.weibo.com'),
    PAGE.replace('1022:', '1022%3A'), PAGE.replace('/h5/', '/other/../h5/'),
    ' '+SHORT, SHORT+'\n', SHORT+'\u0000', 'data:text/html,'+SHORT, 'javascript:'+SHORT,
    '//t.cn/RgFE2Px', null, undefined, {}, ['https://t.cn/RgFE2Px'],
  ]) assert.equal(resolveStandaloneEmoticonUrl(sourceUrl), null, String(sourceUrl));
});

test('original link tokens prevent URL normalization from upgrading an unconfirmed spelling', () => {
  const value = SHORT.replace('t.cn', 't.cn:443');
  assert.equal(tokenize(value)[0].url, SHORT);
  assert.deepEqual(standaloneEmoticonsForMessage(message(value)), []);
  for (const prefix of ['javascript:', 'file:', 'identifier', 'person@'])
    assert.deepEqual(standaloneEmoticonsForMessage(message(prefix+SHORT)), [], prefix);
});

test('mixed Chinese text, punctuation and repeated links retain source order without duplicates', () => {
  const text = `前文（${SHORT}），普通 https://example.com/news。\n${PAGE}；${SHORT}，尾声[哈哈]`;
  const value = message(text), before = JSON.stringify(value);
  assert.deepEqual(standaloneEmoticonsForMessage(value).map(item=>item.sourceUrl), [SHORT, PAGE]);
  assert.equal(JSON.stringify(value), before);
  assert.equal(value.text, text);
  assert.equal(Object.hasOwn(value,'images'), false);
  assert.equal(tokenize(text).map(part=>part.text).join(''), text);
});

test('existing image lists and private metadata are not changed or traversed', () => {
  const value = message('ordinary text');
  value.images = [{url:GIF}];
  value.sharedPost = {text:SHORT,images:[{url:GIF}]};
  value.editionData = {version:1,received:message(SHORT)};
  const before = JSON.stringify(value);
  assert.deepEqual(standaloneEmoticonsForMessage(value), []);
  assert.equal(JSON.stringify(value), before);
});

test('public withdrawal projection never revives an archived emoticon URL', () => {
  const original = message(SHORT), notice = {...original,
    recall:{state:'withdrawn',protocol:'weibo-group-344',observedAt:original.time+1000},
    editionData:{version:1,received:original},
  };
  assert.deepEqual(standaloneEmoticonsForMessage(publicMessage(notice)), []);
  assert.deepEqual(standaloneEmoticonsForMessage(notice), []);
  assert.deepEqual(standaloneEmoticonsForMessage({...original,recall:{...notice.recall,originalAvailable:false}}), []);
});

test('retained visible original can display but does not acquire a network permission or restore deleted content', () => {
  const visible = {...message(SHORT),recall:{state:'withdrawn',protocol:'weibo-group-344',observedAt:1795449559000,originalAvailable:true},recalledMediaLocalOnly:true};
  const before = JSON.stringify(visible);
  const resolved = standaloneEmoticonsForMessage(visible);
  assert.equal(resolved.length,1);
  assert.equal(resolved[0].sourceUrl, SHORT);
  assert.equal(JSON.stringify(visible), before);
  assert.deepEqual(standaloneEmoticonsForMessage({...visible,localDeletion:{batchId:'synthetic'}}), []);
  assert.deepEqual(standaloneEmoticonsForMessage({...visible,contentUnavailable:true}), []);
});

test('repeated source links do not grow the descriptor list and unknown values have no effect', () => {
  const text = Array.from({length:1000},(_,i)=>i%2?SHORT:PAGE).join('\n');
  assert.deepEqual(standaloneEmoticonsForMessage(message(text)).map(item=>item.sourceUrl), [PAGE, SHORT]);
  for (const value of [null,undefined,[],{}, {text:17},{text:{toString:()=>SHORT}}])
    assert.deepEqual(standaloneEmoticonsForMessage(value), []);
});

test('callers receive independent descriptors and cannot poison the confirmation directory', () => {
  const first = resolveStandaloneEmoticonUrl(SHORT);
  first.url='https://evil.example/changed.gif';first.pageUrl='https://evil.example';
  assert.equal(resolveStandaloneEmoticonUrl(SHORT).url,GIF);
  const value=message(SHORT), one=standaloneEmoticonsForMessage(value), two=standaloneEmoticonsForMessage(value);
  assert.notEqual(one[0],two[0]);assert.deepEqual(one,two);
});
