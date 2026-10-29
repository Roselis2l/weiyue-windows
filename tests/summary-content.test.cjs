'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {prepareSummaryContent, knownPostPermalink} = require('../app/core/summary-content.cjs');
const {normalizeSharedPost, normalizeMessages, WeiboClient} = require('../app/core/weibo.cjs');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const image = n => ({url: `https://wx1.sinaimg.cn/large/${n}.png`});
const message = (id = '10', patch = {}) => ({id, groupId: '21', senderId: '31', senderName: '模拟成员', text: '普通聊天', time: 1000, ...patch});
const prepared = (messages, {start = 0, end = 2000, groupId = '21'} = {}) => ({
  groupId, range: {start, end},
  messages: messages.filter(m => m.groupId === groupId && m.time >= start && m.time < end)
    .map(({id, groupId, senderId, senderName, text, time}) => ({id, groupId, senderId, senderName, text, time})),
});
const resolve = (messages, options = {}) => prepareSummaryContent(prepared(messages), {messages, ...options});
const readyPost = patch => ({state: 'ready', text: '分享微博完整正文', images: [], author: '模拟作者', ...patch});
const loader = async () => ({bytes: PNG, mime: 'image/png'});

test('withdrawn sources use saved text without refreshing posts or images',async()=>{
  const source=message('10',{text:'分享图片',recall:{state:'withdrawn'},images:[image('old')],sharedPost:readyPost({state:'unavailable',text:'此前保存的正文'})});
  const forbidden=()=>{throw new Error('Unexpected network');};
  const result=await resolve([source],{client:{messageDetail:forbidden},loadImage:forbidden});
  assert.equal(result.content[0].images.length,0);assert.match(result.content[0].text,/此前保存的正文/);assert.equal(result.coverage.imageCount,0);assert.equal(result.coverage.omissions.length,1);
});

test('cached post and repost body are additional real text, and images contain actual bytes without AI requests', async () => {
  const sharedPost = normalizeSharedPost({status: {text_raw: '评论正文', retweeted_status: {
    text_raw: '原始微博正文', user: {screen_name: '转发作者'}, pic_urls: [image('repost')],
  }}});
  const source = message('10', {sharedPost, images: [image('chat')]});
  const calls = [];
  const result = await resolve([source], {loadImage: async (url, options) => {
    calls.push({url, options}); return {bytes: Buffer.concat([PNG, Buffer.from(url)]), mime: 'image/png'};
  }});
  assert.match(result.content[0].text, /评论正文\n\n转发 @转发作者：\n原始微博正文/);
  assert.doesNotMatch(result.content[0].text, /普通聊天/);
  assert.equal(result.content[0].images.length, 2);
  assert.deepEqual(Buffer.from(result.content[0].images[0].dataUrl.split(',')[1], 'base64'), Buffer.concat([PNG, Buffer.from(calls[0].url)]));
  assert.equal(result.coverage.postCount, 1);
  assert.equal(result.coverage.imageCount, 2);
  assert.equal(result.coverage.omissions.length, 0);
  assert.equal(calls[0].options.maxBytes, 4 * 1024 * 1024);
});

test('selection isolation honors group and half-open time bounds before any content reads', async () => {
  const messages = [message('10', {time: 0, images: [image('selected')]}),
    message('11', {time: 2000, images: [image('excluded-end')]}),
    message('12', {time: -1, images: [image('excluded-before')]}),
    message('13', {groupId: '99', images: [image('excluded-group')]})];
  const urls = [];
  const result = await resolve(messages, {loadImage: async url => {urls.push(url); return loader();}});
  assert.equal(result.content.length, 1);
  assert.deepEqual(urls, [image('selected').url]);
});

test('changed snapshot, conflicting source IDs and mismatching timing fail before reads', async () => {
  const source = message(), pre = prepared([source]);
  let calls = 0;
  for (const messages of [[{...source, text: 'changed'}], [{...source, time: 1001}], [source, {...source, senderName: 'conflict'}], []]) {
    await assert.rejects(prepareSummaryContent(pre, {messages, loadImage: async () => {calls++; return loader();}}), {code: 'SUMMARY_CONTENT_INVALID'});
  }
  assert.equal(calls, 0);
});

