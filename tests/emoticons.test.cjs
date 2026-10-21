'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const links = require('../app/renderer/linkify.js');
const { create, safeAsset, projectText, installCopyHandler, IMAGE_SIZE } = require('../app/renderer/emoticons.js');
// Deliberately synthetic local assets: no assertion that this is an official map.
const manifest = {
  '二哈': { src: 'app://local/emoticons/synthetic-erha.png' },
  '笑cry': { src: 'app://local/emoticons/synthetic-laughcry.gif' },
  '哈哈': { src: 'app://local/emoticons/synthetic-haha.webp' },
};
const renderer = create({ manifest, links });
const emoticons = text => renderer.tokenize(text).filter(part => part.type === 'emoticon');
const reconstruct = text => renderer.tokenize(text).map(part => part.text).join('');

test('all verified official names and both bracket forms render without changing original text or requesting absent icons', () => {
  const official=require('../app/renderer/emoticon-manifest.js');
  const document=fakeDocument(),full=create({manifest:official,links});
  const names=Object.keys(official),text=names.map(name=>`[${name}]【${name}】`).join('，\n');
  const parts=full.tokenize(text),images=parts.filter(part=>part.type==='emoticon');
  assert.equal(names.length,409);assert.equal(images.length,names.length*2);
  assert.equal(parts.map(part=>part.text).join(''),text);
  assert.equal(document.requests.length,0,'Constructing and tokenizing a full catalogue must not preload images');
  for(const [index,name] of names.entries()){
    assert.equal(images[index*2].name,name);assert.equal(images[index*2+1].name,name);
    assert.equal(images[index*2].src,official[name].src);
  }
  const shown=document.createElement('div');
  const selected='[二哈]【大侦探皮卡丘微笑】[正义联盟logo]【宇航员】[航天员]';
  full.appendText(shown,selected);
  assert.equal(document.requests.length,5,'Only emoticons in the rendered messages create image elements');
  assert.equal(projectText(shown),selected);
  assert.equal(document.requests.at(-1),document.requests.at(-2),'Official duplicate-content names resolve to the shared asset');
  const long=childrenByClass(shown,'emoticon-fallback-long');
  assert.deepEqual(long.map(node=>node.textContent),['【大侦探皮卡丘微笑】','[正义联盟logo]','【宇航员】','[航天员]']);
  assert.deepEqual(childrenByClass(shown,'emoticon-fallback-compact').map(node=>node.textContent),
    ['【大侦探皮卡丘微笑】','[正义联盟logo]']);
  for(const image of childrenByClass(shown,'emoticon-image'))image.dispatch('error');
  assert.equal(projectText(shown),selected,'Every failed long/short token still copies its complete original text');
});

test('long legacy path code failure retains its exact original copy text and fixed-size image slot',()=>{
  const official=require('../app/renderer/emoticon-manifest.js'),document=fakeDocument(),full=create({manifest:official,links});
  const shown=document.createElement('div'),text='[苦涩]【/ee8192.png】[/ee858c.png][/ee88a6.png]【/ee88a6.png】[/ee84a5.png]【/ee84a5.png】[/ee88ab.png]【/ee88ab.png】';
  full.appendText(shown,text);
  const images=childrenByClass(shown,'emoticon-image');
  assert.equal(images.length,9);assert.equal(projectText(shown),text);
  for(const image of images){assert.equal(image.width,IMAGE_SIZE);assert.equal(image.height,IMAGE_SIZE);image.dispatch('error');}
  assert.equal(projectText(shown),text);
  assert.deepEqual(childrenByClass(shown,'emoticon-fallback-compact').map(node=>node.textContent),['【/ee8192.png】','[/ee858c.png]','[/ee88a6.png]','【/ee88a6.png】','[/ee84a5.png]','【/ee84a5.png】','[/ee88ab.png]','【/ee88ab.png】']);
});

test('conflicting normalized names stay literal instead of selecting an arbitrary same-name emoticon',()=>{
  const first='app://local/emoticons/first.png',second='app://local/emoticons/second.gif';
  for(const entries of [
    {'二哈':first,'[二哈]':second,'【二哈】':first},
    {'[二哈]':second,'二哈':first},
    {'二哈':first,'【二哈】':'https://example.com/untrusted.png'},
  ]){
    assert.deepEqual(create({manifest:entries,links}).tokenize('[二哈]【二哈】'),[{type:'text',text:'[二哈]【二哈】'}]);
  }
  const aliases=create({manifest:{'二哈':first,'[二哈]':first,'旧代码':first},links});
  assert.deepEqual(aliases.tokenize('[二哈]【旧代码】').map(part=>part.src),[first,first]);
});

