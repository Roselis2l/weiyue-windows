'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const links = require('../app/renderer/linkify.js');
const { normalizeHttpUrl, tokenize, createLink, appendTextLinks } = links;
const linked = text => tokenize(text).filter(part => part.type === 'link');
const rebuild = text => tokenize(text).map(part => part.text).join('');

test('HTTP and HTTPS links preserve URL parameters and normalize only the address', () => {
  const text = '请看https://weibo.com/123/AbCd?x=1&ref=a%2Fb#讨论\n再看 HTTP://example.com/a?q=中文';
  const result = linked(text);
  assert.equal(result.length, 2);
  assert.equal(result[0].text, 'https://weibo.com/123/AbCd?x=1&ref=a%2Fb#讨论');
  assert.equal(result[0].url, 'https://weibo.com/123/AbCd?x=1&ref=a%2Fb#%E8%AE%A8%E8%AE%BA');
  assert.equal(result[1].url, 'http://example.com/a?q=%E4%B8%AD%E6%96%87');
  assert.equal(rebuild(text), text);
});

test('Chinese punctuation, newline and quoted URLs remain visible outside anchors', () => {
  for (const punctuation of ['，', '。', '！', '？', '；', '：', '、', '…', '.', ',', '!', '?', ';', ':']) {
    const text = `请看 https://example.com/a${punctuation}\n下一行`;
    assert.deepEqual(linked(text).map(p => p.text), ['https://example.com/a'], punctuation);
    assert.equal(rebuild(text), text);
  }
  const quoted = '“https://example.com/一”与 <https://example.com/二>、"http://example.com/三"';
  assert.equal(linked(quoted).length, 3);
  assert.equal(rebuild(quoted), quoted);
});

test('balanced URL brackets stay intact while sentence brackets stay outside', () => {
  const cases = [
    ['(https://example.com/a)', 'https://example.com/a'],
    ['(https://example.com/a(b)).', 'https://example.com/a(b)'],
    ['https://example.com/a(b(c))', 'https://example.com/a(b(c))'],
    ['https://example.com/?q=[a]', 'https://example.com/?q=[a]'],
    ['【https://example.com/a】', 'https://example.com/a'],
    ['（https://example.com/a（甲））', 'https://example.com/a（甲）'],
    ['https://[::1]/a', 'https://[::1]/a'],
    ['https://example.com/?v=1,2&x=(a)', 'https://example.com/?v=1,2&x=(a)'],
  ];
  for (const [text, expected] of cases) {
    assert.deepEqual(linked(text).map(p => p.text), [expected]);
    assert.equal(rebuild(text), text);
  }
});

test('dangerous or malformed schemes and authority tricks are never accepted', () => {
  for (const value of [
    'javascript:alert(1)', 'file:///C:/secret.txt', 'data:text/html,<img src=x>',
    'mailto:test@example.com', 'https:example.com', '//example.com',
    ' https://example.com', 'https://example.com\n', 'https://user:pass@example.com/a',
    'https://trusted.com@evil.example', 'https://example.com\\@evil.example',
    'http://', 'https://exa mple.com', 'https://example.com/\u0000', 'https://example.com/\u0085',
    'https://example.com/' + 'a'.repeat(4096),
  ]) assert.equal(normalizeHttpUrl(value), null, value);
  for (const text of ['javascript:https://example.com', 'file:https://example.com', 'xhttps://example.com', 'name@https://example.com']) {
    assert.deepEqual(linked(text), []);
    assert.equal(rebuild(text), text);
  }
});

test('untrusted HTML is never interpreted while genuine URLs can be linked as text', () => {
  const text = '<img src=x onerror="alert(1)"> https://example.com/?q=%3Cscript%3E&x=1';
  const parts = tokenize(text);
  assert.equal(parts[0].type, 'text');
  assert.equal(parts[0].text, '<img src=x onerror="alert(1)"> ');
  assert.equal(parts[1].type, 'link');
  assert.equal(rebuild(text), text);
});

test('oversized URL candidates stay plain text without quadratic bracket trimming', () => {
  const text = 'https://example.com/' + ')'.repeat(100000);
  assert.deepEqual(linked(text), []);
  assert.equal(rebuild(text), text);
});

