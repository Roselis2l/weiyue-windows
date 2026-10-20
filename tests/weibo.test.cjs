'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {WeiboClient, parsePrecisionJson, identifier, previousId, normalizeIdentity, normalizeGroups,
  normalizeMessages, normalizeImages, normalizeSharedPost, postText, retryDelay, PATHS} = require('../app/core/weibo.cjs');

const rawMessage = (id, extras = {}) => ({id, from_uid: '71', from_user: {screen_name: '模拟成员'},
  time: 1700000000, content: '第一段\n\n  第二段', ...extras});
const reply = (body, status = 200, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), {status, headers});
function fixture(responses, options = {}) {
  const calls = [], delays = [];
  const client = new WeiboClient({fetch: async (url, init) => {
    calls.push({url: new URL(url), init});
    const response = responses.shift();
    if (response instanceof Error) throw response;
    if (typeof response === 'function') return response(url, init);
    if (!response) throw new Error('Mock responses exhausted');
    return response;
  }, sleep: async ms => delays.push(ms), ...options});
  return {client, calls, delays};
}

test('JSON scanner protects 64-bit IDs, preserves escaped quoted text and safe counts', () => {
  const parsed = parsePrecisionJson('{"id":9007199254740993123,"n":20,"text":"\\\"id\\\":9007199254740993124","nested":[-9007199254740993123,1.00000000000000001,1e3]}');
  assert.equal(parsed.id, '9007199254740993123');
  assert.equal(parsed.n, 20);
  assert.equal(parsed.text, '"id":9007199254740993124');
  assert.deepEqual(parsed.nested, ['-9007199254740993123', '1.00000000000000001', '1e3']);
});

test('malformed JSON and oversized responses are rejected with sanitized errors', () => {
  for (const input of ['{"id":01}', '{"id":1e}', '{"text":"secret', 'secret_cookie=private', ' '.repeat(8 * 1024 * 1024 + 1)]) {
    assert.throws(() => parsePrecisionJson(input), error => error.code === 'INVALID_RESPONSE' && !error.message.includes('secret'));
  }
});

test('IDs cannot recover unsafe Numbers or normalize fractional/exponential lexical values', () => {
  for (const value of [9007199254740993123, 1.1, '1e3', '1.00000000000000001', '-1', '00', '0', {}, undefined]) assert.throws(() => identifier(value));
  assert.equal(identifier(123), '123');
  assert.equal(identifier('0', true), '0');
  assert.equal(previousId('9007199254740993123'), '9007199254740993122');
  assert.equal(previousId('1'), '0');
});

test('identity and groups use exact official envelope and only explicit group type', () => {
  assert.deepEqual(normalizeIdentity(parsePrecisionJson('{"profile":{"id":9007199254740993123,"screen_name":"模拟账号"}}')), {id: '9007199254740993123', name: '模拟账号'});
  assert.deepEqual(normalizeGroups({contacts: [
    {user: {type: 2, id: '11', name: '同名群'}}, {user: {type: 2, id: '12', name: '同名群'}},
    {user: {type: 2, id: '11', name: '重复'}}, {user: {type: 1, id: '13', name: '私聊'}},
    {user: {type: 2, id: '14', screen_name: '备用名称'}}
  ]}), [{id: '11', name: '同名群', selected: false}, {id: '12', name: '同名群', selected: false}, {id: '14', name: '备用名称', selected: false}]);
  assert.throws(() => normalizeGroups({contacts: [{user: {type: 2, id: '11'}}]}));
  assert.throws(() => normalizeIdentity({}));
});

test('message text remains plain unmodified text and missing senders remain distinct', () => {
  const list = normalizeMessages({messages: [rawMessage('11', {content: '<script>alert(1)</script>\n 原文'}),
    rawMessage('12', {from_uid: 0, from_user: undefined}), rawMessage('13', {from_uid: undefined, from_user: undefined}),
    rawMessage('14', {from_uid: undefined, from_user: {idstr: '72', name: '资料成员'}})]}, '21');
  assert.equal(list[0].text, '<script>alert(1)</script>\n 原文');
  assert.equal(list[0].time, 1700000000000);
  assert.equal(list[1].senderId, 'unknown:12');
  assert.equal(list[2].senderId, 'unknown:13');
  assert.equal(list[3].senderId, '72');
});