test('both bracket forms resolve only injected known names while preserving every original literal', () => {
  const text = '你好[二哈]【笑cry】[哈哈]【二哈】[笑cry]【哈哈】再见';
  const result = emoticons(text);
  assert.deepEqual(result.map(part => part.text), ['[二哈]', '【笑cry】', '[哈哈]', '【二哈】', '[笑cry]', '【哈哈】']);
  assert.deepEqual(result.map(part => part.name), ['二哈', '笑cry', '哈哈', '二哈', '笑cry', '哈哈']);
  assert.equal(result[0].src, manifest['二哈'].src);
  assert.equal(result[1].src, manifest['笑cry'].src);
  assert.equal(reconstruct(text), text);
  assert.deepEqual(create({ links }).tokenize(text), [{ type: 'text', text }]);
});

test('repeated and mixed tokens preserve punctuation, whitespace and newline order', () => {
  for (const text of ['[二哈][二哈]【二哈】', '中文\n【笑cry】  [哈哈]\n', '【哈哈】，真的！[二哈]。']) {
    assert.equal(reconstruct(text), text);
    assert.equal(emoticons(text).length, text === '中文\n【笑cry】  [哈哈]\n' ? 2 : text.startsWith('【哈哈】') ? 2 : 3);
  }
});

test('unknown, ordinary, malformed and nested bracket prose stays unchanged', () => {
  for (const text of [
    '[未知表情]【未知表情】(二哈)（哈哈）', '[笑Cry]', '[ 二哈]', '[二哈 ]',
    '[二哈】', '【二哈]', '[[二哈]]', '【段落[二哈]】', '[未闭合[哈哈]',
    '[二\n哈]', '[]【】', '[' + 'x'.repeat(1000) + ']',
  ]) {
    assert.deepEqual(emoticons(text), [], text);
    assert.equal(reconstruct(text), text);
  }
  assert.deepEqual(emoticons('[未知] [二哈]').map(part => part.text), ['[二哈]']);
});

test('valid HTTP(S) links retain bracket contents, fragments, queries and original link behavior', () => {
  for (const url of [
    'https://example.com/[二哈]?q=【哈哈】#【笑cry】',
    'http://[::1]/[二哈]', 'https://example.com/?text=%5B%E4%BA%8C%E5%93%88%5D',
  ]) {
    const text = `${url}\n【二哈】`;
    const tokens = renderer.tokenize(text);
    assert.deepEqual(tokens.filter(part => part.type === 'link'), links.tokenize(text).filter(part => part.type === 'link'));
    assert.deepEqual(emoticons(text).map(part => part.text), ['【二哈】']);
    assert.equal(reconstruct(text), text);
  }
});

test('unsupported, credential-bearing and oversized URI candidates are preserved without anchors or substitutions', () => {
  for (const text of [
    'ftp://example.com/[二哈]', 'file:///C:/[二哈]', 'app://local/[二哈]', 'www.example.com/【二哈】',
    '//example.com/[二哈]', 'custom://example.com/[二哈]',
    'mailto:test@example.com?subject=[二哈]', 'javascript:https://example.com/[二哈]',
    'https://user:pw@example.com/[二哈]', 'data:text/plain,[二哈]',
    'https://example.com/' + 'a'.repeat(5000) + '[二哈]',
  ]) {
    assert.deepEqual(emoticons(text), [], text);
    assert.deepEqual(renderer.tokenize(text).filter(part => part.type === 'link'), [], text);
    assert.equal(reconstruct(text), text);
  }
  assert.deepEqual(emoticons('Note:[二哈] 标签:【哈哈】').map(part => part.text), ['[二哈]', '【哈哈】']);
});

