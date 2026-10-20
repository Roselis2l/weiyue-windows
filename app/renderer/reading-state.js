(function (root, factory) {
  'use strict';
  const helpers = factory();
  if (typeof module === 'object' && module.exports) module.exports = helpers;
  else root.WeiyueReading = helpers;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function finite(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }

  // Keep IDs opaque: Weibo IDs can exceed Number.MAX_SAFE_INTEGER.
  // Geometry must be measured in the same coordinate space (e.g. client rects).
  function captureViewport(options = {}) {
    const viewportTop = finite(options.viewportTop, 0);
    const viewportHeight = Math.max(0, finite(options.viewportHeight, 0));
    const viewportBottom = viewportTop + viewportHeight;
    const items = Array.isArray(options.items) ? options.items : [];
    const visible = items.filter(item => item &&
      Number.isFinite(item.top) && Number.isFinite(item.bottom) &&
      item.bottom > viewportTop + 1 && item.top < viewportBottom);
    const anchor = visible[0];
    let readThrough = null;
    // A pending image can expand after its placeholder looked fully visible.
    // Stop the high-water candidate before it, including offscreen pending images.
    for (const item of items) {
      if (!item || !Number.isFinite(item.top) || !Number.isFinite(item.bottom)) continue;
      if (item.ready === false) break;
      if (item.bottom > viewportTop + 1 && item.bottom <= viewportBottom + 1) readThrough = item;
    }
    return {
      anchorId: anchor ? anchor.id : null,
      anchorOffset: anchor ? anchor.top - viewportTop : 0,
      atBottom: options.loadedAtEnd === true &&
        finite(options.scrollHeight, 0) - finite(options.scrollTop, 0) - viewportHeight <= 32,
      readThroughId: readThrough ? readThrough.id : null
    };
  }

  function restoredScrollTop(options = {}) {
    return Math.max(0, finite(options.scrollTop, 0) + finite(options.itemTop, 0) -
      finite(options.viewportTop, 0) - finite(options.anchorOffset, 0));
  }

  function chooseWindow(options = {}) {
    const total = Math.max(0, Math.floor(finite(options.total, 0)));
    const limit = Math.max(1, Math.min(2000, Math.floor(finite(options.limit, 160))));
    const anchorIndex = finite(options.anchorIndex, -1);
    const offset = options.latestRequested === true
      ? Math.max(total - limit, 0)
      : anchorIndex >= 0 ? Math.max(Math.floor(anchorIndex) - 25, 0) : 0;
    return { offset, limit };
  }

  function mediaReadyForRead(options = {}) {
    // Already-read context may contain lazy images outside the loading area.
    // Only a confirmed local read boundary grants that exception.
    return options.loaded === true || options.alreadyRead === true;
  }

  function trailingSpaceHeight(viewportHeight, lastHeight, bottomPadding = 0) {
    return Math.max(0, finite(viewportHeight, 0) - finite(lastHeight, 0) - finite(bottomPadding, 0));
  }

  // A scroll event alone is not proof of user input: setting scrollTop also emits it.
  // Context includes account, group, query and layout generation. Passive changes reset
  // the gate, so neither a delayed scroll event nor an old dwell timer grants permission.
  function createReadIntentGate() {
    let intent = null;
    return Object.freeze({
      reset() { intent = null; },
      arm(context, scrollTop, now, trusted) {
        intent = trusted === true && Number.isFinite(scrollTop) ? { context, top: scrollTop, expires: now + 1200, candidate: null } : null;
      },
      scroll(context, scrollTop, now, readThroughId) {
        if (!intent || context !== intent.context || now > intent.expires) { intent = null; return null; }
        const previous = intent.top;
        if (!Number.isFinite(scrollTop) || scrollTop < previous) { intent = null; return null; }
        intent.top = scrollTop;
        // Native smooth scrolling ends with fractional-pixel steps. They still
        // belong to the trusted gesture and must not erase its dwell candidate.
        // A duplicate position may retain the same candidate, never acquire a
        // newly arrived message without further downward movement.
        if (scrollTop === previous) return readThroughId && intent.candidate?.readThroughId === String(readThroughId) ? intent.candidate : null;
        intent.candidate = readThroughId ? Object.freeze({ context, readThroughId: String(readThroughId), kind: 'scroll' }) : null;
        return intent.candidate;
      }
    });
  }

  function recentGroupId(groups = [], states = {}) {
    const selected = groups.filter(group => group.selected !== false);
    let chosen = selected[0] || null, newest = -Infinity;
    for (const group of selected) {
      const raw = states[group.id]?.updatedAt;
      const time = typeof raw === 'number' ? raw : typeof raw === 'string' ? Date.parse(raw) : NaN;
      if (Number.isFinite(time) && time > newest) { chosen = group; newest = time; }
    }
    return chosen?.id ?? null;
  }

  function unreadLabel(count) {
    if (!Number.isInteger(count) || count <= 0) return '';
    return count > 999 ? '999+' : String(count);
  }

  return Object.freeze({ captureViewport, restoredScrollTop, chooseWindow, mediaReadyForRead, trailingSpaceHeight, createReadIntentGate, recentGroupId, unreadLabel });
});