test('invalid timestamps, fractional IDs and cross-group records never enter a page', () => {
  for (const extra of [{gid: '99'}, {time: undefined}, {time: -1}, {time: ''}, {time: 999999999999999999999999}, {content: {}}, {id: 9007199254740993123}]) {
    assert.throws(() => normalizeMessages({messages: [rawMessage('11', extra)]}, '21'));
  }
  assert.throws(() => normalizeMessages(parsePrecisionJson('{"messages":[{"id":1.00000000000000001,"time":1700000000}]}'), '21'));
  assert.equal(normalizeMessages({messages: [rawMessage('11', {time: undefined, created_at: '2023-11-14T22:13:20.000Z'})]}, '21')[0].time, 1700000000000);
});

test('image attachments retain real original/thumbnail URLs and metadata without changing message text', () => {
  const message = normalizeMessages({messages: [rawMessage('22', {content: '分享图片', media_type: 1,
    pic_infos: [{original_pic: 'http://wx1.sinaimg.cn/large/a.jpg', thumbnail_pic: 'https://wx1.sinaimg.cn/thumb/a.jpg', width: '1920', height: 1080}],
    pic_urls: ['https://wx1.sinaimg.cn/large/a.jpg'], fids: ['999']})]}, '21')[0];
  assert.equal(message.text, '分享图片');
  assert.equal(message.mediaVersion, 1);
  assert.deepEqual(message.images, [{url: 'https://wx1.sinaimg.cn/large/a.jpg', originalUrl: 'https://wx1.sinaimg.cn/large/a.jpg',
    thumbnailUrl: 'https://wx1.sinaimg.cn/thumb/a.jpg', width: 1920, height: 1080}]);
  assert.equal(normalizeMessages({messages: [rawMessage('23')]}, '21')[0].mediaVersion, 1);
});

test('image FIDs remain exact lexical IDs and use only the fixed official original-image endpoint', () => {
  const raw = parsePrecisionJson('{"media_type":1,"fids":[9007199254740993123,9007199254740993124]}');
  const images = normalizeImages(raw);
  assert.equal(images.length, 2);
  for (let index = 0; index < images.length; index++) {
    const url = new URL(images[index].originalUrl);
    assert.equal(url.origin + url.pathname, 'https://upload.api.weibo.com/2/mss/msget');
    assert.equal(url.searchParams.get('source'), '209678993');
    assert.equal(url.searchParams.get('imageType'), 'origin');
    assert.equal(url.searchParams.get('fid'), ['9007199254740993123', '9007199254740993124'][index]);
  }
  assert.equal(normalizeImages({media_type: '1', att_ids: '11,12,11', fids: ['13']}).length, 2);
  assert.equal(new URL(normalizeImages({media_type: 1, att_ids: ['11'], fids: ['13']})[0].url).searchParams.get('fid'), '11');
  assert.deepEqual(normalizeImages({media_type: 1, fids: [9007199254740993123, '0', '1e3', 'file:///test', {}]}), []);
  assert.deepEqual(normalizeImages({media_type: 10, fids: ['11']}), []);
});

test('image variants are bounded, deduplicated and drop foreign origins without losing safe siblings', () => {
  const images = normalizeImages({pic_infos: {a: {large: {url: 'https://wx2.sinaimg.cn/large/a.png', width: 720, height: 400}},
    b: {url: 'javascript:alert(1)'}, c: {url: 'https://evil.example/image.jpg'}},
    pics: [{original: {url: 'https://wx2.sinaimg.cn/large/b.png'}}], pic_urls: ['file:///a', {url: 'https://wx2.sinaimg.cn/large/a.png'}]});
  assert.equal(images.length, 2);
  assert.equal(images[0].width, 720);
  assert.equal(images[1].originalUrl, 'https://wx2.sinaimg.cn/large/b.png');
  assert.equal(normalizeImages({pic_urls: Array.from({length: 60}, (_, i) => `https://wx1.sinaimg.cn/large/${i}.jpg`)}).length, 50);
});

