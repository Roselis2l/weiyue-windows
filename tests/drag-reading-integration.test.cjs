'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const reading = require('../app/renderer/reading-state.js');
const drag = require('../app/renderer/drag-scroll.js');
const paging = require('../app/renderer/auto-page.js');
const source = fs.readFileSync(require.resolve('../app/renderer/app.js'), 'utf8');

// Run the actual renderer input handlers, drag helper, read gate, dwell timer and
// queued read.set path. Only browser geometry, event dispatch, clock and IPC are
// simulated. In particular a scrollTop write does not immediately dispatch its
// scroll event: Chromium can deliver that event after pointerup.
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `source section ${start}`);
  return source.slice(a, b);
}
const extracted = section('function isCurrentReadingRendered()', 'function watchMessageSizes()') +
  section('function hasFilters(', 'async function applyFilters(') +
  section('function bindReadingInput(', 'function updateUnreadBadges()') +
  section("window.addEventListener('pointerup'", "window.addEventListener('focus'");

class Surface {
  listeners = new Map();
  addEventListener(type, callback, options) {
    const entries = this.listeners.get(type) || [];
    entries.push({callback, capture: options === true || options?.capture === true});
    this.listeners.set(type, entries);
  }
  removeEventListener(type, callback) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item.callback !== callback));
  }
  emit(type, event, capture) {
    for (const item of [...(this.listeners.get(type) || [])]) {
      if (item.capture !== capture) continue;
      item.callback(event);
      if (event.stopped) break;
    }
  }
}
class Element extends Surface {
  constructor(selectors = []) {
    super();
    const classes = new Set();
    this.classList = {add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value)};
    this.selectors = new Set(selectors);
  }
  matches(query) { return query.split(',').some(selector => this.selectors.has(selector.trim())); }
}

