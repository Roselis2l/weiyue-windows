(function (root, factory) {
  'use strict';
  const helpers = factory();
  if (typeof module === 'object' && module.exports) module.exports = helpers;
  else root.WeiyueAutoPage = helpers;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const WHEEL_GAP_MS = 250, INTENT_MS = 1200;
  function isAtBottom({scrollTop, scrollHeight, clientHeight} = {}, threshold = 24) {
    if (![scrollTop, scrollHeight, clientHeight, threshold].every(Number.isFinite) ||
        scrollTop < 0 || scrollHeight < 0 || clientHeight <= 0 || threshold < 0) return false;
    return scrollHeight - clientHeight - scrollTop <= threshold;
  }
  function createAutoPager({snapshot, load, apply, onState = () => {}, onError = () => {}, now = Date.now}) {
    if (![snapshot, load, apply, onState, onError, now].every(value => typeof value === 'function')) throw new TypeError('Invalid paging callbacks');
    let generation = 0, pending = null, armed = null, state = 'idle', error = null;
    let wheelAt = -Infinity, wheelId = 0;
    const spent = new Set();
    const consume = token => {spent.add(token); if (spent.size > 128) spent.delete(spent.values().next().value);};
    const status = () => ({loading: !!pending, state, error});
    const publish = (next, problem = null) => {state = next; error = problem; onState(status());};
    const valid = value => value?.enabled === true && typeof value.key === 'string' &&
      [value.offset, value.count, value.total].every(Number.isSafeInteger) && value.offset >= 0 && value.count >= 0 && value.total >= 0;
    const same = (left, right) => valid(right) && left.key === right.key && left.offset === right.offset && left.count === right.count;
    const cancelIntent = () => {armed = null;};
    const reset = () => {generation++; armed = null; spent.clear(); publish('idle');};
    function observe() {
      if (pending || !armed) return pending || false;
      const value = snapshot(), moment = now();
      if (!same(armed.snapshot, value) || moment > armed.until) {armed = null; return false;}
      if (value.offset + value.count >= value.total) {armed = null; publish('end'); return false;}
      if (value.blocked || !value.atBottom) return false;
      const captured = {...value}, ownGeneration = generation, used = armed.token;
      armed = null; consume(used);
      // Establish the lock before invoking application callbacks, including load.
      const operation = Promise.resolve().then(() => load(captured)).then(result => {
        const currentBeforeApply = snapshot();
        if (ownGeneration !== generation || !same(captured, currentBeforeApply) || currentBeforeApply.blocked) return;
        apply(result, captured);
        const current = snapshot();
        publish(current.offset + current.count >= current.total ? 'end' : 'idle');
      }).catch(problem => {
        if (ownGeneration !== generation || !same(captured, snapshot())) return;
        publish('error', problem); onError(problem);
      }).finally(() => {
        if (pending === operation) {pending = null; if (state === 'loading') state = 'idle'; onState(status());}
        // Deliberately never observe here: a response or layout change is not input.
      });
      pending = operation; publish('loading'); return operation;
    }
    function intent({trusted, kind, direction, gestureId, modified = false} = {}) {
      if (trusted !== true || modified || !Number.isFinite(direction) || direction <= 0 || !['wheel', 'drag'].includes(kind)) {
        armed = null; return false;
      }
      const moment = now();
      let token;
      if (kind === 'wheel') {
        if (moment - wheelAt >= WHEEL_GAP_MS) wheelId++;
        wheelAt = moment; token = `wheel:${wheelId}`;
      } else {
        if (gestureId === undefined || gestureId === null) return false;
        token = `drag:${String(gestureId)}`;
      }
      // Inputs during a pending request are consumed, never queued for its result.
      if (pending) {consume(token); armed = null; return pending;}
      const value = snapshot();
      if (!valid(value) || spent.has(token)) return false;
      armed = {token, snapshot: {...value}, until: moment + INTENT_MS};
      return observe();
    }
    return Object.freeze({intent, observe, cancelIntent, reset, status});
  }
  async function queryWindow({query, payload, firstId, lastId, count, active = () => true}) {
    const changed = () => {const problem = new Error('消息列表已更新，请稍后重试。'); problem.code = 'PAGE_CHANGED'; return problem;};
    const desired = Math.max(payload.limit || 160, count || 0);
    const first = await query({...payload, limit: Math.min(2000, desired), ...(firstId ? {startId: firstId} : {})});
    if (!active()) throw changed();
    const offset = first.offset ?? payload.offset ?? 0, messages = [...first.messages];
    let wanted = desired;
    // Preserve the old trailing message when history was inserted inside the
    // loaded window, not merely the previous numerical count.
    if (lastId && !messages.some(message => String(message.id) === lastId)) {
      const tail = await query({...payload, startId: lastId, limit: 1});
      if (!active() || tail.revision !== first.revision || tail.total !== first.total) throw changed();
      wanted = Math.max(wanted, tail.offset - offset + 1);
    }
    while (messages.length < wanted && offset + messages.length < first.total) {
      if (!messages.length) throw changed();
      const next = await query({...payload, afterId: String(messages.at(-1).id), limit: Math.min(2000, wanted - messages.length)});
      if (!active() || next.revision !== first.revision || next.total !== first.total || next.offset !== offset + messages.length || !next.messages.length) throw changed();
      messages.push(...next.messages);
    }
    if (new Set(messages.map(message => String(message.id))).size !== messages.length) throw changed();
    return {...first, offset, messages};
  }
  return Object.freeze({createAutoPager, isAtBottom, queryWindow, WHEEL_GAP_MS, INTENT_MS});
});