test('official url_objects status becomes a separate plain-text shared post with its actual author, pictures and link', () => {
  const message = normalizeMessages({messages: [rawMessage('22', {content: '我发布了新微博，快来围观吧！', url_objects: [{
    info: {url_long: 'https://weibo.com/71/Abc123'}, status: {idstr: '9007199254740993123', user: {screen_name: '原帖作者'},
      text: '<p>正文 &amp; 图文<br><img src="x" alt="[笑脸]"></p><script>doNotRun()</script>',
      pic_urls: [{large: {url: 'https://wx1.sinaimg.cn/large/post.jpg'}}]}}]})]}, '21')[0];
  assert.equal(message.text, '我发布了新微博，快来围观吧！');
  assert.deepEqual(message.sharedPost, {id: '9007199254740993123', url: 'https://weibo.com/71/Abc123', author: '原帖作者',
    text: '正文 & 图文\n[笑脸]', state: 'ready', images: [{url: 'https://wx1.sinaimg.cn/large/post.jpg', originalUrl: 'https://wx1.sinaimg.cn/large/post.jpg'}]});
});

test('generic published-post notifications without a target never invent a post from sender or mblogid', () => {
  const notification = rawMessage('22', {content: '我发布了新微博，快来围观吧！', mblogid: 'abcd'});
  assert.equal(normalizeSharedPost(notification), undefined);
  const [normalized] = normalizeMessages({messages: [notification]}, '3');
  assert.equal(normalized.text, notification.content);
  assert.equal(normalized.mediaVersion, 1);
  assert.equal(Object.hasOwn(normalized, 'sharedPost'), false);
  for (const url of ['javascript:alert(1)', 'https://evil.example/post', 'https://t.cn/unknown']) {
    assert.equal(normalizeSharedPost({...notification, url}), undefined);
    assert.equal(normalizeSharedPost({...notification, url_objects: [{info: {url_long: url}}]}), undefined);
  }
  assert.equal(normalizeSharedPost(rawMessage('23', {content: '普通群聊消息'})), undefined);
  assert.equal(normalizeSharedPost(rawMessage('24', {content: '分享图片', media_type: 1})), undefined);
});

test('published-post notifications with a verified post URL retain an unavailable share card', () => {
  const linked = normalizeSharedPost({content: '我发布了新微博，快来围观吧！', url: 'https://weibo.com/71/RealPost'});
  assert.equal(linked.state, 'unavailable');
  assert.equal(linked.url, 'https://weibo.com/71/RealPost');
  assert.equal(linked.text, '');
  assert.equal(linked.reason, '分享通知未附微博正文，请打开原微博查看');
  const nested = normalizeSharedPost({content: '我发布了新微博，快来围观吧！',
    url_objects: [{info: {url_long: 'https://weibo.com/71/RealPost'}}]});
  assert.deepEqual(nested, linked);
});

test('unsafe or shortened share URLs and images are omitted without replacing known post text', () => {
  const shared = normalizeSharedPost({url_objects: [{info: {url_long: 'https://evil.example/', url_short: 'https://t.cn/abc'},
    status: {text_raw: '<literal user text>', url: 'javascript:alert(1)', pic_urls: [{url: 'https://evil.example/x'}]}}]});
  assert.equal(shared.text, '<literal user text>');
  assert.equal(shared.state, 'ready');
  assert.equal(shared.url, undefined);
  assert.deepEqual(shared.images, []);
  assert.equal(postText({text: '&#x1f642; &lt;tag&gt; <style>hidden</style>line<br>two'}), '🙂 <tag> line\ntwo');
});

test('supplied long text and repost body are retained; deleted or absent bodies remain unavailable', () => {
  const full = normalizeSharedPost({status: {text_raw: '短预览', isLongText: true, longText: {longTextContent: '<p>完整长微博正文</p>'},
    retweeted_status: {user: {screen_name: '被转发作者'}, text_raw: '实际转发正文', pic_urls: ['https://wx1.sinaimg.cn/large/repost.jpg']}}});
  assert.equal(full.text, '完整长微博正文\n\n转发 @被转发作者：\n实际转发正文');
  assert.equal(full.truncated, undefined);
  assert.equal(full.images.length, 1);
  assert.equal(normalizeSharedPost({status: {text: '较短正文', isLongText: true}}).truncated, true);
  const deleted = normalizeSharedPost({status: {deleted: 1, text: '不应继续展示', pic_urls: ['https://wx1.sinaimg.cn/a.jpg']}});
  assert.equal(deleted.state, 'unavailable');
  assert.equal(deleted.text, '');
  assert.deepEqual(deleted.images, []);
  assert.equal(normalizeSharedPost({status: {id: '23'}}).state, 'unavailable');
});

