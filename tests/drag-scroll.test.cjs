'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {attach, THRESHOLD} = require('../app/renderer/drag-scroll.js');

test('downward intent is reported at a clamped bottom without a scroll write, and reversals remain distinguishable',()=>{
  const intents=[],h=fixture({onIntent:(_event,value)=>intents.push(value)});
  h.scroll.scrollHeight=700;h.down();h.move(280);h.move(270);h.move(275);h.up();
  assert.deepEqual(h.writes,[]);
  assert.deepEqual(intents,[{from:300,to:300,direction:20},{from:300,to:300,direction:10},{from:300,to:300,direction:-5}]);
});

class Surface {
  listeners = new Map();
  addEventListener(type, callback) { const values = this.listeners.get(type) || []; values.push(callback); this.listeners.set(type, values); }
  removeEventListener(type, callback) { this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== callback)); }
  emit(type, event) { for (const callback of [...(this.listeners.get(type) || [])]) { callback(event); if (event.stopped) break; } return event; }
  get listenerCount() { return [...this.listeners.values()].reduce((total, list) => total + list.length, 0); }
}
function fixture(overrides = {}) {
  const win = new Surface(), scroll = new Surface(), blank = {}, text = {}, calls = [], writes = [], timers = new Map();
  let clock = 0, sequence = 0, current = true, top = 300;
  Object.assign(win, {innerWidth: 1200, innerHeight: 900, performance: {now: () => clock},
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, {callback, due: clock + delay}); return id; },
    clearTimeout(id) { timers.delete(id); }});
  Object.assign(scroll, {ownerDocument: {defaultView: win}, isConnected: true, scrollHeight: 1600, clientHeight: 400});
  Object.defineProperty(scroll, 'scrollTop', {get: () => top, set: value => {writes.push(value); top = value;}});
  const options = {canStart: event => event.target === blank, isCurrent: () => current,
    onStart: event => calls.push(['start', event.clientY]),
    beforeMove: (_event, delta) => calls.push(['move', {...delta}, scroll.scrollTop]),
    onEnd: result => calls.push(['end', {...result}]), ...overrides};
  const controller = attach(scroll, options);
  const event = (values = {}) => ({isTrusted: true, pointerType: 'mouse', isPrimary: true, pointerId: 7,
    button: 0, buttons: 1, clientX: 500, clientY: 300, target: blank, relatedTarget: {}, detail: 1,
    altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, prevented: false, stopped: false,
    preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...values});
  return {win, scroll, blank, text, calls, writes, timers, controller, options,
    current: value => { current = value; },
    down(values = {}) { const e = event(values); win.emit('pointerdown', e); scroll.emit('pointerdown', e); return e; },
    move(y, values = {}) { return win.emit('pointermove', event({clientY: y, ...values})); },
    up(values = {}) { return win.emit('pointerup', event({buttons: 0, ...values})); },
    emit(type, values = {}) { return win.emit(type, event(values)); },
    click(values = {}) { return win.emit('click', event({buttons: 0, ...values})); },
    tick(ms) { clock += ms; for (const [id, item] of [...timers]) if (item.due <= clock) {timers.delete(id); item.callback();} }
  };
}
function active(h) { h.down(); h.move(280); assert.equal(h.controller.isDragging(), true); }

test('drag begins only for trusted, primary, unmodified left mouse input in caller-approved blank areas', () => {
  for (const invalid of [{isTrusted: false}, {isPrimary: false}, {pointerType: 'touch'}, {pointerType: 'pen'},
    {button: 2}, {buttons: 0}, {buttons: 3}, {ctrlKey: true}, {altKey: true}, {metaKey: true}, {shiftKey: true}, {clientY: NaN}]) {
    const h = fixture(); const down = h.down(invalid); const move = h.move(100);
    assert.equal(down.prevented, false); assert.equal(move.prevented, false); assert.equal(h.controller.isDragging(), false);
    assert.deepEqual(h.calls, []); assert.deepEqual(h.writes, []); h.controller.dispose();
  }
  const h = fixture(); h.down({target: h.text}); h.move(100); h.up();
  assert.deepEqual(h.calls, []); assert.deepEqual(h.writes, []); assert.equal(h.click().prevented, false);
});

test('sub-threshold presses preserve native focus, text selection and ordinary clicks', () => {
  const h = fixture(); assert.equal(THRESHOLD, 6); assert.equal(h.down().prevented, false);
  assert.equal(h.move(295).prevented, false); h.move(300, {clientX: 900});
  assert.equal(h.controller.isDragging(), false); h.up();
  assert.deepEqual(h.calls, []); assert.deepEqual(h.writes, []); assert.equal(h.click().prevented, false);
  h.down(); h.controller.cancel(); assert.deepEqual(h.calls, []);
});

test('six vertical pixels start once, invoke beforeMove before assignment, and track original position without inertia', () => {
  const h = fixture(); h.down(); assert.equal(h.move(294).prevented, true); h.move(280); h.move(270);
  assert.deepEqual(h.calls, [['start', 294], ['move', {from: 300, to: 306}, 300], ['move', {from: 306, to: 320}, 306], ['move', {from: 320, to: 330}, 320]]);
  h.up(); h.tick(5000); assert.deepEqual(h.writes, [306, 320, 330]);
  assert.equal(h.controller.isDragging(), false); assert.deepEqual(h.calls.at(-1), ['end', {cancelled: false, dragged: true, reason: 'release'}]);
});

