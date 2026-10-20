'use strict';
// Keep each account's cooldown and security pause when its window is inactive.
// Only explicit configure() by the user may clear a security pause.
class AccountAutoSync {
  constructor() { this.controllers = new Map(); this.current = null; }
  activate(accountId, create) {
    let next = this.controllers.get(accountId);
    if (!next) { next = create(); this.controllers.set(accountId, next); }
    if (this.current !== next) this.current?.stop();
    this.current = next;
    next.start();
    return next;
  }
}
module.exports = { AccountAutoSync };