function harness() {
  let now = 0, next = 1;
  const timers = new Map(), frames = new Map(), writes = [], events = [];
  const setTimeout = (callback, delay) => { const id = next++; timers.set(id, {callback, due: now + delay}); return id; };
  const clearTimeout = id => timers.delete(id);
  const win = new Surface();
  Object.assign(win, {WeiyueDragScroll: drag, innerWidth: 1200, innerHeight: 900,
    performance: {now: () => now}, setTimeout, clearTimeout,
    getSelection: () => ({removeAllRanges: () => events.push({at: now, type: 'selection-clear'})})});
  const document = {visibilityState: 'visible', hasFocus: () => true, defaultView: win};
  const scroll = new Element();
  Object.assign(scroll, {scrollTop: 100, offsetWidth: 200, clientWidth: 190, clientHeight: 400, scrollHeight: 1000,
    ownerDocument: document, isConnected: true, getBoundingClientRect: () => ({top: 0, bottom: 400, right: 200})});
  const rows = [{id: 'M1', top: 100, bottom: 260, ready: true},
    {id: 'M2', top: 270, bottom: 520, ready: true}, {id: 'M3', top: 600, bottom: 700, ready: true}];
  const modal = {open: false};
  const model = {view: 'read', groupId: 'group-a', accountEpoch: 1, queryVersion: 7, layoutVersion: 0, intentVersion: 0,
    state: {account: {id: 'synthetic-account'}, groups: [{id: 'group-a', unreadCount: 3}],
      readStates: {'group-a': {readThroughId: 'M0'}}, readPositions: {}},
    renderedReading: {accountId: 'synthetic-account', epoch: 1, groupId: 'group-a', version: 7, filtered: false},
    scrollTop: 100, restoring: false, restoreFrame: null, pointerScrolling: false, touchY: null, readTimer: null, viewport: null,
    switching: false, closing: false, readWrite: Promise.resolve(), lastReadPayload: '', pointerReading: null,
    readingActivity: null, readingCommits: new Map(), pendingReadingRefresh: null, pendingReadingTimer: null,
    refreshRunning: false, searchEditor: null, readNavigation: null,
    filters: {keyword: '', senderIds: [], start: '', end: '', importantOnly: false}};
  const measuredMessages = () => rows.map(row => ({...row, top: row.top - scroll.scrollTop, bottom: row.bottom - scroll.scrollTop}));
  const api = async (name, payload) => {
    assert.equal(name, 'read.set', 'no unrelated IPC or external service calls');
    writes.push({at: now, ...JSON.parse(JSON.stringify(payload))});
    return {readState: {readThroughId: payload.readThroughId || model.state.readStates[payload.groupId].readThroughId}};
  };
  // These fixtures contain a complete local window. Keep the real pager idle
  // while exercising the actual read/drag state machines and their new hooks.
  const autoPage=paging.createAutoPager({snapshot:()=>({enabled:false}),load:()=>{throw Error('complete fixture must not page');},apply:()=>{throw Error('complete fixture must not append');}});
  const context = vm.createContext({model, reading, autoPage, readIntent: reading.createReadIntentGate(), document, window: win, Element,
    scroll, api, $: id => id === 'message-scroll' ? scroll : id === 'modal' ? modal : null,
    performance: win.performance, setTimeout, clearTimeout,
    requestAnimationFrame: callback => { const id = next++; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id), measuredMessages,
    searchEditing: () => false, updateReadChrome: () => {}, updateUnreadBadges: () => {}, enrichVisibleMessages: async () => {},
    refreshState: async () => events.push({at: now, type: 'refresh-state'}),
    refreshReadingIncrementally: async () => events.push({at: now, type: 'refresh-messages'})});
  vm.runInContext(extracted + ';bindReadingInput(scroll);', context);
  const run = code => vm.runInContext(code, context);
  async function settle() { for (let i = 0; i < 16; i++) await Promise.resolve(); await model.readWrite; }
  async function tick(ms) {
    const target = now + ms;
    let iterations = 0;
    for (;;) {
      const pending = [...timers].filter(([, value]) => value.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
      if (!pending) break;
      assert.ok(iterations++ < 100, 'deferred refresh must not spin');
      now = pending[1].due; timers.delete(pending[0]); pending[1].callback(); await settle();
    }
    now = target; await settle();
  }
  function emit(type, overrides = {}, targetListeners = false) {
    const event = {isTrusted: true, pointerType: 'mouse', isPrimary: true, pointerId: 7, button: 0, buttons: 1,
      target: scroll, clientX: 150, clientY: 300, relatedTarget: {}, detail: 1,
      altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
      preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...overrides};
    win.emit(type, event, true);
    if (targetListeners && !event.stopped) { scroll.emit(type, event, true); scroll.emit(type, event, false); }
    if (!event.stopped) win.emit(type, event, false);
    return event;
  }
  return {model, scroll, rows, document, modal, writes, events, run, tick, settle, emit,
    down: overrides => emit('pointerdown', overrides, true),
    move: y => emit('pointermove', {clientY: y}, true),
    release: () => emit('pointerup', {buttons: 0}),
    scrollEvent: () => run('handleReadingScroll()'),
    passiveScroll(top) { scroll.scrollTop = top; run('handleReadingScroll()'); },
    readIds: () => writes.filter(value => value.readThroughId).map(value => value.readThroughId),
    pendingDwell: () => timers.get(model.readTimer),
    dispose: () => model.messageDrag.dispose()};
}

function scenario(name, body) {
  test(name, async () => { const h = harness(); try { await body(h); } finally { h.dispose(); } });
}

scenario('drag release processes the last unhandled scroll position before resetting intent; a delayed duplicate preserves dwell', async h => {
  h.down(); h.move(200);
  assert.equal(h.scroll.scrollTop, 200);
  assert.equal(h.model.scrollTop, 100, 'simulate compositor/DOM scroll event delayed until after pointerup');
  h.release();
  assert.equal(h.model.scrollTop, 200, 'release synchronously accounts for the final displacement');
  const dwell = h.pendingDwell();
  await h.tick(300); h.scrollEvent();
  assert.equal(h.pendingDwell(), dwell, 'same-position event must not replace the candidate or its deadline');
  await h.tick(199); assert.deepEqual(h.readIds(), []);
  await h.tick(1); assert.deepEqual(h.readIds(), ['M2']);
  assert.equal(h.writes.find(value => value.readThroughId).at, 500);
});

scenario('repeated same-top events after an observed drag do not postpone or erase its original read timer', async h => {
  h.down(); h.move(200); h.scrollEvent();
  const dwell = h.pendingDwell();
  await h.tick(100); h.release();
  for (let i = 0; i < 3; i++) { await h.tick(100); h.scrollEvent(); assert.equal(h.pendingDwell(), dwell); }
  await h.tick(100);
  assert.deepEqual(h.readIds(), ['M2']);
  assert.equal(h.writes.find(value => value.readThroughId).at, 500, 'release and duplicate events do not extend the deadline');
});

scenario('passive movement soon after release cannot borrow the expired drag or read a newly visible message', async h => {
  h.down(); h.move(200); h.release();
  await h.tick(100); h.passiveScroll(350);
  await h.tick(600);
  assert.deepEqual(h.readIds(), [], 'different passive position cancels the previous dwell and cannot acquire M3');
  assert.equal(h.model.state.readStates['group-a'].readThroughId, 'M0');
  assert.ok(h.writes.some(value => value.anchorId), 'ordinary anchor persistence still works');
});

scenario('after a valid drag commits, later passive scroll and duplicate events leave its high-water unchanged', async h => {
  h.down(); h.move(200); h.release(); await h.tick(500);
  assert.deepEqual(h.readIds(), ['M2']);
  h.passiveScroll(350); await h.tick(300); h.scrollEvent(); await h.tick(500);
  assert.deepEqual(h.readIds(), ['M2']);
  assert.equal(h.model.state.readStates['group-a'].readThroughId, 'M2');
});

test('pointer cancellation, window exit, blur, lost button and context changes cannot commit a pending drag read', async () => {
  const cases = [
    ['pointercancel', h => h.emit('pointercancel')],
    ['window exit', h => h.emit('pointerout', {relatedTarget: null})],
    ['blur', h => h.emit('blur')],
    ['lost button', h => h.emit('pointermove', {buttons: 0, clientY: 190}, true)],
    ['modal opened', h => { h.modal.open = true; h.release(); }],
    ['group changed', h => { h.model.groupId = 'group-b'; h.release(); }]
  ];
  for (const [name, cancel] of cases) {
    const h = harness();
    try {
      h.down(); h.move(200); h.scrollEvent(); await h.tick(100); cancel(h);
      assert.equal(h.model.messageDrag.isDragging(), false, name);
      assert.equal(h.scroll.classList.contains('is-dragging'), false, name);
      h.scrollEvent(); await h.tick(700);
      assert.deepEqual(h.readIds(), [], name);
      assert.equal(h.model.state.readStates['group-a'].readThroughId, 'M0', name);
      assert.equal(h.model.readingActivity, null, name);
    } finally { h.dispose(); }
  }
});

scenario('upward historical dragging and reversal before dwell never advance the high-water', async h => {
  h.down(); h.move(350); h.release(); await h.tick(600);
  assert.deepEqual(h.readIds(), []);
  h.down(); h.move(150); h.scrollEvent(); await h.tick(100);
  h.move(200); h.release(); await h.tick(600);
  assert.deepEqual(h.readIds(), [], 'upward reversal cancels the downward candidate even if M2 stays visible');
  assert.equal(h.model.state.readStates['group-a'].readThroughId, 'M0');
});

scenario('filtered reading can drag but cannot persist or spend ordinary read permission', async h => {
  h.model.filters.keyword = 'synthetic'; h.model.renderedReading.filtered = true;
  h.down(); h.move(200); h.release(); h.scrollEvent(); await h.tick(700);
  assert.equal(h.scroll.scrollTop, 200);
  assert.deepEqual(h.writes, [], 'temporary search positions must not overwrite the saved anchor or high-water');
});

scenario('an upward held drag defers background refresh even without active read intent, then releases it normally', async h => {
  h.down(); h.move(350);
  assert.equal(h.model.readingActivity, null);
  assert.equal(h.run('readingBusy()'), true);
  h.run('queueReadingRefresh()'); await h.tick(600);
  assert.equal(h.events.filter(value => value.type.startsWith('refresh-')).length, 0);
  h.release(); await h.tick(0);
  assert.equal(h.run('readingBusy()'), false);
  assert.deepEqual(h.events.filter(value => value.type.startsWith('refresh-')).map(value => value.type), ['refresh-state', 'refresh-messages']);
  await h.tick(500); assert.deepEqual(h.readIds(), []);
});

test('actual caller whitelist permits only blank message containers and rejects text, controls, links, media and avatar areas', () => {
  const allowed = ['scroll', '.message', '.message-copy', '.message-top', '#reading-end-space'];
  const rejected = ['.message-content', '.message-text', 'a', 'img', 'video', 'button', 'input', 'textarea', '.message-avatar',
    '.message-affordance', '.message-actions', '.reference-card', '.message-sender', 'span', 'div'];
  for (const selector of [...allowed, ...rejected]) {
    const h = harness();
    try {
      const target = selector === 'scroll' ? h.scroll : new Element([selector]);
      h.down({target}); const event = h.move(200);
      assert.equal(h.model.messageDrag.isDragging(), allowed.includes(selector), selector);
      assert.equal(h.scroll.scrollTop, allowed.includes(selector) ? 200 : 100, selector);
      assert.equal(event.prevented === true, allowed.includes(selector), selector);
      if (rejected.includes(selector)) {
        assert.equal(h.model.readingActivity, null, selector);
        assert.equal(h.events.some(value => value.type === 'selection-clear'), false, `${selector}: native selection remains intact`);
      }
      h.release();
    } finally { h.dispose(); }
  }
  for (const target of [null, {}, {matches: () => true}]) {
    const h = harness();
    try {
      h.down({target}); h.move(200);
      assert.equal(h.model.messageDrag.isDragging(), false, 'non-Element targets cannot enter the whitelist');
    } finally { h.dispose(); }
  }
});
