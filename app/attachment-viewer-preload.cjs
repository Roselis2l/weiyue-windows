'use strict';
const {contextBridge,ipcRenderer}=require('electron');
const allowed=new Set(['load','retry','save','close','maximize','minimize']);
contextBridge.exposeInMainWorld('attachmentViewer',Object.freeze({call:async action=>{
  if(!allowed.has(action))throw new Error('不支持的附件操作。');
  const result=await ipcRenderer.invoke('weiyue:attachment-viewer',action);
  if(!result?.ok)throw new Error(result?.error||'附件操作失败。');
  return result.value;
}}));
