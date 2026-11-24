'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const links = require('../app/renderer/linkify.js');
const { create, projectText, safeStandaloneSource, installCopyHandler } = require('../app/renderer/emoticons.js');
const { standaloneEmoticonsForMessage } = require('../app/core/standalone-emoticons.cjs');

const SHORT = 'https://t.cn/RgFE2Px';
const PAGE = 'https://photo.weibo.com/h5/comment/compic_id/1022:2305976005EGbicly1ftcu7q36u3g30740740u4?emoticon=1';
const TOKEN = 'a'.repeat(32);
const route = (index = 0, variant = 'preview') => `app://media/${TOKEN}/synthetic-group/synthetic-message/emoticon/${index}/${variant}`;
const descriptor = (sourceUrl = SHORT, index = 0) => ({ sourceUrl, src: route(index), originalSrc: route(index, 'original') });
const renderer = create({ links, manifest: { '哈哈': { src: 'app://local/emoticons/synthetic-haha.gif' } } });

// This DOM records assigned image URLs instead of fetching them. All identities
// and assets except the publicly confirmed standalone URL are synthetic.
function fakeDocument() {
  function listen(target) {
    target.listeners = new Map();
    target.addEventListener = (name, callback) => {
      const list = target.listeners.get(name) || []; list.push(callback); target.listeners.set(name, list);
    };
    target.removeEventListener = (name, callback) => target.listeners.set(name, (target.listeners.get(name) || []).filter(fn => fn !== callback));
    target.dispatch = (name, event = {}) => { for (const callback of target.listeners.get(name) || []) callback(event); };
    return target;
  }
  const document = listen({ requests: [], activeElement: null, selection: null });
  document.getSelection = () => document.selection;
  document.createTextNode = value => ({ nodeType: 3, nodeValue: String(value), textContent: String(value), ownerDocument: document });
  document.createElement = tag => {
    const element = listen({ nodeType: 1, tagName: tag.toUpperCase(), ownerDocument: document,
      className: '', style: {}, attributes: new Map(), childNodes: [] });
    element.classList = {
      contains: name => element.className.split(/\s+/).includes(name),
      add: (...names) => { element.className = [...new Set([...element.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
    };
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
function byClass(parent, name) {
  const result = [];
  function walk(node) {
    if (node.classList?.contains(name)) result.push(node);
    for (const child of node.childNodes || []) walk(child);
  }
  walk(parent); return result;
}
function interaction(button = 0) {
  return { button, prevented: false, stopped: false,
    preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
}
function render(text = SHORT, descriptors = [descriptor()], extraOptions = {}) {
  const document = fakeDocument(), parent = document.createElement('div'), opened = [], previews = [];
  renderer.appendText(parent, text, value => opened.push(value), {
    standaloneEmoticons: descriptors, openStandalone: value => previews.push(value), ...extraOptions,
  });
  return { document, parent, opened, previews,
    image: byClass(parent, 'standalone-emoticon-image')[0],
    frame: byClass(parent, 'standalone-emoticon-open')[0],
    wrapper: byClass(parent, 'standalone-emoticon')[0],
    link: byClass(parent, 'standalone-emoticon-link')[0],
  };
}

test('standalone images accept only scoped app media emoticon routes with indices 0 through 15', () => {
  for (const index of [0, 1, 9, 10, 15]) {
    assert.equal(safeStandaloneSource(route(index)), route(index));
    assert.equal(safeStandaloneSource(route(index, 'original'), 'original'), route(index, 'original'));
  }
  const invalid = [
    undefined, null, {}, '', `https://media/${TOKEN}/g/m/emoticon/0/preview`,
    'https://wx2.sinaimg.cn/bmiddle/005EGbicly1ftcu7q36u3g30740740u4.gif',
    'data:image/gif;base64,R0lGODlh', 'javascript:alert(1)', 'file:///C:/synthetic.gif',
    route().replace('app://media/', 'app://media.evil/'), route().replace('app://media/', 'app://evil@media/'),
    route().replace('app://media/', 'app://media:443/'), route().replace('app://media/', 'app://local/'),
    route().replace(TOKEN, 'short-token'), route().replace('/emoticon/', '/message/'),
    route().replace('/emoticon/', '/post/'), route().replace('/emoticon/', '/reference/'),
    ...[-1, 16, 100, '01', '1.0'].map(index => route(index)),
    route(0, 'original'), route(0, 'download'), route() + '?extra=1', route() + '#fragment',
    route() + '\n', route().replace('/synthetic-group/', '//'), route().replace('/synthetic-message/', '//'),
    route().replace('/synthetic-group/', '/%00/'), route().replace('/synthetic-group/', '/' + 'x'.repeat(257) + '/'),
  ];
  for (const value of invalid) assert.equal(safeStandaloneSource(value), null, String(value));
});

test('loading, ready and failed standalone images retain exactly one original URL in text and copy projection', () => {
  const text = `前文（${SHORT}），后文。`;
  for (const state of ['loading', 'ready', 'failed']) {
    const shown = render(text);
    if (state === 'ready') shown.image.dispatch('load');
    if (state === 'failed') shown.image.dispatch('error');
    assert.equal(shown.wrapper.getAttribute('data-emoticon-state'), state);
    assert.equal(projectText(shown.parent), text);
    assert.equal(shown.parent.textContent, text);
    assert.equal(projectText(shown.parent).split(SHORT).length - 1, 1);
    assert.equal(byClass(shown.parent, 'message-link').length, 1);
    assert.equal(shown.link.getAttribute('href'), SHORT);
    assert.equal(shown.image.alt, '');
    assert.equal(shown.image.getAttribute('referrerpolicy'), 'no-referrer');
    assert.deepEqual(shown.document.requests, [route()]);
  }
});

test('image and frame reserve 128 pixels through loading and failure without fetched-content dimensions', () => {
  const shown = render();
  assert.equal(shown.image.width, 128); assert.equal(shown.image.height, 128);
  assert.equal(shown.image.draggable, false); assert.equal(shown.image.loading, 'lazy');
  assert.equal(shown.frame.type, 'button'); assert.ok(shown.frame.getAttribute('aria-label'));
  assert.ok(shown.frame.getAttribute('title')); assert.equal(shown.frame.disabled, true);
  shown.image.dispatch('error');
  assert.equal(shown.image.width, 128); assert.equal(shown.image.height, 128); assert.equal(shown.image.hidden, true);
  const css = fs.readFileSync(path.join(__dirname, '../app/renderer/style.css'), 'utf8');
  const frameRule = css.match(/\.standalone-emoticon-open\s*\{([^}]+)\}/)?.[1];
  assert.ok(frameRule, 'The frame must reserve space before lazy image load');
  assert.match(frameRule, /(?:^|;)width:128px(?:;|$)/);
  assert.match(frameRule, /(?:^|;)height:128px(?:;|$)/);
});

test('untrusted image URLs and mismatched source aliases remain ordinary links without creating image requests', () => {
  const maliciousSources = [
    'https://example.com/image.gif', 'https://wx2.sinaimg.cn/bmiddle/005EGbicly1ftcu7q36u3g30740740u4.gif',
    'data:image/gif;base64,R0lGODlh', 'app://local/emoticons/synthetic.gif',
    route().replace('/emoticon/', '/message/'), route(16), route() + '?x=1',
  ];
  for (const src of maliciousSources) {
    const shown = render(SHORT, [{ ...descriptor(), src }]);
    assert.equal(shown.image, undefined, src); assert.deepEqual(shown.document.requests, [], src);
    assert.equal(projectText(shown.parent), SHORT); assert.equal(byClass(shown.parent, 'message-link').length, 1);
  }
  for (const sourceUrl of [PAGE, SHORT + '?extra=1', SHORT.toUpperCase(), 'https://example.com/']) {
    const shown = render(SHORT, [descriptor(sourceUrl)]);
    assert.equal(shown.image, undefined, sourceUrl); assert.deepEqual(shown.document.requests, []);
  }
  const normalizedAlias = SHORT.replace('t.cn/', 't.cn:443/');
  const normalized = render(normalizedAlias);
  assert.equal(normalized.image, undefined, 'Raw link text, not URL normalization, controls descriptor matching');
  assert.deepEqual(normalized.document.requests, []); assert.equal(projectText(normalized.parent), normalizedAlias);
});

test('original links and ready preview have separate callbacks while loading or failed previews cannot open', () => {
  const item = descriptor(), shown = render(SHORT, [item]);
  const pointer = interaction(); shown.frame.dispatch('pointerdown', pointer); assert.equal(pointer.stopped, true);
  const loadingClick = interaction(); shown.frame.dispatch('click', loadingClick);
  assert.equal(loadingClick.prevented, true); assert.equal(loadingClick.stopped, true); assert.deepEqual(shown.previews, []);
  const linkClick = interaction(); shown.link.dispatch('click', linkClick);
  assert.equal(linkClick.prevented, true); assert.equal(linkClick.stopped, true); assert.deepEqual(shown.opened, [SHORT]);
  shown.image.dispatch('load'); assert.equal(shown.frame.disabled, false);
  shown.frame.dispatch('click', interaction()); assert.deepEqual(shown.previews, [item]);
  assert.deepEqual(shown.opened, [SHORT], 'Opening an inline preview must not also open the external webpage');
  shown.image.dispatch('error'); shown.frame.dispatch('click', interaction()); assert.deepEqual(shown.previews, [item]);
  shown.link.dispatch('click', interaction()); assert.deepEqual(shown.opened, [SHORT, SHORT]);
});

test('invalid original preview target never enables the preview even if inline loading succeeds', () => {
  for (const originalSrc of [undefined, route(), route(16, 'original'), 'https://example.com/file.gif']) {
    const shown = render(SHORT, [{ ...descriptor(), originalSrc }]);
    shown.image.dispatch('load'); assert.equal(shown.frame.disabled, true);
    shown.frame.dispatch('click', interaction()); assert.deepEqual(shown.previews, []);
    assert.equal(projectText(shown.parent), SHORT); assert.deepEqual(shown.document.requests, [route()]);
  }
});

test('late load after failure does not re-enable a hidden image or revive its preview', () => {
  const shown = render();
  shown.image.dispatch('error'); shown.image.dispatch('load');
  assert.equal(shown.wrapper.getAttribute('data-emoticon-state'), 'failed');
  assert.equal(shown.image.hidden, true); assert.equal(shown.frame.disabled, true);
  shown.frame.dispatch('click', interaction()); assert.deepEqual(shown.previews, []);
  assert.equal(projectText(shown.parent), SHORT);
});

test('repeated mixed standalone links and old shortcodes preserve original text and ordinary link behavior', () => {
  const text = `[哈哈] ${SHORT}，${SHORT}\n【哈哈】 ${PAGE}。https://example.com/news?image=photo.gif https://weibo.com/123/synthetic`;
  const derived = standaloneEmoticonsForMessage({ text }).map((item, index) => ({ ...item, ...descriptor(item.sourceUrl, index) }));
  const shown = render(text, derived);
  assert.equal(derived.length, 2); assert.equal(byClass(shown.parent, 'standalone-emoticon-image').length, 3);
  assert.equal(byClass(shown.parent, 'emoticon-image').length, 2);
  assert.equal(byClass(shown.parent, 'message-link').length, 5);
  assert.equal(projectText(shown.parent), text);
  for (const image of [...byClass(shown.parent, 'emoticon-image'), ...byClass(shown.parent, 'standalone-emoticon-image')]) image.dispatch('load');
  assert.equal(projectText(shown.parent), text);
  for (const image of [...byClass(shown.parent, 'emoticon-image'), ...byClass(shown.parent, 'standalone-emoticon-image')]) image.dispatch('error');
  assert.equal(projectText(shown.parent), text);
  assert.deepEqual(shown.document.requests, [
    'app://local/emoticons/synthetic-haha.gif', route(0), route(0),
    'app://local/emoticons/synthetic-haha.gif', route(1),
  ]);
});

test('ordinary webpages, video, post and unverified photo routes retain anchors without image requests', () => {
  const text = [
    'https://example.com/contains-an-image', 'https://video.weibo.com/show?fid=1034:synthetic',
    'https://weibo.com/123/synthetic', 'https://t.cn/Unknown',
    PAGE.replace('?emoticon=1', '?emoticon=0'), PAGE + '&other=1',
  ].join('\n');
  const descriptors = standaloneEmoticonsForMessage({ text });
  assert.deepEqual(descriptors, []);
  const shown = render(text, descriptors);
  assert.equal(byClass(shown.parent, 'message-link').length, 6);
  assert.deepEqual(shown.document.requests, []); assert.equal(projectText(shown.parent), text);
});

test('only the first sixteen descriptors are inspected and rendering never mutates source descriptors', () => {
  const ignored = Array.from({ length: 16 }, (_, i) => descriptor(`https://example.com/${i}`, i));
  const beyond = render(SHORT, [...ignored, descriptor()]);
  assert.equal(beyond.image, undefined); assert.deepEqual(beyond.document.requests, []);
  const valid = Object.freeze(descriptor(SHORT, 15)), items = Object.freeze([...ignored.slice(0, 15), valid]);
  const before = JSON.stringify(items), shown = render(SHORT, items);
  shown.image.dispatch('load'); shown.frame.dispatch('click', interaction());
  assert.deepEqual(shown.document.requests, [route(15)]); assert.equal(JSON.stringify(items), before);
  assert.equal(shown.previews[0], valid);
});

test('mixed selection copy keeps URL and old shortcode semantics without additional image assignments', () => {
  const text = `[哈哈] ${SHORT} 尾文`, shown = render(text);
  shown.image.dispatch('load'); byClass(shown.parent, 'emoticon-image')[0].dispatch('load');
  const before = shown.document.requests.slice();
  shown.document.selection = { isCollapsed: false, rangeCount: 1, getRangeAt: () => ({ cloneContents: () => shown.document.fragment(shown.parent) }) };
  const dispose = installCopyHandler(shown.document), values = new Map(), cleared = [];
  const event = { target: shown.parent, prevented: false, preventDefault() { this.prevented = true; },
    clipboardData: { setData: (name, value) => values.set(name, value), clearData: name => cleared.push(name) } };
  shown.document.dispatch('copy', event);
  assert.equal(event.prevented, true); assert.equal(values.get('text/plain'), text); assert.deepEqual(cleared, ['text/html']);
  assert.deepEqual(shown.document.requests, before, 'Copy projection must not create or reload any image');
  dispose();
});

function dispatchSelectedCopy(shown, fragment, { target = shown.parent, active = null, nativeText = '\nNative inline-flex selection\n' } = {}) {
  const { document } = shown, values = new Map(), cleared = [], requests = document.requests.slice();
  document.activeElement = active;
  document.selection = {
    isCollapsed: false, rangeCount: 1, toString: () => nativeText,
    getRangeAt: () => ({ cloneContents: () => fragment }),
  };
  // Use a cancelable copy event with an injected write-only clipboard, invoking
  // the production listener without accessing the operating-system clipboard.
  const event = new Event('copy', { cancelable: true });
  Object.defineProperties(event, {
    target: { value: target },
    clipboardData: { value: {
      setData: (name, value) => values.set(name, value), clearData: name => cleared.push(name),
      getData() { throw new Error('The copy handler must never read the clipboard'); },
    } },
  });
  const dispose = installCopyHandler(document);
  try { document.dispatch('copy', event); } finally { dispose(); }
  assert.deepEqual(document.requests, requests, 'A copy event must not create or reload an image');
  return { event, values, cleared };
}

test('standalone-only full-wrapper copy is intercepted in every load state without native inline-flex line breaks', () => {
  for (const state of ['loading', 'ready', 'failed']) {
    const shown = render();
    if (state === 'ready') shown.image.dispatch('load');
    if (state === 'failed') shown.image.dispatch('error');
    const copied = dispatchSelectedCopy(shown, shown.document.fragment(shown.wrapper), { nativeText: `\n${SHORT}\n` });
    assert.equal(copied.event.defaultPrevented, true, state);
    assert.deepEqual([...copied.values], [['text/plain', SHORT]], state);
    assert.deepEqual(copied.cleared, ['text/html']);
  }
});

test('partial standalone link selections copy only the selected characters including in failed wrappers', () => {
  for (const insideWrapper of [false, true]) {
    const shown = render(), partial = shown.document.createElement('a');
    partial.className = 'message-link standalone-emoticon-link';
    partial.textContent = 't.cn/Rg';
    let fragment = shown.document.fragment(partial);
    if (insideWrapper) {
      shown.image.dispatch('error');
      // Mirrors cloneContents() of a range intersecting only part of the link.
      shown.wrapper.childNodes = [partial];
      fragment = shown.document.fragment(shown.wrapper);
    }
    const copied = dispatchSelectedCopy(shown, fragment, { nativeText: '\nt.cn/Rg' });
    assert.equal(copied.event.defaultPrevented, true);
    assert.equal(copied.values.get('text/plain'), 't.cn/Rg');
    assert.notEqual(copied.values.get('text/plain'), SHORT, 'Copy must not expand a partial selection to the entire URL');
  }
});

test('repeated standalone and mixed shortcode copy events preserve punctuation and explicit newlines exactly', () => {
  for (const text of [`${SHORT}，${SHORT}\n${PAGE}`, `前文[哈哈] ${SHORT}\n【哈哈】 ${PAGE} 后文`]) {
    const descriptors = standaloneEmoticonsForMessage({ text }).map((item, index) => descriptor(item.sourceUrl, index));
    const shown = render(text, descriptors);
    for (const image of [...byClass(shown.parent, 'standalone-emoticon-image'), ...byClass(shown.parent, 'emoticon-image')]) image.dispatch('load');
    const copied = dispatchSelectedCopy(shown, shown.document.fragment(shown.parent));
    assert.equal(copied.event.defaultPrevented, true);
    assert.equal(copied.values.get('text/plain'), text);
    assert.deepEqual(copied.cleared, ['text/html']);
  }
});

test('image-only and empty standalone range fragments do not invent links or intercept native image copy', () => {
  for (const kind of ['image', 'frame', 'empty-wrapper', 'empty-link']) {
    const shown = render(); shown.image.dispatch('load');
    let selected;
    if (kind === 'image') selected = shown.image;
    if (kind === 'frame') { shown.wrapper.childNodes = [shown.frame]; selected = shown.wrapper; }
    if (kind === 'empty-wrapper') { shown.wrapper.childNodes = []; selected = shown.wrapper; }
    if (kind === 'empty-link') { shown.link.childNodes = []; selected = shown.link; }
    const fragment = shown.document.fragment(selected);
    assert.equal(projectText(fragment), '', kind);
    const copied = dispatchSelectedCopy(shown, fragment);
    assert.equal(copied.event.defaultPrevented, false, kind);
    assert.equal(copied.values.size, 0, kind); assert.deepEqual(copied.cleared, []);
  }
});

test('standalone copy handler leaves input, textarea and contenteditable editing untouched for target or active focus', () => {
  for (const kind of ['input', 'textarea', 'contenteditable']) {
    for (const focusedVia of ['target', 'active']) {
      const shown = render(), editor = shown.document.createElement(kind === 'contenteditable' ? 'div' : kind);
      if (kind === 'contenteditable') editor.isContentEditable = true;
      const copied = dispatchSelectedCopy(shown, shown.document.fragment(shown.wrapper), {
        target: focusedVia === 'target' ? editor : shown.parent,
        active: focusedVia === 'active' ? editor : null,
      });
      assert.equal(copied.event.defaultPrevented, false, `${kind}/${focusedVia}`);
      assert.equal(copied.values.size, 0); assert.deepEqual(copied.cleared, []);
    }
  }
});