test('manifest only accepts exact bundled image paths and snapshots own entries', () => {
  for (const value of [
    'https://example.com/emote.png', 'data:image/png;base64,eA==', 'file:///emote.png',
    'app://other/emoticons/emote.png', 'app://local:80/emoticons/emote.png', 'app://x@local/emoticons/emote.png',
    'app://local/emoticons/../emote.png', 'app://local/emoticons/%2e%2e/emote.png',
    'app://local/emoticons/nested/emote.png', 'app://local/emoticons/emote.svg', 'app://local/emoticons/emote.png?q=x',
    'app://local/emoticons/emote.png#x', 'app://local/emoticons/emote.png\n', 'app://local/emoticons/emote..png',
  ]) {
    assert.equal(safeAsset(value), null, value);
    assert.equal(create({ manifest: { '二哈': value }, links }).tokenize('[二哈]')[0].type, 'text');
  }
  const inherited = Object.create({ '二哈': manifest['二哈'] });
  inherited['哈哈'] = manifest['哈哈'];
  assert.equal(create({ manifest: inherited, links }).tokenize('[二哈]')[0].type, 'text');
  const mutable = { '二哈': { ...manifest['二哈'] } };
  const fixed = create({ manifest: mutable, links });
  mutable['二哈'].src = 'https://evil.example/emote.png';
  assert.equal(fixed.tokenize('[二哈]')[0].src, manifest['二哈'].src);
  const bracketKeys = create({ manifest: { '[二哈]': manifest['二哈'], '【哈哈】': manifest['哈哈'] }, links });
  assert.deepEqual(bracketKeys.tokenize('【二哈】[哈哈]').map(part => part.name), ['二哈', '哈哈']);
  assert.equal(renderer.tokenize('[constructor][__proto__]')[0].type, 'text');
});

function fakeDocument() {
  function listeners(target) {
    target.listeners = new Map();
    target.addEventListener = (type, callback) => {
      const list = target.listeners.get(type) || []; list.push(callback); target.listeners.set(type, list);
    };
    target.removeEventListener = (type, callback) => target.listeners.set(type, (target.listeners.get(type) || []).filter(value => value !== callback));
    target.dispatch = (type, event = {}) => { for (const callback of target.listeners.get(type) || []) callback(event); };
    return target;
  }
  const document = listeners({ requests: [], activeElement: null, selection: null });
  document.getSelection = () => document.selection;
  document.createTextNode = value => ({ nodeType: 3, nodeValue: String(value), textContent: String(value), ownerDocument: document });
  document.createElement = tag => {
    const element = listeners({ nodeType: 1, tagName: tag.toUpperCase(), ownerDocument: document,
      className: '', style: {}, attributes: new Map(), childNodes: [] });
    element.classList = { contains: name => element.className.split(/\s+/).includes(name) };
    element.setAttribute = (name, value) => element.attributes.set(name, String(value));
    element.getAttribute = name => element.attributes.get(name) ?? null;
    element.append = (...children) => element.childNodes.push(...children);
    Object.defineProperty(element, 'textContent', {
      get: () => element.childNodes.map(child => child.textContent).join(''),
      set: value => { element.childNodes = [document.createTextNode(value)]; },
    });
    Object.defineProperty(element, 'src', {
      get: () => element.attributes.get('src'),
      set: value => { document.requests.push(String(value)); element.attributes.set('src', String(value)); },
    });
    return element;
  };
  document.fragment = (...childNodes) => ({ nodeType: 11, childNodes });
  return document;
}
function childrenByClass(parent, name) {
  const result = [];
  function walk(node) {
    if (node.classList?.contains(name)) result.push(node);
    for (const child of node.childNodes || []) walk(child);
  }
  walk(parent); return result;
}
function copyEvent(target) {
  return { target, defaultPrevented: false, values: new Map(), cleared: [],
    preventDefault() { this.defaultPrevented = true; },
    get clipboardData() { return {
      setData: (type, value) => this.values.set(type, value),
      clearData: type => this.cleared.push(type),
    }; } };
}

test('safe rendering creates text nodes, real local images and exact alt/title/original-token metadata', () => {
  const document = fakeDocument(), parent = document.createElement('div');
  const text = '<img src=x onerror=bad()> [二哈]【笑cry】 https://example.com/[哈哈]';
  assert.equal(renderer.appendText(parent, text), parent);
  assert.equal(parent.childNodes[0].nodeType, 3);
  assert.equal(parent.childNodes[0].textContent, '<img src=x onerror=bad()> ');
  const wrappers = childrenByClass(parent, 'inline-emoticon'), images = childrenByClass(parent, 'emoticon-image');
  assert.equal(images.length, 2); assert.equal(wrappers.length, 2);
  assert.equal(wrappers[0].getAttribute('data-original-token'), '[二哈]');
  assert.equal(wrappers[1].getAttribute('data-original-token'), '【笑cry】');
  assert.deepEqual(images.map(image => [image.alt, image.title]), [['[二哈]', '[二哈]'], ['【笑cry】', '【笑cry】']]);
  assert.ok(images.every(image => image.width === IMAGE_SIZE && image.height === IMAGE_SIZE && image.draggable === false));
  assert.ok(images.every(image => !image.classList.contains('message-image')));
  assert.deepEqual(document.requests, [manifest['二哈'].src, manifest['笑cry'].src]);
  assert.equal(projectText(parent), text);
});

