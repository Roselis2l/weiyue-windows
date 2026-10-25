'use strict';
const {validateAppearance} = require('../renderer/appearance.js');
const {validateTheme} = require('../renderer/interface-theme.js');
function fail(code,message) { const error = new Error(message); error.code = code; throw error; }
function payloadFields(payload) {
  let descriptors,keys;
  try {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error();
    const prototype = Object.getPrototypeOf(payload);
    if (prototype !== Object.prototype && prototype !== null) throw new Error();
    descriptors = Object.getOwnPropertyDescriptors(payload); keys = Reflect.ownKeys(descriptors);
    if (![2,3].includes(keys.length) || keys.some(key => !['accountId','appearance','interfaceTheme'].includes(key)) || !keys.includes('accountId') || !keys.includes('appearance')) throw new Error();
    for (const key of keys) if (!Object.hasOwn(descriptors[key],'value') || !descriptors[key].enumerable) throw new Error();
  } catch { fail('APPEARANCE_INVALID','外观保存请求无效，请重新打开设置。'); }
  const accountId = descriptors.accountId.value;
  if (typeof accountId !== 'string' || !accountId || accountId.length > 256 || /[\u0000-\u001f]/.test(accountId)) fail('APPEARANCE_INVALID','外观设置所属账号无效。');
  return {accountId,appearance:descriptors.appearance.value,...(Object.hasOwn(descriptors,'interfaceTheme')?{interfaceTheme:validateTheme(descriptors.interfaceTheme.value)}:{})};
}
// Synchronous and account-bound: no credentials, network, dialog or other
// settings are involved. Store.update supplies atomic persistence/rollback.
function saveAppearanceSettings({store,getContext,payload}) {
  const selection = payloadFields(payload), initial = getContext();
  const owner = {accountId:initial.accountId,epoch:initial.epoch};
  const check = () => {
    const context = getContext();
    if (selection.accountId !== owner.accountId || context.accountId !== owner.accountId || context.epoch !== owner.epoch) fail('APPEARANCE_ACCOUNT_CHANGED','当前账号已变化，请重新打开外观设置。');
    if (context.closing) fail('APPEARANCE_CLOSING','窗口正在关闭，未保存外观设置。');
    if (context.busy) fail('APPEARANCE_BUSY','操作正在进行，请完成后再保存外观设置。');
  };
  check();
  const appearance = validateAppearance(selection.appearance);
  check();
  store.update(owner.accountId,state => { check(); state.settings.appearance = appearance;if(Object.hasOwn(selection,'interfaceTheme'))state.settings.interfaceTheme=selection.interfaceTheme; });
  return {...appearance};
}
module.exports = {saveAppearanceSettings};
