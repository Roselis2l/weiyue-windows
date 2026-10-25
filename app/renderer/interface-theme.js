(function (root, factory) {
  'use strict';
  const exported = factory();
  if (typeof module === 'object' && module.exports) module.exports = exported;
  else root.WeiyueInterfaceTheme = exported;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  // Original Chrome-inspired palettes, not a claim of exact Chrome colors.
  // These tokens never contain message bubble, nickname or body colors.
  const DEFAULT_THEME = 'cool-grey';
  const THEMES = Object.freeze({
    'cool-grey':Object.freeze({label:'Cool Grey · 冷灰',shell:'#e5e8ed',panel:'#f0f2f5',surface:'#ffffff',hover:'#e1e6ed',selected:'#d5dfec',accent:'#334e70',text:'#253446',muted:'#526174',line:'#b7c1ce',accentText:'#ffffff'}),
    viridian:Object.freeze({label:'Viridian · 青碧',shell:'#dceae5',panel:'#edf5f1',surface:'#fbfffd',hover:'#dcece4',selected:'#c7e4d6',accent:'#205c49',text:'#213c32',muted:'#49665a',line:'#a6c5b6',accentText:'#ffffff'}),
    pink:Object.freeze({label:'Pink · 浅粉',shell:'#f3e3ea',panel:'#fcf0f5',surface:'#fffafd',hover:'#f4dfe8',selected:'#edccdc',accent:'#823e5b',text:'#49303d',muted:'#715367',line:'#d6b2c4',accentText:'#ffffff'}),
    violet:Object.freeze({label:'Violet · 紫罗兰',shell:'#e9e4f4',panel:'#f4f0fb',surface:'#fefcff',hover:'#e8dff5',selected:'#dbcef0',accent:'#60418a',text:'#3b304d',muted:'#665576',line:'#c2b1d8',accentText:'#ffffff'})
  });
  function normalizeTheme(value) { return typeof value === 'string' && Object.hasOwn(THEMES,value) ? value : DEFAULT_THEME; }
  function validateTheme(value) {
    if (typeof value !== 'string' || !Object.hasOwn(THEMES,value)) {
      const error = new Error('请选择受支持的界面主题。');error.code='APPEARANCE_INVALID';throw error;
    }
    return value;
  }
  function apply(host,value) {
    const id=normalizeTheme(value),theme=THEMES[id];
    host.dataset.interfaceTheme=id;
    for(const [key,color] of Object.entries(theme))if(key!=='label')host.style.setProperty('--ui-'+key.replace(/[A-Z]/g,char=>'-'+char.toLowerCase()),color);
    return id;
  }
  return Object.freeze({DEFAULT_THEME,THEMES,normalizeTheme,validateTheme,apply});
});