test('missing ordinary share body is enriched only through its exact account-scoped chat message', async () => {
  const source = message('9007199254740993123', {sharedPost: {state: 'unavailable', text: '', images: [], url: 'https://weibo.com/31/Abc'}});
  const calls = [];
  const client = new WeiboClient({maxAttempts: 1, fetch: async (url, init) => {
    calls.push({url: new URL(url), init});
    return new Response(JSON.stringify({message: {id: source.id, gid: source.groupId, from_uid: source.senderId,
      content: source.text, time: 1, url_objects: [{info: {url_long: source.sharedPost.url}, status: {
        text_raw: '接口返回完整正文', user: {screen_name: '原作者'}, pic_urls: [image('detail')],
      }}]}}), {status: 200, headers: {'content-type': 'application/json'}});
  }});
  const result = await resolve([source], {client, loadImage: loader});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.origin, 'https://api.weibo.com');
  assert.equal(calls[0].url.pathname, '/webim/groupchat/query_message.json');
  assert.equal(calls[0].url.searchParams.get('id'), '21');
  assert.equal(calls[0].url.searchParams.get('mid'), source.id);
  assert.equal(calls[0].init.credentials, 'include');
  assert.equal(calls[0].init.redirect, 'error');
  assert.match(result.content[0].text, /接口返回完整正文/);
  assert.equal(result.content[0].images.length, 1);
});

test('complete cached shares do not trigger a network text refresh', async () => {
  const result = await resolve([message('10', {sharedPost: readyPost()})], {client: {messageDetail() {throw new Error('must not run');}}});
  assert.equal(result.coverage.postLookups, 0);
  assert.equal(result.content[0].postCount, 1);
});

test('pure published-post notifications do not infer, fetch or report a missing post', async () => {
  for (const text of ['我发布了新微博，快来围观吧！', '我发布了新微博', '我发布了新微博, 快来围观吧!']) {
    const source = message('10', {text, sharedPost: {state: 'unavailable', text: '', images: [], url: 'https://weibo.com/31/Abc'}});
    const result = await resolve([source], {client: {messageDetail() {throw new Error('must not run');}}});
    assert.equal(result.coverage.postLookups, 0);
    assert.equal(result.coverage.notificationCount, 1);
    assert.equal(result.coverage.omissions.length, 0);
    assert.equal(result.content[0].text, '');
  }
});

test('notifications that actually carry a supplied readable post retain that supplied content without guessing', async () => {
  const source = message('10', {text: '我发布了新微博，快来围观吧！', sharedPost: readyPost()});
  const result = await resolve([source]);
  assert.equal(result.coverage.postCount, 1);
  assert.equal(result.coverage.notificationCount, 0);
});

test('known literal post permalinks can request only their original message detail, never arbitrary external URLs', async () => {
  const source = message('10', {text: '看看这条 https://weibo.com/31/Abc'});
  let calls = 0;
  const result = await resolve([source], {client: {async messageDetail(gid, mid) {
    calls++; assert.equal(gid, source.groupId); assert.equal(mid, source.id);
    return {...source, sharedPost: readyPost({url: 'https://weibo.com/31/Abc'})};
  }}});
  assert.equal(calls, 1); assert.match(result.content[0].text, /完整正文/);
  for (const url of ['https://evil.example/a', 'https://weibo.com/u/31', 'https://weibo.com/settings', 'http://weibo.com/31/Abc', 'https://weibo.com:443/31/Abc', 'https://weibo.com@evil.example/31/Abc']) {
    assert.equal(knownPostPermalink(url), null);
  }
});

test('unavailable import post remains an explicit omission and does not get guessed from its URL', async () => {
  const result = await resolve([message('10', {sharedPost: {state: 'unavailable', text: '', images: [], url: 'https://weibo.com/31/Abc'}})]);
  assert.equal(result.content[0].text, '');
  assert.equal(result.content[0].omissions[0].kind, 'post');
  assert.equal(result.content[0].omissions[0].messageId, '10');
  assert.match(result.content[0].omissions[0].reason, /未把链接当成正文/);
});

test('detail errors and cross-group, wrong-ID, wrong-time or wrong-post results never enter the outgoing content', async () => {
  const source = message('10', {sharedPost: {state: 'unavailable', text: '', images: [], id: '101', url: 'https://weibo.com/31/Abc'}});
  const cases = [
    () => {throw new Error('Cookie=secret private server body');},
    () => ({...source, groupId: '99', sharedPost: readyPost()}),
    () => ({...source, id: '99', sharedPost: readyPost()}),
    () => ({...source, time: 999, sharedPost: readyPost()}),
    () => ({...source, sharedPost: readyPost({id: '102'})}),
  ];
  for (const fn of cases) {
    const result = await resolve([source], {client: {messageDetail: fn}});
    assert.equal(result.content[0].text, '');
    assert.doesNotMatch(JSON.stringify(result), /Cookie|secret|private server/);
    assert.ok(result.content[0].omissions.length);
  }
});