function fakeDocument() {
  const document = {
    createTextNode(text) { return { nodeType: 3, textContent: text, ownerDocument: document }; },
    createElement(tag) {
      return {
        nodeType: 1, tagName: tag, ownerDocument: document, children: [], attributes: {}, listeners: {},
        append(...children) { this.children.push(...children); },
        setAttribute(name, value) { this.attributes[name] = value; },
        addEventListener(name, handler) { this.listeners[name] = handler; },
        classList: { add() {} },
      };
    },
  };
  return document;
}
function event(button = 0) {
  return { button, prevented: false, stopped: false,
    preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
}

test('safe DOM uses text nodes and exact href; no innerHTML or inline handlers', () => {
  const document = fakeDocument(), parent = document.createElement('div');
  appendTextLinks(parent, '<img onerror=evil> https://example.com/?a=1&b=2', () => {});
  assert.equal(parent.children[0].nodeType, 3);
  assert.equal(parent.children[0].textContent, '<img onerror=evil> ');
  const anchor = parent.children[1];
  assert.equal(anchor.tagName, 'a');
  assert.equal(anchor.textContent, 'https://example.com/?a=1&b=2');
  assert.equal(anchor.attributes.href, anchor.textContent);
  assert.equal(anchor.attributes.rel, 'noopener noreferrer');
  assert.equal(anchor.attributes.referrerpolicy, 'no-referrer');
  assert.equal('innerHTML' in anchor, false);
  assert.equal('onclick' in anchor.attributes, false);
});

test('only explicit link activation routes to host and suppresses navigation/selection propagation', () => {
  const document = fakeDocument(), calls = [];
  const anchor = createLink(document, 'https://example.com/a?b=1', '公开链接', url => calls.push(url));
  assert.deepEqual(calls, []);
  const down = event(); anchor.listeners.pointerdown(down);
  assert.equal(down.stopped, true); assert.deepEqual(calls, []);
  const click = event(); anchor.listeners.click(click);
  assert.equal(click.prevented, true); assert.equal(click.stopped, true);
  assert.deepEqual(calls, ['https://example.com/a?b=1']);
  const right = event(2); anchor.listeners.auxclick(right);
  assert.equal(right.prevented, true); assert.equal(calls.length, 1);
  const middle = event(1); anchor.listeners.auxclick(middle);
  assert.equal(middle.prevented, true); assert.equal(calls.length, 2);
  assert.equal(createLink(document, 'javascript:alert(1)', 'bad', () => calls.push('bad')), null);
  assert.equal(calls.length, 2);
});

test('actual message renderer routes text and original-post links without reading or selection writes', () => {
  const source = fs.readFileSync(path.join(__dirname, '../app/renderer/app.js'), 'utf8');
  const start = source.indexOf('function renderMessageContent(');
  const end = source.indexOf('\nasync function enrichMessages(', start);
  assert.ok(start >= 0 && end > start);
  const document = fakeDocument(), calls = [], selected = new Set(['kept']);
  const node = (tag, props = {}, ...children) => {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) if (key === 'text') element.textContent = value;
    element.append(...children.flat().filter(x => x !== null && x !== undefined));
    return element;
  };
  const context = {
    document, node, links, emoticons: require('../app/renderer/emoticons.js').create({manifest: require('../app/renderer/emoticon-manifest.js'), links}),
    isNotificationOnly: () => false, isLegacyShare: () => false,
    accountKind: () => 'import', model: { selected }, button: () => { throw Error('unexpected button'); },
    api: (action, payload) => { calls.push({ action, payload }); return Promise.resolve(true); },
    run: (_key, action) => action(),
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end) + ';globalThis.render=renderMessageContent;', context);
  const rendered = context.render({ text: '链接 https://example.com/a', sharedPost: {
    state: 'ready', text: '原帖 https://example.com/b', author: '作者',
    url: 'https://weibo.com/123/Abc', images: [],
  } });
  const anchors = [];
  function walk(element) {
    if (!element || typeof element !== 'object') return;
    if (element.tagName === 'a') anchors.push(element);
    for (const child of element.children || []) walk(child);
  }
  walk(rendered);
  assert.equal(anchors.length, 3);
  assert.equal(calls.length, 0);
  for (const anchor of anchors) anchor.listeners.click(event());
  assert.deepEqual(calls.map(x => x.action), ['external.open', 'external.open', 'external.open']);
  assert.deepEqual(calls.map(x => x.payload.url), ['https://example.com/a', 'https://example.com/b', 'https://weibo.com/123/Abc']);
  assert.deepEqual([...selected], ['kept']);
});

test('script is local, precedes app startup and the link helper contains no HTML insertion', () => {
  const html = fs.readFileSync(path.join(__dirname, '../app/renderer/index.html'), 'utf8');
  assert.ok(html.indexOf('src="linkify.js"') < html.indexOf('src="app.js"'));
  const source = fs.readFileSync(path.join(__dirname, '../app/renderer/linkify.js'), 'utf8');
  assert.doesNotMatch(source, /(?:innerHTML|outerHTML|insertAdjacentHTML|document\.write)\s*(?:=|\()/);
});