test('reverse dragging changes direction and clamps at current scroll bounds without extra no-op writes', () => {
  const h = fixture(); h.down(); h.move(280); h.move(310); h.move(800); h.move(850);
  assert.deepEqual(h.writes, [320, 290, 0]);
  h.up(); h.down({clientY: 850}); h.move(0); assert.equal(h.scroll.scrollTop, 850);
  h.scroll.scrollHeight = 600; h.move(50); assert.equal(h.scroll.scrollTop, 200);
  assert.deepEqual(h.calls.filter(call => call[0] === 'move').map(call => call[1]),
    [{from:300,to:320},{from:320,to:290},{from:290,to:0},{from:0,to:850},{from:850,to:200}]);
});

test('release stops movement and consumes exactly the generated mouse click', () => {
  const h = fixture(); active(h); h.up(); const top = h.scroll.scrollTop; h.move(200);
  assert.equal(h.scroll.scrollTop, top); const click = h.click();
  assert.equal(click.prevented, true); assert.equal(click.stopped, true); assert.equal(h.click().prevented, false);
  assert.equal(h.calls.filter(call => call[0] === 'end').length, 1);
});

test('cancellation paths stop immediately, notify once and prevent the trailing drag click', () => {
  const cases = [
    ['pointer-cancel', h => h.emit('pointercancel')], ['window-leave', h => h.emit('pointerout', {relatedTarget:null})],
    ['blur', h => h.emit('blur')], ['buttons', h => h.move(200, {buttons:0})], ['buttons', h => h.move(200, {buttons:3})],
    ['buttons', h => h.move(200, {ctrlKey:true})], ['window-leave', h => h.move(200, {clientX:-1})],
    ['window-leave', h => h.move(900)], ['context', h => {h.current(false); h.move(200);}],
    ['context', h => {h.scroll.isConnected=false; h.move(200);}], ['cancel', h => h.controller.cancel()]
  ];
  for (const [reason, cancel] of cases) {
    const h = fixture(); active(h); const before = h.writes.length; cancel(h); h.move(100); h.up(); h.controller.cancel();
    assert.equal(h.controller.isDragging(), false, reason); assert.equal(h.writes.length, before, reason);
    assert.deepEqual(h.calls.filter(call => call[0] === 'end'), [['end',{cancelled:true,dragged:true,reason}]], reason);
    assert.equal(h.click().prevented, true, reason); h.controller.dispose();
  }
});

test('unrelated and untrusted pointer moves cannot control an active gesture', () => {
  const h = fixture(); active(h); const before = h.scroll.scrollTop;
  h.move(100, {pointerId:8}); h.move(100, {isTrusted:false}); h.up({pointerId:8}); h.emit('pointercancel', {pointerId:8});
  h.emit('pointerout', {relatedTarget:{}}); assert.equal(h.controller.isDragging(), true); assert.equal(h.scroll.scrollTop, before);
  h.move(270); assert.equal(h.scroll.scrollTop, 330); h.up();
});

test('click suppression does not eat keyboard activation, injected clicks or a later explicit mouse press', () => {
  const h = fixture(); active(h); h.up();
  assert.equal(h.click({detail:0}).prevented, false); assert.equal(h.click({isTrusted:false}).prevented, false);
  assert.equal(h.click({pointerId:8}).prevented, false); assert.equal(h.click().prevented, true);
  active(h); h.up(); h.down({target:h.text}); assert.equal(h.click({target:h.text}).prevented, false);
  active(h); h.up(); h.tick(751); assert.equal(h.click().prevented, false);
});

test('new explicit pointer input cancels an abandoned gesture and remains independently clickable', () => {
  const h = fixture(); active(h); h.down({target:h.text}); assert.equal(h.controller.isDragging(), false);
  assert.equal(h.calls.at(-1)[1].reason, 'new-pointer'); assert.equal(h.click({target:h.text}).prevented, false);
  h.down(); h.move(260); assert.equal(h.controller.isDragging(), true);
});

test('callback errors or callback-driven context changes cannot leave an active drag or write stale scroll positions', () => {
  let h = fixture({beforeMove:()=>{throw new Error('synthetic hook failure');}}); h.down();
  assert.throws(()=>h.move(280),/synthetic hook failure/); assert.equal(h.controller.isDragging(),false); assert.deepEqual(h.writes,[]);
  assert.equal(h.calls.at(-1)[1].reason,'callback-error');
  h = fixture(); h.options.onStart = () => h.current(false); h.down(); h.move(280);
  assert.equal(h.controller.isDragging(),false); assert.deepEqual(h.writes,[]); assert.equal(h.calls.at(-1)[1].reason,'context');
  h = fixture(); h.options.beforeMove = () => h.controller.cancel(); h.down(); h.move(280);
  assert.equal(h.controller.isDragging(),false); assert.deepEqual(h.writes,[]); assert.equal(h.calls.at(-1)[1].reason,'cancel');
});

test('context invalidation before release reports cancellation rather than valid completion', () => {
  const h=fixture(); active(h); h.current(false); h.up();
  assert.deepEqual(h.calls.at(-1),['end',{cancelled:true,dragged:true,reason:'context'}]);
});

test('dispose removes all listeners and timers, is idempotent, and reports only an actual active drag', () => {
  const h=fixture(); h.down(); h.controller.dispose(); h.controller.dispose();
  assert.equal(h.win.listenerCount,0); assert.equal(h.scroll.listenerCount,0); assert.equal(h.timers.size,0); assert.deepEqual(h.calls,[]);
  h.down(); h.move(100); assert.deepEqual(h.writes,[]);
  const activeFixture=fixture(); active(activeFixture); activeFixture.controller.dispose();
  assert.deepEqual(activeFixture.calls.at(-1),['end',{cancelled:true,dragged:true,reason:'dispose'}]);
  assert.equal(activeFixture.win.listenerCount,0); assert.equal(activeFixture.timers.size,0);
});
