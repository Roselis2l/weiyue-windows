'use strict';
// Keep each account's cooldown and security pause when its window is inactive.
// A verified login may clear only that account's authentication pause. Other
// security stops still require the existing explicit recovery action.
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

  authenticationRestored(accountId, options) {
    const controller = this.controllers.get(accountId);
    if (!controller || this.current !== controller) throw new Error('登录账号不是当前自动更新账号。');
    return controller.authenticationRestored(options);
  }
}
module.exports = { AccountAutoSync };