test('all GETs are fixed HTTPS endpoints, use account session credentials, and reject redirects', async () => {
  const f = fixture([reply({profile: {id: '61', screen_name: '账号'}}), reply({contacts: []}), reply({messages: []})]);
  await f.client.identity(); await f.client.groups(); await f.client.syncGroup('21');
  assert.deepEqual(f.calls.map(call => call.url.pathname), [PATHS.identity, PATHS.groups, PATHS.messages]);
  for (const call of f.calls) {
    assert.equal(call.url.origin, 'https://api.weibo.com');
    assert.equal(call.url.searchParams.get('source'), '209678993');
    assert.equal(call.init.credentials, 'include');
    assert.equal(call.init.method, 'GET');
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.cache, 'no-store');
    assert.deepEqual(call.init.headers, {Accept: 'application/json', Referer: 'https://api.weibo.com/chat'});
  }
  assert.equal(f.calls[1].url.searchParams.get('special_source'), '3');
  assert.equal(f.calls[2].url.searchParams.get('count'), '20');
  assert.equal(f.calls[2].url.searchParams.get('query_sender'), '1');
  const response = reply({messages: []});
  Object.defineProperty(response, 'url', {value: 'https://evil.example/webim/groupchat/query_messages.json'});
  const other = fixture([response]);
  await assert.rejects(other.client.syncGroup('21'), {code: 'UNSAFE_REDIRECT'});
  assert.equal(other.calls.length, 1);
});

test('max_mid is minimum ID minus one with full precision, not array order, and duplicate IDs collapse', async () => {
  const f = fixture([
    reply('{"messages":[{"id":9007199254740993129,"time":1700000000},{"id":9007199254740993127,"time":1699999998},{"id":9007199254740993128,"time":1699999999},{"id":9007199254740993128,"time":1699999999}]}'),
    reply({messages: [rawMessage('9007199254740993126', {time: 1699999997})]}),
    reply({messages: []})
  ]);
  const batches = [];
  const result = await f.client.syncGroup('21', {onPage: page => batches.push(page)});
  assert.equal(f.calls[0].url.searchParams.has('max_mid'), false);
  assert.equal(f.calls[1].url.searchParams.get('max_mid'), '9007199254740993126');
  assert.equal(f.calls[2].url.searchParams.get('max_mid'), '9007199254740993125');
  assert.equal(result.messages.length, 4);
  assert.deepEqual(result.messages.map(message => message.id), ['9007199254740993126', '9007199254740993127', '9007199254740993128', '9007199254740993129']);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.nextCursor, null);
  assert.equal(result.pages, 3);
  assert.equal(result.coverage.oldest, 1699999997000);
  assert.deepEqual(batches.map(page => page.messages.length), [3, 1, 0]);
  assert.match(result.coverage.note, /无法保证完整/);
});

test('message detail uses the official fixed endpoint and verifies both identifiers before returning media', async () => {
  const f = fixture([reply({message: rawMessage('9007199254740993123', {gid: '21', from_user: undefined,
    content: '分享图片', media_type: 1, fids: ['9007199254740993124']})})]);
  const message = await f.client.messageDetail('21', '9007199254740993123');
  const call = f.calls[0];
  assert.equal(call.url.origin, 'https://api.weibo.com');
  assert.equal(call.url.pathname, '/webim/groupchat/query_message.json');
  assert.equal(call.url.searchParams.get('source'), '209678993');
  assert.equal(call.url.searchParams.get('id'), '21');
  assert.equal(call.url.searchParams.get('mid'), '9007199254740993123');
  assert.equal(call.init.headers.Referer, 'https://api.weibo.com/chat');
  assert.equal(call.init.credentials, 'include');
  assert.equal(message.id, '9007199254740993123');
  assert.equal(message.groupId, '21');
  assert.equal(message.senderId, '71');
  assert.equal(message.senderName, '发送者待确认');
  assert.equal(message.images.length, 1);
  assert.equal(message.mediaVersion, 1);
});

