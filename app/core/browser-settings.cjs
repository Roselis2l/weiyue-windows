"use strict";
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {normalizeHttpUrl}=require('../renderer/linkify.js');
const BROWSERS=[['chrome','Google Chrome','Google/Chrome/Application/chrome.exe'],['edge','Microsoft Edge','Microsoft/Edge/Application/msedge.exe'],['firefox','Mozilla Firefox','Mozilla Firefox/firefox.exe'],['brave','Brave','BraveSoftware/Brave-Browser/Application/brave.exe'],['vivaldi','Vivaldi','Vivaldi/Application/vivaldi.exe']];
function createBrowserSettings({dataRoot,shell,io=fs,launch=spawn,env=process.env,platform=process.platform}){
 const file=path.join(dataRoot,'browser-preferences.json');
 function installed(){
  if(platform!=='win32')return [];
  const roots=[env.ProgramFiles,env['ProgramFiles(x86)'],env.LOCALAPPDATA].filter(Boolean);
  return BROWSERS.flatMap(([id,label,relative])=>{const executable=roots.map(root=>path.join(root,...relative.split('/'))).find(candidate=>{try{return io.statSync(candidate).isFile();}catch{return false;}});return executable?[{id,label,executable}]:[];});
 }
 function read(){try{const value=JSON.parse(io.readFileSync(file,'utf8'));return typeof value?.browser==='string'?value.browser:'default';}catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)return 'default';throw error;}}
 function get(){const selected=read(),choices=[{id:'default',label:'系统默认浏览器'},...installed().map(({id,label})=>({id,label}))];return {selected,choices,available:choices.some(item=>item.id===selected)};}
 function save(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>key!=='browser')||typeof value.browser!=='string')throw Error('请选择有效的浏览器。');
  if(value.browser!=='default'&&!installed().some(item=>item.id===value.browser))throw Error('所选浏览器未安装或已移动，请重新选择。');
  const temporary=file+'.'+crypto.randomUUID()+'.tmp';io.mkdirSync(dataRoot,{recursive:true});
  try{io.writeFileSync(temporary,JSON.stringify({browser:value.browser}),{flag:'wx'});io.renameSync(temporary,file);}finally{try{io.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
  return get();
 }
 async function open(value){
  const url=normalizeHttpUrl(value);if(!url)throw Error('仅允许 HTTP 或 HTTPS 网页地址。');
  const selected=read();if(selected==='default'){await shell.openExternal(url);return true;}
  const browser=installed().find(item=>item.id===selected);
  if(!browser)throw Error('所选浏览器未安装或已移动，请在设置中重新选择。');
  // Never execute a renderer-supplied path, command, or shell fragment.
  await new Promise((resolve,reject)=>{const child=launch(browser.executable,[url],{shell:false,detached:true,stdio:'ignore',windowsHide:false});child.once('error',()=>reject(Error('浏览器启动失败，请检查安装或改用系统默认浏览器。')));child.once('spawn',()=>{child.unref();resolve();});});
  return true;
 }
 return {get,save,open};
}
module.exports={createBrowserSettings};
