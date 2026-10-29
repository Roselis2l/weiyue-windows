'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const KEYS=['leftCollapsed','rightCollapsed'];
function normalizeLayout(value,{strict=false}={}) {
  const valid=value&&typeof value==='object'&&!Array.isArray(value);
  if(strict&&(!valid||Object.keys(value).some(key=>!KEYS.includes(key))||KEYS.some(key=>typeof value[key]!=='boolean')))throw new TypeError('栏位布局必须包含两个有效的收起开关。');
  return Object.fromEntries(KEYS.map(key=>[key,!!(valid&&value[key]===true)]));
}
function createLayoutPreferences(file,{io=fs}={}) {
  const target=path.resolve(file);
  function read(){try{const value=JSON.parse(io.readFileSync(target,'utf8'));if(!value||typeof value!=='object'||Array.isArray(value))return {};return value;}catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)return {};throw error;}}
  function write(change){
    const next={...read(),...change},temporary=target+'.'+crypto.randomUUID()+'.tmp';
    io.mkdirSync(path.dirname(target),{recursive:true});
    try{io.writeFileSync(temporary,JSON.stringify(next),{flag:'wx'});io.renameSync(temporary,target);}finally{try{io.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
    return next;
  }
  return {
    getLayout:()=>normalizeLayout(read().layout),
    saveLayout:value=>{const layout=normalizeLayout(value,{strict:true});write({layout});return layout;},
    setActiveId:id=>{if(typeof id!=='string'||!id.trim()||id.length>256)throw new TypeError('工作区 ID 无效。');write({activeId:id});}
  };
}
module.exports={normalizeLayout,createLayoutPreferences};
