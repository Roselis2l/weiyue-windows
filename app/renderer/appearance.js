(function (root, factory) {
  'use strict';
  const exported = factory();
  if (typeof module === 'object' && module.exports) module.exports = exported;
  else root.WeiyueAppearance = exported;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const DEFAULTS = Object.freeze({
    chatBackground: '#f1f3f2', memberName: '#52634b', importantName: '#860000',
    memberBubble: '#ffffff', importantBubble: '#fcd3d4', importantText: '#860000', memberText: '#000000'
  });
  const FIELDS = Object.freeze(Object.keys(DEFAULTS));
  const LABELS = Object.freeze({chatBackground:'聊天背景',memberName:'普通成员昵称',importantName:'重点成员昵称',memberBubble:'普通消息气泡',importantBubble:'重点消息气泡',importantText:'重点消息正文',memberText:'普通成员消息文字颜色'});
  const MIN_CONTRAST = 4.5;
  function invalid(message) { const error = new Error(message); error.code = 'APPEARANCE_INVALID'; throw error; }
  function descriptors(value) {
    try {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return null;
      return Object.getOwnPropertyDescriptors(value);
    } catch { return null; }
  }
  function normalizeHex(value) {
    if (typeof value !== 'string' || !/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) return null;
    const lower = value.toLowerCase();
    return lower.length === 4 ? '#' + [...lower.slice(1)].map(char => char + char).join('') : lower;
  }
  // Reading an old state never adds defaults to the persisted state. Invalid
  // fields fall back individually, and accessors are not evaluated.
  function normalizeAppearance(value) {
    const properties = descriptors(value), result = {};
    for (const field of FIELDS) {
      const property = properties && Object.getOwnPropertyDescriptor(properties, field)?.value;
      // Existing five-color settings retain their old automatic text behavior.
      // Only a missing/invalid entire appearance object receives new defaults.
      if (field === 'importantText' && properties) {
        result[field] = property && Object.hasOwn(property,'value') ? normalizeHex(property.value) : null;
        continue;
      }
      result[field] = property && Object.hasOwn(property, 'value') ? normalizeHex(property.value) || DEFAULTS[field] : DEFAULTS[field];
    }
    return result;
  }
  function validateAppearance(value) {
    const properties = descriptors(value);
    if (!properties) invalid('外观颜色必须是包含七项设置的普通对象。');
    const keys = Reflect.ownKeys(properties);
    if (keys.length !== FIELDS.length || keys.some(key => typeof key !== 'string' || !FIELDS.includes(key))) invalid('外观颜色只能包含七项指定设置，不能缺少或增加字段。');
    const result = {};
    for (const field of FIELDS) {
      const property = properties[field];
      if (!property || !Object.hasOwn(property, 'value') || !property.enumerable) invalid('外观颜色必须使用普通可保存的字段。');
      if (field === 'importantText' && property.value === null) { result[field] = null; continue; }
      const color = normalizeHex(property.value);
      if (!color) invalid(LABELS[field] + '请输入 #RGB 或 #RRGGBB 格式的颜色，不支持透明度。');
      result[field] = color;
    }
    return result;
  }
  function luminance(value) {
    const color = normalizeHex(value);
    if (!color) invalid('计算对比度需要有效的 HEX 颜色。');
    const channels = [1,3,5].map(index => parseInt(color.slice(index,index + 2),16) / 255)
      .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  }
  function contrastRatio(first, second) {
    const a = luminance(first), b = luminance(second);
    return (Math.max(a,b) + 0.05) / (Math.min(a,b) + 0.05);
  }
  function readableColor(background, preferred) {
    for (const color of preferred) if (contrastRatio(color,background) >= MIN_CONTRAST) return color;
    return contrastRatio('#000000',background) >= contrastRatio('#ffffff',background) ? '#000000' : '#ffffff';
  }
  function getAppearanceTheme(value) {
    const colors = normalizeAppearance(value), warnings = [];
    for (const field of ['memberName','importantName']) {
      const contrast = contrastRatio(colors[field],colors.chatBackground);
      if (contrast < MIN_CONTRAST) warnings.push({field,contrast,minimum:MIN_CONTRAST,message:LABELS[field] + '与聊天背景对比度较低，可能不易阅读；指定颜色仍会保留。'});
    }
    if (colors.importantText !== null) {
      const contrast = contrastRatio(colors.importantText,colors.importantBubble);
      if (contrast < MIN_CONTRAST) warnings.push({field:'importantText',contrast,minimum:MIN_CONTRAST,message:'重点消息正文与重点消息气泡对比度较低，可能不易阅读；指定颜色仍会保留。'});
    }
    const memberContrast = contrastRatio(colors.memberText,colors.memberBubble);
    if (memberContrast < MIN_CONTRAST) warnings.push({field:'memberText',contrast:memberContrast,minimum:MIN_CONTRAST,message:'普通成员消息文字与普通消息气泡对比度较低，可能不易阅读；指定颜色仍会保留。'});
    return { colors,
      chatText:readableColor(colors.chatBackground,['#53604f','#f4f8f5']),
      chatLink:readableColor(colors.chatBackground,['#356f64','#d8eee3']),
      memberText:colors.memberText,
      memberLink:readableColor(colors.memberBubble,['#356f64','#d8eee3']),
      importantText:colors.importantText === null ? readableColor(colors.importantBubble,['#f4f8f5','#53604f']) : colors.importantText,
      importantLink:readableColor(colors.importantBubble,['#860000','#d8eee3','#356f64']),
      warnings
    };
  }
  return Object.freeze({DEFAULTS,FIELDS,MIN_CONTRAST,normalizeHex,normalizeAppearance,validateAppearance,contrastRatio,getAppearanceTheme});
});
