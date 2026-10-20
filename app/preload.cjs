'use strict';
const {contextBridge,ipcRenderer} = require('electron');
const actions = new Set(['state','account.switch','demo','groups.select','sync','sync.status','sync.configure','messages.query','messages.locate','messages.enrich','members.list','read.set','important.set','bookmark.add','bookmark.list','bookmark.remove','import','export.bookmarks','summary.preview','summary.local','summary.ai','summary.list','summary.export','settings.save','ai.providers','settings.ai.save','login.open','login.complete','login.status','login.cancel','logout','notion.targets','notion.preview','notion.export','external.open','window.closeReady']);
contextBridge.exposeInMainWorld('api',Object.freeze({call:async(action,payload={})=>{
  if (!actions.has(action)) throw new Error('不支持的操作');
  const result=await ipcRenderer.invoke('weiyue:call',action,payload);
  if(!result.ok) throw new Error(result.error);
  return result.value;
},onBeforeClose:callback=>{if(typeof callback!=='function')throw new Error('回调无效');const listener=()=>callback();ipcRenderer.on('weiyue:before-close',listener);return()=>ipcRenderer.removeListener('weiyue:before-close',listener);}}));
