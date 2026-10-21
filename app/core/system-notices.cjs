'use strict';

// The official pcweibochat history renderer chooses its notice component from
// type/sub_type/dm_type. Group names and member display names are not evidence.
// Keep the protocol metadata so a local import cannot turn an ordinary message
// into a notice just by supplying a display label or a boolean.
const own = (value,key) => Object.prototype.hasOwnProperty.call(value,key);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function protocolInteger(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value === 'string' && /^(?:0|[1-9][0-9]{0,5})$/.test(value)) value=Number(value);
  return Number.isSafeInteger(value) && value >= 0 && value <= 999999 ? value : undefined;
}
function noticeMetadata(type,subType,dmType) {
  // Mirrors checktype in the official history UI, including its special
  // template and DM notice cases. media_type is deliberately not consulted.
  return subType===101 || type>0 && (type!==321 || subType>0 || dmType===9 && subType===0);
}
function classifySystemNotice(message) {
  if (!object(message)) return undefined;
  const type=protocolInteger(message.type,0),subType=protocolInteger(message.sub_type,0),dmType=protocolInteger(message.dm_type,undefined);
  // The official DM9 branch requires explicit zero; missing sub_type is not
  // equivalent to that strict comparison even though other branches allow it.
  const explicitSubType=own(message,'sub_type')&&message.sub_type!==undefined;
  if(type===undefined||subType===undefined||(own(message,'dm_type')&&dmType===undefined)||!noticeMetadata(type,subType,explicitSubType?dmType:undefined))return undefined;
  return {kind:'weibo-system',type,subType,...(dmType!==undefined?{dmType}:{})};
}
function normalizeSystemNotice(value) {
  if(!object(value)||value.kind!=='weibo-system')throw new TypeError('系统通知信息无效');
  const type=protocolInteger(value.type,undefined),subType=protocolInteger(value.subType,undefined),dmType=protocolInteger(value.dmType,undefined);
  if(type===undefined||subType===undefined||(own(value,'dmType')&&dmType===undefined)||!noticeMetadata(type,subType,dmType))throw new TypeError('系统通知协议类型无效');
  return {kind:'weibo-system',type,subType,...(dmType!==undefined?{dmType}:{})};
}

module.exports={classifySystemNotice,normalizeSystemNotice};