test('message detail rejects absent, cross-group or mismatching records without silently substituting a message', async () => {
  for (const message of [null, rawMessage('22'), rawMessage('22', {gid: '99'}), rawMessage('23', {gid: '21'})]) {
    const f = fixture([reply({message})]);
    await assert.rejects(f.client.messageDetail('21', '22'), {code: 'INVALID_RESPONSE'});
    assert.equal(f.calls.length, 1);
  }
});

test('message detail shares bounded errors and cancellation with other official reads', async () => {
  const unauthorized = fixture([reply('', 403)]);
  await assert.rejects(unauthorized.client.messageDetail('21', '22'), {code: 'ACCESS_DENIED'});
  assert.equal(unauthorized.calls.length, 1);
  const controller = new AbortController(), f = fixture([() => new Promise(() => {})]);
  const work = f.client.messageDetail('21', '22', {signal: controller.signal});
  controller.abort();
  await assert.rejects(work, {code: 'ABORTED'});
  assert.equal(f.calls[0].init.signal.aborted, true);
  const notCalled = fixture([]);
  await assert.rejects(notCalled.client.messageDetail('21', '22', {signal: controller.signal}), {code: 'ABORTED'});
  await assert.rejects(notCalled.client.messageDetail('21', 9007199254740993123), {code: 'INVALID_RESPONSE'});
  assert.equal(notCalled.calls.length, 0);
});

test('incremental sync stops on the minimum lexical ID while retaining overlap and a historical cursor', async () => {
  const f = fixture([reply({messages: [rawMessage('9007199254740993129'), rawMessage('9007199254740993127'), rawMessage('9007199254740993128')]})]);
  const pages = [];
  const result = await f.client.syncGroup('21', {stopAtId: '9007199254740993128', onPage: page => pages.push(page)});
  assert.equal(result.reachedStop, true);
  assert.equal(result.nextCursor, '9007199254740993126');
  assert.equal(result.coverage.complete, false);
  assert.equal(result.messages.length, 3);
  assert.equal(result.pages, 1);
  assert.equal(pages[0].reachedStop, true);
  assert.equal(pages[0].nextCursor, '9007199254740993126');
  assert.match(result.coverage.note, /增量区间已衔接/);
  assert.equal(f.calls.length, 1);
});

test('incremental sync pages until known overlap and does not confuse overlap with history exhaustion', async () => {
  const f = fixture([reply({messages: [rawMessage('30'), rawMessage('29')]}), reply({messages: [rawMessage('28'), rawMessage('27')]})]);
  const reached = [];
  const result = await f.client.syncGroup('21', {stopAtId: '28', onPage: page => reached.push(page.reachedStop)});
  assert.deepEqual(reached, [false, true]);
  assert.equal(f.calls[1].url.searchParams.get('max_mid'), '28');
  assert.equal(result.nextCursor, '26');
  assert.equal(result.reachedStop, true);
  assert.equal(result.coverage.complete, false);
  assert.deepEqual(f.delays, [300]);
});

test('incremental budget exhaustion stays resumable, and continuation retains its original overlap boundary', async () => {
  const f = fixture([reply({messages: [rawMessage('30')]})]);
  const result = await f.client.syncGroup('21', {maxPages: 1, stopAtId: '20'});
  assert.equal(result.reachedStop, false);
  assert.equal(result.nextCursor, '29');
  assert.equal(result.coverage.complete, false);
  const next = fixture([reply({messages: [rawMessage('29'), rawMessage('20')]})]);
  const continuation = await next.client.syncGroup('21', {before: result.nextCursor, stopAtId: '20'});
  assert.equal(next.calls[0].url.searchParams.get('max_mid'), '29');
  assert.equal(continuation.reachedStop, true);
  assert.equal(continuation.nextCursor, '19');
  assert.equal(continuation.coverage.complete, false);
});

test('actual historical end remains distinct from overlap, and unsafe stop IDs fail before network access', async () => {
  const end = fixture([reply({messages: [], has_more: false})]);
  const result = await end.client.syncGroup('21', {stopAtId: '20'});
  assert.equal(result.reachedStop, false);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.nextCursor, null);
  const none = fixture([]);
  for (const stopAtId of [9007199254740993123, '0', '1e3', '-1', {}]) await assert.rejects(none.client.syncGroup('21', {stopAtId}), {code: 'INVALID_RESPONSE'});
  assert.equal(none.calls.length, 0);
});