test('truncated long posts and unreadable reposts remain explicitly partial instead of claiming a full body', async () => {
  const post = normalizeSharedPost({status: {text_raw: '短预览', isLongText: true, retweeted_status: {
    deleted: 1, text_raw: '不得包含删除正文', pic_urls: [image('deleted')],
  }}});
  assert.equal(post.truncated, true);
  assert.doesNotMatch(post.text, /不得包含删除正文/);
  assert.equal(post.images.length, 0);
  const source = message('10', {sharedPost: post});
  const result = await resolve([source], {client: {async messageDetail() {return source;}}});
  assert.match(result.content[0].text, /已知内容不完整/);
  assert.match(result.content[0].omissions.at(-1).reason, /仍不完整/);
  const link = normalizeSharedPost({status: {text: '预览<a href=\"https://weibo.com/31/Abc\">全文</a>'}});
  assert.equal(link.truncated, true);
});

test('repost long-text metadata propagates into parent completeness and full supplied long text clears it', () => {
  assert.equal(normalizeSharedPost({status: {text_raw: '转发', retweeted_status: {text_raw: '预览', isLongText: '1'}}}).truncated, true);
  const post = normalizeSharedPost({status: {text_raw: '转发', retweeted_status: {
    text_raw: '短', isLongText: true, longText: {longTextContent: '完整转发长文'},
  }}});
  assert.equal(post.truncated, undefined); assert.match(post.text, /完整转发长文/);
});

test('model without confirmed vision reports each candidate and never downloads image bytes', async () => {
  let calls = 0;
  const result = await resolve([message('10', {images: [image('a'), image('a'), image('b')], sharedPost: readyPost({images: [image('c')]})})],
    {includeImages: false, loadImage: async () => {calls++; return loader();}});
  assert.equal(calls, 0);
  assert.equal(result.content[0].images.length, 0);
  assert.equal(result.content[0].omissions.filter(o => o.kind === 'image').length, 3);
  assert.equal(result.content[0].postCount, 1);
});

test('duplicate URLs are read once and duplicate actual bytes under different URLs share an image label', async () => {
  const urls = [];
  const result = await resolve([message('10', {images: [image('a'), image('a')]}), message('11', {images: [image('a'), image('b')]})],
    {loadImage: async url => {urls.push(url); return loader();}});
  assert.deepEqual(urls, [image('a').url, image('b').url]);
  assert.equal(result.coverage.imageCount, 1);
  assert.equal(result.coverage.imageBytes, PNG.length);
  assert.equal(result.content[0].images[0].label, result.content[1].images[1].label);
});

test('unsafe images, GIF, mismatching bytes, and failed downloads become safe explicit omissions', async () => {
  const source = message('10', {images: [{url: 'https://evil.example/private'}, image('gif'), image('mismatch'), image('fail')]});
  const urls = [];
  const result = await resolve([source], {loadImage: async url => {
    urls.push(url);
    if (url.includes('/gif.')) return {bytes: Buffer.from('GIF89a'), mime: 'image/gif'};
    if (url.includes('/mismatch.')) return {bytes: PNG, mime: 'image/jpeg'};
    throw new Error('token=secret chat private payload');
  }});
  assert.equal(urls.length, 3);
  assert.equal(result.content[0].images.length, 0);
  assert.equal(result.content[0].omissions.length, 4);
  assert.doesNotMatch(JSON.stringify(result), /evil\.example|secret|private payload/);
});

test('per-image, total-byte and image-count budgets omit excess without continuing downloads after budget is reached', async () => {
  const messages = [message('10', {images: [image('a'), image('b'), image('c')]})];
  let calls = 0;
  const distinctLoader = async url => {calls++; return {mime: 'image/png', bytes: Buffer.concat([PNG, Buffer.from(url)])};};
  const countResult = await resolve(messages, {maxImages: 1, loadImage: distinctLoader});
  assert.equal(calls, 1); assert.equal(countResult.coverage.imageCount, 1); assert.equal(countResult.content[0].omissions.length, 2);
  const tooLarge = await resolve([message('10', {images: [image('a')]})], {maxImageBytes: PNG.length - 1, loadImage: loader});
  assert.equal(tooLarge.content[0].images.length, 0); assert.match(tooLarge.content[0].omissions[0].reason, /单张图片/);
  calls = 0;
  const budget = PNG.length + Buffer.byteLength(image('a').url);
  const total = await resolve(messages, {maxTotalImageBytes: budget, loadImage: distinctLoader});
  assert.equal(calls, 1); assert.equal(total.coverage.imageBytes, budget);
});

