'use strict';

function invalidated() {
  const error = new Error('登录会话恢复已取消或失效，请重新打开官方登录页。');
  error.code = 'SESSION_RESTORE_INVALIDATED';
  return error;
}

function restoreFailure(code, message) { return Object.assign(new Error(message), {code}); }

function usableSnapshotCookie(cookie, officialUrl, nowSeconds=Date.now()/1000) {
  if(!cookie||typeof cookie.domain!=='string'||!cookie.domain||typeof cookie.name!=='string'||!cookie.name||typeof cookie.value!=='string')return false;
  if(cookie.expirationDate!==undefined&&(!Number.isFinite(cookie.expirationDate)||cookie.expirationDate<=nowSeconds))return false;
  return officialUrl('https://'+cookie.domain.replace(/^\./,''));
}

// Every restoration belongs to one account generation. Logging out, resetting
// credentials or adopting a newly verified session invalidates earlier work,
// including Chromium cookie operations that cannot themselves be aborted.
class AccountSessionRegistry {
  constructor({ sessions = new Map(), createSession, readCookies, officialUrl }) {
    this.sessions = sessions;
    this.createSession = createSession;
    this.readCookies = readCookies;
    this.officialUrl = officialUrl;
    this.generations = new Map();
    this.flights = new Map();
    this.restoreStatuses = new Map();
  }

  advance(id) {
    const generation = (this.generations.get(id) || 0) + 1;
    this.generations.set(id, generation);
    return generation;
  }

  invalidate(id) {
    const previous = this.sessions.get(id);
    this.advance(id);
    this.sessions.delete(id);
    this.flights.delete(id);
    this.restoreStatuses.delete(id);
    return previous;
  }

  adopt(id, session) {
    this.advance(id);
    this.flights.delete(id);
    this.sessions.set(id, session);
    this.restoreStatuses.set(id, 'verified');
  }

  status(id) { return this.restoreStatuses.get(id) || ''; }
  markVerified(id, session) {
    if(this.sessions.get(id)===session)this.restoreStatuses.set(id,'verified');
  }
  hasUsableSnapshot(cookies) {
    const now=Date.now()/1000;
    return Array.isArray(cookies)&&cookies.some(cookie=>usableSnapshotCookie(cookie,this.officialUrl,now));
  }

  async restore(id, { check = () => {} } = {}) {
    check();
    if (this.sessions.has(id)) return this.sessions.get(id);
    let flight = this.flights.get(id);
    if (!flight) {
      flight = { generation: this.advance(id), callers: new Set(), promise: null };
      this.flights.set(id, flight);
    }
    const caller = { check, error: null };
    flight.callers.add(caller);
    if (!flight.promise) flight.promise = this.restoreFlight(id, flight);
    try {
      const restored = await flight.promise;
      if (caller.error) throw caller.error;
      check();
      return restored;
    } catch (error) {
      if (caller.error) throw caller.error;
      check();
      throw error;
    } finally {
      flight.callers.delete(caller);
    }
  }

  async restoreFlight(id, flight) {
    const current = () => {
      if (this.generations.get(id) !== flight.generation) throw invalidated();
      // A canceled reader must not cancel another reader's restoration. If all
      // callers have canceled, however, a late cookie write must not be cached.
      let wanted = false;
      for (const caller of flight.callers) {
        if (caller.error) continue;
        try { caller.check(); wanted = true; }
        catch (error) { caller.error = error; }
      }
      if (!wanted) throw invalidated();
    };
    try {
      current();
      const cookies=this.readCookies(id)||[], now=Date.now()/1000;
      const eligible=Array.isArray(cookies)?cookies.filter(cookie=>usableSnapshotCookie(cookie,this.officialUrl,now)):[];
      if(!eligible.length){
        this.restoreStatuses.set(id,'missing');
        throw restoreFailure('SESSION_SNAPSHOT_MISSING','本机没有仍可用的登录快照，请在微博官方页面登录。');
      }
      let restored;
      try {restored=this.createSession();}
      catch {
        current();this.restoreStatuses.set(id,'temporary');
        throw restoreFailure('SESSION_RESTORE_TEMPORARY','本机暂未恢复登录会话，请稍后重试；不代表微博登录已失效。');
      }
      let accepted=0;
      for (const cookie of eligible) {
        current();
        const item = {
          url: 'https://' + cookie.domain.replace(/^\./, '') + (cookie.path || '/'),
          name: cookie.name, value: cookie.value, path: cookie.path || '/',
          secure: true, httpOnly: !!cookie.httpOnly, sameSite: cookie.sameSite || 'unspecified',
        };
        if (!cookie.hostOnly) item.domain = cookie.domain;
        if (cookie.expirationDate) item.expirationDate = cookie.expirationDate;
        try { await restored.cookies.set(item); accepted++; }
        catch { /* Never expose cookie errors or change the supplied expiration. */ }
        current();
      }
      current();
      if(!accepted){
        this.restoreStatuses.set(id,'temporary');
        throw restoreFailure('SESSION_RESTORE_TEMPORARY','本机暂未恢复登录会话，请稍后重试；不代表微博登录已失效。');
      }
      this.sessions.set(id, restored);
      this.restoreStatuses.set(id,'restored'); // Candidate only; official identity must still be checked.
      return restored;
    } finally {
      if (this.flights.get(id) === flight) this.flights.delete(id);
    }
  }
}

module.exports = { AccountSessionRegistry };
