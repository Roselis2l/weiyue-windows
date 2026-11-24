(function (root, factory) {
  'use strict';
  const helpers = factory();
  if (typeof module === 'object' && module.exports) module.exports = helpers;
  else root.WeiyueDragScroll = helpers;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const THRESHOLD = 6;
  const CLICK_WINDOW_MS = 750;
  const modified = event => event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
  const finite = value => typeof value === 'number' && Number.isFinite(value);

  function attach(scroll, options = {}) {
    const win = scroll?.ownerDocument?.defaultView;
    if (!scroll?.addEventListener || !win?.addEventListener) throw new TypeError('A connected scroll element and window are required');
    let gesture = null, disposed = false, clickSuppression = null, clickTimer = null;
    const listeners = [];
    const now = () => win.performance?.now?.() ?? Date.now();
    const current = () => !disposed && scroll.isConnected !== false && (!options.isCurrent || options.isCurrent());
    const listen = (target, type, callback, config) => {
      target.addEventListener(type, callback, config);
      listeners.push(() => target.removeEventListener(type, callback, config));
    };
    const clearClick = () => {
      if (clickTimer !== null) win.clearTimeout(clickTimer);
      clickTimer = null; clickSuppression = null;
    };
    const suppressNextClick = pointerId => {
      clearClick(); clickSuppression = {pointerId, until: now() + CLICK_WINDOW_MS};
      clickTimer = win.setTimeout(clearClick, CLICK_WINDOW_MS);
    };
    const finish = (cancelled, reason) => {
      const previous = gesture; gesture = null;
      // A simple press, cancelled threshold candidate, or repeated cancellation
      // never reports a drag and cannot accidentally consume an ordinary click.
      if (!previous?.dragged) return;
      suppressNextClick(previous.pointerId);
      options.onEnd?.({cancelled, dragged: true, reason});
    };
    const down = event => {
      if (!current() || event.isTrusted !== true || event.pointerType !== 'mouse' || event.isPrimary !== true ||
          event.button !== 0 || event.buttons !== 1 || modified(event) || !finite(event.clientY) ||
          !finite(event.clientX) || typeof options.canStart !== 'function' || !options.canStart(event)) return;
      const startTop = Number(scroll.scrollTop);
      if (!Number.isFinite(startTop)) return;
      gesture = {pointerId: event.pointerId, startY: event.clientY, lastY: event.clientY, startTop, dragged: false};
      // Keep native text selection, focus and clicks intact until the threshold.
    };
    const move = event => {
      const active = gesture;
      if (!active || event.isTrusted !== true || event.pointerId !== active.pointerId) return;
      if (!current()) { finish(true, 'context'); return; }
      if (event.buttons !== 1 || modified(event)) { finish(true, 'buttons'); return; }
      if (!finite(event.clientY) || !finite(event.clientX)) { finish(true, 'coordinates'); return; }
      if (event.clientX < 0 || event.clientY < 0 || event.clientX >= win.innerWidth || event.clientY >= win.innerHeight) {
        finish(true, 'window-leave'); return;
      }
      const distance = event.clientY - active.startY;
      if (!active.dragged && Math.abs(distance) < THRESHOLD) return;
      event.preventDefault();
      try {
        if (!active.dragged) { active.dragged = true; options.onStart?.(event); }
        if (gesture !== active) return;
        if (!current()) { finish(true, 'context'); return; }
        const from = Number(scroll.scrollTop);
        const max = Math.max(0, Number(scroll.scrollHeight) - Number(scroll.clientHeight));
        if (!Number.isFinite(from) || !Number.isFinite(max)) { finish(true, 'geometry'); return; }
        const to = Math.max(0, Math.min(max, active.startTop - distance));
        const direction = active.lastY - event.clientY; active.lastY = event.clientY;
        // Report genuine downward intent even when clamped at the physical end.
        // The caller may load one local page after this held gesture is released.
        options.onIntent?.(event, {from, to, direction});
        if (gesture !== active) return;
        if (to === from) return;
        options.beforeMove?.(event, {from, to});
        if (gesture !== active) return;
        if (!current()) { finish(true, 'context'); return; }
        scroll.scrollTop = to;
      } catch (error) {
        finish(true, 'callback-error');
        throw error;
      }
    };
    const up = event => {
      if (!gesture || event.isTrusted !== true || event.pointerId !== gesture.pointerId || event.button !== 0) return;
      const valid = current();
      finish(!valid, valid ? 'release' : 'context');
    };

    // Global listeners follow a held pointer across message descendants without
    // pointer capture, and therefore do not retarget ordinary text/media clicks.
    listen(win, 'pointerdown', event => {
      if (event.isTrusted !== true) return;
      finish(true, 'new-pointer'); clearClick();
    }, true);
    listen(scroll, 'pointerdown', down);
    listen(win, 'pointermove', move, {capture: true, passive: false});
    listen(win, 'pointerup', up, true);
    listen(win, 'pointercancel', event => {
      if (gesture && event.pointerId === gesture.pointerId) finish(true, 'pointer-cancel');
    }, true);
    listen(win, 'pointerout', event => {
      if (gesture && event.pointerId === gesture.pointerId && event.relatedTarget === null) finish(true, 'window-leave');
    }, true);
    listen(win, 'blur', () => finish(true, 'blur'));
    listen(win, 'click', event => {
      if (!clickSuppression || event.isTrusted !== true || event.detail <= 0 || event.button !== 0) return;
      if (now() > clickSuppression.until) { clearClick(); return; }
      if (finite(event.pointerId) && event.pointerId !== clickSuppression.pointerId) return;
      clearClick(); event.preventDefault(); event.stopImmediatePropagation();
    }, true);

    return Object.freeze({
      isDragging: () => !!gesture?.dragged,
      cancel: () => finish(true, 'cancel'),
      dispose() {
        if (disposed) return;
        try { finish(true, 'dispose'); }
        finally { disposed = true; clearClick(); for (const remove of listeners) remove(); }
      }
    });
  }

  return Object.freeze({attach, THRESHOLD});
});