test('load and failure keep the reserved box dimensions; failed image reveals complete original literal', () => {
  const document = fakeDocument(), parent = document.createElement('div');
  renderer.appendText(parent, '[二哈]【笑cry】');
  for (const wrapper of childrenByClass(parent, 'inline-emoticon')) {
    const [fallback, image] = wrapper.childNodes;
    const before = { width: image.width, height: image.height, wrapperStyle: { ...wrapper.style } };
    assert.equal(fallback.textContent, wrapper.getAttribute('data-original-token'));
    assert.equal(wrapper.getAttribute('data-emoticon-state'), 'loading');
    image.dispatch('load'); assert.equal(fallback.hidden, true); assert.equal(image.hidden, false);
    assert.equal(wrapper.getAttribute('data-emoticon-state'), 'ready');
    image.dispatch('error'); assert.equal(fallback.hidden, false); assert.equal(image.hidden, true);
    assert.equal(wrapper.getAttribute('data-emoticon-state'), 'failed');
    assert.deepEqual({ width: image.width, height: image.height, wrapperStyle: { ...wrapper.style } }, before);
    assert.equal(projectText(wrapper), fallback.textContent);
    image.dispatch('load'); assert.equal(image.hidden, true, 'Late load must not erase the fallback after failure');
  }
});

