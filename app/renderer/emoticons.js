(function (root, factory) {
  'use strict';
  const exported = factory();
  if (typeof module === 'object' && module.exports) module.exports = exported;
  else root.WeiyueEmoticons = exported;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const IMAGE_SIZE = 24;
  const MAX_NAME_LENGTH = 64;
  const LEGACY_SINGLE_LINE = new Set(['二哈', '笑cry', '哈哈']);
  const OPEN = Object.freeze({ '[': ']', '【': '】' });
  const CLOSE = new Set([']', '】']);
  const BLOCKS = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DIV', 'DL', 'DT', 'DD',
    'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TR', 'UL']);
  const COPY_HANDLERS = new WeakMap();

  function tokenName(value) {
    if (typeof value !== 'string' || value.length < 3 || value.length > MAX_NAME_LENGTH + 2 ||
        OPEN[value[0]] !== value.at(-1)) return null;
    const name = value.slice(1, -1);
    return /[\[\]【】\r\n]/u.test(name) ? null : name;
  }
  function safeAsset(value) {
    // Only a verified, bundled manifest may determine an image address. There
    // are no remote URLs, path traversal, queries or credentials in this route.
    if (typeof value !== 'string' ||
        !/^app:\/\/local\/emoticons\/[a-zA-Z0-9][a-zA-Z0-9_-]*\.(?:png|gif|webp)$/.test(value)) return null;
    return value;
  }

  function safeStandaloneSource(value, variant = 'preview') {
    if (typeof value !== 'string' || value.length > 4096 || /[\s\\\u0000-\u001f\u007f]/.test(value)) return null;
    try {
      const u = new URL(value), p = u.pathname.slice(1).split('/').map(decodeURIComponent);
      if (u.protocol !== 'app:' || u.host !== 'media' || u.username || u.password || u.port || u.search || u.hash ||
          p.length !== 6 || !/^[a-f0-9]{32}$/.test(p[0]) || p[3] !== 'emoticon' || !/^(?:[0-9]|1[0-5])$/.test(p[4]) || p[5] !== variant ||
          p.slice(1,3).some(s => !s || s.length > 256 || /[\u0000-\u001f\u007f]/.test(s))) return null;
      return u.href;
    } catch { return null; }
  }
  function manifestTable(manifest) {
    const result = new Map(), ambiguous = new Set();
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return result;
    for (const [key, descriptor] of Object.entries(manifest)) {
      const name = tokenName(key) || key;
      if (!name || name.length > MAX_NAME_LENGTH || /[\[\]【】\r\n]/u.test(name) || ambiguous.has(name)) continue;
      const src = safeAsset(typeof descriptor === 'string' ? descriptor : descriptor?.src);
      if (result.has(name) && result.get(name) !== src) {
        result.delete(name); ambiguous.add(name);
      } else if (src) result.set(name, src);
    }
    return result;
  }

  function appendPlain(parts, value) {
    if (!value) return;
    if (parts.at(-1)?.type === 'text') parts[parts.length - 1].text += value;
    else parts.push({ type: 'text', text: value });
  }
  function scanBrackets(text, table, parts) {
    const stack = [];
    let start = -1, end = 0, invalid = false;
    for (let index = 0; index < text.length; index++) {
      const character = text[index];
      if (Object.hasOwn(OPEN, character)) {
        if (!stack.length) { start = index; invalid = false; }
        else invalid = true; // Nested bracket prose is preserved as one literal.
        stack.push(character);
      } else if (CLOSE.has(character) && stack.length) {
        if (OPEN[stack.pop()] !== character) invalid = true;
        if (!stack.length && !invalid) {
          const original = text.slice(start, index + 1), name = tokenName(original);
          const src = name === null ? undefined : table.get(name);
          if (src) {
            appendPlain(parts, text.slice(end, start));
            parts.push({ type: 'emoticon', text: original, name, src });
            end = index + 1;
          }
        }
      }
    }
    appendPlain(parts, text.slice(end));
  }
  function scanPlainText(text, table, parts) {
    // Valid HTTP(S) links are already protected by WeiyueLinks. Conservatively
    // preserve unsupported/rejected URI-looking text too, without linking it.
    const uri = /(?:[a-z][a-z0-9+.-]*:\/\/|\/\/|www\.|(?:mailto|data|javascript|tel|file|app|weibo|sinaweibo):)[^\s<>"'`，。！？；：、…“”‘’]+/giu;
    let end = 0;
    for (const match of text.matchAll(uri)) {
      scanBrackets(text.slice(end, match.index), table, parts);
      appendPlain(parts, match[0]); end = match.index + match[0].length;
    }
    scanBrackets(text.slice(end), table, parts);
  }

  function originalToken(node) {
    if (node?.nodeType !== 1 ||
        !(node.classList?.contains('inline-emoticon') || node.classList?.contains('emoticon-image'))) return null;
    const value = node.getAttribute('data-original-token');
    return tokenName(value) === null ? null : value;
  }
  function containsEmoticon(node) {
    if (originalToken(node) !== null && projectText(node) !== '') return true;
    // An inline-flex image/link component adds visual line breaks to Chromium's
    // native selection text. Project the selected link text itself, including
    // partial selections, without expanding an image-only selection to a URL.
    if ((node?.classList?.contains('standalone-emoticon') ||
        node?.classList?.contains('standalone-emoticon-link')) && projectText(node) !== '') return true;
    for (const child of node?.childNodes || []) if (containsEmoticon(child)) return true;
    return false;
  }
  function projectText(node) {
    if (!node) return '';
    if (node.nodeType === 3) return node.nodeValue ?? node.textContent ?? '';
    const token = originalToken(node);
    if (token !== null) {
      if (node.classList.contains('emoticon-image')) return token;
      const hasImage = [...(node.childNodes || [])].some(child => child.classList?.contains('emoticon-image'));
      // A range ending at offset zero may clone an empty ready wrapper. Only
      // restore its token if the range actually contains the displayed image.
      if (node.getAttribute('data-emoticon-state') === 'ready') return hasImage ? token : '';
      // Loading/failed fallback is visible selectable text. A cloned range can
      // contain only part of that text: preserve that part instead of expanding
      // it into the full emoticon. An image-only clone still restores its token.
      const fallback = [...(node.childNodes || [])].filter(child => child.classList?.contains('emoticon-fallback'));
      if (fallback.length) return fallback.map(projectText).join('');
      return hasImage ? token : '';
    }
    const tag = String(node.tagName || '').toUpperCase();
    if (tag === 'BR') return '\n';
    if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(tag) || node.hidden) return '';
    let text = '', previousBlock = false, previousCell = false;
    for (const child of node.childNodes || []) {
      const value = projectText(child);
      if (!value) continue;
      const childTag = String(child.tagName || '').toUpperCase();
      const block = BLOCKS.has(childTag), cell = childTag === 'TD' || childTag === 'TH';
      if (text && (previousBlock || block) && !text.endsWith('\n') && !value.startsWith('\n')) text += '\n';
      else if (text && (previousCell || cell) && !text.endsWith('\t')) text += '\t';
      text += value; previousBlock = block; previousCell = cell;
    }
    return text;
  }
  function installCopyHandler(document) {
    if (!document || typeof document.addEventListener !== 'function')
      throw new Error('表情复制处理需要有效的文档。');
    const existing = COPY_HANDLERS.get(document);
    if (existing) return existing;
    const copy = event => {
      if (event.defaultPrevented || typeof event.clipboardData?.setData !== 'function') return;
      const target = event.target, active = document.activeElement;
      const isEditor = node => ['INPUT', 'TEXTAREA'].includes(String(node?.tagName || '').toUpperCase()) || node?.isContentEditable;
      if (isEditor(target) || isEditor(active)) return;
      try {
        const selection = document.getSelection?.() || document.defaultView?.getSelection?.();
        if (!selection || selection.isCollapsed || !selection.rangeCount) return;
        const fragments = [];
        for (let index = 0; index < selection.rangeCount; index++)
          fragments.push(selection.getRangeAt(index).cloneContents());
        if (!fragments.some(containsEmoticon)) return;
        // Detached fragments are never inserted into a document or assigned
        // innerHTML, so projecting a selection cannot load an image.
        const text = fragments.map(projectText).join('\n');
        event.clipboardData.setData('text/plain', text);
        event.clipboardData.clearData?.('text/html');
        event.preventDefault();
      } catch { /* Leave the browser's normal copy behavior available. */ }
    };
    document.addEventListener('copy', copy);
    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      document.removeEventListener('copy', copy);
      COPY_HANDLERS.delete(document);
    };
    COPY_HANDLERS.set(document, remove);
    return remove;
  }

  function create({ manifest = {}, links } = {}) {
    if (typeof links?.tokenize !== 'function' || typeof links?.createLink !== 'function')
      throw new Error('表情显示需要已有的安全链接解析器。');
    const table = manifestTable(manifest);
    const copyDisposers = new Set();
    function tokenize(value) {
      const text = typeof value === 'string' ? value : String(value ?? '');
      const parts = [];
      for (const part of links.tokenize(text)) {
        if (part.type === 'link') parts.push({ type: 'link', text: part.text, url: part.url });
        else scanPlainText(part.text, table, parts);
      }
      if (!parts.length) parts.push({ type: 'text', text: '' });
      return parts;
    }
    function createEmoticon(document, part) {
      const wrapper = document.createElement('span');
      wrapper.className = 'inline-emoticon';
      wrapper.setAttribute('data-original-token', part.text);
      wrapper.setAttribute('data-emoticon-state', 'loading');
      wrapper.setAttribute('title', part.text);
      // Host CSS reserves a 32×24 slot in every state. Images are 24×24;
      // fallback uses small text inside the same slot, never expanding it.
      const fallback = document.createElement('span');
      // JavaScript character count does not predict glyph width: e.g.
      // 【宇航员】 is only five characters but occupies 40px at 8px CJK size.
      // Keep the six legacy tokens' measured typography; every additional
      // official name uses the bounded multiline fallback geometry.
      fallback.className = 'emoticon-fallback' + (!LEGACY_SINGLE_LINE.has(part.name) ? ' emoticon-fallback-long' : '') +
        (part.text.length >= 9 ? ' emoticon-fallback-compact' : '');
      fallback.textContent = part.text;
      const image = document.createElement('img');
      image.className = 'emoticon-image';
      image.width = IMAGE_SIZE; image.height = IMAGE_SIZE;
      image.alt = part.text; image.title = part.text;
      image.draggable = false; image.decoding = 'async'; image.hidden = true;
      image.setAttribute('data-original-token', part.text);
      image.setAttribute('referrerpolicy', 'no-referrer');
      let failed = false;
      image.addEventListener('load', () => {
        if (failed) return;
        fallback.hidden = true; image.hidden = false;
        wrapper.setAttribute('data-emoticon-state', 'ready');
      });
      image.addEventListener('error', () => {
        failed = true; fallback.hidden = false; image.hidden = true;
        wrapper.setAttribute('data-emoticon-state', 'failed');
      });
      wrapper.append(fallback, image);
      image.src = part.src;
      return wrapper;
    }
    function createStandalone(document, part, options, openLink) {
      const descriptor = Array.isArray(options?.standaloneEmoticons) && options.standaloneEmoticons.slice(0,16).find(item => item?.sourceUrl === part.text);
      const src = safeStandaloneSource(descriptor?.src);
      if (!src) return null;
      const wrapper = document.createElement('span');
      wrapper.className = 'standalone-emoticon';
      wrapper.setAttribute('data-emoticon-state', 'loading');
      const frame = document.createElement('button');
      frame.className = 'standalone-emoticon-open'; frame.type = 'button'; frame.disabled = true;
      frame.setAttribute('data-status', '正在加载表情…');
      frame.setAttribute('aria-label', '查看动态表情'); frame.setAttribute('title', '查看动态表情');
      const image = document.createElement('img');
      image.className = 'standalone-emoticon-image'; image.width = 128; image.height = 128;
      // The visible original link is the only text in this component. Copy,
      // search, bookmarks and exports keep the URL rather than an invented name.
      image.alt = ''; image.title = '动态表情'; image.draggable = false; image.decoding = 'async'; image.loading = 'lazy';
      image.setAttribute('referrerpolicy', 'no-referrer');
      let failed = false;
      image.addEventListener('load', () => {
        if (failed) return;
        wrapper.setAttribute('data-emoticon-state', 'ready'); frame.setAttribute('data-status', '');
        frame.disabled = !safeStandaloneSource(descriptor.originalSrc, 'original');
      });
      image.addEventListener('error', () => {
        failed = true;
        image.hidden = true; frame.disabled = true;
        wrapper.setAttribute('data-emoticon-state', 'failed'); frame.setAttribute('data-status', '表情暂不可用，可打开原链接');
      });
      frame.addEventListener('pointerdown', event => event.stopPropagation());
      frame.addEventListener('click', event => {
        event.preventDefault(); event.stopPropagation();
        if (!frame.disabled && typeof options.openStandalone === 'function') options.openStandalone(descriptor);
      });
      frame.append(image);
      const original = links.createLink(document, part.url, part.text, openLink);
      if (!original) return null;
      original.classList.add('standalone-emoticon-link');
      wrapper.append(frame, original); image.src = src;
      return wrapper;
    }
    function appendText(parent, value, openLink, options) {
      const document = parent?.ownerDocument;
      if (!document || typeof parent.append !== 'function') throw new Error('表情显示需要有效的文本容器。');
      for (const part of tokenize(value)) {
        if (part.type === 'emoticon') parent.append(createEmoticon(document, part));
        else if (part.type === 'link')
          parent.append(createStandalone(document, part, options, openLink) || links.createLink(document, part.url, part.text, openLink) || document.createTextNode(part.text));
        else parent.append(document.createTextNode(part.text));
      }
      return parent;
    }
    return Object.freeze({
      tokenize, appendText,
      installCopyHandler(document) {
        const remove = installCopyHandler(document);
        copyDisposers.add(remove);
        return remove;
      },
      dispose() { for (const remove of copyDisposers) remove(); copyDisposers.clear(); },
    });
  }
  return Object.freeze({ create, safeAsset, safeStandaloneSource, projectText, installCopyHandler, IMAGE_SIZE });
});