test('short pages do not imply completion; a page limit exposes a resumable cursor and gap note', async () => {
  const f = fixture([reply({messages: [rawMessage('23')]}), reply({messages: [rawMessage('22')]})]);
  const result = await f.client.syncGroup('21', {maxPages: 2});
  assert.equal(result.pages, 2);
  assert.equal(result.nextCursor, '21');
  assert.equal(result.coverage.complete, false);
  assert.match(result.coverage.note, /上限/);
});

test('explicit end and decimal ID one terminate without an unnecessary extra request', async () => {
  for (const body of [{messages: [rawMessage('1')]}, {messages: [rawMessage('20')], has_more: 0}, {messages: [], hasMore: false}]) {
    const f = fixture([reply(body)]);
    const result = await f.client.syncGroup('21');
    assert.equal(result.pages, 1);
    assert.equal(result.nextCursor, null);
    assert.equal(result.coverage.complete, true);
  }
});

test('an empty page that claims more data is a gap, never a successful complete history', async () => {
  const f = fixture([reply({messages: [], has_more: true})]);
  let saved = false;
  await assert.rejects(f.client.syncGroup('21', {onPage: () => {saved = true;}}), {code: 'INVALID_RESPONSE'});
  assert.equal(saved, false);
});

test('historical continuation never claims it proves latest-message coverage', async () => {
  const f = fixture([reply({messages: [rawMessage('1')], has_more: false})]);
  const result = await f.client.syncGroup('21', {before: '10'});
  assert.equal(f.calls[0].url.searchParams.get('max_mid'), '10');
  assert.equal(result.coverage.complete, false);
  assert.match(result.coverage.note, /最新消息覆盖/);
});

test('ignored cursor stops before archiving repeated or newer page; previous pages survive via callback', async () => {
  const f = fixture([reply({messages: [rawMessage('30')]}), reply({messages: [rawMessage('30')]})]);
  const saved = [];
  await assert.rejects(f.client.syncGroup('21', {onPage: page => saved.push(...page.messages)}), {code: 'CURSOR_IGNORED'});
  assert.equal(saved.length, 1);
  assert.equal(f.calls.length, 2);
});

test('transient network and 5xx failures are bounded and sanitize server/network text', async () => {
  const f = fixture([new Error('secret Cookie=abc'), reply('private account error', 503), reply({messages: []})]);
  assert.equal((await f.client.syncGroup('21')).pages, 1);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.delays, [750, 1500]);
  const failure = fixture([new Error('secret'), new Error('secret'), new Error('secret')]);
  await assert.rejects(failure.client.identity(), error => error.code === 'NETWORK' && !error.message.includes('secret'));
  assert.equal(failure.calls.length, 3);
});

test('login can use two total attempts and a 12-second per-attempt deadline', async () => {
  const f = fixture([new Error('simulated offline'), reply('', 503), reply({profile: {id: '61'}})], {maxAttempts: 2, timeoutMs: 12000});
  assert.equal(f.client.timeoutMs, 12000);
  await assert.rejects(f.client.identity(), {code: 'SERVER_ERROR'});
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.delays, [750]);
  const single = fixture([reply('', 503), reply({contacts: []})], {maxAttempts: 1});
  await assert.rejects(single.client.groups(), {code: 'SERVER_ERROR'});
  assert.equal(single.calls.length, 1);
  assert.deepEqual(single.delays, []);
});

test('invalid attempt/deadline options fail before any network request', () => {
  for (const maxAttempts of [0, -1, 4, 1.5, '2', NaN, Infinity]) {
    assert.throws(() => new WeiboClient({fetch() {}, maxAttempts}), /retry attempt/);
  }
  for (const timeoutMs of [0, -1, 60001, 1.5, '12000', NaN, Infinity]) {
    assert.throws(() => new WeiboClient({fetch() {}, timeoutMs}), /timeout/);
  }
});