test('missing image placeholders are safely backfilled by their exact chat message or reported', async () => {
  const source = message('10', {text: '分享图片'});
  const client = {async messageDetail() {return {...source, images: [image('filled')]};}};
  const result = await resolve([source], {client, loadImage: loader});
  assert.equal(result.content[0].images.length, 1);
  const missing = await resolve([source]);
  assert.equal(missing.content[0].omissions[0].kind, 'image');
});

test('missing image placeholder omissions distinguish exhausted lookups, time budget, timeout and safe read failures', async t => {
  const sources = [message('10', {text: '分享图片'}), message('11', {text: '[图片]'})];
  let calls = 0;
  const limited = await resolve(sources, {maxPostLookups: 1, client: {async messageDetail(_group, id) {
    calls++; return sources.find(m => m.id === id);
  }}});
  assert.equal(calls, 1);
  assert.match(limited.content[1].omissions[0].reason, /条数上限/);
  const stalled = await resolve([sources[0]], {operationTimeoutMs: 5,
    client: {messageDetail: () => new Promise(() => {})}});
  assert.match(stalled.content[0].omissions[0].reason, /超时/);
  let clock = 1000;
  const now = t.mock.method(Date, 'now', () => clock);
  const budget = await resolve(sources, {timeoutMs: 5, client: {async messageDetail(_group, id) {
    clock += 10; return sources.find(m => m.id === id);
  }}});
  now.mock.restore();
  assert.match(budget.content[1].omissions[0].reason, /时间预算/);
  const failed = await resolve([sources[0]], {client: {async messageDetail() {
    throw new Error('Cookie=private; sensitive server response');
  }}});
  assert.match(failed.content[0].omissions[0].reason, /无法通过当前登录会话补全/);
  assert.doesNotMatch(JSON.stringify(failed), /private|sensitive|Cookie/);
  const clientTimeout = {async messageDetail() {throw Object.assign(new Error('private'), {code: 'TIMEOUT'});}};
  const clientTimedOut = await resolve([sources[0], message('12', {sharedPost: readyPost({truncated: true})})], {client: clientTimeout});
  assert.match(clientTimedOut.content[0].omissions[0].reason, /超时/);
  assert.match(clientTimedOut.content[1].omissions[0].reason, /超时/);
});

test('lookup count and preparation timeout are bounded with an omission for each unresolved source', async () => {
  const messages = [message('10', {sharedPost: readyPost({truncated: true})}), message('11', {sharedPost: readyPost({truncated: true})})];
  let calls = 0;
  const result = await resolve(messages, {maxPostLookups: 1, client: {async messageDetail(_group, id) {
    calls++; return messages.find(m => m.id === id);
  }}});
  assert.equal(calls, 1);
  assert.match(result.content[1].omissions[0].reason, /条数上限/);
  const timeout = await resolve([messages[0]], {operationTimeoutMs: 5, client: {messageDetail: () => new Promise(() => {})}});
  assert.match(timeout.content[0].omissions[0].reason, /超时/);
});

test('cancellation before or during a stalled content read stops preparation and never returns late private bytes', async () => {
  const source = message('10', {images: [image('a')]});
  const controller = new AbortController();
  let calls = 0, complete;
  const work = resolve([source], {signal: controller.signal, loadImage: (_url, {signal}) => {
    calls++; assert.equal(signal.aborted, false); return new Promise(resolve => {complete = resolve;});
  }});
  await new Promise(setImmediate);
  controller.abort();
  await assert.rejects(work, {code: 'SUMMARY_CONTENT_ABORT'});
  complete({bytes: PNG, mime: 'image/png'});
  await new Promise(setImmediate);
  assert.equal(calls, 1);
  await assert.rejects(resolve([source], {signal: controller.signal, loadImage: () => {calls++;}}), {code: 'SUMMARY_CONTENT_ABORT'});
  assert.equal(calls, 1);
});

test('source snapshots are never mutated or persisted by content preparation', async () => {
  const source = message('10', {sharedPost: readyPost(), images: [image('a')]});
  const before = JSON.stringify(source);
  await resolve([source], {loadImage: loader});
  assert.equal(JSON.stringify(source), before);
});
