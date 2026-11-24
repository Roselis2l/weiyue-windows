'use strict';

// Shared with the main process: parsing never trusts an HTML fragment or a
// renderer-provided protocol. Messages remain text nodes throughout rendering.
const WeiyueLinks = (() => {
  const MAX_URL_LENGTH = 4096;
  const TRAILING_PUNCTUATION = /[.,!?;:，。！？；：、…]$/u;
  const CLOSING = Object.freeze({ ')': '(', ']': '[', '}': '{', '）': '（', '】': '【', '》': '《', '〉': '〈', '」': '「', '』': '『' });

  function normalizeHttpUrl(value) {
    if (typeof value !== 'string' || !value || value.length > MAX_URL_LENGTH ||
        !/^https?:\/\//i.test(value) || /[\s\\\u0000-\u001f\u007f-\u009f]/u.test(value)) return null;
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
      return url.href;
    } catch { return null; }
  }

  function trimSentenceEnd(value) {
    const counts = new Map();
    for (const character of value) counts.set(character, (counts.get(character) || 0) + 1);
    let result = value;
    while (result) {
      const last = result.at(-1);
      if (TRAILING_PUNCTUATION.test(last)) { result = result.slice(0, -1); continue; }
      const opener = CLOSING[last];
      if (opener) {
        if ((counts.get(last) || 0) > (counts.get(opener) || 0)) {
          counts.set(last, counts.get(last) - 1);
          result = result.slice(0, -1); continue;
        }
      }
      break;
    }
    return result;
  }

  function tokenize(value) {
    const text = typeof value === 'string' ? value : String(value ?? '');
    // Chinese sentence punctuation and markup delimiters end a URL. Balanced
    // parentheses stay part of a path; unmatched closing brackets stay text.
    const expression = /https?:\/\/[^\s<>"'`，。！？；：、…“”‘’]+/giu;
    const parts = [];
    let end = 0;
    for (const match of text.matchAll(expression)) {
      const start = match.index;
      if (match[0].length > MAX_URL_LENGTH) continue;
      // Do not turn the suffix of another protocol, email or identifier into
      // a link. Chinese prose may be immediately adjacent to an actual URL.
      if (start > 0 && /[A-Za-z0-9_:/\\@]/.test(text[start - 1])) continue;
      const label = trimSentenceEnd(match[0]);
      const url = normalizeHttpUrl(label);
      if (!url) continue;
      if (start > end) parts.push({ type: 'text', text: text.slice(end, start) });
      parts.push({ type: 'link', text: label, url });
      end = start + label.length;
    }
    if (end < text.length || !parts.length) parts.push({ type: 'text', text: text.slice(end) });
    return parts;
  }

  function createLink(document, value, label, open) {
    const url = normalizeHttpUrl(value);
    if (!url) return null;
    const link = document.createElement('a');
    link.className = 'message-link';
    link.textContent = String(label ?? value);
    link.setAttribute('href', url);
    link.setAttribute('title', '用系统默认浏览器打开');
    link.setAttribute('rel', 'noopener noreferrer');
    link.setAttribute('referrerpolicy', 'no-referrer');
    // No browser navigation is allowed inside the app. The host independently
    // validates this URL and only opens it after this explicit user action.
    link.addEventListener('pointerdown', event => event.stopPropagation());
    link.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (event.button !== undefined && event.button !== 0) return;
      if (typeof open === 'function') open(url);
    });
    link.addEventListener('auxclick', event => {
      event.preventDefault();
      event.stopPropagation();
      if (event.button === 1 && typeof open === 'function') open(url);
    });
    return link;
  }

  function appendTextLinks(parent, value, open) {
    const document = parent.ownerDocument;
    for (const part of tokenize(value)) {
      const link = part.type === 'link' ? createLink(document, part.url, part.text, open) : null;
      parent.append(link || document.createTextNode(part.text));
    }
    return parent;
  }

  return Object.freeze({ normalizeHttpUrl, tokenize, createLink, appendTextLinks });
})();

if (typeof module === 'object' && module.exports) module.exports = WeiyueLinks;
if (typeof window === 'object') window.WeiyueLinks = WeiyueLinks;