test('429 honors Retry-After and long cooldown stops rather than shortening it', async () => {
  const f = fixture([reply('', 429, {'retry-after': '2'}), reply({messages: []})]);
  await f.client.syncGroup('21');
  assert.deepEqual(f.delays, [2000]);
  const long = fixture([reply('', 429, {'retry-after': '3600'})]);
  await assert.rejects(long.client.syncGroup('21'), error => error.code === 'RATE_LIMIT' && error.retryAfter === '3600');
  assert.equal(long.calls.length, 1);
  assert.equal(long.delays.length, 0);
  assert.equal(retryDelay('Thu, 01 Jan 1970 00:00:10 GMT', 0, 0), 10000);
});

test('401, 403, authentication, risk and unknown business errors never retry', async () => {
  const cases = [[reply('', 401), 'AUTH_REQUIRED'], [reply('', 403), 'ACCESS_DENIED'],
    [reply({error_code: 21301, error: 'secret auth message'}), 'AUTH_REQUIRED'],
    [reply({error_code: 100001, error: 'secret captcha'}), 'API_REJECTED'],
    [reply({result: false}), 'API_REJECTED']];
  for (const [response, code] of cases) {
    const f = fixture([response]);
    await assert.rejects(f.client.syncGroup('21'), error => error.code === code && !error.message.includes('secret'));
    assert.equal(f.calls.length, 1);
    assert.equal(f.delays.length, 0);
  }
});

test('10012 is a page-source error with an actionable message and never retries as a network or risk error', async () => {
  for (const method of ['identity', 'groups']) {
    const f = fixture([reply({error_code: 10012, error: 'private server detail'})]);
    await assert.rejects(f.client[method](), error => {
      assert.equal(error.code, 'PAGE_SOURCE_REJECTED');
      assert.equal(error.message, '微博未接受页面来源，请更新应用或重新打开官方登录页后重试。');
      assert.doesNotMatch(error.message, /private|风控/);
      return true;
    });
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.delays, []);
  }
  const f = fixture([reply({error_code: '10012'})]);
  await assert.rejects(f.client.syncGroup('21'), {code: 'PAGE_SOURCE_REJECTED'});
  assert.equal(f.calls.length, 1);
});

test('invalid envelope or mismatching group fails whole page and does not call persistence', async () => {
  for (const body of [{wrong: []}, {messages: [rawMessage('2', {gid: '99'})]}, '<html>private login screen</html>', []]) {
    const f = fixture([reply(body)]);
    let saved = false;
    await assert.rejects(f.client.syncGroup('21', {onPage: () => {saved = true;}}), {code: 'INVALID_RESPONSE'});
    assert.equal(saved, false);
    assert.equal(f.calls.length, 1);
  }
});

test('aborted or late responses never reach persistence even if fetch ignores AbortSignal', async () => {
  const controller = new AbortController();
  let finish;
  const f = fixture([() => new Promise(resolve => {finish = resolve;})]);
  let saved = false;
  const work = f.client.syncGroup('21', {signal: controller.signal, onPage: () => {saved = true;}});
  controller.abort();
  await assert.rejects(work, {code: 'ABORTED'});
  assert.equal(f.calls[0].init.signal.aborted, true);
  finish(reply({messages: [rawMessage('2')]}));
  await new Promise(setImmediate);
  assert.equal(saved, false);
});

test('identity and groups accept a shared login AbortSignal and stop before request when cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  const f = fixture([]);
  await assert.rejects(f.client.identity({signal: controller.signal}), {code: 'ABORTED'});
  await assert.rejects(f.client.groups({signal: controller.signal}), {code: 'ABORTED'});
  assert.equal(f.calls.length, 0);
});

test('identity and groups cancellation aborts an in-flight request even when transport never settles', async () => {
  for (const method of ['identity', 'groups']) {
    const controller = new AbortController();
    const f = fixture([() => new Promise(() => {})]);
    const work = f.client[method]({signal: controller.signal});
    controller.abort();
    await assert.rejects(work, {code: 'ABORTED'});
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].init.signal.aborted, true);
    assert.equal(f.delays.length, 0);
  }
});

test('login cancellation interrupts the actual retry delay and prevents subsequent attempts', async () => {
  const controller = new AbortController();
  let calls = 0;
  const client = new WeiboClient({fetch: async () => {calls++; throw new Error('simulated offline');}});
  const work = client.identity({signal: controller.signal});
  await new Promise(setImmediate);
  controller.abort();
  await assert.rejects(work, {code: 'ABORTED'});
  assert.equal(calls, 1);
});