test('links still route only explicit clicks through the existing safe external-open callback', () => {
  const document = fakeDocument(), parent = document.createElement('div'), calls = [];
  renderer.appendText(parent, '[二哈] https://example.com/?q=[哈哈] 【笑cry】', url => calls.push(url));
  const anchors = childrenByClass(parent, 'message-link');
  assert.equal(anchors.length, 1); assert.deepEqual(calls, []);
  const event = { button: 0, prevented: false, stopped: false,
    preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
  anchors[0].dispatch('click', event);
  assert.equal(event.prevented, true); assert.equal(event.stopped, true);
  assert.deepEqual(calls, [links.normalizeHttpUrl('https://example.com/?q=[哈哈]')]);
});

test('copy projection preserves both original bracket forms, message newlines, links and cross-message boundaries', () => {
  const document = fakeDocument(), first = document.createElement('article'), second = document.createElement('article');
  const line1 = document.createElement('div'), line2 = document.createElement('div');
  renderer.appendText(line1, '第一行[二哈]\n第二行【笑cry】 https://example.com/[哈哈]');
  renderer.appendText(line2, '另一条【哈哈】');
  first.append(line1); second.append(line2, document.createElement('br'), document.createTextNode('结束'));
  const fragment = document.fragment(first, second), count = document.requests.length;
  assert.equal(projectText(fragment), '第一行[二哈]\n第二行【笑cry】 https://example.com/[哈哈]\n另一条【哈哈】\n结束');
  assert.equal(document.requests.length, count, 'Copy projection must not create/request images');
  assert.equal(projectText(document.fragment(document.createTextNode('  leading\n\ntrailing  '))), '  leading\n\ntrailing  ');
});

test('partial visible fallback and image-only selected fragments preserve the actual selected text', () => {
  const document = fakeDocument(), parent = document.createElement('div');
  renderer.appendText(parent, '[二哈]');
  const wrapper = childrenByClass(parent, 'inline-emoticon')[0], [fallback, image] = wrapper.childNodes;
  fallback.textContent = '[二'; wrapper.childNodes = [fallback];
  assert.equal(projectText(document.fragment(document.createTextNode('A'), wrapper)), 'A[二');
  wrapper.setAttribute('data-emoticon-state', 'failed');
  assert.equal(projectText(wrapper), '[二');
  assert.equal(projectText(document.fragment(image)), '[二哈]');
  document.selection = { isCollapsed: false, rangeCount: 1, getRangeAt: () => ({
    cloneContents: () => document.fragment(image),
  }) };
  const remove = renderer.installCopyHandler(document), event = copyEvent(parent);
  document.dispatch('copy', event);
  assert.equal(event.values.get('text/plain'), '[二哈]');
  assert.equal(renderer.installCopyHandler(document), remove);
  renderer.dispose(); assert.equal(document.listeners.get('copy').length, 0);
});

test('empty ready-wrapper and hidden fallback-only range boundaries do not add unselected tokens', () => {
  const document = fakeDocument(), parent = document.createElement('div');
  renderer.appendText(parent, '[二哈]');
  const wrapper = childrenByClass(parent, 'inline-emoticon')[0], [fallback, image] = wrapper.childNodes;
  image.dispatch('load');
  wrapper.childNodes = [];
  const fragment = document.fragment(document.createTextNode('正文结束'), wrapper);
  assert.equal(projectText(fragment), '正文结束');
  wrapper.childNodes = [fallback];
  assert.equal(projectText(fragment), '正文结束');
  document.selection = { isCollapsed: false, rangeCount: 1, getRangeAt: () => ({ cloneContents: () => fragment }) };
  const remove = installCopyHandler(document), event = copyEvent(parent);
  document.dispatch('copy', event);
  assert.equal(event.values.size, 0); assert.equal(event.defaultPrevented, false);
  remove();
});

test('copy handler only writes the selected projection for emoticon ranges and never reads a clipboard', () => {
  const document = fakeDocument(), parent = document.createElement('div');
  renderer.appendText(parent, '复制[二哈]与【哈哈】');
  document.selection = { isCollapsed: false, rangeCount: 1, getRangeAt: () => ({ cloneContents: () => document.fragment(parent) }) };
  const remove = installCopyHandler(document);
  assert.equal(installCopyHandler(document), remove, 'Installation should be idempotent');
  assert.equal(document.listeners.get('copy').length, 1);
  const event = copyEvent(parent), requests = document.requests.length;
  document.dispatch('copy', event);
  assert.deepEqual([...event.values], [['text/plain', '复制[二哈]与【哈哈】']]);
  assert.deepEqual(event.cleared, ['text/html']); assert.equal(event.defaultPrevented, true);
  assert.equal(document.requests.length, requests);
  remove(); remove();
  assert.equal(document.listeners.get('copy').length, 0);
  const secondRemove = installCopyHandler(document); remove();
  assert.equal(document.listeners.get('copy').length, 1); secondRemove();
});

test('ordinary text, collapsed selection, input/textarea editing and already handled copies are untouched', () => {
  const document = fakeDocument(), parent = document.createElement('div');
  renderer.appendText(parent, '[二哈]');
  installCopyHandler(document);
  const fragment = document.fragment(parent);
  document.selection = { isCollapsed: false, rangeCount: 1, getRangeAt: () => ({ cloneContents: () => fragment }) };
  for (const tag of ['input', 'textarea']) {
    const input = document.createElement(tag), event = copyEvent(input);
    document.dispatch('copy', event); assert.equal(event.values.size, 0); assert.equal(event.defaultPrevented, false);
    document.activeElement = input;
    const bodyEvent = copyEvent(parent); document.dispatch('copy', bodyEvent); assert.equal(bodyEvent.values.size, 0);
    document.activeElement = null;
  }
  const editable = document.createElement('div'); editable.isContentEditable = true;
  const editing = copyEvent(editable); document.dispatch('copy', editing); assert.equal(editing.values.size, 0);
  const handled = copyEvent(parent); handled.defaultPrevented = true;
  document.dispatch('copy', handled); assert.equal(handled.values.size, 0);
  document.selection.isCollapsed = true;
  const collapsed = copyEvent(parent); document.dispatch('copy', collapsed); assert.equal(collapsed.values.size, 0);
  document.selection = { isCollapsed: false, rangeCount: 1, getRangeAt: () => ({
    cloneContents: () => document.fragment(document.createTextNode('普通复制[未知]')),
  }) };
  const plain = copyEvent(parent); document.dispatch('copy', plain); assert.equal(plain.values.size, 0);
});

test('large bracket input scans without losing text and browser export loads without DOM or network', () => {
  const text = '['.repeat(50000) + '二哈' + ']'.repeat(50000) + '[哈哈]';
  assert.equal(reconstruct(text), text);
  assert.deepEqual(emoticons(text).map(part => part.text), ['[哈哈]']);
  const source = fs.readFileSync(path.join(__dirname, '../app/renderer/emoticons.js'), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(source, context);
  assert.equal(typeof context.WeiyueEmoticons.create, 'function');
  assert.equal(typeof context.WeiyueEmoticons.installCopyHandler, 'function');
  assert.doesNotMatch(source, /\.\s*(?:innerHTML|outerHTML|insertAdjacentHTML|readText|writeText)\b|\b(?:fetch|XMLHttpRequest)\s*\(/);
});