test('login cancellation also bounds a response body that never completes', async () => {
  const controller = new AbortController();
  let bodyRead = false;
  const f = fixture([{status: 200, url: '', headers: new Headers(), text: () => {
    bodyRead = true; return new Promise(() => {});
  }}]);
  const work = f.client.groups({signal: controller.signal});
  await new Promise(setImmediate);
  assert.equal(bodyRead, true);
  controller.abort();
  await assert.rejects(work, {code: 'ABORTED'});
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].init.signal.aborted, true);
});

test('response body timeout is bounded for identity and groups, independently of headers arrival', async () => {
  for (const method of ['identity', 'groups']) {
    const signals = [];
    const f = fixture([], {timeoutMs: 5, fetch: async (_url, init) => {
      signals.push(init.signal);
      return {status: 200, url: '', headers: new Headers(), text: () => new Promise(() => {})};
    }});
    await assert.rejects(f.client[method](), {code: 'TIMEOUT'});
    assert.equal(signals.length, 3);
    assert.equal(signals.every(signal => signal.aborted), true);
  }
});

test('Electron-style empty Response.url is accepted for both login endpoints', async () => {
  const profile = reply({profile: {id: '61', screen_name: '模拟账号'}});
  const groups = reply({contacts: [{user: {type: 2, id: '21', name: '模拟群'}}]});
  assert.equal(profile.url, '');
  assert.equal(groups.url, '');
  const f = fixture([profile, groups]);
  assert.deepEqual(await f.client.identity(), {id: '61', name: '模拟账号'});
  assert.deepEqual(await f.client.groups(), [{id: '21', name: '模拟群', selected: false}]);
});

test('a stalled fetch has a bounded timeout and aborts all three attempts', async () => {
  const signals = [];
  const f = fixture([], {timeoutMs: 5, fetch: async (_url, init) => {
    signals.push(init.signal);
    return new Promise(() => {});
  }});
  await assert.rejects(f.client.syncGroup('21'), {code: 'TIMEOUT'});
  assert.equal(signals.length, 3);
  assert.equal(signals.every(signal => signal.aborted), true);
});

test('onPage storage failures stop new network reads', async () => {
  const f = fixture([reply({messages: [rawMessage('22')]}), reply({messages: []})]);
  await assert.rejects(f.client.syncGroup('21', {onPage: async () => {throw new Error('disk full');}}), /disk full/);
  assert.equal(f.calls.length, 1);
});

test('invalid arguments and pre-aborted sync do not touch the network', async () => {
  const f = fixture([]);
  for (const maxPages of [0, -1, 101, 1.5]) await assert.rejects(f.client.syncGroup('21', {maxPages}), {code: 'INVALID_ARGUMENT'});
  await assert.rejects(f.client.syncGroup('https://evil.example'));
  await assert.rejects(f.client.syncGroup('21', {before: 9007199254740993123}));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.client.syncGroup('21', {signal: controller.signal}), {code: 'ABORTED'});
  assert.equal(f.calls.length, 0);
});

test('page callback integrates with account store and repeated sync deduplicates without losing strings', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const {Store} = require('../app/core/store.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weiyue-weibo-test-'));
  try {
    const store = new Store(root);
    store.ensureAccount({id: 'weibo-61', name: '模拟账号', kind: 'weibo'});
    store.mergeMessages('weibo-61', [{id: '21', name: '模拟群', selected: true}], []);
    const body = {messages: [rawMessage('9007199254740993123', {from_uid: 0, from_user: undefined})], has_more: false};
    let inserted = 0;
    for (let i = 0; i < 2; i++) {
      const f = fixture([reply(body)]);
      await f.client.syncGroup('21', {onPage: page => {inserted += store.mergeMessages('weibo-61', [], page.messages);}});
    }
    assert.equal(inserted, 1);
    const saved = store.queryMessages('weibo-61', {groupId: '21'});
    assert.equal(saved.total, 1);
    assert.equal(saved.messages[0].id, '9007199254740993123');
    assert.equal(saved.messages[0].senderId, 'unknown:9007199254740993123');
    assert.equal(saved.messages[0].text, '第一段\n\n  第二段');
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^weiyue-weibo-test-/);
    fs.rmSync(root, {recursive: true, force: true});
  }
});
